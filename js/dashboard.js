class DashboardManager {
    constructor() {
        this.chart = null;
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.initializeCharts();
    }
    
    setupEventListeners() {
        // Atualizar dados do dashboard periodicamente
        setInterval(() => {
            this.loadDashboardData();
        }, 30000); // Atualizar a cada 30 segundos
    }
    
    initializeCharts() {
        const ctx = document.getElementById('messagesChart').getContext('2d');
        
        // Dados iniciais do gráfico
        this.chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: ['00:00', '04:00', '08:00', '12:00', '16:00', '20:00'],
                datasets: [
                    {
                        label: 'Mensagens Enviadas',
                        data: [12, 19, 3, 5, 2, 3],
                        borderColor: '#25D366',
                        backgroundColor: 'rgba(37, 211, 102, 0.1)',
                        tension: 0.4,
                        fill: true
                    },
                    {
                        label: 'Mensagens Recebidas',
                        data: [8, 15, 8, 12, 6, 10],
                        borderColor: '#667EEA',
                        backgroundColor: 'rgba(102, 126, 234, 0.1)',
                        tension: 0.4,
                        fill: true
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)'
                        }
                    },
                    x: {
                        grid: {
                            color: 'rgba(255, 255, 255, 0.1)'
                        },
                        ticks: {
                            color: 'rgba(255, 255, 255, 0.7)'
                        }
                    }
                }
            }
        });
    }
    
    async loadDashboardData() {
        try {
            const data = await Utils.makeAPIRequest('/status');
            this.updateStats(data);
            this.updateRecentActivity();
        } catch (error) {
            console.error('Erro ao carregar dados do dashboard:', error);
        }
    }
    
    updateStats(data) {
        const companies = data.empresas || [];
        const activeCompanies = companies.filter(company => 
            company.whatsapp_status === 'ready'
        ).length;
        
        // Atualizar estatísticas
        document.getElementById('activeCompanies').textContent = activeCompanies;
        document.getElementById('onlineUsers').textContent = '1'; // Simulado
        document.getElementById('messagesToday').textContent = '24'; // Simulado
        document.getElementById('goalsAchieved').textContent = '75%'; // Simulado
    }
    
    updateRecentActivity() {
        const activityList = document.getElementById('recentActivity');
        
        // Atividades simuladas - em produção viriam da API
        const activities = [
            {
                type: 'whatsapp',
                message: 'Nova sessão WhatsApp conectada - Farmácia Central',
                time: '2 minutos atrás',
                icon: 'fab fa-whatsapp',
                color: '#25D366'
            },
            {
                type: 'user',
                message: 'Novo usuário cadastrado - João Silva',
                time: '15 minutos atrás',
                icon: 'fas fa-user-plus',
                color: '#667EEA'
            },
            {
                type: 'message',
                message: '15 mensagens enviadas hoje',
                time: '1 hora atrás',
                icon: 'fas fa-comment',
                color: '#764BA2'
            },
            {
                type: 'company',
                message: 'Nova empresa cadastrada - Drogaria Popular',
                time: '2 horas atrás',
                icon: 'fas fa-building',
                color: '#F093FB'
            }
        ];
        
        activityList.innerHTML = activities.map(activity => `
            <div class="activity-item">
                <div class="activity-icon" style="background: ${activity.color}">
                    <i class="${activity.icon}"></i>
                </div>
                <div class="activity-content">
                    <p>${activity.message}</p>
                    <span class="activity-time">${activity.time}</span>
                </div>
            </div>
        `).join('');
    }
    
    updateChart(data) {
        // Atualizar gráfico com dados reais da API
        if (this.chart && data) {
            // Implementar atualização do gráfico com dados reais
        }
    }
}