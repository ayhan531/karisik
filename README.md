# ES Menkul Canlı Fiyat Takip Sistemi

🔴 **CANLI** gerçek zamanlı TradingView verilerine dayalı profesyonel piyasa fiyat takip dashboard'u.

## 🚀 Özellikler

- ✅ **Gerçek Zamanlı Veriler:** TradingView WebSocket üzerinden canlı fiyat akışı
- ✅ **850+ Sembol:** Kripto, BIST, Forex, Emtia, Hisse Senetleri, Endeksler
- ✅ **6 Kategori:** ENDEKSLER, EMTIA, EXCHANGE, KRIPTO, BORSA ISTANBUL, STOCKS
- ✅ **Arama Fonksiyonu:** Tüm sembollerde anlık arama
- ✅ **Son Veri Kalıcılığı:** Veri akışı kesildiğinde en son fiyat görünmeye devam eder
- ✅ **Bağlantı Durumu:** 🟢 CANLI / 🔴 BAĞLANTI YOK göstergesi
- ✅ **Premium Dark Theme:** Profesyonel ES Menkul tasarımı

## 📋 Sistem Mimarisi

```
┌─────────────┐         ┌──────────────┐         ┌──────────────┐
│  TradingView│         │   Playwright │         │   Frontend   │
│   WebSocket │────────▶│  Proxy Server│────────▶│  Dashboard   │
│   (Gerçek)  │         │  (Node.js)   │         │  (HTML/JS)   │
└─────────────┘         └──────────────┘         └──────────────┘
```

### Backend (Server)
- **Playwright** ile gerçek Chrome browser
- TradingView cookie authentication
- 3 farklı WebSocket stream dinleme
- Sembol normalizasyonu (CRYPTO:BTCUSD → BTC)
- WebSocket broadcast (port 3002)

### Frontend
- Vanilla JavaScript (modüler)
- WebSocket client
- 850+ sembol listesi
- Kategori bazlı filtreleme
- Real-time price updates

## 🛠️ Kurulum

### 1. Depo Klonlama
```bash
git clone https://github.com/ayhan531/karisik.git
cd karisik
```

### 2. Server Kurulumu
```bash
cd server
npm install
npx playwright install chromium
```

### 3. TradingView Cookie Ayarı

`server/config.js` dosyasındaki cookie'leri güncelleyin:

1. TradingView'e giriş yapın
2. F12 → Application → Cookies → tradingview.com
3. `sessionid`, `sessionid_sign`, `device_t` değerlerini kopyalayın
4. `server/config.js` dosyasına yapıştırın

### 4. Çalıştırma

#### Backend:
```bash
cd server
npm start
```

#### Frontend:
```bash
# Ana dizinde
npx http-server ./ -p 8080
```

Tarayıcıda: `http://localhost:8080`

## 🌐 Deployment (Render.com)

### Otomatik Kurulum
```bash
# Repository'i Render'a bağlayın
# render.yaml otomatik olarak her şeyi kuracaktır
```

### Manuel Kurulum

**Backend Service:**
- **Type:** Web Service
- **Build Command:** `cd server && npm install && npx playwright install chromium`
- **Start Command:** `cd server && npm start`
- **Environment Variables:**
  - `NODE_ENV=production`
  - Cookie bilgilerini environment variables olarak ekleyin

**Frontend Service:**
- **Type:** Static Site
- **Publish Directory:** `./`
- **Build Command:** (boş bırakın)

## 📊 Veri Kaynağı

Tüm fiyat verileri **TradingView Pro** hesabı üzerinden çekilmektedir:
- **data.tradingview.com** - Fiyat verileri
- **pushstream.tradingview.com** - Canlı akış

## ⚙️ Teknik Detaylar

### Sembol Mapping
```javascript
// TradingView Format → Uygulama Format
CRYPTO:BTCUSD → BTC
BINANCE:ETHUSDT → ETH
BIST:THYAO → THYAO
FX_IDC:EURUSD → EURUSD
```

### WebSocket Mesaj Formatı
```json
{
  "type": "price_update",
  "data": {
    "symbol": "BTC",
    "price": 69000.00,
    "changePercent": 3.45,
    "timestamp": 1771031000000
  }
}
```

## 🔧 Troubleshooting

### Cookie Hataları
- Cookie'lerin güncel olduğundan emin olun
- TradingView'e tekrar giriş yapıp yeni cookie alın

### WebSocket Bağlantı Sorunları
- Server'ın çalıştığından emin olun (`npm start`)
- Port 3002'nin açık olduğunu kontrol edin

### Veri Gelmiyor
- Browser console'da hata var mı kontrol edin
- Server loglarını inceleyin
- Cookie'lerin doğru olduğunu teyit edin

## 📝 License

MIT

## 👤 Geliştirici

**Frontend & Backend:** ES Menkul inspired design  
**Data Source:** TradingView Pro  
**Deployment:** Render.com

---

**Not:** Bu sistem sadece veri akışı için tasarlanmıştır. Chart görüntüleme özelliği kaldırılmıştır. Manuel trading işlemleri için ES Menkul resmi platformunu kullanın.
