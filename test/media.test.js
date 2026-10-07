'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { TENANT_A, TENANT_B } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createAdminRouter } = require('../src/routes/admin');
const { createSecretBox } = require('../src/lib/secrets');
const { FFMPEG_PATH } = require('../src/routes/media');

const TENANTS = { a: TENANT_A, b: TENANT_B };

function setup({ ffmpeg } = {}) {
  const db = makeDb({
    bg_profiles: [], bg_tenant_members: [], bg_tenant_integrations: [], bg_tenant_media: [],
    bg_tenant_settings: [{ tenant_id: 'tenant-a', features: { ar3d: true } }, { tenant_id: 'tenant-b', features: {} }],
    bg_menu_items: [1, 2, 3, 4, 5, 6].map((id) => ({ id, tenant_id: 'tenant-a', is_available: id !== 6 })).concat([{ id: 50, tenant_id: 'tenant-b', is_available: true }]),
  });
  const staff = db.addUser('owner@a.test');
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: staff.id, role: 'admin' });
  const crew = db.addUser('crew@a.test');
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' });

  const stored = new Map();                                   // object path -> bytes
  const storage = { from: (bucketName) => ({
    upload: async (p, body) => { stored.set(`${bucketName}/${p}`, body); return { error: null }; },
    remove: async (paths) => { paths.forEach((p) => stored.delete(`${bucketName}/${p}`)); return { error: null }; },
    getPublicUrl: (p) => ({ data: { publicUrl: `https://files.test/${bucketName}/${p}` } }),
  }) };
  const supabase = { ...db.supabase, storage };

  const calls = [];
  const runFfmpeg = ffmpeg || (async (args) => { calls.push(args); fs.writeFileSync(args[args.length - 1], 'x'.repeat(100)); });
  const events = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-media-test-'));

  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    supabase, auth: createAuth({ supabase }), secretBox: createSecretBox('unit-test-secret-key-123'), assistant: { reply: async () => ({}) },
    onMenuChanged: (id) => events.push(id),
    mediaOptions: { runFfmpeg, tmpDir, log: { error: () => {} } },
  }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, stored, calls, events, tmpDir, tokens: { staff: db.token(staff), crew: db.token(crew) } };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, p, { token, body, video, tenant } = {}) => new Promise((resolve, reject) => {
    const headers = {}; let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    if (video) {
      const b = '----t' + Math.random().toString(16).slice(2);
      data = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="video"; filename="${video.name}"\r\nContent-Type: video/mp4\r\n\r\n`), Buffer.from('fakevideo'), Buffer.from(`\r\n--${b}--\r\n`)]);
      headers['content-type'] = 'multipart/form-data; boundary=' + b;
    } else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; }
    if (data) headers['content-length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s && (res.headers['content-type'] || '').includes('json') ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

test('ffmpeg is the program at the repository root (fixed path, no environment setting)', () => {
  assert.equal(FFMPEG_PATH, path.join(__dirname, '..', 'ffmpeg'));
  assert.ok(fs.existsSync(FFMPEG_PATH));
  assert.equal(process.env.FFMPEG_PATH, undefined);
});

test('media routes need an owner or admin of this restaurant', async () => {
  const { app, tokens } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', '/api/admin/media')).status, 401);
    assert.equal((await call('GET', '/api/admin/media', { token: tokens.crew })).status, 403);
    assert.equal((await call('GET', '/api/admin/media', { token: tokens.staff, tenant: 'b' })).status, 403);
    assert.equal((await call('GET', '/api/admin/media', { token: tokens.staff })).status, 200);
  });
});

test('hero upload: encodes, stores under the restaurant, saves the links, clears the page cache', async () => {
  const { app, tokens, stored, calls, events, db } = setup();
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'clip.mp4' } });
    assert.equal(r.status, 200);
    assert.match(r.body.video_url, /^https:\/\/files\.test\/videos\/tenant-a\/hero\.mp4\?v=\d+$/);
    assert.match(r.body.poster_url, /tenant-a\/hero\.jpg/);
    assert.deepEqual([...stored.keys()].sort(), ['videos/tenant-a/hero.jpg', 'videos/tenant-a/hero.mp4']);
    assert.equal(calls.length, 2);                                      // one encode, one poster frame
    assert.ok(calls[0].includes('-an') && calls[0].includes('6'));       // no audio, 6 s for the hero
    assert.deepEqual(events, ['tenant-a']);
    const row = db.rowsOf('bg_tenant_media')[0];
    assert.equal(row.tenant_id, 'tenant-a'); assert.equal(row.slot, 'hero');

    const list = await call('GET', '/api/admin/media', { token: tokens.staff });
    assert.ok(list.body.hero.video_url); assert.equal(list.body.special, null);
  });
});

test('special upload uses the small, every-frame-a-keyframe encoding', async () => {
  const { app, tokens, calls } = setup();
  await run(app, async (call) => {
    assert.equal((await call('POST', '/api/admin/media/special', { token: tokens.staff, video: { name: 'x.mov' } })).status, 200);
    assert.ok(calls[0].includes('-g') && calls[0].includes('10'));
  });
});

test('unknown slot, wrong file type and a missing file are refused without running ffmpeg', async () => {
  const { app, tokens, calls } = setup();
  await run(app, async (call) => {
    assert.equal((await call('POST', '/api/admin/media/banner', { token: tokens.staff, video: { name: 'a.mp4' } })).status, 404);
    assert.equal((await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'notes.txt' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/media/hero', { token: tokens.staff, body: {} })).status, 400);
    assert.equal(calls.length, 0);
  });
});

test('an encoded file over 4.5 MB is refused and nothing is stored', async () => {
  const big = async (args) => { fs.writeFileSync(args[args.length - 1], Buffer.alloc(4_600_000)); };
  const { app, tokens, stored, db } = setup({ ffmpeg: big });
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'a.mp4' } });
    assert.equal(r.status, 400); assert.match(r.body.error, /4\.5 MB/);
    assert.equal(stored.size, 0); assert.equal(db.rowsOf('bg_tenant_media').length, 0);
  });
});

test('an ffmpeg failure gives a friendly error, leaves no temp files, and frees the server for the next upload', async () => {
  let n = 0;
  const flaky = async (args) => { if (n++ === 0) throw new Error('moov atom not found'); fs.writeFileSync(args[args.length - 1], 'ok'); };
  const { app, tokens } = setup({ ffmpeg: flaky });
  await run(app, async (call) => {
    const bad = await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'a.mp4' } });
    assert.equal(bad.status, 500); assert.doesNotMatch(JSON.stringify(bad.body), /moov/);
    assert.equal((await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'a.mp4' } })).status, 200);
  });
});

test('delete removes the files and the saved links', async () => {
  const { app, tokens, stored, db } = setup();
  await run(app, async (call) => {
    await call('POST', '/api/admin/media/hero', { token: tokens.staff, video: { name: 'a.mp4' } });
    const r = await call('DELETE', '/api/admin/media/hero', { token: tokens.staff });
    assert.equal(r.status, 200); assert.equal(r.body.hero, null);
    assert.equal(stored.size, 0); assert.equal(db.rowsOf('bg_tenant_media').length, 0);
  });
});

test('special items: exactly five different, available dishes of this restaurant', async () => {
  const { app, tokens, db, events } = setup();
  await run(app, async (call) => {
    const put = (ids, tenant) => call('PUT', '/api/admin/media/special-items', { token: tokens.staff, body: { item_ids: ids }, tenant });
    assert.equal((await put([1, 2, 3, 4])).status, 400);                 // too few
    assert.equal((await put([1, 2, 3, 4, 4])).status, 400);              // duplicate
    assert.equal((await put([1, 2, 3, 4, 6])).status, 400);              // 6 is sold out
    assert.equal((await put([1, 2, 3, 4, 50])).status, 400);             // 50 belongs to another restaurant
    const ok = await put([5, 4, 3, 2, 1]);
    assert.equal(ok.status, 200);
    const features = db.rowsOf('bg_tenant_settings').find((s) => s.tenant_id === 'tenant-a').features;
    assert.deepEqual(features.specialItemIds, [5, 4, 3, 2, 1]);
    assert.equal(features.ar3d, true);                                    // other switches kept
    assert.deepEqual(events, ['tenant-a']);
    assert.deepEqual((await call('GET', '/api/admin/media/special-items', { token: tokens.staff })).body.item_ids, [5, 4, 3, 2, 1]);
  });
});
