require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { RSI, MACD, BollingerBands } = require('technicalindicators');

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Cấu hình Telegram
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Quản lý kết nối App
const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(data));
    });
}

function sendTelegramAlert(signal) {
    if (!CHAT_ID) return;
    const emoji = signal.type === 'BUY' ? '🟢' : '🔴';
    const text = `${emoji} *TÍN HIỆU ${signal.type} - ${signal.symbol}*
💰 Giá: $${signal.price}
🎯 SL: $${signal.stopLoss} | TP: $${signal.takeProfit}
📊 *Phân tích:*
• RSI(14): ${signal.indicators.rsi}
• MACD: ${signal.indicators.macdSignal}
• BB: ${signal.indicators.bbPosition}
💡 Lý do: ${signal.reason}`;
    bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}

// --- PHÂN TÍCH KỸ THUẬT CHUYÊN SÂU ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];

async function getKlines(symbol, interval = '1h', limit = 100) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await axios.get(url);
    // Trả về mảng giá đóng cửa (Close Price)
    return res.data.map(k => parseFloat(k[4]));
}

async function analyzeSymbol(symbol) {
    try {
        const closes = await getKlines(symbol);
        const currentPrice = closes[closes.length - 1];

        // 1. Tính RSI (14 chu kỳ)
        const rsiValues = RSI.calculate({ values: closes, period: 14 });
        const rsi = rsiValues[rsiValues.length - 1];

        // 2. Tính MACD
        const macdValues = MACD.calculate({ 
            values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9, SimpleMAOscillator: true, SimpleMASignal: true 
        });
        const macd = macdValues[macdValues.length - 1];

        // 3. Tính Bollinger Bands
        const bbValues = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
        const bb = bbValues[bbValues.length - 1];

        // --- LOGIC ĐỒNG THUẬN TÍN HIỆU ---
        let buyScore = 0;
        let sellScore = 0;
        let reasons = [];

        // RSI: < 30 (Quá bán), > 70 (Quá mua)
        if (rsi < 30) { buyScore++; reasons.push(`RSI quá bán (${rsi.toFixed(1)})`); }
        else if (rsi > 70) { sellScore++; reasons.push(`RSI quá mua (${rsi.toFixed(1)})`); }

        // MACD: Histogram dương & MACD cắt lên Signal -> Mua
        if (macd.histogram > 0 && macd.MACD > macd.signal) { buyScore++; reasons.push('MACD Bullish Cross'); }
        else if (macd.histogram < 0 && macd.MACD < macd.signal) { sellScore++; reasons.push('MACD Bearish Cross'); }

        // Bollinger Bands: Chạm/Gãy băng dưới -> Mua, Chạm/Gãy băng trên -> Bán
        if (currentPrice <= bb.lower) { buyScore++; reasons.push('Chạm dải BB dưới'); }
        else if (currentPrice >= bb.upper) { sellScore++; reasons.push('Chạm dải BB trên'); }

        // Chỉ phát tín hiệu khi có ít nhất 2/3 chỉ báo đồng thuận
        let signalType = null;
        if (buyScore >= 2) signalType = 'BUY';
        else if (sellScore >= 2) signalType = 'SELL';

        if (signalType) {
            const slMult = signalType === 'BUY' ? 0.97 : 1.03; // SL 3%
            const tpMult = signalType === 'BUY' ? 1.06 : 0.94; // TP 6% (Tỷ lệ R:R = 1:2)

            const signal = {
                type: signalType,
                symbol: symbol,
                price: currentPrice.toFixed(2),
                stopLoss: (currentPrice * slMult).toFixed(2),
                takeProfit: (currentPrice * tpMult).toFixed(2),
                reason: reasons.join(' + '),
                indicators: {
                    rsi: rsi.toFixed(1),
                    macdSignal: macd.histogram > 0 ? 'Tăng 📈' : 'Giảm 📉',
                    bbPosition: currentPrice <= bb.lower ? 'Vùng thấp' : (currentPrice >= bb.upper ? 'Vùng cao' : 'Trung bình')
                }
            };

            broadcast({ type: 'SIGNAL', data: signal });
            sendTelegramAlert(signal);
            console.log(`[TA] ${signalType} ${symbol} @ $${currentPrice} | Score: Buy=${buyScore}, Sell=${sellScore}`);
        }
    } catch (err) {
        console.error(`Lỗi phân tích ${symbol}:`, err.message);
    }
}

// Vòng lặp quét toàn bộ danh sách coin mỗi 60 giây
async function marketScanner() {
    for (const symbol of SYMBOLS) {
        await analyzeSymbol(symbol);
        await new Promise(r => setTimeout(r, 200)); // Delay nhẹ tránh bị Binance rate-limit
    }
}

setInterval(marketScanner, 60000);
marketScanner(); // Chạy ngay khi khởi động

app.get('/', (req, res) => res.send('ProTrade Bot TA Engine is Live! 🧠📊'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
