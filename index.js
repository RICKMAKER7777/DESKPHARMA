// index.js - Versão 7.2 (Completa com todas as rotas + melhorias Render)
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
import { exec } from 'child_process';
import util from 'util';

const { Client, LocalAuth } = pkg;
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'deskpharma_secret_key_2024';

// === CONFIG RENDER ===
const IS_RENDER = process.env.RENDER === 'true' || true;
const DB_PATH = IS_RENDER ? '/tmp/whatsapp_db.sqlite' : './whatsapp_db.sqlite';
const SESSIONS_PATH = IS_RENDER ? '/tmp/sessions' : './sessions';
const QR_PATH = IS_RENDER ? '/tmp' : './qrs';

// Criar pastas necessárias
for (const dir of [path.dirname(DB_PATH), SESSIONS_PATH, QR_PATH]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(cors({ origin: ORIGIN === '*' ? true : ORIGIN, credentials: true }));
app.use(express.json({ limit: '50mb' }));

const io = new SocketIOServer(server, {
  cors: { origin: ORIGIN === '*' ? true : ORIGIN, methods: ['GET', 'POST'] },
});

// ========== DATABASE ==========
let db;
function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function dbExec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

async function initializeDatabase() {
  console.log(`[DATABASE] Conectando ao SQLite em: ${DB_PATH}`);
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      console.log('[DATABASE] ✅ Conectado ao SQLite');
      db.run('PRAGMA foreign_keys = ON');
      createTables().then(resolve).catch(reject);
    });
  });
}

async function createTables() {
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
    )`);
  await dbExec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      phone_number TEXT,
      message_type TEXT,
      content TEXT,
      is_from_me BOOLEAN DEFAULT 0,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await dbExec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      name TEXT,
      phone_number TEXT UNIQUE,
      email TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  await dbExec(`
    CREATE TABLE IF NOT EXISTS message_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  
  const count = await dbGet('SELECT COUNT(*) as c FROM empresas');
  if (count.c === 0) {
    console.log('[DATABASE] Inserindo empresas padrão...');
    await dbRun(`INSERT INTO empresas (cnpj,nome,telefone,email) VALUES 
      ('12345678000195','Farmácia Central','+5511999999999','contato@farmaciacentral.com.br'),
      ('98765432000187','Drogaria Popular','+5511888888888','vendas@drogariapopular.com.br')`);
    
    // Inserir templates padrão
    await dbRun(`INSERT INTO message_templates (empresa_id, name, content, category) VALUES 
      (1, 'Boas Vindas', 'Olá! Bem-vindo à Farmácia Central! Como podemos ajudar?', 'saudacao'),
      (1, 'Promoção', 'Olá! Temos promoções especiais esta semana. Gostaria de conhecer?', 'promocao'),
      (2, 'Boas Vindas', 'Olá! Bem-vindo à Drogaria Popular! Em que podemos ajudar?', 'saudacao')`);
  }
  console.log('[DATABASE] ✅ Todas as tabelas criadas/verificadas');
}

// ====== AUTH ======
const FIXED_TOKENS = ['bubble_integration_token_2024'];
function authenticateToken(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (FIXED_TOKENS.includes(token)) return next();
  return res.status(401).json({ success: false, error: 'Token inválido' });
}

// ====== WHATSAPP ======
const whatsappInstances = new Map();
const connectionHeartbeats = new Map();

function normalizeNumber(number) {
  if (!number) return null;
  number = number.replace(/\D/g, '');
  if (!number.startsWith('55')) number = '55' + number;
  return number + '@c.us';
}

async function updateWhatsAppStatus(id, status, qr = null, error = null) {
  await dbRun(`UPDATE empresas SET whatsapp_status=?,whatsapp_qr_code=?,whatsapp_error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    [status, qr, error, id]);
}

async function saveMessageToDatabase({ empresa_id, phone_number, message_type, content, is_from_me }) {
  await dbRun(
    `INSERT INTO messages (empresa_id,phone_number,message_type,content,is_from_me,timestamp) VALUES (?,?,?,?,?,?)`,
    [empresa_id, phone_number, message_type, content, is_from_me ? 1 : 0, new Date().toISOString()]
  );
}

function startConnectionHeartbeat(empresaId, client) {
  if (connectionHeartbeats.has(empresaId)) clearInterval(connectionHeartbeats.get(empresaId));
  const hb = setInterval(async () => {
    try {
      const state = await client.getState();
      console.log(`[WA-${empresaId}] ❤️ Heartbeat: ${state}`);
      if (state !== 'CONNECTED') await client.initialize();
    } catch (e) {
      console.log(`[WA-${empresaId}] ❌ Heartbeat erro:`, e.message);
    }
  }, 30000);
  connectionHeartbeats.set(empresaId, hb);
}

async function clearProblematicSession(empresaId) {
  const p = path.join(SESSIONS_PATH, `empresa_${empresaId}`);
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function createWhatsAppInstance(empresaId) {
  console.log(`[WA-${empresaId}] 🚀 Criando instância`);
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `empresa_${empresaId}`,
      dataPath: path.join(SESSIONS_PATH, `empresa_${empresaId}`)
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
        '--single-process', '--no-zygote', '--disable-extensions', '--mute-audio',
        '--disable-sync', '--no-first-run', '--no-default-browser-check'
      ]
    },
    qrMaxRetries: 1,
    multiDevice: true,
  });

  let isReady = false;

  client.on('qr', async (qr) => {
    const file = path.join(QR_PATH, `qr_${empresaId}.png`);
    await QRCode.toFile(file, qr);
    const url = `https://teste-deploy-rjuf.onrender.com/qr/${empresaId}`;
    console.log(`[WA-${empresaId}] 🔄 QR Code gerado: ${url}`);
    await updateWhatsAppStatus(empresaId, 'qr_code', url, null);
  });

  client.on('ready', async () => {
    console.log(`[WA-${empresaId}] ✅ WhatsApp pronto`);
    isReady = true;
    await updateWhatsAppStatus(empresaId, 'ready', null, null);
    startConnectionHeartbeat(empresaId, client);
  });

  client.on('disconnected', async (r) => {
    console.log(`[WA-${empresaId}] 🔌 Desconectado: ${r}`);
    await updateWhatsAppStatus(empresaId, 'disconnected', null, r);
    if (isReady) {
      setTimeout(() => client.initialize(), 10000);
    }
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('status') || msg.from.includes('newsletter')) return;
    console.log(`[WA-${empresaId}] 📩 Mensagem: ${msg.body}`);
    await saveMessageToDatabase({
      empresa_id: empresaId,
      phone_number: msg.fromMe ? msg.to : msg.from,
      message_type: msg.type,
      content: msg.body || '[mídia]',
      is_from_me: msg.fromMe
    });
  });

  return client;
}

async function initializeWhatsAppForEmpresa(empresaId) {
  const client = createWhatsAppInstance(empresaId);
  whatsappInstances.set(empresaId, client);
  await clearProblematicSession(empresaId);
  await client.initialize();
  console.log(`[WA-${empresaId}] 📱 Instância inicializada`);
  return true;
}

// ====== ROTAS COMPLETAS ======

// Rota principal
app.get('/', (req, res) => {
  res.json({
    success: true,
    version: '7.2',
    environment: 'render',
    endpoints: {
      qr: '/qr/:empresa_id',
      health: '/health',
      status: '/status',
      terminal: '/terminal/last',
      empresas: '/empresas',
      messages: '/messages/:empresa_id',
      contacts: '/contacts/:empresa_id',
      templates: '/templates/:empresa_id',
      initialize: '/whatsapp/initialize/:empresa_id',
      send: '/whatsapp/send/:empresa_id',
      disconnect: '/whatsapp/disconnect/:empresa_id'
    }
  });
});

// QR Code
app.get('/qr/:empresa_id', (req, res) => {
  const file = path.join(QR_PATH, `qr_${req.params.empresa_id}.png`);
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).send('QR Code não encontrado');
});

// Health Check
app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'online', 
    environment: 'render',
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Status completo
app.get('/status', async (req, res) => {
  const empresas = await dbAll('SELECT * FROM empresas');
  res.json({
    success: true,
    empresas,
    whatsapp_instances: whatsappInstances.size,
    heartbeats: connectionHeartbeats.size,
    system: {
      platform: process.platform,
      node_version: process.version,
      memory: process.memoryUsage(),
      uptime: process.uptime()
    }
  });
});

// Última linha do terminal (NOVA ROTA)
app.get('/terminal/last', authenticateToken, async (req, res) => {
  try {
    const execPromise = util.promisify(exec);
    
    // Comando para pegar últimas linhas do log do sistema (ajuste conforme necessário)
    const { stdout } = await execPromise('tail -n 50 /var/log/syslog 2>/dev/null || tail -n 50 /var/log/messages 2>/dev/null || echo "Logs do sistema não disponíveis"');
    
    // Alternativa: último comando do histórico (se disponível)
    const { stdout: history } = await execPromise('tail -n 10 ~/.bash_history 2>/dev/null || echo "Histórico não disponível"');
    
    res.json({
      success: true,
      system_logs: stdout.split('\n').filter(line => line.trim()),
      command_history: history.split('\n').filter(line => line.trim()),
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      success: true,
      system_logs: [`Erro ao acessar logs: ${error.message}`],
      command_history: ['Histórico não disponível neste ambiente'],
      timestamp: new Date().toISOString()
    });
  }
});

// Empresas
app.get('/empresas', authenticateToken, async (req, res) => {
  try {
    const empresas = await dbAll('SELECT * FROM empresas ORDER BY id');
    res.json({ success: true, empresas });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Mensagens por empresa
app.get('/messages/:empresa_id', authenticateToken, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { limit = 100, offset = 0 } = req.query;
    
    const messages = await dbAll(
      `SELECT * FROM messages WHERE empresa_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      [empresa_id, parseInt(limit), parseInt(offset)]
    );
    
    const total = await dbGet(
      `SELECT COUNT(*) as count FROM messages WHERE empresa_id = ?`,
      [empresa_id]
    );
    
    res.json({ 
      success: true, 
      messages,
      pagination: {
        total: total.count,
        limit: parseInt(limit),
        offset: parseInt(offset)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Contatos por empresa
app.get('/contacts/:empresa_id', authenticateToken, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const contacts = await dbAll(
      `SELECT * FROM contacts WHERE empresa_id = ? ORDER BY name`,
      [empresa_id]
    );
    res.json({ success: true, contacts });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Adicionar contato
app.post('/contacts/:empresa_id', authenticateToken, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { name, phone_number, email } = req.body;
    
    await dbRun(
      `INSERT INTO contacts (empresa_id, name, phone_number, email) VALUES (?, ?, ?, ?)`,
      [empresa_id, name, phone_number, email]
    );
    
    res.json({ success: true, message: 'Contato adicionado com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Templates por empresa
app.get('/templates/:empresa_id', authenticateToken, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const templates = await dbAll(
      `SELECT * FROM message_templates WHERE empresa_id = ? ORDER BY name`,
      [empresa_id]
    );
    res.json({ success: true, templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Adicionar template
app.post('/templates/:empresa_id', authenticateToken, async (req, res) => {
  try {
    const { empresa_id } = req.params;
    const { name, content, category } = req.body;
    
    await dbRun(
      `INSERT INTO message_templates (empresa_id, name, content, category) VALUES (?, ?, ?, ?)`,
      [empresa_id, name, content, category]
    );
    
    res.json({ success: true, message: 'Template adicionado com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Inicializar WhatsApp
app.post('/whatsapp/initialize/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  try {
    await initializeWhatsAppForEmpresa(id);
    res.json({ success: true, message: 'Inicializado', empresa_id: id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Enviar mensagem
app.post('/whatsapp/send/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  const { to, message } = req.body;
  const client = whatsappInstances.get(id);
  if (!client) return res.status(503).json({ success: false, error: 'Instância não ativa' });
  
  try {
    const chatId = normalizeNumber(to);
    await client.sendMessage(chatId, message);
    await saveMessageToDatabase({ 
      empresa_id: id, 
      phone_number: chatId, 
      message_type: 'text', 
      content: message, 
      is_from_me: true 
    });
    res.json({ success: true, to: chatId, message: 'Enviado com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Desconectar WhatsApp
app.post('/whatsapp/disconnect/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  const client = whatsappInstances.get(id);
  
  if (!client) {
    return res.status(404).json({ success: false, error: 'Instância não encontrada' });
  }
  
  try {
    // Parar heartbeat
    if (connectionHeartbeats.has(id)) {
      clearInterval(connectionHeartbeats.get(id));
      connectionHeartbeats.delete(id);
    }
    
    // Desconectar cliente
    await client.destroy();
    whatsappInstances.delete(id);
    
    // Atualizar status
    await updateWhatsAppStatus(id, 'disconnected', null, 'Desconectado manualmente');
    
    res.json({ success: true, message: 'WhatsApp desconectado com sucesso' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ====== SERVER ======
async function startServer() {
  await initializeDatabase();
  server.listen(PORT, () => {
    console.log(`✅ API rodando na porta ${PORT}`);
    console.log('🌍 Ambiente: Render');
    console.log('📱 Versão: 7.2 - Completa com todas as rotas');
    console.log('🔗 Terminal logs: https://teste-deploy-rjuf.onrender.com/terminal/last');
  });
}

startServer().catch(console.error);