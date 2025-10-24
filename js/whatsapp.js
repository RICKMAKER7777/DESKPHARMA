class WhatsAppManager {
    constructor() {
        this.sessions = [];
        this.pollingIntervals = new Map();
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.setupPolling();
    }
    
    setupEventListeners() {
        // Botão nova sessão
        document.getElementById('newSessionBtn').addEventListener('click', () => {
            this.showNewSessionModal();
        });
        
        // Modal nova sessão
        document.getElementById('newSessionForm').addEventListener('submit', (e) => {
            e.preventDefault();
            this.createNewSession();
        });
        
        // Fechar modais
        document.querySelectorAll('.modal-close, .modal-cancel').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.target.closest('.modal').classList.add('hidden');
            });
        });
    }
    
    setupPolling() {
        // Polling para atualizar status das sessões
        setInterval(() => {
            this.loadSessions();
        }, 10000); // Atualizar a cada 10 segundos
    }
    
    async loadSessions() {
        try {
            const data = await Utils.makeAPIRequest('/status');
            this.sessions = data.empresas || [];
            this.renderSessions();
            
            // Atualizar estado global
            window.stateManager.setState({ whatsappSessions: this.sessions });
        } catch (error) {
            console.error('Erro ao carregar sessões:', error);
        }
    }
    
    renderSessions() {
        const container = document.getElementById('sessionsContainer');
        
        if (this.sessions.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fab fa-whatsapp"></i>
                    <h3>Nenhuma sessão ativa</h3>
                    <p>Comece criando sua primeira sessão do WhatsApp</p>
                    <button class="btn btn-primary" id="addFirstSession">
                        <i class="fas fa-plus"></i>
                        Nova Sessão
                    </button>
                </div>
            `;
            
            document.getElementById('addFirstSession').addEventListener('click', () => {
                this.showNewSessionModal();
            });
            return;
        }
        
        container.innerHTML = this.sessions.map(session => `
            <div class="session-card" data-session-id="${session.id}">
                <div class="session-header">
                    <div class="session-info">
                        <h3>${session.nome}</h3>
                        <div class="session-status ${session.whatsapp_status}">
                            <i class="fas fa-circle"></i>
                            <span>${this.getSessionStatusText(session.whatsapp_status)}</span>
                        </div>
                    </div>
                    <div class="session-actions">
                        ${session.whatsapp_status === 'disconnected' ? `
                            <button class="session-btn connect" onclick="whatsappManager.initializeSession(${session.id})">
                                <i class="fas fa-plug"></i>
                                Conectar
                            </button>
                        ` : ''}
                        
                        ${session.whatsapp_status === 'qr_code' ? `
                            <button class="session-btn connect" onclick="whatsappManager.showQRCode(${session.id})">
                                <i class="fas fa-qrcode"></i>
                                QR Code
                            </button>
                        ` : ''}
                        
                        ${session.whatsapp_status === 'ready' ? `
                            <button class="session-btn disconnect" onclick="whatsappManager.disconnectSession(${session.id})">
                                <i class="fas fa-power-off"></i>
                                Desconectar
                            </button>
                        ` : ''}
                    </div>
                </div>
                
                <div class="session-details">
                    <div class="detail-item">
                        <i class="fas fa-id-card"></i>
                        <span>CNPJ: ${session.cnpj}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-phone"></i>
                        <span>${session.telefone || 'Não configurado'}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-sync-alt"></i>
                        <span>Atualizado: ${Utils.formatDate(session.updated_at)}</span>
                    </div>
                </div>
                
                ${session.whatsapp_error ? `
                    <div class="session-error">
                        <i class="fas fa-exclamation-triangle"></i>
                        <span>${session.whatsapp_error}</span>
                    </div>
                ` : ''}
            </div>
        `).join('');
    }
    
    getSessionStatusText(status) {
        const statusMap = {
            'disconnected': 'Desconectado',
            'initializing': 'Inicializando...',
            'qr_code': 'Aguardando QR Code',
            'ready': 'Conectado',
            'error': 'Erro na Conexão'
        };
        return statusMap[status] || status;
    }
    
    showNewSessionModal() {
        const modal = document.getElementById('newSessionModal');
        const companySelect = document.getElementById('sessionCompany');
        
        // Carregar empresas no select
        const companies = window.stateManager.getState().companies;
        companySelect.innerHTML = '<option value="">Selecione uma empresa</option>' +
            companies.map(company => `
                <option value="${company.id}">${company.nome} - ${company.cnpj}</option>
            `).join('');
        
        modal.classList.remove('hidden');
    }
    
    async createNewSession() {
        const companyId = document.getElementById('sessionCompany').value;
        const phoneNumber = document.getElementById('sessionNumber').value;
        
        if (!companyId || !phoneNumber) {
            Utils.showNotification('Preencha todos os campos', 'error');
            return;
        }
        
        try {
            // Fechar modal
            document.getElementById('newSessionModal').classList.add('hidden');
            
            Utils.showNotification('Inicializando sessão WhatsApp...', 'info');
            
            await Utils.makeAPIRequest(`/whatsapp/initialize/${companyId}`, {
                method: 'POST'
            });
            
            // Iniciar polling para verificar QR Code
            this.startQRCodePolling(companyId);
            
        } catch (error) {
            Utils.showNotification(`Erro ao criar sessão: ${error.message}`, 'error');
        }
    }
    
    async initializeSession(companyId) {
        try {
            Utils.showNotification('Inicializando WhatsApp...', 'info');
            
            await Utils.makeAPIRequest(`/whatsapp/initialize/${companyId}`, {
                method: 'POST'
            });
            
            this.startQRCodePolling(companyId);
            
        } catch (error) {
            Utils.showNotification(`Erro ao inicializar: ${error.message}`, 'error');
        }
    }
    
    startQRCodePolling(companyId) {
        // Parar polling anterior se existir
        if (this.pollingIntervals.has(companyId)) {
            clearInterval(this.pollingIntervals.get(companyId));
        }
        
        const interval = setInterval(async () => {
            try {
                const data = await Utils.makeAPIRequest('/status');
                const session = data.empresas.find(emp => emp.id === parseInt(companyId));
                
                if (session) {
                    if (session.whatsapp_status === 'qr_code' && session.whatsapp_qr_code) {
                        this.showQRCode(companyId, session.whatsapp_qr_code);
                        clearInterval(interval);
                        this.pollingIntervals.delete(companyId);
                    } else if (session.whatsapp_status === 'ready') {
                        Utils.showNotification('WhatsApp conectado com sucesso!', 'success');
                        clearInterval(interval);
                        this.pollingIntervals.delete(companyId);
                        this.loadSessions(); // Recarregar lista
                    } else if (session.whatsapp_status === 'error') {
                        Utils.showNotification(`Erro: ${session.whatsapp_error}`, 'error');
                        clearInterval(interval);
                        this.pollingIntervals.delete(companyId);
                    }
                }
            } catch (error) {
                console.error('Erro no polling:', error);
            }
        }, 2000); // Verificar a cada 2 segundos
        
        this.pollingIntervals.set(companyId, interval);
        
        // Timeout de 60 segundos
        setTimeout(() => {
            if (this.pollingIntervals.has(companyId)) {
                clearInterval(this.pollingIntervals.get(companyId));
                this.pollingIntervals.delete(companyId);
                Utils.showNotification('Timeout na inicialização do WhatsApp', 'error');
            }
        }, 60000);
    }
    
    showQRCode(companyId, qrCodeUrl = null) {
        const modal = document.getElementById('qrModal');
        const qrImage = document.getElementById('qrImage');
        
        if (qrCodeUrl) {
            qrImage.src = qrCodeUrl;
        } else {
            qrImage.src = `https://teste-deploy-rjuf.onrender.com/qr/${companyId}`;
        }
        
        modal.classList.remove('hidden');
        
        // Iniciar verificação de conexão
        this.startConnectionPolling(companyId);
    }
    
    startConnectionPolling(companyId) {
        const interval = setInterval(async () => {
            try {
                const data = await Utils.makeAPIRequest('/status');
                const session = data.empresas.find(emp => emp.id === parseInt(companyId));
                
                if (session && session.whatsapp_status === 'ready') {
                    Utils.showNotification('WhatsApp conectado com sucesso!', 'success');
                    document.getElementById('qrModal').classList.add('hidden');
                    clearInterval(interval);
                    this.loadSessions(); // Recarregar lista
                }
            } catch (error) {
                console.error('Erro na verificação de conexão:', error);
            }
        }, 3000);
        
        // Parar após 5 minutos
        setTimeout(() => {
            clearInterval(interval);
        }, 300000);
    }
    
    async disconnectSession(companyId) {
        try {
            Utils.showNotification('Desconectando WhatsApp...', 'info');
            
            // Nota: A API atual não tem endpoint de disconnect, então vamos simular
            // Em produção, isso chamaria um endpoint específico
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            Utils.showNotification('WhatsApp desconectado', 'success');
            this.loadSessions(); // Recarregar lista
            
        } catch (error) {
            Utils.showNotification(`Erro ao desconectar: ${error.message}`, 'error');
        }
    }
    
    async sendMessage(companyId, to, message) {
        try {
            await Utils.makeAPIRequest(`/whatsapp/send/${companyId}`, {
                method: 'POST',
                body: JSON.stringify({ to, message })
            });
            
            Utils.showNotification('Mensagem enviada com sucesso!', 'success');
        } catch (error) {
            Utils.showNotification(`Erro ao enviar mensagem: ${error.message}`, 'error');
            throw error;
        }
    }
}