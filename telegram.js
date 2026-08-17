// ============================================================
// PANEL ADMIN BLUE GAMES — versi Telegram Bot (webhook, Vercel)
//
// Ganti "node panel.js" yang jalan di terminal jadi endpoint
// serverless yang dipanggil Telegram tiap ada pesan masuk.
// Gak perlu proses nyala 24 jam, cocok buat Vercel.
//
// Env vars yang WAJIB diset di Vercel:
//   TELEGRAM_BOT_TOKEN      -> token dari @BotFather
//   TELEGRAM_ADMIN_CHAT_ID  -> chat id kamu (boleh lebih dari satu, pisah koma)
//   FIREBASE_SERVICE_ACCOUNT -> isi serviceAccountKey.json, di-JSON.stringify jadi satu baris
//   FIREBASE_DATABASE_URL   -> https://daftar-id-default-rtdb.asia-southeast1.firebasedatabase.app
// ============================================================
const admin = require('firebase-admin');

let firebaseApp;
function getDb() {
    if (!firebaseApp) {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        firebaseApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL,
        });
    }
    return admin.database();
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

function formatId(n) {
    return String(n).padStart(6, '0');
}

function isAuthorized(chatId) {
    if (!ADMIN_CHAT_ID) return false; // default: tolak semua kalau belum diset
    return ADMIN_CHAT_ID.split(',').map((s) => s.trim()).includes(String(chatId));
}

async function sendMessage(chatId, text) {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
}

async function handleCommand(chatId, text) {
    const [cmdRaw, ...rest] = text.trim().split(/\s+/);
    const cmd = cmdRaw.toLowerCase();
    const arg = rest.join(' ').trim();
    const ref = getDb().ref();

    if (cmd === '/start' || cmd === '/menu') {
        await sendMessage(
            chatId,
            '<b>Panel Admin Blue Games</b>\n\n' +
                '/status - lihat status sekarang\n' +
                '/on - aktifkan dialog update\n' +
                '/off - matikan dialog update\n' +
                '/setlink [url] - ganti link update\n' +
                '/accounts - lihat daftar akun terdaftar'
        );
        return;
    }

    if (cmd === '/status') {
        const [counterSnap, updateSnap] = await Promise.all([
            ref.child('counter').once('value'),
            ref.child('updateStatus').once('value'),
        ]);
        const counter = counterSnap.val() || 0;
        const status = updateSnap.val() || { maintenance: false, updateUrl: '' };
        await sendMessage(
            chatId,
            `Total akun: ${formatId(counter)} (${counter})\n` +
                `Dialog update: ${status.maintenance ? 'AKTIF' : 'MATI'}\n` +
                `Link update: ${status.updateUrl || '(belum di-set)'}`
        );
        return;
    }

    if (cmd === '/on') {
        await ref.child('updateStatus/maintenance').set(true);
        await sendMessage(chatId, '✅ Dialog update sekarang AKTIF di aplikasi.');
        return;
    }

    if (cmd === '/off') {
        await ref.child('updateStatus/maintenance').set(false);
        await sendMessage(chatId, '✅ Dialog update sekarang DIMATIKAN.');
        return;
    }

    if (cmd === '/setlink') {
        if (!arg) {
            await sendMessage(chatId, '⚠️ Format: /setlink https://link-update-lo');
        } else {
            await ref.child('updateStatus/updateUrl').set(arg);
            await sendMessage(chatId, `✅ Link update disimpan: ${arg}`);
        }
        return;
    }

    if (cmd === '/accounts') {
        const accountsSnap = await ref.child('accounts').once('value');
        const accounts = accountsSnap.val() || {};
        const entries = Object.entries(accounts);
        if (entries.length === 0) {
            await sendMessage(chatId, '(belum ada akun terdaftar)');
        } else {
            const lines = entries
                .sort((a, b) => a[1] - b[1])
                .slice(0, 100)
                .map(([key, id]) => `${formatId(id)}  ${key}`);
            const extra = entries.length > 100 ? `\n\n(+${entries.length - 100} lagi, gak ditampilin)` : '';
            await sendMessage(chatId, `<b>Daftar Akun</b>\n\n${lines.join('\n')}${extra}`);
        }
        return;
    }

    await sendMessage(chatId, 'Perintah gak dikenal. Ketik /menu buat lihat daftar perintah.');
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(200).send('Bot aktif.');
        return;
    }

    try {
        const update = req.body;
        const message = update && update.message;
        if (message && message.text) {
            const chatId = message.chat.id;
            if (!isAuthorized(chatId)) {
                await sendMessage(chatId, `⛔ Kamu gak punya akses. Chat ID kamu: ${chatId}`);
            } else {
                await handleCommand(chatId, message.text);
            }
        }
    } catch (err) {
        console.error(err);
    }

    res.status(200).send('OK');
};
      
