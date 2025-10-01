// app.js - Express.js + MongoDB + RabbitMQ Entegrasyonu (Düzenlenmiş)
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const amqp = require('amqplib');

const app = express();

// RabbitMQ değişkenleri
let channel = null;
let connection = null;

// RabbitMQ bağlantı ve kuyruk yönetimi
const QUEUES = [
    'email-queue',
    'sms-queue',
    'analytics-queue',
    'image-processing-queue'
];

async function connectRabbitMQ() {
    try {
        connection = await amqp.connect(process.env.RABBITMQ_URL, { heartbeat: 10 });
        channel = await connection.createChannel();

        // Kuyrukları oluştur
        for (const queue of QUEUES) {
            await channel.assertQueue(queue, { durable: true });
        }

        console.log('✅ RabbitMQ\'ya başarıyla bağlandı!');
        console.log('📬 Kuyruklar oluşturuldu:', QUEUES.join(', '));

        // Bağlantı kapanırsa tekrar bağlanmayı dene
        connection.on('close', () => {
            console.error('❌ RabbitMQ bağlantısı kapandı. Yeniden bağlanılıyor...');
            channel = null;
            setTimeout(connectRabbitMQ, 5000);
        });

        connection.on('error', (err) => {
            console.error('❌ RabbitMQ bağlantı hatası:', err.message);
        });
    } catch (error) {
        console.error('❌ RabbitMQ bağlantı hatası:', error.message);
        channel = null;
        setTimeout(connectRabbitMQ, 5000);
    }
}

connectRabbitMQ();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
    } else {
        next();
    }
});

// Logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// MongoDB Bağlantısı
mongoose.connect(process.env.MONGODB_URI)
    .then(() => {
        console.log('✅ MongoDB\'ye başarıyla bağlandı!');
        console.log('📍 Database:', mongoose.connection.name);
    })
    .catch((error) => {
        console.error('❌ MongoDB bağlantı hatası:', error.message);
        process.exit(1);
    });

// Mongoose Schema ve Model
const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, 'İsim zorunludur'],
        trim: true,
        minlength: [2, 'İsim en az 2 karakter olmalıdır'],
        maxlength: [50, 'İsim en fazla 50 karakter olabilir']
    },
    email: {
        type: String,
        required: [true, 'Email zorunludur'],
        unique: true,
        lowercase: true,
        trim: true,
        match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Geçerli bir email adresi giriniz']
    },
    phone: {
        type: String,
        trim: true
    },
    age: {
        type: Number,
        required: [true, 'Yaş zorunludur'],
        min: [0, 'Yaş 0\'dan küçük olamaz'],
        max: [120, 'Yaş 120\'den büyük olamaz']
    },
    status: {
        type: String,
        enum: ['active', 'inactive', 'pending'],
        default: 'active'
    },
    createdAt: {
        type: Date,
        default: Date.now
    },
    updatedAt: {
        type: Date,
        default: Date.now
    }
});

userSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

const User = mongoose.model('User', userSchema);

// Routes

app.get('/', (req, res) => {
    res.json({
        message: '🚀 Express.js + MongoDB + RabbitMQ API\'sine Hoş Geldiniz!',
        version: '3.0.0',
        database: 'MongoDB + Mongoose',
        queue: 'RabbitMQ',
        endpoints: {
            'GET /api/users': 'Tüm kullanıcıları listele',
            'GET /api/users/:id': 'Belirli bir kullanıcıyı getir',
            'POST /api/users': 'Yeni kullanıcı oluştur',
            'PUT /api/users/:id': 'Kullanıcı bilgilerini güncelle',
            'DELETE /api/users/:id': 'Kullanıcıyı sil',
            'GET /api/users/stats/summary': 'Kullanıcı istatistikleri'
        },
        services: {
            mongodb: mongoose.connection.readyState === 1 ? 'Connected' : 'Disconnected',
            rabbitmq: channel ? 'Connected' : 'Disconnected'
        }
    });
});

// GET /api/users
app.get('/api/users', async (req, res) => {
    try {
        const { name, minAge, maxAge, status, limit = 10, page = 1, sort = 'createdAt' } = req.query;

        let query = {};

        if (name) {
            query.name = { $regex: name, $options: 'i' };
        }

        if (minAge || maxAge) {
            query.age = {};
            if (minAge) query.age.$gte = parseInt(minAge);
            if (maxAge) query.age.$lte = parseInt(maxAge);
        }

        if (status) {
            query.status = status;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const total = await User.countDocuments(query);

        const users = await User.find(query)
            .sort(sort)
            .skip(skip)
            .limit(limitNum)
            .select('-__v');

        res.json({
            success: true,
            count: users.length,
            total: total,
            page: pageNum,
            totalPages: Math.ceil(total / limitNum),
            data: users
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Kullanıcılar getirilirken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/users/:id
app.get('/api/users/:id', async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('-__v');

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Kullanıcı bulunamadı'
            });
        }

        res.json({
            success: true,
            data: user
        });

    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({
                success: false,
                message: 'Geçersiz kullanıcı ID formatı'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Kullanıcı getirilirken hata oluştu',
            error: error.message
        });
    }
});

// POST /api/users - RabbitMQ Entegrasyonlu
app.post('/api/users', async (req, res) => {
    try {
        const { name, email, age, status, phone } = req.body;

        const newUser = new User({
            name,
            email,
            phone,
            age,
            status: status || 'active'
        });

        const savedUser = await newUser.save();

        // RabbitMQ mesajlarını gönder
        if (channel) {
            try {
                // 1. Analytics Queue
                channel.sendToQueue(
                    'analytics-queue',
                    Buffer.from(JSON.stringify({
                        action: 'analytics-user-registered',
                        userId: savedUser._id,
                        data: {
                            event: 'user-registered',
                            data: {
                                userAge: savedUser.age,
                                registrationDate: savedUser.createdAt,
                                source: 'api'
                            }
                        }
                    })),
                    { persistent: true }
                );

                // 2. Email Queue
                channel.sendToQueue(
                    'email-queue',
                    Buffer.from(JSON.stringify({
                        action: 'email-welcome',
                        userId: savedUser._id,
                        data: {
                            email: savedUser.email,
                            type: 'welcome',
                            data: {
                                userName: savedUser.name
                            }
                        }
                    })),
                    { persistent: true }
                );

                // 3. SMS Queue
                if (phone) {
                    const verificationCode = Math.floor(100000 + Math.random() * 900000);
                    channel.sendToQueue(
                        'sms-queue',
                        Buffer.from(JSON.stringify({
                            action: 'sms-verification',
                            data: {
                                phone: phone,
                                content: `Merhaba ${savedUser.name}, hesabınız oluşturuldu! Doğrulama kodu: ${verificationCode}`,
                                type: 'verification'
                            }
                        })),
                        { persistent: true }
                    );
                }

                // 4. Image Processing Queue
                channel.sendToQueue(
                    'image-processing-queue',
                    Buffer.from(JSON.stringify({
                        action: 'image-processed',
                        userId: savedUser._id,
                        data: {
                            imagePath: '/uploads/default-avatar.jpg',
                            operations: ['resize', 'optimize', 'thumbnail']
                        }
                    })),
                    { persistent: true }
                );

                console.log(`📤 Mesajlar kuyruğa gönderildi: ${savedUser.email}`);
            } catch (queueError) {
                console.error('⚠️ RabbitMQ mesaj gönderme hatası:', queueError.message);
            }
        } else {
            console.warn('⚠️ RabbitMQ bağlantısı yok, mesajlar kuyruğa gönderilemedi.');
        }

        res.status(201).json({
            success: true,
            message: 'Kullanıcı oluşturuldu! Background işlemleri başlatıldı.',
            data: savedUser,
            backgroundJobs: {
                email: 'Welcome email gönderiliyor...',
                sms: phone ? `SMS gönderiliyor: ${phone}...` : 'Telefon numarası yok',
                analytics: 'User registration analytics kaydediliyor...',
                imageProcessing: 'Profil resmi işleniyor...'
            }
        });

    } catch (error) {
        if (error.name === 'ValidationError') {
            const validationErrors = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: 'Validation hatası',
                errors: validationErrors
            });
        }

        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Bu email adresi zaten kullanılıyor'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Kullanıcı oluşturulurken hata oluştu',
            error: error.message
        });
    }
});

// PUT /api/users/:id
app.put('/api/users/:id', async (req, res) => {
    try {
        const { name, email, age, status, phone } = req.body;

        const updatedUser = await User.findByIdAndUpdate(
            req.params.id,
            { name, email, phone, age, status, updatedAt: Date.now() },
            {
                new: true,
                runValidators: true,
                select: '-__v'
            }
        );

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                message: 'Kullanıcı bulunamadı'
            });
        }

        res.json({
            success: true,
            message: 'Kullanıcı başarıyla güncellendi',
            data: updatedUser
        });

    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({
                success: false,
                message: 'Geçersiz kullanıcı ID formatı'
            });
        }

        if (error.name === 'ValidationError') {
            const validationErrors = Object.values(error.errors).map(err => err.message);
            return res.status(400).json({
                success: false,
                message: 'Validation hatası',
                errors: validationErrors
            });
        }

        if (error.code === 11000) {
            return res.status(409).json({
                success: false,
                message: 'Bu email adresi zaten kullanılıyor'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Kullanıcı güncellenirken hata oluştu',
            error: error.message
        });
    }
});

// DELETE /api/users/:id
app.delete('/api/users/:id', async (req, res) => {
    try {
        const deletedUser = await User.findByIdAndDelete(req.params.id).select('-__v');

        if (!deletedUser) {
            return res.status(404).json({
                success: false,
                message: 'Kullanıcı bulunamadı'
            });
        }

        res.json({
            success: true,
            message: 'Kullanıcı başarıyla silindi',
            data: deletedUser
        });

    } catch (error) {
        if (error.name === 'CastError') {
            return res.status(400).json({
                success: false,
                message: 'Geçersiz kullanıcı ID formatı'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Kullanıcı silinirken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/users/stats/summary
app.get('/api/users/stats/summary', async (req, res) => {
    try {
        const stats = await User.aggregate([
            {
                $group: {
                    _id: null,
                    totalUsers: { $sum: 1 },
                    averageAge: { $avg: '$age' },
                    minAge: { $min: '$age' },
                    maxAge: { $max: '$age' }
                }
            },
            {
                $project: {
                    _id: 0,
                    totalUsers: 1,
                    averageAge: { $round: ['$averageAge', 1] },
                    minAge: 1,
                    maxAge: 1
                }
            }
        ]);

        const statusStats = await User.aggregate([
            {
                $group: {
                    _id: '$status',
                    count: { $sum: 1 }
                }
            },
            {
                $sort: { count: -1 }
            }
        ]);

        const ageGroups = await User.aggregate([
            {
                $bucket: {
                    groupBy: '$age',
                    boundaries: [0, 18, 25, 35, 50, 65, 120],
                    default: 'Other',
                    output: {
                        count: { $sum: 1 },
                        users: { $push: '$name' }
                    }
                }
            }
        ]);

        res.json({
            success: true,
            data: {
                summary: stats[0] || { totalUsers: 0, averageAge: 0, minAge: 0, maxAge: 0 },
                statusDistribution: statusStats,
                ageGroups: ageGroups
            }
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'İstatistikler getirilirken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/users/analytics/advanced
app.get('/api/users/analytics/advanced', async (req, res) => {
    try {
        const analytics = await User.aggregate([
            {
                $facet: {
                    overview: [
                        {
                            $group: {
                                _id: null,
                                totalUsers: { $sum: 1 },
                                avgAge: { $avg: '$age' },
                                minAge: { $min: '$age' },
                                maxAge: { $max: '$age' }
                            }
                        }
                    ],
                    emailDomains: [
                        {
                            $project: {
                                domain: {
                                    $arrayElemAt: [
                                        { $split: ['$email', '@'] },
                                        1
                                    ]
                                }
                            }
                        },
                        {
                            $group: {
                                _id: '$domain',
                                count: { $sum: 1 }
                            }
                        },
                        { $sort: { count: -1 } }
                    ],
                    ageCategories: [
                        {
                            $project: {
                                name: 1,
                                age: 1,
                                category: {
                                    $switch: {
                                        branches: [
                                            { case: { $lt: ['$age', 18] }, then: 'Çocuk' },
                                            { case: { $lt: ['$age', 25] }, then: 'Genç' },
                                            { case: { $lt: ['$age', 35] }, then: 'Yetişkin' },
                                            { case: { $gte: ['$age', 35] }, then: 'Orta Yaş+' }
                                        ],
                                        default: 'Diğer'
                                    }
                                }
                            }
                        },
                        {
                            $group: {
                                _id: '$category',
                                count: { $sum: 1 },
                                users: { $push: '$name' }
                            }
                        }
                    ]
                }
            }
        ]);

        res.json({
            success: true,
            data: analytics[0]
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Analitik veriler getirilirken hata oluştu',
            error: error.message
        });
    }
});

// 404 Handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Bu endpoint mevcut değil'
    });
});

// Global Error Handler
app.use((error, req, res, next) => {
    console.error('❌ Hata:', error);
    res.status(500).json({
        success: false,
        message: 'Sunucu hatası oluştu',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Sunucu kapatılıyor...');
    try {
        if (channel) {
            await channel.close();
            console.log('✅ RabbitMQ channel kapatıldı');
        }
        if (connection) {
            await connection.close();
            console.log('✅ RabbitMQ bağlantısı kapatıldı');
        }
    } catch (err) {
        console.error('❌ RabbitMQ kapatma hatası:', err.message);
    }
    try {
        await mongoose.connection.close();
        console.log('✅ MongoDB bağlantısı kapatıldı');
    } catch (err) {
        console.error('❌ MongoDB kapatma hatası:', err.message);
    }
    process.exit(0);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Express.js + MongoDB + RabbitMQ sunucusu http://localhost:${PORT} adresinde çalışıyor`);
    console.log('\n📋 Endpoint\'ler:');
    console.log('GET    http://localhost:3000/');
    console.log('POST   http://localhost:3000/api/users');
    console.log('\n💡 RabbitMQ UI: http://localhost:15672');
    console.log('💡 MongoDB UI: http://localhost:8081\n');
});