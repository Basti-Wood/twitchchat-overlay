// Read channel from URL: add ?channel=yourchannelname to the browser source URL
// For full badge support (subscriber tiers, bits, founder…) also add:
//   &token=YOUR_OAUTH_TOKEN
// Get a free token at https://twitchapps.com/tmi/ — paste the whole thing
// (with or without the 'oauth:' prefix).
const params = new URLSearchParams(window.location.search);
const channel    = (params.get('channel') || '').toLowerCase();
const rawToken   = params.get('token') || '';
const oauthToken = rawToken.replace(/^oauth:/i, ''); // strip prefix if present

const chatContainer = document.querySelector('.chat');
const MAX_MESSAGES  = 10;

let overlaySlideDirection = 'right';
let overlayBubbleImages   = [];
let last_image_used       = null;

// Auth state — populated by initAuth() when a token is provided
let authHeaders  = null;
// Helix badge map: 'setId/version' -> image URL (populated from Twitch API)
const helixBadgeMap = new Map();

// === Badge image URLs (static-cdn.jtvnw.net — no API needed, verified working) ===
// badges.twitch.tv is decommissioned; the Helix API requires OAuth.
// All UUIDs below were verified against the CDN on 2026-05-16.
const BADGE_URLS = {
    'broadcaster/1':  'https://static-cdn.jtvnw.net/badges/v1/5527c58c-fb7d-422d-b71b-f309dcb85cc1/2',
    'moderator/1':    'https://static-cdn.jtvnw.net/badges/v1/3267646d-33f0-4b17-b3df-f923a41db1d0/2',
    'vip/1':          'https://static-cdn.jtvnw.net/badges/v1/b817aba4-fad8-49e2-b88a-7cc744dfa6ec/2',
    'partner/1':      'https://static-cdn.jtvnw.net/badges/v1/d12a2e27-16f6-41d0-ab77-b780518f00a3/2',
    'turbo/1':        'https://static-cdn.jtvnw.net/badges/v1/bd444ec6-8f34-4bf9-91f4-af1e3428d80f/2',
    'premium/1':      'https://static-cdn.jtvnw.net/badges/v1/a1dd5073-19c3-4911-8cb4-c464a7bc1510/2',
    'global_mod/1':   'https://static-cdn.jtvnw.net/badges/v1/9ef7e029-4cdf-4d4d-a0d5-e2b3fb2583fe/2',
    'artist-badge/1': 'https://static-cdn.jtvnw.net/badges/v1/4300a897-03dc-4e83-8c0e-c332fee7057f/2',
    // Subscriber: channel-custom badges can't be fetched without OAuth,
    // so any subscriber version falls back to this generic badge.
    'subscriber/0':   'https://static-cdn.jtvnw.net/badges/v1/5d9f2208-5dd8-11e7-8513-2ff4adfae661/2',
};

const emoteMap = new Map(); // word -> image URL

// === Color utility ===
function getLuminance(hex) {
    if (!hex || hex.length < 7) return 0;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const lin = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrastColor(hex) {
    return getLuminance(hex) > 0.179 ? '#000000' : '#ffffff';
}

// === IRC parsing ===

function parseTags(tagStr) {
    const tags = {};
    if (!tagStr) return tags;
    tagStr.split(';').forEach(part => {
        const eq = part.indexOf('=');
        if (eq !== -1) tags[part.slice(0, eq)] = part.slice(eq + 1);
    });
    return tags;
}

// "broadcaster/1,subscriber/6" -> { broadcaster: '1', subscriber: '6' }
function parseBadges(badgeStr) {
    const result = {};
    if (!badgeStr) return result;
    badgeStr.split(',').forEach(b => {
        const slash = b.indexOf('/');
        if (slash !== -1) result[b.slice(0, slash)] = b.slice(slash + 1);
    });
    return result;
}

// "25:0-4,12-16/1902:6-10" -> { '25': ['0-4', '12-16'], '1902': ['6-10'] }
function parseEmotes(emoteStr) {
    const result = {};
    if (!emoteStr) return result;
    emoteStr.split('/').forEach(part => {
        const colon = part.indexOf(':');
        if (colon !== -1) {
            const id  = part.slice(0, colon);
            const pos = part.slice(colon + 1).split(',');
            result[id] = pos;
        }
    });
    return result;
}

function parseIRC(raw) {
    let pos = 0;
    let tags = {};

    if (raw[0] === '@') {
        const space = raw.indexOf(' ');
        tags = parseTags(raw.slice(1, space));
        pos = space + 1;
    }

    let prefixLogin = '';
    if (raw[pos] === ':') {
        const spaceIdx = raw.indexOf(' ', pos);
        const prefix = raw.slice(pos + 1, spaceIdx); // e.g. "user!user@user.tmi.twitch.tv"
        const bangIdx = prefix.indexOf('!');
        if (bangIdx !== -1) prefixLogin = prefix.slice(0, bangIdx).toLowerCase();
        pos = spaceIdx + 1;
    }

    const cmdEnd = raw.indexOf(' ', pos);
    const command = raw.slice(pos, cmdEnd);
    pos = cmdEnd + 1;

    if (command === 'ROOMSTATE') {
        return { type: 'roomstate', roomId: tags['room-id'] || '' };
    }

    if (command === 'CLEARMSG') {
        return { type: 'clearmsg', targetMsgId: tags['target-msg-id'] || '' };
    }

    if (command === 'CLEARCHAT') {
        const colonIdx = raw.indexOf(':', pos);
        const targetUser = colonIdx !== -1 ? raw.slice(colonIdx + 1).trim() : null;
        return { type: 'clearchat', targetUser: targetUser || null };
    }

    if (command !== 'PRIVMSG') return null;

    const colonIdx = raw.indexOf(':', pos);
    if (colonIdx === -1) return null;
    const text = raw.slice(colonIdx + 1);

    return {
        type:   'message',
        id:     tags['id']           || '',
        login:  prefixLogin,
        nick:   tags['display-name'] || 'unknown',
        color:  tags['color']        || '#9146FF',
        badges: parseBadges(tags['badges']),
        emotes: parseEmotes(tags['emotes']),
        text,
    };
}

// === Badge auth + Helix loading ===

/**
 * Validate the OAuth token and extract the client_id Twitch paired it with.
 * Populates authHeaders so Helix calls can be made.
 */
async function initAuth() {
    if (!oauthToken) return;
    try {
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { 'Authorization': `OAuth ${oauthToken}` },
        });
        if (!res.ok) { console.warn('Badge token validation failed — badges will use fallback images.'); return; }
        const { client_id } = await res.json();
        authHeaders = {
            'Authorization': `Bearer ${oauthToken}`,
            'Client-Id': client_id,
        };
        console.log('Twitch badge auth ready');
    } catch (e) { console.warn('Auth init failed:', e); }
}

/**
 * Fetch badge data from a Helix endpoint and populate helixBadgeMap.
 * Works for both /global and /channel (broadcaster_id) endpoints.
 */
async function loadHelixBadges(url) {
    if (!authHeaders) return;
    try {
        const res = await fetch(url, { headers: authHeaders });
        if (!res.ok) return;
        const { data } = await res.json();
        for (const set of data) {
            for (const v of set.versions) {
                helixBadgeMap.set(`${set.set_id}/${v.id}`, v.image_url_2x);
            }
        }
    } catch (e) { console.warn('Helix badge load failed:', e); }
}

// === Badge lookup ===
function getBadgeUrl(setId, version) {
    const key = `${setId}/${version}`;
    // 1. Helix API data (full channel-specific badges: subscriber tiers, bits, etc.)
    if (helixBadgeMap.has(key)) return helixBadgeMap.get(key);
    // 2. Helix fallback: same set, lower version
    const key1 = `${setId}/1`, key0 = `${setId}/0`;
    if (helixBadgeMap.size > 0) {
        if (helixBadgeMap.has(key1)) return helixBadgeMap.get(key1);
        if (helixBadgeMap.has(key0)) return helixBadgeMap.get(key0);
    }
    // 3. Hardcoded CDN URLs (global badges, always available without auth)
    return BADGE_URLS[key] ?? BADGE_URLS[`${setId}/1`] ?? BADGE_URLS[`${setId}/0`] ?? null;
}

// === Emote loading ===
async function loadBTTVGlobal() {
    try {
        const res = await fetch('https://api.betterttv.net/3/cached/emotes/global');
        const emotes = await res.json();
        emotes.forEach(e => emoteMap.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`));
    } catch (e) { console.warn('BTTV global failed:', e); }
}

async function loadBTTVChannel(channelId) {
    try {
        const res = await fetch(`https://api.betterttv.net/3/cached/users/twitch/${channelId}`);
        const data = await res.json();
        [...(data.channelEmotes || []), ...(data.sharedEmotes || [])].forEach(
            e => emoteMap.set(e.code, `https://cdn.betterttv.net/emote/${e.id}/2x`)
        );
    } catch (e) { console.warn('BTTV channel failed:', e); }
}

async function loadFFZGlobal() {
    try {
        const res = await fetch('https://api.frankerfacez.com/v1/set/global');
        const data = await res.json();
        Object.values(data.sets || {}).forEach(set => {
            (set.emoticons || []).forEach(e => {
                const raw = e.urls['2'] || e.urls['1'];
                if (raw) emoteMap.set(e.name, raw.startsWith('//') ? 'https:' + raw : raw);
            });
        });
    } catch (e) { console.warn('FFZ global failed:', e); }
}

async function loadFFZChannel(channelName) {
    try {
        const res = await fetch(`https://api.frankerfacez.com/v1/room/${channelName}`);
        if (!res.ok) return; // channel not on FFZ — silently skip
        const data = await res.json();
        Object.values(data.sets || {}).forEach(set => {
            (set.emoticons || []).forEach(e => {
                const raw = e.urls['2'] || e.urls['1'];
                if (raw) emoteMap.set(e.name, raw.startsWith('//') ? 'https:' + raw : raw);
            });
        });
    } catch (e) { console.warn('FFZ channel failed:', e); }
}

async function load7TVGlobal() {
    try {
        const res = await fetch('https://7tv.io/v3/emote-sets/global');
        const data = await res.json();
        (data.emotes || []).forEach(e => {
            emoteMap.set(e.name, `https://cdn.7tv.app/emote/${e.data.id}/2x.webp`);
        });
    } catch (e) { console.warn('7TV global failed:', e); }
}

async function load7TVChannel(channelId) {
    try {
        const res = await fetch(`https://7tv.io/v3/users/twitch/${channelId}`);
        const data = await res.json();
        (data.emote_set?.emotes || []).forEach(e => {
            emoteMap.set(e.name, `https://cdn.7tv.app/emote/${e.data.id}/2x.webp`);
        });
    } catch (e) { console.warn('7TV channel failed:', e); }
}

// === Rendering ===

function renderBadges(badges) {
    const frag = document.createDocumentFragment();
    for (const [setId, version] of Object.entries(badges)) {
        const url = getBadgeUrl(setId, String(version));
        if (!url) continue;
        const img = document.createElement('img');
        img.src = url;
        img.alt = setId;
        img.className = 'badge';
        frag.appendChild(img);
    }
    return frag;
}

function appendTextSegment(frag, text) {
    const words = text.split(' ');
    words.forEach((word, i) => {
        const url = emoteMap.get(word);
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = word;
            img.className = 'emote';
            frag.appendChild(img);
        } else {
            frag.appendChild(document.createTextNode(word));
        }
        if (i < words.length - 1) frag.appendChild(document.createTextNode(' '));
    });
}

function isEmoteOnly(text, twitchEmotes) {
    // Mark character positions covered by native Twitch emotes
    const covered = new Set();
    for (const [, ranges] of Object.entries(twitchEmotes || {})) {
        for (const range of ranges) {
            const [start, end] = range.split('-').map(Number);
            for (let i = start; i <= end; i++) covered.add(i);
        }
    }

    // Collect text not covered by Twitch emotes, then check each word against
    // the third-party emote map (BTTV / FFZ / 7TV loaded into emoteMap).
    let hasAnyEmote = covered.size > 0;
    let remaining = '';
    for (let i = 0; i < text.length; i++) {
        if (!covered.has(i)) remaining += text[i];
    }
    for (const word of remaining.split(' ')) {
        if (word === '') continue;
        if (emoteMap.has(word)) { hasAnyEmote = true; continue; }
        return false; // plain text word found — not emote-only
    }
    return hasAnyEmote; // true only when at least one emote was present
}

function renderMessage(text, twitchEmotes) {
    const replacements = [];
    for (const [id, ranges] of Object.entries(twitchEmotes)) {
        for (const range of ranges) {
            const [start, end] = range.split('-').map(Number);
            replacements.push({ start, end, id });
        }
    }
    replacements.sort((a, b) => a.start - b.start);

    const frag = document.createDocumentFragment();
    let cursor = 0;

    for (const { start, end, id } of replacements) {
        if (start > cursor) appendTextSegment(frag, text.slice(cursor, start));
        const img = document.createElement('img');
        img.src = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;
        img.alt = text.slice(start, end + 1);
        img.className = 'emote';
        frag.appendChild(img);
        cursor = end + 1;
    }

    if (cursor < text.length) appendTextSegment(frag, text.slice(cursor));
    return frag;
}

function deleteMessage(targetMsgId) {
    if (!targetMsgId) return;
    const el = chatContainer.querySelector(`[data-msg-id="${CSS.escape(targetMsgId)}"]`);
    if (el) el.remove();
}

function clearUserMessages(loginName) {
    if (!loginName) {
        // Full /clear — wipe everything
        while (chatContainer.firstChild) chatContainer.removeChild(chatContainer.firstChild);
        return;
    }
    chatContainer
        .querySelectorAll(`[data-user="${CSS.escape(loginName.toLowerCase())}"]`)
        .forEach(el => el.remove());
}

function addMessage(msg) {
    const row = document.createElement('div');
    row.className = `chat-message slide-in-${overlaySlideDirection}`;
    if (msg.id)    row.dataset.msgId = msg.id;
    if (msg.login) row.dataset.user  = msg.login.toLowerCase();

    const usernameRow = document.createElement('div');
    usernameRow.className = 'username-row';
    usernameRow.style.backgroundColor = msg.color;
    usernameRow.appendChild(renderBadges(msg.badges));

    const nameSpan = document.createElement('span');
    nameSpan.className = 'username';
    nameSpan.textContent = msg.nick;
    nameSpan.style.color = contrastColor(msg.color);
    usernameRow.appendChild(nameSpan);

    const msgBox = document.createElement('div');
    msgBox.className = 'message-box' + (isEmoteOnly(msg.text, msg.emotes) ? ' emote-only' : '');
    if (overlayBubbleImages.length > 0) {
        let ri;
        if (overlayBubbleImages.length > 1) {
            do {
                ri = overlayBubbleImages[Math.floor(Math.random() * overlayBubbleImages.length)];
            } while (ri === last_image_used);
        } else {
            ri = overlayBubbleImages[0];
        }
        last_image_used = ri;
        msgBox.style.backgroundImage    = `url("${ri}")`;
        msgBox.style.backgroundSize     = 'cover';
        msgBox.style.backgroundPosition = 'center';
    }
    msgBox.appendChild(renderMessage(msg.text, msg.emotes));

    row.appendChild(usernameRow);
    row.appendChild(msgBox);
    chatContainer.appendChild(row);

    while (chatContainer.children.length > MAX_MESSAGES) {
        chatContainer.removeChild(chatContainer.firstChild);
    }
}

// === Load config from conf/config.json (for cross-browser-context persistence) ===
async function loadConfigFile() {
    try {
        // Add a cache-bust param so OBS doesn't serve a stale cached version
        const res = await fetch('../conf/config.json?_=' + Date.now());
        if (!res.ok) {
            console.warn('[overlay] config.json fetch failed:', res.status);
            return;
        }
        const data = await res.json();
        const fileCfg = data?.config?.[channel];
        if (fileCfg && typeof fileCfg === 'object') {
            // File config is always authoritative — merge over any cached localStorage values
            const key = 'overlayConfig_' + channel;
            const existing = localStorage.getItem(key);
            const merged = { ...(existing ? JSON.parse(existing) : {}), ...fileCfg };
            localStorage.setItem(key, JSON.stringify(merged));
        } else {
            console.warn('[overlay] config.json has no entry for channel:', channel,
                '— available keys:', Object.keys(data?.config ?? {}));
        }
    } catch (e) {
        console.warn('[overlay] Could not load config.json (using localStorage fallback):', e.message);
    }
}

// === Overlay style config ===
function applyOverlayConfig() {
    const raw = localStorage.getItem('overlayConfig_' + channel);
    if (!raw) return;
    let cfg;
    try { cfg = JSON.parse(raw); } catch { return; }

    // Update slide direction and bubble images for future messages
    overlaySlideDirection = cfg.slideDirection || 'right';
    overlayBubbleImages   = Array.isArray(cfg.bubbleImages) ? cfg.bubbleImages : [];

    let css = '';

    if (cfg.bubbleColor) {
        const r = parseInt(cfg.bubbleColor.slice(1, 3), 16);
        const g = parseInt(cfg.bubbleColor.slice(3, 5), 16);
        const b = parseInt(cfg.bubbleColor.slice(5, 7), 16);
        const a = cfg.bubbleOpacity ?? 0.882;
        css += `.message-box { background-color: rgba(${r},${g},${b},${a}) !important; }\n`;
    }
    if (cfg.textColor)
        css += `.message-box { color: ${cfg.textColor} !important; }\n`;
    // Only apply a global background-image rule when no image array is set.
    // When bubbleImages is non-empty, images are applied per-message inline in addMessage().
    if (cfg.bubbleImage && overlayBubbleImages.length === 0)
        css += `.message-box { background-image: url("${cfg.bubbleImage}") !important; background-size: cover !important; background-position: center !important; }\n`;
    if (cfg.fontSize)
        css += `body { font-size: ${cfg.fontSize}px !important; }\n`;
    if (cfg.nameBubbleMarginLeft != null)
        css += `.username-row { margin-left: ${cfg.nameBubbleMarginLeft}px !important; }\n`;
    if (cfg.nameBubbleMarginBottom != null)
        css += `.username-row { margin-bottom: ${cfg.nameBubbleMarginBottom}px !important; }\n`;
    if (cfg.msgBubbleMarginLeft != null)
        css += `.message-box { margin-left: ${cfg.msgBubbleMarginLeft}px !important; }\n`;

    if (cfg.fontFamily === '__custom__') {
        // Prefer server URL; fall back to legacy base64 data URL for old configs
        const fontSrc = cfg.customFontUrl || cfg.customFontDataUrl;
        if (cfg.customFontName && fontSrc) {
            css += `@font-face { font-family: '${cfg.customFontName}'; src: url('${fontSrc}'); }\n`;
            css += `body { font-family: '${cfg.customFontName}', sans-serif !important; }\n`;
        }
    } else if (cfg.fontFamily) {
        css += `body { font-family: ${cfg.fontFamily} !important; }\n`;
    }

    if (!css) return;
    // Upsert — update existing style element instead of appending a new one
    let style = document.getElementById('overlay-config-styles');
    if (!style) {
        style = document.createElement('style');
        style.id = 'overlay-config-styles';
        document.head.appendChild(style);
    }
    style.textContent = css;

    // Apply custom CSS override in its own element so it stays separate from generated styles
    let customStyle = document.getElementById('overlay-custom-css');
    if (!customStyle) {
        customStyle = document.createElement('style');
        customStyle.id = 'overlay-custom-css';
        document.head.appendChild(customStyle);
    }
    customStyle.textContent = cfg.customCSS || '';
}

// === WebSocket connection ===
async function init() {
    if (!channel) {
        console.warn('No channel specified. Add ?channel=yourchannelname to the URL.');
        return;
    }

    await loadConfigFile();
    applyOverlayConfig();
    // Poll every 3 s: re-fetch config.json so OBS always gets the latest saved config
    // (OBS localStorage is isolated from the config-page browser, so the file is the bridge)
    setInterval(async () => {
        await loadConfigFile();
        applyOverlayConfig();
    }, 3000);
    await initAuth();

    await Promise.allSettled([
        loadHelixBadges('https://api.twitch.tv/helix/chat/badges/global'),
        loadBTTVGlobal(),
        loadFFZGlobal(),
        loadFFZChannel(channel),
        load7TVGlobal(),
    ]);

    connect();
}

function connect() {
    const ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');

    ws.onopen = () => {
        ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
        ws.send('NICK justinfan12345');
        ws.send(`JOIN #${channel}`);
    };

    ws.onmessage = (event) => {
        event.data.split('\r\n').forEach(line => {
            if (!line) return;
            if (line.startsWith('PING')) {
                ws.send('PONG :tmi.twitch.tv');
                return;
            }
            const parsed = parseIRC(line);
            if (!parsed) return;

            if (parsed.type === 'roomstate' && parsed.roomId) {
                Promise.allSettled([
                    loadHelixBadges(`https://api.twitch.tv/helix/chat/badges?broadcaster_id=${parsed.roomId}`),
                    loadBTTVChannel(parsed.roomId),
                    load7TVChannel(parsed.roomId),
                ]);
            } else if (parsed.type === 'message') {
                addMessage(parsed);
            } else if (parsed.type === 'clearmsg') {
                deleteMessage(parsed.targetMsgId);
            } else if (parsed.type === 'clearchat') {
                clearUserMessages(parsed.targetUser);
            }
        });
    };

    ws.onclose = () => setTimeout(connect, 3000);
    ws.onerror = () => ws.close();
}

init();
