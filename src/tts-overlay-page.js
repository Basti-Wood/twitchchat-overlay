// ─────────────────────────────────────────────────────────────────────────────
//  tts-overlay-page.js — runs inside tts.html (the standalone OBS browser source)
//
//  Shows a visual alert box (who triggered + the spoken text) AND plays the
//  ElevenLabs audio. The server pushes events over SSE (/api/tts/stream).
//
//  Design goals (after debugging "no card / no sound" in OBS):
//   • The alert CARD always shows when a tts event arrives — even if audio fails.
//   • Audio plays from THIS page (so it is audible in the OBS browser source).
//   • The queue can never wedge: every clip has a hard safety timeout.
//   • A small status line (bottom-left) shows connection + playback state so it
//     is obvious what is happening. Add ?debug=1 to keep it visible permanently.
//   • Robust autoplay unlock for normal browsers (OBS autoplays already).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    const ORIGIN = window.TTS_SERVER || '';
    const stage  = document.getElementById('tts-stage');
    const params = new URLSearchParams(window.location.search);
    const DEBUG  = params.get('debug') === '1';

    const localQueue = [];
    let playing = false;
    let appearance = null;
    let audioUnlocked = false;
    let audioCtx = null;

    // ── Status line ──────────────────────────────────────────────────────────
    const statusEl = document.createElement('div');
    statusEl.style.cssText =
        'position:fixed;left:8px;bottom:8px;z-index:9999;font:12px/1.4 monospace;' +
        'color:#fff;background:rgba(0,0,0,.55);padding:4px 8px;border-radius:6px;' +
        'pointer-events:none;max-width:90vw;white-space:pre-wrap;transition:opacity .4s;';
    document.body.appendChild(statusEl);
    let statusHideTimer = null;
    function setStatus(msg) {
        const time = new Date().toLocaleTimeString();
        statusEl.textContent = `[tts] ${msg}`;
        statusEl.style.opacity = '1';
        console.log(`[tts-overlay] ${time} ${msg}`);
        if (!DEBUG) {
            clearTimeout(statusHideTimer);
            statusHideTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 4000);
        }
    }

    // ── Appearance: ?param overrides first, else server config ───────────────
    async function loadAppearance() {
        let cfg = {};
        try {
            const res = await fetch(ORIGIN + '/api/tts/appearance');
            if (res.ok) cfg = await res.json();
        } catch (e) { setStatus('appearance fetch failed: ' + e.message); }
        appearance = {
            position:  params.get('pos')      || cfg.position    || 'bottom-center',
            accent:    params.get('accent')   || cfg.accent      || '#9146ff',
            bg:        params.get('bg')        || cfg.bg          || 'rgba(20, 16, 40, 0.92)',
            text:      params.get('text')      || cfg.text        || '#ffffff',
            fontSize:  Number(params.get('fontSize') || cfg.fontSize || 18),
            radius:    Number(cfg.radius != null ? cfg.radius : 16),
            duration:  Number(params.get('duration') || cfg.duration || 0), // 0 = until audio ends
            showIcon:  cfg.showIcon != null ? cfg.showIcon : true,
        };
        stage.className = 'pos-' + (appearance.position || 'bottom-center');
    }

    // ── Audio unlock for non-OBS browsers ───────────────────────────────────
    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (Ctx) { audioCtx = new Ctx(); if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {}); }
        } catch {}
        try {
            const a = new Audio('data:audio/mpeg;base64,SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5AAAAAAAAAAAAAAD/');
            a.volume = 0;
            a.play().catch(() => {});
        } catch {}
        setStatus('audio unlocked');
    }
    window.addEventListener('click',   unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    window.addEventListener('pointerdown', unlockAudio, { once: true });

    // ── Icons + titles ────────────────────────────────────────────────────────
    const ICONS = {
        bits:   '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 7v10l8 5 8-5V7l-8-5zm0 2.3L17.5 8 12 11.7 6.5 8 12 4.3z"/></svg>',
        resub:  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.6-5.2 4.5 1.6 6.7L12 16.9 5.8 20.6l1.6-6.7L2.2 8.9l6.9-.6z"/></svg>',
        redeem: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20 7h-2.2a3 3 0 0 0-4.8-3.5A3 3 0 0 0 6.2 7H4a1 1 0 0 0-1 1v3h18V8a1 1 0 0 0-1-1zM4 13v6a1 1 0 0 0 1 1h6v-7H4zm9 7h6a1 1 0 0 0 1-1v-6h-7v7z"/></svg>',
        manual: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2z"/></svg>',
    };

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function titleFor(meta) {
        const who = meta.user || 'Someone';
        switch (meta.kind) {
            case 'bits':   return { html: `<span class="who">${escapeHtml(who)}</span> cheered ${meta.bits != null ? meta.bits : ''} bits`, sub: 'Bits' };
            case 'resub':  return { html: `<span class="who">${escapeHtml(who)}</span> resubscribed`, sub: meta.months ? `${meta.months} months · Tier ${meta.tier || 1}` : 'Resub' };
            case 'redeem': return { html: `<span class="who">${escapeHtml(who)}</span>`, sub: meta.reward || 'Channel Points' };
            default:       return { html: `<span class="who">${escapeHtml(who)}</span>`, sub: 'TTS' };
        }
    }

    function showAlert(item) {
        const meta = item.meta || {};
        const t = titleFor(meta);
        const el = document.createElement('div');
        el.className = 'tts-alert';
        el.style.setProperty('--accent', appearance.accent);
        el.style.setProperty('--bg', appearance.bg);
        el.style.setProperty('--text', appearance.text);
        el.style.setProperty('--radius', appearance.radius + 'px');
        el.style.fontSize = appearance.fontSize + 'px';

        const iconHtml = appearance.showIcon
            ? `<div class="tts-alert-icon">${ICONS[meta.kind] || ICONS.manual}</div>` : '';
        el.innerHTML = `
            <div class="tts-alert-head">
                ${iconHtml}
                <div>
                    <div class="tts-alert-title">${t.html}</div>
                    <div class="tts-alert-sub">${escapeHtml(t.sub)}</div>
                </div>
            </div>
            <div class="tts-alert-body">${escapeHtml(item.spoken || '')}</div>`;
        stage.appendChild(el);
        void el.offsetWidth; // reflow → trigger transition
        el.classList.add('show');
        return el;
    }

    function hideAlert(el) {
        if (!el) return;
        el.classList.remove('show');
        setTimeout(() => { try { el.remove(); } catch {} }, 400);
    }

    // ── Playback ─────────────────────────────────────────────────────────────
    // The CARD is shown immediately and kept visible for at least minVisibleMs
    // OR until the audio ends (whichever is longer), so a fast audio error never
    // makes the card flash away. The queue advances when audio ends/errors.
    function playNext() {
        if (playing) return;
        const item = localQueue.shift();
        if (!item) return;
        playing = true;

        setStatus(`showing ${item.meta ? item.meta.kind : 'tts'} card${item.url ? ' + audio' : ''}`);
        const alertEl = showAlert(item);
        const shownAt = Date.now();
        const minVisibleMs = (appearance.duration > 0 ? appearance.duration * 1000 : 3500);

        let released = false;
        const release = (why) => {
            if (released) return;
            released = true;
            const elapsed = Date.now() - shownAt;
            const wait = Math.max(0, minVisibleMs - elapsed);
            setTimeout(() => {
                hideAlert(alertEl);
                playing = false;
                fetch(ORIGIN + '/api/tts/done', { method: 'POST' }).catch(() => {});
                playNext();
            }, wait);
            if (why) setStatus(why);
        };

        if (!item.url) { release('no audio url — card only'); return; }

        const audio = new Audio(ORIGIN + item.url);
        audio.volume = 1.0;

        // Hard safety timeout: if 'ended' never fires (codec stall etc.), release
        // anyway after the clip's expected max so the queue can't wedge.
        const safety = setTimeout(() => release('audio safety timeout'), 30000);

        audio.addEventListener('ended', () => { clearTimeout(safety); release('audio ended'); }, { once: true });
        audio.addEventListener('error', () => { clearTimeout(safety); release('audio error — card kept'); }, { once: true });

        const tryPlay = () => audio.play();
        tryPlay().then(() => setStatus('audio playing')).catch(err => {
            // Autoplay blocked (typically only in a normal browser tab, not OBS).
            setStatus('autoplay blocked — retrying; click overlay if silent');
            // Retry a few times automatically; also retry on any user gesture.
            let tries = 0;
            const retry = () => {
                tries++;
                audio.play().then(() => setStatus('audio playing (retry)')).catch(() => {
                    if (tries < 20) setTimeout(retry, 500);
                });
            };
            window.addEventListener('click', retry, { once: true });
            window.addEventListener('pointerdown', retry, { once: true });
            setTimeout(retry, 500);
        });
    }

    // ── SSE connection ────────────────────────────────────────────────────────
    let es = null;
    function connect() {
        try {
            es = new EventSource(ORIGIN + '/api/tts/stream');
        } catch (e) {
            setStatus('SSE create failed: ' + e.message);
            setTimeout(connect, 3000);
            return;
        }
        es.onopen = () => setStatus('connected to server');
        es.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'tts' && msg.url) {
                setStatus(`event: tts (${msg.meta ? msg.meta.kind : '?'}) "${(msg.spoken || '').slice(0, 40)}"`);
                localQueue.push(msg);
                playNext();
            } else if (msg.type === 'appearance') {
                setStatus('appearance updated');
                loadAppearance();
            } else if (msg.type === 'hello') {
                setStatus('server said hello');
            }
        };
        es.onerror = () => {
            // EventSource auto-reconnects. Surface it so a wrong URL is obvious.
            setStatus('SSE error / reconnecting — is the URL http://…:8080/html/tts.html ?');
        };
    }

    // ── Init ────────────────────────────────────────────────────────────────
    (async function init() {
        const inPreview = window.self !== window.top;
        if (inPreview) { setStatus('preview iframe — playback disabled'); return; }
        setStatus('starting…');
        await loadAppearance();
        connect();
    })();
})();
