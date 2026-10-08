// Admin page: approve / deny Twitch users, set roles, channels and TTS access.
(async function () {
    const me = await window.authReady;
    if (me.role !== 'admin') { location.replace('/html/config.html'); return; }

    const msg = document.getElementById('admin-message');
    const say = (text, ok) => { msg.textContent = text; msg.style.color = ok ? '#2ecc71' : '#e05a5a'; };

    async function api(url, body) {
        const res = await fetch(url, {
            method: body ? 'POST' : 'GET',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || res.status);
        return data;
    }

    const el = (tag, props = {}, ...kids) => {
        const n = Object.assign(document.createElement(tag), props);
        kids.forEach(k => n.append(k));
        return n;
    };
    const btn = (label, cls, fn) => el('button', { className: 'btn-small ' + (cls || ''), textContent: label, onclick: fn });
    const badge = (text, kind) => el('span', { className: 'badge badge--' + kind, textContent: text });

    async function act(promise, okText) {
        try { await promise; say(okText, true); } catch (e) { say(e.message, false); }
        load();
    }
    const update = (u, patch) => api('/api/admin/users/update', { id: u.id, ...patch });

    function userCell(u) {
        const td = el('td', { className: 'user-cell' });
        if (u.avatar) td.append(el('img', { src: u.avatar, alt: '' }));
        td.append(el('span', { textContent: u.displayName + (u.displayName.toLowerCase() === u.login ? '' : ` (${u.login})`) }));
        return td;
    }

    function renderPending(users) {
        const tb = document.querySelector('#pending-table tbody');
        tb.replaceChildren();
        const pending = users.filter(u => u.status === 'pending');
        if (!pending.length) { tb.append(el('tr', {}, el('td', { textContent: 'No pending requests.' }))); return; }
        for (const u of pending) {
            tb.append(el('tr', {},
                userCell(u),
                el('td', {}, el('div', { className: 'admin-actions' },
                    btn('Approve', '', () => act(update(u, { status: 'approved' }), `${u.login} approved`)),
                    btn('Deny', 'btn-small--danger', () => act(update(u, { status: 'denied' }), `${u.login} denied`)),
                )),
            ));
        }
    }

    function renderUsers(users, myId) {
        const tb = document.querySelector('#users-table tbody');
        tb.replaceChildren();
        for (const u of users.filter(x => x.status !== 'pending')) {
            const isMe = u.id === myId;
            const channel = el('input', { type: 'text', value: u.channel });
            channel.addEventListener('change', () => act(update(u, { channel: channel.value }), 'Channel updated'));
            const tts = el('input', { type: 'checkbox', checked: u.ttsAccess });
            tts.addEventListener('change', () => act(update(u, { ttsAccess: tts.checked }), 'TTS access updated'));

            const actions = el('div', { className: 'admin-actions' });
            if (u.role === 'admin') actions.append(btn('Make user', '', () => act(update(u, { role: 'user' }), 'Role updated')));
            else if (u.status === 'approved') actions.append(btn('Make admin', '', () => act(update(u, { role: 'admin' }), 'Role updated')));
            if (u.status === 'approved') {
                if (!isMe) actions.append(btn('Revoke', 'btn-small--danger', () => act(update(u, { status: 'denied' }), `${u.login} revoked`)));
            } else {
                actions.append(btn('Approve', '', () => act(update(u, { status: 'approved' }), `${u.login} approved`)));
            }
            if (!isMe) actions.append(btn('Delete', 'btn-small--danger', () => {
                if (confirm(`Delete ${u.login}?`)) act(api('/api/admin/users/delete', { id: u.id }), `${u.login} deleted`);
            }));

            tb.append(el('tr', {},
                userCell(u),
                el('td', {}, badge(u.status, u.status)),
                el('td', {}, u.role === 'admin' ? badge('admin', 'admin') : 'user'),
                el('td', {}, channel),
                el('td', {}, tts),
                el('td', { textContent: u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'never' }),
                el('td', {}, actions),
            ));
        }
    }

    async function load() {
        try {
            const data = await api('/api/admin/users');
            renderPending(data.users);
            renderUsers(data.users, data.me);
        } catch (e) { say(e.message, false); }
    }

    document.getElementById('add-form').addEventListener('submit', (ev) => {
        ev.preventDefault();
        const input = document.getElementById('add-login');
        const login = input.value.trim();
        input.value = '';
        act(api('/api/admin/users', { login }), `${login} can now log in with Twitch`);
    });

    load();
})();