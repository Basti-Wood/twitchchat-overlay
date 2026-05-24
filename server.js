const http = require('http');
const fs   = require('fs');
const path = require('path');

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
};

const server = http.createServer((req, res) => {
    // Allow requests from the same machine only (config page + OBS on localhost)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ── POST /api/save-config ────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/save-config') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                // Validate it's real JSON before writing
                JSON.parse(body);

                const target = path.join(ROOT, 'conf', 'config.json');
                fs.writeFileSync(target, body, 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                console.log('[save-config] config.json updated');
            } catch (e) {
                console.error('[save-config] error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── POST /api/upload/image?channel=xxx ───────────────────────────────
    if (req.method === 'POST' && req.url.startsWith('/api/upload/image')) {
        const urlObj   = new URL(req.url, 'http://localhost');
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url: urlPath }));
                console.log('[upload] image saved:', urlPath);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── DELETE /api/upload/image ─────────────────────────────────────────
    // Body: JSON { url: "/uploads/images/channel/file.png" }
    if (req.method === 'POST' && req.url === '/api/delete/image') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const { url } = JSON.parse(body);
                // Only allow deleting files inside uploads/images/
                if (!url || !url.startsWith('/uploads/images/')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Invalid path' }));
                    return;
                }
                const target = path.normalize(path.join(ROOT, url));
                // Double-check resolved path stays inside uploads/images
                if (!target.startsWith(path.join(ROOT, 'uploads', 'images'))) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: false, error: 'Forbidden' }));
                    return;
                }
                if (fs.existsSync(target)) fs.unlinkSync(target);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true }));
                console.log('[delete] image removed:', url);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── POST /api/upload/font ────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/api/upload/font') {
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, url: urlPath }));
                console.log('[upload] font saved:', urlPath);
            } catch (e) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: false, error: e.message }));
            }
        });
        return;
    }

    // ── Static file serving ──────────────────────────────────────────────
    let urlPath = req.url.split('?')[0]; // strip query string
    if (urlPath === '/') urlPath = '/index.html';

    // Prevent path traversal
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
    console.log(`  Startpage: http://localhost:${PORT}/index.html`);
    console.log('  ──────────────────────────────────────────────────');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
});
