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
//
// CATATAN: fitur update APK jarak jauh (kirim .apk ke bot, local bot-api
// server, dialog update di app) udah DIHAPUS karena sering error. Bot ini
// sekarang cuma ngurus: skip/unskip boost, daftar akun, dan info user
// terakhir aktif.
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

// ============================================================
// FIX: MENU/BALESAN KE-KIRIM 2X
//
// Penyebabnya BUKAN bug di logic command, tapi 2 INSTANCE BOT jalan
// BERSAMAAN -- biasanya kejadian pas Railway lagi redeploy: container LAMA
// belum bener-bener mati padahal container BARU udah mulai polling juga,
// jadi dua-duanya sama-sama nangkep & jawab pesan Telegram yang SAMA
// (makanya kelihatan 2 balesan dengan versi kode yang beda pas abis update
// kode -- itu literally instance lama + instance baru jawab bareng).
//
// Fix-nya: tiap instance yang start nulis "tanda pengenal" unik ke Firebase
// (nimpa punya instance sebelumnya). Sebelum bales pesan APAPUN, instance
// ngecek dulu apa tanda pengenal DIA masih yang paling baru di Firebase --
// kalau ternyata udah ada instance LEBIH BARU yang nimpa duluan (berarti
// dia instance lama yang harusnya udah mati), dia DIAM AJA, gak ikut bales.
// Jadi walau ada 2 instance polling bareng, yang jawab cuma 1 -- instance
// yang paling baru start.
// ============================================================
const INSTANCE_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
db.ref('botInstance')
    .set({ id: INSTANCE_ID, startedAt: Date.now() })
    .then(() => console.log(`🔑 Instance ID: ${INSTANCE_ID} (udah diklaim sebagai instance aktif)`))
    .catch((e) => console.error('Gagal klaim instance:', e.message));

async function isCurrentInstance() {
    try {
        const snap = await db.ref('botInstance/id').once('value');
        return snap.val() === INSTANCE_ID;
    } catch (e) {
        // Gagal baca (misal lagi offline sebentar) -- anggap valid aja,
        // lebih baik sesekali dobel daripada bot diem total gara-gara ini.
        return true;
    }
}

bot.on('polling_error', (err) => {
    console.error('❌ Polling error:', err.message);
});

// Daftar command biar muncul di tombol menu "/" Telegram
bot.setMyCommands([
    { command: 'menu', description: 'Lihat semua perintah' },
    { command: 'accounts', description: 'Lihat daftar akun user' },
    { command: 'lastactive', description: 'Lihat ID user yang terakhir aktif' },
    { command: 'skipboost', description: 'Skip dialog boost 15 detik buat 1 ID' },
    { command: 'unskipboost', description: 'Balikin dialog boost buat 1 ID' },
]).catch((err) => console.error('Gagal set command list:', err));

function formatId(n) {
    return String(n).padStart(6, '0');
}

function isAuthorized(chatId) {
    if (!ADMIN_CHAT_ID) return false;
    return ADMIN_CHAT_ID.split(',').map((s) => s.trim()).includes(String(chatId));
}

// Ubah timestamp (ms epoch) jadi teks relatif kayak "5 menit lalu".
// null/undefined (akun lama yang belum pernah ngirim heartbeat lastActive
// karena app-nya belum diupdate ke versi yang nulis lastActive) -> "belum ada data".
function formatRelativeTime(ts) {
    if (!ts) return 'belum ada data';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'baru saja';
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return 'baru saja';
    if (diffMin < 60) return `${diffMin} menit lalu`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} jam lalu`;
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay} hari lalu`;
}

// ============================================================
// STATE "LAGI NUNGGU BALESAN" -- PER CHAT
//
// PENTING (bekas bug): sebelumnya ini pakai 3 Set terpisah
// (waitingForLink, waitingForSkipId, waitingForUnskipId). Masalahnya,
// kalau user mulai satu alur (misal tap "Un-skip Boost") tapi TIDAK
// jadi ngebales ID-nya -- malah ngetik command lain -- flag "lagi
// nunggu unskip" itu KETINGGALAN nyangkut selamanya karena gak pernah
// dihapus. Efeknya: nanti kalau user ngetik angka polos lagi buat
// alasan LAIN, bisa ke-baca sebagai balesan unskip yang nyangkut itu,
// terus DIAM-DIAM ngehapus status skip yang baru aja di-pasang --
// padahal bot udah bilang "berhasil".
//
// Fix: cuma ada SATU state pending per chat (bukan 3 Set independen),
// dan otomatis kehapus begitu user ngirim command APAPUN (`/...`).
// Jadi gak mungkin ada 2 state nyangkut bareng lagi.
// ============================================================
const pendingAction = new Map(); // chatId -> 'skipboost' | 'unskipboost'

const menuKeyboard = {
    reply_markup: {
        inline_keyboard: [
            [{ text: '📋 Lihat Daftar Akun', callback_data: 'accounts' }],
            [{ text: '🕒 Terakhir Aktif', callback_data: 'lastactive' }],
            [
                { text: '🚀 Skip Boost (ID)', callback_data: 'skipboost' },
                { text: '↩️ Un-skip Boost (ID)', callback_data: 'unskipboost' },
            ],
        ],
    },
};

async function sendMenu(chatId) {
    // Ngirim menu baru = user "keluar" dari alur nunggu-balesan manapun.
    pendingAction.delete(chatId);
    await bot.sendMessage(
        chatId,
        `<b>Panel Admin Blue Games</b>\nPilih menu di bawah.`,
        { parse_mode: 'HTML', ...menuKeyboard }
    );
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

    if (action === 'lastactive') {
        const lastActiveSnap = await ref.child('lastActive').once('value');
        const lastActiveMap = lastActiveSnap.val() || {};

        const activeEntries = Object.entries(lastActiveMap).map(([id, ts]) => ({
            id: parseInt(id, 10),
            ts: typeof ts === 'number' ? ts : 0,
        }));
        const now = Date.now();
        const active24h = activeEntries.filter((e) => now - e.ts < 24 * 60 * 60 * 1000).length;
        let mostRecentLine = 'belum ada data (app user belum keupdate ke versi yang lapor lastActive)';
        if (activeEntries.length > 0) {
            const mostRecent = activeEntries.reduce((a, b) => (a.ts > b.ts ? a : b));
            mostRecentLine = `ID ${formatId(mostRecent.id)} (${formatRelativeTime(mostRecent.ts)})`;
        }

        await bot.sendMessage(
            chatId,
            `<b>Terakhir Aktif</b>\n\n` +
                `Aktif 24 jam terakhir: ${active24h} akun\n` +
                `Paling baru aktif: ${mostRecentLine}`,
            { parse_mode: 'HTML' }
        );
    } else if (action === 'accounts') {
        const [accountsSnap, lastActiveSnap] = await Promise.all([
            ref.child('accounts').once('value'),
            ref.child('lastActive').once('value'),
        ]);
        const accounts = accountsSnap.val() || {};
        const lastActiveMap = lastActiveSnap.val() || {};
        const entries = Object.entries(accounts);
        if (entries.length === 0) {
            await bot.sendMessage(chatId, '(belum ada akun terdaftar)');
        } else {
            const lines = entries
                .sort((a, b) => a[1] - b[1])
                .slice(0, 100)
                .map(([key, id]) => {
                    const lastActive = lastActiveMap[id];
                    return `${formatId(id)}  ${key}\n     terakhir aktif: ${formatRelativeTime(lastActive)}`;
                });
            const extra = entries.length > 100 ? `\n\n(+${entries.length - 100} lagi, gak ditampilin)` : '';
            await bot.sendMessage(chatId, `<b>Daftar Akun</b>\n\n${lines.join('\n\n')}${extra}`, { parse_mode: 'HTML' });
        }
    } else if (action === 'skipboost') {
        if (!arg) {
            pendingAction.set(chatId, 'skipboost');
            await bot.sendMessage(chatId, 'Kirim ID akun yang mau di-skip dialog boost-nya (contoh: 123 atau 000123):');
            return;
        }
        const id = parseAccountId(arg);
        if (id === null) {
            await bot.sendMessage(chatId, '⚠️ ID gak valid, harus angka. Contoh: /skipboost 123');
            return;
        }
        await ref.child(`boostSkip/${id}`).set(true);
        const verifySnap = await ref.child(`boostSkip/${id}`).once('value');
        if (verifySnap.val() === true) {
            await bot.sendMessage(chatId, `✅ Dialog boost (hitung mundur 15 detik) di-SKIP buat ID ${formatId(id)}.\n\nCatatan: di app-nya baru ke-apply dalam ±15 detik (auto-refresh) atau begitu app dibuka lagi.`);
        } else {
            await bot.sendMessage(chatId, `⚠️ Gagal verifikasi -- data ke-tulis tapi gak kebaca balik sebagai true buat ID ${formatId(id)}. Coba lagi atau cek koneksi Firebase.`);
        }
    } else if (action === 'unskipboost') {
        if (!arg) {
            pendingAction.set(chatId, 'unskipboost');
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
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    // Instance lama (dari deployment sebelumnya yang belum bener-bener
    // mati) -- diem aja, biar gak ikut bales bareng instance yang baru.
    if (!(await isCurrentInstance())) {
        console.log('⏭️ Instance ini udah gak aktif (ada instance lebih baru), skip pesan.');
        return;
    }

    const text = (msg.text || '').trim();
    console.log(`📩 Pesan masuk dari ${chatId}: "${text}"`);
    if (!text) return;

    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, `⛔ Kamu gak punya akses. Chat ID kamu: ${chatId}`);
        return;
    }

    try {
        // Kalau user ngetik COMMAND BARU (`/...`), itu artinya dia "keluar"
        // dari alur nunggu-balesan manapun yang lagi jalan -- batalin
        // pendingAction-nya duluan sebelum command baru diproses. Ini yang
        // nutup celah bug lama (state nyangkut kalau user ganti alur).
        if (text.startsWith('/')) {
            pendingAction.delete(chatId);
        } else if (pendingAction.has(chatId)) {
            // Bukan command -> ini balesan buat alur yang lagi ditunggu.
            const action = pendingAction.get(chatId);
            pendingAction.delete(chatId);
            await runAction(chatId, action, text);
            return;
        }

        if (text === '/start' || text === '/menu') {
            await sendMenu(chatId);
            return;
        }

        if (!text.startsWith('/')) {
            // Bukan command, dan gak ada alur yang lagi ditunggu -> tampilin menu.
            await sendMenu(chatId);
            return;
        }

        const [cmdRaw, ...rest] = text.split(/\s+/);
        const cmd = cmdRaw.toLowerCase().replace('/', '');
        const arg = rest.join(' ').trim();

        const knownCommands = ['accounts', 'lastactive', 'skipboost', 'unskipboost'];
        if (knownCommands.includes(cmd)) {
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

    // Sama kayak di handler message -- instance lama diem aja.
    if (!(await isCurrentInstance())) {
        console.log('⏭️ Instance ini udah gak aktif (ada instance lebih baru), skip callback.');
        return;
    }

    if (!isAuthorized(chatId)) {
        await bot.answerCallbackQuery(query.id, { text: 'Gak punya akses.', show_alert: true });
        return;
    }

    try {
        // Sama kayak command baru -- tap tombol menu manapun ngebatalin
        // alur nunggu-balesan sebelumnya (kalau ada) biar gak nyangkut.
        pendingAction.delete(chatId);
        await runAction(chatId, action, null);
        await bot.answerCallbackQuery(query.id);
    } catch (err) {
        console.error(err);
        await bot.answerCallbackQuery(query.id, { text: 'Error, cek log Railway.', show_alert: true });
    }
});

