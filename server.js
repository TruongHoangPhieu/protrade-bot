require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios'); // Thư viện gọi API

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Cấu hình Telegram
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Lưu trữ clients kết nối
const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('Client connected');
    ws.on('close', () => clients.delete(ws));
});

function broadcast(data) {
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

function sendTelegramAlert(signal) {
    if (!CHAT_ID) return;
    const emoji = signal.type === 'BUY' ? '🟢' : '🔴';
    const text = `
${emoji} *TÍN HIỆU ${signal.type}* ${emoji}
📊 *Cặp:* ${signal.symbol}
💰 *Giá thực:* $${signal.price}
🎯 *Stop Loss:* $${signal.stopLoss}
🏁 *Take Profit:* $${signal.takeProfit}
⏰ *Lúc:* ${new Date().toLocaleTimeString('vi-VN')}
    `;
    bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}

// --- KẾT NỐI DỮ LIỆU THỰC TẾ TỪ BINANCE ---
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
let priceCache = {}; // Lưu giá lần trước để so sánh xu hướng ngắn hạn

async function analyzeMarket() {
    try {
        // Lấy giá ticker 24h từ Binance (Miễn phí, không cần API Key)
        const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr');
        const tickers = response.data.filter(t => SYMBOLS.includes(t.symbol));

        for (const ticker of tickers) {
            const currentPrice = parseFloat(ticker.lastPrice);
            const priceChangePercent = parseFloat(ticker.priceChangePercent);
            const prevPrice = priceCache[ticker.symbol] || currentPrice;
            
            // Cập nhật cache
            priceCache[ticker.symbol] = currentPrice;

            // LOGIC PHÂN TÍCH ĐƠN GIẢN DỰA TRÊN BIẾN ĐỘNG THỰC
            // Nếu giá giảm mạnh > 2% trong 24h -> Tín hiệu MUA bắt đáy
            // Nếu giá tăng mạnh > 2% trong 24h -> Tín hiệu BÁN chốt lời
            let signalType = null;
            let reason = '';

            if (priceChangePercent < -2.0) {
                signalType = 'BUY';
                reason = `Giảm mạnh ${priceChangePercent.toFixed(2)}% - Vùng hỗ trợ`;
            } else if (priceChangePercent > 2.0) {
                signalType = 'SELL';
                reason = `Tăng nóng ${priceChangePercent.toFixed(2)}% - Vùng kháng cự`;
            }

            // Chỉ gửi tín hiệu khi có điều kiện rõ ràng
            if (signalType) {
                const slMultiplier = signalType === 'BUY' ? 0.98 : 1.02;
                const tpMultiplier = signalType === 'BUY' ? 1.05 : 0.95;

                const signal = {
                    type: signalType,
                    symbol: ticker.symbol,
                    price: currentPrice.toFixed(2),
                    stopLoss: (currentPrice * slMultiplier).toFixed(2),
                    takeProfit: (currentPrice * tpMultiplier).toFixed(2),
                    reason: reason
                };

                broadcast({ type: 'SIGNAL', data: signal });
                sendTelegramAlert(signal);
                console.log(`[REAL] Signal: ${signalType} ${ticker.symbol} @ $${currentPrice}`);
            }
        }
    } catch (error) {
        console.error('Lỗi lấy dữ liệu Binance:', error.message);
    }
}

// Chạy phân tích mỗi 60 giây
setInterval(analyzeMarket, 60000);
// Chạy ngay lần đầu khi khởi động
analyzeMarket();

app.get('/', (req, res) => {
    res.send('ProTrade Bot REAL DATA is Running! 🚀');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
