// index.js - Versão 7.5 (Puppeteer com Chromium)
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import QRCode from 'qrcode';
import pkg from 'whatsapp-web.js';
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Client, LocalAuth } = pkg;
const app = express();
const server = http.createServer(app);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.ALLOWED_ORIGIN || '*';

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

// ====== PUPPETEER CONFIG COM CHROMIUM ======
function getPuppeteerConfig() {
  // Configuração otimizada para Render com Chromium
  const config = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote', 
      '--disable-gpu',
      '--single-process',
      '--user-data-dir=/tmp/chrome',
      '--disable-web-security',
      '--disable-features=site-per-process',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding'
    ],
    ignoreHTTPSErrors: true,
    timeout: 60000
  };

  // No Render, o Puppeteer vai usar o Chromium baixado automaticamente
  console.log('[PUPPETEER] 🔧 Usando Chromium do Puppeteer');
  
  return config;
}

function createWhatsAppInstance(empresaId) {
  console.log(`[WA-${empresaId}] 🚀 Criando instância WhatsApp`);
  
  const puppeteerConfig = getPuppeteerConfig();

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: `empresa_${empresaId}`,
      dataPath: path.join(SESSIONS_PATH, `empresa_${empresaId}`)
    }),
    puppeteer: puppeteerConfig,
    qrMaxRetries: 5,
    restartOnAuthFail: true,
    takeoverOnConflict: true,
  });

  let isReady = false;

  client.on('loading_screen', (percent, message) => {
    console.log(`[WA-${empresaId}] 📱 Carregando: ${percent}% - ${message}`);
  });

  client.on('qr', async (qr) => {
    console.log(`[WA-${empresaId}] 🔄 QR Code recebido`);
    try {
      const file = path.join(QR_PATH, `qr_${empresaId}.png`);
      await QRCode.toFile(file, qr);
      console.log(`[WA-${empresaId}] ✅ QR Code salvo em: ${file}`);
      
      const url = `https://teste-deploy-rjuf.onrender.com/qr/${empresaId}`;
      console.log(`[WA-${empresaId}] 🌐 QR Code URL: ${url}`);
      
      await updateWhatsAppStatus(empresaId, 'qr_code', url, null);
      
    } catch (error) {
      console.log(`[WA-${empresaId}] ❌ Erro ao gerar QR Code:`, error.message);
      await updateWhatsAppStatus(empresaId, 'error', null, `QR Error: ${error.message}`);
    }
  });

  client.on('ready', async () => {
    console.log(`[WA-${empresaId}] ✅ WhatsApp conectado e pronto`);
    isReady = true;
    await updateWhatsAppStatus(empresaId, 'ready', null, null);
    
    // Limpar QR Code após conexão
    const qrFile = path.join(QR_PATH, `qr_${empresaId}.png`);
    if (fs.existsSync(qrFile)) {
      fs.unlinkSync(qrFile);
    }
  });

  client.on('auth_failure', async (msg) => {
    console.log(`[WA-${empresaId}] ❌ Falha na autenticação:`, msg);
    await updateWhatsAppStatus(empresaId, 'error', null, `Auth Failed: ${msg}`);
  });

  client.on('disconnected', async (reason) => {
    console.log(`[WA-${empresaId}] 🔌 Desconectado:`, reason);
    await updateWhatsAppStatus(empresaId, 'disconnected', null, reason);
  });

  client.on('message', async (msg) => {
    if (msg.from.includes('status') || msg.from.includes('broadcast')) return;
    console.log(`[WA-${empresaId}] 📩 Mensagem de ${msg.from}: ${msg.body?.substring(0, 50)}...`);
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

    // Limpar sessões anteriores
    const sessionPath = path.join(SESSIONS_PATH, `empresa_${empresaId}`);
    if (fs.existsSync(sessionPath)) {
      console.log(`[WA-${empresaId}] 🗑️ Limpando sessão anterior`);
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }

    // Criar cliente
    const client = createWhatsAppInstance(empresaId);
    whatsappInstances.set(empresaId, client);

    // Atualizar status
    await updateWhatsAppStatus(empresaId, 'initializing', null, null);

    // Inicializar com timeout mais longo para baixar Chromium
    console.log(`[WA-${empresaId}] ⏳ Inicializando (pode demorar para baixar Chromium)...`);
    
    const initializationPromise = client.initialize();
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Timeout na inicialização (120s)')), 120000)
    );

    await Promise.race([initializationPromise, timeoutPromise]);
    
    console.log(`[WA-${empresaId}] ✅ Instância inicializada com sucesso`);
    return true;

  } catch (error) {
    console.log(`[WA-${empresaId}] ❌ Erro na inicialização:`, error.message);
    await updateWhatsAppStatus(empresaId, 'error', null, error.message);
    
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
    version: '7.5',
    environment: 'render',
    message: 'Sistema DeskPharma - Puppeteer com Chromium',
    endpoints: {
      status: '/status',
      qr: '/qr/:id',
      initialize: '/whatsapp/initialize/1 ou /2'
    }
  });
});

app.get('/qr/:empresa_id', (req, res) => {
  const file = path.join(QR_PATH, `qr_${req.params.empresa_id}.png`);
  console.log(`[QR] Buscando: ${file}`);
  
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).json({ 
      success: false, 
      error: 'QR Code não encontrado',
      tip: 'Aguarde a inicialização ou verifique o status'
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    success: true, 
    status: 'online',
    timestamp: new Date().toISOString(),
    chromium: 'embedded'
  });
});

app.get('/status', async (req, res) => {
  try {
    const empresas = await dbAll('SELECT * FROM empresas ORDER BY id');
    
    const qrFiles = {};
    empresas.forEach(empresa => {
      const qrFile = path.join(QR_PATH, `qr_${empresa.id}.png`);
      qrFiles[empresa.id] = fs.existsSync(qrFile);
    });

    res.json({
      success: true,
      empresas,
      whatsapp_instances: whatsappInstances.size,
      qr_files: qrFiles,
      system: {
        platform: process.platform,
        node_version: process.version,
        uptime: process.uptime(),
        chromium: 'puppeteer-bundled'
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/whatsapp/initialize/:empresa_id', authenticateToken, async (req, res) => {
  const id = parseInt(req.params.empresa_id);
  
  if (id !== 1 && id !== 2) {
    return res.status(400).json({ 
      success: false, 
      error: 'Use empresa ID 1 ou 2',
      available_empresas: [1, 2]
    });
  }
  
  try {
    console.log(`[API] Inicializando WhatsApp para empresa ${id}`);
    await initializeWhatsAppForEmpresa(id);
    
    res.json({ 
      success: true, 
      message: 'WhatsApp inicializando... (pode demorar na primeira vez)',
      empresa_id: id,
      qr_url: `https://teste-deploy-rjuf.onrender.com/qr/${id}`,
      note: 'Primeira inicialização pode demorar para baixar o Chromium'
    });
    
  } catch (error) {
    console.log(`[API] Erro ao inicializar empresa ${id}:`, error.message);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      tip: 'Na primeira execução, aguarde o download do Chromium (pode levar 1-2 minutos)'
    });
  }
});

// ====== SERVER ======
async function startServer() {
  await initializeDatabase();
  server.listen(PORT, () => {
    console.log(`✅ API rodando na porta ${PORT}`);
    console.log('🌍 Ambiente: Render');
    console.log('📱 Versão: 7.5 - Puppeteer com Chromium');
    console.log('⚡ Primeira inicialização pode demorar para baixar Chromium');
    console.log('🔗 Status: https://teste-deploy-rjuf.onrender.com/status');
  });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('🔄 Recebido SIGTERM, encerrando gracefully...');
  server.close(() => {
    console.log('✅ Servidor encerrado');
    process.exit(0);
  });
});

startServer().catch(console.error);