
async function apiFetch(url, options = {}) {
    const res = await fetch(url, options);
    if (res.status === 401) {
        window.location.href = '/admin/login.html';
        return;
    }
    return res;
}

async function loadConfig() {
    try {
        const res = await apiFetch(`/api/admin/config`);
        if (!res) return;
        config = await res.json();

        try {
            const cacheRes = await apiFetch('/api/admin/ticker-cache');
            const cacheData = await cacheRes.json();
            if (cacheData.success) {
                config.tickerCache = {};
                (cacheData.cache || []).forEach(c => {
                    config.tickerCache[c.symbol] = c.ticker;
                });
            }
        } catch (e) { }

        if (config.metrics) {
            document.getElementById('wsClientsMetric').innerText = config.metrics.wsClients;
            document.getElementById('pwStatusMetric').innerText = config.metrics.playwrightStatus;

            const lastData = config.metrics.lastDataTime;
            if (lastData) {
                const diffSec = Math.floor((Date.now() - lastData) / 1000);
                document.getElementById('lastDataMetric').innerText = `${diffSec} sn önce`;
                document.getElementById('lastDataMetric').style.color = diffSec > 300 ? '#ef4444' : '#10b981';
            }
        }

        renderCategories();
        renderTable();
        document.getElementById('globalDelay').value = config.delay || 0;
    } catch (e) {
        console.error('Config load failed:', e);
    }
}

setInterval(() => {
    if (document.visibilityState === 'visible') {
        loadConfig();
    }
}, 30000);

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

function renderCategories() {
    const list = document.getElementById('categoryList');
    const newCatSelect = document.getElementById('newCategory');
    const editCatSelect = document.getElementById('editCategory');

    list.innerHTML = '';
    newCatSelect.innerHTML = '';
    editCatSelect.innerHTML = '';

    const categories = config.categories || [];

    categories.forEach(cat => {

        const optNew = document.createElement('option');
        optNew.value = cat;
        optNew.innerHTML = cat;
        if (cat === 'KRIPTO') optNew.selected = true;
        newCatSelect.appendChild(optNew);

        const optEdit = document.createElement('option');
        optEdit.value = cat;
        optEdit.innerHTML = cat;
        editCatSelect.appendChild(optEdit);

        const div = document.createElement('div');
        div.style.cssText = 'background: #0f172a; padding: 5px 15px; border-radius: 20px; border: 1px solid #334155; display: flex; align-items: center; gap: 8px; font-size: 14px;';
        div.innerHTML = `
            ${cat}
            <span style="color: #ef4444; cursor: pointer; font-weight: bold;" onclick="deleteCategory('${cat}')">&times;</span>
        `;
        list.appendChild(div);
    });
}

async function addCategory() {
    const name = document.getElementById('newCategoryName').value.trim().toUpperCase();
    if (!name) return;
    await apiFetch('/api/admin/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'add', category: name })
    });
    document.getElementById('newCategoryName').value = '';
    await loadConfig();
}

async function deleteCategory(name) {
    if (!confirm(`'${name}' kategorisini silmek istediğinizden emin misiniz?`)) return;
    await apiFetch('/api/admin/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', category: name })
    });
    await loadConfig();
}

function renderTable() {
    const tbody = document.getElementById('symbolTableBody');
    tbody.innerHTML = '';

    const query = document.getElementById('monitorSearch').value.toLowerCase();

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

        if (symObj.paused) {
            statusHtml = '<span class="status-badge paused">Durduruldu</span>';
        } else if (hasOverride) {
            statusHtml = '<span class="status-badge override">Override</span>';
            if (override.type === 'fixed') overrideValue = `Sabit: ${override.value} TL`;
            else overrideValue = `Çarpan: ${override.value}x`;

            if (override.expiresAt) {
                const expDate = new Date(override.expiresAt);
                if (expDate > new Date()) {
                    overrideValue += `<br><span style="font-size: 10px; color: #f59e0b;">Bitiş: ${expDate.getHours()}:${String(expDate.getMinutes()).padStart(2, '0')}</span>`;
                } else {
                    statusHtml = '<span class="status-badge active">Canlı (Süresi Doldu)</span>';
                }
            }
        }

        const catColor = isCustom ? '#3b82f6' : '#10b981';

        const tr = document.createElement('tr');
        tr.id = `row-${sym}`;

        const tvTicker = config.tickerCache ? config.tickerCache[sym] : '...';

        tr.innerHTML = `
            <td data-label="Seç">
                <input type="checkbox" class="symbol-checkbox" value="${sym}" onclick="updateSelectButtons()">
            </td>
            <td data-label="Sembol">
                <strong>${sym}</strong>
            </td>
            <td data-label="Kategori" style="color: ${catColor}; font-size: 0.85em;">${category}</td>
            <td data-label="TV Ticker" style="font-family: monospace; color: #94a3b8; font-size: 0.8em;">
                ${tvTicker}
            </td>
            <td data-label="Fiyat" class="price-cell">Bekleniyor...</td>
            <td data-label="Durum">${statusHtml}</td>
            <td data-label="Override">${overrideValue}</td>
            <td data-label="İşlem" style="display: flex; gap: 5px; flex-wrap: wrap;">
                ${symObj.paused
                ? `<button class="active" onclick="togglePauseSymbol('${sym}', false)">Devam Et</button>`
                : `<button class="warning" onclick="togglePauseSymbol('${sym}', true)">Durdur</button>`
            }
                <button onclick="openEditModal('${sym}', '${category}', ${isCustom})">Düzenle</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('selectAllCheckbox').checked = false;
    updateSelectButtons();
}

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

async function togglePauseSymbol(symbol, paused) {
    if (paused && !confirm(`${symbol} sembolünden veri akışını durdurmak istiyor musunuz?`)) return;

    await apiFetch(`/api/admin/symbol/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, paused })
    });
    await loadConfig();
}

let currentEditingSymbol = null;
let isBulkEdit = false;

function openEditModal(symbol, category, isCustom = false) {
    currentEditingSymbol = symbol;
    isBulkEdit = false;
    document.getElementById('modalTitle').innerText = `Düzenle: ${symbol}`;
    document.getElementById('editModal').style.display = 'block';

    document.getElementById('categoryInputGroup').style.display = 'block';
    document.getElementById('editCategory').value = category || 'DİĞER';

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

    const deleteBtn = document.getElementById('deleteSymbolBtn');
    if (isCustom) {
        deleteBtn.style.display = 'block';
        deleteBtn.onclick = () => deleteSymbol(symbol);
    } else {
        deleteBtn.style.display = 'none';
    }

    toggleInputs();
}

function openBulkEditModal() {
    const checkedBoxes = document.querySelectorAll('.symbol-checkbox:checked');
    if (checkedBoxes.length === 0) return;

    isBulkEdit = true;
    document.getElementById('modalTitle').innerText = `Toplu Düzenle (${checkedBoxes.length} Sembol)`;
    document.getElementById('editModal').style.display = 'block';

    document.getElementById('categoryInputGroup').style.display = 'none';
    document.getElementById('overrideType').value = 'none';
    document.getElementById('fixedPrice').value = '';
    document.getElementById('multiplierValue').value = '1.00';
    document.getElementById('expiresIn').value = '';
    document.getElementById('deleteSymbolBtn').style.display = 'none';

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

function toggleSelectAll() {
    const isChecked = document.getElementById('selectAllCheckbox').checked;

    const checkboxes = document.querySelectorAll('.symbol-checkbox');
    checkboxes.forEach(cb => {

        if (cb.closest('tr').style.display !== 'none') {
            cb.checked = isChecked;
        }
    });
    updateSelectButtons();
}

function updateSelectButtons() {
    const checkedBoxes = document.querySelectorAll('.symbol-checkbox:checked');
    const deleteBtn = document.getElementById('bulkDeleteBtn');
    const editBtn = document.getElementById('bulkEditBtn');

    if (checkedBoxes.length > 0) {
        deleteBtn.style.display = 'block';
        deleteBtn.innerText = `Seçilenleri Sil (${checkedBoxes.length})`;
        editBtn.style.display = 'block';
        editBtn.innerText = `Seçilenleri Düzenle (${checkedBoxes.length})`;
    } else {
        deleteBtn.style.display = 'none';
        editBtn.style.display = 'none';
    }
}

async function bulkDeleteSymbols() {
    const checkedBoxes = document.querySelectorAll('.symbol-checkbox:checked');
    if (checkedBoxes.length === 0) return;

    const symbolsToDelete = Array.from(checkedBoxes).map(cb => cb.value);

    if (!confirm(`${symbolsToDelete.length} adet sembolü toplu silmek istediğinize emin misiniz?`)) return;

    await apiFetch(`/api/admin/symbols/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols: symbolsToDelete })
    });

    document.getElementById('selectAllCheckbox').checked = false;
    document.getElementById('bulkDeleteBtn').style.display = 'none';

    await loadConfig();
    alert('Seçilen semboller silindi!');
}

function toggleInputs() {
    const type = document.getElementById('overrideType').value;
    document.getElementById('fixedInputGroup').style.display = type === 'fixed' ? 'block' : 'none';
    document.getElementById('multiplierInputGroup').style.display = type === 'multiplier' ? 'block' : 'none';
    document.getElementById('expirationInputGroup').style.display = type !== 'none' ? 'block' : 'none';
}

async function saveOverride() {
    const type = document.getElementById('overrideType').value;

    let payload = {};
    if (type === 'fixed') {
        payload.price = document.getElementById('fixedPrice').value;
    } else if (type === 'multiplier') {
        payload.multiplier = document.getElementById('multiplierValue').value;
    }

    const expiresIn = document.getElementById('expiresIn').value;
    if (expiresIn && type !== 'none') {
        payload.expiresIn = expiresIn;
    }

    if (isBulkEdit) {
        const checkedBoxes = document.querySelectorAll('.symbol-checkbox:checked');
        const symbolsToEdit = Array.from(checkedBoxes).map(cb => cb.value);
        payload.symbols = symbolsToEdit;

        await apiFetch(`/api/admin/symbols/bulk-override`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        document.getElementById('selectAllCheckbox').checked = false;

    } else {

        payload.symbol = currentEditingSymbol;

        const newCategory = document.getElementById('editCategory').value;
        await apiFetch(`/api/admin/symbol/category`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol: currentEditingSymbol, category: newCategory })
        });

        await apiFetch(`/api/admin/override`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    }

    closeModal();
    await loadConfig();
    alert('Ayarlar kaydedildi!');
}

loadConfig();

const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}

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
            const oldPriceText = priceCell.innerText.replace(' TL', '');
            const oldPrice = parseFloat(oldPriceText);

            let formattedPrice;
            if (price < 0.001) formattedPrice = price.toFixed(8);
            else if (price < 1) formattedPrice = price.toFixed(4);
            else formattedPrice = price.toFixed(2);

            priceCell.innerText = `${formattedPrice} TL`;

            if (!isNaN(oldPrice) && oldPrice !== price) {
                priceCell.style.color = price > oldPrice ? '#4ade80' : '#f87171';
                setTimeout(() => priceCell.style.color = 'white', 500);
            }
        }
    }
}
