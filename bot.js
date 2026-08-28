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
// Env var OPSIONAL (buat fitur kirim APK langsung ke bot):
//   PUBLIC_BASE_URL          -> cuma perlu diisi manual KALAU Railway belum
//                               auto-generate domain publik. Kalau di tab
//                               Settings > Networking service ini kamu udah
//                               klik "Generate Domain", BIARIN KOSONG --
//                               bot otomatis pakai domain itu sendiri.
//
// Env var OPSIONAL (buat naikin limit APK dari 20MB ke 2GB):
//   TELEGRAM_API_ID          -> daftar sekali di https://my.telegram.org/apps
//   TELEGRAM_API_HASH        -> (pasangan dari TELEGRAM_API_ID di atas)
//
// ==== FITUR: KIRIM APK LANGSUNG KE BOT ====
// Tinggal kirim file .apk sebagai attachment biasa ke chat ini (BUKAN
// command, langsung attach file). Bot bakal:
//   1) cek ukurannya
//   2) ambil APK-nya dari Telegram, TERUS DI-HOST ULANG lewat server
//      HTTP kecil yang jalan bareng bot ini (bukan simpen link asli dari
//      Telegram -- link itu cuma valid ~1 jam, kalau dipakai langsung,
//      user yang buka app lebih dari 1 jam kemudian bakal gagal download).
//      Link yang disimpen ke Firebase jadi PERMANEN, gak kedaluwarsa.
//   3) BACA LANGSUNG versionCode dari file APK-nya sendiri (pake
//      app-info-parser, TANPA admin perlu ketik angka apapun) --
//      ini yang dipake app buat nentuin apa update ini beneran lebih
//      baru dari yang lagi kepasang di HP user, jadi update gak
//      ke-trigger berulang walau link-nya statis/sama terus.
//   4) otomatis nyalain dialog update (maintenance: true) + set updateUrl
//      ke link permanen itu + latestVersionCode hasil baca otomatis tadi.
//
// ==== NAIKIN LIMIT 20MB -> 2GB (LOCAL BOT API SERVER, SATU CONTAINER) ====
// PENTING: telegram-bot-api dalam mode --local BALIKIN ABSOLUTE LOCAL PATH
// di file_path (bukan link HTTP yang bisa didownload dari luar) -- ini
// bukan bug, emang gitu desainnya (lihat dokumentasi resmi tdlib). Karena
// itu, telegram-bot-api HARUS jalan di CONTAINER YANG SAMA dengan bot ini
// (bukan service Railway terpisah), biar bot bisa baca file-nya langsung
// dari disk yang sama -- ini yang dilakuin kode di bawah (lewat
// child_process.spawn). Dockerfile khusus juga diperlukan supaya binary
// telegram-bot-api ikut ke-install di image yang sama dengan Node.js-nya.
//
// Kalau TELEGRAM_API_ID & TELEGRAM_API_HASH belum diisi, bot otomatis
// balik ke server resmi Telegram (limit tetap 20MB, tanpa proses sampingan).
// ============================================================
const { spawn } = require('child_process');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const AppInfoParser = require('app-info-parser');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

if (!BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN belum diset.');
    process.exit(1);
}

// ============================================================
// NYALAIN telegram-bot-api SEBAGAI PROSES SAMPINGAN
// (di container yang sama -- lihat penjelasan panjang di atas)
// ============================================================
const TBAPI_DIR = '/app/tbapi-data';
const TBAPI_PORT = 8081;
let localApiReady = false;

if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
    if (!fs.existsSync(TBAPI_DIR)) fs.mkdirSync(TBAPI_DIR, { recursive: true });

    const tbapi = spawn('telegram-bot-api', [
        `--api-id=${process.env.TELEGRAM_API_ID}`,
        `--api-hash=${process.env.TELEGRAM_API_HASH}`,
        '--local',
        `--http-port=${TBAPI_PORT}`,
        `--dir=${TBAPI_DIR}`,
    ]);

    tbapi.stdout.on('data', (d) => console.log(`[tbapi] ${d}`.trim()));
    tbapi.stderr.on('data', (d) => console.log(`[tbapi] ${d}`.trim()));
    tbapi.on('exit', (code) => {
        console.error(`⚠️ telegram-bot-api mati (exit code ${code}). Restart container buat nyalain ulang.`);
    });
    tbapi.on('error', (err) => {
        console.error(`⚠️ Gagal jalanin telegram-bot-api: ${err.message}`);
    });

    localApiReady = true;
    console.log('🚀 telegram-bot-api dijalanin sebagai proses sampingan (satu container)...');
} else {
    console.log('⚠️ TELEGRAM_API_ID / TELEGRAM_API_HASH belum diset -- pakai server resmi Telegram (limit tetap 20MB).');
}

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
});
const db = admin.database();

// Limit RESMI dari server Telegram buat method getFile (bukan dari
// library/bot ini). Telegram ngizinin KIRIM file sampe 50MB ke chat, tapi
// bot cuma bisa DOWNLOAD BALIK file yang <= 20MB lewat server RESMI mereka
// -- dua limit yang beda. Begitu local Bot API server nyala, limit ini
// naik jadi 2GB.
const MAX_BOT_DOWNLOAD_BYTES_OFFICIAL = 20 * 1024 * 1024;
const MAX_BOT_DOWNLOAD_BYTES_LOCAL = 2000 * 1024 * 1024;

// Kalau proses sampingan telegram-bot-api berhasil dinyalain, bot connect
// ke situ (lewat localhost, sesama proses di container yang sama) buat
// naikin limit download APK dari 20MB ke 2GB.
const LOCAL_API_URL = localApiReady ? `http://localhost:${TBAPI_PORT}` : null;
const MAX_BOT_DOWNLOAD_BYTES = LOCAL_API_URL ? MAX_BOT_DOWNLOAD_BYTES_LOCAL : MAX_BOT_DOWNLOAD_BYTES_OFFICIAL;

const bot = new TelegramBot(BOT_TOKEN, {
    polling: true,
    ...(LOCAL_API_URL ? { baseApiUrl: LOCAL_API_URL } : {}),
});
if (LOCAL_API_URL) {
    console.log(`📡 Pakai Local Bot API Server: ${LOCAL_API_URL} (limit download naik ke ${(MAX_BOT_DOWNLOAD_BYTES_LOCAL / 1024 / 1024).toFixed(0)}MB)`);
} else {
    console.log('📡 Pakai server resmi Telegram (limit download tetap 20MB)');
}
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
    { command: 'status', description: 'Lihat status dialog update & statistik akun' },
    { command: 'update', description: 'Lihat info APK update yang lagi aktif' },
    { command: 'on', description: 'Aktifkan dialog update' },
    { command: 'off', description: 'Matikan dialog update' },
    { command: 'accounts', description: 'Lihat daftar akun + terakhir aktif' },
    { command: 'skipboost', description: 'Skip dialog boost 15 detik buat 1 ID' },
    { command: 'unskipboost', description: 'Balikin dialog boost buat 1 ID' },
    { command: 'boostskiplist', description: 'Lihat daftar ID yang di-skip boost-nya' },
    { command: 'checkboost', description: 'Cek status skip-boost 1 ID langsung dari database' },
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
            [{ text: '📊 Status', callback_data: 'status' }],
            [{ text: '🆕 Info Update Terakhir', callback_data: 'update' }],
            [
                { text: '✅ Aktifkan Dialog', callback_data: 'on' },
                { text: '⛔ Matikan Dialog', callback_data: 'off' },
            ],
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
    // Ngirim menu baru = user "keluar" dari alur nunggu-balesan manapun.
    pendingAction.delete(chatId);
    const limitMb = (MAX_BOT_DOWNLOAD_BYTES / 1024 / 1024).toFixed(0);
    await bot.sendMessage(
        chatId,
        `<b>Panel Admin Blue Games</b>\nPilih menu di bawah, atau kirim file .apk langsung ke sini buat update otomatis (maks ${limitMb}MB).`,
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

    if (action === 'status') {
        const [counterSnap, updateSnap, lastActiveSnap] = await Promise.all([
            ref.child('counter').once('value'),
            ref.child('updateStatus').once('value'),
            ref.child('lastActive').once('value'),
        ]);
        const counter = counterSnap.val() || 0;
        const status = updateSnap.val() || { maintenance: false, updateUrl: '' };
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
            `<b>Status</b>\n\n` +
                `Total akun: ${formatId(counter)} (${counter})\n` +
                `Aktif 24 jam terakhir: ${active24h} akun\n` +
                `Paling baru aktif: ${mostRecentLine}\n\n` +
                `Dialog update: ${status.maintenance ? 'AKTIF' : 'MATI'}\n` +
                `Link update: ${status.updateUrl || '(belum di-set)'}`,
            { parse_mode: 'HTML' }
        );
    } else if (action === 'update') {
        const updateSnap = await ref.child('updateStatus').once('value');
        const status = updateSnap.val() || { maintenance: false, updateUrl: '' };

        if (!status.updateUrl) {
            await bot.sendMessage(chatId, '(belum ada update yang di-set. Kirim file .apk langsung ke chat ini)');
            return;
        }

        const sizeLine = status.fileSize ? `${(status.fileSize / 1024 / 1024).toFixed(1)}MB` : '(gak diketahui)';
        const uploadedLine = status.uploadedAt ? formatRelativeTime(status.uploadedAt) : '(gak diketahui)';

        await bot.sendMessage(
            chatId,
            `<b>Update Aktif Sekarang</b>\n\n` +
                `Nama file: ${status.fileName || '(gak ada nama)'}\n` +
                `Ukuran: ${sizeLine}\n` +
                `versionCode: ${status.latestVersionCode || '(gak diketahui)'}\n` +
                `Diupload: ${uploadedLine}\n` +
                `Dialog update: ${status.maintenance ? 'AKTIF (bakal ke-download otomatis di app user)' : 'MATI (APK ini nganggur, gak dikirim ke user manapun)'}\n\n` +
                `Link: ${status.updateUrl}`,
            { parse_mode: 'HTML' }
        );
    } else if (action === 'on') {
        await ref.child('updateStatus/maintenance').set(true);
        await bot.sendMessage(chatId, '✅ Dialog update sekarang AKTIF di aplikasi.');
    } else if (action === 'off') {
        await ref.child('updateStatus/maintenance').set(false);
        await bot.sendMessage(chatId, '✅ Dialog update sekarang DIMATIKAN.');
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
    } else if (action === 'checkboost') {
        if (!arg) {
            await bot.sendMessage(chatId, 'Kirim: /checkboost <id>\nContoh: /checkboost 1');
            return;
        }
        const id = parseAccountId(arg);
        if (id === null) {
            await bot.sendMessage(chatId, '⚠️ ID gak valid, harus angka.');
            return;
        }
        const snap = await ref.child(`boostSkip/${id}`).once('value');
        const raw = snap.val();
        await bot.sendMessage(
            chatId,
            `Path: boostSkip/${id}\n` +
                `Nilai di database: ${JSON.stringify(raw)}\n` +
                `Status: ${raw === true ? '✅ DI-SKIP' : '⛔ TIDAK di-skip (dialog tetap tampil)'}`
        );
    }
}

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
const APK_PATH = path.join(DOWNLOAD_DIR, 'latest.apk');

// Dipakai kalau LOCAL_API_URL gak aktif (server resmi Telegram) --
// download lewat HTTPS biasa dari link file resmi Telegram.
function downloadToFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        https
            .get(url, (res) => {
                if (res.statusCode !== 200) {
                    file.close();
                    fs.unlink(destPath, () => {});
                    reject(new Error(`HTTP ${res.statusCode} pas download dari Telegram`));
                    return;
                }
                res.pipe(file);
                file.on('finish', () => file.close(resolve));
            })
            .on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
    });
}

function getPublicBaseUrl() {
    // Railway otomatis nyediain domain publiknya di env var ini KALAU
    // "Generate Domain" udah diaktifin di tab Settings > Networking service
    // ini. PUBLIC_BASE_URL cuma dipakai sebagai fallback manual.
    if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
    if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
    return null;
}

// Server HTTP kecil buat nyajiin APK yang udah didownload, biar linknya
// STABIL & GAK KEDALUWARSA -- beda sama link file:// bawaan Telegram yang
// cuma valid ~1 jam. User bisa buka app-nya kapan aja (bahkan berhari-hari
// setelah admin kirim APK-nya ke bot), link ini tetap kepake.
//
// CATATAN: link ini SENGAJA statis ("/latest.apk") -- filenya yang ditimpa
// tiap ada update baru, bukan linknya yang berubah. Makanya app di sisi
// Android JANGAN pake link ini buat nentuin "ada update baru apa enggak"
// (linknya emang selalu sama) -- app harus bandingin `latestVersionCode`
// (dibaca otomatis di bawah) sama versionCode yang lagi kepasang.
const PORT = process.env.PORT || 3000;
http
    .createServer((req, res) => {
        if (req.url === '/latest.apk' && fs.existsSync(APK_PATH)) {
            res.writeHead(200, {
                'Content-Type': 'application/vnd.android.package-archive',
                'Content-Length': fs.statSync(APK_PATH).size,
            });
            fs.createReadStream(APK_PATH).pipe(res);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    })
    .listen(PORT, () => console.log(`🌐 Static server APK jalan di port ${PORT}`));

// ============================================================
// BACA versionCode LANGSUNG DARI FILE APK -- admin GAK PERLU KETIK
// ANGKA APAPUN. Ini yang bikin seluruh alur update jadi 100% otomatis:
// admin cuma kirim file .apk ke chat, sisanya (hosting + baca versi +
// tulis ke Firebase) semua kejadian sendiri di sini.
// ============================================================
function readApkVersionCode(apkPath) {
    return new Promise((resolve, reject) => {
        const parser = new AppInfoParser(apkPath);
        parser
            .parse()
            .then((result) => {
                // app-info-parser balikin versionCode sebagai string/number
                // tergantung versi APK -- dipaksa jadi Number biar konsisten
                // dibandingin sama versionCode di app Android (Long).
                const versionCode = Number(result.versionCode);
                if (!versionCode || Number.isNaN(versionCode)) {
                    reject(new Error('versionCode gak kebaca dari APK (hasil parse kosong/invalid)'));
                    return;
                }
                resolve({ versionCode, versionName: result.versionName || null });
            })
            .catch(reject);
    });
}

async function handleApkUpload(msg) {
    const chatId = msg.chat.id;
    if (!isAuthorized(chatId)) {
        bot.sendMessage(chatId, `⛔ Kamu gak punya akses. Chat ID kamu: ${chatId}`);
        return;
    }

    const doc = msg.document;
    const fileName = doc.file_name || 'update.apk';
    if (!fileName.toLowerCase().endsWith('.apk')) {
        await bot.sendMessage(chatId, '⚠️ File yang dikirim bukan .apk, diabaikan.');
        return;
    }

    if (doc.file_size && doc.file_size > MAX_BOT_DOWNLOAD_BYTES) {
        const limitMb = (MAX_BOT_DOWNLOAD_BYTES / 1024 / 1024).toFixed(0);
        await bot.sendMessage(
            chatId,
            `⚠️ File-nya ${(doc.file_size / 1024 / 1024).toFixed(1)}MB -- di atas limit ${limitMb}MB yang aktif sekarang.\n\n` +
                (LOCAL_API_URL
                    ? `Local Bot API Server udah aktif tapi tetep kelebihan -- ukuran ini beneran di luar batas 2GB.`
                    : `Ini limit dari server RESMI Telegram (bot cuma bisa download balik file <= 20MB, walau kirimnya boleh sampe 50MB). Set env var TELEGRAM_API_ID & TELEGRAM_API_HASH buat naikin limitnya sampe 2GB.`)
        );
        return;
    }

    const publicBase = getPublicBaseUrl();
    if (!publicBase) {
        await bot.sendMessage(
            chatId,
            '⚠️ Domain publik Railway belum aktif buat service ini. Aktifin dulu di tab Settings > Networking > "Generate Domain", atau set env var PUBLIC_BASE_URL manual -- baru kirim ulang APK-nya.'
        );
        return;
    }

    try {
        await bot.sendMessage(chatId, `⏳ Mengunduh ${fileName} (${(doc.file_size / 1024 / 1024).toFixed(1)}MB) dari Telegram...`);

        if (LOCAL_API_URL) {
            // Mode local (satu container dengan telegram-bot-api): file_path
            // dari getFile udah berupa ABSOLUTE PATH DI DISK CONTAINER INI
            // SENDIRI -- tinggal di-copy langsung, gak perlu request HTTP lagi
            // (itu emang gak didukung lagi di mode --local, lihat komentar
            // panjang di bagian atas file ini).
            const file = await bot.getFile(doc.file_id);
            await fs.promises.copyFile(file.file_path, APK_PATH);
        } else {
            // Mode server resmi Telegram: file_path masih berupa path relatif
            // yang perlu diubah jadi link HTTPS buat didownload.
            const fileLink = await bot.getFileLink(doc.file_id);
            await downloadToFile(fileLink, APK_PATH);
        }

        // Baca versionCode langsung dari file APK yang baru kedownload --
        // GAGAL DI SINI = STOP, jangan lanjut nulis ke Firebase sama sekali.
        // Lebih aman APK lama tetap aktif daripada nulis data update yang
        // versionCode-nya gak jelas (bisa bikin app user gak pernah keupdate
        // ATAU malah gak mau install sama sekali).
        let versionInfo;
        try {
            versionInfo = await readApkVersionCode(APK_PATH);
        } catch (err) {
            console.error('Gagal baca versionCode APK:', err);
            await bot.sendMessage(
                chatId,
                `⚠️ File udah kedownload tapi GAGAL baca versionCode-nya (${err.message}).\n` +
                    `Firebase TIDAK diupdate -- update yang lagi aktif sekarang (kalau ada) tetap dipakai. ` +
                    `Cek lagi APK-nya, mungkin corrupt atau bukan APK valid.`
            );
            return;
        }

        const publicUrl = `${publicBase}/latest.apk`;
        await db.ref('updateStatus').set({
            maintenance: true,
            updateUrl: publicUrl,
            latestVersionCode: versionInfo.versionCode,
            latestVersionName: versionInfo.versionName,
            fileName,
            fileSize: doc.file_size || 0,
            uploadedAt: Date.now(),
        });

        await bot.sendMessage(
            chatId,
            `✅ APK diterima & disimpan di server.\n` +
                `versionCode terdeteksi: ${versionInfo.versionCode}` +
                (versionInfo.versionName ? ` (v${versionInfo.versionName})` : '') +
                `\nDialog update AKTIF, link permanen:\n${publicUrl}`
        );
    } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, `⚠️ Gagal proses APK: ${err.message}`);
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

    // Kirim file .apk sebagai attachment (bukan command) -> alur khusus.
    if (msg.document) {
        await handleApkUpload(msg);
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

        const knownCommands = ['status', 'update', 'on', 'off', 'accounts', 'skipboost', 'unskipboost', 'boostskiplist', 'checkboost'];
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
     
