// index.js - API WhatsApp com Solução Definitiva QR Code - CORRIGIDO
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import sqlite3 from 'sqlite3';
import jwt from 'jsonwebtoken';

const { Client, LocalAuth } = pkg;

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'deskpharma_secret_key_2024';

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
        db = new sqlite3.Database('./whatsapp_db.sqlite', (err) => {
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
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Tabela de sessões WhatsApp
        await dbExec(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                empresa_id INTEGER UNIQUE NOT NULL,
                session_data TEXT,
                status TEXT DEFAULT 'disconnected',
                last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (empresa_id) REFERENCES empresas (id)
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
                FOREIGN KEY (empresa_id) REFERENCES empresas (id)
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
                FOREIGN KEY (empresa_id) REFERENCES empresas (id),
                FOREIGN KEY (conversation_id) REFERENCES conversations (id)
            )
        `);

        // Inserir empresas exemplo se não existirem
        const empresaCount = await dbGet('SELECT COUNT(*) as count FROM empresas');
        
        if (empresaCount.count === 0) {
            await dbRun(`
                INSERT INTO empresas (cnpj, nome, telefone, email) 
                VALUES (?, ?, ?, ?)
            `, ['12345678000195', 'Farmácia Central', '+5511999999999', 'contato@farmaciacentral.com.br']);

            await dbRun(`
                INSERT INTO empresas (cnpj, nome, telefone, email) 
                VALUES (?, ?, ?, ?)
            `, ['98765432000187', 'Drogaria Popular', '+5511888888888', 'vendas@drogariapopular.com.br']);

            console.log('[DATABASE] Empresas exemplo inseridas');
        }

        console.log('[DATABASE] ✅ Todas as tabelas criadas/verificadas');

    } catch (error) {
        console.error('[DATABASE] Erro ao criar tabelas:', error);
        throw error;
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
            'UPDATE empresas SET whatsapp_status = ?, whatsapp_qr_code = ?, whatsapp_error = ? WHERE id = ?',
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
        // Verificar se CNPJ já existe
        const existing = await dbGet('SELECT id FROM empresas WHERE cnpj = ?', [cnpj]);
        if (existing) {
            throw new Error('CNPJ já cadastrado');
        }

        const result = await dbRun(
            'INSERT INTO empresas (cnpj, nome, telefone, email) VALUES (?, ?, ?, ?)',
            [cnpj, nome, telefone, email]
        );
        
        // Buscar empresa criada
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

    // ✅ Aceita token fixo (para Bubble)
    if (token && FIXED_TOKENS.includes(token)) {
        req.user = { 
            id: 1, 
            email: 'bubble@integration.com', 
            role: 'admin',
            empresa_id: 1
        };
        return next();
    }

    // ✅ Ou verifica JWT normal
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
let empresas;

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
        
        // Buscar ou criar conversa
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

        // Inserir mensagem
        await dbRun(
            `INSERT INTO messages (empresa_id, conversation_id, phone_number, message_type, content, is_from_me, timestamp) 
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [empresa_id, convId, phone_number, message_type, content, is_from_me ? 1 : 0, new Date().toISOString()]
        );

        // Atualizar última mensagem da conversa
        await dbRun(
            'UPDATE conversations SET last_message = ?, last_message_time = ? WHERE id = ?',
            [content, new Date().toISOString(), convId]
        );

    } catch (error) {
        console.error('[DATABASE] Erro ao salvar mensagem:', error);
    }
}

// ==================== WHATSAPP INSTANCE CORRIGIDA ====================
function createWhatsAppInstance(empresaId, cnpj) {
    console.log(`[WA-${empresaId}] 🚀 Criando nova instância WhatsApp`);
    
    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: `empresa_${empresaId}`,
            dataPath: `./sessions/empresa_${empresaId}`
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
                '--disable-software-rasterizer'
            ],
            // 🔥 CONFIGURAÇÃO CRÍTICA: Timeout aumentado
            timeout: 60000
        },
        // 🔥 CONFIGURAÇÕES OTIMIZADAS
        takeoverOnConflict: false,
        takeoverTimeoutMs: 60000,
        restartOnAuthFail: false, // ✅ Mudar para false
        qrMaxRetries: 5, // ✅ Aumentar tentativas
        authTimeout: 120000, // ✅ 2 minutos para autenticação
        qrTimeout: 60000, // ✅ 60 segundos para QR
        // 🔥 NOVA CONFIGURAÇÃO: Evitar múltiplas instâncias
        multiDevice: true
    });

    let qrTimeout;
    let isAuthenticated = false;
    let qrRetryCount = 0;
    const MAX_QR_RETRIES = 3;
    
    console.log(`[WA-${empresaId}] 📱 Instância criada, verificando sessão existente...`);

    // 🔥 EVENTO QR CODE - CORRIGIDO
    client.on('qr', async (qr) => {
        try {
            qrRetryCount++;
            console.log(`[WA-${empresaId}] 🔄 QR Code solicitado (Tentativa ${qrRetryCount}/${MAX_QR_RETRIES})`);
            
            // Limpar timeout anterior
            if (qrTimeout) {
                clearTimeout(qrTimeout);
                qrTimeout = null;
            }

            // Verificar limite de tentativas
            if (qrRetryCount > MAX_QR_RETRIES) {
                console.log(`[WA-${empresaId}] 🚫 Limite de tentativas de QR Code atingido`);
                await updateWhatsAppStatus(empresaId, 'qr_retry_limit', null, 'Limite de tentativas excedido');
                return;
            }

            // Gerar QR Code
            const dataUrl = await QRCode.toDataURL(qr, {
                width: 300,
                height: 300,
                margin: 1
            });
            
            console.log(`[WA-${empresaId}] 📱 QR Code gerado - Aguardando escaneamento...`);
            
            // Salvar no banco
            await updateWhatsAppStatus(empresaId, 'qr_code', dataUrl, null);
            
            // 🔥 TIMEOUT AUMENTADO - 90 segundos
            qrTimeout = setTimeout(async () => {
                console.log(`[WA-${empresaId}] ⏰ QR Code expirado (90s)`);
                
                // Verificar se já está autenticado
                try {
                    const state = await client.getState();
                    console.log(`[WA-${empresaId}] 🔍 Estado atual após timeout: ${state}`);
                    
                    if (state === 'CONNECTED') {
                        console.log(`[WA-${empresaId}] ✅ Já está conectado, ignorando timeout`);
                        return;
                    }
                } catch (error) {
                    console.log(`[WA-${empresaId}] ❌ Erro ao verificar estado: ${error.message}`);
                }
                
                // 🔥 AGUARDAR ANTES DE RECRIAR
                console.log(`[WA-${empresaId}] ⏳ Aguardando 5s antes de novo QR Code...`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                
                // 🔥 NÃO DESTRUIR A INSTÂNCIA - APENAS REINICIAR
                console.log(`[WA-${empresaId}] 🔄 Reiniciando para novo QR Code...`);
                try {
                    await client.resetState();
                    await client.initialize();
                } catch (error) {
                    console.error(`[WA-${empresaId}] ❌ Erro ao reiniciar:`, error);
                }
            }, 90000); // ✅ 90 segundos

        } catch (error) {
            console.error(`[WA-${empresaId}] ❌ Erro ao gerar QR:`, error);
        }
    });

    // 🔥 EVENTO READY - CORRIGIDO
    client.on('ready', async () => {
        console.log(`[WA-${empresaId}] 🎉 READY - WhatsApp conectado e pronto!`);
        
        // Limpar timeout do QR
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = true;
        qrRetryCount = 0; // Resetar contador
        
        // Atualizar status no banco
        await updateWhatsAppStatus(empresaId, 'ready', null, null);
        
        // 🔥 VERIFICAÇÃO EXTRA DE CONEXÃO
        try {
            const state = await client.getState();
            console.log(`[WA-${empresaId}] 📊 Estado confirmado: ${state}`);
            
            if (state === 'CONNECTED') {
                console.log(`[WA-${empresaId}] ✅ CONEXÃO ESTABELECIDA COM SUCESSO`);
                
                // 🔥 TESTE DE ENVIO DE MENSAGEM DE CONFIRMAÇÃO
                try {
                    await client.sendMessage('status@broadcast', '🤖 Bot conectado com sucesso!');
                    console.log(`[WA-${empresaId}] ✅ Mensagem de teste enviada`);
                } catch (testError) {
                    console.log(`[WA-${empresaId}] ℹ️  Mensagem de teste não necessária`);
                }
            }
        } catch (error) {
            console.error(`[WA-${empresaId}] ❌ Erro ao verificar estado:`, error);
        }
    });

    // 🔥 EVENTO AUTHENTICATED - CRÍTICO
    client.on('authenticated', async () => {
        console.log(`[WA-${empresaId}] 🔑 AUTHENTICATED - Sessão autenticada com sucesso!`);
        
        // Limpar timeout do QR
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = true;
        qrRetryCount = 0; // Resetar contador
        
        // Já atualizar status para evitar problemas
        await updateWhatsAppStatus(empresaId, 'authenticated', null, null);
        
        // 🔥 AGUARDAR O EVENTO READY
        console.log(`[WA-${empresaId}] ⏳ Aguardando evento READY...`);
    });

    // 🔥 NOVO EVENTO: AUTHENTICATION SUCCESS
    client.on('auth_success', async () => {
        console.log(`[WA-${empresaId}] ✅ AUTH_SUCCESS - Autenticação bem-sucedida!`);
        await updateWhatsAppStatus(empresaId, 'auth_success', null, null);
    });

    // 🔥 EVENTO CHANGE_STATE - IMPORTANTE
    client.on('change_state', async (state) => {
        console.log(`[WA-${empresaId}] 🔄 MUDANÇA DE ESTADO: ${state}`);
        
        if (state === 'CONNECTED') {
            console.log(`[WA-${empresaId}] 🌐 CONECTADO AO WHATSAPP WEB`);
            await updateWhatsAppStatus(empresaId, 'ready', null, null);
        }
    });

    // 🔥 EVENTO AUTH FAILURE
    client.on('auth_failure', async (msg) => {
        console.log(`[WA-${empresaId}] ❌ FALHA NA AUTENTICAÇÃO:`, msg);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        await updateWhatsAppStatus(empresaId, 'auth_failure', null, msg);
    });

    // 🔥 EVENTO DISCONNECTED
    client.on('disconnected', async (reason) => {
        console.log(`[WA-${empresaId}] 🔌 DESCONECTADO:`, reason);
        
        if (qrTimeout) {
            clearTimeout(qrTimeout);
            qrTimeout = null;
        }
        
        isAuthenticated = false;
        await updateWhatsAppStatus(empresaId, 'disconnected', null, reason);
        
        // 🔥 RECONEXÃO MAIS INTELIGENTE
        if (reason === 'NAVIGATION' || reason === 'CONFLICT') {
            console.log(`[WA-${empresaId}] 🔄 Tentando reconexão automática em 15s...`);
            setTimeout(async () => {
                try {
                    console.log(`[WA-${empresaId}] 🔄 Iniciando reconexão...`);
                    await client.initialize();
                } catch (error) {
                    console.error(`[WA-${empresaId}] ❌ Erro na reconexão:`, error);
                }
            }, 15000);
        }
    });

    // 🔥 EVENTO MESSAGE
    client.on('message', async (msg) => {
        try {
            const messageContent = msg.body || getDefaultMessageContent(msg.type);
            
            console.log(`[WA-${empresaId}] 📩 MENSAGEM RECEBIDA de ${msg.from}: ${messageContent.substring(0, 50)}`);
            
            // 🔥 CONFIRMAÇÃO DE QUE ESTÁ FUNCIONANDO
            if (!isAuthenticated) {
                console.log(`[WA-${empresaId}] 💡 RECEBENDO MENSAGENS - SESSÃO ATIVA!`);
                isAuthenticated = true;
                await updateWhatsAppStatus(empresaId, 'ready', null, null);
            }
            
            await saveMessageToDatabase({
                empresa_id: empresaId,
                phone_number: msg.fromMe ? msg.to : msg.from,
                message_type: msg.type,
                content: messageContent,
                is_from_me: msg.fromMe
            });

        } catch (error) {
            console.error(`[WA-${empresaId}] ❌ Erro ao processar mensagem:`, error);
        }
    });

    // 🔥 EVENTO LOADING SCREEN
    client.on('loading_screen', (percent, message) => {
        console.log(`[WA-${empresaId}] 📊 Carregando: ${percent}% - ${message}`);
    });

    return client;
}

// ==================== FUNÇÃO PARA INICIALIZAR WHATSAPP CORRIGIDA ====================
async function initializeWhatsAppForEmpresa(empresaId) {
    try {
        const empresa = await getEmpresaById(empresaId);
        if (!empresa) {
            console.error(`[WA-${empresaId}] ❌ Empresa não encontrada`);
            return false;
        }

        // Verificar se já existe instância
        if (whatsappInstances.has(empresaId)) {
            const existingClient = whatsappInstances.get(empresaId);
            
            // Verificar se a instância existente ainda está funcionando
            try {
                const state = await existingClient.getState();
                console.log(`[WA-${empresaId}] ✅ Instância já existe - Estado: ${state}`);
                
                if (state === 'CONNECTED') {
                    console.log(`[WA-${empresaId}] 🎯 Já conectado, retornando...`);
                    return true;
                }
            } catch (error) {
                console.log(`[WA-${empresaId}] 🔄 Instância existente com problema, recriando...`);
                try {
                    await existingClient.destroy();
                } catch (destroyError) {
                    console.log(`[WA-${empresaId}] ℹ️  Erro ao destruir instância antiga:`, destroyError.message);
                }
                whatsappInstances.delete(empresaId);
            }
        }

        console.log(`[WA-${empresaId}] 🚀 Inicializando nova instância WhatsApp...`);
        
        // 🔥 AGUARDAR SE HOUVER INSTÂNCIA ANTERIOR
        if (whatsappInstances.has(empresaId)) {
            console.log(`[WA-${empresaId}] ⏳ Aguardando 3s antes de nova inicialização...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        const client = createWhatsAppInstance(empresaId, empresa.cnpj);
        whatsappInstances.set(empresaId, client);

        // 🔥 TIMEOUT DE INICIALIZAÇÃO AUMENTADO
        const initializationPromise = client.initialize();
        
        // Timeout de 2 minutos para inicialização
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout na inicialização do WhatsApp (2min)')), 120000);
        });

        await Promise.race([initializationPromise, timeoutPromise]);
        
        console.log(`[WA-${empresaId}] 📱 Inicialização concluída com sucesso`);
        return true;

    } catch (error) {
        console.error(`[WA-${empresaId}] ❌ Erro na inicialização:`, error);
        await updateWhatsAppStatus(empresaId, 'error', null, error.message);
        
        // 🔥 LIMPAR INSTÂNCIA COM PROBLEMA
        if (whatsappInstances.has(empresaId)) {
            try {
                const problemClient = whatsappInstances.get(empresaId);
                await problemClient.destroy();
            } catch (destroyError) {
                console.log(`[WA-${empresaId}] ℹ️  Erro ao limpar instância problemática:`, destroyError.message);
            }
            whatsappInstances.delete(empresaId);
        }
        
        return false;
    }
}

// ==================== ENDPOINTS DA API ====================

// 1. HEALTH CHECK (PUBLICO)
app.get('/health', (req, res) => {
    res.json({ 
        success: true,
        status: 'online', 
        timestamp: new Date().toISOString(),
        empresas_ativas: whatsappInstances.size,
        message: 'API WhatsApp para Bubble - Online'
    });
});

// 2. STATUS GERAL (PUBLICO)
app.get('/status', async (req, res) => {
    try {
        const empresasArray = await dbAll('SELECT id, nome, whatsapp_status FROM empresas');
        
        res.json({
            success: true,
            server_time: new Date().toISOString(),
            empresas: empresasArray,
            total_empresas: empresasArray.length,
            whatsapp_instances: whatsappInstances.size
        });
    } catch (error) {
        console.error('[STATUS] Erro:', error);
        res.status(500).json({ success: false, error: 'Erro interno' });
    }
});

// 3. LISTAR EMPRESAS (PRIVADO)
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

// 4. CADASTRAR EMPRESA (PRIVADO)
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

// 5. INICIALIZAR WHATSAPP (PRIVADO)
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

// 6. STATUS DO WHATSAPP (PUBLICO)
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

// 7. REINICIAR WHATSAPP (PRIVADO)
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

        // Destruir instância atual
        const client = whatsappInstances.get(empresaId);
        if (client) {
            try {
                await client.destroy();
                console.log(`[WA-${empresaId}] ✅ Instância anterior destruída`);
            } catch (destroyError) {
                console.log(`[WA-${empresaId}] ℹ️  Erro ao destruir instância:`, destroyError.message);
            }
            whatsappInstances.delete(empresaId);
        }

        // 🔥 AGUARDAR MAIS TEMPO
        console.log(`[WA-${empresaId}] ⏳ Aguardando 5s antes de recriar...`);
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Criar nova instância
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

// 8. ENVIAR MENSAGEM (PRIVADO)
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

// 9. LISTAR CONVERSAS (PRIVADO)
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

// 10. MENSAGENS DE UM CONTATO (PRIVADO)
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
        version: '4.1', // ✅ Versão atualizada
        database: 'SQLite Persistente',
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
        
        empresas = await getAllEmpresas();
        console.log(`[DATABASE] 📊 ${empresas.size} empresas carregadas do banco`);
        
        console.log('🚀 Iniciando API WhatsApp para Bubble...');
        
        server.listen(PORT, () => {
            console.log(`✅ API rodando na porta ${PORT}`);
            console.log(`🌐 URL: http://localhost:${PORT}`);
            console.log(`🔐 Token fixo: ${FIXED_TOKENS[0]}`);
            console.log(`💾 Banco: SQLite persistente`);
            console.log(`📱 Versão: 4.1 - Solução Definitiva QR Code CORRIGIDA`);
            console.log(`🔥 Mudanças principais:`);
            console.log(`   ✅ Timeout QR aumentado para 90s`);
            console.log(`   ✅ Limite de tentativas: 3`);
            console.log(`   ✅ Aguardar entre tentativas`);
            console.log(`   ✅ Não destruir instância desnecessariamente`);
        });
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('🔌 Encerrando servidor...');
    
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