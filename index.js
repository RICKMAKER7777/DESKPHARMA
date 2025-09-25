import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Client, LocalAuth } = pkg;

const app = express();
const server = http.createServer(app);

// Servir arquivos estáticos da pasta server
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3001;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN, credentials: true }));
app.use(express.json());

const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN === '*' ? true : ORIGIN },
});

// Variáveis para controlar o estado
let whatsappStatus = 'disconnected';
let lastConnectionTime = null;
let connectionError = null;

// WhatsApp client
const waClient = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.SESSION_DIR || '.wwebjs_auth' }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-extensions',
    ],
  },
});

// --------------------- FUNÇÃO AUXILIAR ---------------------
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

// --------------------- EVENTOS WHATSAPP ---------------------
waClient.on('qr', async (qr) => {
  whatsappStatus = 'qr_code';
  connectionError = null;
  const dataUrl = await QRCode.toDataURL(qr);
  io.emit('wa:qr', { dataUrl });
  console.log('[WA] QR Code gerado');
});

waClient.on('ready', () => {
  whatsappStatus = 'ready';
  lastConnectionTime = new Date();
  connectionError = null;
  io.emit('wa:status', { status: 'ready' });
  console.log('[WA] Ready - Conectado e pronto');
});

waClient.on('authenticated', () => {
  whatsappStatus = 'authenticated';
  connectionError = null;
  io.emit('wa:status', { status: 'authenticated' });
  console.log('[WA] Autenticado');
});

waClient.on('auth_failure', (msg) => {
  whatsappStatus = 'auth_failure';
  connectionError = msg;
  io.emit('wa:status', { status: 'auth_failure', msg });
  console.log('[WA] Falha na autenticação:', msg);
});

waClient.on('disconnected', (reason) => {
  whatsappStatus = 'disconnected';
  connectionError = reason;
  io.emit('wa:status', { status: 'disconnected', reason });
  console.log('[WA] Desconectado:', reason);
  
  // Tentar reconectar automaticamente
  setTimeout(() => {
    console.log('[WA] Tentando reconectar...');
    waClient.initialize();
  }, 5000);
});

waClient.on('message', async (msg) => {
  const payload = {
    from: msg.from,
    to: msg.to,
    body: msg.body,
    timestamp: msg.timestamp * 1000,
    fromMe: msg.fromMe,
    id: msg.id?._serialized,
  };
  io.emit('wa:message', payload);
});

// --------------------- ENDPOINTS ---------------------

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
    'connecting': 'Conectando ao WhatsApp...'
  };
  return details[status] || 'Status desconhecido';
}

// HEALTH
app.get('/health', (req, res) => res.json({ ok: true }));

// ENVIAR MENSAGEM
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
      return res.status(400).json({ success: false, error: 'Número inválido ou não informado' });
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

    const formattedMessages = messages.map(msg => ({
      id: msg.id._serialized,
      body: msg.body,
      from: msg.from,
      to: msg.to,
      timestamp: msg.timestamp * 1000,
      fromMe: msg.fromMe
    }));

    res.json({ success: true, chatId, messages: formattedMessages });

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

    res.status(500).json({ success: false, error: err.message });
  }
});

// --------------------- START SERVER ---------------------
waClient.initialize();
whatsappStatus = 'connecting';

server.listen(PORT, () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log(`[STATUS] Endpoint disponível em: http://localhost:${PORT}/status`);
});
