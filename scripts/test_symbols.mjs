const knownCryptos = new Set(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'ADA', 'AVAX', 'DOGE', 'SHIB', 'DOT', 'LINK', 'TRX', 'POL', 'LTC', 'BCH', 'UNI', 'XLM', 'ATOM', 'ETC', 'FIL', 'HBAR', 'APT', 'ARB', 'OP', 'INJ', 'RENDER', 'GRT', 'STX', 'NEAR', 'ALGO', 'AAVE', 'SAND', 'GALA', 'MANA', 'EGLD', 'THETA', 'AXS', 'XTZ', 'MINA', 'CHZ', 'NEO']);
const nasdaqStocks = new Set(['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'TSLA', 'META', 'NFLX', 'AMD', 'INTC', 'CSCO', 'ADBE', 'PYPL', 'CRM', 'ORCL']);
const nyseStocksSet = new Set(['IBM', 'V', 'MA', 'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BA', 'DIS', 'KO', 'PEP', 'MCD', 'NKE', 'WMT', 'TGT', 'PG', 'JNJ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'XOM', 'CVX', 'GE', 'F', 'GM', 'VZ', 'T']);
const symbolMapping = {
    'BRENT': 'TVC:UKOIL', 'GOLD': 'FX_IDC:XAUTRY', 'SILVER': 'FX_IDC:XAGTRY',
    'COPPER': 'COMEX:HG1!', 'WHEAT': 'CBOT:ZW1!', 'CORN': 'CBOT:ZC1!',
    'SUGAR': 'ICEUS:SB1!', 'COFFEE': 'ICEUS:KC1!', 'COTTON': 'ICEUS:CT1!',
    'SPX': 'TVC:SPX', 'NDX': 'TVC:NDX', 'DAX': 'TVC:DAX', 'DJI': 'TVC:DJI',
    'CAC40': 'TVC:CAC40', 'NI225': 'TVC:NI225', 'HSI': 'TVC:HSI',
    'XU100': 'BIST:XU100', 'XU030': 'BIST:XU030', 'XBANK': 'BIST:XBANK',
};

function getSymbolForCategory(symbol, category) {
    if (!symbol) return null;
    if (symbol.includes(':')) return symbol.toUpperCase();
    const sym = symbol.toUpperCase().trim();
    if (symbolMapping[sym]) return symbolMapping[sym];
    if (category === 'BORSA ISTANBUL') return 'BIST:' + sym;
    if (category === 'EXCHANGE') return 'FX_IDC:' + sym;
    if (category === 'KRIPTO') {
        if (sym.endsWith('USDT')) return 'BINANCE:' + sym;
        if (sym.endsWith('TRY')) return 'BINANCE:' + sym;
        if (sym.endsWith('USD')) return 'BINANCE:' + sym.slice(0, -3) + 'USDT';
        return 'BINANCE:' + sym + 'USDT';
    }
    if (category === 'STOCKS') {
        if (nyseStocksSet.has(sym)) return 'NYSE:' + sym;
        return 'NASDAQ:' + sym;
    }
    if (category === 'EMTIA') return 'TVC:' + sym;
    const cryptoSuffixes = ['USDT', 'USDC', 'USD', 'TRY', 'BTC', 'ETH', 'BNB'];
    for (const suffix of cryptoSuffixes) {
        if (sym.endsWith(suffix)) {
            const base = sym.slice(0, -suffix.length);
            if (knownCryptos.has(base) || base.length <= 6) {
                if (suffix === 'USD') return 'BINANCE:' + base + 'USDT';
                return 'BINANCE:' + sym;
            }
        }
    }
    if (nasdaqStocks.has(sym)) return 'NASDAQ:' + sym;
    if (nyseStocksSet.has(sym)) return 'NYSE:' + sym;
    if (knownCryptos.has(sym)) return 'BINANCE:' + sym + 'USDT';
    if (sym.length >= 3 && sym.length <= 6 && /^[A-Z]+$/.test(sym)) return 'BIST:' + sym;
    return 'TVC:' + sym;
}

const tests = [
    { symbol: 'GUBRF', category: 'BORSA ISTANBUL' },
    { symbol: 'ETHUSDT', category: 'KRIPTO' },
    { symbol: 'BTCUSD', category: 'KRIPTO' },
    { symbol: 'ETH', category: 'KRIPTO' },
    { symbol: 'AVAXTRY', category: 'KRIPTO' },
    { symbol: 'WHEAT', category: 'EMTIA' },
    { symbol: 'GOLD', category: 'EMTIA' },
    { symbol: 'SPX', category: 'ENDEKSLER' },
    { symbol: 'EURUSD', category: 'EXCHANGE' },
    { symbol: 'AAPL', category: 'STOCKS' },
    { symbol: 'JPM', category: 'STOCKS' },
    { symbol: 'BTCUSD', category: 'DİĞER' },
    { symbol: 'OP', category: 'KRIPTO' },
];

console.log('Sembol Dönüşüm Testi:');
console.log('='.repeat(60));
tests.forEach(t => {
    const ticker = getSymbolForCategory(t.symbol, t.category);
    const ok = ticker && ticker.includes(':') ? '✅' : '❌';
    console.log(ok + ' [' + t.category.padEnd(16) + '] ' + t.symbol.padEnd(10) + ' -> ' + ticker);
});
