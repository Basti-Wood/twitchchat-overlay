// Shared client-side auth: resolves the logged-in user (cookie session) or sends
// the visitor to the Twitch login page. Pages await `window.authReady`.
window.authReady = (async function () {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    if (res.status === 401) {
        location.replace('/index.html');
        return new Promise(() => {});
    }
    const me = await res.json();
    window.currentAccount = me;
    // Legacy key read by config.js helpers
    sessionStorage.setItem('account', JSON.stringify(me));

    const chip = document.getElementById('user-chip');
    if (chip) {
        chip.querySelector('span').textContent = me.displayName;
        const img = chip.querySelector('img');
        if (me.avatar) img.src = me.avatar; else img.remove();
        chip.hidden = false;
    }
    const adminLink = document.getElementById('admin-link');
    if (adminLink) adminLink.hidden = me.role !== 'admin';
    return me;
})();

async function logout() {
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    sessionStorage.removeItem('account');
    location.replace('/index.html?status=loggedout');
}