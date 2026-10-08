// Twitch login, user approval, roles and sessions for the config pages.
//
//  • Login:   Twitch OAuth "authorization code" flow (no scopes -> identity only).
//  • Access:  only users stored in <DATA_DIR>/conf/users.json with status "approved".
//             Anyone else who logs in is recorded as "pending" until an admin approves.
//  • Admins:  role "admin" (bootstrapped via ADMIN_TWITCH_LOGINS, managed on /html/admin.html).
//  • Session: random id in an HttpOnly cookie, stored server-side in <DATA_DIR>/conf/sessions.json.

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const COOKIE_SESSION = 'overlay_sid';
const COOKIE_STATE   = 'overlay_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function readJSON(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJSON(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 4), 'utf8');
    fs.renameSync(tmp, file);
}

const rand = (n = 32) => crypto.randomBytes(n).toString('hex');

function normLogin(v) {
    return String(v || '').toLowerCase().replace(/^@/, '').replace(/[^a-z0-9_]/g, '').slice(0, 25);
}

function parseCookies(req) {
    const out = {};
    for (const part of String(req.headers.cookie || '').split(';')) {
        const i = part.indexOf('=');
        if (i === -1) continue;
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

class Auth {
    /**
     * @param {object} opts
     * @param {string} opts.dataDir  persistent data directory
     * @param {string} opts.rootDir  project dir (for one-time import of legacy accounts.json)
     */
    constructor({ dataDir, rootDir }) {
        this.confDir      = path.join(dataDir, 'conf');
        this.usersFile    = path.join(this.confDir, 'users.json');
        this.sessionsFile = path.join(this.confDir, 'sessions.json');
        this.rootDir      = rootDir;

        this.clientId     = (process.env.TWITCH_CLIENT_ID || '').trim();
        this.clientSecret = (process.env.TWITCH_CLIENT_SECRET || '').trim();
        this.redirectUri  = this._resolveRedirectUri();
        this.secureCookie = this.redirectUri.startsWith('https://');

        this.adminLogins = (process.env.ADMIN_TWITCH_LOGINS || '')
            .split(/[,\s]+/).map(normLogin).filter(Boolean);

        this.sessions = new Map(Object.entries(readJSON(this.sessionsFile, {})));
        this._pruneSessions();
        this._importLegacyAccounts();
    }

    _resolveRedirectUri() {
        const explicit = (process.env.TWITCH_LOGIN_REDIRECT_URI || '').trim();
        if (explicit) return explicit;
        const publicUrl = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
        if (publicUrl) return publicUrl + '/auth/twitch/callback';
        const tts = (process.env.TWITCH_REDIRECT_URI || '').trim();
        if (tts) return tts.replace(/\/api\/tts\/oauth\/callback\/?$/, '/auth/twitch/callback');
        return `http://localhost:${process.env.PORT || 8080}/auth/twitch/callback`;
    }

    get configured() { return !!(this.clientId && this.clientSecret); }

    // ── Users ────────────────────────────────────────────────────────────────
    _load() {
        const d = readJSON(this.usersFile, { users: [] });
        return Array.isArray(d.users) ? d.users : [];
    }
    _save(users) { writeJSON(this.usersFile, { users }); }

    /** One-time import of the old accounts.json: each account becomes a pre-approved user (login = channel). */
    _importLegacyAccounts() {
        if (fs.existsSync(this.usersFile)) return;
        const legacy = readJSON(path.join(this.confDir, 'accounts.json'), null)
                    || readJSON(path.join(this.rootDir, 'conf', 'accounts.json'), null);
        const users = [];
        for (const a of (legacy && Array.isArray(legacy.accounts) ? legacy.accounts : [])) {
            const login = normLogin(a.channel || a.username);
            if (!login || login === 'channelname' || login === 'username' || users.some(u => u.login === login)) continue;
            users.push({
                id: rand(8), twitchId: null, login, displayName: a.username || login, avatar: '',
                role: 'user', status: 'approved', channel: login,
                ttsAccess: !!a.ttsAccess, oauthToken: a.oauthToken || '',
                createdAt: new Date().toISOString(), lastLogin: null,
            });
        }
        if (users.length) console.log(`[auth] imported ${users.length} legacy account(s) as approved users — they now log in with Twitch.`);
        this._save(users);
    }

    publicUser(u) {
        return {
            id: u.id, login: u.login, displayName: u.displayName || u.login, avatar: u.avatar || '',
            role: u.role, status: u.status, channel: u.channel || u.login,
            ttsAccess: !!u.ttsAccess, createdAt: u.createdAt, lastLogin: u.lastLogin,
        };
    }

    /** The shape the config page / TTS engine expects. */
    me(u) {
        return {
            ...this.publicUser(u),
            username: u.displayName || u.login,
            oauthToken: u.oauthToken || '',
        };
    }

    /** Approved users in the legacy "account" shape (used by the TTS manager). */
    accounts() {
        return this._load()
            .filter(u => u.status === 'approved')
            .map(u => ({ username: u.displayName || u.login, channel: (u.channel || u.login), ttsAccess: !!u.ttsAccess }));
    }

    list() { return this._load().map(u => this.publicUser(u)); }

    _adminCount(users) { return users.filter(u => u.role === 'admin' && u.status === 'approved').length; }

    addByLogin(loginRaw) {
        const login = normLogin(loginRaw);
        if (!login) throw new Error('Invalid Twitch login');
        const users = this._load();
        if (users.some(u => u.login === login)) throw new Error('User already exists');
        const u = {
            id: rand(8), twitchId: null, login, displayName: login, avatar: '',
            role: 'user', status: 'approved', channel: login, ttsAccess: false, oauthToken: '',
            createdAt: new Date().toISOString(), lastLogin: null,
        };
        users.push(u);
        this._save(users);
        return this.publicUser(u);
    }

    update(id, patch, actingUserId) {
        const users = this._load();
        const u = users.find(x => x.id === id);
        if (!u) throw new Error('User not found');
        const next = { ...u };
        if (patch.role !== undefined) {
            if (!['admin', 'user'].includes(patch.role)) throw new Error('Invalid role');
            next.role = patch.role;
        }
        if (patch.status !== undefined) {
            if (!['approved', 'pending', 'denied'].includes(patch.status)) throw new Error('Invalid status');
            next.status = patch.status;
        }
        if (patch.channel !== undefined) {
            const ch = normLogin(patch.channel);
            if (!ch) throw new Error('Invalid channel');
            next.channel = ch;
        }
        if (patch.ttsAccess !== undefined) next.ttsAccess = !!patch.ttsAccess;

        const wasAdmin = u.role === 'admin' && u.status === 'approved';
        const isAdmin  = next.role === 'admin' && next.status === 'approved';
        if (wasAdmin && !isAdmin && this._adminCount(users) <= 1) throw new Error('Cannot remove the last administrator');
        if (id === actingUserId && wasAdmin && !isAdmin) throw new Error('You cannot remove your own admin access');

        Object.assign(u, next);
        this._save(users);
        if (next.status !== 'approved') this.destroySessionsOf(id);
        return this.publicUser(u);
    }

    remove(id, actingUserId) {
        const users = this._load();
        const u = users.find(x => x.id === id);
        if (!u) throw new Error('User not found');
        if (id === actingUserId) throw new Error('You cannot delete yourself');
        if (u.role === 'admin' && u.status === 'approved' && this._adminCount(users) <= 1) {
            throw new Error('Cannot remove the last administrator');
        }
        this._save(users.filter(x => x.id !== id));
        this.destroySessionsOf(id);
    }

    /** Update the stored token field of the user's own record. */
    setOwnToken(id, token) {
        const users = this._load();
        const u = users.find(x => x.id === id);
        if (!u) return;
        u.oauthToken = String(token || '').slice(0, 200);
        this._save(users);
    }

    // ── Sessions ─────────────────────────────────────────────────────────────
    _pruneSessions() {
        const now = Date.now();
        for (const [sid, s] of this.sessions) if (s.expires < now) this.sessions.delete(sid);
    }
    _persistSessions() { writeJSON(this.sessionsFile, Object.fromEntries(this.sessions)); }

    _cookie(name, value, maxAgeSec) {
        return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`
            + (this.secureCookie ? '; Secure' : '');
    }

    createSession(res, userId) {
        const sid = rand(32);
        this.sessions.set(sid, { userId, expires: Date.now() + SESSION_TTL_MS });
        this._persistSessions();
        this._appendCookie(res, this._cookie(COOKIE_SESSION, sid, SESSION_TTL_MS / 1000));
    }

    destroySession(req, res) {
        const sid = parseCookies(req)[COOKIE_SESSION];
        if (sid && this.sessions.delete(sid)) this._persistSessions();
        this._appendCookie(res, this._cookie(COOKIE_SESSION, '', 0));
    }

    destroySessionsOf(userId) {
        let changed = false;
        for (const [sid, s] of this.sessions) if (s.userId === userId) { this.sessions.delete(sid); changed = true; }
        if (changed) this._persistSessions();
    }

    _appendCookie(res, value) {
        const prev = res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie', prev ? [].concat(prev, value) : value);
    }

    /** Returns the full stored user record for a valid, still-approved session, else null. */
    currentUser(req) {
        const sid = parseCookies(req)[COOKIE_SESSION];
        const s = sid && this.sessions.get(sid);
        if (!s || s.expires < Date.now()) return null;
        const u = this._load().find(x => x.id === s.userId);
        return u && u.status === 'approved' ? u : null;
    }

    /** Channel (lowercase) the user may manage. */
    channelOf(u) { return String(u.channel || u.login || '').toLowerCase(); }

    // ── Twitch OAuth login ───────────────────────────────────────────────────
    beginLogin(res) {
        if (!this.configured) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET are not configured in .env');
            return;
        }
        const state = rand(16);
        this._appendCookie(res, this._cookie(COOKIE_STATE, state, 600));
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: this.redirectUri,
            response_type: 'code',
            state,
            force_verify: 'true',
        });
        res.writeHead(302, { Location: 'https://id.twitch.tv/oauth2/authorize?' + params });
        res.end();
    }

    async handleCallback(req, res, query) {
        const redirect = (loc) => { res.writeHead(302, { Location: loc }); res.end(); };
        const cookieState = parseCookies(req)[COOKIE_STATE];
        this._appendCookie(res, this._cookie(COOKIE_STATE, '', 0));

        if (query.get('error')) return redirect('/index.html?status=cancelled');
        const code = query.get('code');
        if (!code || !cookieState || query.get('state') !== cookieState) return redirect('/index.html?status=error');

        let twitchUser;
        try {
            const tokRes = await fetch('https://id.twitch.tv/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: this.clientId, client_secret: this.clientSecret, code,
                    grant_type: 'authorization_code', redirect_uri: this.redirectUri,
                }),
            });
            const tok = await tokRes.json();
            if (!tokRes.ok || !tok.access_token) throw new Error(tok.message || 'token exchange failed');

            const meRes = await fetch('https://api.twitch.tv/helix/users', {
                headers: { Authorization: 'Bearer ' + tok.access_token, 'Client-Id': this.clientId },
            });
            const me = await meRes.json();
            twitchUser = me && me.data && me.data[0];
            if (!twitchUser) throw new Error('could not read Twitch profile');

            // We only needed the identity; the token is not kept.
            fetch('https://id.twitch.tv/oauth2/revoke', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: this.clientId, token: tok.access_token }),
            }).catch(() => {});
        } catch (e) {
            console.error('[auth] twitch login failed:', e.message);
            return redirect('/index.html?status=error');
        }

        const user = this._upsertFromTwitch(twitchUser);
        if (user.status === 'approved') {
            this.createSession(res, user.id);
            return redirect('/html/config.html');
        }
        return redirect(`/index.html?status=${user.status}&user=${encodeURIComponent(user.displayName)}`);
    }

    _upsertFromTwitch(t) {
        const login = normLogin(t.login);
        const users = this._load();
        let u = users.find(x => x.twitchId === t.id) || users.find(x => !x.twitchId && x.login === login);
        const isBootstrapAdmin = this.adminLogins.includes(login);

        if (!u) {
            u = {
                id: rand(8), twitchId: t.id, login, displayName: t.display_name || login,
                avatar: t.profile_image_url || '', role: 'user', status: 'pending',
                channel: login, ttsAccess: false, oauthToken: '',
                createdAt: new Date().toISOString(), lastLogin: null,
            };
            users.push(u);
            console.log(`[auth] new login request from ${login} (pending approval)`);
        }
        u.twitchId = t.id;
        u.displayName = t.display_name || login;
        u.avatar = t.profile_image_url || u.avatar;
        if (u.login !== login) {
            if (!u.channel || u.channel === u.login) u.channel = login;
            u.login = login;
        }
        if (isBootstrapAdmin) { u.role = 'admin'; u.status = 'approved'; u.ttsAccess = true; }
        if (u.status === 'approved') u.lastLogin = new Date().toISOString();
        this._save(users);
        return u;
    }
}

module.exports = { Auth, parseCookies };
