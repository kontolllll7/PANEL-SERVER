// ============================================================
// PANEL ADMIN BLUE GAMES — versi Telegram Bot (polling, Railway)
//
// Beda sama versi Vercel: ini proses yang NYALA TERUS, connect
// sendiri ke server Telegram buat "nanya" pesan baru (polling).
// Gak perlu setup webhook.
//
// Env vars yang WAJIB diset di Railway (tab "Variables"):
//   TELEGRAM_BOT_TOKEN       -> token dari @BotFather
//   TELEGRAM_ADMIN_CHAT_ID   -> chat id kamu (boleh lebih dari satu, pisah koma)
//   FIREBASE_SERVICE_ACCOUNT -> isi serviceAccountKey.json, di-JSON.stringify jadi satu baris
//   FIREBASE_DATABASE_URL    -> https://daftar-id-default-rtdb.asia-southeast1.firebasedatabase.app
// ============================================================
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN belum diset.');
    process.exit(1);
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('🤖 Bot jalan (polling mode)...');

function formatId(n) {
    return String(n).padStart(6, '0');
}

function isAuthorized(chatId) {
    if (!ADMIN_CHAT_ID) return false;
    return ADMIN_CHAT_ID.split(',').map((s) => s.trim()).includes(String(chatId));
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text.startsWith('/')) return;

    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, `⛔ Kamu gak punya akses. Chat ID kamu: ${chatId}`);
        return;
    }

    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(' ').trim();
    const ref = db.ref();

    try {
        if (cmd === '/start' || cmd === '/menu') {
            await bot.sendMessage(
                chatId,
                '<b>Panel Admin Blue Games</b>\n\n' +
                    '/status - lihat status sekarang\n' +
                    '/on - aktifkan dialog update\n' +
                    '/off - matikan dialog update\n' +
                    '/setlink [url] - ganti link update\n' +
                    '/accounts - lihat daftar akun terdaftar',
                { parse_mode: 'HTML' }
            );
        } else if (cmd === '/status') {
            const [counterSnap, updateSnap] = await Promise.all([
                ref.child('counter').once('value'),
                ref.child('updateStatus').once('value'),
            ]);
            const counter = counterSnap.val() || 0;
            const status = updateSnap.val() || { maintenance: false, updateUrl: '' };
            await bot.sendMessage(
                chatId,
                `Total akun: ${formatId(counter)} (${counter})\n` +
                    `Dialog update: ${status.maintenance ? 'AKTIF' : 'MATI'}\n` +
                    `Link update: ${status.updateUrl || '(belum di-set)'}`
            );
        } else if (cmd === '/on') {
            await ref.child('updateStatus/maintenance').set(true);
            await bot.sendMessage(chatId, '✅ Dialog update sekarang AKTIF di aplikasi.');
        } else if (cmd === '/off') {
            await ref.child('updateStatus/maintenance').set(false);
            await bot.sendMessage(chatId, '✅ Dialog update sekarang DIMATIKAN.');
        } else if (cmd === '/setlink') {
            if (!arg) {
                await bot.sendMessage(chatId, '⚠️ Format: /setlink https://link-update-lo');
            } else {
                await ref.child('updateStatus/updateUrl').set(arg);
                await bot.sendMessage(chatId, `✅ Link update disimpan: ${arg}`);
            }
        } else if (cmd === '/accounts') {
            const accountsSnap = await ref.child('accounts').once('value');
            const accounts = accountsSnap.val() || {};
            const entries = Object.entries(accounts);
            if (entries.length === 0) {
                await bot.sendMessage(chatId, '(belum ada akun terdaftar)');
            } else {
                const lines = entries
                    .sort((a, b) => a[1] - b[1])
                    .slice(0, 100)
                    .map(([key, id]) => `${formatId(id)}  ${key}`);
                const extra = entries.length > 100 ? `\n\n(+${entries.length - 100} lagi, gak ditampilin)` : '';
                await bot.sendMessage(chatId, `<b>Daftar Akun</b>\n\n${lines.join('\n')}${extra}`, { parse_mode: 'HTML' });
            }
        } else {
            await bot.sendMessage(chatId, 'Perintah gak dikenal. Ketik /menu buat lihat daftar perintah.');
        }
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '⚠️ Ada error, cek log Railway.');
    }
});
