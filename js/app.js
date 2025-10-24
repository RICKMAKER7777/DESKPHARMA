class DeskPharmaApp {
    constructor() {
        this.currentPage = 'dashboard';
        this.init();
    }
    
    init() {
        this.initializeManagers();
        this.setupNavigation();
        this.setupGlobalEventListeners();
        this.showLoadingScreen();
    }
    
    initializeManagers() {
        // Inicializar todos os gerenciadores
        window.authManager = new AuthManager();
        window.companiesManager = new CompaniesManager();
        window.whatsappManager = new WhatsAppManager();
        window.dashboardManager = new DashboardManager();
        
        // Configurar assinatura do state manager
        window.stateManager.subscribe((state) => {
            this.onStateChange(state);
        });
    }
    
    setupNavigation() {
        // Navegação entre páginas
        document.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.preventDefault();
                const page = item.getAttribute('data-page');
                this.navigateTo(page);
            });
        });
        
        // Navegação por hash (URL)
        window.addEventListener('hashchange', () => {
            const page = window.location.hash.substring(1) || 'dashboard';
            this.navigateTo(page);
        });
        
        // Navegação inicial
        const initialPage = window.location.hash.substring(1) || 'dashboard';
        this.navigateTo(initialPage);
    }
    
    setupGlobalEventListeners() {
        // Toggle sidebar em mobile
        document.querySelector('.sidebar-toggle').addEventListener('click', () => {
            document.querySelector('.sidebar').classList.toggle('collapsed');
        });
        
        // Fechar modais ao clicar fora
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('modal')) {
                e.target.classList.add('hidden');
            }
        });
        
        // Prevenir fechamento com ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                document.querySelectorAll('.modal').forEach(modal => {
                    modal.classList.add('hidden');
                });
            }
        });
    }
    
    navigateTo(page) {
        // Atualizar menu ativo
        document.querySelectorAll('.menu-item').forEach(item => {
            item.classList.remove('active');
        });
        
        document.querySelector(`[data-page="${page}"]`).classList.add('active');
        
        // Esconder todas as páginas
        document.querySelectorAll('.page').forEach(pageElement => {
            pageElement.classList.remove('active');
        });
        
        // Mostrar página atual
        const pageElement = document.getElementById(`${page}Page`);
        if (pageElement) {
            pageElement.classList.add('active');
            this.currentPage = page;
            
            // Atualizar URL
            window.location.hash = page;
            
            // Executar ações específicas da página
            this.onPageChange(page);
        }
    }
    
    onPageChange(page) {
        switch (page) {
            case 'dashboard':
                window.dashboardManager.loadDashboardData();
                break;
            case 'whatsapp':
                window.whatsappManager.loadSessions();
                break;
            case 'empresas':
                window.companiesManager.loadCompanies();
                break;
            case 'usuarios':
                // Carregar usuários
                break;
            case 'deliverys':
                // Carregar deliverys
                break;
            case 'metas':
                // Carregar metas
                break;
        }
    }
    
    onStateChange(state) {
        // Atualizar interface baseada no estado global
        this.updateStatsFromState(state);
    }
    
    updateStatsFromState(state) {
        // Atualizar contadores baseados no estado
        const activeSessions = state.whatsappSessions.filter(
            session => session.whatsapp_status === 'ready'
        ).length;
        
        // Atualizar badge do WhatsApp no menu
        const whatsappBadge = document.querySelector('[data-page="whatsapp"] .menu-badge');
        if (whatsappBadge) {
            whatsappBadge.textContent = activeSessions;
            whatsappBadge.className = `menu-badge ${activeSessions > 0 ? 'online' : 'offline'}`;
        }
    }
    
    showLoadingScreen() {
        // Simular carregamento inicial
        setTimeout(() => {
            window.authManager.checkAuthStatus();
        }, 2000);
    }
    
    // Métodos utilitários globais
    showModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    }
    
    hideModal(modalId) {
        document.getElementById(modalId).classList.add('hidden');
    }
}

// Inicializar aplicação quando o DOM estiver pronto
document.addEventListener('DOMContentLoaded', () => {
    window.deskPharmaApp = new DeskPharmaApp();
});

// Exportar para uso global
window.Utils = Utils;