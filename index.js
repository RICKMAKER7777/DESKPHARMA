// index.js - API WhatsApp com Heartbeat e Conexão Persistente
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import sqlite3 from 'sqlite3';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';

const { Client, LocalAuth } = pkg;

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'deskpharma_secret_key_2024';

// 🔥 CONFIGURAÇÃO DE AMBIENTE RENDER
const IS_RENDER = process.env.RENDER === 'true';
const DB_PATH = IS_RENDER ? '/tmp/whatsapp_db.sqlite' : './whatsapp_db.sqlite';
const SESSIONS_PATH = IS_RENDER ? '/tmp/sessions' : './sessions';

// Criar diretórios se não existirem
if (!fs.existsSync(path.dirname(DB_PATH))) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}
if (!fs.existsSync(SESSIONS_PATH)) {
    fs.mkdirSync(SESSIONS_PATH, { recursive: true });
}

app.use(cors({ 
    origin: ORIGIN === '*' ? true : ORIGIN, 
    credentials: true 
}));
app.use(express.json({ limit: '50mb' }));

const io = new SocketIOServer(server, {
    cors: { 
        origin: ORIGIN === '*' ? true : ORIGIN,
        methods: ['GET', 'POST']
    },
});

// ==================== CONFIGURAÇÃO DO BANCO DE DADOS ====================
let db;

// Funções do banco de dados
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
        console.log(`[DATABASE] Conectando ao SQLite em: ${DB_PATH}`);
        
        db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('[DATABASE] Erro ao conectar com o banco:', err);
                reject(err);
            } else {
                console.log('[DATABASE] Conectado ao SQLite com persistência');
                db.run('PRAGMA foreign_keys = ON');
                createTables().then(resolve).catch(reject);
            }
        });
    });
}

async function createTables() {
    try {
        // Tabela de empresas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS empresas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cnpj TEXT UNIQUE NOT NULL,
                nome TEXT NOT NULL,
                telefone TEXT,
                email TEXT,
                whatsapp_status TEXT DEFAULT 'disconnected',
                whatsapp_qr_code TEXT,
                whatsapp_error TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de conversas
        await dbExec(`
            CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                empresa_id INTEGER NOT NULL,
                phone_number TEXT NOT NULL,
                contact_name TEXT,
                last_message TEXT,
                last_message_time DATETIME,
                unread_count INTEGER DEFAULT 0,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON DELETE CASCADE
            )
        `);

        // Tabela de mensagens
        await dbExec(`
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                empresa_id INTEGER NOT NULL,
                conversation_id INTEGER,
                phone_number TEXT NOT NULL,
                message_type TEXT NOT NULL,
                content TEXT,
                media_url TEXT,
                media_type TEXT,
                is_from_me BOOLEAN DEFAULT 0,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'sent',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (empresa_id) REFERENCES empresas (id) ON DELETE CASCADE,
                FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
            )
        `);

        // 🔥 DADOS INICIAIS PERSISTENTES
        await initializeDefaultData();
        
        console.log('[DATABASE] ✅ Todas as tabelas criadas/verificadas com dados iniciais');

    } catch (error) {
        console.error('[DATABASE] Erro ao criar tabelas:', error);
        throw error;
    }
}

// 🔥 INICIALIZAR DADOS PADRÃO
async function initializeDefaultData() {
    try {
        const empresaCount = await dbGet('SELECT COUNT(*) as count FROM empresas');
        
        if (empresaCount.count === 0) {
            console.log('[DATABASE] Inicializando dados padrão...');
            
            await dbRun(`
                INSERT INTO empresas (cnpj, nome, telefone, email, whatsapp_status) 
                VALUES (?, ?, ?, ?, ?)
            `, ['12345678000195', 'Farmácia Central', '+5511999999999', 'contato@farmaciacentral.com.br', 'disconnected']);

            await dbRun(`
                INSERT INTO empresas (cnpj, nome, telefone, email, whatsapp_status) 
                VALUES (?, ?, ?, ?, ?)
            `, ['98765432000187', 'Drogaria Popular', '+5511888888888', 'vendas@drogariapopular.com.br', 'disconnected']);

            console.log('[DATABASE] ✅ Empresas padrão inseridas');
        } else {
            console.log(`[DATABASE] 📊 ${empresaCount.count} empresas encontradas no banco`);
        }

    } catch (error) {
        console.error('[DATABASE] Erro ao inicializar dados:', error);
    }
}

// ==================== FUNÇÕES DE BANCO ====================

// Buscar todas as empresas
async function getAllEmpresas() {
    try {
        const empresas = await dbAll('SELECT * FROM empresas ORDER BY id');
        const empresasMap = new Map();
        
        empresas.forEach(emp => {
            empresasMap.set(emp.id, emp);
        });
        
        return empresasMap;
    } catch (error) {
        console.error('[DATABASE] Erro ao buscar empresas:', error);
        return new Map();
    }
}

// Buscar empresa por ID
async function getEmpresaById(id) {
    try {
        return await dbGet('SELECT * FROM empresas WHERE id = ?', [id]);
    } catch (error) {
        console.error('[DATABASE] Erro ao buscar empresa:', error);
        return null;
    }
}

// Atualizar status do WhatsApp
async function updateWhatsAppStatus(empresaId, status, qrCode = null, error = null) {
    try {
        await dbRun(
            'UPDATE empresas SET whatsapp_status = ?, whatsapp_qr_code = ?, whatsapp_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [status, qrCode, error, empresaId]
        );
        return true;
    } catch (error) {
        console.error('[DATABASE] Erro ao atualizar status:', error);
        return false;
    }
}

// Cadastrar nova empresa
async function createEmpresa(cnpj, nome, telefone, email) {
    try {
        const existing = await dbGet('SELECT id FROM empresas WHERE cnpj = ?', [cnpj]);
        if (existing) {
            throw new Error('CNPJ já cadastrado');
        }

        const result = await dbRun(
            'INSERT INTO empresas (cnpj, nome, telefone, email) VALUES (?, ?, ?, ?)',
            [cnpj, nome, telefone, email]
        );
        
        const novaEmpresa = await dbGet('SELECT * FROM empresas WHERE id = ?', [result.lastID]);
        return novaEmpresa;
        
    } catch (error) {
        console.error('[DATABASE] Erro ao criar empresa:', error);
        throw error;
    }
}

// ==================== TOKEN FIXO PARA BUBBLE ====================
const FIXED_TOKENS = [
    'bubble_integration_token_2024',
    'deskpharma_fixed_token',
    'whatsapp_api_bubble'
];

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token && FIXED_TOKENS.includes(token)) {
        req.user = { 
            id: 1, 
            email: 'bubble@integration.com', 
            role: 'admin',
            empresa_id: 1
        };
        return next();
    }

    if (token) {
        jwt.verify(token, JWT_SECRET, (err, user) => {
            if (!err) {
                req.user = user;
                return next();
            }
        });
    }

    return res.status(401).json({ 
        success: false,
        error: 'Token de acesso necessário ou inválido',
        valid_tokens: FIXED_TOKENS
    });
};

// ==================== STORAGE EM MEMÓRIA ====================
const whatsappInstances = new Map();
const instanceCreationLocks = new Map();
const connectionHeartbeats = new Map(); // 🔥 HEARTBEATS PARA MANTER CONEXÃO

// ==================== FUNÇÕES AUXILIARES ====================
function normalizeNumber(number) {
    if (!number || typeof number !== 'string') return null;
    number = number.replace(/\D/g, '');
    if (number.length < 10) return null;
    if (!number.startsWith('55')) {
        number = '55' + number;
    }
    return number + '@c.us';
}

function getDefaultMessageContent(messageType) {
    const defaults = {
        'image': '📷 Imagem',
        'video': '🎥 Vídeo', 
        'audio': '🎵 Áudio',
        'document': '📄 Documento',
        'sticker': '🖼️ Figurinha'
    };
    return defaults[messageType] || '📎 Mídia';
}

// Salvar mensagem no banco
async function saveMessageToDatabase(messageData) {
    try {
        const { empresa_id, phone_number, message_type, content, is_from_me } = messageData;
        
        let existingConv = await dbGet(
            'SELECT id FROM conversations WHERE empresa_id = ? AND phone_number = ?', 
            [empresa_id, phone_number]
        );
        
        let convId;
        if (existingConv) {
            convId = existingConv.id;
        } else {
            const contactName = `Cliente ${phone_number.replace('@c.us', '').slice(-4)}`;
            const result = await dbRun(
                'INSERT INTO conversations (empresa_id, phone_number, contact_name, last_message, last_message_time) VALUES (?, ?, ?, ?, ?)',
                [empresa_id, phone_number, contactName, content, new Date().toISOString()]
            );
            convId = result.lastID;
        }

        await dbRun(
            `INSERT INTO messages (empresa_id, conversation_id, phone_number, message_type, content, is_from_me, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [empresa_id, convId, phone_number, message_type, content, is_from_me ? 1 : 0, new Date().toISOString()]
        );

        await dbRun(
            'UPDATE conversations SET last_message = ?, last_message_time = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [content, new Date().toISOString(), convId]
        );

    } catch (error) {
        console.error('[DATABASE] Erro ao salvar mensagem:', error);
    }
}

// 🔥 LIMPAR SESSÃO PROBLEMÁTICA
async function clearProblematicSession(empresaId) {
    try {
        const sessionPath = path.join(SESSIONS_PATH, `empresa_${empresaId}`);
        if (fs.existsSync(sessionPath)) {
            console.log(`[WA-${empresaId}] 🗑️  Limpando sessão problemática...`);
            fs.rmSync(sessionPath, { recursive: true, force: true });
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    } catch (error) {
        console.log(`[WA-${empresaId}] ℹ️  Erro ao limpar sessão:`, error.message);
    }
}

// 🔥 INICIAR HEARTBEAT PARA MANTER CONEXÃO
function startConnectionHeartbeat(empresaId, client) {
    console.log(`[WA-${empresaId}] ❤️  Iniciando heartbeat de conexão...`);
    
    // Parar heartbeat anterior se existir
    if (connectionHeartbeats.has(empresaId)) {
        clearInterval(connectionHeartbeats.get(empresaId));
    }
    
    const heartbeat = setInterval(async () => {
        try {
            const state = await client.getState();
            if (state === 'CONNECTED') {
                console.log(`[WA-${empresaId}] ❤️  Conexão ativa - Estado: ${state}`);
                
                // 🔥 MANTER ATIVIDADE ENVIANDO COMANDO SIMPLES
                try {
                    // Comando simples para manter conexão ativa
                    await client.getChats({ limit: 1 });
                } catch (activityError) {
                    console.log(`[WA-${empresaId}] ℹ️  Heartbeat activity:`, activityError.message);
                }
            } else {
                console.log(`[WA-${empresaId}] ⚠️  Conexão perdida - Estado: ${state}`);
                // Tentar recuperar conexão
                try {
                    await client.initialize();
                } catch (reconnectError) {
                    console.log(`[WA-${empresaId}] ❌ Erro ao reconectar:`, reconnectError.message);
                }
            }
        } catch (error) {
            console.log(`[WA-${empresaId}] ❌ Erro no heartbeat:`, error.message);
        }
    }, 30000); // 🔥 A CADA 30 SEGUNDOS
    
    connectionHeartbeats.set(empresaId, heartbeat);
}

// 🔥 PARAR HEARTBEAT
function stopConnectionHeartbeat(empresaId) {
    if (connectionHeartbeats.has(empresaId)) {
        clearInterval(connectionHeartbeats.get(empresaId));
        connectionHeartbeats.delete(empresaId);
        console.log(`[WA-${empresaId}] 💔 Heartbeat parado`);
    }
}

// ==================== WHATSAPP INSTANCE CORRIGIDA ====================
function createWhatsAppInstance(empresaId, cnpj) {
    console.log(`[WA-${empresaId}] 🚀 Criando instância WhatsApp`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: `empresa_${empresaId}`,
            dataPath: path.join(SESSIONS_PATH, `empresa_${empresaId}`)
        }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-web-security',
                '--disable-features=site-per-process',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-ipc-flooding-protection'
            ],
            timeout: 60000,
            ignoreHTTPSErrors: true
        },
        // 🔥 CONFIGURAÇÕES PARA CONEXÃO ESTÁVEL
        takeoverOnConflict: false,
        takeoverTimeoutMs: 0,
        restartOnAuthFail: false,
        qrMaxRetries: 1,
        authTimeout: 60000,
        qrTimeout: 45000,
        multiDevice: true,
        // 🔥 CONFIGURAÇÕES ADICIONAIS PARA ESTABILIDADE
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
    });

    let qrTimeout;
    let isAuthenticated = false;
    let isReady = false;
    
    console.log(`[WA-${empresaId}] 📱 Instância criada`);

    // 🔥 EVENTO QR CODE
    client.on('qr', async (qr) => {
        try {
            console.log(`[WA-${empresaId}] 🔄 QR Code recebido`);
            
            if (qrTimeout) {
                clearTimeout(qrTimeout);
                qrTimeout = null;
            }

            const dataUrl = await QRCode.toDataURL(qr, {
                width: 300,
                height: 300,
                margin: 1
            });
            
            console.log(`[WA-${empresaId}] 📱 QR Code gerado - Aguardando escaneamento...`);
            
            await updateWhatsAppStatus(empresaId, 'qr_code', dataUrl, null);
            
            qrTimeout = setTimeout(async () => {
                if (isAuthenticated || isReady) {
                    console.log(`[WA-${empresaId}] ✅ Já autenticado, ignorando timeout`);
                    return;
                }
                
                console.log(`[WA-${empresaId}] ⏰ QR Code não escaneado em 45s`);
                
                try {
                    const state = await client.getState();
                    console.log(`[WA-${empresaId}] 🔍 Estado atual: ${state}`);
                } catch (error) {
                    console.log(`[WA-${empresaId}] ❌ Erro ao verificar estado: ${error.message}`);
                }
                
            }, 45000);

        } catch (error) {
            console.error(`[WA-${empresaId}] ❌ Erro no QR:`, error);
        }
    });

    // 🔥 EVENTO AUTHENTICATED
    client.on('authenticated', async (session) => {
        console.log(`[WA-${empresaId}] 🔑 AUTHENTICATED - QR Code lido com sucesso!`);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = true;
        await updateWhatsAppStatus(empresaId, 'authenticated', null, null);
        
        console.log(`[WA-${empresaId}] 📱 Dispositivo reconheceu a autenticação`);
    });

    // 🔥 EVENTO READY - CONEXÃO COMPLETA
    client.on('ready', async () => {
        console.log(`[WA-${empresaId}] 🎉 READY - WhatsApp conectado e pronto!`);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = true;
        isReady = true;
        
        await updateWhatsAppStatus(empresaId, 'ready', null, null);
        
        console.log(`[WA-${empresaId}] ✅ CONEXÃO ESTABELECIDA COM SUCESSO`);
        
        // 🔥 INICIAR HEARTBEAT APÓS READY
        startConnectionHeartbeat(empresaId, client);
        
        // 🔥 TESTE INICIAL DE FUNCIONAMENTO
        try {
            const chats = await client.getChats();
            console.log(`[WA-${empresaId}] 💬 ${chats.length} chats carregados`);
            
            // Teste de envio para si mesmo
            const me = client.info.wid.user;
            await client.sendMessage(`${me}@c.us`, '🤖 Bot conectado e funcionando!');
            console.log(`[WA-${empresaId}] ✅ Mensagem de teste enviada`);
        } catch (testError) {
            console.log(`[WA-${empresaId}] ℹ️  Teste inicial:`, testError.message);
        }
    });

    // 🔥 EVENTO CHANGE_STATE - MONITORAR CONEXÃO
    client.on('change_state', async (state) => {
        console.log(`[WA-${empresaId}] 🔄 MUDANÇA DE ESTADO: ${state}`);
        
        if (state === 'CONNECTED') {
            console.log(`[WA-${empresaId}] 🌐 CONECTADO AO WHATSAPP WEB`);
            if (!isReady) {
                console.log(`[WA-${empresaId}] 🔥 Reconectado - Reiniciando heartbeat`);
                startConnectionHeartbeat(empresaId, client);
            }
        } else if (state === 'DISCONNECTED') {
            console.log(`[WA-${empresaId}] 🔌 DESCONECTADO - Tentando recuperar...`);
            isReady = false;
        }
    });

    // 🔥 EVENTO AUTH FAILURE
    client.on('auth_failure', async (msg) => {
        console.log(`[WA-${empresaId}] ❌ FALHA NA AUTENTICAÇÃO:`, msg);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        stopConnectionHeartbeat(empresaId);
        await updateWhatsAppStatus(empresaId, 'auth_failure', null, msg);
        
        setTimeout(() => {
            clearProblematicSession(empresaId);
        }, 5000);
    });

    // 🔥 EVENTO DISCONNECTED - TRATAMENTO MELHORADO
    client.on('disconnected', async (reason) => {
        console.log(`[WA-${empresaId}] 🔌 DESCONECTADO: ${reason}`);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = false;
        isReady = false;
        stopConnectionHeartbeat(empresaId);
        
        await updateWhatsAppStatus(empresaId, 'disconnected', null, reason);
        
        // Remover instância da memória
        whatsappInstances.delete(empresaId);
        
        if (reason === 'LOGOUT') {
            console.log(`[WA-${empresaId}] 🚪 LOGOUT detectado - limpando sessão...`);
            await clearProblematicSession(empresaId);
        } else {
            // 🔥 TENTAR RECONEXÃO AUTOMÁTICA
            console.log(`[WA-${empresaId}] 🔄 Tentando reconexão em 10s...`);
            setTimeout(async () => {
                try {
                    console.log(`[WA-${empresaId}] 🔄 Iniciando reconexão...`);
                    await client.initialize();
                } catch (reconnectError) {
                    console.log(`[WA-${empresaId}] ❌ Erro na reconexão:`, reconnectError.message);
                }
            }, 10000);
        }
    });

    // 🔥 EVENTO MESSAGE - COM DEBUG DETALHADO
    client.on('message', async (msg) => {
    try {
        console.log(`[WA-${empresaId}] 📩 NOVA MENSAGEM DETECTADA:`);
        console.log(`[WA-${empresaId}] De: ${msg.from}`);
        console.log(`[WA-${empresaId}] Para: ${msg.to}`);
        console.log(`[WA-${empresaId}] Tipo: ${msg.type}`);
        console.log(`[WA-${empresaId}] Corpo: ${msg.body}`);
        console.log(`[WA-${empresaId}] Timestamp: ${msg.timestamp}`);
        console.log(`[WA-${empresaId}] FromMe: ${msg.fromMe}`);
        
        // Ignorar mensagens de newsletter e status
        if (msg.from.includes('newsletter') || msg.from.includes('status') || msg.from.includes('broadcast')) {
            console.log(`[WA-${empresaId}] 📨 Mensagem de newsletter/broadcast ignorada`);
            return;
        }
        
        const messageContent = msg.body || getDefaultMessageContent(msg.type);
        
        console.log(`[WA-${empresaId}] 💾 Salvando no banco...`);
        
        await saveMessageToDatabase({
            empresa_id: empresaId,
            phone_number: msg.fromMe ? msg.to : msg.from,
            message_type: msg.type,
            content: messageContent,
            is_from_me: msg.fromMe,
            timestamp: new Date(msg.timestamp * 1000) // 🔥 CORRIGIR TIMESTAMP
        });
        
        console.log(`[WA-${empresaId}] ✅ Mensagem salva com sucesso!`);

    } catch (error) {
        console.error(`[WA-${empresaId}] ❌ Erro ao processar mensagem:`, error);
    }
});

    // 🔥 EVENTOS ADICIONAIS PARA DEBUG
    client.on('loading_screen', (percent, message) => {
        console.log(`[WA-${empresaId}] 📊 Carregando: ${percent}% - ${message}`);
    });

    client.on('message_ack', (msg, ack) => {
        console.log(`[WA-${empresaId}] ✅ ACK: ${ack} para mensagem de ${msg.from}`);
    });

    return client;
}

// ==================== FUNÇÃO PARA INICIALIZAR WHATSAPP CORRIGIDA ====================
async function initializeWhatsAppForEmpresa(empresaId) {
    if (instanceCreationLocks.has(empresaId)) {
        console.log(`[WA-${empresaId}] ⏳ Inicialização já em andamento...`);
        return true;
    }
    
    instanceCreationLocks.set(empresaId, true);
    
    try {
        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            console.error(`[WA-${empresaId}] ❌ Empresa não encontrada`);
            return false;
        }

        // Verificar se já existe instância válida
        if (whatsappInstances.has(empresaId)) {
            const existingClient = whatsappInstances.get(empresaId);
            
            try {
                const state = await existingClient.getState();
                console.log(`[WA-${empresaId}] ✅ Instância existe - Estado: ${state}`);
                
                if (state === 'CONNECTED') {
                    console.log(`[WA-${empresaId}] 🎯 Já conectado e funcionando`);
                    return true;
                }
            } catch (error) {
                console.log(`[WA-${empresaId}] 🔄 Instância inválida, recriando...`);
                try {
                    stopConnectionHeartbeat(empresaId);
                    await existingClient.destroy();
                } catch (destroyError) {
                    console.log(`[WA-${empresaId}] ℹ️  Erro ao destruir:`, destroyError.message);
                }
                whatsappInstances.delete(empresaId);
            }
        }

        console.log(`[WA-${empresaId}] 🚀 Iniciando nova instância WhatsApp...`);
        
        await clearProblematicSession(empresaId);
        
        const client = createWhatsAppInstance(empresaId, empresa.cnpj);
        whatsappInstances.set(empresaId, client);

        await client.initialize();
        
        console.log(`[WA-${empresaId}] 📱 Instância inicializada com sucesso`);
        return true;

    } catch (error) {
        console.error(`[WA-${empresaId}] ❌ Erro na inicialização:`, error);
        await updateWhatsAppStatus(empresaId, 'error', null, error.message);
        
        if (whatsappInstances.has(empresaId)) {
            whatsappInstances.delete(empresaId);
        }
        stopConnectionHeartbeat(empresaId);
        
        return false;
    } finally {
        instanceCreationLocks.delete(empresaId);
    }
}

// ==================== ENDPOINTS DA API ====================

// HEALTH CHECK
app.get('/health', (req, res) => {
    res.json({ 
        success: true,
        status: 'online', 
        timestamp: new Date().toISOString(),
        empresas_ativas: whatsappInstances.size,
        environment: IS_RENDER ? 'render' : 'local',
        heartbeats_ativos: connectionHeartbeats.size
    });
});

// STATUS GERAL
app.get('/status', async (req, res) => {
    try {
        const empresasArray = await dbAll('SELECT id, nome, whatsapp_status FROM empresas');
        
        res.json({
            success: true,
            server_time: new Date().toISOString(),
            environment: IS_RENDER ? 'render' : 'local',
            empresas: empresasArray,
            total_empresas: empresasArray.length,
            whatsapp_instances: whatsappInstances.size,
            heartbeats_ativos: connectionHeartbeats.size
        });
    } catch (error) {
        console.error('[STATUS] Erro:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// [RESTANTE DOS ENDPOINTS PERMANECE IGUAL...]

// LISTAR EMPRESAS
app.get('/empresas', authenticateToken, async (req, res) => {
    try {
        const empresas = await dbAll('SELECT * FROM empresas ORDER BY id');
        
        res.json({
            success: true,
            empresas: empresas,
            total: empresas.length
        });
    } catch (error) {
        console.error('[EMPRESAS] Erro ao listar:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// CADASTRAR EMPRESA
app.post('/empresas', authenticateToken, async (req, res) => {
    try {
        const { cnpj, nome, telefone, email } = req.body;

        if (!cnpj || !nome) {
            return res.status(400).json({ 
                success: false, 
                error: 'CNPJ e nome são obrigatórios' 
            });
        }

        const novaEmpresa = await createEmpresa(cnpj, nome, telefone, email);

        res.json({
            success: true,
            message: 'Empresa cadastrada com sucesso',
            empresa: novaEmpresa
        });

    } catch (error) {
        console.error('[EMPRESAS] Erro ao cadastrar:', error);
        if (error.message === 'CNPJ já cadastrado') {
            res.status(400).json({ success: false, error: error.message });
        } else {
            res.status(500).json({ success: false, error: 'Erro interno' });
        }
    }
});

// INICIALIZAR WHATSAPP
app.post('/whatsapp/initialize/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);
        
        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        const success = await initializeWhatsAppForEmpresa(empresaId);

        if (success) {
            res.json({ 
                success: true, 
                message: 'WhatsApp inicializado com sucesso',
                empresa_id: empresaId,
                status: 'initializing'
            });
        } else {
            res.status(500).json({ 
                success: false,
                error: 'Erro ao inicializar WhatsApp' 
            });
        }

    } catch (error) {
        console.error('[WHATSAPP] Erro na inicialização:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno: ' + error.message 
        });
    }
});

// STATUS DO WHATSAPP
app.get('/whatsapp/status/:empresa_id', async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);
        
        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        res.json({
            success: true,
            empresa_id: empresaId,
            nome: empresa.nome,
            whatsapp_status: empresa.whatsapp_status,
            qr_code: empresa.whatsapp_qr_code,
            error: empresa.whatsapp_error,
            has_instance: whatsappInstances.has(empresaId),
            has_heartbeat: connectionHeartbeats.has(empresaId),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[WHATSAPP] Erro ao buscar status:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno' 
        });
    }
});

// REINICIAR WHATSAPP
app.post('/whatsapp/restart/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);
        
        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        console.log(`[WA-${empresaId}] 🔄 Reiniciando WhatsApp...`);

        const client = whatsappInstances.get(empresaId);
        if (client) {
            try {
                stopConnectionHeartbeat(empresaId);
                await client.destroy();
                console.log(`[WA-${empresaId}] ✅ Instância anterior destruída`);
            } catch (destroyError) {
                console.log(`[WA-${empresaId}] ℹ️  Erro ao destruir:`, destroyError.message);
            }
            whatsappInstances.delete(empresaId);
        }

        await clearProblematicSession(empresaId);
        
        console.log(`[WA-${empresaId}] ⏳ Aguardando 5s antes de recriar...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        const success = await initializeWhatsAppForEmpresa(empresaId);

        if (success) {
            res.json({ 
                success: true, 
                message: 'WhatsApp reiniciado com sucesso',
                empresa_id: empresaId,
                status: 'restarting'
            });
        } else {
            res.status(500).json({ 
                success: false,
                error: 'Erro ao reiniciar WhatsApp' 
            });
        }

    } catch (error) {
        console.error('[WHATSAPP] Erro ao reiniciar:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno: ' + error.message 
        });
    }
});

// ENVIAR MENSAGEM
app.post('/whatsapp/send/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const { to, message } = req.body;
        const empresaId = parseInt(empresa_id);

        if (!to || !message) {
            return res.status(400).json({ 
                success: false, 
                error: 'Parâmetros "to" e "message" são obrigatórios' 
            });
        }

        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        if (empresa.whatsapp_status !== 'ready') {
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp não está conectado',
                current_status: empresa.whatsapp_status
            });
        }

        const client = whatsappInstances.get(empresaId);
        if (!client) {
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp não inicializado para esta empresa' 
            });
        }

        const chatId = normalizeNumber(to);
        if (!chatId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Número de telefone inválido' 
            });
        }

        await client.sendMessage(chatId, message);
        
        await saveMessageToDatabase({
            empresa_id: empresaId,
            phone_number: chatId,
            message_type: 'text',
            content: message,
            is_from_me: true
        });

        res.json({ 
            success: true, 
            to: chatId,
            empresa_id: empresaId,
            message: 'Mensagem enviada com sucesso',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[WHATSAPP] Erro ao enviar mensagem:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao enviar mensagem: ' + error.message 
        });
    }
});

// LISTAR CONVERSAS
app.get('/messages/conversations/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);

        const conversations = await dbAll(`
            SELECT c.*, COUNT(m.id) as message_count 
            FROM conversations c 
            LEFT JOIN messages m ON c.id = m.conversation_id 
            WHERE c.empresa_id = ?
            GROUP BY c.id 
            ORDER BY c.last_message_time DESC
        `, [empresaId]);

        res.json({
            success: true,
            empresa_id: empresaId,
            conversations: conversations,
            total: conversations.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar conversas:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno' 
        });
    }
});

// 🔥 SINCRONIZAR MENSAGENS EXISTENTES DO WHATSAPP
app.post('/whatsapp/sync-messages/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const { limit = 50 } = req.body;
        const empresaId = parseInt(empresa_id);

        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        if (empresa.whatsapp_status !== 'ready') {
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp não está conectado',
                current_status: empresa.whatsapp_status
            });
        }

        const client = whatsappInstances.get(empresaId);
        if (!client) {
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp não inicializado para esta empresa' 
            });
        }

        console.log(`[WA-${empresaId}] 🔄 Sincronizando mensagens...`);

        // Buscar chats recentes
        const chats = await client.getChats();
        let totalMessages = 0;
        let syncedConversations = 0;

        // Sincronizar últimos chats
        for (const chat of chats.slice(0, limit)) {
            try {
                console.log(`[WA-${empresaId}] 💬 Sincronizando chat: ${chat.name || chat.id.user}`);
                
                // Buscar mensagens do chat
                const messages = await chat.fetchMessages({ limit: 100 });
                
                for (const msg of messages) {
                    // Ignorar mensagens de broadcast/newsletter
                    if (msg.from.includes('newsletter') || msg.from.includes('status') || msg.from.includes('broadcast')) {
                        continue;
                    }

                    const messageContent = msg.body || getDefaultMessageContent(msg.type);
                    
                    await saveMessageToDatabase({
                        empresa_id: empresaId,
                        phone_number: msg.fromMe ? msg.to : msg.from,
                        message_type: msg.type,
                        content: messageContent,
                        is_from_me: msg.fromMe,
                        timestamp: new Date(msg.timestamp * 1000) // Converter timestamp do WhatsApp
                    });
                    
                    totalMessages++;
                }
                
                syncedConversations++;
                
            } catch (chatError) {
                console.error(`[WA-${empresaId}] ❌ Erro ao sincronizar chat:`, chatError.message);
            }
        }

        res.json({
            success: true,
            empresa_id: empresaId,
            message: 'Mensagens sincronizadas com sucesso',
            stats: {
                conversations_synced: syncedConversations,
                messages_synced: totalMessages,
                total_conversations: chats.length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[SYNC] Erro ao sincronizar mensagens:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro ao sincronizar mensagens: ' + error.message 
        });
    }
});

// MENSAGENS DE UM CONTATO
app.get('/messages/all-conversation/:empresa_id/:phone', authenticateToken, async (req, res) => {
    try {
        const { empresa_id, phone } = req.params;
        const { page = 1, limit = 100 } = req.query;
        const empresaId = parseInt(empresa_id);

        let normalizedPhone = phone;
        if (!phone.includes('@c.us')) {
            normalizedPhone = normalizeNumber(phone);
        }

        const offset = (page - 1) * limit;

        const messages = await dbAll(`
            SELECT * FROM messages 
            WHERE empresa_id = ? AND phone_number = ? 
            ORDER BY timestamp ASC
            LIMIT ? OFFSET ?
        `, [empresaId, normalizedPhone, limit, offset]);

        const totalCount = await dbGet(
            'SELECT COUNT(*) as total FROM messages WHERE empresa_id = ? AND phone_number = ?',
            [empresaId, normalizedPhone]
        );

        res.json({
            success: true,
            empresa_id: empresaId,
            phone_number: normalizedPhone,
            messages: messages,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: totalCount.total,
                totalPages: Math.ceil(totalCount.total / limit)
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar mensagens:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno' 
        });
    }
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 API WhatsApp para Bubble - Online',
        version: '7.0',
        environment: IS_RENDER ? 'render' : 'local',
        database: 'SQLite Persistente',
        database_path: DB_PATH,
        sessions_path: SESSIONS_PATH,
        endpoints: {
            public: [
                'GET  /health',
                'GET  /status', 
                'GET  /whatsapp/status/:empresa_id'
            ],
            private: [
                'GET  /empresas',
                'POST /empresas',
                'POST /whatsapp/initialize/:empresa_id',
                'POST /whatsapp/restart/:empresa_id',
                'POST /whatsapp/send/:empresa_id',
                'GET  /messages/conversations/:empresa_id',
                'GET  /messages/all-conversation/:empresa_id/:phone'
            ]
        },
        authentication: {
            type: 'Bearer Token',
            valid_tokens: FIXED_TOKENS,
            example: 'Authorization: Bearer bubble_integration_token_2024'
        }
    });
});

// ==================== INICIALIZAÇÃO DO SERVIDOR ====================
async function startServer() {
    try {
        await initializeDatabase();
        
        console.log('🚀 Iniciando API WhatsApp para Bubble...');
        console.log(`🌍 Ambiente: ${IS_RENDER ? 'RENDER' : 'LOCAL'}`);
        console.log(`💾 Banco: ${DB_PATH}`);
        console.log(`📁 Sessions: ${SESSIONS_PATH}`);
        
        server.listen(PORT, () => {
            console.log(`✅ API rodando na porta ${PORT}`);
            console.log(`🔐 Token fixo: ${FIXED_TOKENS[0]}`);
            console.log(`📱 Versão: 7.0 - Heartbeat e Conexão Persistente`);
            console.log(`🔥 Novas funcionalidades:`);
            console.log(`   ❤️  Heartbeat a cada 30s para manter conexão`);
            console.log(`   🔄 Reconexão automática`);
            console.log(`   📊 Monitoramento contínuo do estado`);
            console.log(`   🚫 Filtro de newsletters/broadcasts`);
        });
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🔌 Encerrando servidor...');
    
    // Parar todos os heartbeats
    for (const [empresaId] of connectionHeartbeats) {
        stopConnectionHeartbeat(empresaId);
    }
    
    for (const [empresaId, client] of whatsappInstances) {
        try {
            await client.destroy();
            console.log(`[WA-${empresaId}] ✅ Instância destruída`);
        } catch (error) {
            console.log(`[WA-${empresaId}] ❌ Erro ao destruir:`, error.message);
        }
    }
    
    if (db) {
        db.close();
    }
    
    process.exit(0);
});

startServer().catch(console.error);