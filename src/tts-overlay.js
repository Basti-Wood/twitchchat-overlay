// ─────────────────────────────────────────────────────────────────────────────
//  tts-overlay.js — runs inside chat.html (the OBS browser source)
//
//  Opens an SSE stream to the server and plays each TTS clip in order. The
//  server already spaces clips out via its queue, but we play strictly one at a
//  time here too and tell the server when a clip ends (/api/tts/done) so its
//  "gap between clips" timer starts from the real end of audio.
//
//  OBS browser sources allow audio autoplay without a user gesture. In a normal
//  browser tab autoplay may be blocked until the first click — we handle that
//  with a one-time unlock.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
    // Resolve server origin. chat.html is served from the same origin in OBS,
    // so relative URLs work. (If you ever embed the overlay cross-origin, set
    // window.TTS_SERVER before this script runs.)
    const ORIGIN = window.TTS_SERVER || '';

    const localQueue = [];
    let playing = false;
    let audioUnlocked = false;

    function log(...a) { console.log('[tts-overlay]', ...a); }

    // ── Audio unlock for non-OBS browsers ───────────────────────────────────
    function unlockAudio() {
        if (audioUnlocked) return;
        audioUnlocked = true;
        // Play a near-silent buffer to satisfy autoplay policies.
        try {
            const a = new Audio();
            a.src = 'data:audio/mpeg;base64,SUQzAwAAAAAAFlRTU0UAAAAMAAADTGF2ZjU4LjI5AAAAAAAAAAAAAAD/';
            a.volume = 0;
            a.play().catch(() => {});
        } catch {}
        log('audio unlocked');
    }
    window.addEventListener('click',   unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });

    // ── Playback ─────────────────────────────────────────────────────────────
    function playNext() {
        if (playing) return;
        const item = localQueue.shift();
        if (!item) return;
        playing = true;

        const audio = new Audio(ORIGIN + item.url);
        audio.volume = 1.0;

        const finish = () => {
            playing = false;
            // Tell the server this clip ended so its inter-clip gap is accurate.
            fetch(ORIGIN + '/api/tts/done', { method: 'POST' }).catch(() => {});
            // Continue with anything the SSE pushed while we were playing.
            playNext();
        };

        audio.addEventListener('ended', finish, { once: true });
        audio.addEventListener('error', (e) => {
            log('audio error', e && e.message);
            finish();
        }, { once: true });

        audio.play().catch(err => {
            // Autoplay blocked (non-OBS). Re-queue and wait for a user gesture.
            log('play blocked, will retry after gesture:', err && err.message);
            playing = false;
            localQueue.unshift(item);
            window.addEventListener('click', () => playNext(), { once: true });
        });
    }

    // ── SSE connection ────────────────────────────────────────────────────────
    function connect() {
        const es = new EventSource(ORIGIN + '/api/tts/stream');

        es.onmessage = (ev) => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }
            if (msg.type === 'tts' && msg.url) {
                localQueue.push(msg);
                playNext();
            }
        };

        es.onerror = () => {
            // EventSource auto-reconnects; nothing to do.
            // (The server also sends `retry: 3000`.)
        };

        log('SSE connected');
    }

    // Only connect on the live overlay, not inside the config preview iframe.
    // The preview loads chat.html in an <iframe>; we skip TTS there to avoid
    // double playback while configuring.
    const inPreview = window.self !== window.top;
    if (!inPreview) {
        connect();
    } else {
        log('preview iframe — TTS playback disabled here');
    }
})();
