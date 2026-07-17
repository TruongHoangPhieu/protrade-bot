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

// --- API NẾN + CHỈ BÁO CHO APP ---
app.get('/api/klines/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const interval = req.query.interval || '1h';
        const limit = parseInt(req.query.limit) || 100;
        
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        const { data } = await axios.get(url);
        const closes = data.map(k => parseFloat(k[4]));
        
        // Tính toán chỉ báo phía server để giảm tải cho App
        const ema34 = EMA.calculate({ values: closes, period: 34 });
        const bb = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        
        const klines = data.map((k, i) => ({
            time: Math.floor(k[0] / 1000),
            open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
            ema34: ema34[i - (100 - ema34.length)] || null,
            bbUpper: bb[i - (100 - bb.length)]?.upper || null,
            bbLower: bb[i - (100 - bb.length)]?.lower || null
        })).filter(k => k.ema34 !== null); // Chỉ trả về nến có đủ dữ liệu chỉ báo
        
        res.json(klines);
    } catch (e) { res.status(400).json({ error: 'Invalid symbol or interval' }); }
});

// --- QUÉT TÍN HIỆU ĐA KHUNG THỜI GIAN ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const TIMEFRAMES = ['15m', '1h', '4h'];

async function getIndicators(symbol, interval) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=100`;
    const { data } = await axios.get(url);
    const closes = data.map(k => parseFloat(k[4]));
    const price = closes[closes.length - 1];
    
    return {
        price,
        rsi: RSI.calculate({ values: closes, period: 14 }).pop(),
        macd: MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 }).pop(),
        bb: BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 }).pop(),
        ema34: EMA.calculate({ values: closes, period: 34 }).pop()
    };
}

async function analyzeSymbol(symbol) {
    try {
        // Kiểm tra sự đồng thuận đa khung thời gian
        const tfData = {};
        for (const tf of TIMEFRAMES) {
            tfData[tf] = await getIndicators(symbol, tf);
            await new Promise(r => setTimeout(r, 200));
        }
        
        const current = tfData['1h']; // Khung chính để phát tín hiệu
        let buyScore = 0, sellScore = 0, reasons = [];
        
        // Logic vùng Mua/Bán kết hợp EMA + BB + RSI + MACD
        const isAtBuyZone = current.price <= current.bb.lower && current.price < current.ema34;
        const isAtSellZone = current.price >= current.bb.upper && current.price > current.ema34;
        
        if (isAtBuyZone) { buyScore += 2; reasons.push('Vùng MUA (BB Lower + Dưới EMA34)'); }
        if (isAtSellZone) { sellScore += 2; reasons.push('Vùng BÁN (BB Upper + Trên EMA34)'); }
        if (current.rsi < 30) { buyScore++; reasons.push(`RSI quá bán (${current.rsi.toFixed(0)})`); }
        else if (current.rsi > 70) { sellScore++; reasons.push(`RSI quá mua (${current.rsi.toFixed(0)})`); }
        if (current.macd.histogram > 0 && current.macd.MACD > current.macd.signal) { buyScore++; reasons.push('MACD Bullish'); }
        else if (current.macd.histogram < 0 && current.macd.MACD < current.macd.signal) { sellScore++; reasons.push('MACD Bearish'); }
        
        // Xác nhận xu hướng từ khung 4h
        if (tfData['4h'].price > tfData['4h'].ema34 && buyScore >= 3) { buyScore++; reasons.push('Xu hướng 4H tăng'); }
        if (tfData['4h'].price < tfData['4h'].ema34 && sellScore >= 3) { sellScore++; reasons.push('Xu hướng 4H giảm'); }
        
        const type = buyScore >= 3 ? 'BUY' : (sellScore >= 3 ? 'SELL' : null);
        if (type) {
            const sl = type === 'BUY' ? 0.97 : 1.03;
            const tp = type === 'BUY' ? 1.06 : 0.94;
            const signal = {
                type, symbol, 
                price: current.price.toFixed(2),
                stopLoss: (current.price * sl).toFixed(2),
                takeProfit: (current.price * tp).toFixed(2),
                timeframe: '1H (Xác nhận 4H)',
                reason: reasons.join(' | ')
            };
            broadcast({ type: 'SIGNAL', data: signal });
            
            // Gửi Telegram
            if (CHAT_ID) {
                const emoji = type === 'BUY' ? '🟢' : '🔴';
                const text = `${emoji} *${type} ${symbol}* [${signal.timeframe}]
💰 $${signal.price} | SL: $${signal.stopLoss} | TP: $${signal.takeProfit}
📊 ${signal.reason}`;
                bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' }).catch(() => {});
            }
        }
    } catch (err) { console.error(`Lỗi ${symbol}:`, err.message); }
}

async function scanner() {
    for (const s of SYMBOLS) { await analyzeSymbol(s); }
}
setInterval(scanner, 60000);
scanner();

app.get('/', (req, res) => res.send('ProTrade Bot v4.0 Ultimate Live! 🚀'));
server.listen(process.env.PORT || 3000);
