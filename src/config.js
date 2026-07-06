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

// Note: keep browser code free of Node-only APIs (like fs). The font picker
// uses file uploads handled by /api/upload/font, so no local dir scan here.

// ═══════════════════════════════════════════════════════════════════════════
//  TTS tab logic
//  Two sub-tabs: "Customize" (overlay look + triggers + test + copy link) and
//  "Queue" (live feed of incoming requests). The TTS settings live in a
//  TOP-LEVEL "tts" key of conf/config.json (the server reads config.tts).
// ═══════════════════════════════════════════════════════════════════════════

const TTS_DEFAULTS = {
    defaultVoice:    '',
    gapSeconds:      4,
    maxChars:        300,
    maxClipSeconds:  30,
    modelId:         'eleven_multilingual_v2',
    language:        { default: 'de', autoDetect: true },
    stability:       0.5,
    similarityBoost: 0.75,
    bits:    { enabled: false, minBits: 100, voice: '', template: '' },
    resubs:  { enabled: false, minTier: 1,   voice: '', template: '' },
    redeems: { enabled: false, rewardTitle: '', rewardId: '', voice: '', template: '' },
    gifs:    { enabled: true, bits: [], resubs: [], redeems: [] },
    appearance: {
        position: 'bottom-center',
        accent:   '#9146ff',
        bg:       'rgba(20, 16, 40, 0.92)',
        text:     '#ffffff',
        fontSize: 18,
        radius:   16,
        duration: 0,
        showIcon: true,
    },
};

let ttsConfig = JSON.parse(JSON.stringify(TTS_DEFAULTS));
let ttsVoices = [];

function ttsEl(id) { return document.getElementById(id); }

// ── Per-user: every account edits its OWN channel's TTS config ───────────────
function ttsChannelKey() {
    try {
        const stored = sessionStorage.getItem('account');
        if (!stored) return null;
        const { channel } = JSON.parse(stored);
        return channel ? String(channel).toLowerCase() : null;
    } catch { return null; }
}

/** Append ?channel=<key> to a TTS API path. */
function ttsApi(path) {
    const key = ttsChannelKey();
    if (!key) return path;
    return path + (path.includes('?') ? '&' : '?') + 'channel=' + encodeURIComponent(key);
}

// ── rgba <-> hex helpers (color inputs need hex; we store bg as rgba) ────────
function ttsRgbaToHex(rgba) {
    if (!rgba) return '#141028';
    if (rgba[0] === '#') return rgba.slice(0, 7);
    const m = rgba.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return '#141028';
    const h = n => Number(n).toString(16).padStart(2, '0');
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
}
function ttsRgbaAlpha(rgba) {
    if (!rgba) return 0.92;
    const m = String(rgba).match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/i);
    return m ? parseFloat(m[1]) : 1;
}
function ttsHexToRgba(hex, alpha) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) || 0;
    const g = parseInt(h.slice(2, 4), 16) || 0;
    const b = parseInt(h.slice(4, 6), 16) || 0;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Load / save the whole config.json, merging the `tts` block ───────────────
// TTS settings are stored PER CHANNEL: config.tts[<channel>] = { ... }.
function ttsIsFlatLegacy(tts) {
    return !!(tts && (tts.bits || tts.appearance || tts.defaultVoice !== undefined));
}

async function ttsLoadConfig() {
    const key = ttsChannelKey();
    try {
        const res = await fetch('../conf/config.json?_=' + Date.now());
        if (res.ok) {
            const data = await res.json();
            let mine = null;
            if (data && data.tts) {
                if (key && data.tts[key] && !ttsIsFlatLegacy(data.tts)) mine = data.tts[key];
                else if (ttsIsFlatLegacy(data.tts)) mine = data.tts; // legacy flat (server migrates on boot)
            }
            if (mine) {
                ttsConfig = {
                    ...TTS_DEFAULTS, ...mine,
                    bits:    { ...TTS_DEFAULTS.bits,    ...(mine.bits    || {}) },
                    resubs:  { ...TTS_DEFAULTS.resubs,  ...(mine.resubs  || {}) },
                    redeems: { ...TTS_DEFAULTS.redeems, ...(mine.redeems || {}) },
                    gifs:    { ...TTS_DEFAULTS.gifs,    ...(mine.gifs    || {}) },
                    language: { ...TTS_DEFAULTS.language, ...(mine.language || {}) },
                    appearance: { ...TTS_DEFAULTS.appearance, ...(mine.appearance || {}) },
                };
            }
        }
    } catch (e) { console.warn('[tts-cfg] load failed:', e.message); }
}

async function ttsSaveConfig() {
    const key = ttsChannelKey();
    if (!key) { console.warn('[tts-cfg] no channel in session — cannot save'); return; }
    let fileData = { config: {}, presets: {} };
    try {
        const res = await fetch('../conf/config.json?_=' + Date.now());
        if (res.ok) fileData = await res.json();
    } catch {}
    if (!fileData.config)  fileData.config  = {};
    if (!fileData.presets) fileData.presets = {};
    // Preserve other channels' TTS settings; replace only our own block.
    if (!fileData.tts || ttsIsFlatLegacy(fileData.tts)) fileData.tts = {};
    fileData.tts[key] = ttsConfig;
    try {
        const res = await fetch('/api/save-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fileData, null, 4),
        });
        const data = await res.json();
        if (!data.ok) console.warn('[tts-cfg] save error:', data.error);
        // tell any open overlays of THIS channel to re-read appearance
        fetch(ttsApi('/api/tts/appearance/notify'), { method: 'POST' }).catch(() => {});
    } catch (e) { console.warn('[tts-cfg] save fetch failed:', e.message); }
}

// ── Voice dropdowns ──────────────────────────────────────────────────────────
function ttsFillVoiceSelect(sel, includeDefaultOption) {
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '';
    if (includeDefaultOption) {
        const o = document.createElement('option');
        o.value = ''; o.textContent = includeDefaultOption;
        sel.appendChild(o);
    }
    ttsVoices.forEach(v => {
        const o = document.createElement('option');
        o.value = v.name;          // store by name so {Name} tags line up
        o.textContent = v.name;
        sel.appendChild(o);
    });
    sel.value = current;
}

async function ttsLoadVoices() {
    try {
        const res = await fetch('/api/tts/voices');
        const data = await res.json();
        ttsVoices = data.voices || [];
    } catch (e) { console.warn('[tts-cfg] voices failed:', e.message); ttsVoices = []; }

    ttsFillVoiceSelect(ttsEl('tts-default-voice'), '(first available)');
    ttsFillVoiceSelect(ttsEl('tts-bits-voice'),    '(default voice)');
    ttsFillVoiceSelect(ttsEl('tts-resub-voice'),   '(default voice)');
    ttsFillVoiceSelect(ttsEl('tts-redeem-voice'),  '(default voice)');
    ttsApplyToForm();
}

// ── Status panel ──────────────────────────────────────────────────────────────
async function ttsRefreshStatus() {
    const el = ttsEl('tts-status');
    if (!el) return;
    try {
        const res = await fetch(ttsApi('/api/tts/status'));
        const s = await res.json();
        const bits = [];
        bits.push(s.elevenConfigured ? '✓ ElevenLabs key' : '✗ No ElevenLabs key (.env)');
        bits.push(s.twitchConfigured ? '✓ Twitch app creds' : '✗ No Twitch creds (.env)');
        if (s.twitchClientIdPrefix) bits.push(`Client ID: ${s.twitchClientIdPrefix}`);
        if (s.redirectUri) bits.push(`Redirect URI: ${s.redirectUri}`);
        bits.push(s.authorized ? `✓ Authorized as ${s.login}` : '✗ Not authorized');
        bits.push(s.eventSubOnline ? '✓ EventSub online' : '✗ EventSub offline');
        bits.push(`${s.voiceCount} voices · queue ${s.queueLength}${s.playing ? ' · playing' : ''}`);
        el.innerHTML = bits.join('<br>');
        const btn = ttsEl('tts-connect-btn');
        if (btn) btn.textContent = s.authorized ? 'Re-connect Twitch (EventSub)' : 'Connect Twitch (EventSub)';
    } catch (e) {
        el.textContent = 'Status unavailable — is the server running?';
    }
}

// ── Form <-> ttsConfig ──────────────────────────────────────────────────────
function ttsApplyToForm() {
    const c = ttsConfig;
    if (ttsEl('tts-default-voice')) ttsEl('tts-default-voice').value = c.defaultVoice || '';
    if (ttsEl('tts-gap'))           ttsEl('tts-gap').value           = c.gapSeconds;
    if (ttsEl('tts-maxchars'))      ttsEl('tts-maxchars').value      = c.maxChars;
    if (ttsEl('tts-model'))         ttsEl('tts-model').value         = c.modelId;
    if (ttsEl('tts-language-default')) ttsEl('tts-language-default').value = (c.language && c.language.default) || 'de';
    if (ttsEl('tts-language-autodetect')) ttsEl('tts-language-autodetect').checked = !c.language || c.language.autoDetect !== false;

    ttsEl('tts-bits-enabled').checked  = !!c.bits.enabled;
    ttsEl('tts-bits-min').value        = c.bits.minBits;
    ttsEl('tts-bits-voice').value      = c.bits.voice || '';
    ttsEl('tts-bits-template').value   = c.bits.template || '';

    ttsEl('tts-resub-enabled').checked = !!c.resubs.enabled;
    ttsEl('tts-resub-mintier').value   = String(c.resubs.minTier || 1);
    ttsEl('tts-resub-voice').value     = c.resubs.voice || '';
    ttsEl('tts-resub-template').value  = c.resubs.template || '';

    ttsEl('tts-redeem-enabled').checked = !!c.redeems.enabled;
    ttsEl('tts-redeem-title').value     = c.redeems.rewardTitle || '';
    ttsEl('tts-redeem-id').value        = c.redeems.rewardId || '';
    ttsEl('tts-redeem-voice').value     = c.redeems.voice || '';
    ttsEl('tts-redeem-template').value  = c.redeems.template || '';

    // GIFs
    if (ttsEl('tts-gifs-enabled')) ttsEl('tts-gifs-enabled').checked = !c.gifs || c.gifs.enabled !== false;
    ttsRenderGifGalleries();

    // Appearance
    const a = c.appearance || {};
    if (ttsEl('tts-ap-position')) ttsEl('tts-ap-position').value = a.position || 'bottom-center';
    if (ttsEl('tts-ap-accent'))   ttsEl('tts-ap-accent').value   = ttsRgbaToHex(a.accent || '#9146ff');
    if (ttsEl('tts-ap-bg'))       ttsEl('tts-ap-bg').value       = ttsRgbaToHex(a.bg);
    const alpha = ttsRgbaAlpha(a.bg);
    if (ttsEl('tts-ap-bg-opacity')) {
        ttsEl('tts-ap-bg-opacity').value = alpha;
        if (ttsEl('tts-ap-bg-opacity-val')) ttsEl('tts-ap-bg-opacity-val').textContent = Number(alpha).toFixed(2);
    }
    if (ttsEl('tts-ap-text'))     ttsEl('tts-ap-text').value     = ttsRgbaToHex(a.text || '#ffffff');
    if (ttsEl('tts-ap-fontsize')) ttsEl('tts-ap-fontsize').value = a.fontSize || 18;
    if (ttsEl('tts-ap-radius'))   ttsEl('tts-ap-radius').value   = a.radius != null ? a.radius : 16;
    if (ttsEl('tts-ap-duration')) ttsEl('tts-ap-duration').value = a.duration || 0;
    if (ttsEl('tts-ap-showicon')) ttsEl('tts-ap-showicon').checked = a.showIcon !== false;

    ttsRenderPreview();
}

function ttsReadFromForm() {
    const c = ttsConfig;
    c.defaultVoice = ttsEl('tts-default-voice').value;
    c.gapSeconds   = parseFloat(ttsEl('tts-gap').value)   || 0;
    c.maxChars     = parseInt(ttsEl('tts-maxchars').value) || 300;
    c.modelId      = ttsEl('tts-model').value;
    c.language     = {
        default: (ttsEl('tts-language-default').value || 'de').toLowerCase(),
        autoDetect: !!ttsEl('tts-language-autodetect').checked,
    };

    c.bits.enabled  = ttsEl('tts-bits-enabled').checked;
    c.bits.minBits  = parseInt(ttsEl('tts-bits-min').value) || 0;
    c.bits.voice    = ttsEl('tts-bits-voice').value;
    c.bits.template = ttsEl('tts-bits-template').value;

    c.resubs.enabled  = ttsEl('tts-resub-enabled').checked;
    c.resubs.minTier  = parseInt(ttsEl('tts-resub-mintier').value) || 1;
    c.resubs.voice    = ttsEl('tts-resub-voice').value;
    c.resubs.template = ttsEl('tts-resub-template').value;

    c.redeems.enabled     = ttsEl('tts-redeem-enabled').checked;
    c.redeems.rewardTitle = ttsEl('tts-redeem-title').value;
    c.redeems.rewardId    = ttsEl('tts-redeem-id').value.trim();
    c.redeems.voice       = ttsEl('tts-redeem-voice').value;
    c.redeems.template    = ttsEl('tts-redeem-template').value;

    if (!c.gifs) c.gifs = { enabled: true, bits: [], resubs: [], redeems: [] };
    if (ttsEl('tts-gifs-enabled')) c.gifs.enabled = ttsEl('tts-gifs-enabled').checked;

    // Appearance
    const alpha = parseFloat(ttsEl('tts-ap-bg-opacity').value);
    c.appearance = {
        position: ttsEl('tts-ap-position').value,
        accent:   ttsEl('tts-ap-accent').value,
        bg:       ttsHexToRgba(ttsEl('tts-ap-bg').value, isNaN(alpha) ? 0.92 : alpha),
        text:     ttsEl('tts-ap-text').value,
        fontSize: parseInt(ttsEl('tts-ap-fontsize').value) || 18,
        radius:   parseInt(ttsEl('tts-ap-radius').value) || 0,
        duration: parseFloat(ttsEl('tts-ap-duration').value) || 0,
        showIcon: ttsEl('tts-ap-showicon').checked,
    };
    if (ttsEl('tts-ap-bg-opacity-val')) ttsEl('tts-ap-bg-opacity-val').textContent = (isNaN(alpha)?0.92:alpha).toFixed(2);
}

// ── Live preview of the alert box ─────────────────────────────────────────────
const TTS_PREVIEW_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 7v10l8 5 8-5V7l-8-5zm0 2.3L17.5 8 12 11.7 6.5 8 12 4.3z"/></svg>';
function ttsRenderPreview() {
    const a = ttsConfig.appearance || {};
    const alert = ttsEl('tts-preview-alert');
    const stage = ttsEl('tts-preview-stage');
    if (!alert || !stage) return;
    alert.style.setProperty('--accent', a.accent || '#9146ff');
    alert.style.setProperty('--bg', a.bg || 'rgba(20,16,40,0.92)');
    alert.style.setProperty('--text', a.text || '#ffffff');
    alert.style.setProperty('--radius', (a.radius != null ? a.radius : 16) + 'px');
    alert.style.fontSize = (a.fontSize || 18) + 'px';
    const pos = a.position || 'bottom-center';
    stage.style.justifyContent = pos.includes('left') ? 'flex-start' : pos.includes('right') ? 'flex-end' : 'center';
    const icon = ttsEl('tts-preview-icon');
    if (icon) {
        icon.style.display = (a.showIcon === false) ? 'none' : '';
        icon.innerHTML = TTS_PREVIEW_ICON;
    }
}

// Debounced save
let _ttsSaveTimer = null;
function ttsScheduleSave() {
    ttsReadFromForm();
    ttsRenderPreview();
    clearTimeout(_ttsSaveTimer);
    _ttsSaveTimer = setTimeout(ttsSaveConfig, 600);
}

// ── Copy overlay link (points to tts.html) ───────────────────────────────────
function ttsCopyOverlayLink() {
    const url = new URL('tts.html', window.location.href);
    const key = ttsChannelKey();
    if (key) url.searchParams.set('channel', key);
    navigator.clipboard.writeText(url.toString()).then(() => {
        const btn = ttsEl('tts-copy-link');
        if (!btn) return;
        const original = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
        setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = original; }, 2000);
    }).catch(() => {
        alert('Could not copy — here is the overlay URL:\n\n' + url.toString());
    });
}

// ── Queue view ────────────────────────────────────────────────────────────────
const TTS_KIND_LABEL = { bits: 'Bits', resub: 'Resub', redeem: 'Redeem', manual: 'Test' };
function ttsEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function ttsTimeAgo(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return Math.max(1, Math.floor(d/1000)) + 's ago';
    if (d < 3600000) return Math.floor(d/60000) + 'm ago';
    return Math.floor(d/3600000) + 'h ago';
}
function ttsQueueItemHtml(it) {
    const kind = it.kind || 'manual';
    return `
        <div class="tts-queue-item status-${it.status || 'queued'}" data-id="${it.id}">
            <div class="tts-queue-item-head">
                <span class="tts-queue-who">${ttsEscape(it.user || 'Someone')}</span>
                <span class="tts-queue-badge kind-${kind}">${TTS_KIND_LABEL[kind] || kind}</span>
            </div>
            <div class="tts-queue-text">${ttsEscape(it.spoken)}</div>
            <div class="tts-queue-meta">
                <span><span class="tts-queue-status-dot"></span>${it.status || 'queued'}</span>
                <span>${ttsEscape(it.voiceName || '')}</span>
                <span>${ttsTimeAgo(it.ts || Date.now())}</span>
            </div>
        </div>`;
}
function ttsRenderQueue(list) {
    const wrap = ttsEl('tts-queue-list');
    const empty = ttsEl('tts-queue-empty');
    if (!wrap) return;
    if (!list.length) {
        wrap.innerHTML = '<div class="tts-queue-empty" id="tts-queue-empty">No requests yet.</div>';
        return;
    }
    if (empty) empty.remove();
    wrap.innerHTML = list.map(ttsQueueItemHtml).join('');
}
async function ttsLoadQueue() {
    try {
        const res = await fetch(ttsApi('/api/tts/queue'));
        const data = await res.json();
        ttsRenderQueue(data.requests || []);
    } catch (e) { console.warn('[tts-cfg] queue load failed:', e.message); }
}
// Apply a live queue event (add or status update) without a full reload.
function ttsApplyQueueEvent(action, item) {
    const wrap = ttsEl('tts-queue-list');
    if (!wrap) return;
    const empty = ttsEl('tts-queue-empty');
    if (empty) empty.remove();
    const existing = wrap.querySelector(`.tts-queue-item[data-id="${item.id}"]`);
    if (existing) {
        existing.outerHTML = ttsQueueItemHtml(item);
    } else if (action === 'add') {
        wrap.insertAdjacentHTML('afterbegin', ttsQueueItemHtml(item));
        const items = wrap.querySelectorAll('.tts-queue-item');
        if (items.length > 60) items[items.length - 1].remove();
    }
}

// ── SSE for the config page (queue feed only; no audio here) ─────────────────
let _ttsCfgSSE = null;

function ttsConnectSSE() {
    if (_ttsCfgSSE) return;
    try {
        _ttsCfgSSE = new EventSource(ttsApi('/api/tts/stream'));
        _ttsCfgSSE.onmessage = (ev) => {
            let msg; try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'queue' && msg.item) ttsApplyQueueEvent(msg.action, msg.item);
        };
        _ttsCfgSSE.onerror = () => { /* auto-reconnects */ };
    } catch (e) { console.warn('[tts-cfg] SSE failed:', e.message); }
}

// ── Sub-tab switching + hiding the center chat preview on the TTS tab ────────
function ttsShowSubtab(name) {
    document.querySelectorAll('.tts-subtab').forEach(b => b.classList.toggle('active', b.dataset.subtab === name));
    const cust = ttsEl('tts-sub-customize');
    const queue = ttsEl('tts-sub-queue');
    if (cust)  cust.style.display  = (name === 'customize') ? 'flex' : 'none';
    if (queue) queue.style.display = (name === 'queue') ? 'flex' : 'none';
    if (name === 'queue') ttsLoadQueue();
}

// Show/hide the center preview column depending on the active right-panel tab.
function ttsUpdateCenterPreview() {
    const previewCol = document.querySelector('.config-preview');
    // Keep layout stable when switching to TTS; do not collapse the middle pane.
    if (previewCol) previewCol.style.display = '';
}

// ── Alert GIFs: a list per event type; the overlay picks one at random ───────
const TTS_GIF_EVENTS = ['bits', 'resubs', 'redeems'];

function ttsRenderGifGalleries() {
    TTS_GIF_EVENTS.forEach(ev => {
        const gallery = ttsEl(`tts-gif-${ev}-gallery`);
        if (!gallery) return;
        const list = (ttsConfig.gifs && ttsConfig.gifs[ev]) || [];
        gallery.innerHTML = '';
        if (!list.length) {
            gallery.innerHTML = '<span class="hint">No GIFs yet.</span>';
            return;
        }
        list.forEach((url, idx) => {
            const thumb = document.createElement('div');
            thumb.className = 'img-thumb';
            const img = document.createElement('img');
            img.src = url;
            const btn = document.createElement('button');
            btn.className = 'img-thumb-remove';
            btn.textContent = '✕';
            btn.title = 'Remove GIF';
            btn.addEventListener('click', async () => {
                ttsConfig.gifs[ev].splice(idx, 1);
                ttsRenderGifGalleries();
                ttsSaveConfig();
                if (url && url.startsWith('/uploads/images/')) {
                    try {
                        await fetch('/api/delete/image', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url }),
                        });
                    } catch {}
                }
            });
            thumb.appendChild(img);
            thumb.appendChild(btn);
            gallery.appendChild(thumb);
        });
    });
}

function ttsWireGifUploads() {
    TTS_GIF_EVENTS.forEach(ev => {
        const input = ttsEl(`tts-gif-${ev}-upload`);
        if (!input) return;
        input.addEventListener('change', async e => {
            const files = Array.from(e.target.files);
            if (!files.length) return;
            if (!ttsConfig.gifs) ttsConfig.gifs = { enabled: true, bits: [], resubs: [], redeems: [] };
            if (!Array.isArray(ttsConfig.gifs[ev])) ttsConfig.gifs[ev] = [];

            for (const file of files) {
                try {
                    const buffer = await file.arrayBuffer();
                    const res = await fetch('/api/upload/image?channel=' + encodeURIComponent('tts-gifs-' + (ttsChannelKey() || 'default')), {
                        method: 'POST',
                        headers: {
                            'Content-Type': file.type || 'application/octet-stream',
                            'X-Filename': encodeURIComponent(file.name),
                        },
                        body: buffer,
                    });
                    const data = await res.json();
                    if (!data.ok) throw new Error(data.error);
                    ttsConfig.gifs[ev].push(data.url);
                } catch (err) {
                    alert('GIF upload failed (' + file.name + '): ' + err.message);
                }
            }
            e.target.value = '';
            ttsRenderGifGalleries();
            ttsSaveConfig();
        });
    });
}

function ttsWireControls() {
    const ids = [
        'tts-default-voice', 'tts-gap', 'tts-maxchars', 'tts-model', 'tts-language-default', 'tts-language-autodetect',
        'tts-gifs-enabled',
        'tts-bits-enabled', 'tts-bits-min', 'tts-bits-voice', 'tts-bits-template',
        'tts-resub-enabled', 'tts-resub-mintier', 'tts-resub-voice', 'tts-resub-template',
        'tts-redeem-enabled', 'tts-redeem-title', 'tts-redeem-id', 'tts-redeem-voice', 'tts-redeem-template',
        'tts-ap-position', 'tts-ap-accent', 'tts-ap-bg', 'tts-ap-bg-opacity',
        'tts-ap-text', 'tts-ap-fontsize', 'tts-ap-radius', 'tts-ap-duration', 'tts-ap-showicon',
    ];
    ids.forEach(id => {
        const el = ttsEl(id);
        if (!el) return;
        el.addEventListener('input', ttsScheduleSave);
        if (el.tagName === 'SELECT' || el.type === 'checkbox') el.addEventListener('change', ttsScheduleSave);
    });

    const connectBtn = ttsEl('tts-connect-btn');
    if (connectBtn) connectBtn.addEventListener('click', () => {
        window.open(ttsApi('/api/tts/oauth/start'), '_blank', 'width=600,height=800');
    });
    const reconnectBtn = ttsEl('tts-reconnect-btn');
    if (reconnectBtn) reconnectBtn.addEventListener('click', async () => {
        reconnectBtn.textContent = '⟳ Connecting…';
        reconnectBtn.disabled = true;
        try {
            const res = await fetch(ttsApi('/api/tts/eventsub/connect'), { method: 'POST' });
            const data = await res.json();
            reconnectBtn.textContent = data.ok ? '⟳ Reconnect EventSub' : '✗ ' + data.error;
            if (data.ok) setTimeout(ttsRefreshStatus, 3000);
        } catch (e) {
            reconnectBtn.textContent = '✗ Failed';
        } finally {
            setTimeout(() => { reconnectBtn.textContent = '⟳ Reconnect EventSub'; reconnectBtn.disabled = false; }, 4000);
        }
    });
    const refreshBtn = ttsEl('tts-refresh-btn');
    if (refreshBtn) refreshBtn.addEventListener('click', ttsRefreshStatus);

    const copyBtn = ttsEl('tts-copy-link');
    if (copyBtn) copyBtn.addEventListener('click', ttsCopyOverlayLink);

    ttsWireGifUploads();

    const queueRefresh = ttsEl('tts-queue-refresh');
    if (queueRefresh) queueRefresh.addEventListener('click', ttsLoadQueue);

    document.querySelectorAll('.tts-subtab').forEach(btn => {
        btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ttsShowSubtab(btn.dataset.subtab);
        });
    });

    // Hook the existing right-panel tab buttons to toggle the center preview.
    document.querySelectorAll('.panel-tab[data-tab]').forEach(btn => {
        btn.addEventListener('click', () => setTimeout(ttsUpdateCenterPreview, 0));
    });

    const testBtn = ttsEl('tts-test-btn');
    if (testBtn) testBtn.addEventListener('click', async () => {
        const result = ttsEl('tts-test-result');
        const text = ttsEl('tts-test-text').value.trim();
        if (!text) { result.textContent = 'Enter some text first.'; return; }
        const stored = sessionStorage.getItem('account');
        if (!stored) { result.textContent = 'Not logged in — log in first.'; return; }
        const acc = JSON.parse(stored);
        result.textContent = 'Sending…';
        try {
            // First, show how the voice tag resolves so a mismatch is obvious.
            let voiceInfo = '';
            try {
                const r = await fetch(ttsApi('/api/tts/voices/resolve?text=' + encodeURIComponent(text)));
                const rd = await r.json();
                voiceInfo = ` — voice: ${rd.voiceName || '(default)'}`;
            } catch {}
            const res = await fetch('/api/tts/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: acc.username,
                    password: acc.password,
                    text,
                    kind: 'redeem',
                    reward: 'Test Redeem',
                }),
            });
            const data = await res.json();
            if (data.ok) result.textContent = `Queued redeem ✓ (queue ${data.queueLength})${voiceInfo}. Audio plays on the overlay page.`;
            else         result.textContent = 'Error: ' + (data.error || res.status);
        } catch (e) { result.textContent = 'Failed: ' + e.message; }
    });

    const testRedeemsBtn = ttsEl('tts-test-redeems-btn');
    if (testRedeemsBtn) testRedeemsBtn.addEventListener('click', async () => {
        const result = ttsEl('tts-test-result');
        const stored = sessionStorage.getItem('account');
        if (!stored) { result.textContent = 'Not logged in - log in first.'; return; }
        const acc = JSON.parse(stored);
        result.textContent = 'Sending test redeems...';
        try {
            const res = await fetch('/api/tts/test-redeems', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: acc.username, password: acc.password }),
            });
            const data = await res.json();
            if (data.ok) result.textContent = `Queued ${data.added} redeem tests ✓ (queue length ${data.queueLength}). Audio plays on the redeem overlay page.`;
            else         result.textContent = 'Error: ' + (data.error || res.status);
        } catch (e) { result.textContent = 'Failed: ' + e.message; }
    });

    const rewardListBtn = ttsEl('tts-redeem-list-btn');
    if (rewardListBtn) rewardListBtn.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const wrap = ttsEl('tts-reward-list');
        if (!wrap) return;
        wrap.innerHTML = '<div class="hint">Loading rewards...</div>';
        try {
            const res = await fetch(ttsApi('/api/tts/rewards'));
            const data = await res.json();
            if (!res.ok || !data.ok) {
                wrap.innerHTML = `<div class="hint">${ttsEscape(data.error || ('Error ' + res.status))}</div>`;
                return;
            }
            const rewards = data.rewards || [];
            if (!rewards.length) {
                wrap.innerHTML = '<div class="hint">No custom rewards found.</div>';
                return;
            }
            wrap.innerHTML = '';
            rewards.forEach(r => {
                const row = document.createElement('div');
                row.className = 'tts-reward-row';

                const name = document.createElement('span');
                name.className = 'name';
                name.textContent = `${r.title} (${r.id})`;

                const pick = document.createElement('button');
                pick.className = 'pick';
                pick.textContent = 'Use ID';
                pick.type = 'button';
                pick.addEventListener('click', () => {
                    if (ttsEl('tts-redeem-id')) ttsEl('tts-redeem-id').value = r.id;
                    if (ttsEl('tts-redeem-title')) ttsEl('tts-redeem-title').value = r.title || '';
                    ttsScheduleSave();
                });

                row.appendChild(name);
                row.appendChild(pick);
                wrap.appendChild(row);
            });
        } catch (e) {
            wrap.innerHTML = `<div class="hint">Failed: ${ttsEscape(e.message)}</div>`;
        }
    });
}

// ── TTS access gate: accounts without ttsAccess never see the TTS UI ─────────
function ttsAccountHasAccess() {
    try {
        const stored = sessionStorage.getItem('account');
        if (!stored) return false;
        return !!JSON.parse(stored).ttsAccess;
    } catch { return false; }
}

function ttsRemoveUiForNoAccess() {
    const tabBtn = document.querySelector('.panel-tab[data-tab="tts"]');
    if (tabBtn) tabBtn.remove();
    const tabContent = ttsEl('tab-tts');
    if (tabContent) tabContent.remove();
}

// ── Init the TTS tab once the DOM is ready ───────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    if (!ttsEl('tab-tts')) return;
    if (!ttsAccountHasAccess()) {
        // No TTS access → remove the tab button and its content entirely.
        ttsRemoveUiForNoAccess();
        return;
    }
    await ttsLoadConfig();
    ttsApplyToForm();
    ttsWireControls();
    ttsShowSubtab('customize');
    ttsUpdateCenterPreview();
    await ttsLoadVoices();
    ttsRefreshStatus();
    setInterval(ttsRefreshStatus, 10000);
    ttsConnectSSE();
});
