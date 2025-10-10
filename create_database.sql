-- Arquivo: create_database.sql
-- Execute este script para criar o banco de dados completo

-- Tabela de usuários
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('client', 'attendant', 'delivery', 'supervisor')),
    phone TEXT,
    avatar TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT 1
);

-- Tabela de conversas
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone_number TEXT NOT NULL,
    contact_name TEXT,
    contact_avatar TEXT,
    last_message TEXT,
    last_message_time DATETIME,
    unread_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de mensagens
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER,
    phone_number TEXT NOT NULL,
    message_type TEXT NOT NULL DEFAULT 'text',
    content TEXT,
    media_url TEXT,
    media_type TEXT,
    is_from_me BOOLEAN DEFAULT 0,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'sent',
    FOREIGN KEY (conversation_id) REFERENCES conversations (id)
);

-- Tabela de vendas
CREATE TABLE IF NOT EXISTS sales (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    items_count INTEGER,
    status TEXT DEFAULT 'completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de entregas
CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    delivery_person TEXT,
    status TEXT DEFAULT 'pending',
    value DECIMAL(10,2),
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de atendimentos
CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_name TEXT,
    service_type TEXT,
    status TEXT,
    attendant_id INTEGER,
    start_time DATETIME,
    end_time DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Tabela de aprovações
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
);

-- Tabela de metas
CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    month_year TEXT NOT NULL,
    target_amount DECIMAL(10,2) NOT NULL,
    current_amount DECIMAL(10,2) DEFAULT 0,
    progress_percentage DECIMAL(5,2) DEFAULT 0,
    days_remaining INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Inserir dados de exemplo
INSERT OR IGNORE INTO users (name, email, password, role, phone) VALUES 
('Supervisor Master', 'supervisor@deskpharma.com', '$2a$10$N9qo8uLOickgx2ZMRZoMye.Kd6LwYHdA7vW9J.x.5.3K5Z6QYQZ5u', 'supervisor', '+5511999999999'),
('Atendente João', 'atendente@deskpharma.com', '$2a$10$N9qo8uLOickgx2ZMRZoMye.Kd6LwYHdA7vW9J.x.5.3K5Z6QYQZ5u', 'attendant', '+5511988888888'),
('Entregador Carlos', 'entregador@deskpharma.com', '$2a$10$N9qo8uLOickgx2ZMRZoMye.Kd6LwYHdA7vW9J.x.5.3K5Z6QYQZ5u', 'delivery', '+5511977777777');

-- Inserir vendas de exemplo
INSERT OR IGNORE INTO sales (date, amount, items_count) VALUES 
(date('now'), 1250.50, 8),
(date('now'), 890.25, 5),
(date('now', '-1 day'), 2100.75, 12);

-- Inserir entregas de exemplo
INSERT OR IGNORE INTO deliveries (order_id, client_name, status, value, address) VALUES 
('ORD001', 'Maria Silva', 'completed', 45.50, 'Rua A, 123'),
('ORD002', 'João Santos', 'pending', 89.90, 'Av. B, 456'),
('ORD003', 'Ana Costa', 'in_progress', 120.00, 'Rua C, 789');

-- Inserir metas de exemplo
INSERT OR IGNORE INTO goals (month_year, target_amount, current_amount, progress_percentage, days_remaining) VALUES 
(strftime('%Y-%m', 'now'), 50000.00, 39000.00, 78.00, 12);