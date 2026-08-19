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

bot.on('polling_error', (err) => {
    console.error('❌ Polling error:', err.message);
});

// Daftar command biar muncul di tombol menu "/" Telegram
bot.setMyCommands([
    { command: 'menu', description: 'Lihat semua perintah' },
    { command: 'status', description: 'Lihat status dialog update & jumlah akun' },
    { command: 'on', description: 'Aktifkan dialog update' },
    { command: 'off', description: 'Matikan dialog update' },
    { command: 'setlink', description: 'Ganti link update' },
    { command: 'accounts', description: 'Lihat daftar akun terdaftar' },
    { command: 'skipboost', description: 'Skip dialog boost 15 detik buat 1 ID' },
    { command: 'unskipboost', description: 'Balikin dialog boost buat 1 ID' },
    { command: 'boostskiplist', description: 'Lihat daftar ID yang di-skip boost-nya' },
]).catch((err) => console.error('Gagal set command list:', err));

function formatId(n) {
    return String(n).padStart(6, '0');
}

function isAuthorized(chatId) {
    if (!ADMIN_CHAT_ID) return false;
    return ADMIN_CHAT_ID.split(',').map((s) => s.trim()).includes(String(chatId));
}

// Nyimpen siapa yang lagi ditanya "kirim link barunya" (buat fitur tombol Ganti Link)
const waitingForLink = new Set();
// Sama, tapi buat nunggu user ngetik ID pas tombol "Skip Boost (ID)"/"Un-skip" dipencet.
const waitingForSkipId = new Set();
const waitingForUnskipId = new Set();

const menuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📊 Status', callback_data: 'status' }],
            [
                { text: '✅ Aktifkan Dialog', callback_data: 'on' },
                { text: '⛔ Matikan Dialog', callback_data: 'off' },
            ],
            [{ text: '🔗 Ganti Link Update', callback_data: 'setlink' }],
            [{ text: '📋 Lihat Daftar Akun', callback_data: 'accounts' }],
            [
                { text: '🚀 Skip Boost (ID)', callback_data: 'skipboost' },
                { text: '↩️ Un-skip Boost (ID)', callback_data: 'unskipboost' },
            ],
            [{ text: '📋 Daftar ID Skip Boost', callback_data: 'boostskiplist' }],
        ],
    },
};

async function sendMenu(chatId) {
    await bot.sendMessage(chatId, '<b>Panel Admin Blue Games</b>\nPilih menu di bawah:', {
        parse_mode: 'HTML',
        ...menuKeyboard,
    });
}

// Validasi & normalisasi ID yang diketik admin (boleh ada spasi/leading zero,
// yang penting angka valid >= 0). Balikin null kalau gak valid.
function parseAccountId(raw) {
    if (raw === undefined || raw === null) return null;
    const trimmed = String(raw).trim();
    if (!/^\d+$/.test(trimmed)) return null;
    return parseInt(trimmed, 10);
}

async function runAction(chatId, action, arg) {
    const ref = db.ref();

    if (action === 'status') {
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
    } else if (action === 'on') {
        await ref.child('updateStatus/maintenance').set(true);
        await bot.sendMessage(chatId, '✅ Dialog update sekarang AKTIF di aplikasi.');
    } else if (action === 'off') {
        await ref.child('updateStatus/maintenance').set(false);
        await bot.sendMessage(chatId, '✅ Dialog update sekarang DIMATIKAN.');
    } else if (action === 'setlink') {
        if (!arg) {
            waitingForLink.add(chatId);
            await bot.sendMessage(chatId, 'Kirim link update yang baru (langsung ketik & send):');
        } else {
            await ref.child('updateStatus/updateUrl').set(arg);
            await bot.sendMessage(chatId, `✅ Link update disimpan: ${arg}`);
        }
    } else if (action === 'accounts') {
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
    } else if (action === 'skipboost') {
        if (!arg) {
            waitingForSkipId.add(chatId);
            await bot.sendMessage(chatId, 'Kirim ID akun yang mau di-skip dialog boost-nya (contoh: 123 atau 000123):');
            return;
        }
        const id = parseAccountId(arg);
        if (id === null) {
            await bot.sendMessage(chatId, '⚠️ ID gak valid, harus angka. Contoh: /skipboost 123');
            return;
        }
        await ref.child(`boostSkip/${id}`).set(true);
        await bot.sendMessage(chatId, `✅ Dialog boost (hitung mundur 15 detik) di-SKIP buat ID ${formatId(id)}.`);
    } else if (action === 'unskipboost') {
        if (!arg) {
            waitingForUnskipId.add(chatId);
            await bot.sendMessage(chatId, 'Kirim ID akun yang mau dibalikin lagi dialog boost-nya (contoh: 123 atau 000123):');
            return;
        }
        const id = parseAccountId(arg);
        if (id === null) {
            await bot.sendMessage(chatId, '⚠️ ID gak valid, harus angka. Contoh: /unskipboost 123');
            return;
        }
        await ref.child(`boostSkip/${id}`).remove();
        await bot.sendMessage(chatId, `✅ Dialog boost dibalikin normal (tampil lagi) buat ID ${formatId(id)}.`);
    } else if (action === 'boostskiplist') {
        const skipSnap = await ref.child('boostSkip').once('value');
        const skipMap = skipSnap.val() || {};
        const ids = Object.keys(skipMap).filter((k) => skipMap[k] === true);
        if (ids.length === 0) {
            await bot.sendMessage(chatId, '(belum ada ID yang di-skip dialog boost-nya)');
        } else {
            const lines = ids
                .map((idStr) => parseInt(idStr, 10))
                .sort((a, b) => a - b)
                .map((id) => formatId(id));
            await bot.sendMessage(chatId, `<b>ID yang Dialog Boost-nya Di-skip</b>\n\n${lines.join('\n')}`, {
                parse_mode: 'HTML',
            });
        }
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    console.log(`📩 Pesan masuk dari ${chatId}: "${text}"`);
    if (!text) return;

    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, `⛔ Kamu gak punya akses. Chat ID kamu: ${chatId}`);
        return;
    }

    try {
        // Kalau bot lagi nunggu link baru / ID skip-boost dari user ini
        if (waitingForLink.has(chatId) && !text.startsWith('/')) {
            waitingForLink.delete(chatId);
            await runAction(chatId, 'setlink', text);
            return;
        }
        if (waitingForSkipId.has(chatId) && !text.startsWith('/')) {
            waitingForSkipId.delete(chatId);
            await runAction(chatId, 'skipboost', text);
            return;
        }
        if (waitingForUnskipId.has(chatId) && !text.startsWith('/')) {
            waitingForUnskipId.delete(chatId);
            await runAction(chatId, 'unskipboost', text);
            return;
        }

        if (text === '/start' || text === '/menu') {
            await sendMenu(chatId);
            return;
        }

        if (!text.startsWith('/')) {
            await sendMenu(chatId);
            return;
        }

        const [cmdRaw, ...rest] = text.split(/\s+/);
        const cmd = cmdRaw.toLowerCase().replace('/', '');
        const arg = rest.join(' ').trim();

        if (['status', 'on', 'off', 'setlink', 'accounts', 'skipboost', 'unskipboost', 'boostskiplist'].includes(cmd)) {
            await runAction(chatId, cmd, arg);
        } else {
            await bot.sendMessage(chatId, 'Perintah gak dikenal. Ketik /menu buat lihat daftar perintah.');
        }
    } catch (err) {
        console.error(err);
        bot.sendMessage(chatId, '⚠️ Ada error, cek log Railway.');
    }
});

// Handle tap tombol
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const action = query.data;

    if (!isAuthorized(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Gak punya akses.', show_alert: true });
        return;
    }

    try {
        await runAction(chatId, action, null);
        await bot.answerCallbackQuery(query.id);
    } catch (err) {
        console.error(err);
        await bot.answerCallbackQuery(query.id, { text: 'Error, cek log Railway.', show_alert: true });
    }
});
                                                                  
