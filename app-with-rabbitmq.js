

// app-with-socketio.js - Express.js + MongoDB + RabbitMQ + Socket.io Tam Entegrasyon
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const amqp = require('amqplib');
const { Server } = require('socket.io');
const http = require('http');
const nodemailer = require('nodemailer');

const app = express();

// HTTP server oluştur
const server = http.createServer(app);

// Socket.io'yu başlat
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Online kullanıcılar
const onlineUsers = new Map();

// Middleware'ler
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

// RabbitMQ Service Class
class RabbitMQService {
    constructor() {
        this.connection = null;
        this.channel = null;
        this.isConnected = false;
    }

    async connect() {
        try {
            console.log('🐰 RabbitMQ\'ya bağlanılıyor...');

            this.connection = await amqp.connect('amqp://admin:password123@localhost:5672');
            this.channel = await this.connection.createChannel();

            this.isConnected = true;
            console.log('✅ RabbitMQ bağlantısı başarılı!');

            // Error handling
            this.connection.on('error', (err) => {
                console.error('❌ RabbitMQ bağlantı hatası:', err);
                this.isConnected = false;
            });

            return this.channel;

        } catch (error) {
            console.error('❌ RabbitMQ bağlantı hatası:', error.message);
            this.isConnected = false;
            throw error;
        }
    }

    async sendToQueue(queueName, message) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }

            await this.channel.assertQueue(queueName, { durable: true });

            const messageBuffer = Buffer.from(JSON.stringify({
                ...message,
                timestamp: new Date().toISOString(),
                messageId: Date.now() + Math.random()
            }));

            const result = this.channel.sendToQueue(queueName, messageBuffer, {
                persistent: true
            });

            console.log(`📤 Mesaj gönderildi [${queueName}]:`, message);
            return result;

        } catch (error) {
            console.error('❌ Mesaj gönderme hatası:', error.message);
            throw error;
        }
    }

    async consumeQueue(queueName, callback) {
        try {
            if (!this.isConnected) {
                await this.connect();
            }

            await this.channel.assertQueue(queueName, { durable: true });

            console.log(`👂 Queue dinleniyor: ${queueName}`);

            return await this.channel.consume(queueName, async (message) => {
                if (message) {
                    try {
                        const content = JSON.parse(message.content.toString());
                        console.log(`📥 Mesaj alındı [${queueName}]:`, content);

                        await callback(content, message);
                        this.channel.ack(message);

                    } catch (error) {
                        console.error('❌ Mesaj işleme hatası:', error.message);
                        this.channel.nack(message, false, true);
                    }
                }
            }, { noAck: false });

        } catch (error) {
            console.error('❌ Queue dinleme hatası:', error.message);
            throw error;
        }
    }

    async getQueueInfo(queueName) {
        if (!this.isConnected) {
            await this.connect();
        }
        return await this.channel.checkQueue(queueName);
    }
}

// RabbitMQ instance
const rabbitmq = new RabbitMQService();

// SMTP / Email helper
function createSmtpTransporter() {
    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587;
    const secure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!host || !user || !pass) {
        console.warn('⚠️ SMTP yapılandırması eksik. E-postalar simüle edilecek. .env içine SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS ekleyin.');
        return null;
    }

    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass }
    });
}

const smtpTransporter = createSmtpTransporter();

// User Schema (MongoDB)
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
        required: [true, 'Telefon numarası zorunludur'],
        match: [/^\+90[0-9]{10}$/, 'Geçerli bir Türkiye telefon numarası giriniz (+905551234567)']
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

const User = mongoose.model('User', userSchema);

// Chat Room Schema
const chatRoomSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
        maxlength: 50
    },
    description: {
        type: String,
        maxlength: 200
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    members: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    }],
    isPrivate: {
        type: Boolean,
        default: false
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const ChatRoom = mongoose.model('ChatRoom', chatRoomSchema);

// Message Schema
const messageSchema = new mongoose.Schema({
    content: {
        type: String,
        required: true,
        trim: true,
        maxlength: 1000
    },
    sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
    },
    chatRoom: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'ChatRoom',
        required: true
    },
    messageType: {
        type: String,
        enum: ['text', 'image', 'file', 'system'],
        default: 'text'
    },
    isEdited: {
        type: Boolean,
        default: false
    },
    editedAt: Date,
    readBy: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        readAt: {
            type: Date,
            default: Date.now
        }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

const Message = mongoose.model('Message', messageSchema);

// Log Schema (İşlem logları için)
const logSchema = new mongoose.Schema({
    action: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    data: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
    source: { type: String, default: 'api' },
    status: { type: String, enum: ['success', 'error'], default: 'success' }
});

const Log = mongoose.model('Log', logSchema);

// Socket.io Event Handlers
io.on('connection', (socket) => {
    console.log(`👤 Kullanıcı bağlandı: ${socket.id}`);

    // Kullanıcı giriş yaptığında
    socket.on('user-login', async (userData) => {
        try {
            const { userId, name } = userData;

            // Kullanıcıyı online listesine ekle
            onlineUsers.set(userId, {
                socketId: socket.id,
                name: name,
                lastSeen: new Date()
            });

            // Kullanıcıyı kendi ID'si ile room'a ekle
            socket.join(userId);

            // Tüm online kullanıcılara bu kullanıcının online olduğunu bildir
            io.emit('user-online', {
                userId: userId,
                name: name,
                onlineCount: onlineUsers.size
            });

            console.log(`✅ ${name} (${userId}) giriş yaptı. Online: ${onlineUsers.size}`);

        } catch (error) {
            console.error('❌ User login hatası:', error);
            socket.emit('error', { message: 'Giriş yapılırken hata oluştu' });
        }
    });

    // Chat room'a katıl
    socket.on('join-room', async (data) => {
        try {
            const { roomId, userId } = data;

            // Room'a katıl
            socket.join(roomId);

            // Room bilgilerini getir
            const room = await ChatRoom.findById(roomId)
                .populate('members', 'name email')
                .populate('createdBy', 'name email');

            if (!room) {
                socket.emit('error', { message: 'Oda bulunamadı' });
                return;
            }

            // Son mesajları getir
            const messages = await Message.find({ chatRoom: roomId })
                .populate('sender', 'name email')
                .sort({ createdAt: -1 })
                .limit(50);

            // Kullanıcıya room bilgilerini gönder
            socket.emit('room-joined', {
                room: room,
                messages: messages.reverse()
            });

            // Room'daki diğer kullanıcılara bildir
            socket.to(roomId).emit('user-joined-room', {
                userId: userId,
                roomId: roomId
            });

            console.log(`👥 Kullanıcı ${userId} room ${roomId}'a katıldı`);

        } catch (error) {
            console.error('❌ Join room hatası:', error);
            socket.emit('error', { message: 'Odaya katılırken hata oluştu' });
        }
    });

    // Mesaj gönder
    socket.on('send-message', async (data) => {
        try {
            const { content, senderId, roomId, messageType = 'text' } = data;

            // Yeni mesaj oluştur
            const newMessage = new Message({
                content: content,
                sender: senderId,
                chatRoom: roomId,
                messageType: messageType
            });

            const savedMessage = await newMessage.save();

            // Populate ile sender bilgilerini getir
            const populatedMessage = await Message.findById(savedMessage._id)
                .populate('sender', 'name email');

            // Room'daki tüm kullanıcılara mesajı gönder
            io.to(roomId).emit('new-message', populatedMessage);

            // RabbitMQ'ya mesaj analytics'i gönder
            await rabbitmq.sendToQueue('analytics-queue', {
                event: 'message-sent',
                userId: senderId,
                data: {
                    roomId: roomId,
                    messageLength: content.length,
                    messageType: messageType,
                    timestamp: new Date()
                }
            });

            console.log(`💬 Mesaj gönderildi: ${roomId} - ${content.substring(0, 50)}...`);

        } catch (error) {
            console.error('❌ Send message hatası:', error);
            socket.emit('error', { message: 'Mesaj gönderilirken hata oluştu' });
        }
    });

    // Yazıyor indicator
    socket.on('typing-start', (data) => {
        const { roomId, userId, userName } = data;
        socket.to(roomId).emit('user-typing', {
            userId: userId,
            userName: userName
        });
    });

    socket.on('typing-stop', (data) => {
        const { roomId, userId } = data;
        socket.to(roomId).emit('user-stopped-typing', {
            userId: userId
        });
    });

    // Mesaj okundu
    socket.on('message-read', async (data) => {
        try {
            const { messageId, userId } = data;

            await Message.findByIdAndUpdate(messageId, {
                $addToSet: {
                    readBy: {
                        user: userId,
                        readAt: new Date()
                    }
                }
            });

            // Room'daki diğer kullanıcılara bildir
            const message = await Message.findById(messageId);
            socket.to(message.chatRoom.toString()).emit('message-read-update', {
                messageId: messageId,
                userId: userId
            });

        } catch (error) {
            console.error('❌ Message read hatası:', error);
        }
    });

    // Kullanıcı çıkış yaptığında
    socket.on('disconnect', () => {
        // Online listesinden çıkar
        let disconnectedUser = null;
        for (const [userId, userData] of onlineUsers.entries()) {
            if (userData.socketId === socket.id) {
                disconnectedUser = { userId, ...userData };
                onlineUsers.delete(userId);
                break;
            }
        }

        if (disconnectedUser) {
            // Tüm kullanıcılara bildir
            io.emit('user-offline', {
                userId: disconnectedUser.userId,
                name: disconnectedUser.name,
                onlineCount: onlineUsers.size
            });

            console.log(`👋 ${disconnectedUser.name} çıkış yaptı. Online: ${onlineUsers.size}`);
        }

        console.log(`👤 Kullanıcı bağlantısı kesildi: ${socket.id}`);
    });
});

// Background Workers (Queue Consumer'lar)
async function startBackgroundWorkers() {
    try {
        // Email Queue Worker
        await rabbitmq.consumeQueue('email-queue', async (message) => {
            const { type, userId, email, data } = message;

            console.log(`📧 Email işlemi başladı: ${type}`);

            let sendStatus = 'success';
            let sendInfo = null;
            try {
                if (smtpTransporter) {
                    const mailOptions = {
                        from: process.env.SMTP_FROM || process.env.SMTP_USER,
                        to: email,
                        subject: data?.subject || `Welcome, ${data?.userName || 'User'}!`,
                        html: data?.html || `<h2>Hoş geldiniz, ${data?.userName || 'kullanıcı'}!</h2><p>Hesabınız başarıyla oluşturuldu.</p>`
                    };
                    sendInfo = await smtpTransporter.sendMail(mailOptions);
                    console.log('📨 SMTP send result:', sendInfo?.messageId || sendInfo);
                } else {
                    // Simülasyon modu
                    await new Promise(resolve => setTimeout(resolve, 500));
                    console.log(`(Simulated) Email to ${email}`);
                }
            } catch (err) {
                sendStatus = 'error';
                console.error('❌ SMTP gönderim hatası:', err.message);
            }

            // Log kaydı
            await Log.create({
                action: `email-${type}`,
                userId: userId,
                data: { email, type, data, sendInfo },
                status: sendStatus
            });

            console.log(`✅ Email işleme tamamlandı: ${email} (${type}) - ${sendStatus}`);
        });

        // SMS Queue Worker
        await rabbitmq.consumeQueue('sms-queue', async (message) => {
            const { type, phone, content } = message;

            console.log(`📱 SMS işlemi başladı: ${type}`);

            // Simulate SMS sending
            await new Promise(resolve => setTimeout(resolve, 800));

            await Log.create({
                action: `sms-${type}`,
                data: { phone, content, type },
                status: 'success'
            });

            console.log(`✅ SMS gönderildi: ${phone} (${type})`);
        });

        // Analytics Queue Worker
        await rabbitmq.consumeQueue('analytics-queue', async (message) => {
            const { event, userId, data } = message;

            console.log(`📊 Analytics işlemi başladı: ${event}`);

            // Simulate analytics processing
            await new Promise(resolve => setTimeout(resolve, 500));

            await Log.create({
                action: `analytics-${event}`,
                userId: userId,
                data: { event, data },
                status: 'success'
            });

            console.log(`✅ Analytics kaydedildi: ${event}`);
        });

        // Image Processing Queue Worker
        await rabbitmq.consumeQueue('image-processing-queue', async (message) => {
            const { userId, imagePath, operations } = message;

            console.log(`🖼️ Image processing başladı: ${operations.join(', ')}`);

            // Simulate image processing
            await new Promise(resolve => setTimeout(resolve, 2000));

            await Log.create({
                action: 'image-processed',
                userId: userId,
                data: { imagePath, operations },
                status: 'success'
            });

            console.log(`✅ Image processing tamamlandı: ${imagePath}`);
        });

        console.log('🔄 Tüm background worker\'lar başlatıldı!');

    } catch (error) {
        console.error('❌ Background worker başlatma hatası:', error.message);
    }
}

// Routes

// Ana sayfa
app.get('/', (req, res) => {
    res.json({
        message: '🚀 Express.js + MongoDB + RabbitMQ + Socket.io API\'sine Hoş Geldiniz!',
        version: '4.0.0',
        services: {
            database: 'MongoDB + Mongoose',
            messageQueue: 'RabbitMQ',
            backgroundJobs: 'Active',
            realTime: 'Socket.io'
        },
        endpoints: {
            'GET /api/users': 'Tüm kullanıcıları listele',
            'POST /api/users': 'Yeni kullanıcı oluştur (+ Background Jobs)',
            'GET /api/chat/rooms': 'Chat odalarını listele',
            'POST /api/chat/rooms': 'Yeni chat odası oluştur',
            'GET /api/chat/online-users': 'Online kullanıcıları getir',
            'GET /api/logs': 'Sistem loglarını görüntüle',
            'GET /api/queues/status': 'Queue durumlarını kontrol et'
        },
        socketEvents: [
            'user-login → Kullanıcı giriş',
            'join-room → Chat odasına katıl',
            'send-message → Mesaj gönder',
            'typing-start/stop → Yazıyor indicator',
            'message-read → Mesaj okundu'
        ]
    });
});

// POST /api/users - Yeni kullanıcı oluştur (RabbitMQ ile background jobs)
app.post('/api/users', async (req, res) => {
    try {
        const { name, email, phone, age, status } = req.body;

        const newUser = new User({
            name,
            email,
            phone,
            age,
            status: status || 'active'
        });

        const savedUser = await newUser.save();

        res.status(201).json({
            success: true,
            message: 'Kullanıcı oluşturuldu! Background işlemleri başlatıldı.',
            data: savedUser,
            backgroundJobs: {
                email: 'Welcome email gönderiliyor...',
                sms: `SMS gönderiliyor: ${savedUser.phone}`,
                analytics: 'User registration analytics kaydediliyor...'
            }
        });

        // Background Jobs
        await rabbitmq.sendToQueue('email-queue', {
            type: 'welcome',
            userId: savedUser._id,
            email: savedUser.email,
            data: { userName: savedUser.name }
        });

        await rabbitmq.sendToQueue('sms-queue', {
            type: 'verification',
            phone: savedUser.phone,
            content: `Merhaba ${savedUser.name}, hesabınız oluşturuldu! Doğrulama kodu: ${Math.floor(100000 + Math.random() * 900000)}`
        });

        await rabbitmq.sendToQueue('analytics-queue', {
            event: 'user-registered',
            userId: savedUser._id,
            data: {
                userAge: savedUser.age,
                registrationDate: savedUser.createdAt,
                source: 'api'
            }
        });

        await rabbitmq.sendToQueue('image-processing-queue', {
            userId: savedUser._id,
            imagePath: `/uploads/default-avatar.jpg`,
            operations: ['resize', 'optimize', 'thumbnail']
        });

        // Socket.io ile real-time bildirim
        io.emit('new-user-registered', {
            user: {
                id: savedUser._id,
                name: savedUser.name,
                email: savedUser.email
            },
            timestamp: new Date()
        });

        console.log(`🎉 Kullanıcı oluşturuldu ve background job'lar başlatıldı: ${savedUser.email}`);

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

// GET /api/users - Kullanıcıları listele
app.get('/api/users', async (req, res) => {
    try {
        const users = await User.find({}).select('-__v').sort({ createdAt: -1 });

        res.json({
            success: true,
            count: users.length,
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

// GET /api/chat/rooms - Chat odalarını listele
app.get('/api/chat/rooms', async (req, res) => {
    try {
        const { userId } = req.query;

        const rooms = await ChatRoom.find({
            $or: [
                { isPrivate: false },
                { members: userId },
                { createdBy: userId }
            ]
        })
            .populate('createdBy', 'name email')
            .populate('members', 'name email')
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: rooms.length,
            data: rooms
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Chat odaları getirilirken hata oluştu',
            error: error.message
        });
    }
});

// POST /api/chat/rooms - Yeni chat odası oluştur
app.post('/api/chat/rooms', async (req, res) => {
    try {
        const { name, description, createdBy, isPrivate = false } = req.body;

        const newRoom = new ChatRoom({
            name: name,
            description: description,
            createdBy: createdBy,
            members: [createdBy],
            isPrivate: isPrivate
        });

        const savedRoom = await newRoom.save();
        const populatedRoom = await ChatRoom.findById(savedRoom._id)
            .populate('createdBy', 'name email')
            .populate('members', 'name email');

        // Socket.io ile tüm kullanıcılara yeni oda bildir
        io.emit('new-room-created', populatedRoom);

        res.status(201).json({
            success: true,
            message: 'Chat odası oluşturuldu',
            data: populatedRoom
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Chat odası oluşturulurken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/chat/rooms/:id/messages - Odanın mesajlarını getir
app.get('/api/chat/rooms/:id/messages', async (req, res) => {
    try {
        const { id } = req.params;
        const { limit = 50, page = 1 } = req.query;

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        const messages = await Message.find({ chatRoom: id })
            .populate('sender', 'name email')
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limitNum);

        res.json({
            success: true,
            count: messages.length,
            data: messages.reverse()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Mesajlar getirilirken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/chat/online-users - Online kullanıcıları getir
app.get('/api/chat/online-users', (req, res) => {
    const onlineList = Array.from(onlineUsers.entries()).map(([userId, userData]) => ({
        userId: userId,
        name: userData.name,
        lastSeen: userData.lastSeen
    }));

    res.json({
        success: true,
        count: onlineList.length,
        data: onlineList
    });
});

// GET /api/logs - Sistem loglarını görüntüle
app.get('/api/logs', async (req, res) => {
    try {
        const { limit = 20, action } = req.query;

        let query = {};
        if (action) {
            query.action = { $regex: action, $options: 'i' };
        }

        const logs = await Log.find(query)
            .populate('userId', 'name email')
            .sort({ timestamp: -1 })
            .limit(parseInt(limit));

        res.json({
            success: true,
            count: logs.length,
            data: logs
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Loglar getirilirken hata oluştu',
            error: error.message
        });
    }
});

// GET /api/queues/status - Queue durumlarını kontrol et
app.get('/api/queues/status', async (req, res) => {
    try {
        const queueNames = ['email-queue', 'sms-queue', 'analytics-queue', 'image-processing-queue'];
        const queueStatus = {};

        for (const queueName of queueNames) {
            try {
                const info = await rabbitmq.getQueueInfo(queueName);
                queueStatus[queueName] = {
                    messageCount: info.messageCount,
                    consumerCount: info.consumerCount
                };
            } catch (error) {
                queueStatus[queueName] = {
                    status: 'not_found',
                    error: error.message
                };
            }
        }

        res.json({
            success: true,
            rabbitmqConnected: rabbitmq.isConnected,
            queues: queueStatus,
            onlineUsers: onlineUsers.size,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Queue durumu kontrol edilirken hata oluştu',
            error: error.message
        });
    }
});

// 404 Handler
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Bu endpoint mevcut değil',
        availableEndpoints: [
            'GET /',
            'GET /api/users',
            'POST /api/users',
            'GET /api/chat/rooms',
            'POST /api/chat/rooms',
            'GET /api/chat/online-users',
            'GET /api/logs',
            'GET /api/queues/status'
        ]
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

// Graceful Shutdown
process.on('SIGINT', async () => {
    console.log('\n🔄 Sunucu kapatılıyor...');

    // Socket.io bağlantılarını kapat
    io.close(() => {
        console.log('✅ Socket.io bağlantıları kapatıldı');
    });

    if (rabbitmq.connection) {
        await rabbitmq.connection.close();
        console.log('✅ RabbitMQ bağlantısı kapatıldı');
    }

    await mongoose.connection.close();
    console.log('✅ MongoDB bağlantısı kapatıldı');

    process.exit(0);
});

// Server başlat
const PORT = process.env.PORT || 3000;

async function startServer() {
    try {
        // RabbitMQ'ya bağlan
        await rabbitmq.connect();

        // Background worker'ları başlat
        await startBackgroundWorkers();

        // Server'ı başlat (app.listen yerine server.listen)
        server.listen(PORT, () => {
            console.log(`\n🚀 Express.js + MongoDB + RabbitMQ + Socket.io sunucusu http://localhost:${PORT} adresinde çalışıyor`);
            console.log('\n📋 API Endpoint\'leri:');
            console.log('GET    http://localhost:3000/                         - API bilgileri');
            console.log('POST   http://localhost:3000/api/users                - Kullanıcı oluştur (+ Background Jobs)');
            console.log('GET    http://localhost:3000/api/users                - Kullanıcıları listele');
            console.log('GET    http://localhost:3000/api/chat/rooms           - Chat odaları');
            console.log('POST   http://localhost:3000/api/chat/rooms           - Yeni chat odası');
            console.log('GET    http://localhost:3000/api/chat/online-users    - Online kullanıcılar');
            console.log('GET    http://localhost:3000/api/logs                 - Sistem logları');
            console.log('GET    http://localhost:3000/api/queues/status        - Queue durumu');
            console.log('\n💬 Socket.io Events:');
            console.log('🔌 user-login        - Kullanıcı giriş');
            console.log('🏠 join-room         - Chat odasına katıl');
            console.log('💬 send-message      - Mesaj gönder');
            console.log('⌨️  typing-start/stop - Yazıyor indicator');
            console.log('✅ message-read      - Mesaj okundu');
            console.log('\n🌐 Management UI\'ler:');
            console.log('🐰 RabbitMQ Management: http://localhost:15672');
            console.log('🍃 MongoDB UI: http://localhost:8081');
            console.log('\n🎉 Real-time chat sistemi hazır! Background job\'lar çalışıyor...\n');
        });

    } catch (error) {
        console.error('❌ Server başlatma hatası:', error.message);
        process.exit(1);
    }
}

startServer();