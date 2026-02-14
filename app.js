import { symbolsData } from './symbols.js';

class TradingApp {
    constructor() {
        this.currentCategory = 'BORSA ISTANBUL';
        this.searchQuery = '';
        this.symbols = symbolsData;
        this.prices = {};
        this.ws = null;
        this.reconnectInterval = null;

        this.init();
    }

    init() {
        this.renderFilters();
        this.renderList();
        this.setupEventListeners();
        this.connectToProxy();
    }

    // TradingView Proxy'e WebSocket bağlantısı
    connectToProxy() {
        console.log('🔌 Proxy sunucusuna bağlanılıyor...');

        this.ws = new WebSocket('ws://localhost:3002');

        this.ws.onopen = () => {
            console.log('✅ Proxy bağlantısı başarılı! Gerçek veriler akıyor...');
            this.updateConnectionStatus(true);

            if (this.reconnectInterval) {
                clearInterval(this.reconnectInterval);
                this.reconnectInterval = null;
            }
        };

        this.ws.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'price_update') {
                    this.handlePriceUpdate(message.data);
                }
            } catch (err) {
                console.error('Mesaj parse hatası:', err);
            }
        };

        this.ws.onerror = (error) => {
            console.error('❌ WebSocket hatası:', error);
            this.updateConnectionStatus(false);
        };

        this.ws.onclose = () => {
            console.log('🔌 Bağlantı koptu, yeniden bağlanılıyor...');
            this.updateConnectionStatus(false);

            if (!this.reconnectInterval) {
                this.reconnectInterval = setTimeout(() => {
                    this.connectToProxy();
                }, 3000);
            }
        };
    }

    // Gerçek fiyat güncellemesi
    handlePriceUpdate(data) {
        // TradingView sembol formatından bizim formata çevir
        const parts = data.symbol.split(':');
        const cleanSymbol = parts[1] || parts[0];
        const baseSymbol = cleanSymbol.replace('USDT', '');

        this.prices[baseSymbol] = data;

        // DOM'u güncelle
        const priceEl = document.getElementById(`price-${baseSymbol}`);
        const changeEl = document.getElementById(`change-${baseSymbol}`);

        if (priceEl && data.price) {
            const oldPrice = parseFloat(priceEl.textContent);
            const newPrice = parseFloat(data.price);

            priceEl.textContent = newPrice.toFixed(2);

            // Flash animasyonu
            if (newPrice > oldPrice) {
                priceEl.style.color = '#48bb78';
            } else if (newPrice < oldPrice) {
                priceEl.style.color = '#f56565';
            }
            setTimeout(() => priceEl.style.color = 'white', 800);
        }

        if (changeEl && data.changePercent) {
            const isPositive = data.changePercent >= 0;
            changeEl.className = `change-val ${isPositive ? 'positive' : 'negative'}`;
            changeEl.textContent = `${isPositive ? '+' : ''}${data.changePercent.toFixed(2)}%`;
        }
    }

    updateConnectionStatus(connected) {
        const statusEl = document.getElementById('connectionStatus');
        if (statusEl) {
            statusEl.textContent = connected ? '🟢 CANLI' : '🔴 BAĞLANTI YOK';
            statusEl.className = connected ? 'status-live' : 'status-offline';
        }
    }

    renderFilters() {
        const filterContainer = document.getElementById('marketFilters');
        const categories = Object.keys(this.symbols);

        filterContainer.innerHTML = categories.map(cat => `
            <div class="filter-chip ${cat === this.currentCategory ? 'active' : ''}" data-category="${cat}">
                ${cat}
            </div>
        `).join('');
    }

    renderList() {
        const listContainer = document.getElementById('symbolList');
        const filteredSymbols = this.symbols[this.currentCategory].filter(sym =>
            sym.toLowerCase().includes(this.searchQuery.toLowerCase())
        );

        listContainer.innerHTML = filteredSymbols.map(sym => {
            const cachedData = this.prices[sym];

            // EN SON VERİYİ GÖSTER - "..." KULLANMA
            // Eğer veri varsa göster, yoksa "Bekleniyor" desin ama bir kere geldikten sonra hep görünsün
            const price = cachedData?.price !== undefined ? cachedData.price.toFixed(2) : 'Bekleniyor';
            const change = cachedData?.changePercent || 0;
            const isPositive = change >= 0;

            return `
                <div class="symbol-row" data-symbol="${sym}">
                    <div class="sym-info">
                        <div class="sym-logo">${sym.substring(0, 1)}</div>
                        <div class="sym-name">${sym}</div>
                    </div>
                    <div class="price-val" id="price-${sym}">${price}</div>
                    <div class="spread-val">${cachedData?.bid && cachedData?.ask ? (cachedData.ask - cachedData.bid).toFixed(4) : '-'}</div>
                    <div class="change-val ${isPositive ? 'positive' : 'negative'}" id="change-${sym}">
                        ${isPositive ? '+' : ''}${typeof change === 'number' ? change.toFixed(2) : '0.00'}%
                    </div>
                </div>
            `;
        }).join('');
    }

    setupEventListeners() {
        // Filter Click
        document.getElementById('marketFilters').addEventListener('click', (e) => {
            if (e.target.classList.contains('filter-chip')) {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this.currentCategory = e.target.dataset.category;
                this.renderList();
            }
        });

        // Search
        document.getElementById('symbolSearch').addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.renderList();
        });

        // Row Click - Devre dışı (sadece veri akışı)
        // Chart açılma özelliği kaldırıldı - kullanıcı isteği
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new TradingApp();
});
