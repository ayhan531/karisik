// --- API Wrapper ---
async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        window.location.href = '/admin/login.html';
        return;
    }
    return res;
}

// --- Load Config ---
async function loadConfig() {
    try {
        const res = await apiFetch(`/api/admin/config`);
        if (!res) return;
        config = await res.json();
        renderTable();
        document.getElementById('globalDelay').value = config.delay || 0;
    } catch (e) {
        console.error('Config load failed:', e);
    }
}

async function logout() {
    try {
        const res = await fetch('/api/auth/logout', { method: 'POST' });
        const result = await res.json();
        if (result.success) {
            window.location.href = '/admin/login.html';
        }
    } catch (e) {
        console.error('Logout failed:', e);
    }
}

// --- Render Table ---
function renderTable() {
    const tbody = document.getElementById('symbolTableBody');
    tbody.innerHTML = '';

    // Search Filter
    const query = document.getElementById('monitorSearch').value.toLowerCase();

    // Combine known symbols + custom symbols
    let allSymbols = config.symbols || [];

    // Config'deki override'ları listeye ekle (eğer symbols içinde yoksa bile)
    Object.keys(config.overrides || {}).forEach(sym => {
        if (!allSymbols.includes(sym)) allSymbols.push(sym);
    });

    allSymbols.forEach(sym => {
        if (!sym.toLowerCase().includes(query)) return;

        const override = config.overrides ? config.overrides[sym] : null;
        const hasOverride = !!override;

        let statusHtml = '<span class="status-badge active">Canlı</span>';
        let overrideValue = '-';

        if (hasOverride) {
            statusHtml = '<span class="status-badge override">Override</span>';
            if (override.type === 'fixed') overrideValue = `Sabit: ${override.value} TL`;
            else overrideValue = `Çarpan: ${override.value}x`;
        }

        const tr = document.createElement('tr');
        tr.id = `row-${sym}`; // Add ID for easy access
        tr.innerHTML = `
            <td data-label="Sembol">${sym}</td>
            <td data-label="Fiyat" class="price-cell">Bekleniyor...</td>
            <td data-label="Durum">${statusHtml}</td>
            <td data-label="Override">${overrideValue}</td>
            <td data-label="İşlem">
                <button onclick="openEditModal('${sym}')">Düzenle</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// --- Actions ---

async function updateDelay() {
    const delay = document.getElementById('globalDelay').value;
    await apiFetch(`/api/admin/delay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delay })
    });
    alert('Gecikme güncellendi!');
}

async function addSymbol() {
    const symbol = document.getElementById('newSymbol').value.trim();
    if (!symbol) return;

    await apiFetch(`/api/admin/symbol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol })
    });

    document.getElementById('newSymbol').value = '';
    // Reload config to update list
    await loadConfig();
    alert('Sembol eklendi! Veri akışı başlıyor...');
}

// --- Modal Logic ---
let currentEditingSymbol = null;

function openEditModal(symbol) {
    currentEditingSymbol = symbol;
    document.getElementById('modalTitle').innerText = `Düzenle: ${symbol}`;
    document.getElementById('editModal').style.display = 'block';

    const override = config.overrides ? config.overrides[symbol] : null;

    if (override) {
        document.getElementById('overrideType').value = override.type;
        if (override.type === 'fixed') {
            document.getElementById('fixedPrice').value = override.value;
        } else {
            document.getElementById('multiplierValue').value = override.value;
        }
    } else {
        document.getElementById('overrideType').value = 'none';
        document.getElementById('fixedPrice').value = '';
        document.getElementById('multiplierValue').value = '1.00';
    }
    toggleInputs();
}

function closeModal() {
    document.getElementById('editModal').style.display = 'none';
}

function toggleInputs() {
    const type = document.getElementById('overrideType').value;
    document.getElementById('fixedInputGroup').style.display = type === 'fixed' ? 'block' : 'none';
    document.getElementById('multiplierInputGroup').style.display = type === 'multiplier' ? 'block' : 'none';
}

async function saveOverride() {
    const type = document.getElementById('overrideType').value;
    let payload = { symbol: currentEditingSymbol };

    if (type === 'fixed') {
        payload.price = document.getElementById('fixedPrice').value;
    } else if (type === 'multiplier') {
        payload.multiplier = document.getElementById('multiplierValue').value;
    }
    // If 'none', sending just symbol will be treated as delete in backend if both price/mult are undefined

    await apiFetch(`/api/admin/override`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    closeModal();
    await loadConfig();
    alert('Ayarlar kaydedildi!');
}

// --- Init ---
loadConfig();

// --- WebSocket Connection ---
// Secure connection with API Key
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${window.location.host}?token=EsMenkul_Secret_2026`);

ws.onopen = () => {
    console.log('✅ WebSocket Bağlantısı Kuruldu');
};

ws.onerror = (error) => {
    console.error('❌ WebSocket Hatası:', error);
};

ws.onmessage = (event) => {
    try {
        const message = JSON.parse(event.data);
        if (message.type === 'price_update') {
            const { symbol, price } = message.data;
            updatePriceCell(symbol, price);
        }
    } catch (e) {
        console.error('WS:', e);
    }
};

function updatePriceCell(symbol, price) {
    const row = document.getElementById(`row-${symbol}`);
    if (row) {
        const priceCell = row.querySelector('.price-cell');
        if (priceCell) {
            // Flash effect
            const oldPrice = parseFloat(priceCell.innerText.replace(' TL', ''));
            priceCell.innerText = `${price.toFixed(2)} TL`;

            if (oldPrice !== price) {
                priceCell.style.color = price > oldPrice ? '#4ade80' : '#f87171'; // Green/Red
                setTimeout(() => priceCell.style.color = 'white', 500);
            }
        }
    }
}
