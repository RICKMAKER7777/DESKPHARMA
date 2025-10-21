// index.js - API Only para Bubble
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
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
            empresa_id: 1 // Empresa padrão
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
const empresas = new Map();
const whatsappInstances = new Map();
const conversations = new Map();
const messages = new Map();

// Dados de exemplo
function initializeSampleData() {
    // Empresas de exemplo
    empresas.set(1, {
        id: 1,
        cnpj: '12345678000195',
        nome: 'Farmácia Central',
        whatsapp_status: 'disconnected',
        whatsapp_qr_code: null,
        whatsapp_error: null
    });
    
    empresas.set(2, {
        id: 2, 
        cnpj: '98765432000187',
        nome: 'Drogaria Popular',
        whatsapp_status: 'disconnected',
        whatsapp_qr_code: null,
        whatsapp_error: null
    });

    // Conversas de exemplo
    conversations.set('1_5519997124467@c.us', {
        id: '1_5519997124467@c.us',
        empresa_id: 1,
        phone_number: '5519997124467@c.us',
        contact_name: 'João Silva',
        last_message: 'Olá, gostaria de informações',
        last_message_time: new Date().toISOString(),
        unread_count: 2
    });

    // Mensagens de exemplo
    messages.set('1_5519997124467@c.us', [
        {
            id: 1,
            empresa_id: 1,
            phone_number: '5519997124467@c.us',
            message_type: 'text',
            content: 'Olá, gostaria de informações sobre os produtos',
            is_from_me: false,
            timestamp: new Date(Date.now() - 3600000).toISOString()
        },
        {
            id: 2,
            empresa_id: 1,
            phone_number: '5519997124467@c.us',
            message_type: 'text',
            content: 'Claro! Em que posso ajudar?',
            is_from_me: true,
            timestamp: new Date(Date.now() - 1800000).toISOString()
        }
    ]);
}

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

// ==================== WHATSAPP INSTANCE ====================
function createWhatsAppInstance(empresaId, cnpj) {
    const client = new Client({
        authStrategy: new LocalAuth({ 
            clientId: `empresa_${empresaId}`,
            dataPath: `./sessions/empresa_${empresaId}`
        }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    // Eventos do WhatsApp
    client.on('qr', async (qr) => {
        try {
            const dataUrl = await QRCode.toDataURL(qr, {
                width: 300,
                height: 300,
                margin: 1
            });
            
            const empresa = empresas.get(empresaId);
            if (empresa) {
                empresa.whatsapp_qr_code = dataUrl;
                empresa.whatsapp_status = 'qr_code';
                empresa.whatsapp_error = null;
            }
            
            console.log(`[WA-${empresaId}] QR Code gerado`);
        } catch (error) {
            console.error(`[WA-${empresaId}] Erro ao gerar QR:`, error);
        }
    });

    client.on('ready', () => {
        const empresa = empresas.get(empresaId);
        if (empresa) {
            empresa.whatsapp_status = 'ready';
            empresa.whatsapp_error = null;
        }
        console.log(`[WA-${empresaId}] ✅ Conectado e pronto`);
    });

    client.on('auth_failure', (msg) => {
        const empresa = empresas.get(empresaId);
        if (empresa) {
            empresa.whatsapp_status = 'auth_failure';
            empresa.whatsapp_error = msg;
        }
        console.log(`[WA-${empresaId}] ❌ Falha na autenticação:`, msg);
    });

    client.on('disconnected', (reason) => {
        const empresa = empresas.get(empresaId);
        if (empresa) {
            empresa.whatsapp_status = 'disconnected';
            empresa.whatsapp_error = reason;
        }
        console.log(`[WA-${empresaId}] 🔌 Desconectado:`, reason);
    });

    client.on('message', async (msg) => {
        try {
            const messageContent = msg.body || getDefaultMessageContent(msg.type);
            const phoneKey = `${empresaId}_${msg.fromMe ? msg.to : msg.from}`;
            
            if (!messages.has(phoneKey)) {
                messages.set(phoneKey, []);
            }
            
            const newMessage = {
                id: Date.now(),
                empresa_id: empresaId,
                phone_number: msg.fromMe ? msg.to : msg.from,
                message_type: msg.type,
                content: messageContent,
                is_from_me: msg.fromMe,
                timestamp: new Date().toISOString()
            };
            
            messages.get(phoneKey).push(newMessage);
            
            console.log(`[WA-${empresaId}] 📩 Mensagem de ${msg.from}: ${messageContent.substring(0, 50)}`);
            
        } catch (error) {
            console.error(`[WA-${empresaId}] Erro ao processar mensagem:`, error);
        }
    });

    return client;
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

// 2. STATUS DA API (PUBLICO)
app.get('/status', (req, res) => {
    const empresaStatus = Array.from(empresas.values()).map(emp => ({
        id: emp.id,
        nome: emp.nome,
        whatsapp_status: emp.whatsapp_status,
        has_instance: whatsappInstances.has(emp.id)
    }));
    
    res.json({
        success: true,
        server_time: new Date().toISOString(),
        empresas: empresaStatus,
        total_conversations: conversations.size,
        total_messages: Array.from(messages.values()).reduce((acc, msgs) => acc + msgs.length, 0)
    });
});

// 3. INICIALIZAR WHATSAPP (PRIVADO)
app.post('/whatsapp/initialize/:empresa_id', authenticateToken, async (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);
        
        const empresa = empresas.get(empresaId);
        if (!empresa) {
            return res.status(404).json({ 
                success: false,
                error: 'Empresa não encontrada' 
            });
        }

        // Se já existe instância, retorna status atual
        if (whatsappInstances.has(empresaId)) {
            return res.json({ 
                success: true, 
                message: 'WhatsApp já inicializado',
                status: empresa.whatsapp_status,
                qr_code: empresa.whatsapp_qr_code
            });
        }

        // Criar nova instância
        const client = createWhatsAppInstance(empresaId, empresa.cnpj);
        whatsappInstances.set(empresaId, client);

        // Inicializar
        await client.initialize();

        res.json({ 
            success: true, 
            message: 'WhatsApp inicializado com sucesso',
            empresa_id: empresaId,
            status: 'initializing',
            next_step: 'Verificar QR Code em /whatsapp/status/' + empresaId
        });

    } catch (error) {
        console.error('[WHATSAPP] Erro na inicialização:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno do servidor: ' + error.message 
        });
    }
});

// 4. STATUS DO WHATSAPP (PUBLICO)
app.get('/whatsapp/status/:empresa_id', (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);
        
        const empresa = empresas.get(empresaId);
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
            error: 'Erro interno do servidor' 
        });
    }
});

// 5. ENVIAR MENSAGEM (PRIVADO)
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

        const empresa = empresas.get(empresaId);
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

        // Enviar mensagem
        await client.sendMessage(chatId, message);
        
        // Salvar mensagem localmente
        const phoneKey = `${empresaId}_${chatId}`;
        if (!messages.has(phoneKey)) {
            messages.set(phoneKey, []);
        }
        
        const newMessage = {
            id: Date.now(),
            empresa_id: empresaId,
            phone_number: chatId,
            message_type: 'text',
            content: message,
            is_from_me: true,
            timestamp: new Date().toISOString()
        };
        
        messages.get(phoneKey).push(newMessage);

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

// 6. LISTAR CONVERSAS (PRIVADO)
app.get('/messages/conversations/:empresa_id', authenticateToken, (req, res) => {
    try {
        const { empresa_id } = req.params;
        const empresaId = parseInt(empresa_id);

        // Filtrar conversas da empresa
        const empresaConversations = Array.from(conversations.values())
            .filter(conv => conv.empresa_id === empresaId)
            .map(conv => {
                const phoneKey = `${empresaId}_${conv.phone_number}`;
                const convMessages = messages.get(phoneKey) || [];
                return {
                    ...conv,
                    message_count: convMessages.length,
                    last_message: convMessages[convMessages.length - 1]?.content || conv.last_message
                };
            });

        res.json({
            success: true,
            empresa_id: empresaId,
            conversations: empresaConversations,
            total: empresaConversations.length,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar conversas:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno do servidor' 
        });
    }
});

// 7. TODAS AS MENSAGENS DE UM CONTATO (PRIVADO)
app.get('/messages/all-conversation/:empresa_id/:phone', authenticateToken, (req, res) => {
    try {
        const { empresa_id, phone } = req.params;
        const { page = 1, limit = 100, search } = req.query;
        const empresaId = parseInt(empresa_id);

        let normalizedPhone = phone;
        if (!phone.includes('@c.us')) {
            normalizedPhone = normalizeNumber(phone);
        }

        const phoneKey = `${empresaId}_${normalizedPhone}`;
        let allMessages = messages.get(phoneKey) || [];

        // Aplicar busca se fornecida
        if (search) {
            allMessages = allMessages.filter(msg => 
                msg.content.toLowerCase().includes(search.toLowerCase())
            );
        }

        // Ordenar por timestamp (mais recente primeiro)
        allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Paginação
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + parseInt(limit);
        const paginatedMessages = allMessages.slice(startIndex, endIndex);

        // Ordenar para exibição (mais antigo primeiro)
        const messagesForDisplay = [...paginatedMessages].sort(
            (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
        );

        res.json({
            success: true,
            empresa_id: empresaId,
            phone_number: normalizedPhone,
            messages: messagesForDisplay,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: allMessages.length,
                totalPages: Math.ceil(allMessages.length / limit),
                hasNextPage: endIndex < allMessages.length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar mensagens:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno do servidor' 
        });
    }
});

// 8. BUSCAR CONVERSAS (PRIVADO)
app.get('/messages/search-conversations/:empresa_id', authenticateToken, (req, res) => {
    try {
        const { empresa_id } = req.params;
        const { search, page = 1, limit = 20 } = req.query;
        const empresaId = parseInt(empresa_id);

        let empresaConversations = Array.from(conversations.values())
            .filter(conv => conv.empresa_id === empresaId);

        // Aplicar busca
        if (search) {
            empresaConversations = empresaConversations.filter(conv =>
                conv.contact_name.toLowerCase().includes(search.toLowerCase()) ||
                conv.phone_number.includes(search)
            );
        }

        // Paginação
        const startIndex = (page - 1) * limit;
        const paginatedConversations = empresaConversations.slice(startIndex, startIndex + parseInt(limit));

        res.json({
            success: true,
            empresa_id: empresaId,
            conversations: paginatedConversations,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: empresaConversations.length,
                hasMore: startIndex + parseInt(limit) < empresaConversations.length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao buscar conversas:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno do servidor' 
        });
    }
});

// 9. CRIAR CONVERSA (PRIVADO)
app.post('/messages/conversation/:empresa_id', authenticateToken, (req, res) => {
    try {
        const { empresa_id } = req.params;
        const { phone_number, contact_name } = req.body;
        const empresaId = parseInt(empresa_id);

        if (!phone_number) {
            return res.status(400).json({ 
                success: false,
                error: 'phone_number é obrigatório' 
            });
        }

        const normalizedPhone = normalizeNumber(phone_number);
        const phoneKey = `${empresaId}_${normalizedPhone}`;

        // Se já existe, retorna a existente
        if (conversations.has(phoneKey)) {
            return res.json({
                success: true,
                conversation: conversations.get(phoneKey),
                exists: true
            });
        }

        // Criar nova conversa
        const newConversation = {
            id: phoneKey,
            empresa_id: empresaId,
            phone_number: normalizedPhone,
            contact_name: contact_name || `Cliente ${normalizedPhone.replace('@c.us', '').slice(-4)}`,
            last_message: 'Conversa iniciada',
            last_message_time: new Date().toISOString(),
            unread_count: 0
        };

        conversations.set(phoneKey, newConversation);
        messages.set(phoneKey, []);

        res.json({
            success: true,
            conversation: newConversation,
            exists: false,
            message: 'Conversa criada com sucesso'
        });

    } catch (error) {
        console.error('[MESSAGES] Erro ao criar conversa:', error);
        res.status(500).json({ 
            success: false,
            error: 'Erro interno do servidor' 
        });
    }
});

// Rota raiz
app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 API WhatsApp para Bubble - Online',
        version: '2.0',
        endpoints: {
            public: [
                'GET  /health',
                'GET  /status', 
                'GET  /whatsapp/status/:empresa_id'
            ],
            private: [
                'POST /whatsapp/initialize/:empresa_id',
                'POST /whatsapp/send/:empresa_id',
                'GET  /messages/conversations/:empresa_id',
                'GET  /messages/all-conversation/:empresa_id/:phone',
                'GET  /messages/search-conversations/:empresa_id',
                'POST /messages/conversation/:empresa_id'
            ]
        },
        authentication: {
            type: 'Bearer Token',
            valid_tokens: FIXED_TOKENS,
            example: 'Authorization: Bearer bubble_integration_token_2024'
        }
    });
});

// Inicializar servidor
async function startServer() {
    try {
        initializeSampleData();
        
        console.log('🚀 Iniciando API WhatsApp para Bubble...');
        console.log('📋 Endpoints disponíveis:');
        console.log('   GET  /health');
        console.log('   GET  /status');
        console.log('   GET  /whatsapp/status/:empresa_id');
        console.log('   POST /whatsapp/initialize/:empresa_id');
        console.log('   POST /whatsapp/send/:empresa_id');
        console.log('   GET  /messages/conversations/:empresa_id');
        console.log('   GET  /messages/all-conversation/:empresa_id/:phone');
        
        server.listen(PORT, () => {
            console.log(`✅ API rodando na porta ${PORT}`);
            console.log(`🌐 URL: http://localhost:${PORT}`);
            console.log(`🔐 Token fixo: ${FIXED_TOKENS[0]}`);
            console.log(`📱 Empresas: 1 (Farmácia Central), 2 (Drogaria Popular)`);
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
        await client.destroy();
    }
    
    process.exit(0);
});

startServer().catch(console.error);