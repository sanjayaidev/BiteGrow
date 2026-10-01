const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const VIDEOS_DIR = path.join(PUBLIC_DIR, 'videos');
const TMP_DIR = path.join(os.tmpdir(), 'promo-uploads');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''; // optional: protects /admin and uploads
const SLOTS = ['hero', 'pop1', 'pop2', 'pop3'];
fs.mkdirSync(VIDEOS_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

// ffmpeg: FFMPEG_PATH env > ffmpeg.exe / ffmpeg next to server.js > PATH
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const names = process.platform === 'win32' ? ['ffmpeg.exe'] : ['ffmpeg'];
  for (const n of names) {
    const p = path.join(__dirname, n);
    if (!fs.existsSync(p)) continue;
    if (process.platform !== 'win32') {
      try { fs.chmodSync(p, fs.statSync(p).mode | 0o100); }
      catch (e) { console.error(`Cannot make bundled ffmpeg executable: ${e.message}`); }
    }
    return p;
  }
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();
const ffmpeg = (args, cb) => execFile(FFMPEG, ['-y', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 1 << 24 }, cb);

function auth(req, res, next) {
  if (!ADMIN_PASSWORD) return next();
  const raw = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString();
  if (raw.slice(raw.indexOf(':') + 1) === ADMIN_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="admin"').status(401).send('Password required');
}

const app = express();

// Menu comes from menu.json; edit it and refresh. Served as a script so the page needs no async loading.
app.get('/menu-data.js', (req, res) => {
  let menu = { categories: [], items: [] };
  try { menu = JSON.parse(fs.readFileSync(path.join(__dirname, 'menu.json'), 'utf8')); } catch (e) { console.error('menu.json:', e.message); }
  res.type('text/javascript').set('Cache-Control', 'no-cache').send(`window.MENU = ${JSON.stringify(menu)};`);
});
app.get('/api/menu', (req, res) => res.sendFile(path.join(__dirname, 'menu.json')));

app.get(['/admin', '/admin.html'], auth, (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// express.static handles HTTP Range requests, which video seeking needs.
app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  setHeaders: (res, file) => { if (file.startsWith(VIDEOS_DIR)) res.set('Cache-Control', 'no-cache'); }
}));

const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    ['.mp4', '.mov', '.webm', '.mkv', '.avi', '.m4v'].includes(ext) ? cb(null, true) : cb(new Error('Unsupported file type ' + ext));
  }
});

// POST /api/upload/:slot  (slot = hero | pop1 | pop2 | pop3), form field "video"
app.post('/api/upload/:slot', auth, (req, res) => {
  const slot = req.params.slot;
  if (!SLOTS.includes(slot)) return res.status(404).json({ error: 'Unknown slot' });
  upload.single('video')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No video received' });
    const src = req.file.path;
    const isHero = slot === 'hero';
    const tmpOut = path.join(TMP_DIR, `${slot}-${Date.now()}.mp4`);
    // hero and popular: every frame a keyframe (-g 1) so scroll scrubbing is smooth
    const vArgs = isHero
      ? ['-i', src, '-t', '30', '-an', '-vf', 'fps=30,scale=960:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-g', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpOut]
      : ['-i', src, '-t', '12', '-an', '-vf', 'fps=30,scale=640:-2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-g', '1', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmpOut];
    const done = (status, body) => { fs.unlink(src, () => {}); fs.unlink(tmpOut, () => {}); res.status(status).json(body); };
    ffmpeg(vArgs, (e, so, se) => {
      if (e) return done(500, { error: e.code === 'ENOENT' ? `ffmpeg not found (${FFMPEG}). Put ffmpeg.exe next to server.js or set FFMPEG_PATH.` : 'ffmpeg failed', detail: String(se || e.message).split('\n').slice(-4).join('\n') });
      ffmpeg(['-i', src, '-frames:v', '1', '-vf', `scale=${isHero ? 960 : 640}:-2`, '-q:v', '3', path.join(VIDEOS_DIR, `${slot}.jpg`)], e2 => {
        if (e2) return done(500, { error: 'poster failed' });
        try { fs.copyFileSync(tmpOut, path.join(VIDEOS_DIR, `${slot}.mp4`)); } catch (e3) { return done(500, { error: e3.message }); }
        done(200, { success: true, slot, v: Date.now() });
      });
    });
  });
});

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });

process.on('uncaughtException', e => { console.error('\nCRASH:', e && e.stack || e); process.exit(1); });

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  require('child_process').exec(cmd, () => {});
}

function start(port, tries) {
  const srv = app.listen(port);
  srv.on('listening', () => {
    const url = `http://localhost:${port}`;
    console.log('\n==============================================');
    console.log(`  SERVER RUNNING  ->  ${url}`);
    console.log(`  Admin           ->  ${url}/admin${ADMIN_PASSWORD ? '  (password protected)' : '  (no password set; set ADMIN_PASSWORD)'}`);
    console.log('  Keep this window open. Ctrl+C to stop.');
    console.log('==============================================\n');
    execFile(FFMPEG, ['-version'], { windowsHide: true }, e => console.log(e ? `ffmpeg: NOT FOUND (${FFMPEG}) - site works, uploads need ffmpeg.exe next to server.js` : `ffmpeg: ${FFMPEG}`));
    openBrowser(url);
  });
  srv.on('error', e => {
    if (e.code === 'EADDRINUSE' && tries < 15) { console.log(`Port ${port} is busy, trying ${port + 1}...`); return start(port + 1, tries + 1); }
    console.error(`\nCannot start server on port ${port}: ${e.code || ''} ${e.message}`);
    process.exit(1);
  });
}
start(Number(PORT), 0);
