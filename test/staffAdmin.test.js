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
    bg_profiles: [], bg_tenant_members: [], bg_categories: [], bg_menu_items: [], bg_tenant_integrations: [],
    bg_tenant_settings: [{ tenant_id: 'tenant-a', brand_name: 'RED HOUSE', features: { ar3d: true } }],
  });
  const owner = db.addUser('owner@a.test');        // u1
  const admin = db.addUser('admin@a.test');        // u2
  const crew = db.addUser('crew@a.test');          // u3
  const customer = db.addUser('cust@a.test');      // u4, no role anywhere
  const otherStaff = db.addUser('staff@b.test');   // u5, works at restaurant B
  db.rowsOf('bg_tenant_members').push(
    { tenant_id: 'tenant-a', user_id: owner.id, role: 'owner' },
    { tenant_id: 'tenant-a', user_id: admin.id, role: 'admin' },
    { tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' },
    { tenant_id: 'tenant-b', user_id: otherStaff.id, role: 'staff' },
  );
  db.rowsOf('bg_profiles').push({ id: crew.id, display_name: 'Chef Crew' });
  db.rowsOf('bg_menu_items').push({ id: 1, tenant_id: 'tenant-a', name: { en: 'Mine' } }, { id: 2, tenant_id: 'tenant-b', name: { en: 'Theirs' } });
  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    supabase: db.supabase, auth: createAuth({ supabase: db.supabase }), secretBox: createSecretBox('unit-test-secret-key-123'),
    assistant: { reply: async () => ({ text: 'hi' }) },
  }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, ids: { owner, admin, crew, customer, otherStaff }, tokens: { owner: db.token(owner), admin: db.token(admin), crew: db.token(crew) } };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, path, { token, body } = {}) => new Promise((resolve, reject) => {
    const headers = {}; let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s && (res.headers['content-type'] || '').includes('json') ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

test('staff: only the owner manages the team', async () => {
  const { app, tokens } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', '/api/admin/staff')).status, 401);
    assert.equal((await call('GET', '/api/admin/staff', { token: tokens.crew })).status, 403);
    assert.equal((await call('GET', '/api/admin/staff', { token: tokens.admin })).status, 403);       // an admin may run the menu, not the team
    assert.equal((await call('POST', '/api/admin/staff', { token: tokens.admin, body: { email: 'x@y.test', role: 'staff' } })).status, 403);
    assert.equal((await call('GET', '/api/admin/staff', { token: tokens.owner })).status, 200);
  });
});

test('staff: list shows this restaurant\'s team with emails, owner first', async () => {
  const { app, tokens } = setup();
  await run(app, async (call) => {
    const r = await call('GET', '/api/admin/staff', { token: tokens.owner });
    assert.deepEqual(r.body.staff.map((s) => [s.email, s.role]), [['owner@a.test', 'owner'], ['admin@a.test', 'admin'], ['crew@a.test', 'staff']]);
    assert.equal(r.body.staff[0].is_you, true);
    assert.equal(r.body.staff[2].display_name, 'Chef Crew');
    assert.ok(!r.body.staff.some((s) => s.email === 'staff@b.test'));                                  // the other restaurant's staff stay private
  });
});

test('staff: add an existing account, create one with a temporary password, and refuse bad input', async () => {
  const { app, db, tokens, ids } = setup();
  await run(app, async (call) => {
    const add = (body) => call('POST', '/api/admin/staff', { token: tokens.owner, body });
    assert.equal((await add({ email: 'nope', role: 'staff' })).status, 400);
    assert.equal((await add({ email: 'cust@a.test', role: 'owner' })).status, 400);                    // owner cannot be handed out here
    assert.equal((await add({ email: 'new@a.test', role: 'staff' })).status, 404);                     // no account and no password

    const existing = await add({ email: 'CUST@a.test', role: 'staff' });
    assert.equal(existing.status, 201);
    assert.equal(existing.body.member.created_account, false);
    assert.ok(db.rowsOf('bg_tenant_members').some((m) => m.tenant_id === 'tenant-a' && m.user_id === ids.customer.id && m.role === 'staff'));
    assert.equal((await add({ email: 'cust@a.test', role: 'admin' })).status, 409);                    // already on the team
    assert.equal((await add({ email: 'owner@a.test', role: 'admin' })).status, 409);

    assert.equal((await add({ email: 'new@a.test', role: 'admin', password: 'short' })).status, 400);
    const made = await add({ email: 'new@a.test', role: 'admin', password: 'longenough1' });
    assert.equal(made.status, 201);
    assert.equal(made.body.member.created_account, true);
    assert.ok(db.rowsOf('bg_tenant_members').some((m) => m.tenant_id === 'tenant-a' && m.role === 'admin' && m.user_id !== ids.admin.id));

    // A person who already works at restaurant B can also be added here: accounts are global, roles are per restaurant.
    assert.equal((await add({ email: 'staff@b.test', role: 'staff' })).status, 201);
  });
});

test('staff: change a role or remove someone, but never the owner, yourself or another restaurant\'s people', async () => {
  const { app, db, tokens, ids } = setup();
  await run(app, async (call) => {
    const asOwner = (method, path, body) => call(method, '/api/admin/staff' + path, { token: tokens.owner, body });
    assert.equal((await asOwner('PATCH', '/' + ids.crew.id, { role: 'owner' })).status, 400);
    assert.equal((await asOwner('PATCH', '/' + ids.crew.id, { role: 'admin' })).status, 200);
    assert.equal(db.rowsOf('bg_tenant_members').find((m) => m.user_id === ids.crew.id).role, 'admin');

    assert.equal((await asOwner('PATCH', '/' + ids.owner.id, { role: 'staff' })).status, 403);         // the owner is untouchable
    assert.equal((await asOwner('DELETE', '/' + ids.owner.id)).status, 403);
    assert.equal((await asOwner('DELETE', '/' + ids.otherStaff.id)).status, 404);                      // belongs to restaurant B
    assert.equal((await asOwner('DELETE', '/' + ids.customer.id)).status, 404);
    assert.equal((await asOwner('DELETE', '/bad%20id!')).status, 400);

    assert.equal((await asOwner('DELETE', '/' + ids.crew.id)).status, 200);
    assert.ok(!db.rowsOf('bg_tenant_members').some((m) => m.user_id === ids.crew.id && m.tenant_id === 'tenant-a'));
    assert.ok(db.rowsOf('bg_tenant_members').some((m) => m.user_id === ids.otherStaff.id));            // B's row is untouched
  });
});

test('settings: homepage layout is validated and merged with the other feature flags', async () => {
  const { app, db, tokens } = setup();
  await run(app, async (call) => {
    const put = (features) => call('PUT', '/api/admin/settings', { token: tokens.owner, body: { features } });
    assert.equal((await put({ heroMode: 'sideways' })).status, 400);
    assert.equal((await put({ heroSpeed: 0 })).status, 400);
    assert.equal((await put({ heroSpeed: 11 })).status, 400);
    assert.equal((await put({ heroSpeed: 2.5 })).status, 400);
    assert.equal((await put({ topPick: 'yes' })).status, 400);
    assert.equal((await put({ topPickItemId: 2 })).status, 400);                                       // a dish of another restaurant
    assert.equal((await put({ topPickItemId: 999 })).status, 400);
    assert.equal((await put({ topPickItemId: 'abc' })).status, 400);

    const ok = await put({ heroMode: 'auto', heroSpeed: '7', topPick: false, topPickItemId: 1 });
    assert.equal(ok.status, 200);
    assert.deepEqual(db.rowsOf('bg_tenant_settings')[0].features, { ar3d: true, heroMode: 'auto', heroSpeed: 7, topPick: false, topPickItemId: 1 });
    assert.deepEqual(ok.body.features, db.rowsOf('bg_tenant_settings')[0].features);

    // Choosing "best rated" again removes the pinned dish; a separate save of ar3d keeps the homepage choices.
    await put({ topPickItemId: null });
    assert.equal('topPickItemId' in db.rowsOf('bg_tenant_settings')[0].features, false);
    await put({ ar3d: false });
    assert.deepEqual(db.rowsOf('bg_tenant_settings')[0].features, { ar3d: false, heroMode: 'auto', heroSpeed: 7, topPick: false });
  });
});
