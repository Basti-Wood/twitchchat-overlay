# Custom Twitch chat overlay + editor

## Wie benutzt man es

1. Kopiere das repo auf deinen server
2. `.env.example` nach `.env` kopieren und ausfüllen (Twitch App, `ADMIN_TWITCH_LOGINS`, `PUBLIC_URL`) – siehe unten
3. starte den server `node server.js` (oder `docker compose up -d --build`)
4. öffne `http://localhost:8080` und klicke **Login with Twitch**
5. Als Admin unter `/html/admin.html` andere Nutzer freigeben (neue Logins landen dort als "pending")
6. den chat konfigurieren wie man es braucht
7. Config speichern (oben rechts)
8. Overlay link kopieren (oben mitte)
9. den link in OBS einfügen.

## Twitch Login einrichten

1. https://dev.twitch.tv/console/apps → deine App öffnen (dieselbe wie für TTS)
2. Unter **OAuth Redirect URLs** zusätzlich eintragen (exakt, Zeichen für Zeichen):
   - lokal: `http://localhost:8080/auth/twitch/callback`
   - Server: `https://deine-domain.tld/auth/twitch/callback`
3. In `.env`: `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`, `PUBLIC_URL` und `ADMIN_TWITCH_LOGINS=dein_twitch_login`
4. Server neu starten.

Wer sich einloggt und nicht freigegeben ist, sieht "wartet auf Freigabe" und erscheint im Admin-Panel.
Admins können dort Nutzer freigeben/sperren, zu Admin machen, den Channel ändern und TTS-Zugriff vergeben.
Alte Einträge aus `accounts.json` werden beim ersten Start automatisch als freigegebene Nutzer übernommen
(Twitch-Login = `channel` des alten Accounts). Danach wird `accounts.json` nicht mehr verwendet und kann gelöscht werden.

## Daten / Updates

Alles was Nutzer hochladen oder speichern liegt in **`data/`** (Docker: `./data` → `/data`, Einstellung `DATA_DIR`):

- `data/uploads/` – Bilder, Fonts, TTS-Audio
- `data/conf/` – config.json, users.json, sessions.json, Twitch-Tokens, TTS-Queue

Zum Updaten nur Code ersetzen (`server.js`, `src/`, `html/`, `css/`, `index.html`) – `data/` nie anfassen (am besten Backup davon machen).
Vorhandene `conf/` und `uploads/` Ordner werden beim ersten Start automatisch (ohne Überschreiben) nach `data/` kopiert.

## Important note

wenn man den chat neu konfiguriert hat muss man die cache auf OBS aktualisieren, damit die veränderungen gezeigt werden können.