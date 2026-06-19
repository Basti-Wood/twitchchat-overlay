// list-voices.js — prints your ElevenLabs voice names so you can see the exact
// spelling to use in a {Voice} tag. Run from the project folder:
//
//     node list-voices.js
//
// It reads ELEVENLABS_API_KEY from your .env (same loader as the server).

const fs   = require('fs');
const path = require('path');

(function loadDotEnv() {
    try {
        const envPath = path.join(__dirname, '.env');
        if (!fs.existsSync(envPath)) return;
        for (let line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
            line = line.trim();
            if (!line || line.startsWith('#')) continue;
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const key = line.slice(0, eq).trim();
            let val = line.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
            if (!(key in process.env)) process.env[key] = val;
        }
    } catch {}
})();

const key = (process.env.ELEVENLABS_API_KEY || '').trim();
if (!key) { console.error('No ELEVENLABS_API_KEY in .env'); process.exit(1); }

(async () => {
    try {
        const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
        if (!res.ok) {
            console.error('ElevenLabs API error:', res.status, await res.text().catch(() => ''));
            process.exit(1);
        }
        const data = await res.json();
        const voices = (data.voices || []).map(v => ({ name: v.name, id: v.voice_id }));
        console.log(`\nYou have ${voices.length} voices in your ElevenLabs account:\n`);
        voices.forEach(v => console.log(`  {${v.name}}   (id: ${v.id})`));
        console.log('\nUse one of the names above in a tag, e.g.  {' + (voices[0] ? voices[0].name : 'VoiceName') + '} Hallo Welt\n');
        console.log('Tip: partial names also work — {' + (voices[0] ? voices[0].name.split(/[\s-]/)[0] : 'Voice') + '} matches the first voice that starts with that word.\n');
    } catch (e) {
        console.error('Request failed:', e.message);
        process.exit(1);
    }
})();
