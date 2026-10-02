# Promo site (Node.js)

Video hero scrubbed by mouse wheel (PC) or left/right drag (mobile), Popular list (1 column x 6 rows, drag each video left/right), Menu, sticky mobile footer nav. No database.

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

## Behaviour
- The page is never scroll-locked. Until the hero video is fully loaded, scrolling just scrolls the page. Once loaded, the mouse wheel scrubs the hero; at either end of the video the wheel scrolls the page again.
- Mobile: drag the hero left/right to scrub it; vertical swipes always scroll the page.
- Popular cards: drag left/right (touch or mouse), or trackpad swipe / Shift+wheel, to scrub. A plain vertical wheel scrolls the page. A hint with arrows shows until the first drag.
- Only 3 Popular videos are loaded at a time (the ones nearest the middle of the screen); the rest show their poster. They start loading after the hero has finished.

## Caching
Video URLs carry a version (`?v=<file mtime>`, injected via `/menu-data.js`) and are served with `Cache-Control: public, max-age=31536000, immutable`. Browsers keep them and don't re-request; uploading a new clip changes only that clip's version, so only it is downloaded again.
