'use strict';
// Platform admin: one env key manages every restaurant.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { createPlatformRouter } = require('../src/routes/platform');

const KEY = 'correct-horse-battery';

function setup({ key = KEY, attempts, baseDomain = 'bitegrow.app' } = {}) {
  const db = makeDb({ bg_tenants: [], bg_tenant_settings: [], bg_tenant_domains: [], bg_tenant_members: [] });
  db.hooks.bg_tenants = (row) => { row.id = db.uuid(); row.created_at = '2026-01-01T00:00:00Z'; row.languages = row.languages || ['en']; row.default_lang = row.default_lang || 'en'; };   // what the database fills in
  const changed = [];
  const app = express();
  app.use('/api/platform', createPlatformRouter({ supabase: db.supabase, key, baseDomain, attempts, onTenantChanged: (id) => changed.push(id) }));
  app.use((err, req, res, next) => res.status(err.status && err.expose ? err.status : 500).json({ error: err.expose ? err.message : 'Server error' }));
  return { db, app, changed };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, path, { body, key = KEY } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (key) headers.authorization = 'Bearer ' + key;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

const P = '/api/platform';
const mk = (over = {}) => ({ slug: 'wok-star', name: 'Wok Star', ...over });

test('platform: switched off without a long enough key', async () => {
  for (const key of [null, '', 'short']) {
    const { app } = setup({ key });
    await run(app, async (call) => {
      const r = await call('GET', P + '/tenants', { key: key || 'anything' });
      assert.equal(r.status, 503);
      assert.match(r.body.error, /PLATFORM_ADMIN_KEY/);
    });
  }
});

test('platform: needs the right key; only wrong keys count toward the lockout', async () => {
  const { app } = setup({ attempts: 3 });
  await run(app, async (call) => {
    assert.equal((await call('GET', P + '/session', { key: null })).status, 401);
    assert.equal((await call('GET', P + '/session', { key: 'nope' })).status, 401);
    // many correct calls never lock anyone out
    for (let i = 0; i < 6; i++) assert.equal((await call('GET', P + '/session')).status, 200);
    assert.equal((await call('GET', P + '/session', { key: 'wrong-1' })).status, 401);   // 3rd wrong (incl. the two above? first was key:null)
    const locked = await call('GET', P + '/session');                                    // even the right key waits after too many wrong ones
    assert.equal(locked.status, 429);
  });
});

test('platform: an unknown path is a JSON 404 once signed in', async () => {
  const { app } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', P + '/nothing')).status, 404);
  });
});

test('platform: create a restaurant with settings, domain and a new owner account', async () => {
  const { db, app, changed } = setup();
  await run(app, async (call) => {
    const r = await call('POST', P + '/tenants', { body: mk({
      timezone: 'Asia/Kolkata', currency: 'inr', currency_symbol: '₹', languages: 'en, ar', logo_url: 'img/logo.png',
      domain: 'Order.Wokstar.com', owner_email: 'Boss@Wok.test', owner_password: 'temp-pass-1',
    }) });
    assert.equal(r.status, 201);
    const t = r.body.tenant;
    assert.equal(t.slug, 'wok-star'); assert.equal(t.status, 'active'); assert.equal(t.currency, 'INR');
    assert.equal(t.order_prefix, 'WOK'); assert.deepEqual(t.languages, ['en', 'ar']); assert.equal(t.default_lang, 'en');
    assert.equal(t.brand_name, 'Wok Star'); assert.equal(t.logo_url, 'img/logo.png');
    assert.deepEqual(t.domains, [{ domain: 'order.wokstar.com', is_primary: true }]);
    assert.equal(t.url, 'https://order.wokstar.com');
    assert.deepEqual(r.body.owner, { email: 'boss@wok.test', created_account: true });
    assert.equal(db.rowsOf('bg_tenant_settings').length, 1);
    const members = db.rowsOf('bg_tenant_members');
    assert.equal(members.length, 1); assert.equal(members[0].role, 'owner'); assert.equal(members[0].tenant_id, t.id);
    assert.deepEqual(changed, [t.id]);

    // the list shows it, with the address falling back to <slug>.<BASE_DOMAIN> when there is no domain
    await call('POST', P + '/tenants', { body: mk({ slug: 'plain-one', name: 'Plain' }) });
    const list = (await call('GET', P + '/tenants')).body;
    assert.equal(list.tenants.length, 2);
    assert.equal(list.tenants.find((x) => x.slug === 'plain-one').url, 'https://plain-one.bitegrow.app');
  });
});

test('platform: create refuses bad input and leaves nothing behind', async () => {
  const { db, app } = setup();
  await run(app, async (call) => {
    const bad = async (body, re) => { const r = await call('POST', P + '/tenants', { body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.body.error, re); };
    await bad({ name: 'X' }, /Web name/);
    await bad(mk({ slug: 'Bad Slug' }), /Web name/);
    await bad(mk({ slug: '-ab-' }), /Web name/);
    await bad(mk({ name: '   ' }), /name is required/);
    await bad(mk({ logo_url: 'javascript:alert(1)' }), /Logo link/);
    await bad(mk({ logo_url: 'http://insecure.example/a.png' }), /Logo link/);
    await bad(mk({ domain: 'https://x.com/path' }), /Domain/);
    await bad(mk({ timezone: 'Mars/Base' }), /Timezone/);
    await bad(mk({ currency: 'RUPEES' }), /Currency/);
    await bad(mk({ order_prefix: 'a' }), /prefix/);
    await bad(mk({ order_prefix: 'TOOLONGPREFIX' }), /prefix/);
    await bad(mk({ currency_symbol: 'way too long' }), /symbol/);
    await bad(mk({ languages: 'english' }), /Languages/);
    await bad(mk({ owner_email: 'nope' }), /Owner email/);
    // a new owner account needs a password, and that is checked before the restaurant is created
    const noPw = await call('POST', P + '/tenants', { body: mk({ owner_email: 'new@person.test' }) });
    assert.equal(noPw.status, 404);
    assert.equal(db.rowsOf('bg_tenants').length, 0);
    assert.equal(db.rowsOf('bg_tenant_settings').length, 0);
  });
});

test('platform: a failure part-way through removes the half-made restaurant', async () => {
  const { db, app, changed } = setup();
  await run(app, async (call) => {
    db.failNext('bg_tenant_domains', 'insert', 'disk on fire');
    const r = await call('POST', P + '/tenants', { body: mk({ domain: 'a.example.com' }) });
    assert.equal(r.status, 500);
    assert.equal(db.rowsOf('bg_tenants').length, 0);          // rolled back
    assert.deepEqual(changed, []);
  });
});

test('platform: web names and domains are unique', async () => {
  const { app } = setup();
  await run(app, async (call) => {
    assert.equal((await call('POST', P + '/tenants', { body: mk({ domain: 'a.example.com' }) })).status, 201);
    assert.equal((await call('POST', P + '/tenants', { body: mk({ name: 'Other' }) })).status, 409);                       // same slug
    const dup = await call('POST', P + '/tenants', { body: mk({ slug: 'second', domain: 'A.example.com' }) });             // same domain
    assert.equal(dup.status, 409); assert.match(dup.body.error, /domain/i);
  });
});

test('platform: edit name, branding and suspend / activate', async () => {
  const { db, app, changed } = setup();
  await run(app, async (call) => {
    const id = (await call('POST', P + '/tenants', { body: mk() })).body.tenant.id;
    changed.length = 0;
    const r = await call('PATCH', `${P}/tenants/${id}`, { body: { brand_name: 'WOK STAR', logo_url: 'https://cdn.example.com/l.png', status: 'suspended', languages: ['ar', 'en'] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.tenant.status, 'suspended'); assert.equal(r.body.tenant.brand_name, 'WOK STAR');
    assert.equal(r.body.tenant.logo_url, 'https://cdn.example.com/l.png');
    assert.equal(r.body.tenant.default_lang, 'ar'); assert.deepEqual(r.body.tenant.languages, ['ar', 'en']);
    assert.deepEqual(changed, [id]);

    const cleared = await call('PATCH', `${P}/tenants/${id}`, { body: { logo_url: '', status: 'active' } });
    assert.equal(cleared.body.tenant.logo_url, ''); assert.equal(cleared.body.tenant.status, 'active');
    assert.equal(db.rowsOf('bg_tenant_settings')[0].logo_url, null);          // stored as null: the site shows the name as text

    const patch = (body) => call('PATCH', `${P}/tenants/${id}`, { body });
    assert.equal((await patch({ status: 'deleted' })).status, 400);
    assert.equal((await patch({ logo_url: '//evil.example/x.png' })).status, 400);
    assert.equal((await patch({ brand_name: '' })).status, 400);
    assert.equal((await patch({})).status, 400);
    assert.equal((await call('PATCH', `${P}/tenants/${db.uuid()}`, { body: { name: 'Ghost' } })).status, 404);
    assert.equal((await call('PATCH', `${P}/tenants/not%20an%20id!`, { body: { name: 'Ghost' } })).status, 400);
  });
});

test('platform: domains can be added and removed; the first real one is the main address', async () => {
  const { db, app } = setup();
  await run(app, async (call) => {
    const id = (await call('POST', P + '/tenants', { body: mk() })).body.tenant.id;
    const d1 = await call('POST', `${P}/tenants/${id}/domains`, { body: { domain: 'one.example.com' } });
    assert.equal(d1.status, 201);
    const d2 = await call('POST', `${P}/tenants/${id}/domains`, { body: { domain: 'two.example.com' } });
    assert.deepEqual(d2.body.tenant.domains.map((d) => [d.domain, d.is_primary]), [['one.example.com', true], ['two.example.com', false]]);
    assert.equal(d2.body.tenant.url, 'https://one.example.com');
    assert.equal((await call('POST', `${P}/tenants/${id}/domains`, { body: { domain: 'two.example.com' } })).status, 409);
    assert.equal((await call('POST', `${P}/tenants/${id}/domains`, { body: { domain: 'not a domain' } })).status, 400);

    // another restaurant cannot take it
    const other = (await call('POST', P + '/tenants', { body: mk({ slug: 'other-one', name: 'Other' }) })).body.tenant.id;
    const steal = await call('POST', `${P}/tenants/${other}/domains`, { body: { domain: 'one.example.com' } });
    assert.equal(steal.status, 409); assert.match(steal.body.error, /another restaurant/);

    const rm = await call('DELETE', `${P}/tenants/${id}/domains/two.example.com`);
    assert.equal(rm.status, 200); assert.equal(rm.body.tenant.domains.length, 1);
    assert.equal((await call('DELETE', `${P}/tenants/${id}/domains/two.example.com`)).status, 404);
    assert.equal((await call('DELETE', `${P}/tenants/${other}/domains/one.example.com`)).status, 404);     // not theirs
    assert.equal(db.rowsOf('bg_tenant_domains').length, 1);
  });
});

test('platform: owners can be attached, created, and listed', async () => {
  const { db, app } = setup();
  const existing = db.addUser('chef@place.test');
  await run(app, async (call) => {
    const id = (await call('POST', P + '/tenants', { body: mk() })).body.tenant.id;
    const url = `${P}/tenants/${id}/owner`;
    assert.equal((await call('POST', url, { body: { email: 'bad' } })).status, 400);
    assert.equal((await call('POST', url, { body: { email: 'new@place.test' } })).status, 404);                     // unknown account, no password
    assert.equal((await call('POST', url, { body: { email: 'new@place.test', password: 'short' } })).status, 400);

    const a = await call('POST', url, { body: { email: 'Chef@Place.test' } });                                       // existing account
    assert.equal(a.status, 201); assert.deepEqual(a.body.owner, { email: 'chef@place.test', created_account: false });
    const b = await call('POST', url, { body: { email: 'new@place.test', password: 'long-enough-1' } });             // new account
    assert.equal(b.body.owner.created_account, true);

    // an existing team member is promoted instead of duplicated
    db.rowsOf('bg_tenant_members').find((m) => m.user_id === existing.id).role = 'staff';
    assert.equal((await call('POST', url, { body: { email: 'chef@place.test' } })).status, 201);
    const members = (await call('GET', `${P}/tenants/${id}/members`)).body.members;
    assert.deepEqual(members.map((m) => [m.email, m.role]), [['chef@place.test', 'owner'], ['new@place.test', 'owner']]);
  });
});
