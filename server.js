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

const { TTSEngine } = require('./src/TTS.js');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Strip characters that could cause path traversal or filesystem issues. */
function sanitizeName(name) {
    return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function sendJSON(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
}

function readBody(req) {
    return new Promise((resolve) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => resolve(body));
    });
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
// The overlay (chat.html) opens an EventSource to /api/tts/stream. We keep the
// response objects here and write events to all of them when audio is ready.
const sseClients = new Set();

function broadcast(payload) {
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try { res.write(data); } catch { /* dropped on next cleanup */ }
    }
}

// ── TTS engine ───────────────────────────────────────────────────────────────
const tts = new TTSEngine({ root: ROOT, broadcast });
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
    //  TTS API
    // ═══════════════════════════════════════════════════════════════════════

    // ── SSE stream the overlay subscribes to ────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/stream') {
        res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection':    'keep-alive',
        });
        res.write('retry: 3000\n\n');
        res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
        req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
        return;
    }

    // ── Status (config page polls this) ──────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/status') {
        sendJSON(res, 200, tts.status());
        return;
    }

    // ── Voice list for the dropdowns ─────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/api/tts/voices') {
        if (tts.voices.length === 0) await tts.loadVoices();
        sendJSON(res, 200, { voices: tts.voices });
        return;
    }

    // ── Debug: resolve a {VoiceName} tag — GET /api/tts/voices/resolve?text=... ─
    if (req.method === 'GET' && pathname === '/api/tts/voices/resolve') {
        const text = urlObj.searchParams.get('text') || '';
        if (tts.voices.length === 0) await tts.loadVoices();
        const { voiceId, cleanText } = tts.resolveVoiceFromText(text, tts.defaultVoiceId());
        const voiceName = tts.voiceNameFromId(voiceId);
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
        sendJSON(res, 200, tts.appearance);
        return;
    }

    // Recent requests for the config "Queue" view
    if (req.method === 'GET' && pathname === '/api/tts/queue') {
        sendJSON(res, 200, { requests: tts.recentRequests() });
        return;
    }

    // Config page tells overlays the appearance changed (live refresh)
    if (req.method === 'POST' && pathname === '/api/tts/appearance/notify') {
        broadcast({ type: 'appearance' });
        sendJSON(res, 200, { ok: true });
        return;
    }

    // ── Begin Twitch OAuth (redirect the browser to Twitch) ──────────────────
    if (req.method === 'GET' && pathname === '/api/tts/oauth/start') {
        const url = tts.buildAuthUrl();
        if (!url) { res.writeHead(500); res.end('TWITCH_CLIENT_ID not configured in .env'); return; }
        res.writeHead(302, { Location: url });
        res.end();
        return;
    }

    // ── Force EventSub reconnect (no OAuth needed if already authorized) ───────
    if (req.method === 'POST' && pathname === '/api/tts/eventsub/connect') {
        if (!tts.tokens || !tts.tokens.user_id) {
            sendJSON(res, 400, { ok: false, error: 'Not authorized — use the Connect Twitch button first.' });
            return;
        }
        tts.forceReconnect().catch(e => console.error('[eventsub reconnect]', e.message));
        sendJSON(res, 200, { ok: true, message: 'Reconnecting EventSub…' });
        return;
    }

    // ── List channel point rewards (for picking redeem IDs in the UI) ────────
    if (req.method === 'GET' && pathname === '/api/tts/rewards') {
        try {
            const rewards = await tts.listCustomRewards();
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

    // ── Manual test / send (gated by account access) ─────────────────────────
    //   POST body: { username, password, text, voice? }
    if (req.method === 'POST' && pathname === '/api/tts/test') {
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body); } catch { return sendJSON(res, 400, { ok: false, error: 'Bad JSON' }); }

        // Re-verify the account against accounts.json (don't trust the client).
        const acc = tts.accounts.find(a => a.username === data.username && a.password === data.password);
        if (!acc)              return sendJSON(res, 401, { ok: false, error: 'Invalid account' });
        if (!acc.ttsAccess)    return sendJSON(res, 403, { ok: false, error: 'This account does not have TTS access' });
        if (!data.text)        return sendJSON(res, 400, { ok: false, error: 'No text' });

        const kind = String(data.kind || 'manual').toLowerCase() === 'redeem' ? 'redeem' : 'manual';
        const meta = kind === 'redeem'
            ? { kind: 'redeem', user: acc.username, reward: data.reward || 'Test Redeem', rewardId: 'test-redeem-single' }
            : { kind: 'manual', user: acc.username };
        tts.enqueue(data.text, data.voice, meta);
        sendJSON(res, 200, { ok: true, queueLength: tts.queue.length });
        return;
    }

    // ── Test redeem set (gated by account access) ──────────────────────────
    //   POST body: { username, password }
    if (req.method === 'POST' && pathname === '/api/tts/test-redeems') {
        const body = await readBody(req);
        let data;
        try { data = JSON.parse(body); } catch { return sendJSON(res, 400, { ok: false, error: 'Bad JSON' }); }

        const acc = tts.accounts.find(a => a.username === data.username && a.password === data.password);
        if (!acc)           return sendJSON(res, 401, { ok: false, error: 'Invalid account' });
        if (!acc.ttsAccess) return sendJSON(res, 403, { ok: false, error: 'This account does not have TTS access' });

        const redeemVoice = (tts.config && tts.config.redeems && tts.config.redeems.voice) || '';
        const samples = [
            { user: 'Basti',  reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Das ist ein Parser-Test mit strict braces.' },
            { user: 'Tuubaa', reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Hallo zusammen, Redeem Nummer zwei.' },
            { user: 'Chat',   reward: 'TTS', message: '{Roger - Laid-Back, Casual, Resonant} Vielen Dank fuers Zuschauen!' },
        ];

        samples.forEach(s => {
            tts.enqueue(s.message, redeemVoice, {
                kind: 'redeem',
                user: s.user,
                reward: s.reward,
                rewardId: 'test-redeem',
            });
        });

        sendJSON(res, 200, { ok: true, added: samples.length, queueLength: tts.queue.length });
        return;
    }

    // ── Overlay reports a clip finished playing (releases the queue) ─────────
    if (req.method === 'POST' && pathname === '/api/tts/done') {
        tts.notifyPlaybackDone();
        sendJSON(res, 200, { ok: true });
        return;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Existing config / upload API (unchanged)
    // ═══════════════════════════════════════════════════════════════════════

    if (req.method === 'POST' && pathname === '/api/save-config') {
        const body = await readBody(req);
        try {
            JSON.parse(body);
            fs.writeFileSync(path.join(ROOT, 'conf', 'config.json'), body, 'utf8');
            sendJSON(res, 200, { ok: true });
            console.log('[save-config] config.json updated');
        } catch (e) {
            console.error('[save-config] error:', e.message);
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/upload/image') {
        const channel  = sanitizeName((urlObj.searchParams.get('channel') || 'default').toLowerCase());
        const filename = sanitizeName(decodeURIComponent(req.headers['x-filename'] || 'image.png'));
        const dir      = path.join(ROOT, 'uploads', 'images', channel);
        ensureDir(dir);
        const target = path.join(dir, filename);
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                fs.writeFileSync(target, Buffer.concat(chunks));
                const urlPath = `/uploads/images/${channel}/${filename}`;
                sendJSON(res, 200, { ok: true, url: urlPath });
                console.log('[upload] image saved:', urlPath);
            } catch (e) {
                sendJSON(res, 500, { ok: false, error: e.message });
            }
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/delete/image') {
        const body = await readBody(req);
        try {
            const { url } = JSON.parse(body);
            if (!url || !url.startsWith('/uploads/images/')) {
                return sendJSON(res, 400, { ok: false, error: 'Invalid path' });
            }
            const target = path.normalize(path.join(ROOT, url));
            if (!target.startsWith(path.join(ROOT, 'uploads', 'images'))) {
                return sendJSON(res, 403, { ok: false, error: 'Forbidden' });
            }
            if (fs.existsSync(target)) fs.unlinkSync(target);
            sendJSON(res, 200, { ok: true });
            console.log('[delete] image removed:', url);
        } catch (e) {
            sendJSON(res, 500, { ok: false, error: e.message });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/upload/font') {
        const filename = sanitizeName(decodeURIComponent(req.headers['x-filename'] || 'font.ttf'));
        const dir      = path.join(ROOT, 'uploads', 'fonts');
        ensureDir(dir);
        const target = path.join(dir, filename);
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                fs.writeFileSync(target, Buffer.concat(chunks));
                const urlPath = `/uploads/fonts/${filename}`;
                sendJSON(res, 200, { ok: true, url: urlPath });
                console.log('[upload] font saved:', urlPath);
            } catch (e) {
                sendJSON(res, 500, { ok: false, error: e.message });
            }
        });
        return;
    }

    // ── Static file serving ──────────────────────────────────────────────────
    let urlPath = pathname;
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT + path.sep) && filePath !== ROOT) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + urlPath);
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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
