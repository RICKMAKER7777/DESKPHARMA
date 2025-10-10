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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Client, LocalAuth, MessageMedia } = pkg;

const app = express();
const server = http.createServer(app);

// Servir arquivos estáticos da pasta server
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN, credentials: true }));
app.use(express.json({ limit: '10mb' }));

const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN === '*' ? true : ORIGIN },
});

// Variáveis para controlar o estado
let whatsappStatus = 'disconnected';
let lastConnectionTime = null;
let connectionError = null;

// Configurações otimizadas para reduzir uso de RAM
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
  ],
  env: {
    NODE_OPTIONS: '--max-old-space-size=256'
  }
};

// WhatsApp client com configurações otimizadas
const waClient = new Client({
  authStrategy: new LocalAuth({ 
    dataPath: process.env.SESSION_DIR || '.wwebjs_auth',
    clientId: 'wa-client-1'
  }),
  puppeteer: puppeteerOptions,
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  },
  takeoverOnConflict: false,
  takeoverTimeoutMs: 0,
  qrMaxRetries: 3
});

// --------------------- FUNÇÕES AUXILIARES ---------------------
function normalizeNumber(number) {
  if (!number || typeof number !== 'string') return null;

  // remove caracteres não numéricos
  number = number.replace(/\D/g, '');

  // precisa ter pelo menos DDD + número
  if (number.length < 10) return null;

  // adiciona DDI "55" se não tiver
  if (!number.startsWith('55')) {
    number = '55' + number;
  }

  return number + '@c.us';
}

// Função para limpar sessão
async function clearSession() {
  try {
    whatsappStatus = 'disconnecting';
    connectionError = null;
    
    if (waClient.pupPage && !waClient.pupPage.isClosed()) {
      await waClient.pupPage.close().catch(() => {});
    }
    
    if (waClient.pupBrowser && waClient.pupBrowser.isConnected()) {
      await waClient.pupBrowser.close().catch(() => {});
    }
    
    const sessionPath = process.env.SESSION_DIR || '.wwebjs_auth';
    try {
      await fs.rm(sessionPath, { recursive: true, force: true });
      console.log('[WA] Sessão removida com sucesso');
    } catch (fsError) {
      console.log('[WA] Não foi possível remover a sessão:', fsError.message);
    }
    
    waClient.destroy();
    console.log('[WA] Cliente destruído');
    
    return true;
  } catch (error) {
    console.error('[WA] Erro ao limpar sessão:', error);
    return false;
  }
}

// Garbage collection manual para liberar memória
function cleanupMemory() {
  if (global.gc) {
    global.gc();
    console.log('[MEMORY] Garbage collection executado');
  }
}

// --------------------- EVENTOS WHATSAPP ---------------------
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
    
    // Emitir evento específico para o Bubble.io
    io.emit('QR_CODE_WHATS', { 
      qrCode: dataUrl,
      status: 'qr_code'
    });
    
    console.log('[WA] QR Code gerado');
    
    // Limpar memória após gerar QR
    setTimeout(cleanupMemory, 1000);
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
  
  // Emitir evento para o Bubble.io
  io.emit('QR_CODE_WHATS', { 
    status: 'ready',
    message: 'WhatsApp conectado com sucesso'
  });
  
  console.log('[WA] Ready - Conectado e pronto');
  
  // Limpar memória após conectar
  setTimeout(cleanupMemory, 2000);
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
  
  io.emit('QR_CODE_WHATS', { 
    status: 'auth_failure',
    error: msg
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
  
  io.emit('QR_CODE_WHATS', { 
    status: 'disconnected',
    reason: reason
  });
  
  console.log('[WA] Desconectado:', reason);
  
  // Tentar reconectar automaticamente após um tempo maior
  setTimeout(() => {
    console.log('[WA] Tentando reconectar...');
    whatsappStatus = 'connecting';
    waClient.initialize().catch(err => {
      console.error('[WA] Erro na reconexão:', err);
    });
  }, 10000);
});

waClient.on('message', async (msg) => {
  try {
    const payload = {
      from: msg.from,
      to: msg.to,
      body: msg.body,
      timestamp: msg.timestamp * 1000,
      fromMe: msg.fromMe,
      id: msg.id?._serialized,
      hasMedia: msg.hasMedia,
      type: msg.type
    };

    // Se a mensagem tem mídia, processar
    if (msg.hasMedia) {
      try {
        const media = await msg.downloadMedia();
        if (media) {
          payload.media = {
            data: media.data,
            mimetype: media.mimetype,
            filename: media.filename || `media_${msg.timestamp}`
          };
        }
      } catch (mediaError) {
        console.error('[WA] Erro ao baixar mídia:', mediaError);
        payload.mediaError = mediaError.message;
      }
    }

    io.emit('wa:message', payload);
    console.log(`[WA] Mensagem recebida de ${msg.from} (${msg.type})`);
    
  } catch (error) {
    console.error('[WA] Erro ao processar mensagem:', error);
  }
});

// --------------------- ENDPOINTS ---------------------

// STATUS
app.get('/status', (req, res) => {
  const statusInfo = {
    status: whatsappStatus,
    last_connection: lastConnectionTime,
    error: connectionError,
    timestamp: new Date().toISOString(),
    details: getStatusDetails(whatsappStatus),
    memory: process.memoryUsage()
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

// LIMPAR SESSÃO
app.post('/clear-session', async (req, res) => {
  try {
    console.log('[API] Solicitada limpeza de sessão');
    
    const success = await clearSession();
    
    if (success) {
      // Reinicializar o cliente após limpar a sessão
      setTimeout(() => {
        whatsappStatus = 'connecting';
        waClient.initialize().catch(err => {
          console.error('[WA] Erro na reinicialização:', err);
        });
      }, 3000);
      
      res.json({ 
        success: true, 
        message: 'Sessão limpa com sucesso. Escaneie o novo QR Code.' 
      });
    } else {
      res.status(500).json({ 
        success: false, 
        error: 'Erro ao limpar sessão' 
      });
    }
  } catch (error) {
    console.error('[API] Erro no clear-session:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
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
    
    // Limpar memória após enviar mensagem
    setTimeout(cleanupMemory, 500);
    
    res.json({ success: true, to: chatId });

  } catch (err) {
    console.error('Erro ao enviar mensagem:', err);

    if (err.message.includes('disconnected') || err.message.includes('connection')) {
      whatsappStatus = 'disconnected';
      connectionError = err.message;
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp desconectado durante o envio',
        current_status: whatsappStatus
      });
    }

    res.status(500).json({ success: false, error: err.message });
  }
});

// ENVIAR IMAGEM
app.post('/send-image', async (req, res) => {
  try {
    if (whatsappStatus !== 'ready') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp não está conectado',
        current_status: whatsappStatus
      });
    }

    let { to, image, caption, filename = 'image.jpg' } = req.body;

    if (!to || !image) {
      return res.status(400).json({ 
        success: false, 
        error: 'to e image são obrigatórios' 
      });
    }

    const chatId = normalizeNumber(to);
    if (!chatId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Número inválido' 
      });
    }

    // Verificar se a imagem é base64 ou data URL
    let imageData = image;
    if (image.startsWith('data:')) {
      imageData = image.split(',')[1];
    }

    const media = new MessageMedia('image/jpeg', imageData, filename);
    await waClient.sendMessage(chatId, media, { caption: caption || '' });
    
    // Limpar memória após enviar imagem
    setTimeout(cleanupMemory, 500);
    
    res.json({ 
      success: true, 
      to: chatId,
      type: 'image',
      hasCaption: !!caption
    });

  } catch (err) {
    console.error('Erro ao enviar imagem:', err);

    if (err.message.includes('disconnected') || err.message.includes('connection')) {
      whatsappStatus = 'disconnected';
      connectionError = err.message;
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp desconectado durante o envio',
        current_status: whatsappStatus
      });
    }

    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ENVIAR ARQUIVO/IMAGEM GENÉRICO
app.post('/send-media', async (req, res) => {
  try {
    if (whatsappStatus !== 'ready') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp não está conectado',
        current_status: whatsappStatus
      });
    }

    let { to, file, mimetype, filename, caption } = req.body;

    if (!to || !file || !mimetype || !filename) {
      return res.status(400).json({ 
        success: false, 
        error: 'to, file, mimetype e filename são obrigatórios' 
      });
    }

    const chatId = normalizeNumber(to);
    if (!chatId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Número inválido' 
      });
    }

    // Verificar se o arquivo é base64 ou data URL
    let fileData = file;
    if (file.startsWith('data:')) {
      fileData = file.split(',')[1];
    }

    const media = new MessageMedia(mimetype, fileData, filename);
    await waClient.sendMessage(chatId, media, { caption: caption || '' });
    
    // Limpar memória após enviar mídia
    setTimeout(cleanupMemory, 500);
    
    res.json({ 
      success: true, 
      to: chatId,
      type: 'media',
      mimetype: mimetype,
      hasCaption: !!caption
    });

  } catch (err) {
    console.error('Erro ao enviar mídia:', err);

    if (err.message.includes('disconnected') || err.message.includes('connection')) {
      whatsappStatus = 'disconnected';
      connectionError = err.message;
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp desconectado durante o envio',
        current_status: whatsappStatus
      });
    }

    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// BUSCAR MENSAGENS
app.get('/messages', async (req, res) => {
  try {
    if (whatsappStatus !== 'ready') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp não está conectado',
        current_status: whatsappStatus
      });
    }

    let { number, limit = 20, since } = req.query;

    const chatId = normalizeNumber(number);
    if (!chatId) {
      return res.status(400).json({ 
        success: false, 
        error: 'Número inválido ou não informado' 
      });
    }

    const chats = await waClient.getChats();
    const chat = chats.find(c => c.id._serialized === chatId);

    if (!chat) {
      return res.status(404).json({ 
        success: false,
        error: `Nenhuma conversa encontrada com ${chatId}. Envie uma mensagem antes de buscar.` 
      });
    }

    let messages = await chat.fetchMessages({ limit: parseInt(limit, 10) });

    messages = messages.filter(msg => !msg.fromMe);

    if (since) {
      const sinceDate = new Date(since);
      if (!isNaN(sinceDate.getTime())) {
        messages = messages.filter(msg => new Date(msg.timestamp * 1000) >= sinceDate);
      }
    }

    const formattedMessages = await Promise.all(
      messages.map(async (msg) => {
        const messageObj = {
          id: msg.id._serialized,
          body: msg.body,
          from: msg.from,
          to: msg.to,
          timestamp: msg.timestamp * 1000,
          fromMe: msg.fromMe,
          hasMedia: msg.hasMedia,
          type: msg.type
        };

        // Se a mensagem tem mídia, incluir informações da mídia
        if (msg.hasMedia) {
          try {
            const media = await msg.downloadMedia();
            if (media) {
              messageObj.media = {
                mimetype: media.mimetype,
                filename: media.filename || `media_${msg.timestamp}`,
                data: media.data // base64
              };
            }
          } catch (mediaError) {
            console.error('[WA] Erro ao baixar mídia para histórico:', mediaError);
            messageObj.mediaError = mediaError.message;
          }
        }

        return messageObj;
      })
    );

    // Limpar memória após buscar mensagens
    setTimeout(cleanupMemory, 1000);

    res.json({ 
      success: true, 
      chatId, 
      messages: formattedMessages 
    });

  } catch (err) {
    console.error('Erro ao buscar mensagens:', err);

    if (err.message.includes('disconnected') || err.message.includes('connection')) {
      whatsappStatus = 'disconnected';
      connectionError = err.message;
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp desconectado durante a busca',
        current_status: whatsappStatus
      });
    }

    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// --------------------- MIDDLEWARE DE LIMPEZA DE MEMÓRIA ---------------------
app.use((req, res, next) => {
  // Executar garbage collection a cada 10 requisições
  if (Math.random() < 0.1 && global.gc) {
    setTimeout(cleanupMemory, 100);
  }
  next();
});

// --------------------- START SERVER ---------------------
console.log('[SERVER] Iniciando servidor...');

// Inicializar WhatsApp client
waClient.initialize().catch(err => {
  console.error('[WA] Erro na inicialização:', err);
  whatsappStatus = 'disconnected';
  connectionError = err.message;
});

whatsappStatus = 'connecting';

server.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log(`[STATUS] Endpoint disponível em: http://localhost:${PORT}/status`);
  console.log(`[HEALTH] Health check em: http://localhost:${PORT}/health`);
  console.log(`[CLEAR]  Limpar sessão: POST http://localhost:${PORT}/clear-session`);
  
  // Limpar memória periodicamente a cada 5 minutos
  setInterval(cleanupMemory, 5 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('[SERVER] Recebido SIGINT, encerrando...');
  await clearSession();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[SERVER] Recebido SIGTERM, encerrando...');
  await clearSession();
  process.exit(0);
});