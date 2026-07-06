// ─────────────────────────────────────────────────────────────────────────────
//  TTS.js — TTS engine for the Twitch Chat Overlay
//
//  Responsibilities:
//   • Hold the Twitch EventSub WebSocket connection (bits, resubs, channel points)
//   • Manage the Twitch user-token OAuth flow (authorize once, refresh forever)
//   • Decide whether an incoming event is allowed to trigger TTS (thresholds)
//   • Synthesize speech via ElevenLabs (server-side; the API key never leaves here)
//   • Run a single global queue with a configurable gap between clips
//   • Hand finished audio to a "broadcast" callback (server.js pushes it over SSE)
//   • Keep a short request history for the config "Queue" view
//
//  No external npm dependencies — only Node core. Node 18-alpine (your Docker
//  base) ships a global fetch and a global WebSocket, so we use those directly.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const TWITCH_OAUTH = 'https://id.twitch.tv/oauth2';
const TWITCH_HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB_WS  = 'wss://eventsub.wss.twitch.tv/ws';
const ELEVEN_API   = 'https://api.elevenlabs.io/v1';

// Scopes required for the three event types we subscribe to.
//   bits         → bits:read
//   resubs       → channel:read:subscriptions
//   point redeem → channel:read:redemptions
const SCOPES = ['bits:read', 'channel:read:subscriptions', 'channel:read:redemptions'];

// ─────────────────────────────────────────────────────────────────────────────
//  Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(...a)  { console.log('[tts]', ...a); }
function warn(...a) { console.warn('[tts]', ...a); }

function norm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

function writeJSON(file, data) {
    try { fs.writeFileSync(file, JSON.stringify(data, null, 4), 'utf8'); }
    catch (e) { warn('writeJSON failed for', file, e.message); }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TTSEngine
// ─────────────────────────────────────────────────────────────────────────────

class TTSEngine {
    /**
     * One engine per streamer/channel. Each engine has its OWN Twitch OAuth
     * tokens, EventSub connection, queue, and settings (config.tts[channel]).
     *
     * @param {object} opts
     * @param {string} opts.root        project root dir
     * @param {string} opts.channel     channel key (lowercase) this engine belongs to
     * @param {object} opts.manager     TTSManager (shared ElevenLabs voice cache)
     * @param {function} opts.broadcast (payload) => void  — push to this channel's SSE clients
     */
    constructor({ root, broadcast, channel, manager }) {
        this.root      = root;
        this.channel   = String(channel || '').toLowerCase();
        this.manager   = manager || null;
        this.broadcast = broadcast || (() => {});

        this.confDir   = path.join(root, 'conf');
        this.audioDir  = path.join(root, 'uploads', 'tts');
        const suffix   = this.channel ? '.' + this.channel.replace(/[^a-z0-9_-]/g, '_') : '';
        this.tokenFile = path.join(this.confDir, `tokens${suffix}.json`);
        this.queueFile = path.join(this.confDir, `tts-queue${suffix}.json`);

        if (!fs.existsSync(this.audioDir)) fs.mkdirSync(this.audioDir, { recursive: true });

        // ── Twitch app credentials (from .env) ──
        this.clientId     = (process.env.TWITCH_CLIENT_ID     || '').trim();
        this.clientSecret = (process.env.TWITCH_CLIENT_SECRET || '').trim();
        // Where Twitch sends the user back after they authorize. Must EXACTLY
        // match a redirect URI registered in your Twitch dev console app.
        this.redirectUri  = (process.env.TWITCH_REDIRECT_URI  || 'http://localhost:8080/api/tts/oauth/callback').trim();

        // ── ElevenLabs ──
        this.elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();

        // ── Live token state ──
        this.tokens = readJSON(this.tokenFile, null); // { access, refresh, obtained, expires_in, login, user_id }

        // ── EventSub state ──
        this.ws            = null;
        this.sessionId     = null;
        this.keepaliveSecs = 30;
        this.reconnecting  = false;

        // ── Voice cache — shared across all engines via the manager ──
        this._voices = []; // only used when running without a manager

        // ── Queue ──
        this.queue      = [];     // [{ id, text, segments: [{voiceId, text}], meta, ts }]
        this.playing    = false;
        this.lastFinish = 0;
        this._seq       = 0;      // monotonically increasing request id

        // ── Recent-request history (for the config "Queue" view) ──
        // Newest last. Capped to keep memory bounded.
        this.history    = [];     // [{ id, kind, user, spoken, voiceName, status, ts }]
        this._current   = null;   // the item currently playing (history entry)

        // CSRF state for the OAuth round-trip
        this._oauthState = null;
        this._oauthRedirectUri = null;
    }

    // ── Config access — always read fresh so the config page edits take effect.
    //    TTS settings are PER CHANNEL: config.tts[<channel>] = { ... }. A legacy
    //    flat config.tts (pre per-user) is still readable as a fallback. ──
    get config() {
        const all = readJSON(path.join(this.confDir, 'config.json'), {});
        const tts = (all && all.tts) || {};
        if (this.channel && tts[this.channel] && typeof tts[this.channel] === 'object'
            && !Array.isArray(tts[this.channel])) {
            return tts[this.channel];
        }
        // Legacy flat shape (has setting keys directly on tts)
        if (tts.bits || tts.appearance || tts.defaultVoice !== undefined) return tts;
        return {};
    }

    // Shared ElevenLabs voice cache (loaded once by the manager).
    get voices() {
        return this.manager ? this.manager.voices : this._voices;
    }

    async loadVoices() {
        if (this.manager) return this.manager.loadVoices();
        return this._voices;
    }

    // Appearance sub-block for the visual alert overlay.
    get appearance() {
        return this.config.appearance || {};
    }

    get accounts() {
        const a = readJSON(path.join(this.confDir, 'accounts.json'), { accounts: [] });
        return Array.isArray(a.accounts) ? a.accounts : [];
    }

    // Look up a voice name from an id (for nicer history/queue display).
    voiceNameFromId(id) {
        const v = this.voices.find(v => v.id === id);
        return v ? v.name : id;
    }

    _pushHistory(entry, keep = 60) {
        this.history.push(entry);
        if (this.history.length > keep) this.history.splice(0, this.history.length - keep);
    }

    // Shape sent to the client (Queue view) — small and safe.
    _publicHistEntry(e) {
        return {
            id: e.id, kind: e.kind, user: e.user,
            spoken: e.spoken, voiceName: e.voiceName,
            status: e.status, ts: e.ts,
        };
    }

    // Find a history entry by id.
    _histById(id) { return this.history.find(h => h.id === id); }

    // ───────────────────────────────────────────────────────────────────────
    //  OAuth: authorize once, then refresh automatically
    // ───────────────────────────────────────────────────────────────────────

    /** URL the streamer visits once to grant the scopes. */
    buildAuthUrl(redirectUriOverride) {
        if (!this.clientId) return null;
        this._oauthState = Math.random().toString(36).slice(2) + Date.now().toString(36);
        this._oauthRedirectUri = redirectUriOverride || this.redirectUri;
        const p = new URLSearchParams({
            client_id:     this.clientId,
            redirect_uri:  this._oauthRedirectUri,
            response_type: 'code',
            scope:         SCOPES.join(' '),
            state:         this._oauthState,
            force_verify:  'true',
        });
        return `${TWITCH_OAUTH}/authorize?${p.toString()}`;
    }

    /** Handle the ?code=…&state=… redirect. Returns { ok, error? }. */
    async handleOAuthCallback(code, state) {
        if (!code)                       return { ok: false, error: 'Missing code' };
        if (state !== this._oauthState)  return { ok: false, error: 'State mismatch (possible CSRF) — retry the authorize link' };

        try {
            const body = new URLSearchParams({
                client_id:     this.clientId,
                client_secret: this.clientSecret,
                code,
                grant_type:    'authorization_code',
                redirect_uri:  this._oauthRedirectUri || this.redirectUri,
            });
            const res = await fetch(`${TWITCH_OAUTH}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const data = await res.json();
            if (!res.ok) return { ok: false, error: data.message || JSON.stringify(data) };

            this.tokens = {
                access:     data.access_token,
                refresh:    data.refresh_token,
                expires_in: data.expires_in,
                obtained:   Date.now(),
            };
            // Validate to capture the login + user_id (needed for EventSub conditions).
            await this._validateAndStore();
            this.persistTokens();
            log('OAuth complete for', this.tokens.login, '(' + this.tokens.user_id + ')');

            // (Re)start EventSub now that we have a user token.
            this.startEventSub();
            return { ok: true, login: this.tokens.login };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    persistTokens() { writeJSON(this.tokenFile, this.tokens); }

    async _validateAndStore() {
        const res = await fetch(`${TWITCH_OAUTH}/validate`, {
            headers: { Authorization: `OAuth ${this.tokens.access}` },
        });
        if (!res.ok) throw new Error('Token validation failed (' + res.status + ')');
        const v = await res.json();
        this.tokens.login   = v.login;
        this.tokens.user_id = v.user_id;
        this.tokens.scopes  = v.scopes;
    }

    /** Refresh the access token using the stored refresh token. */
    async refreshAccessToken() {
        if (!this.tokens || !this.tokens.refresh) return false;
        try {
            const body = new URLSearchParams({
                client_id:     this.clientId,
                client_secret: this.clientSecret,
                grant_type:    'refresh_token',
                refresh_token: this.tokens.refresh,
            });
            const res = await fetch(`${TWITCH_OAUTH}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body,
            });
            const data = await res.json();
            if (!res.ok) { warn('refresh failed:', data.message || data); return false; }
            this.tokens.access     = data.access_token;
            this.tokens.refresh    = data.refresh_token || this.tokens.refresh;
            this.tokens.expires_in = data.expires_in;
            this.tokens.obtained   = Date.now();
            this.persistTokens();
            log('Access token refreshed');
            return true;
        } catch (e) { warn('refresh error:', e.message); return false; }
    }

    /** A valid bearer token, refreshing first if it's near expiry. */
    async getAccessToken() {
        if (!this.tokens) return null;
        const age     = Date.now() - (this.tokens.obtained || 0);
        const ttlMs   = (this.tokens.expires_in || 0) * 1000;
        if (ttlMs && age > ttlMs - 5 * 60 * 1000) await this.refreshAccessToken();
        return this.tokens.access;
    }

    helixHeaders(token) {
        return { Authorization: `Bearer ${token}`, 'Client-Id': this.clientId };
    }

    // ───────────────────────────────────────────────────────────────────────
    //  EventSub over WebSocket
    // ───────────────────────────────────────────────────────────────────────

    async startEventSub() {
        if (!this.tokens || !this.tokens.user_id) {
            warn('startEventSub: no user token yet — visit the authorize link first.');
            return;
        }
        if (typeof WebSocket === 'undefined') {
            warn('Global WebSocket not available in this Node runtime — EventSub disabled.');
            return;
        }
        this._connectEventSub(EVENTSUB_WS);
    }

    _connectEventSub(url) {
        try {
            this.ws = new WebSocket(url);
        } catch (e) {
            warn('EventSub connect threw:', e.message);
            this._scheduleReconnect();
            return;
        }

        this.ws.addEventListener('open', () => log('EventSub socket open'));

        this.ws.addEventListener('message', (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            this._onEventSubMessage(msg);
        });

        this.ws.addEventListener('close', () => {
            warn('EventSub socket closed — will reconnect');
            this.sessionId = null;  // mark offline so status is accurate
            this._scheduleReconnect();
        });

        this.ws.addEventListener('error', (e) => {
            warn('EventSub socket error:', e && e.message ? e.message : '(unknown)');
            try { this.ws.close(); } catch {}
        });
    }

    _scheduleReconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;
        setTimeout(() => {
            this.reconnecting = false;
            this.startEventSub();
        }, 5000);
    }

    /** Force-reconnect EventSub without needing to re-do OAuth. */
    async forceReconnect() {
        this.reconnecting = false;
        if (this.ws) {
            try { this.ws.close(); } catch {}
            this.ws = null;
        }
        this.sessionId = null;
        // Refresh the access token first in case it expired.
        if (this.tokens && this.tokens.refresh) {
            await this.refreshAccessToken();
        }
        this.startEventSub();
    }

    async _onEventSubMessage(msg) {
        const type = msg.metadata && msg.metadata.message_type;

        if (type === 'session_welcome') {
            this.sessionId     = msg.payload.session.id;
            this.keepaliveSecs = msg.payload.session.keepalive_timeout_seconds || 30;
            log('EventSub session', this.sessionId);
            await this._subscribeAll();
            return;
        }

        if (type === 'session_keepalive') return; // heartbeat — nothing to do

        if (type === 'session_reconnect') {
            // Twitch asks us to migrate to a new URL without missing events.
            const newUrl = msg.payload.session.reconnect_url;
            log('EventSub reconnect requested');
            const old = this.ws;
            this._connectEventSub(newUrl);
            setTimeout(() => { try { old.close(); } catch {} }, 2000);
            return;
        }

        if (type === 'notification') {
            this._handleNotification(msg.payload.subscription.type, msg.payload.event);
            return;
        }

        if (type === 'revocation') {
            warn('Subscription revoked:', msg.payload.subscription.type,
                 msg.payload.subscription.status);
            return;
        }
    }

    async _subscribeAll() {
        const token = await this.getAccessToken();
        if (!token) { warn('No token for EventSub subscribe'); return; }
        const uid = this.tokens.user_id;

        // type → condition. cheer=bits, subscription.message=resub, redemption=points.
        const subs = [
            { type: 'channel.cheer',                          version: '1', condition: { broadcaster_user_id: uid } },
            { type: 'channel.subscription.message',           version: '1', condition: { broadcaster_user_id: uid } },
            { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: { broadcaster_user_id: uid } },
        ];

        for (const s of subs) {
            try {
                const res = await fetch(`${TWITCH_HELIX}/eventsub/subscriptions`, {
                    method: 'POST',
                    headers: { ...this.helixHeaders(token), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type:      s.type,
                        version:   s.version,
                        condition: s.condition,
                        transport: { method: 'websocket', session_id: this.sessionId },
                    }),
                });
                const data = await res.json();
                if (res.ok) log('subscribed:', s.type);
                else        warn('subscribe failed:', s.type, '→', data.message || JSON.stringify(data));
            } catch (e) { warn('subscribe error:', s.type, e.message); }
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Event → TTS decision (threshold gating)
    // ───────────────────────────────────────────────────────────────────────

    _handleNotification(subType, event) {
        const cfg = this.config;

        if (subType === 'channel.cheer') {
            if (!cfg.bits || !cfg.bits.enabled) return;
            const bits = event.bits || 0;
            if (bits < (cfg.bits.minBits || 0)) return;
            const user = event.is_anonymous ? 'Anonym' : (event.user_name || 'Jemand');
            // event.message is the cheer message ("Cheer100 great stream")
            const text = this._composeText(cfg.bits.template, {
                user, amount: bits, message: this._stripCheermotes(event.message || ''),
            }, `${user} hat ${bits} Bits gecheert`);
            this.enqueue(text, cfg.bits.voice, { kind: 'bits', user, bits });
            return;
        }

        if (subType === 'channel.subscription.message') {
            if (!cfg.resubs || !cfg.resubs.enabled) return;
            // tier comes as "1000" / "2000" / "3000"
            const tierNum = ({ '1000': 1, '2000': 2, '3000': 3 })[event.tier] || 1;
            if (tierNum < (cfg.resubs.minTier || 1)) return;
            const months = (event.cumulative_months) || (event.duration_months) || 1;
            const user   = event.user_name || 'Jemand';
            const text = this._composeText(cfg.resubs.template, {
                user, amount: months, tier: tierNum,
                message: (event.message && event.message.text) || '',
            }, `${user} hat seit ${months} Monaten resubbt`);
            this.enqueue(text, cfg.resubs.voice, { kind: 'resub', user, months, tier: tierNum });
            return;
        }

        if (subType === 'channel.channel_points_custom_reward_redemption.add') {
            if (!cfg.redeems || !cfg.redeems.enabled) return;
            const rewardTitle = (event.reward && event.reward.title) || '';
            const rewardId = (event.reward && event.reward.id) || '';
            const wantId = String(cfg.redeems.rewardId || '').trim().toLowerCase();
            if (wantId && rewardId.trim().toLowerCase() !== wantId) return;
            // Optional: only react to a specific reward title (case-insensitive).
            const want = (cfg.redeems.rewardTitle || '').trim().toLowerCase();
            if (want && rewardTitle.trim().toLowerCase() !== want) return;
            const user = event.user_name || 'Jemand';
            const text = this._composeText(cfg.redeems.template, {
                user, reward: rewardTitle, message: event.user_input || '',
            }, event.user_input || rewardTitle);
            this.enqueue(text, cfg.redeems.voice, { kind: 'redeem', user, reward: rewardTitle, rewardId });
            return;
        }
    }

    async listCustomRewards() {
        const token = await this.getAccessToken();
        const uid = this.tokens && this.tokens.user_id;
        if (!token || !uid) throw new Error('Authorize Twitch first');

        const url = `${TWITCH_HELIX}/channel_points/custom_rewards?broadcaster_id=${encodeURIComponent(uid)}&only_manageable_rewards=false`;
        const res = await fetch(url, { headers: this.helixHeaders(token) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.message || ('Helix ' + res.status));

        return (data.data || []).map(r => ({ id: r.id, title: r.title }));
    }

    // Remove "Cheer100", "uni500" style cheermote tokens from a bits message.
    _stripCheermotes(s) {
        return s.replace(/\b[a-zA-Z]+(\d+)\b/g, (m, n) => (Number(n) >= 1 ? '' : m)).replace(/\s+/g, ' ').trim();
    }

    /**
     * Fill a template like "{user} cheered {amount} bits: {message}".
     * Falls back to `fallback` if the template is empty.
     */
    _composeText(template, vars, fallback) {
        if (!template || !template.trim()) return fallback;
        return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
    }

    // ───────────────────────────────────────────────────────────────────────
    //  ElevenLabs voices (cache itself lives on the TTSManager)
    // ───────────────────────────────────────────────────────────────────────

    _findVoiceByTag(rawTag) {
        const tag = String(rawTag || '').trim().replace(/^voice\s*[:=]\s*/i, '').trim();
        if (!tag) return null;
        const wantedExact = tag.toLowerCase();
        const wantedNorm = norm(tag);

        return this.voices.find(v => v.id.toLowerCase() === wantedExact)
            || this.voices.find(v => v.name.toLowerCase() === wantedExact)
            || this.voices.find(v => norm(v.name) === wantedNorm)
            || this.voices.find(v => norm(v.name).startsWith(wantedNorm))
            || this.voices.find(v => norm(v.name).includes(wantedNorm))
            || null;
    }

    /**
     * Resolve voice from a leading "{voice}" tag at the START of the message.
     * The tag may be written with or without a space before the message
     * ("{Rachel} hi" and "{Rachel}hi" both work), and may contain surrounding
     * whitespace inside the braces ("{ Rachel }"). The leading tag is ALWAYS
     * removed from the spoken text, so braces are never read aloud. The voice
     * only switches if the tag matches a known voice; an unknown tag is still
     * stripped and the default voice is used. A tag that is not at the very
     * start (e.g. mid-sentence) is left untouched.
     */
    resolveVoiceFromText(text, defaultVoiceId) {
        const raw = String(text || '');
        let selected = defaultVoiceId;

        // Leading {tag} with optional spaces inside braces and optional space
        // (or none) before the message body.
        const m = raw.match(/^\s*\{\s*([^}]*?)\s*\}\s*([\s\S]*)$/);
        if (!m) {
            return { voiceId: selected, cleanText: raw.replace(/\s+/g, ' ').trim() };
        }

        const taggedVoice = (m[1] || '').trim();
        const messageOnly = (m[2] || '').replace(/\s+/g, ' ').trim();
        const hit = this._findVoiceByTag(taggedVoice);
        if (hit) selected = hit.id;

        // Tag is removed either way so the {voice} text is never spoken.
        return { voiceId: selected, cleanText: messageOnly };
    }

    /**
     * Split a message into voice segments so the voice can change MID-message.
     * "{Rachel} hello {Adam} goodbye" → [{voiceId: rachel, text: "hello"},
     * {voiceId: adam, text: "goodbye"}]. Each segment becomes its own
     * ElevenLabs request. Text before the first tag uses the default voice.
     * Unknown tags are stripped (never spoken) and the voice stays unchanged.
     * Consecutive segments with the same voice are merged into one request.
     */
    splitVoiceSegments(rawText, defaultVoiceId) {
        const raw = String(rawText || '');
        const re = /\{\s*([^{}]*?)\s*\}/g;
        const segments = [];
        let voice = defaultVoiceId;
        let last = 0;
        let m;

        const push = (chunk) => {
            const clean = String(chunk || '').replace(/\s+/g, ' ').trim();
            if (!clean) return;
            const prev = segments[segments.length - 1];
            if (prev && prev.voiceId === voice) prev.text += ' ' + clean;
            else segments.push({ voiceId: voice, text: clean });
        };

        while ((m = re.exec(raw)) !== null) {
            push(raw.slice(last, m.index));   // text before this tag → current voice
            const hit = this._findVoiceByTag(m[1]);
            if (hit) voice = hit.id;          // unknown tag: stripped, voice unchanged
            last = re.lastIndex;
        }
        push(raw.slice(last));
        return segments;
    }

    _detectLanguageCode(text) {
        const defaultLang = String((this.config.language || {}).default || 'de').toLowerCase();
        const s = ' ' + String(text || '').toLowerCase() + ' ';
        if (!s.trim()) return defaultLang;

        // Umlauts / ß are a near-certain German signal.
        if (/[äöüß]/.test(s)) return 'de';

        // Score both languages by counting distinctive stopwords — a single
        // shared word ("in", "was", "die") can no longer flip the language.
        const DE = /\b(ich|du|er|sie|wir|ihr|und|nicht|kein|keine|danke|bitte|hallo|tschuess|servus|moin|heute|morgen|gestern|ja|nein|der|das|ein|eine|einen|mit|fuer|auf|aus|bei|von|zu|zum|zur|ist|sind|war|waren|habe|hast|hat|haben|mal|schon|noch|sehr|auch|aber|oder|wenn|dann|doch|geil|krass|dich|mich|dir|mir|uns|euch|wie|geht|gut|super|toll|viel|vielen|dank|gruesse|liebe|lieber|streamer|kanal)\b/g;
        const EN = /\b(i|you|he|she|we|they|the|and|not|no|thanks|thank|please|hello|hi|hey|today|tomorrow|yesterday|yes|a|an|with|for|on|from|at|of|to|is|are|was|were|have|has|had|very|also|but|or|if|then|great|awesome|nice|love|stream|chat|how|what|good|much|many|greetings|dear|your|my|this|that|it|its)\b/g;

        const deHits = (s.match(DE) || []).length;
        const enHits = (s.match(EN) || []).length;

        if (deHits > enHits) return 'de';
        if (enHits > deHits) return 'en';
        return defaultLang;
    }

    _resolveLanguageCode(text) {
        const cfg = this.config;
        const language = cfg.language || {};
        const defaultLanguage = String(language.default || 'de').toLowerCase();
        // Auto-detect is ON unless explicitly disabled.
        const autoDetect = language.autoDetect !== false;
        if (autoDetect) return this._detectLanguageCode(text);
        return defaultLanguage || 'de';
    }

    /** Only some ElevenLabs models accept language_code enforcement. */
    _modelSupportsLanguageCode(modelId) {
        return /turbo_v2_5|flash_v2_5/i.test(String(modelId || ''));
    }

    /** Convert a stored voice reference (name OR id) to an ElevenLabs voice id. */
    voiceRefToId(ref) {
        if (!ref) return null;
        const byName = this.voices.find(v => v.name.toLowerCase() === String(ref).toLowerCase());
        if (byName) return byName.id;
        const byId = this.voices.find(v => v.id === ref);
        if (byId) return byId.id;
        return ref; // assume it's already an id we don't have cached
    }

    /** The configured default voice id (falls back to the first available voice). */
    defaultVoiceId() {
        const cfg = this.config;
        if (cfg.defaultVoice) {
            // defaultVoice may be a name or an id
            const byName = this.voices.find(v => v.name.toLowerCase() === String(cfg.defaultVoice).toLowerCase());
            if (byName) return byName.id;
            const byId = this.voices.find(v => v.id === cfg.defaultVoice);
            if (byId) return byId.id;
            return cfg.defaultVoice; // trust it's an id
        }
        return this.voices[0] && this.voices[0].id;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Synthesis + queue
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Public entry — also used by the manual "test" endpoint and (optionally)
     * a chat command. Applies {Voice} extraction and default-voice fallback.
     */
    enqueue(rawText, presetVoice, meta = {}) {
        if (!rawText || !rawText.trim()) return;
        const cfg = this.config;

        // Length cap so one troll can't queue a 5-minute monologue.
        const maxChars = cfg.maxChars || 300;
        const text = rawText.trim().slice(0, maxChars);

        // {Voice} tags in the text win; else the per-trigger preset voice; else
        // default. Preset voices are stored by NAME (config UI) → convert to id.
        const presetId = this.voiceRefToId(presetVoice);
        const fallbackVoice = presetId || this.defaultVoiceId();
        if (!fallbackVoice) { warn('No voice available — dropping TTS.'); return; }

        // Split into per-voice segments (voice can change mid-message).
        const segments = this.splitVoiceSegments(text, fallbackVoice);
        if (!segments.length) return;

        const spoken = segments.map(s => s.text).join(' ');
        const voiceNames = [...new Set(segments.map(s => this.voiceNameFromId(s.voiceId)))];
        log(`voice pick: ${segments.length} segment(s) → ${voiceNames.join(', ')}`);

        const id = ++this._seq;
        this.queue.push({ id, text: spoken, segments, meta, ts: Date.now() });
        this._persistQueue();

        // Record a history entry for the Queue view (status: queued).
        const histEntry = {
            id,
            kind:      meta.kind || 'manual',
            user:      meta.user || 'Someone',
            spoken,
            voiceName: voiceNames.join(', '),
            status:    'queued',
            ts:        Date.now(),
        };
        this._pushHistory(histEntry);
        // Notify any listeners (config Queue view) that the queue changed.
        this.broadcast({ type: 'queue', action: 'add', item: this._publicHistEntry(histEntry) });

        log(`queued (${histEntry.kind}): "${spoken.slice(0, 60)}" → ${voiceNames.join(', ')} [len ${this.queue.length}]`);
        this._drain();
    }

    // ── Queue persistence: the pending queue survives a server restart. An
    //    item is deleted from disk once its audio was sent to the overlay
    //    (or it failed permanently). ──────────────────────────────────────────
    _persistQueue() {
        writeJSON(this.queueFile, {
            items: this.queue.map(q => ({
                id: q.id, text: q.text, segments: q.segments, meta: q.meta, ts: q.ts,
            })),
        });
    }

    _restoreQueue() {
        const data = readJSON(this.queueFile, null);
        if (!data || !Array.isArray(data.items) || !data.items.length) return;
        for (const it of data.items) {
            if (!it || !Array.isArray(it.segments) || !it.segments.length) continue;
            this._seq = Math.max(this._seq, Number(it.id) || 0);
            this.queue.push(it);
            this._pushHistory({
                id:        it.id,
                kind:      (it.meta && it.meta.kind) || 'manual',
                user:      (it.meta && it.meta.user) || 'Someone',
                spoken:    it.text,
                voiceName: [...new Set(it.segments.map(s => this.voiceNameFromId(s.voiceId)))].join(', '),
                status:    'queued',
                ts:        it.ts || Date.now(),
            });
        }
        if (this.queue.length) {
            log(`restored ${this.queue.length} queued message(s) from disk`);
            this._drain();
        }
    }

    /** Pick a random GIF for this event kind (config.tts.gifs). */
    _pickGif(kind) {
        const g = this.config.gifs;
        if (!g || g.enabled === false) return null;
        const key = ({ bits: 'bits', resub: 'resubs', redeem: 'redeems' })[kind];
        const list = key && Array.isArray(g[key]) ? g[key].filter(Boolean) : [];
        if (!list.length) return null;
        return list[Math.floor(Math.random() * list.length)];
    }

    async _drain() {
        if (this.playing) return;
        if (this.queue.length === 0) return;

        const cfg     = this.config;
        const gapMs   = Math.max(0, (cfg.gapSeconds != null ? cfg.gapSeconds : 4) * 1000);
        const sinceMs = Date.now() - this.lastFinish;
        if (sinceMs < gapMs) {
            setTimeout(() => this._drain(), gapMs - sinceMs);
            return;
        }

        this.playing = true;
        // Peek (don't shift) — the item stays in the persisted queue file until
        // it was actually sent, so a crash mid-synthesis never loses it.
        const item = this.queue[0];
        const hist = this._histById(item.id);
        if (hist) { hist.status = 'playing'; this._current = hist; }
        if (hist) this.broadcast({ type: 'queue', action: 'update', item: this._publicHistEntry(hist) });

        let sent = false;
        try {
            // Synthesize each voice segment as its OWN ElevenLabs request.
            const urls = [];
            for (const seg of item.segments) {
                try {
                    const audio = await this._synthesize(seg.text, seg.voiceId);
                    if (!audio) continue;
                    const fname = `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.mp3`;
                    fs.writeFileSync(path.join(this.audioDir, fname), audio);
                    urls.push(`/uploads/tts/${fname}`);
                } catch (e) {
                    warn(`segment synth failed ("${seg.text.slice(0, 40)}"):`, e.message);
                }
            }

            if (urls.length) {
                this.broadcast({
                    type:   'tts',
                    url:    urls[0],   // backward compat for old overlay pages
                    urls,              // all segments, played back-to-back
                    spoken: item.text,
                    gif:    this._pickGif(item.meta && item.meta.kind),
                    meta:   item.meta,
                });
                sent = true;
                this._cleanupOldAudio();
            } else if (hist) {
                // every segment failed — mark error and release
                hist.status = 'error';
                this.broadcast({ type: 'queue', action: 'update', item: this._publicHistEntry(hist) });
            }
        } catch (e) {
            warn('synthesize failed:', e.message);
            if (hist) {
                hist.status = 'error';
                this.broadcast({ type: 'queue', action: 'update', item: this._publicHistEntry(hist) });
            }
        } finally {
            // Message was sent (or failed permanently) → delete it from the queue
            // and from the queue file on disk.
            const idx = this.queue.indexOf(item);
            if (idx !== -1) this.queue.splice(idx, 1);
            this._persistQueue();

            if (!sent) {
                // Nothing will play, so nothing will call /api/tts/done — release
                // quickly to keep the queue moving.
                this._releaseTimer = setTimeout(() => this._release(), 500);
            } else {
                // We don't know the exact clip length server-side; the overlay
                // reports back when playback ends (see /api/tts/done). As a safety
                // net we also release after a max timeout so the queue can't wedge.
                const perClip = (cfg.maxClipSeconds || 30) * 1000;
                this._releaseTimer = setTimeout(() => this._release(),
                    perClip * Math.max(1, item.segments.length));
            }
        }
    }

    /** Called either by the overlay (playback ended) or the safety timeout. */
    _release() {
        if (this._releaseTimer) { clearTimeout(this._releaseTimer); this._releaseTimer = null; }
        if (!this.playing) return;
        this.playing    = false;
        this.lastFinish = Date.now();
        if (this._current && this._current.status === 'playing') {
            this._current.status = 'done';
            this.broadcast({ type: 'queue', action: 'update', item: this._publicHistEntry(this._current) });
        }
        this._current = null;
        this._drain();
    }

    notifyPlaybackDone() { this._release(); }

    /** fetch with a hard timeout so a hung request can never block the queue. */
    async _fetchWithTimeout(url, opts = {}, timeoutMs = 30000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
        finally { clearTimeout(t); }
    }

    async _synthesize(text, voiceId) {
        if (!this.elevenKey) throw new Error('ELEVENLABS_API_KEY not set');
        const cfg = this.config;
        const modelId = cfg.modelId || 'eleven_multilingual_v2';
        const payload = {
            text,
            model_id: modelId,
            voice_settings: {
                stability:        cfg.stability        != null ? cfg.stability        : 0.5,
                similarity_boost: cfg.similarityBoost  != null ? cfg.similarityBoost  : 0.75,
            },
        };
        // language_code is only accepted by Turbo/Flash v2.5 — sending it to
        // e.g. multilingual_v2 makes the whole request fail with a 400.
        if (this._modelSupportsLanguageCode(modelId)) {
            payload.language_code = this._resolveLanguageCode(text);
        }

        const MAX_ATTEMPTS = 3;
        let lastErr = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            let res;
            try {
                res = await this._fetchWithTimeout(`${ELEVEN_API}/text-to-speech/${voiceId}`, {
                    method: 'POST',
                    headers: {
                        'xi-api-key':   this.elevenKey,
                        'Content-Type': 'application/json',
                        'Accept':       'audio/mpeg',
                    },
                    body: JSON.stringify(payload),
                }, 30000);
            } catch (e) {
                lastErr = (e && e.name === 'AbortError')
                    ? new Error('ElevenLabs request timed out (30s)')
                    : e;
                warn(`synth attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastErr.message);
                if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
                continue;
            }

            if (res.ok) return Buffer.from(await res.arrayBuffer());

            const errTxt = await res.text().catch(() => '');
            lastErr = new Error(`ElevenLabs ${res.status}: ${errTxt.slice(0, 200)}`);

            // Model rejected language_code after all → drop it and retry once.
            if (res.status === 400 && payload.language_code && /language/i.test(errTxt)) {
                warn('model rejected language_code — retrying without it');
                delete payload.language_code;
                continue;
            }
            // Retry on rate limit / server errors; other 4xx are permanent.
            if (res.status !== 429 && res.status < 500) break;
            warn(`synth attempt ${attempt}/${MAX_ATTEMPTS} failed:`, lastErr.message);
            if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, attempt * 1500));
        }

        throw lastErr || new Error('synthesis failed');
    }

    /** Keep only the most recent N audio files on disk. */
    _cleanupOldAudio(keep = 40) {
        try {
            const files = fs.readdirSync(this.audioDir)
                .filter(f => f.endsWith('.mp3'))
                .map(f => ({ f, t: fs.statSync(path.join(this.audioDir, f)).mtimeMs }))
                .sort((a, b) => b.t - a.t);
            files.slice(keep).forEach(({ f }) => {
                try { fs.unlinkSync(path.join(this.audioDir, f)); } catch {}
            });
        } catch {}
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Access control
    // ───────────────────────────────────────────────────────────────────────

    /**
     * Is this logged-in account allowed to use the TTS control panel / test?
     * Looks up accounts.json by username. `ttsAccess` must be truthy.
     */
    accountHasTTSAccess(username) {
        if (!username) return false;
        const acc = this.accounts.find(a => a.username === username);
        return !!(acc && acc.ttsAccess);
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Status (for the config page)
    // ───────────────────────────────────────────────────────────────────────

    status() {
        return {
            channel:          this.channel,
            elevenConfigured: !!this.elevenKey,
            twitchConfigured: !!(this.clientId && this.clientSecret),
            twitchClientIdPrefix: this.clientId ? `${this.clientId.slice(0, 6)}...` : '',
            redirectUri: this.redirectUri,
            authorized:       !!(this.tokens && this.tokens.user_id),
            login:            this.tokens && this.tokens.login,
            eventSubOnline:   !!this.sessionId,
            voiceCount:       this.voices.length,
            queueLength:      this.queue.length,
            playing:          this.playing,
        };
    }

    // Recent requests for the config "Queue" view (newest first).
    recentRequests(limit = 50) {
        return this.history.slice(-limit).reverse().map(e => this._publicHistEntry(e));
    }

    // Called once at server startup (voices are loaded by the manager).
    async boot() {
        // Bring back anything that was still queued when the server stopped.
        this._restoreQueue();
        if (this.tokens && this.tokens.refresh) {
            await this.refreshAccessToken();
            await this._validateAndStore().catch(() => {});
            this.persistTokens();
            this.startEventSub();
        } else {
            log(`[${this.channel}] not yet authorized with Twitch. Open /api/tts/oauth/start?channel=${this.channel} to connect.`);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  TTSManager — one TTSEngine per streamer (per account with ttsAccess).
//  Owns the shared ElevenLabs voice cache and routes API calls / events to the
//  right channel's engine. Also migrates legacy single-user files on boot.
// ─────────────────────────────────────────────────────────────────────────────

class TTSManager {
    /**
     * @param {object} opts
     * @param {string} opts.root        project root dir
     * @param {function} opts.broadcast (channel, payload) => void — SSE push
     */
    constructor({ root, broadcast }) {
        this.root      = root;
        this.confDir   = path.join(root, 'conf');
        this.broadcastAll = broadcast || (() => {});
        this.elevenKey = (process.env.ELEVENLABS_API_KEY || '').trim();
        this.voices    = []; // shared [{ id, name }]
        this.engines   = new Map(); // channelKey → TTSEngine
    }

    get accounts() {
        const a = readJSON(path.join(this.confDir, 'accounts.json'), { accounts: [] });
        return Array.isArray(a.accounts) ? a.accounts : [];
    }

    /** Channels (lowercase) that are allowed to use TTS. */
    ttsChannels() {
        return [...new Set(this.accounts
            .filter(a => a && a.ttsAccess && a.channel)
            .map(a => String(a.channel).toLowerCase()))];
    }

    engineFor(channel) {
        const key = String(channel || '').toLowerCase().trim();
        if (!key) return null;
        if (!this.engines.has(key)) {
            this.engines.set(key, new TTSEngine({
                root:      this.root,
                channel:   key,
                manager:   this,
                broadcast: (payload) => this.broadcastAll(key, payload),
            }));
        }
        return this.engines.get(key);
    }

    /** Resolve an engine from a ?channel= param; falls back to the only TTS
     *  channel if exactly one exists (keeps old single-user URLs working).
     *  Only channels whose account has ttsAccess resolve to an engine. */
    resolveEngine(channelParam) {
        const chans = this.ttsChannels();
        const key = String(channelParam || '').toLowerCase().trim();
        if (key) return chans.includes(key) ? this.engineFor(key) : null;
        return chans.length === 1 ? this.engineFor(chans[0]) : null;
    }

    /** OAuth callbacks carry only code+state — find the engine that issued the state. */
    async handleOAuthCallback(code, state) {
        for (const eng of this.engines.values()) {
            if (state && eng._oauthState === state) return eng.handleOAuthCallback(code, state);
        }
        return { ok: false, error: 'Unknown or expired state — retry the Connect button from the config page.' };
    }

    // ── Shared voice cache ───────────────────────────────────────────────────
    async loadVoices() {
        if (!this.elevenKey) { warn('No ELEVENLABS_API_KEY — voices unavailable.'); return []; }
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 15000);
            let res;
            try {
                res = await fetch(`${ELEVEN_API}/voices`, {
                    headers: { 'xi-api-key': this.elevenKey },
                    signal: ctrl.signal,
                });
            } finally { clearTimeout(t); }
            if (!res.ok) { warn('voices fetch failed', res.status); return this.voices; }
            const data = await res.json();
            this.voices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name }));
            log('loaded', this.voices.length, 'ElevenLabs voices');
            return this.voices;
        } catch (e) { warn('voices error:', e.message); return this.voices; }
    }

    // ── Legacy migration (single global tts config / tokens.json) ────────────
    _migrateLegacy() {
        const chans = this.ttsChannels();

        // 1) config.tts flat → keyed per channel (every TTS channel gets a copy).
        try {
            const cfgFile = path.join(this.confDir, 'config.json');
            const all = readJSON(cfgFile, null);
            const tts = all && all.tts;
            const isFlat = tts && (tts.bits || tts.appearance || tts.defaultVoice !== undefined);
            if (isFlat && chans.length) {
                const keyed = {};
                for (const ch of chans) keyed[ch] = JSON.parse(JSON.stringify(tts));
                all.tts = keyed;
                writeJSON(cfgFile, all);
                log(`migrated legacy tts config → per-channel (${chans.join(', ')})`);
            }
        } catch (e) { warn('config migration failed:', e.message); }

        // 2) legacy conf/tokens.json → conf/tokens.<channel>.json
        try {
            const legacyTok = path.join(this.confDir, 'tokens.json');
            if (fs.existsSync(legacyTok)) {
                const tok = readJSON(legacyTok, null);
                const login = tok && tok.login ? String(tok.login).toLowerCase() : null;
                const target = login && chans.includes(login) ? login : (chans.length === 1 ? chans[0] : null);
                if (target) {
                    const dest = path.join(this.confDir, `tokens.${target.replace(/[^a-z0-9_-]/g, '_')}.json`);
                    if (!fs.existsSync(dest)) writeJSON(dest, tok);
                    fs.renameSync(legacyTok, legacyTok + '.bak');
                    log(`migrated legacy tokens.json → channel "${target}"`);
                }
            }
        } catch (e) { warn('token migration failed:', e.message); }

        // 3) legacy conf/tts-queue.json → per-channel queue file
        try {
            const legacyQ = path.join(this.confDir, 'tts-queue.json');
            if (fs.existsSync(legacyQ) && chans.length === 1) {
                const dest = path.join(this.confDir, `tts-queue.${chans[0].replace(/[^a-z0-9_-]/g, '_')}.json`);
                if (!fs.existsSync(dest)) fs.renameSync(legacyQ, dest);
                else fs.unlinkSync(legacyQ);
            }
        } catch (e) { warn('queue migration failed:', e.message); }
    }

    // ── Boot: voices once, then one engine per TTS-enabled account ───────────
    async boot() {
        this._migrateLegacy();

        if (this.elevenKey) {
            await this.loadVoices();
            // Retry shortly if the first load failed; refresh hourly so
            // renamed/new voices stay resolvable.
            if (!this.voices.length) setTimeout(() => this.loadVoices().catch(() => {}), 30000);
            const t = setInterval(() => this.loadVoices().catch(() => {}), 60 * 60 * 1000);
            if (t.unref) t.unref();
        }

        const chans = this.ttsChannels();
        if (!chans.length) { log('no accounts with ttsAccess — TTS idle.'); return; }
        for (const ch of chans) {
            const eng = this.engineFor(ch);
            await eng.boot().catch(e => warn(`[${ch}] boot error:`, e.message));
        }
    }
}

module.exports = { TTSEngine, TTSManager, SCOPES };
