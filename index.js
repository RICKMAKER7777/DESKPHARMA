// index.js - Versão 7.3 (Correção QR Code no Render)
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
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      console.log(`[SYSTEM] ✅ Diretório criado: ${dir}`);
    } catch (err) {
      console.log(`[SYSTEM] ❌ Erro ao criar diretório ${dir}:`, err.message);
    }
  }
}

// Verificar permissões de escrita
try {
  fs.writeFileSync(path.join(QR_PATH, 'test.txt'), 'test');
  fs.unlinkSync(path.join(QR_PATH, 'test.txt'));
  console.log('[SYSTEM] ✅ Permissões de escrita OK em', QR_PATH);
} catch (err) {
  console.log('[SYSTEM] ❌ Sem permissão de escrita em', QR_PATH, err.message);
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
  
  const count = await dbGet('SELECT COUNT(*) as c FROM empresas');
  if (count.c === 0) {
    console.log('[DATABASE] Inserindo empresas padrão...');
    await dbRun(`INSERT INTO empresas (cnpj,nome,telefone,email) VALUES 
      ('12345678000195','Farmácia Central','+5511999999999','contato@farmaciacentral.com.br'),
      ('98765432000187','Drogaria Popular','+5511888888888','vendas@drogariapopular.com.br')`);
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
  if (fs.existsSync(p)) {
    console.log(`[WA-${empresaId}] 🗑️ Limpando sessão problemática`);
    fs.rmSync(p, { recursive: true, force: true });
  }
}

function createWhatsAppInstance(empresaId) {
  console.log(`[WA-${empresaId}] 🚀 Criando instância WhatsApp`);
  
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `empresa_${empresaId}`,
      dataPath: path.join(SESSIONS_PATH, `empresa_${empresaId}`)
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--single-process'
      ],
      timeout: 60000
    },
    qrMaxRetries: 3,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 30000,
  });

  let isReady = false;
  let qrGenerated = false;

  client.on('qr', async (qr) => {
    console.log(`[WA-${empresaId}] 🔄 QR Code recebido`);
    try {
      const file = path.join(QR_PATH, `qr_${empresaId}.png`);
      await QRCode.toFile(file, qr);
      console.log(`[WA-${empresaId}] ✅ QR Code salvo em: ${file}`);
      
      const url = `https://teste-deploy-rjuf.onrender.com/qr/${empresaId}`;
      console.log(`[WA-${empresaId}] 🌐 QR Code URL: ${url}`);
      
      await updateWhatsAppStatus(empresaId, 'qr_code', url, null);
      qrGenerated = true;
      
    } catch (error) {
      console.log(`[WA-${empresaId}] ❌ Erro ao gerar QR Code:`, error.message);
      await updateWhatsAppStatus(empresaId, 'error', null, `QR Error: ${error.message}`);
    }
  });

  client.on('ready', async () => {
    console.log(`[WA-${empresaId}] ✅ WhatsApp conectado e pronto`);
    isReady = true;
    await updateWhatsAppStatus(empresaId, 'ready', null, null);
    startConnectionHeartbeat(empresaId, client);
    
    // Limpar QR Code após conexão bem-sucedida
    const qrFile = path.join(QR_PATH, `qr_${empresaId}.png`);
    if (fs.existsSync(qrFile)) {
      fs.unlinkSync(qrFile);
    }
  });

  client.on('authenticated', () => {
    console.log(`[WA-${empresaId}] 🔑 Autenticado`);
  });

  client.on('auth_failure', async (msg) => {
    console.log(`[WA-${empresaId}] ❌ Falha na autenticação:`, msg);
    await updateWhatsAppStatus(empresaId, 'error', null, `Auth Failed: ${msg}`);
  });

  client.on('disconnected', async (reason) => {
    console.log(`[WA-${empresaId}] 🔌 Desconectado:`, reason);
    await updateWhatsAppStatus(empresaId, 'disconnected', null, reason);
    
    if (connectionHeartbeats.has(empresaId)) {
      clearInterval(connectionHeartbeats.get(empresaId));
      connectionHeartbeats.delete(empresaId);
    }
    
    if (isReady) {
      console.log(`[WA-${empresaId}] 🔄 Tentando reconectar em 10s...`);
      setTimeout(() => {
        try {
          client.initialize();
        } catch (e) {
          console.log(`[WA-${empresaId}] ❌ Erro na reconexão:`, e.message);
        }
      }, 10000);
    }
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('status') || msg.from.includes('broadcast') || msg.from.includes('newsletter')) return;
    
    console.log(`[WA-${empresaId}] 📩 Mensagem de ${msg.from}: ${msg.body?.substring(0, 50)}...`);
    
    await saveMessageToDatabase({
      empresa_id: empresaId,
      phone_number: msg.fromMe ? msg.to : msg.from,
      message_type: msg.type,
      content: msg.body || `[${msg.type}]`,
      is_from_me: msg.fromMe
    });
  });

  return client;
}

async function initializeWhatsAppForEmpresa(empresaId) {
  try {
    console.log(`[WA-${empresaId}] 🚀 Iniciando inicialização...`);
    
    // Verificar se empresa existe
    const empresa = await dbGet('SELECT * FROM empresas WHERE id = ?', [empresaId]);
    if (!empresa) {
      throw new Error(`Empresa ${empresaId} não encontrada`);
    }

    // Limpar sessão problemática se existir
    await clearProblematicSession(empresaId);

    // Criar e configurar cliente
    const client = createWhatsAppInstance(empresaId);
    whatsappInstances.set(empresaId, client);

    // Atualizar status para inicializando
    await updateWhatsAppStatus(empresaId, 'initializing', null, null);

    // Inicializar com timeout
    const initializationPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout na inicialização (60s)')), 60000)
    );

    await Promise.race([initializationPromise, timeoutPromise]);
    
    console.log(`[WA-${empresaId}] ✅ Instância inicializada com sucesso`);
    return true;

  } catch (error) {
    console.log(`[WA-${empresaId}] ❌ Erro na inicialização:`, error.message);
    await updateWhatsAppStatus(empresaId, 'error', null, error.message);
    
    // Limpar instância em caso de erro
    if (whatsappInstances.has(empresaId)) {
      whatsappInstances.delete(empresaId);
    }
    
    throw error;
  }
}

// ====== ROTAS ======
app.get('/', (req, res) => {
  res.json({
    success: true,
    version: '7.3',
    environment: 'render',
    message: 'Sistema DeskPharma Online - QR Code Fix Aplicado',
    endpoints: {
      status: '/status',
      qr: '/qr/:empresa_id', 
      initialize: '/whatsapp/initialize/:empresa_id',
      send: '/whatsapp/send/:empresa_id'
    }
  });
});

app.get('/qr/:empresa_id', (req, res) => {
  const file = path.join(QR_PATH, `qr_${req.params.empresa_id}.png`);
  console.log(`[QR] Buscando arquivo: ${file}`);
  
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).json({ 
      success: false, 
      error: 'QR Code não encontrado',
      tip: 'A instância pode ainda estar inicializando ou ter falhado'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'online', 
    environment: 'render',
    timestamp: new Date().toISOString(),
    qr_path: QR_PATH,
    sessions_path: SESSIONS_PATH
  });
});

app.get('/status', async (req, res) => {
  try {
    const empresas = await dbAll('SELECT * FROM empresas ORDER BY id');
    
    // Verificar arquivos de QR existentes
    const qrFiles = {};
    empresas.forEach(empresa => {
      const qrFile = path.join(QR_PATH, `qr_${empresa.id}.png`);
      qrFiles[empresa.id] = fs.existsSync(qrFile);
    });

    res.json({
      success: true,
      empresas,
      whatsapp_instances: whatsappInstances.size,
      heartbeats: connectionHeartbeats.size,
      qr_files: qrFiles,
      system: {
        platform: process.platform,
        node_version: process.version,
        memory: process.memoryUsage(),
        uptime: process.uptime(),
        qr_path: QR_PATH
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/whatsapp/initialize/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  
  try {
    console.log(`[API] Inicializando WhatsApp para empresa ${id}`);
    await initializeWhatsAppForEmpresa(id);
    
    res.json({ 
      success: true, 
      message: 'WhatsApp inicializando...',
      empresa_id: id,
      qr_url: `https://teste-deploy-rjuf.onrender.com/qr/${id}`,
      note: 'Acesse a URL do QR Code em 10-30 segundos'
    });
    
  } catch (error) {
    console.log(`[API] Erro ao inicializar empresa ${id}:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      empresa_id: id 
    });
  }
});

app.post('/whatsapp/send/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  const { to, message } = req.body;
  
  const client = whatsappInstances.get(id);
  if (!client) {
    return res.status(503).json({ 
      success: false, 
      error: 'Instância WhatsApp não ativa. Inicialize primeiro.' 
    });
  }
  
  try {
    const chatId = normalizeNumber(to);
    console.log(`[WA-${id}] 📤 Enviando mensagem para: ${chatId}`);
    
    await client.sendMessage(chatId, message);
    await saveMessageToDatabase({ 
      empresa_id: id, 
      phone_number: chatId, 
      message_type: 'text', 
      content: message, 
      is_from_me: true 
    });
    
    res.json({ 
      success: true, 
      to: chatId, 
      message: 'Mensagem enviada com sucesso' 
    });
    
  } catch (error) {
    console.log(`[WA-${id}] ❌ Erro ao enviar mensagem:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ====== SERVER ======
async function startServer() {
  await initializeDatabase();
  server.listen(PORT, () => {
    console.log(`✅ API rodando na porta ${PORT}`);
    console.log('🌍 Ambiente: Render');
    console.log('📱 Versão: 7.3 - QR Code Fix');
    console.log('📁 QR Path:', QR_PATH);
    console.log('📁 Sessions Path:', SESSIONS_PATH);
    console.log('🔗 Status: https://teste-deploy-rjuf.onrender.com/status');
  });
}

// Tratamento de erros não capturados
process.on('unhandledRejection', (reason, promise) => {
  console.log('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.log('❌ Uncaught Exception:', error);
});

startServer().catch(console.error);