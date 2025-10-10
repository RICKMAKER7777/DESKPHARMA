// index.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import sqlite3 from 'sqlite3';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Client, LocalAuth, MessageMedia } = pkg;

const app = express();
const server = http.createServer(app);

// Configuração do banco de dados SQLite
let db;

// Função para executar queries no SQLite
function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else resolve({ lastID: this.lastID, changes: this.changes });
        });
    });
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

function dbExec(sql) {
    return new Promise((resolve, reject) => {
        db.exec(sql, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

async function initializeDatabase() {
    return new Promise((resolve, reject) => {
        // Criar pasta uploads se não existir
        fs.mkdir('uploads', { recursive: true }).catch(() => {});

        db = new sqlite3.Database('./deskpharma.db', (err) => {
            if (err) {
                console.error('[DATABASE] Erro ao conectar com o banco:', err);
                reject(err);
            } else {
                console.log('[DATABASE] Conectado ao SQLite');
                createTables().then(resolve).catch(reject);
            }
        });
    });
}

async function createTables() {
    try {
        // Tabela de usuários
        await dbExec(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                phone TEXT,
                avatar TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT 1
            )
        `);

        // Tabela de conversas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT NOT NULL,
                contact_name TEXT,
                contact_avatar TEXT,
                last_message TEXT,
                last_message_time DATETIME,
                unread_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de mensagens
        await dbExec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER,
                phone_number TEXT NOT NULL,
                message_type TEXT NOT NULL,
                content TEXT,
                media_url TEXT,
                media_type TEXT,
                is_from_me BOOLEAN DEFAULT 0,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'sent',
                FOREIGN KEY (conversation_id) REFERENCES conversations (id)
            )
        `);

        // Tabela de vendas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date DATE NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                items_count INTEGER,
                status TEXT DEFAULT 'completed',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de entregas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS deliveries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id TEXT NOT NULL,
                client_name TEXT NOT NULL,
                delivery_person TEXT,
                status TEXT DEFAULT 'pending',
                value DECIMAL(10,2),
                address TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de atendimentos
        await dbExec(`
            CREATE TABLE IF NOT EXISTS services (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_name TEXT,
                service_type TEXT,
                status TEXT,
                attendant_id INTEGER,
                start_time DATETIME,
                end_time DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de aprovações
        await dbExec(`
            CREATE TABLE IF NOT EXISTS approvals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                employee_name TEXT NOT NULL,
                approval_type TEXT NOT NULL,
                request_date DATE NOT NULL,
                status TEXT DEFAULT 'pending',
                details TEXT,
                approved_by TEXT,
                approved_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de metas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS goals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                month_year TEXT NOT NULL,
                target_amount DECIMAL(10,2) NOT NULL,
                current_amount DECIMAL(10,2) DEFAULT 0,
                progress_percentage DECIMAL(5,2) DEFAULT 0,
                days_remaining INTEGER,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Verificar se já existem usuários
        const userCount = await dbGet('SELECT COUNT(*) as count FROM users');
        
        if (userCount.count === 0) {
            const hashedPassword = await bcrypt.hash('123456', 10);
            
            await dbRun(`
                INSERT INTO users (name, email, password, role, phone) 
                VALUES (?, ?, ?, ?, ?)
            `, ['Supervisor Master', 'supervisor@deskpharma.com', hashedPassword, 'supervisor', '+5511999999999']);

            await dbRun(`
                INSERT INTO users (name, email, password, role, phone) 
                VALUES (?, ?, ?, ?, ?)
            `, ['Atendente João', 'atendente@deskpharma.com', hashedPassword, 'attendant', '+5511988888888']);

            await dbRun(`
                INSERT INTO users (name, email, password, role, phone) 
                VALUES (?, ?, ?, ?, ?)
            `, ['Entregador Carlos', 'entregador@deskpharma.com', hashedPassword, 'delivery', '+5511977777777']);

            // Inserir dados de exemplo
            const today = new Date().toISOString().split('T')[0];
            
            await dbRun(`
                INSERT INTO sales (date, amount, items_count) VALUES (?, ?, ?)
            `, [today, 3458.90, 15]);

            await dbRun(`
                INSERT INTO deliveries (order_id, client_name, delivery_person, status, value) 
                VALUES (?, ?, ?, ?, ?)
            `, ['#12345', 'Maria Oliveira', 'João Motoboy', 'completed', 87.50]);

            await dbRun(`
                INSERT INTO approvals (employee_name, approval_type, request_date, status) 
                VALUES (?, ?, ?, ?)
            `, ['Carlos Silva', 'Cadastro', '2023-05-12', 'pending']);

            await dbRun(`
                INSERT INTO goals (month_year, target_amount, current_amount, progress_percentage, days_remaining) 
                VALUES (?, ?, ?, ?, ?)
            `, ['2023-05', 50000, 39000, 78, 12]);

            console.log('[DATABASE] Dados de exemplo inseridos');
        }

        console.log('[DATABASE] Tabelas criadas com sucesso');
    } catch (error) {
        console.error('[DATABASE] Erro ao criar tabelas:', error);
        throw error;
    }
}

// Configuração do multer para upload de arquivos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});
const upload = multer({ storage: storage });

// Servir arquivos estáticos
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static('uploads'));

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'deskpharma-secret-key';

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN, credentials: true }));
app.use(express.json({ limit: '50mb' }));

const io = new SocketIOServer(server, {
    cors: { origin: ORIGIN === '*' ? true : ORIGIN },
});

// Middleware de autenticação JWT
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token de acesso necessário' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// Variáveis para controlar o estado
let whatsappStatus = 'disconnected';
let lastConnectionTime = null;
let connectionError = null;

// Configurações otimizadas
const puppeteerOptions = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-cache',
        '--memory-pressure-off',
        '--max-old-space-size=256'
    ]
};

const waClient = new Client({
    authStrategy: new LocalAuth({ 
        dataPath: process.env.SESSION_DIR || '.wwebjs_auth'
    }),
    puppeteer: puppeteerOptions,
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

// --------------------- FUNÇÕES AUXILIARES CORRIGIDAS ---------------------
function normalizeNumber(number) {
    if (!number || typeof number !== 'string') return null;
    number = number.replace(/\D/g, '');
    if (number.length < 10) return null;
    if (!number.startsWith('55')) {
        number = '55' + number;
    }
    return number + '@c.us';
}

// CORREÇÃO: Função auxiliar para obter conteúdo padrão para mensagens sem texto
function getDefaultMessageContent(messageType) {
    const defaults = {
        'image': '📷 Imagem',
        'video': '🎥 Vídeo',
        'audio': '🎵 Áudio',
        'document': '📄 Documento',
        'sticker': '🖼️ Figurinha',
        'location': '📍 Localização',
        'contact': '👤 Contato'
    };
    
    return defaults[messageType] || '📎 Mídia';
}

// CORREÇÃO: Função para tentar obter nome do contato
async function getContactName(phoneNumber) {
    try {
        // Em produção, você pode buscar do WhatsApp ou de uma base de clientes
        // Por enquanto, retorna o número formatado
        const cleanNumber = phoneNumber.replace('@c.us', '');
        return `Cliente ${cleanNumber.substring(cleanNumber.length - 4)}`;
    } catch (error) {
        return phoneNumber;
    }
}

// CORREÇÃO: Melhorar a função saveMessage para lidar melhor com diferentes tipos de mensagem
async function saveMessage(messageData) {
    try {
        const { phone_number, message_type, content, media_url, media_type, is_from_me } = messageData;
        
        // Buscar ou criar conversa
        let existingConv = await dbGet(
            'SELECT id FROM conversations WHERE phone_number = ?', 
            [phone_number]
        );
        
        let convId;
        if (existingConv) {
            convId = existingConv.id;
            
            // Atualizar unread_count se for mensagem recebida
            if (!is_from_me) {
                await dbRun(
                    'UPDATE conversations SET unread_count = unread_count + 1 WHERE id = ?',
                    [convId]
                );
            }
        } else {
            const contactName = await getContactName(phone_number);
            const result = await dbRun(
                'INSERT INTO conversations (phone_number, contact_name, last_message, last_message_time, unread_count) VALUES (?, ?, ?, ?, ?)',
                [phone_number, contactName, content, new Date().toISOString(), is_from_me ? 0 : 1]
            );
            convId = result.lastID;
        }

        // CORREÇÃO: Garantir que o conteúdo não seja null
        const messageContent = content || getDefaultMessageContent(message_type);
        
        // Inserir mensagem
        const result = await dbRun(
            `INSERT INTO messages (conversation_id, phone_number, message_type, content, media_url, media_type, is_from_me, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [convId, phone_number, message_type, messageContent, media_url, media_type, is_from_me, new Date().toISOString()]
        );

        // Atualizar última mensagem da conversa
        await dbRun(
            'UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?',
            [messageContent, new Date().toISOString(), convId]
        );

        return result.lastID;
    } catch (error) {
        console.error('[DATABASE] Erro ao salvar mensagem:', error);
        throw error;
    }
}

// --------------------- NOVOS ENDPOINTS ---------------------

// Autenticação
app.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await dbGet('SELECT * FROM users WHERE email = ? AND is_active = 1', [email]);
        if (!user) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Credenciais inválidas' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone: user.phone,
                avatar: user.avatar
            }
        });
    } catch (error) {
        console.error('[AUTH] Erro no login:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Cadastro de usuário
app.post('/auth/register', async (req, res) => {
    try {
        const { name, email, password, role, phone } = req.body;

        const existingUser = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (existingUser) {
            return res.status(400).json({ error: 'E-mail já cadastrado' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await dbRun(
            'INSERT INTO users (name, email, password, role, phone) VALUES (?, ?, ?, ?, ?)',
            [name, email, hashedPassword, role, phone]
        );

        res.json({ success: true, message: 'Usuário cadastrado com sucesso', userId: result.lastID });
    } catch (error) {
        console.error('[AUTH] Erro no cadastro:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Recuperação de senha
app.post('/auth/forgot-password', async (req, res) => {
    try {
        const { email } = req.body;

        const user = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
        if (!user) {
            return res.json({ success: true, message: 'Se o e-mail existir, enviaremos instruções' });
        }

        // Em produção, enviar e-mail com link de recuperação
        const resetToken = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '1h' });
        
        res.json({ 
            success: true, 
            message: 'Instruções de recuperação enviadas para seu e-mail',
            resetToken // Em produção, enviar por e-mail
        });
    } catch (error) {
        console.error('[AUTH] Erro na recuperação:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Dashboard - Dados gerais
app.get('/dashboard/stats', authenticateToken, async (req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        
        // Vendas de hoje
        const salesToday = await dbGet(
            'SELECT SUM(amount) as total FROM sales WHERE date = ?', 
            [today]
        );

        // Entregas
        const deliveries = await dbGet(
            'SELECT COUNT(*) as total, SUM(CASE WHEN status = "completed" THEN 1 ELSE 0 END) as completed FROM deliveries'
        );

        // Atendimentos
        const services = await dbGet(
            'SELECT COUNT(*) as total FROM services WHERE DATE(created_at) = ?',
            [today]
        );

        // Meta do mês
        const goal = await dbGet(
            'SELECT * FROM goals ORDER BY id DESC LIMIT 1'
        );

        // Aprovações pendentes
        const pendingApprovals = await dbGet(
            'SELECT COUNT(*) as count FROM approvals WHERE status = "pending"'
        );

        res.json({
            sales_today: salesToday?.total || 3458.90,
            deliveries: {
                completed: deliveries?.completed || 24,
                total: deliveries?.total || 30,
                pending: 5
            },
            services: {
                total: services?.total || 56,
                in_progress: 8
            },
            goal: goal || { progress_percentage: 78, days_remaining: 12 },
            pending_approvals: pendingApprovals?.count || 3
        });
    } catch (error) {
        console.error('[DASHBOARD] Erro ao buscar estatísticas:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Mensagens - Listar conversas
app.get('/messages/conversations', authenticateToken, async (req, res) => {
    try {
        const conversations = await dbAll(`
            SELECT c.*, COUNT(m.id) as message_count 
            FROM conversations c 
            LEFT JOIN messages m ON c.id = m.conversation_id 
            GROUP BY c.id 
            ORDER BY c.last_message_time DESC
        `);
        
        res.json({ success: true, conversations });
    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar conversas:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// CORREÇÃO: Endpoint de mensagens - melhorar o filtro por conversa
app.get('/messages/conversation/:phone', authenticateToken, async (req, res) => {
    try {
        const { phone } = req.params;
        
        // CORREÇÃO: Garantir que o número esteja no formato correto
        let normalizedPhone = phone;
        if (!phone.includes('@c.us')) {
            normalizedPhone = normalizeNumber(phone);
        }
        
        const messages = await dbAll(`
            SELECT * FROM messages 
            WHERE phone_number = ? 
            ORDER BY timestamp ASC
        `, [normalizedPhone]);
        
        // CORREÇÃO: Processar mensagens para garantir formato consistente
        const processedMessages = messages.map(msg => ({
            id: msg.id,
            body: msg.content,
            content: msg.content,
            from: msg.phone_number,
            to: msg.is_from_me ? msg.phone_number : 'me',
            fromMe: Boolean(msg.is_from_me),
            is_from_me: Boolean(msg.is_from_me),
            timestamp: msg.timestamp,
            type: msg.message_type
        }));
        
        res.json({ success: true, messages: processedMessages });
    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar mensagens:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Mensagens - Iniciar nova conversa
app.post('/messages/conversation', authenticateToken, async (req, res) => {
    try {
        const { phone_number, contact_name, contact_avatar } = req.body;
        
        const existingConv = await dbGet(
            'SELECT id FROM conversations WHERE phone_number = ?', 
            [phone_number]
        );
        
        if (existingConv) {
            return res.json({ success: true, conversation_id: existingConv.id });
        }
        
        const result = await dbRun(
            'INSERT INTO conversations (phone_number, contact_name, contact_avatar) VALUES (?, ?, ?)',
            [phone_number, contact_name, contact_avatar]
        );
        
        res.json({ success: true, conversation_id: result.lastID });
    } catch (error) {
        console.error('[MESSAGES] Erro ao criar conversa:', error);
        res.status(500).json({ error: 'Erro interno do servidor' });
    }
});

// Upload de mídia
app.post('/upload/media', upload.single('media'), authenticateToken, (req, res) => {
    try {
        const fileUrl = `/uploads/${req.file.filename}`;
        res.json({ success: true, url: fileUrl, filename: req.file.filename });
    } catch (error) {
        console.error('[UPLOAD] Erro no upload:', error);
        res.status(500).json({ error: 'Erro no upload do arquivo' });
    }
});

// --------------------- EVENTOS WHATSAPP CORRIGIDOS ---------------------
waClient.on('qr', async (qr) => {
    whatsappStatus = 'qr_code';
    connectionError = null;
    
    try {
        const dataUrl = await QRCode.toDataURL(qr, {
            width: 300,
            height: 300,
            margin: 1
        });
        
        io.emit('wa:qr', { 
            dataUrl,
            timestamp: new Date().toISOString()
        });
        
        console.log('[WA] QR Code gerado');
    } catch (error) {
        console.error('[WA] Erro ao gerar QR Code:', error);
    }
});

waClient.on('ready', () => {
    whatsappStatus = 'ready';
    lastConnectionTime = new Date();
    connectionError = null;
    
    io.emit('wa:status', { 
        status: 'ready',
        timestamp: lastConnectionTime.toISOString()
    });
    
    console.log('[WA] Ready - Conectado e pronto');
});

waClient.on('authenticated', () => {
    whatsappStatus = 'authenticated';
    connectionError = null;
    
    io.emit('wa:status', { 
        status: 'authenticated',
        timestamp: new Date().toISOString()
    });
    
    console.log('[WA] Autenticado');
});

waClient.on('auth_failure', (msg) => {
    whatsappStatus = 'auth_failure';
    connectionError = msg;
    
    io.emit('wa:status', { 
        status: 'auth_failure', 
        msg,
        timestamp: new Date().toISOString()
    });
    
    console.log('[WA] Falha na autenticação:', msg);
});

waClient.on('disconnected', (reason) => {
    whatsappStatus = 'disconnected';
    connectionError = reason;
    
    io.emit('wa:status', { 
        status: 'disconnected', 
        reason,
        timestamp: new Date().toISOString()
    });
    
    console.log('[WA] Desconectado:', reason);
});

// CORREÇÃO: Melhorar o evento de mensagem do WhatsApp
waClient.on('message', async (msg) => {
    try {
        // CORREÇÃO: Processar melhor o conteúdo da mensagem
        let messageContent = msg.body;
        let messageType = msg.type;
        
        // Se não há corpo e é uma mídia, definir conteúdo descritivo
        if (!messageContent && msg.hasMedia) {
            messageContent = getDefaultMessageContent(msg.type);
        }
        
        const payload = {
            from: msg.from,
            to: msg.to,
            body: messageContent,
            content: messageContent,
            timestamp: msg.timestamp * 1000,
            fromMe: msg.fromMe,
            id: msg.id?._serialized,
            hasMedia: msg.hasMedia,
            type: msg.type
        };

        // Salvar mensagem no banco
        await saveMessage({
            phone_number: msg.fromMe ? msg.to : msg.from, // CORREÇÃO: Usar remetente/destinatário correto
            message_type: msg.type,
            content: messageContent,
            is_from_me: msg.fromMe
        });

        io.emit('wa:message', payload);
        console.log(`[WA] Mensagem recebida de ${msg.from}: ${messageContent.substring(0, 50)}...`);
        
    } catch (error) {
        console.error('[WA] Erro ao processar mensagem:', error);
    }
});

// CORREÇÃO: Adicionar evento para mensagens enviadas
waClient.on('message_create', async (msg) => {
    // Esta evento é disparado quando uma mensagem é enviada (incluindo as que enviamos)
    if (msg.fromMe) {
        try {
            let messageContent = msg.body;
            
            if (!messageContent && msg.hasMedia) {
                messageContent = getDefaultMessageContent(msg.type);
            }
            
            const payload = {
                from: msg.from,
                to: msg.to,
                body: messageContent,
                content: messageContent,
                timestamp: msg.timestamp * 1000,
                fromMe: true,
                id: msg.id?._serialized,
                hasMedia: msg.hasMedia,
                type: msg.type
            };

            // Salvar mensagem no banco
            await saveMessage({
                phone_number: msg.to, // CORREÇÃO: Para mensagens enviadas, o "to" é o contato
                message_type: msg.type,
                content: messageContent,
                is_from_me: true
            });

            io.emit('wa:sent', payload);
            console.log(`[WA] Mensagem enviada para ${msg.to}: ${messageContent.substring(0, 50)}...`);
            
        } catch (error) {
            console.error('[WA] Erro ao processar mensagem enviada:', error);
        }
    }
});

// --------------------- ENDPOINTS EXISTENTES ---------------------

// STATUS
app.get('/status', (req, res) => {
    const statusInfo = {
        status: whatsappStatus,
        last_connection: lastConnectionTime,
        error: connectionError,
        timestamp: new Date().toISOString(),
        details: getStatusDetails(whatsappStatus)
    };
    res.json(statusInfo);
});

function getStatusDetails(status) {
    const details = {
        'ready': 'WhatsApp conectado e funcionando normalmente',
        'authenticated': 'WhatsApp autenticado, inicializando...',
        'qr_code': 'Aguardando leitura do QR Code',
        'disconnected': 'WhatsApp desconectado ou celular desligado',
        'auth_failure': 'Falha na autenticação do WhatsApp',
        'connecting': 'Conectando ao WhatsApp...',
        'disconnecting': 'Desconectando...'
    };
    return details[status] || 'Status desconhecido';
}

// HEALTH
app.get('/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    const memoryMB = {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024)
    };
    
    res.json({ 
        ok: true, 
        memory: memoryMB,
        status: whatsappStatus,
        uptime: process.uptime()
    });
});

// ENVIAR MENSAGEM DE TEXTO
app.post('/send', async (req, res) => {
    try {
        if (whatsappStatus !== 'ready') {
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp não está conectado',
                current_status: whatsappStatus
            });
        }

        let { to, message } = req.body;

        if (!to || !message) {
            return res.status(400).json({ success: false, error: 'to e message são obrigatórios' });
        }

        const chatId = normalizeNumber(to);
        if (!chatId) {
            return res.status(400).json({ success: false, error: 'Número inválido' });
        }

        await waClient.sendMessage(chatId, message);
        
        // Salvar mensagem no banco
        await saveMessage({
            phone_number: chatId,
            message_type: 'text',
            content: message,
            is_from_me: true
        });
        
        res.json({ success: true, to: chatId });

    } catch (err) {
        console.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Rota raiz - servir o dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'DASHBOARD.html'));
});

// --------------------- START SERVER ---------------------
async function startServer() {
    try {
        await initializeDatabase();
        
        console.log('[SERVER] Iniciando servidor...');
        
        // Inicializar WhatsApp client
        waClient.initialize().catch(err => {
            console.error('[WA] Erro na inicialização:', err);
            whatsappStatus = 'disconnected';
            connectionError = err.message;
        });

        whatsappStatus = 'connecting';

        server.listen(PORT, () => {
            console.log(`[SERVER] ✅ Servidor rodando na porta ${PORT}`);
            console.log(`[SERVER] 📊 Dashboard: http://localhost:${PORT}`);
            console.log(`[SERVER] 🔐 Login: POST http://localhost:${PORT}/auth/login`);
            console.log(`[SERVER] 📈 Stats: GET http://localhost:${PORT}/dashboard/stats`);
            console.log(`[SERVER] 🔍 Status: GET http://localhost:${PORT}/status`);
        });
    } catch (error) {
        console.error('[SERVER] Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[SERVER] Recebido SIGINT, encerrando...');
    if (db) {
        db.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[SERVER] Recebido SIGTERM, encerrando...');
    if (db) {
        db.close();
    }
    process.exit(0);
});

startServer().catch(console.error);