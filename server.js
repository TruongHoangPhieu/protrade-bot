require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, MACD, BollingerBands } = require('technicalindicators');

const app = express();

// --- CẤU HÌNH CORS NÂNG CẤP ĐỂ THÔNG SUỐT DỮ LIỆU SANG NETLIFY ---
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Cấu hình Telegram
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Quản lý kết nối
const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
    clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); });
}

function sendTelegramAlert(signal) {
    if (!CHAT_ID) return;
    const emoji = signal.type === 'BUY' ? '🟢' : '🔴';
    const text = `${emoji} *${signal.type} ${signal.symbol}*
💰 $${signal.price} | SL: $${signal.stopLoss} | TP: $${signal.takeProfit}
📊 ${signal.reason}`;
    bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(() => {});
}

// --- DANH SÁCH COIN CHUẨN ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];

// Endpoint cung cấp dữ liệu nến cho App vẽ biểu đồ
app.get('/api/klines/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const interval = req.query.interval || '1h';
        const limit = req.query.limit || 100;
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const { data } = await axios.get(url);
        const klines = data.map(k => ({
            time: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5]
        }));
        res.json(klines);
    } catch (e) { res.status(400).json({ error: 'Symbol not found or API error' }); }
});

// --- PHÂN TÍCH KỸ THUẬT ---
async function getKlines(symbol) {
    try {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=100`;
        const { data } = await axios.get(url);
        return data.map(k => parseFloat(k[4]));
    } catch { return null; }
}

async function analyzeSymbol(symbol) {
    const closes = await getKlines(symbol);
    if (!closes || closes.length < 30) return;

    const price = closes[closes.length - 1];
    const rsi = RSI.calculate({ values: closes, period: 14 }).pop();
    const macd = MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop();
    const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop();

    let buy = 0, sell = 0, reasons = [];
    if (rsi < 30) { buy++; reasons.push(`RSI:${rsi.toFixed(0)}`); } else if (rsi > 70) { sell++; reasons.push(`RSI:${rsi.toFixed(0)}`); }
    if (macd.histogram > 0 && macd.MACD > macd.signal) { buy++; reasons.push('MACD↑'); } else if (macd.histogram < 0) { sell++; reasons.push('MACD↓'); }
    if (price <= bb.lower) { buy++; reasons.push('BB Low'); } else if (price >= bb.upper) { sell++; reasons.push('BB High'); }

    let type = buy >= 2 ? 'BUY' : (sell >= 2 ? 'SELL' : null);
    if (type) {
        const sl = type === 'BUY' ? 0.97 : 1.03;
        const tp = type === 'BUY' ? 1.06 : 0.94;
        const signal = {
            type, symbol, price: price.toFixed(2),
            stopLoss: (price * sl).toFixed(2), takeProfit: (price * tp).toFixed(2),
            reason: reasons.join(' + ')
        };
        broadcast({ type: 'SIGNAL', data: signal });
        sendTelegramAlert(signal);
    }
}

async function scanner() {
    for (const s of SYMBOLS) { await analyzeSymbol(s); await new Promise(r => setTimeout(r, 300)); }
}
setInterval(scanner, 60000);
scanner();

app.get('/', (req, res) => res.send('ProTrade Bot v3.0 - Real Chart & CORS Fix Ready! 🚀'));

// --- SỬA LỖI CỔNG ĐỂ RENDER THÔNG MẠNG ---
const PORT = process.env.PORT || 10000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
});
