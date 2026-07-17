require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, MACD, BollingerBands, EMA } = require('technicalindicators');

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const clients = new Set();
wss.on('connection', (ws) => { clients.add(ws); ws.on('close', () => clients.delete(ws)); });
function broadcast(data) { clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }

// --- CACHE DỮ LIỆU NẾN TỪ WEBSOCKET BINANCE ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const klineCache = {}; // { symbol: { '1h': [...], '15m': [...] } }

// Kết nối WebSocket Stream của Binance (KHÔNG BAO GIỜ BỊ BAN)
function connectBinanceWS() {
    const streams = [];
    SYMBOLS.forEach(s => {
        streams.push(`${s.toLowerCase()}@kline_1h`);
        streams.push(`${s.toLowerCase()}@kline_15m`);
        streams.push(`${s.toLowerCase()}@kline_4h`);
    });
    
    const binanceWS = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams.join('/')}`);
    
    binanceWS.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw);
            const data = msg.data;
            if (!data || !data.k) return;
            
            const symbol = data.s;
            const interval = data.k.i;
            const kline = {
                time: Math.floor(data.k.t / 1000),
                open: +data.k.o, high: +data.k.h, low: +data.k.l, close: +data.k.c, volume: +data.k.v
            };
            
            if (!klineCache[symbol]) klineCache[symbol] = {};
            if (!klineCache[symbol][interval]) klineCache[symbol][interval] = [];
            
            const arr = klineCache[symbol][interval];
            // Cập nhật nến hiện tại hoặc thêm nến mới
            if (arr.length > 0 && arr[arr.length - 1].time === kline.time) {
                arr[arr.length - 1] = kline;
            } else {
                arr.push(kline);
                if (arr.length > 200) arr.shift(); // Giữ tối đa 200 nến
            }
        } catch(e) {}
    });
    
    binanceWS.on('close', () => { setTimeout(connectBinanceWS, 5000); });
    binanceWS.on('error', () => {});
}

// Load dữ liệu lịch sử ban đầu (chỉ gọi 1 lần duy nhất khi khởi động)
async function loadInitialKlines() {
    for (const symbol of SYMBOLS) {
        for (const interval of ['15m', '1h', '4h']) {
            try {
                const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`;
                const { data } = await axios.get(url);
                klineCache[symbol] = klineCache[symbol] || {};
                klineCache[symbol][interval] = data.map(k => ({
                    time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
                }));
                await new Promise(r => setTimeout(r, 300)); // Delay tránh ban lúc init
            } catch(e) { console.error(`Init ${symbol} ${interval}:`, e.message); }
        }
    }
    console.log('✅ Initial klines loaded via REST (one-time only)');
}

// --- API TRẢ VỀ DỮ LIỆU TỪ CACHE (KHÔNG GỌI BINANCE REST) ---
app.get('/api/klines/:symbol', (req, res) => {
    const symbol = req.params.symbol.toUpperCase();
    const interval = req.query.interval || '1h';
    
    const data = klineCache[symbol]?.[interval];
    if (!data || data.length === 0) {
        return res.status(400).json({ error: 'No cached data yet. Wait 30s after deploy.' });
    }
    
    // Tính chỉ báo từ cache
    const closes = data.map(d => d.close);
    let ema34 = [], bb = [];
    try { if (closes.length >= 34) ema34 = EMA.calculate({ values: closes, period: 34 }); } catch(e) {}
    try { if (closes.length >= 20) bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }); } catch(e) {}
    
    const offset34 = closes.length - ema34.length;
    const offsetBB = closes.length - bb.length;
    
    const result = data.map((d, i) => ({
        ...d,
        ema34: (i >= offset34) ? ema34[i - offset34] : null,
        bbUpper: (i >= offsetBB) ? bb[i - offsetBB]?.upper : null,
        bbLower: (i >= offsetBB) ? bb[i - offsetBB]?.lower : null
    }));
    
    res.json(result);
});

// --- QUÉT TÍN HIỆU TỪ CACHE (KHÔNG GỌI API) ---
async function analyzeSymbol(symbol) {
    try {
        const tfData = {};
        for (const tf of ['15m', '1h', '4h']) {
            const data = klineCache[symbol]?.[tf];
            if (!data || data.length < 34) continue;
            const closes = data.map(d => d.close);
            const price = closes[closes.length - 1];
            tfData[tf] = {
                price,
                rsi: RSI.calculate({ values: closes, period: 14 }).pop(),
                macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop(),
                bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop(),
                ema34: EMA.calculate({ values: closes, period: 34 }).pop()
            };
        }
        
        if (!tfData['1h']) return;
        const current = tfData['1h'];
        let buyScore = 0, sellScore = 0, reasons = [];
        
        const isAtBuyZone = current.price <= current.bb.lower && current.price < current.ema34;
        const isAtSellZone = current.price >= current.bb.upper && current.price > current.ema34;
        if (isAtBuyZone) { buyScore += 2; reasons.push('Vùng MUA (BB Lower + Dưới EMA34)'); }
        if (isAtSellZone) { sellScore += 2; reasons.push('Vùng BÁN (BB Upper + Trên EMA34)'); }
        if (current.rsi < 30) { buyScore++; reasons.push(`RSI quá bán (${current.rsi.toFixed(0)})`); }
        else if (current.rsi > 70) { sellScore++; reasons.push(`RSI quá mua (${current.rsi.toFixed(0)})`); }
        if (current.macd.histogram > 0 && current.macd.MACD > current.macd.signal) { buyScore++; reasons.push('MACD Bullish'); }
        else if (current.macd.histogram < 0 && current.macd.MACD < current.macd.signal) { sellScore++; reasons.push('MACD Bearish'); }
        if (tfData['4h'] && tfData['4h'].price > tfData['4h'].ema34 && buyScore >= 3) { buyScore++; reasons.push('Xu hướng 4H tăng'); }
        if (tfData['4h'] && tfData['4h'].price < tfData['4h'].ema34 && sellScore >= 3) { sellScore++; reasons.push('Xu hướng 4H giảm'); }
        
        const type = buyScore >= 3 ? 'BUY' : (sellScore >= 3 ? 'SELL' : null);
        if (type) {
            const sl = type === 'BUY' ? 0.97 : 1.03;
            const tp = type === 'BUY' ? 1.06 : 0.94;
            const signal = { type, symbol, price: current.price.toFixed(2), stopLoss: (current.price * sl).toFixed(2), takeProfit: (current.price * tp).toFixed(2), timeframe: '1H (Xác nhận 4H)', reason: reasons.join(' | ') };
            broadcast({ type: 'SIGNAL', data: signal });
            if (CHAT_ID) {
                const emoji = type === 'BUY' ? '🟢' : '🔴';
                bot.sendMessage(CHAT_ID, `${emoji} *${type} ${signal.symbol}* [${signal.timeframe}]\n💰 $${signal.price} | SL: $${signal.stopLoss} | TP: $${signal.takeProfit}\n📊 ${signal.reason}`, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
    } catch(err) { console.error(`Lỗi phân tích ${symbol}:`, err.message); }
}

async function scanner() { for (const s of SYMBOLS) { await analyzeSymbol(s); } }
setInterval(scanner, 60000);

// --- KHỞI ĐỘNG ---
connectBinanceWS();
loadInitialKlines().then(() => {
    scanner(); // Quét lần đầu sau khi load xong
});

app.get('/', (req, res) => res.send('ProTrade Bot v4.1 - WebSocket Stream Live! 🚀'));
server.listen(process.env.PORT || 3000);
