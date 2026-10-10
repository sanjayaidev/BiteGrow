'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { TENANT_A, TENANT_B } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createAdminRouter } = require('../src/routes/admin');
const { createSecretBox } = require('../src/lib/secrets');

const TENANTS = { a: TENANT_A, b: TENANT_B };

function setup() {
  const db = makeDb({
    bg_profiles: [], bg_tenant_members: [], bg_tenant_settings: [], bg_tenant_integrations: [], bg_categories: [], bg_menu_items: [],
    bg_dining_tables: [
      { id: 1, tenant_id: 'tenant-a', label: '1', token: 'aaaa1111aaaa1111', is_active: true },
      { id: 2, tenant_id: 'tenant-a', label: 'Patio', token: 'bbbb2222bbbb2222', is_active: false },
      { id: 3, tenant_id: 'tenant-b', label: '1', token: 'cccc3333cccc3333', is_active: true },
    ],
  });
  let n = 100;
  db.hooks.bg_dining_tables = (row) => { if (!row.token) row.token = `tok${++n}`.padEnd(16, '0'); if (row.is_active === undefined) row.is_active = true; };
  const admin = db.addUser('admin@a.test');
  const crew = db.addUser('crew@a.test');
  const otherOwner = db.addUser('owner@b.test');
  db.rowsOf('bg_tenant_members').push(
    { tenant_id: 'tenant-a', user_id: admin.id, role: 'admin' },
    { tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' },
    { tenant_id: 'tenant-b', user_id: otherOwner.id, role: 'owner' },
  );
  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    supabase: db.supabase, auth: createAuth({ supabase: db.supabase }), secretBox: createSecretBox('unit-test-secret-key-123'),
    assistant: { reply: async () => ({ text: 'hi' }) },
  }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, tok: { admin: db.token(admin), crew: db.token(crew), other: db.token(otherOwner) } };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, path, { token, body, tenant } = {}) => new Promise((resolve, reject) => {
    const headers = {}; let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s, body: s && (res.headers['content-type'] || '').includes('json') ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call, port); } finally { server.close(); }
}

test('only owners and admins of this restaurant can manage tables', async () => {
  const { app, tok } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', '/api/admin/tables')).status, 401);
    assert.equal((await call('GET', '/api/admin/tables', { token: tok.crew })).status, 403);      // kitchen staff are not enough
    assert.equal((await call('GET', '/api/admin/tables', { token: tok.other })).status, 403);     // owner of another restaurant
    assert.equal((await call('GET', '/api/admin/tables', { token: tok.admin })).status, 200);
  });
});

test('the list shows only this restaurant\'s tables, each with the address its QR code opens', async () => {
  const { app, tok } = setup();
  await run(app, async (call, port) => {
    const a = await call('GET', '/api/admin/tables', { token: tok.admin });
    assert.deepEqual(a.body.tables.map((t) => t.label), ['1', 'Patio']);
    assert.equal(a.body.tables[0].url, `http://127.0.0.1:${port}/?table=aaaa1111aaaa1111`);
    assert.equal(a.body.tables[1].is_active, false);
    const b = await call('GET', '/api/admin/tables', { token: tok.other, tenant: 'b' });
    assert.deepEqual(b.body.tables.map((t) => t.token), ['cccc3333cccc3333']);

    assert.equal(a.body.tables[0].qr_svg, undefined);                                  // images only on request
    const withQr = await call('GET', '/api/admin/tables?qr=1', { token: tok.admin });
    assert.ok(withQr.body.tables.every((t) => /^<svg[\s>]/.test(t.qr_svg)));
  });
});

test('adding one table: trimmed, no duplicates (any capitalisation), length capped', async () => {
  const { app, db, tok } = setup();
  await run(app, async (call) => {
    const ok = await call('POST', '/api/admin/tables', { token: tok.admin, body: { label: '  Window   5 ' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.table.label, 'Window 5');
    assert.ok(ok.body.table.token && ok.body.table.url.includes('?table=' + ok.body.table.token));
    assert.ok(db.rowsOf('bg_dining_tables').some((t) => t.tenant_id === 'tenant-a' && t.label === 'Window 5'));

    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { label: 'patio' } })).status, 409);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { label: 'window 5' } })).status, 409);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { label: '   ' } })).status, 400);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { label: 'x'.repeat(21) } })).status, 400);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: {} })).status, 400);
    // The same name is fine at another restaurant.
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.other, tenant: 'b', body: { label: 'Patio' } })).status, 201);
  });
});

test('adding a numbered range skips names already in use and respects the limits', async () => {
  const { app, db, tok } = setup();
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 4 } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.created.map((t) => t.label), ['2', '3', '4']);      // "1" already exists
    assert.deepEqual(r.body.skipped, ['1']);
    assert.equal(new Set(r.body.created.map((t) => t.token)).size, 3);

    const p = await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 2, prefix: 'T' } });
    assert.deepEqual(p.body.created.map((t) => t.label), ['T1', 'T2']);

    const again = await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 2, prefix: 'T' } });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.created, []);

    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 5, to: 2 } })).status, 400);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 101 } })).status, 400);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 3, prefix: 'x'.repeat(20) } })).status, 400);
    assert.equal((await call('POST', '/api/admin/tables', { token: tok.admin, body: { from: 1, to: 3, prefix: 7 } })).status, 400);
    assert.equal(db.rowsOf('bg_dining_tables').filter((t) => t.tenant_id === 'tenant-b').length, 1);
  });
});

test('renaming keeps the QR code; a table can be switched off; other restaurants\' tables are out of reach', async () => {
  const { app, db, tok } = setup();
  await run(app, async (call) => {
    const r = await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: { label: 'Booth 1' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.table.label, 'Booth 1');
    assert.equal(r.body.table.token, 'aaaa1111aaaa1111');

    const off = await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: { is_active: false } });
    assert.equal(off.body.table.is_active, false);
    assert.equal(db.rowsOf('bg_dining_tables').find((t) => t.id === 1).is_active, false);

    assert.equal((await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: { label: 'PATIO' } })).status, 409);
    assert.equal((await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: { label: 'Booth 1' } })).status, 200);   // its own name is not a clash
    assert.equal((await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: {} })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/tables/1', { token: tok.admin, body: { is_active: 'no' } })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/tables/abc', { token: tok.admin, body: { label: 'x' } })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/tables/99', { token: tok.admin, body: { label: 'x' } })).status, 404);
    assert.equal((await call('PATCH', '/api/admin/tables/3', { token: tok.admin, body: { label: 'Hacked' } })).status, 404);   // table 3 is restaurant B's
    assert.equal(db.rowsOf('bg_dining_tables').find((t) => t.id === 3).label, '1');
  });
});

test('deleting a table removes only that restaurant\'s table', async () => {
  const { app, db, tok } = setup();
  await run(app, async (call) => {
    assert.equal((await call('DELETE', '/api/admin/tables/3', { token: tok.admin })).status, 404);
    assert.equal(db.rowsOf('bg_dining_tables').length, 3);
    assert.equal((await call('DELETE', '/api/admin/tables/2', { token: tok.admin })).status, 200);
    assert.deepEqual(db.rowsOf('bg_dining_tables').map((t) => t.id), [1, 3]);
    assert.equal((await call('DELETE', '/api/admin/tables/2', { token: tok.admin })).status, 404);
  });
});

test('the QR code is an SVG image, and only for this restaurant\'s tables', async () => {
  const { app, tok } = setup();
  await run(app, async (call) => {
    const r = await call('GET', '/api/admin/tables/1/qr.svg', { token: tok.admin });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /image\/svg\+xml/);
    assert.match(r.text, /^<svg[\s>]/);
    assert.equal((await call('GET', '/api/admin/tables/3/qr.svg', { token: tok.admin })).status, 404);
    assert.equal((await call('GET', '/api/admin/tables/1/qr.svg')).status, 401);
  });
});
