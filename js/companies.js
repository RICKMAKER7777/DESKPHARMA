class CompaniesManager {
    constructor() {
        this.companies = [];
        this.init();
    }
    
    init() {
        this.setupEventListeners();
    }
    
    setupEventListeners() {
        // Botão nova empresa
        document.getElementById('newCompanyBtn').addEventListener('click', () => {
            this.showNewCompanyModal();
        });
    }
    
    async loadCompanies() {
        try {
            const data = await Utils.makeAPIRequest('/status');
            this.companies = data.empresas || [];
            this.renderCompanies();
            
            // Atualizar estado global
            window.stateManager.setState({ companies: this.companies });
        } catch (error) {
            console.error('Erro ao carregar empresas:', error);
            Utils.showNotification('Erro ao carregar empresas', 'error');
        }
    }
    
    renderCompanies() {
        const container = document.getElementById('companiesContainer');
        
        if (this.companies.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-building"></i>
                    <h3>Nenhuma empresa cadastrada</h3>
                    <p>Comece cadastrando sua primeira empresa</p>
                    <button class="btn btn-primary" id="addFirstCompany">
                        <i class="fas fa-plus"></i>
                        Cadastrar Empresa
                    </button>
                </div>
            `;
            
            document.getElementById('addFirstCompany').addEventListener('click', () => {
                this.showNewCompanyModal();
            });
            return;
        }
        
        container.innerHTML = this.companies.map(company => `
            <div class="company-card" data-company-id="${company.id}">
                <div class="company-header">
                    <div class="company-avatar">
                        ${Utils.generateAvatar(company.nome)}
                    </div>
                    <div class="company-info">
                        <h3>${company.nome}</h3>
                        <p>CNPJ: ${company.cnpj}</p>
                        <div class="company-status">
                            <span class="status-badge ${company.whatsapp_status}">
                                <i class="fas fa-circle"></i>
                                ${this.getStatusText(company.whatsapp_status)}
                            </span>
                        </div>
                    </div>
                </div>
                
                <div class="company-details">
                    <div class="detail-item">
                        <i class="fas fa-phone"></i>
                        <span>${company.telefone || 'Não informado'}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-envelope"></i>
                        <span>${company.email || 'Não informado'}</span>
                    </div>
                    <div class="detail-item">
                        <i class="fas fa-calendar"></i>
                        <span>Cadastrada em: ${Utils.formatDate(company.created_at)}</span>
                    </div>
                </div>
                
                <div class="company-actions">
                    <button class="btn btn-secondary btn-sm" onclick="companiesManager.editCompany(${company.id})">
                        <i class="fas fa-edit"></i>
                        Editar
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="companiesManager.manageWhatsApp(${company.id})">
                        <i class="fab fa-whatsapp"></i>
                        WhatsApp
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    getStatusText(status) {
        const statusMap = {
            'disconnected': 'Desconectado',
            'initializing': 'Inicializando',
            'qr_code': 'QR Code Disponível',
            'ready': 'Conectado',
            'error': 'Erro'
        };
        return statusMap[status] || status;
    }
    
    showNewCompanyModal() {
        // Implementar modal de nova empresa
        Utils.showNotification('Funcionalidade em desenvolvimento', 'info');
    }
    
    editCompany(companyId) {
        // Implementar edição de empresa
        Utils.showNotification('Edição de empresa em desenvolvimento', 'info');
    }
    
    async manageWhatsApp(companyId) {
        try {
            Utils.showNotification('Inicializando WhatsApp...', 'info');
            
            await Utils.makeAPIRequest(`/whatsapp/initialize/${companyId}`, {
                method: 'POST'
            });
            
            // Aguardar um pouco e verificar o status
            setTimeout(() => {
                this.checkWhatsAppStatus(companyId);
            }, 2000);
            
        } catch (error) {
            Utils.showNotification(`Erro ao inicializar WhatsApp: ${error.message}`, 'error');
        }
    }
    
    async checkWhatsAppStatus(companyId) {
        try {
            const data = await Utils.makeAPIRequest('/status');
            const company = data.empresas.find(emp => emp.id === companyId);
            
            if (company && company.whatsapp_status === 'qr_code') {
                // Mostrar modal com QR Code
                window.whatsappManager.showQRCode(companyId, company.whatsapp_qr_code);
            } else if (company && company.whatsapp_status === 'ready') {
                Utils.showNotification('WhatsApp conectado com sucesso!', 'success');
            } else {
                Utils.showNotification(`Status: ${company.whatsapp_status}`, 'info');
            }
        } catch (error) {
            Utils.showNotification('Erro ao verificar status', 'error');
        }
    }
}