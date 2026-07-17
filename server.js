require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
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
    const text = `${emoji} *TÍN HIỆU ${signal.type}*\n📊 Cặp: ${signal.symbol}\n💰 Giá: $${signal.price}\n🎯 Stop Loss: $${signal.stopLoss}\n🎯 Take Profit: $${signal.takeProfit}\n⏰ Lúc: ${new Date().toLocaleTimeString('vi-VN')}`;
    bot.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
}

setInterval(() => {
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
    const randomSymbol = symbols[Math.floor(Math.random() * symbols.length)];
    const randomPrice = (Math.random() * 1000 + 50).toFixed(2);
    const type = Math.random() > 0.5 ? 'BUY' : 'SELL';
    
    const signal = {
        type: type,
        symbol: randomSymbol,
        price: randomPrice,
        stopLoss: (randomPrice * (type === 'BUY' ? 0.98 : 1.02)).toFixed(2),
        takeProfit: (randomPrice * (type === 'BUY' ? 1.05 : 0.95)).toFixed(2),
        reason: type === 'BUY' ? 'RSI quá bán + Hỗ trợ cứng' : 'RSI quá mua + Kháng cự'
    };

    broadcast({ type: 'SIGNAL', data: signal });
    sendTelegramAlert(signal);
    console.log(`Signal: ${signal.type} ${signal.symbol} at $${signal.price}`);
}, 60000); // 60 giây ra 1 tín hiệu để test

app.get('/', (req, res) => res.send('ProTrade Bot is Running! 🚀'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
