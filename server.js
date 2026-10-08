const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Minimal .env loader (no dependency) ──────────────────────────────────────
// Reads KEY=VALUE lines from ./.env into process.env (without overwriting vars
// already set by the environment / docker-compose). Supports # comments and
// optional surrounding quotes.
(function loadDotEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            let val   = line.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            } else {
                // Allow inline comments in unquoted values: KEY=value # note
                const hash = val.indexOf(' #');
                if (hash !== -1) val = val.slice(0, hash).trim();
            }
            if (!(key in process.env)) process.env[key] = val;
        }
        console.log('[env] .env loaded');
    } catch (e) {
        console.warn('[env] could not load .env:', e.message);
    }
})();

const { TTSManager } = require('./src/TTS.js');
const { Auth }       = require('./src/auth-server.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

// All user data (uploads, config.json, users, tokens, TTS queue/audio) lives in
// DATA_DIR, completely separate from the application files. Updating the app
// (replacing server.js / src / html / css) never touches it.
const DATA_DIR    = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONF_DIR    = path.join(DATA_DIR, 'conf');

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyMissing(src, dest) {
    if (!fs.existsSync(src)) return 0;
    let n = 0;
    ensureDir(dest);
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dest, entry.name);
        if (entry.isDirectory()) n += copyMissing(s, d);
        else if (!fs.existsSync(d)) { fs.copyFileSync(s, d); n++; }
    }
    return n;
}

// One-time, non-destructive import of the legacy <app>/conf and <app>/uploads.
ensureDir(UPLOADS_DIR);
ensureDir(CONF_DIR);
if (DATA_DIR !== ROOT) {
    const moved = copyMissing(path.join(ROOT, 'conf'), CONF_DIR) + copyMissing(path.join(ROOT, 'uploads'), UPLOADS_DIR);
    if (moved) console.log(`[data] copied ${moved} legacy file(s) into ${DATA_DIR}`);
}
console.log('[data] using data directory:', DATA_DIR);

const auth = new Auth({ dataDir: DATA_DIR, rootDir: ROOT });
if (!auth.configured) console.warn('[auth] TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET missing — nobody can log in!');
if (!auth.adminLogins.length && !auth.list().some(u => u.role === 'admin')) {
    console.warn('[auth] No administrator exists. Set ADMIN_TWITCH_LOGINS=<your twitch login> in .env.');
}

/** Strip characters that could cause path traversal or filesystem issues. */
function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function sendJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

const MAX_JSON_BYTES   = 5 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => { if (body.length < MAX_JSON_BYTES) body += c; });
        req.on('end', () => resolve(body));
    });
}

/** Collect a binary upload; sends 413 and returns null when over the size cap. */
function readUpload(req, res) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        let aborted = false;
        req.on('data', chunk => {
            if (aborted) return;
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
                aborted = true;
                sendJSON(res, 413, { ok: false, error: 'File too large (max 25 MB)' });
                resolve(null);
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!aborted) resolve(Buffer.concat(chunks)); });
    });
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const FONT_EXT  = new Set(['.ttf', '.otf', '.woff', '.woff2']);

function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.ttf':  'font/ttf',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.mp3':  'audio/mpeg',
};

// ── SSE client registry ──────────────────────────────────────────────────────
// Overlays open an EventSource to /api/tts/stream?channel=<name>. Each client
// is tagged with its channel; events are only pushed to that channel's clients.
// Clients that connected WITHOUT a channel receive everything (legacy URLs).
const sseClients = new Set();

function broadcast(channel, payload) {
    const data = `data: ${JSON.stringify({ ...payload, channel })}\n\n`;
    for (const res of sseClients) {
        if (res._ttsChannel && channel && res._ttsChannel !== channel) continue;
        try { res.write(data); } catch { /* dropped on next cleanup */ }
    }
}

// ── TTS manager: one engine (OAuth + EventSub + queue + settings) per user ──
const tts = new TTSManager({ root: DATA_DIR, broadcast, getAccounts: () => auth.accounts() });
tts.boot().catch(e => console.error('[tts] boot error:', e.message));

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname;

    // ═══════════════════════════════════════════════════════════════════════
    //  Auth (Twitch login, sessions, admin)
    // ═══════════════════════════════════════════════════════════════════════

    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
        return sendJSON(res, 403, { ok: false, error: 'Cross-origin request blocked' });
    }

    /** Logged-in + approved user, or sends 401 and returns null. */
    const requireUser = () => {
        const u = auth.currentUser(req);
        if (!u) sendJSON(res, 401, { ok: false, error: 'Not logged in' });
        return u;
    };
    const requireAdmin = () => {
        const u = requireUser();
        if (u && u.role !== 'admin') { sendJSON(res, 403, { ok: false, error: 'Administrator only' }); return null; }
        return u;
    };
    /** Channel the request may act on: own channel; admins may pick another via ?channel=. */
    const resolveChannel = (u, wanted) => {
        const own = auth.channelOf(u);
        const w = String(wanted || '').toLowerCase().trim();
        if (!w || w === own) return own;
        if (u.role === 'admin') return w;
        sendJSON(res, 403, { ok: false, error: 'You can only manage your own channel' });
        return null;
    };
    /** Image folders a user may write to / delete from: <channel> and tts-gifs-<channel>. */
    const imageDirAllowed = (u, dir) => {
        if (u.role === 'admin') return true;
        const own = auth.channelOf(u);
        return dir === own || dir === 'tts-gifs-' + own;
    };

    if (req.method === 'GET' && pathname === '/auth/twitch/login') { auth.beginLogin(res); return; }
    if (req.method === 'GET' && pathname === '/auth/twitch/callback') {
        await auth.handleCallback(req, res, urlObj.searchParams);
        return;
    }
    if (req.method === 'POST' && pathname === '/auth/logout') {
        auth.destroySession(req, res);
        return sendJSON(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/me') {
        const u = requireUser(); if (!u) return;
        return sendJSON(res, 200, auth.me(u));
    }
    if (req.method === 'POST' && pathname === '/api/me/token') {
        const u = requireUser(); if (!u) return;
        let data; try { data = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { ok: false, error: 'Bad JSON' }); }
        auth.setOwnToken(u.id, data.token);
        return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
        const u = requireAdmin(); if (!u) return;
        return sendJSON(res, 200, { ok: true, me: u.id, users: auth.list() });
    }
    if (pathname.startsWith('/api/admin/users') && req.method === 'POST') {
        const admin = requireAdmin(); if (!admin) return;
        let data; try { data = JSON.parse(await readBody(req)); } catch { return sendJSON(res, 400, { ok: false, error: 'Bad JSON' }); }
        try {
            res.once('finish', () => tts.syncAccess().catch(e => console.error('[tts] sync error:', e.message)));
            if (pathname === '/api/admin/users')              return sendJSON(res, 200, { ok: true, user: auth.addByLogin(data.login) });
            if (pathname === '/api/admin/users/update')       return sendJSON(res, 200, { ok: true, user: auth.update(data.id, data, admin.id) });
            if (pathname === '/api/admin/users/delete')       { auth.remove(data.id, admin.id); return sendJSON(res, 200, { ok: true }); }
        } catch (e) {
            return sendJSON(res, 400, { ok: false, error: e.message });
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  TTS API
    // ═══════════════════════════════════════════════════════════════════════

    // Resolve the engine for channel-scoped routes (?channel=<name>).
    const ttsEngine = () => tts.resolveEngine(urlObj.searchParams.get('channel'));

    // ── SSE stream the overlay subscribes to ────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/stream') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection':    'keep-alive',
        });
        const ch = (urlObj.searchParams.get('channel') || '').toLowerCase().trim();
        res._ttsChannel = ch || null; // null = legacy client, receives everything
        res.write('retry: 3000\n\n');
        res.write(`data: ${JSON.stringify({ type: 'hello', channel: ch || null })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
    }

    // ── Status (config page polls this) ──────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/status') {
        const eng = ttsEngine();
        if (!eng) return sendJSON(res, 400, { error: 'channel required (?channel=<name>)' });
        sendJSON(res, 200, eng.status());
        return;
    }

    // ── Voice list for the dropdowns (shared across all channels) ────────────
    if (req.method === 'GET' && pathname === '/api/tts/voices') {
        if (tts.voices.length === 0) await tts.loadVoices();
        sendJSON(res, 200, { voices: tts.voices });
        return;
    }

    // ── Debug: resolve a {VoiceName} tag — GET /api/tts/voices/resolve?text=... ─
    if (req.method === 'GET' && pathname === '/api/tts/voices/resolve') {
        const text = urlObj.searchParams.get('text') || '';
        if (tts.voices.length === 0) await tts.loadVoices();
        const eng = ttsEngine();
        if (!eng) return sendJSON(res, 400, { error: 'channel required (?channel=<name>)' });
        const { voiceId, cleanText } = eng.resolveVoiceFromText(text, eng.defaultVoiceId());
        const voiceName = eng.voiceNameFromId(voiceId);
        sendJSON(res, 200, {
            input: text,
            voiceId,
            voiceName,
            cleanText,
            allVoices: tts.voices.map(v => v.name),
        });
        return;
    }

    // Appearance for the visual overlay (tts.html reads this)
    if (req.method === 'GET' && pathname === '/api/tts/appearance') {
        const eng = ttsEngine();
        sendJSON(res, 200, eng ? eng.appearance : {});
        return;
    }

    // Recent requests for the config "Queue" view
    if (req.method === 'GET' && pathname === '/api/tts/queue') {
        const eng = ttsEngine();
        sendJSON(res, 200, { requests: eng ? eng.recentRequests() : [] });
        return;
    }

    // Config page tells overlays the appearance changed (live refresh)
    if (req.method === 'POST' && pathname === '/api/tts/appearance/notify') {
        const u = requireUser(); if (!u) return;
        const ch = resolveChannel(u, urlObj.searchParams.get('channel')); if (!ch) return;
        broadcast(ch, { type: 'appearance' });
        sendJSON(res, 200, { ok: true });
        return;
    }

    // ── Begin Twitch OAuth (redirect the browser to Twitch) ──────────────────
    if (req.method === 'GET' && pathname === '/api/tts/oauth/start') {
        const u = auth.currentUser(req);
        if (!u) { res.writeHead(302, { Location: '/index.html' }); res.end(); return; }
        const ch = resolveChannel(u, urlObj.searchParams.get('channel')); if (!ch) return;
        const eng = tts.resolveEngine(ch);
        if (!eng) { res.writeHead(400); res.end('This channel has no TTS access'); return; }
        const url = eng.buildAuthUrl();
        if (!url) { res.writeHead(500); res.end('TWITCH_CLIENT_ID not configured in .env'); return; }
        res.writeHead(302, { Location: url });
        res.end();
        return;
    }

    // ── Force EventSub reconnect (no OAuth needed if already authorized) ───────
    if (req.method === 'POST' && pathname === '/api/tts/eventsub/connect') {
        const u = requireUser(); if (!u) return;
        const ch = resolveChannel(u, urlObj.searchParams.get('channel')); if (!ch) return;
        const eng = tts.resolveEngine(ch);
        if (!eng) return sendJSON(res, 400, { ok: false, error: 'This channel has no TTS access' });
        if (!eng.tokens || !eng.tokens.user_id) {
            sendJSON(res, 400, { ok: false, error: 'Not authorized — use the Connect Twitch button first.' });
            return;
        }
        eng.forceReconnect().catch(e => console.error('[eventsub reconnect]', e.message));
        sendJSON(res, 200, { ok: true, message: 'Reconnecting EventSub…' });
        return;
    }

    // ── List channel point rewards (for picking redeem IDs in the UI) ────────
    if (req.method === 'GET' && pathname === '/api/tts/rewards') {
        const u = requireUser(); if (!u) return;
        const ch = resolveChannel(u, urlObj.searchParams.get('channel')); if (!ch) return;
        const eng = tts.resolveEngine(ch);
        if (!eng) return sendJSON(res, 400, { ok: false, error: 'This channel has no TTS access' });
        try {
            const rewards = await eng.listCustomRewards();
            sendJSON(res, 200, { ok: true, rewards });
        } catch (e) {
            sendJSON(res, 400, { ok: false, error: e.message });
        }
        return;
    }

    // ── OAuth callback ───────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/oauth/callback') {
        const code  = urlObj.searchParams.get('code');
        const state = urlObj.searchParams.get('state');
        const result = await tts.handleOAuthCallback(code, state);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (result.ok) {
            res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#36363f;color:#eee;padding:40px">
                <h2>&#10003; Connected as ${result.login}</h2>
                <p>EventSub is starting. You can close this tab and return to the config page.</p>
                <script>setTimeout(()=>window.close(),2500)</script></body>`);
        } else {
            res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#36363f;color:#eee;padding:40px">
                <h2>&#10007; Authorization failed</h2><p>${result.error}</p>
                <p><a style="color:#9146ff" href="/api/tts/oauth/start">Try again</a></p></body>`);
        }
        return;
    }

    // ── Manual test / send (logged-in user with TTS access) ──────────────────
    //   POST body: { text, voice?, kind?, reward? }
    if (req.method === 'POST' && pathname === '/api/tts/test') {
        const acc = requireUser(); if (!acc) return;
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body); } catch { return sendJSON(res, 400, { ok: false, error: 'Bad JSON' }); }

        if (!acc.ttsAccess)    return sendJSON(res, 403, { ok: false, error: 'This account does not have TTS access' });
        if (!data.text)        return sendJSON(res, 400, { ok: false, error: 'No text' });

        // The test always goes to the ACCOUNT's own channel engine.
        const eng = tts.engineFor(auth.channelOf(acc));
        const userName = acc.displayName || acc.login;
        const kind = String(data.kind || 'manual').toLowerCase() === 'redeem' ? 'redeem' : 'manual';
        const meta = kind === 'redeem'
            ? { kind: 'redeem', user: userName, reward: data.reward || 'Test Redeem', rewardId: 'test-redeem-single' }
            : { kind: 'manual', user: userName };
        eng.enqueue(data.text, data.voice, meta);
        sendJSON(res, 200, { ok: true, queueLength: eng.queue.length });
        return;
    }

    // ── Test redeem set (logged-in user with TTS access) ───────────────────
    if (req.method === 'POST' && pathname === '/api/tts/test-redeems') {
        const acc = requireUser(); if (!acc) return;
        if (!acc.ttsAccess) return sendJSON(res, 403, { ok: false, error: 'This account does not have TTS access' });

        const eng = tts.engineFor(auth.channelOf(acc));
        const redeemVoice = (eng.config && eng.config.redeems && eng.config.redeems.voice) || '';
        const samples = [
            { user: 'Basti',  reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Das ist ein Parser-Test mit strict braces.' },
            { user: 'Tuubaa', reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Hallo zusammen, Redeem Nummer zwei.' },
            { user: 'Chat',   reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Vielen Dank fuers Zuschauen!' },
        ];

        samples.forEach(s => {
            eng.enqueue(s.message, redeemVoice, {
                kind: 'redeem',
                user: s.user,
                reward: s.reward,
                rewardId: 'test-redeem',
            });
        });

        sendJSON(res, 200, { ok: true, added: samples.length, queueLength: eng.queue.length });
        return;
    }

    // ── Overlay reports a clip finished playing (releases the queue) ─────────
    if (req.method === 'POST' && pathname === '/api/tts/done') {
        const eng = ttsEngine();
        if (eng) eng.notifyPlaybackDone();
        else tts.engines.forEach(e => e.notifyPlaybackDone()); // legacy overlay without ?channel
        sendJSON(res, 200, { ok: true });
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Config / upload API (login required, limited to the user's own channel)
    // ═══════════════════════════════════════════════════════════════════════

    if (req.method === 'POST' && pathname === '/api/save-config') {
        const u = requireUser(); if (!u) return;
        const body = await readBody(req);
        try {
            const incoming = JSON.parse(body);
            const ch = auth.channelOf(u);
            const file = path.join(CONF_DIR, 'config.json');
            let current = {};
            try { current = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first save */ }
            if (!current.config)  current.config  = {};
            if (!current.presets) current.presets = {};
            const flatTts = current.tts && (current.tts.bits || current.tts.appearance || current.tts.defaultVoice !== undefined);
            if (!current.tts || flatTts) current.tts = {};

            // Only this user's own channel entries are taken from the request.
            if (incoming.config  && incoming.config[ch]  !== undefined) current.config[ch]  = incoming.config[ch];
            if (incoming.presets && incoming.presets[ch] !== undefined) current.presets[ch] = incoming.presets[ch];
            if (incoming.tts     && incoming.tts[ch]     !== undefined && u.ttsAccess) current.tts[ch] = incoming.tts[ch];

            fs.writeFileSync(file, JSON.stringify(current, null, 4), 'utf8');
            sendJSON(res, 200, { ok: true });
            console.log(`[save-config] ${ch} saved by ${u.login}`);
        } catch (e) {
            console.error('[save-config] error:', e.message);
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/upload/image') {
        const u = requireUser(); if (!u) return;
        const channel  = sanitizeName((urlObj.searchParams.get('channel') || 'default').toLowerCase());
        if (!imageDirAllowed(u, channel)) return sendJSON(res, 403, { ok: false, error: 'You can only upload to your own channel' });
        const filename = sanitizeName(decodeURIComponent(req.headers['x-filename'] || 'image.png'));
        if (!IMAGE_EXT.has(path.extname(filename).toLowerCase())) return sendJSON(res, 400, { ok: false, error: 'Unsupported image type' });
        const data = await readUpload(req, res); if (!data) return;
        try {
            const dir = path.join(UPLOADS_DIR, 'images', channel);
            ensureDir(dir);
            fs.writeFileSync(path.join(dir, filename), data);
            const urlPath = `/uploads/images/${channel}/${filename}`;
            sendJSON(res, 200, { ok: true, url: urlPath });
            console.log('[upload] image saved:', urlPath);
        } catch (e) {
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/delete/image') {
        const u = requireUser(); if (!u) return;
        const body = await readBody(req);
        try {
            const { url } = JSON.parse(body);
            const m = /^\/uploads\/images\/([^/]+)\/([^/]+)$/.exec(url || '');
            if (!m) return sendJSON(res, 400, { ok: false, error: 'Invalid path' });
            if (!imageDirAllowed(u, m[1])) return sendJSON(res, 403, { ok: false, error: 'Forbidden' });
            const target = path.join(UPLOADS_DIR, 'images', sanitizeName(m[1]), sanitizeName(m[2]));
            if (fs.existsSync(target)) fs.unlinkSync(target);
            sendJSON(res, 200, { ok: true });
            console.log('[delete] image removed:', url);
        } catch (e) {
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/upload/font') {
        const u = requireUser(); if (!u) return;
        const filename = sanitizeName(decodeURIComponent(req.headers['x-filename'] || 'font.ttf'));
        if (!FONT_EXT.has(path.extname(filename).toLowerCase())) return sendJSON(res, 400, { ok: false, error: 'Unsupported font type' });
        const data = await readUpload(req, res); if (!data) return;
        try {
            const dir = path.join(UPLOADS_DIR, 'fonts');
            ensureDir(dir);
            fs.writeFileSync(path.join(dir, filename), data);
            const urlPath = `/uploads/fonts/${filename}`;
            sendJSON(res, 200, { ok: true, url: urlPath });
            console.log('[upload] font saved:', urlPath);
        } catch (e) {
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    // ── Static file serving (explicit whitelist) ─────────────────────────────
    //   /uploads/**         -> <DATA_DIR>/uploads   (public: OBS overlays load these)
    //   /conf/config.json   -> <DATA_DIR>/conf      (public: the overlay reads its style)
    //   /index.html, /html, /css, /src -> app files
    //   everything else (users.json, tokens, .env, server.js, ...) is NOT served.
    let urlPath = pathname;
    if (urlPath === '/') urlPath = '/index.html';
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

    let baseDir = null;
    if (urlPath.startsWith('/uploads/'))         baseDir = UPLOADS_DIR;
    else if (urlPath === '/conf/config.json')    baseDir = CONF_DIR;
    else if (urlPath === '/index.html' || /^\/(html|css|src)\//.test(urlPath)) baseDir = ROOT;

    let decoded = urlPath;
    try { decoded = decodeURIComponent(urlPath); } catch { /* keep raw */ }
    let filePath = null;
    if (baseDir) {
        const rel = baseDir === UPLOADS_DIR ? decoded.slice('/uploads/'.length)
                  : baseDir === CONF_DIR    ? 'config.json'
                  : decoded.slice(1);
        filePath = path.normalize(path.join(baseDir, rel));
        if (!filePath.startsWith(baseDir + path.sep) || (baseDir === ROOT && /(^|[\\/])auth-server\.js$/.test(filePath))) filePath = null;
    }
    if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found: ' + urlPath);
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + urlPath);
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
        // Uploaded files are user content: never let them run scripts (e.g. SVG).
        if (baseDir === UPLOADS_DIR) headers['Content-Security-Policy'] = 'sandbox';
        res.writeHead(200, headers);
        res.end(data);
    });
});
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        console.error(`\n  Port ${PORT} is already in use — the server is probably already running.`);
        console.error(`  Open http://localhost:${PORT}/html/config.html in your browser.\n`);
    } else {
        console.error('Server error:', e.message);
    }
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  Twitch Chat Overlay server started');
    console.log('  ──────────────────────────────────────────────────');
    console.log(`  Startpage:   http://localhost:${PORT}/index.html`);
    console.log(`  Config:      http://localhost:${PORT}/html/config.html`);
    console.log(`  TTS connect: http://localhost:${PORT}/api/tts/oauth/start`);
    console.log('  ──────────────────────────────────────────────────');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
});
