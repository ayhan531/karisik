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
        this.fetchCustomSymbols();
    }

    async fetchCustomSymbols() {
        try {
            const res = await fetch('/api/public-symbols');
            const data = await res.json();
            if (data.symbols && data.symbols.length > 0) {
                let updatedSymbols = JSON.parse(JSON.stringify(symbolsData));
                data.symbols.forEach(sObj => {
                    const cleanName = this.getCleanName(sObj.name);
                    const category = sObj.category || 'DİĞER';
                    if (!updatedSymbols[category]) {
                        updatedSymbols[category] = [];
                    }
                    if (!updatedSymbols[category].includes(cleanName)) {
                        updatedSymbols[category].push(cleanName);
                    }
                });
                this.symbols = updatedSymbols;
                this.renderFilters();
                this.renderList();
                console.log('✅ Özelleştirilmiş semboller yüklendi.');
            }
        } catch (e) {
            console.error('Custom symbols fetch failed:', e);
        }
    }

    getCleanName(sym) {
        const specialMappings = {
            'BIST:XUSIN': 'XSINA',
            'TVC:UKOIL': 'BRENT',
            'FX_IDC:XAUTRYG': 'GLDGR',
            'SZSE:399001': 'SZSE',
            'BIST:XU0301!': 'X30YVADE',
            'BIST:TKFEN': 'TEKFEN',
            'BIST:KOZAA': 'KOZAA',
            'BIST:ARCLK': 'BEKO'
        };
        if (specialMappings[sym]) return specialMappings[sym];
        return sym.split(':').pop().replace('USDT', '');
    }

    connectToProxy() {
        console.log('🔌 Proxy sunucusuna bağlanılıyor...');
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        const wsUrl = `${protocol}//${host}?token=EsMenkul_Secret_2026`;
        console.log(`📡 WebSocket Adresi: ${wsUrl}`);
        this.ws = new WebSocket(wsUrl);
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

    formatPrice(price) {
        if (price === undefined || price === null) return 'Bekleniyor';
        if (typeof price !== 'number') return price;
        if (price < 0.0001) return price.toFixed(8);
        if (price < 1) return price.toFixed(6);
        if (price < 10) return price.toFixed(4);
        return price.toFixed(2);
    }

    handlePriceUpdate(data) {
        const symbol = data.symbol;
        this.prices[symbol] = data;
        const priceEl = document.getElementById(`price-${symbol}`);
        const changeEl = document.getElementById(`change-${symbol}`);
        if (priceEl && data.price !== undefined) {
            const oldPrice = parseFloat(priceEl.innerText.split(' ')[0].replace(/[^0-9.-]/g, '')) || 0;
            const newPrice = parseFloat(data.price);
            const currencySuffix = data.currency === 'USD' ? ' (USD)' : ' (TL)';
            priceEl.innerText = this.formatPrice(newPrice) + currencySuffix;
            if (newPrice > oldPrice) {
                this.flashElement(priceEl, '#48bb78');
            } else if (newPrice < oldPrice) {
                this.flashElement(priceEl, '#f56565');
            }
        }
        if (changeEl && data.changePercent !== undefined) {
            const change = parseFloat(data.changePercent);
            const isPositive = change >= 0;
            changeEl.innerText = `${isPositive ? '+' : ''}${change.toFixed(2)}%`;
            changeEl.className = `change-val ${isPositive ? 'positive' : 'negative'}`;
        }
    }

    flashElement(el, color) {
        el.style.color = color;
        setTimeout(() => el.style.color = 'white', 800);
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
            const priceVal = cachedData?.price !== undefined ? this.formatPrice(cachedData.price) : 'Bekleniyor';
            const currencySuffix = cachedData?.currency ? (cachedData.currency === 'USD' ? ' (USD)' : ' (TL)') : '';
            const price = priceVal + (priceVal !== 'Bekleniyor' ? currencySuffix : '');
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
        document.getElementById('marketFilters').addEventListener('click', (e) => {
            if (e.target.classList.contains('filter-chip')) {
                document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this.currentCategory = e.target.dataset.category;
                this.renderList();
            }
        });
        document.getElementById('symbolSearch').addEventListener('input', (e) => {
            this.searchQuery = e.target.value;
            this.renderList();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new TradingApp();
});
