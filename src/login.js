// Shows the result of a Twitch login attempt and skips the page if already signed in.
(async function () {
    const params = new URLSearchParams(location.search);
    const status = params.get('status');
    const user   = params.get('user') || 'your account';
    const box    = document.getElementById('login-notice');

    const notices = {
        pending:   ['pending', `Hi ${user}! Your login request was sent. An administrator has to approve it before you get access — please try again later.`],
        denied:    ['denied',  `Sorry ${user}, you don't have access to this page.`],
        cancelled: ['info',    'Login cancelled.'],
        error:     ['error',   'Twitch login failed. Please try again.'],
        loggedout: ['info',    'You have been logged out.'],
    };
    if (status && notices[status]) {
        box.className = 'login-notice login-notice--' + notices[status][0];
        box.textContent = notices[status][1];
        box.hidden = false;
        return;
    }

    try {
        const res = await fetch('/api/me', { credentials: 'same-origin' });
        if (res.ok) location.replace('/html/config.html');
    } catch { /* stay on the login page */ }
})();