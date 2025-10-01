require('dotenv').config();
const amqp = require('amqplib');
const nodemailer = require('nodemailer');

// Nodemailer Transport Oluşturma
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: {
        // Geliştirme ortamında sertifika doğrulamasını atla
        rejectUnauthorized: process.env.NODE_ENV === 'production'
    }
});

// RabbitMQ Bağlantı Parametreleri
const RABBITMQ_URL = process.env.RABBITMQ_URL;
const EMAIL_QUEUE = 'email-queue';

// Email Gönderme Fonksiyonu
async function sendEmail(emailData) {
    try {
        const mailOptions = {
            from: process.env.SMTP_FROM,
            to: emailData.data.email,
            subject: getSubject(emailData.action),
            html: getEmailTemplate(emailData)
        };

        const info = await transporter.sendMail(mailOptions);
        console.log(`📧 Email gönderildi: ${emailData.data.email} (${info.messageId})`);
        return info;
    } catch (error) {
        console.error(`❌ Email gönderme hatası (${emailData.data.email}):`, error);
        throw error;
    }
}

// Email Şablon Seçici
function getEmailTemplate(emailData) {
    switch (emailData.action) {
        case 'email-welcome':
            return `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f4f4;">
                    <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <h1 style="color: #2c3e50; text-align: center;">Hoş Geldiniz, ${emailData.data.userName}!</h1>
                        <p style="color: #34495e; line-height: 1.6;">
                            Platformumuza kayıt olduğunuz için teşekkür ederiz. Hesabınız başarıyla oluşturuldu ve kullanıma hazır durumda.
                        </p>
                        <div style="text-align: center; margin-top: 30px;">
                            <a href="#" style="background-color: #3498db; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px;">
                                Hesabımı Yönet
                            </a>
                        </div>
                    </div>
                    <p style="text-align: center; color: #7f8c8d; margin-top: 15px; font-size: 12px;">
                        Bu email otomatik olarak gönderilmiştir. Lütfen yanıtlamayınız.
                    </p>
                </div>
            `;
        
        case 'password-reset':
            return `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f4f4f4;">
                    <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <h1 style="color: #2c3e50; text-align: center;">Şifre Sıfırlama</h1>
                        <p style="color: #34495e; line-height: 1.6;">
                            Şifre sıfırlama talebiniz alınmıştır. Aşağıdaki butona tıklayarak şifrenizi sıfırlayabilirsiniz.
                        </p>
                        <div style="text-align: center; margin-top: 30px;">
                            <a href="${emailData.data.resetLink}" style="background-color: #e74c3c; color: white; padding: 12px 25px; text-decoration: none; border-radius: 5px;">
                                Şifremi Sıfırla
                            </a>
                        </div>
                        <p style="color: #7f8c8d; font-size: 12px; text-align: center; margin-top: 15px;">
                            Bu linkin geçerlilik süresi 1 saat kadardır.
                        </p>
                    </div>
                </div>
            `;
        
        default:
            return `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <h1>Sistem Bildirimi</h1>
                    <p>Detaylı bir email şablonu bulunamadı.</p>
                </div>
            `;
    }
}

// Email Konusu Belirleyici
function getSubject(action) {
    switch (action) {
        case 'email-welcome':
            return 'Platformumuza Hoş Geldiniz!';
        case 'password-reset':
            return 'Şifre Sıfırlama Talebi';
        default:
            return 'Sistem Bildirimi';
    }
}

// RabbitMQ Bağlantısı ve Tüketici Kurulumu
async function setupEmailConsumer() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();

        // Kuyruk oluştur (durable: true - kuyruk kalıcı olsun)
        await channel.assertQueue(EMAIL_QUEUE, { durable: true });

        // Aynı anda 1 mesaj işle (prefetch)
        channel.prefetch(1);

        console.log('📬 Email Worker çalışıyor. Mesaj bekleniyor...');

        channel.consume(EMAIL_QUEUE, async (msg) => {
            if (msg !== null) {
                try {
                    const emailData = JSON.parse(msg.content.toString());
                    console.log('📨 Yeni email talebi alındı:', emailData.action);

                    await sendEmail(emailData);
                    
                    // Mesajı onaylama (kuyruktan çıkarma)
                    channel.ack(msg);
                } catch (error) {
                    console.error('❌ Email işleme hatası:', error);
                    // Hata durumunda mesajı geri gönder
                    channel.nack(msg, false, false);
                }
            }
        });

        // Bağlantı kapanırsa tekrar bağlanmayı dene
        connection.on('close', () => {
            console.error('❌ RabbitMQ bağlantısı kapandı. Yeniden bağlanılıyor...');
            setTimeout(setupEmailConsumer, 5000);
        });

    } catch (error) {
        console.error('❌ Email worker bağlantı hatası:', error);
        // Hata durumunda 5 saniye sonra tekrar bağlanmayı dene
        setTimeout(setupEmailConsumer, 5000);
    }
}

async function testSmtpConnection() {
    try {
        console.log('SMTP Test Başlatılıyor...');
        console.log('SMTP Ayarları:');
        console.log('Host:', process.env.SMTP_HOST);
        console.log('Port:', process.env.SMTP_PORT);
        console.log('Kullanıcı:', process.env.SMTP_USER);
        console.log('Secure:', process.env.SMTP_SECURE);

        const testInfo = await transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: process.env.SMTP_USER, // Kendi mailınıza test
            subject: 'SMTP Bağlantı Testi',
            html: `
                <h1>SMTP Bağlantı Testi</h1>
                <p>Bu bir test email'idir.</p>
                <p>Tarih: ${new Date().toLocaleString()}</p>
            `
        });

        console.log('🟢 Test Email Gönderildi!');
        console.log('Message ID:', testInfo.messageId);
        console.log('Response:', testInfo);
    } catch (error) {
        console.error('🔴 SMTP Test Hatası:', error);
        console.error('Hata Detayları:');
        console.error('Adı:', error.name);
        console.error('Mesaj:', error.message);
        
        // Yaygın hata senaryoları için özel açıklamalar
        if (error.code === 'EAUTH') {
            console.error('🔐 Kimlik doğrulama hatası. Kullanıcı adı veya şifre yanlış olabilir.');
        }
        if (error.code === 'ECONNREFUSED') {
            console.error('🌐 Bağlantı reddedildi. SMTP sunucusu çalışmıyor veya yanlış host/port kullanılıyor.');
        }
    }
}

// Hemen çağır
testSmtpConnection();

// Çalıştırma
setupEmailConsumer();

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Email Worker kapatılıyor...');
    process.exit(0);
});