class AuthManager {
    constructor() {
        this.currentUser = null;
        this.init();
    }
    
    init() {
        this.setupLoginForm();
        this.setupRegisterForm();
        this.setupLogout();
        this.checkAuthStatus();
    }
    
    setupLoginForm() {
        const loginForm = document.getElementById('loginForm');
        const togglePassword = document.querySelector('.toggle-password');
        
        loginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleLogin();
        });
        
        togglePassword.addEventListener('click', () => {
            const passwordInput = document.getElementById('password');
            const icon = togglePassword.querySelector('i');
            
            if (passwordInput.type === 'password') {
                passwordInput.type = 'text';
                icon.className = 'fas fa-eye-slash';
            } else {
                passwordInput.type = 'password';
                icon.className = 'fas fa-eye';
            }
        });
        
        // Link para registro
        document.getElementById('registerLink').addEventListener('click', (e) => {
            e.preventDefault();
            this.showRegisterScreen();
        });
    }
    
    setupRegisterForm() {
        const registerForm = document.getElementById('registerForm');
        const backToLogin = document.getElementById('backToLogin');
        
        registerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            this.handleRegister();
        });
        
        backToLogin.addEventListener('click', () => {
            this.showLoginScreen();
        });
    }
    
    setupLogout() {
        document.getElementById('logoutBtn').addEventListener('click', () => {
            this.logout();
        });
    }
    
    async handleLogin() {
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        
        try {
            // Simulação de login - em produção, isso viria da API
            if (username && password) {
                this.currentUser = {
                    id: 1,
                    name: username,
                    email: `${username}@empresa.com`,
                    role: 'supervisor',
                    company: 'Farmácia Central'
                };
                
                this.showApp();
                Utils.showNotification('Login realizado com sucesso!', 'success');
            } else {
                throw new Error('Credenciais inválidas');
            }
        } catch (error) {
            Utils.showNotification(error.message, 'error');
        }
    }
    
    async handleRegister() {
        const formData = {
            name: document.getElementById('regName').value,
            email: document.getElementById('regEmail').value,
            company: document.getElementById('regCompany').value,
            cnpj: document.getElementById('regCnpj').value,
            phone: document.getElementById('regPhone').value,
            password: document.getElementById('regPassword').value
        };
        
        // Validações básicas
        if (formData.password !== document.getElementById('regConfirmPassword').value) {
            Utils.showNotification('As senhas não coincidem', 'error');
            return;
        }
        
        try {
            // Simulação de registro - em produção, isso viria da API
            Utils.showNotification('Conta criada com sucesso!', 'success');
            this.showLoginScreen();
        } catch (error) {
            Utils.showNotification(error.message, 'error');
        }
    }
    
    logout() {
        this.currentUser = null;
        this.showLoginScreen();
        Utils.showNotification('Logout realizado com sucesso', 'info');
    }
    
    checkAuthStatus() {
        // Verificar se há usuário logado (localStorage, sessionStorage, etc.)
        const savedUser = localStorage.getItem('deskpharma_user');
        if (savedUser) {
            this.currentUser = JSON.parse(savedUser);
            this.showApp();
        } else {
            this.showLoginScreen();
        }
    }
    
    showLoginScreen() {
        document.getElementById('loadingScreen').classList.add('hidden');
        document.getElementById('loginScreen').classList.remove('hidden');
        document.getElementById('registerScreen').classList.add('hidden');
        document.getElementById('app').classList.add('hidden');
    }
    
    showRegisterScreen() {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('registerScreen').classList.remove('hidden');
    }
    
    showApp() {
        document.getElementById('loadingScreen').classList.add('hidden');
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('registerScreen').classList.add('hidden');
        document.getElementById('app').classList.remove('hidden');
        
        // Atualizar interface do usuário
        this.updateUserInterface();
        
        // Carregar dados iniciais
        window.companiesManager.loadCompanies();
        window.whatsappManager.loadSessions();
        window.dashboardManager.loadDashboardData();
    }
    
    updateUserInterface() {
        if (this.currentUser) {
            document.getElementById('userName').textContent = this.currentUser.name;
            document.getElementById('userRole').textContent = this.currentUser.role;
            document.getElementById('userAvatar').innerHTML = 
                Utils.generateAvatar(this.currentUser.name);
        }
    }
    
    getCurrentUser() {
        return this.currentUser;
    }
}