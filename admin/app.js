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

    const query = document.getElementById('monitorSearch').value.toLowerCase();

    // Config'ten gelenler: artık hem sistem hem custom semboller, hepsi {name, category, isCustom}
    let allSymbols = config.symbols || [];

    allSymbols.forEach(symObj => {
        const sym = typeof symObj === 'string' ? symObj : symObj.name;
        const category = typeof symObj === 'string' ? 'DİĞER' : (symObj.category || 'DİĞER');
        const isCustom = typeof symObj === 'string' ? true : (symObj.isCustom !== false);

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

        // Renk: custom = mavi, sistem = yeşil
        const catColor = isCustom ? '#3b82f6' : '#10b981';

        const tr = document.createElement('tr');
        tr.id = `row-${sym}`;
        tr.innerHTML = `
            <td data-label="Sembol">${sym}</td>
            <td data-label="Kategori" style="color: ${catColor}; font-size: 0.85em;">${category}</td>
            <td data-label="Fiyat" class="price-cell">Bekleniyor...</td>
            <td data-label="Durum">${statusHtml}</td>
            <td data-label="Override">${overrideValue}</td>
            <td data-label="İşlem">
                <button onclick="openEditModal('${sym}', ${isCustom})">Düzenle</button>
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
    const symbol = document.getElementById('newSymbol').value.trim().toUpperCase();
    const category = document.getElementById('newCategory').value;
    if (!symbol) return;

    await apiFetch(`/api/admin/symbol`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, category })
    });

    document.getElementById('newSymbol').value = '';
    await loadConfig();
    alert(`Sembol eklendi! Kategori: ${category}`);
}

// --- Modal Logic ---
let currentEditingSymbol = null;

function openEditModal(symbol, isCustom = false) {
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

    // Sil butonu: sadece admin'in eklediği (custom) sembollerde görünsün
    const deleteBtn = document.getElementById('deleteSymbolBtn');
    if (isCustom) {
        deleteBtn.style.display = 'block';
        deleteBtn.onclick = () => deleteSymbol(symbol);
    } else {
        deleteBtn.style.display = 'none';
    }

    toggleInputs();
}

async function deleteSymbol(symbol) {
    if (!confirm(`${symbol} sembolünü silmek istediğinize emin misiniz?`)) return;

    await apiFetch(`/api/admin/symbol/${symbol}`, {
        method: 'DELETE'
    });

    closeModal();
    await loadConfig();
    alert('Sembol silindi!');
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
