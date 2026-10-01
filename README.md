# Promo site (Node.js)

Scroll-scrubbed video hero, Popular row (3 x 16:9), Menu, sticky mobile footer nav. No database.

## Run
    npm install
    npm start          # http://localhost:3000

Windows: double-click `start.bat` (installs on first run, then opens the browser).

## Change content
- Menu: edit `menu.json`, refresh the page.
- Brand text / hero slides: `public/index.html`. Colours: top of `public/app.css`.
- Videos (hero and Popular both play by scroll position, not autoplay; short 5-15 s clips work best): open http://localhost:3000/admin and upload a clip per slot; the server runs ffmpeg for you.
  - Windows: download a build (gyan.dev "release essentials" or BtbN), copy `ffmpeg.exe` next to `server.js`.
  - Or set `FFMPEG_PATH`, or have `ffmpeg` on PATH.

## Options (env vars)
`PORT` (default 3000), `ADMIN_PASSWORD` (protects /admin and uploads; any username), `FFMPEG_PATH`

PowerShell example: `$env:ADMIN_PASSWORD="secret"; npm start`
