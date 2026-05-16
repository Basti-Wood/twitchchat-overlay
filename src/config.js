// ── Defaults ──────────────────────────────────────────────
const DEFAULT_CONFIG = {
    fontSize:               18,
    textColor:              '#000000',
    bubbleColor:            '#efd699',
    bubbleOpacity:          0.882,
    bubbleImage:            null,
    fontFamily:             '',
    customFontName:         null,
    customFontDataUrl:      null,  // legacy base64 — new uploads use customFontUrl
    customFontUrl:          null,
    nameBubbleMarginLeft:   8,
    nameBubbleMarginBottom: -12,
    msgBubbleMarginLeft:    20,
    slideDirection:         'right',
    bubbleImages:           [],
    customCSS:              '',
};

let currentConfig = { ...DEFAULT_CONFIG };

// ── Storage key (keyed per channel so each account has its own config) ──
function getConfigKey() {
    const stored = sessionStorage.getItem('account');
    if (!stored) return null;
    const { channel } = JSON.parse(stored);
    return channel ? `overlayConfig_${channel}` : null;
}

// ── hex + opacity → rgba ──────────────────────────────────
function hexToRgba(hex, opacity) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

// ── Inject @font-face into a specific document ────────────
function injectFontInto(doc, name, dataUrl) {
    let el = doc.getElementById('custom-font-style');
    if (!el) {
        el = doc.createElement('style');
        el.id = 'custom-font-style';
        doc.head.appendChild(el);
    }
    el.textContent = `@font-face { font-family: '${name}'; src: url('${dataUrl}'); }`;
}

// ── Build CSS string reflecting what the current config applies ────────
function buildGeneratedCSS() {
    const cfg = currentConfig;
    const bubbleBg = hexToRgba(cfg.bubbleColor, cfg.bubbleOpacity);
    const lines = [];

    lines.push('.message-box {');
    lines.push(`    background-color: ${bubbleBg};`);
    lines.push(`    color: ${cfg.textColor};`);
    lines.push(`    font-size: ${cfg.fontSize}px;`);
    lines.push(`    margin-left: ${cfg.msgBubbleMarginLeft}px;`);
    if (cfg.bubbleImages && cfg.bubbleImages.length > 0) {
        lines.push(`    /* background-image: random from ${cfg.bubbleImages.length} image(s) — applied per-message via JS */`);
        lines.push('    background-size: cover;');
        lines.push('    background-position: center;');
    } else if (cfg.bubbleImage) {
        lines.push('    /* background-image: applied via JS */');
        lines.push('    background-size: cover;');
        lines.push('    background-position: center;');
    }
    lines.push('}');
    lines.push('');
    lines.push('.username-row {');
    lines.push(`    margin-left: ${cfg.nameBubbleMarginLeft}px;`);
    lines.push(`    margin-bottom: ${cfg.nameBubbleMarginBottom}px;`);
    lines.push('}');
    if (cfg.fontFamily === '__custom__' && cfg.customFontName) {
        lines.push('');
        lines.push('@font-face {');
        lines.push(`    font-family: '${cfg.customFontName}';`);
        lines.push('    src: url(…); /* uploaded font — injected via JS */');
        lines.push('}');
        lines.push('body {');
        lines.push(`    font-family: '${cfg.customFontName}', sans-serif;`);
        lines.push('}');
    } else if (cfg.fontFamily) {
        lines.push('');
        lines.push('body {');
        lines.push(`    font-family: ${cfg.fontFamily};`);
        lines.push('}');
    }
    return lines.join('\n');
}

// ── Apply config styles to the preview iframe ────────────
function applyToPreview() {
    const iframe = document.getElementById('preview-frame');
    const doc = iframe?.contentDocument;
    if (!doc || !doc.body) return;

    // Custom @font-face — prefer server URL, fall back to legacy base64 data URL
    const fontSrc = currentConfig.customFontUrl || currentConfig.customFontDataUrl;
    if (currentConfig.fontFamily === '__custom__' && currentConfig.customFontName && fontSrc) {
        injectFontInto(doc, currentConfig.customFontName, fontSrc);
    }

    // Inject config-derived CSS as a <style> element.
    // Using <style> (not el.style.*) means custom CSS from the editor can override
    // any property without needing !important.
    const cssToInject = currentConfig.customCSS || buildGeneratedCSS();
    let configStyleEl = doc.getElementById('config-css');
    if (!configStyleEl) {
        configStyleEl = doc.createElement('style');
        configStyleEl.id = 'config-css';
        doc.head.appendChild(configStyleEl);
    }
    configStyleEl.textContent = cssToInject;

    // Background images must be applied per-element (random pick from array)
    const imgs = currentConfig.bubbleImages;
    doc.querySelectorAll('.message-box').forEach(el => {
        if (imgs && imgs.length > 0) {
            const ri = imgs[Math.floor(Math.random() * imgs.length)];
            el.style.backgroundImage    = `url("${ri}")`;
            el.style.backgroundSize     = 'cover';
            el.style.backgroundPosition = 'center';
        } else if (currentConfig.bubbleImage) {
            el.style.backgroundImage    = `url("${currentConfig.bubbleImage}")`;
            el.style.backgroundSize     = 'cover';
            el.style.backgroundPosition = 'center';
        } else {
            el.style.backgroundImage    = '';
            el.style.backgroundSize     = '';
            el.style.backgroundPosition = '';
        }
    });

    // Keep the CSS editor textarea in sync (only when user is not actively editing it)
    const cssEditorEl = document.getElementById('cfg-css-editor');
    if (cssEditorEl && document.activeElement !== cssEditorEl) {
        cssEditorEl.value = cssToInject;
    }
}

// ── Inject 3 demo messages into the preview iframe ─────────
function injectDemoMessages() {
    const iframe = document.getElementById('preview-frame');
    const doc = iframe?.contentDocument;
    if (!doc) return;
    const chat = doc.querySelector('.chat');
    if (!chat) return;

    const dir = currentConfig.slideDirection || 'right';
    const demos = [
        { nick: 'Du', color: '#e91916', text: "Welcome to the stream! Let's go! \uD83C\uDF89" },
        { nick: 'Dein lieblings viewer', color: '#9146ff', text: 'This chat overlay looks amazing! \u2728' },
        { nick: 'Ein Mod',    color: '#1db954', text: "Pog Pog Pog! Let's get it! \uD83D\uDE80" },
    ];

    chat.innerHTML = '';
    demos.forEach(msg => {
        const row = doc.createElement('div');
        row.className = `chat-message slide-in-${dir}`;

        const usernameRow = doc.createElement('div');
        usernameRow.className = 'username-row';
        usernameRow.style.backgroundColor = msg.color;

        const nameSpan = doc.createElement('span');
        nameSpan.className = 'username';
        nameSpan.textContent = msg.nick;
        nameSpan.style.color = '#fff';
        usernameRow.appendChild(nameSpan);

        const msgBox = doc.createElement('div');
        msgBox.className = 'message-box';
        msgBox.textContent = msg.text;

        row.appendChild(usernameRow);
        row.appendChild(msgBox);
        chat.appendChild(row);
    });

    applyToPreview();
}

// ── Render bubble image thumbnail gallery ─────────────────
function renderImageGallery() {
    const gallery = document.getElementById('cfg-img-gallery');
    if (!gallery) return;
    gallery.innerHTML = '';
    (currentConfig.bubbleImages || []).forEach((dataUrl, idx) => {
        const thumb = document.createElement('div');
        thumb.className = 'img-thumb';
        const img = document.createElement('img');
        img.src = dataUrl;
        const btn = document.createElement('button');
        btn.className = 'img-thumb-remove';
        btn.textContent = '\u2715';
        btn.title = 'Remove image';
        btn.addEventListener('click', async () => {
            const url = currentConfig.bubbleImages[idx];
            currentConfig.bubbleImages.splice(idx, 1);
            renderImageGallery();
            saveConfig();
            // If it was uploaded to the server, delete it from disk too
            if (url && url.startsWith('/uploads/images/')) {
                try {
                    const res = await fetch('/api/delete/image', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url }),
                    });
                    const data = await res.json();
                    if (!data.ok) console.warn('[delete image] server error:', data.error);
                } catch (err) {
                    console.warn('[delete image] fetch failed:', err.message);
                }
            }
        });
        thumb.appendChild(img);
        thumb.appendChild(btn);
        gallery.appendChild(thumb);
    });
}
// ── Style presets (per-channel, saved in localStorage) ─────
function getPresetsKey() {
    const stored = sessionStorage.getItem('account');
    if (!stored) return null;
    const { channel } = JSON.parse(stored);
    return channel ? `configPresets_${channel.toLowerCase()}` : null;
}

function loadPresets() {
    const key = getPresetsKey();
    if (!key) return [];
    try { return JSON.parse(localStorage.getItem(key)) || []; }
    catch { return []; }
}

function savePresets(list) {
    const key = getPresetsKey();
    if (!key) return;
    localStorage.setItem(key, JSON.stringify(list));
    trySilentFileSave(); // keep config.json in sync without triggering a file picker
}

function renderPresets() {
    const container = document.getElementById('cfg-preset-list');
    if (!container) return;
    const presets = loadPresets();
    if (!presets.length) {
        container.innerHTML = '<span class="hint">No presets saved yet.</span>';
        return;
    }
    container.innerHTML = '';
    presets.forEach((preset, idx) => {
        const row = document.createElement('div');
        row.className = 'preset-item';

        const nameEl = document.createElement('span');
        nameEl.className = 'preset-name';
        nameEl.textContent = preset.name;

        const loadBtn = document.createElement('button');
        loadBtn.className = 'btn-small';
        loadBtn.textContent = 'Load';
        loadBtn.addEventListener('click', () => {
            currentConfig = { ...DEFAULT_CONFIG, ...preset.config };
            saveConfig();
            populateForm();
        });

        const delBtn = document.createElement('button');
        delBtn.className = 'btn-small btn-small--danger';
        delBtn.title = 'Delete preset';
        delBtn.textContent = '\u2715';
        delBtn.addEventListener('click', () => {
            if (!confirm(`Delete preset "${preset.name}"?`)) return;
            const all = loadPresets();
            all.splice(idx, 1);
            savePresets(all);
            renderPresets();
        });

        row.appendChild(nameEl);
        row.appendChild(loadBtn);
        row.appendChild(delBtn);
        container.appendChild(row);
    });
}
// ── Sync form inputs from currentConfig ───────────────────
function populateForm() {
    document.getElementById('cfg-font-family').value    = currentConfig.fontFamily || '';
    document.getElementById('cfg-font-size').value      = currentConfig.fontSize;
    document.getElementById('cfg-text-color').value     = currentConfig.textColor;
    document.getElementById('cfg-bubble-color').value   = currentConfig.bubbleColor;
    document.getElementById('cfg-bubble-opacity').value = currentConfig.bubbleOpacity;
    document.getElementById('cfg-opacity-val').textContent = Number(currentConfig.bubbleOpacity).toFixed(2);
    document.getElementById('cfg-name-ml').value        = currentConfig.nameBubbleMarginLeft;
    document.getElementById('cfg-name-mb').value        = currentConfig.nameBubbleMarginBottom;
    document.getElementById('cfg-msg-ml').value         = currentConfig.msgBubbleMarginLeft;
    document.getElementById('cfg-slide-dir').value      = currentConfig.slideDirection || 'right';

    document.getElementById('cfg-font-label').textContent =
        currentConfig.customFontName || 'No font loaded';

    renderImageGallery();
    const cssEl = document.getElementById('cfg-css-editor');
    if (cssEl) cssEl.value = currentConfig.customCSS || buildGeneratedCSS();
    renderPresets();
}

// ── Persist and refresh preview ───────────────────────────
// keepCSS=true preserves customCSS (used when applying from the CSS editor).
// keepCSS=false (default) clears customCSS so the Style tab is always the source of truth.
function saveConfig(keepCSS = false) {
    if (!keepCSS) currentConfig.customCSS = '';
    const key = getConfigKey();
    if (key) localStorage.setItem(key, JSON.stringify(currentConfig));
    applyToPreview();
}

// ── Load from localStorage ────────────────────────────────
function loadConfig() {
    const key = getConfigKey();
    if (key) {
        const raw = localStorage.getItem(key);
        if (raw) {
            try { currentConfig = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }; }
            catch { currentConfig = { ...DEFAULT_CONFIG }; }
        }
    }
    populateForm();
    applyToPreview();
}

// ── Parse CSS text back into config values (best-effort) ─
function parseCSSToConfig(cssText) {
    const updates = {};

    // .message-box { … }
    const msgMatch = cssText.match(/\.message-box\s*\{([^}]*)\}/s);
    if (msgMatch) {
        const block = msgMatch[1];
        const bgRgba = block.match(/background-color\s*:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/);
        if (bgRgba) {
            const [, r, g, b, a] = bgRgba;
            updates.bubbleColor   = '#' + [r, g, b].map(v => parseInt(v).toString(16).padStart(2, '0')).join('');
            updates.bubbleOpacity = parseFloat(a);
        }
        const bgHex = block.match(/background-color\s*:\s*(#[0-9a-fA-F]{6})/);
        if (bgHex && !bgRgba) updates.bubbleColor = bgHex[1];

        const col = block.match(/(?:^|;|\n)\s*color\s*:\s*(#[0-9a-fA-F]{6})/m);
        if (col) updates.textColor = col[1];

        const fs = block.match(/font-size\s*:\s*([\d.]+)px/);
        if (fs) updates.fontSize = parseFloat(fs[1]);

        const ml = block.match(/margin-left\s*:\s*([\d.-]+)px/);
        if (ml) updates.msgBubbleMarginLeft = parseFloat(ml[1]);
    }

    // .username-row { … }
    const urMatch = cssText.match(/\.username-row\s*\{([^}]*)\}/s);
    if (urMatch) {
        const block = urMatch[1];
        const ml = block.match(/margin-left\s*:\s*([\d.-]+)px/);
        if (ml) updates.nameBubbleMarginLeft = parseFloat(ml[1]);
        const mb = block.match(/margin-bottom\s*:\s*([\d.-]+)px/);
        if (mb) updates.nameBubbleMarginBottom = parseFloat(mb[1]);
    }

    // body { font-family: … }
    const bodyMatch = cssText.match(/body\s*\{([^}]*)\}/s);
    if (bodyMatch) {
        const ff = bodyMatch[1].match(/font-family\s*:\s*([^;]+)/);
        if (ff) updates.fontFamily = ff[1].trim();
    }

    return updates;
}

// ── Wire up all style controls ────────────────────────────
function setupControls() {
    document.getElementById('cfg-font-family').addEventListener('change', e => {
        currentConfig.fontFamily = e.target.value;
        saveConfig();
    });

    document.getElementById('cfg-font-upload').addEventListener('change', async e => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const buffer = await file.arrayBuffer();
            const res = await fetch('/api/upload/font', {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Filename': encodeURIComponent(file.name),
                },
                body: buffer,
            });
            const data = await res.json();
            if (!data.ok) throw new Error(data.error);
            currentConfig.customFontName    = file.name.replace(/\.[^.]+$/, '');
            currentConfig.customFontUrl     = data.url;
            currentConfig.customFontDataUrl = null; // clear any old base64
            currentConfig.fontFamily = '__custom__';
            document.getElementById('cfg-font-family').value = '__custom__';
            document.getElementById('cfg-font-label').textContent = file.name;
            saveConfig();
        } catch (err) {
            alert('Font upload failed: ' + err.message);
        }
    });

    document.getElementById('cfg-font-size').addEventListener('input', e => {
        currentConfig.fontSize = parseInt(e.target.value) || DEFAULT_CONFIG.fontSize;
        saveConfig();
    });

    document.getElementById('cfg-text-color').addEventListener('input', e => {
        currentConfig.textColor = e.target.value;
        saveConfig();
    });

    document.getElementById('cfg-bubble-color').addEventListener('input', e => {
        currentConfig.bubbleColor = e.target.value;
        saveConfig();
    });

    document.getElementById('cfg-bubble-opacity').addEventListener('input', e => {
        currentConfig.bubbleOpacity = parseFloat(e.target.value);
        document.getElementById('cfg-opacity-val').textContent = currentConfig.bubbleOpacity.toFixed(2);
        saveConfig();
    });

    document.getElementById('cfg-bubble-image').addEventListener('change', async e => {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        if (!Array.isArray(currentConfig.bubbleImages)) currentConfig.bubbleImages = [];

        const stored  = sessionStorage.getItem('account');
        const channel = stored ? (JSON.parse(stored).channel || 'default').toLowerCase() : 'default';

        for (const file of files) {
            try {
                const buffer = await file.arrayBuffer();
                const res = await fetch(`/api/upload/image?channel=${encodeURIComponent(channel)}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': file.type || 'application/octet-stream',
                        'X-Filename': encodeURIComponent(file.name),
                    },
                    body: buffer,
                });
                const data = await res.json();
                if (!data.ok) throw new Error(data.error);
                currentConfig.bubbleImages.push(data.url);
            } catch (err) {
                alert('Image upload failed (' + file.name + '): ' + err.message);
            }
        }
        e.target.value = '';
        renderImageGallery();
        saveConfig();
    });

    document.getElementById('cfg-name-ml').addEventListener('input', e => {
        currentConfig.nameBubbleMarginLeft = parseInt(e.target.value);
        saveConfig();
    });
    document.getElementById('cfg-name-mb').addEventListener('input', e => {
        currentConfig.nameBubbleMarginBottom = parseInt(e.target.value);
        saveConfig();
    });
    document.getElementById('cfg-msg-ml').addEventListener('input', e => {
        currentConfig.msgBubbleMarginLeft = parseInt(e.target.value);
        saveConfig();
    });

    document.getElementById('cfg-slide-dir').addEventListener('change', e => {
        currentConfig.slideDirection = e.target.value;
        saveConfig();
    });

    document.getElementById('cfg-reset').addEventListener('click', () => {
        if (!confirm('Reset all style settings to defaults? This cannot be undone.')) return;
        currentConfig = { ...DEFAULT_CONFIG };
        const key = getConfigKey();
        if (key) localStorage.removeItem(key);
        document.getElementById('cfg-font-upload').value  = '';
        document.getElementById('cfg-bubble-image').value = '';
        populateForm();
        applyToPreview();
    });

    // CSS editor — apply on button click or Ctrl+Enter
    // Parses the CSS to sync values back to the Style tab controls.
    function applyCSSEditor() {
        const cssText = document.getElementById('cfg-css-editor').value;
        const parsed  = parseCSSToConfig(cssText);
        Object.assign(currentConfig, parsed);
        currentConfig.customCSS = cssText;
        populateForm();
        saveConfig(true); // keepCSS=true so customCSS is preserved
    }
    document.getElementById('cfg-css-apply').addEventListener('click', applyCSSEditor);
    document.getElementById('cfg-css-editor').addEventListener('keydown', e => {
        if (e.ctrlKey && e.key === 'Enter') applyCSSEditor();
    });

    // Right-panel tab switching
    document.querySelectorAll('.panel-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.panel-tab').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.panel-tab-content').forEach(c => { c.style.display = 'none'; });
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).style.display = 'flex';
        });
    });

    // Preset save
    document.getElementById('cfg-preset-save').addEventListener('click', () => {
        const nameInput = document.getElementById('cfg-preset-name');
        const name = nameInput.value.trim();
        if (!name) { nameInput.focus(); return; }
        const presets = loadPresets();
        const existing = presets.findIndex(p => p.name === name);
        if (existing >= 0) {
            if (!confirm(`Overwrite preset "${name}"?`)) return;
            presets[existing].config = { ...currentConfig };
        } else {
            presets.push({ name, config: { ...currentConfig } });
        }
        savePresets(presets);
        nameInput.value = '';
        renderPresets();
    });
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    const stored = sessionStorage.getItem('account');
    if (stored) {
        const account = JSON.parse(stored);
        if (account.channel)    document.getElementById('channel-input').value = account.channel;
        if (account.oauthToken) document.getElementById('token-input').value   = account.oauthToken;
    }

    loadConfig();
    setupControls();
    // Wire up the preview iframe — inject demo messages once it finishes loading
    const previewFrame = document.getElementById('preview-frame');
    previewFrame.addEventListener('load', () => {
        injectDemoMessages();
    });

    // Update iframe src based on channel / token inputs
    updatePreviewSrc();
    document.getElementById('channel-input').addEventListener('change', updatePreviewSrc);
    document.getElementById('token-input').addEventListener('change', updatePreviewSrc);
});
// ── Update preview iframe src with current channel + token ───
function updatePreviewSrc() {
    const channel = document.getElementById('channel-input').value.trim().toLowerCase();
    const token   = document.getElementById('token-input').value.trim();
    const frame   = document.getElementById('preview-frame');
    if (!frame) return;
    const params = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (token)   params.set('token', token);
    const qs     = params.toString();
    const newSrc = 'chat.html' + (qs ? '?' + qs : '');
    // Only reload if src actually changed
    if (frame.src !== new URL(newSrc, window.location.href).href) {
        frame.src = newSrc;
    }
}

// -- File System Access API helpers (IndexedDB stores the file handle) --
// First save: user picks conf/config.json via a file picker.
// Every save after that writes silently using the remembered handle.

async function _getHandleDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('chatOverlayStore', 1);
        req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = () => reject(req.error);
    });
}

async function _dbGet(db, key) {
    return new Promise(resolve => {
        const get = db.transaction('handles', 'readonly').objectStore('handles').get(key);
        get.onsuccess = () => resolve(get.result ?? null);
        get.onerror   = () => resolve(null);
    });
}

async function _dbPut(db, key, value) {
    return new Promise(resolve => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(value, key);
        tx.oncomplete = resolve;
    });
}

async function resolveConfigHandle() {
    if (!window.showOpenFilePicker) {
        alert('Direct file writing requires Chrome or the built-in OBS browser.');
        return null;
    }
    const db = await _getHandleDB();
    let handle = await _dbGet(db, 'configJson');

    if (handle) {
        let perm = await handle.queryPermission({ mode: 'readwrite' });
        if (perm !== 'granted') perm = await handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') return { db, handle };
    }

    // First time (or permission revoked) -- open a file picker so user selects conf/config.json
    try {
        [handle] = await window.showOpenFilePicker({
            types: [{ description: 'JSON Config', accept: { 'application/json': ['.json'] } }],
            multiple: false,
        });
        await _dbPut(db, 'configJson', handle);
        return { db, handle };
    } catch (e) {
        if (e.name !== 'AbortError') throw e;
        return null;
    }
}

// -- Silent file save (no alerts, only works if handle + permission already granted) --
async function trySilentFileSave() {
    const stored = sessionStorage.getItem('account');
    if (!stored) return;
    const { channel } = JSON.parse(stored);
    if (!channel) return;
    try {
        let fileData = { config: {} };
        try {
            const res = await fetch('../conf/config.json?_=' + Date.now());
            if (res.ok) fileData = await res.json();
        } catch {}
        if (!fileData.config)  fileData.config  = {};
        if (!fileData.presets) fileData.presets = {};
        fileData.config[channel.toLowerCase()]  = { ...currentConfig };
        fileData.presets[channel.toLowerCase()] = loadPresets();

        await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fileData, null, 4),
        });
    } catch { /* silent fail — next explicit Save Config will show the error */ }
}

// ── Save config to conf/config.json via local server ─────
async function saveConfigToFile() {
    const stored = sessionStorage.getItem('account');
    if (!stored) { alert('No account session — please log in first.'); return; }
    const { channel } = JSON.parse(stored);
    if (!channel) { alert('No channel set. Enter a channel name first.'); return; }

    const channelKey = channel.toLowerCase();

    // Read existing file first so we preserve other channels' settings
    let fileData = { config: {} };
    try {
        const res = await fetch('../conf/config.json?_=' + Date.now());
        if (res.ok) fileData = await res.json();
    } catch { /* start fresh if file unreadable */ }

    if (!fileData.config)  fileData.config  = {};
    if (!fileData.presets) fileData.presets = {};
    fileData.config[channelKey]  = { ...currentConfig };
    fileData.presets[channelKey] = loadPresets();

    const json = JSON.stringify(fileData, null, 4);

    try {
        const res = await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json,
        });
        const data = await res.json();
        if (data.ok) {
            flashSaveBtn('Saved ✓');
        } else {
            flashSaveBtn('Save failed!');
            alert('Server returned an error: ' + data.error);
        }
    } catch (e) {
        flashSaveBtn('Save failed!');
        alert('Could not reach the local server.\n\nMake sure you started it:\n  node server.js\n\nThen open the config page via http://localhost:8080/html/config.html\n\n' + e.message);
    }
}

function flashSaveBtn(label) {
    const btn  = document.getElementById('save-btn');
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> ${label}`;
    setTimeout(() => { btn.innerHTML = orig; }, 2500);
}
// ── Copy overlay link ─────────────────────────────────────
function copyLink() {
    const channel = document.getElementById('channel-input').value.trim();
    const token   = document.getElementById('token-input').value.trim();

    const chatUrl = new URL('chat.html', window.location.href);
    const params  = new URLSearchParams();
    if (channel) params.set('channel', channel);
    if (token)   params.set('token', token);
    chatUrl.search = params.toString();

    navigator.clipboard.writeText(chatUrl.toString()).then(() => {
        const btn = document.getElementById('copy-btn');
        const original = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
            </svg>
            Copied!`;
        setTimeout(() => {
            btn.classList.remove('copied');
            btn.innerHTML = original;
        }, 2000);
    }).catch(() => {
        alert('Could not copy — please copy the URL manually:\n\n' + chatUrl.toString());
    });
}

// Dynamically fetch uploaded fonts and add them to the dropdown menu
function fetchUploadedFonts() {
    const fontDir = 'uploads/fonts/';
    const fontFiles = [];

    // Simulate fetching font files dynamically (this would be replaced with actual file fetching logic)
    try {
        const files = fs.readdirSync(fontDir); // Use Node.js to read the directory
        files.forEach(file => {
            if (file.endsWith('.ttf') || file.endsWith('.otf')) {
                const fontName = file.replace(/\.[^.]+$/, ''); // Remove file extension
                fontFiles.push({ name: fontName, url: `${fontDir}${file}` });
            }
        });
    } catch (error) {
        console.error('Error fetching fonts:', error);
    }

    return fontFiles;
}

// Function to update the font dropdown menu dynamically
function updateFontDropdown() {
    const dropdown = document.getElementById('font-dropdown');
    if (!dropdown) return;

    // Clear existing options
    dropdown.innerHTML = '';

    // Add dynamically fetched fonts
    DEFAULT_CONFIG.fontFamilyOptions.forEach(font => {
        const option = document.createElement('option');
        option.value = font;
        option.textContent = font;
        dropdown.appendChild(option);
    });
}

// Call updateFontDropdown after fetching fonts
DEFAULT_CONFIG.fontFamilyOptions = fetchUploadedFonts().map(font => font.name);
updateFontDropdown();
