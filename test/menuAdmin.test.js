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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);

function setup({ uploadError } = {}) {
  const db = makeDb({
    bg_profiles: [], bg_tenant_members: [], bg_tenant_integrations: [], bg_tenant_media: [], bg_tenant_settings: [],
    bg_categories: [
      { id: 1, tenant_id: 'tenant-a', key: 'starters', label: { en: 'Starters' }, sort_order: 1 },
      { id: 2, tenant_id: 'tenant-a', key: 'mains', label: { en: 'Mains' }, sort_order: 2 },
      { id: 9, tenant_id: 'tenant-b', key: 'other', label: { en: 'Other' }, sort_order: 1 },
    ],
    bg_menu_items: [
      { id: 10, tenant_id: 'tenant-a', category_id: 1, name: { en: 'Soup', ar: 'شوربة' }, description: {}, price: 5, sort_order: 1, is_available: true, is_offer: false },
      { id: 90, tenant_id: 'tenant-b', category_id: 9, name: { en: 'Noodles' }, description: {}, price: 7, sort_order: 1, is_available: true, is_offer: false },
    ],
  });
  let nextCat = 100;
  db.hooks.bg_categories = (r) => { r.id = ++nextCat; };            // new rows must not reuse the seeded ids
  const staff = db.addUser('owner@a.test');
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: staff.id, role: 'admin' });
  const crew = db.addUser('crew@a.test');
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' });
  const stored = new Map();
  const storage = { from: (bucket) => ({
    upload: async (p, body) => { if (uploadError) return { error: new Error('no bucket') }; stored.set(`${bucket}/${p}`, body); return { error: null }; },
    getPublicUrl: (p) => ({ data: { publicUrl: `https://files.test/${bucket}/${p}` } }),
  }) };
  const supabase = { ...db.supabase, storage };
  const events = [];
  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ supabase, auth: createAuth({ supabase }), secretBox: createSecretBox('unit-test-secret-key-123'), assistant: { reply: async () => ({}) }, onMenuChanged: (id) => events.push(id) }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, stored, events, staff: db.token(staff), crew: db.token(crew) };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, p, { token, body, image } = {}) => new Promise((resolve, reject) => {
    const headers = {}; let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (image) {
      const b = '----t' + Math.random().toString(16).slice(2);
      data = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`), image, Buffer.from(`\r\n--${b}--\r\n`)]);
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

test('only owners/admins can edit the menu', async () => {
  const s = setup();
  await run(s.app, async (call) => {
    assert.equal((await call('GET', '/api/admin/items')).status, 401);
    assert.equal((await call('GET', '/api/admin/items', { token: s.crew })).status, 403);
    assert.equal((await call('POST', '/api/admin/categories', { token: s.crew, body: { label: { en: 'X' } } })).status, 403);
  });
});

test('categories: list with counts, create, rename (merged), re-key, delete rules', async () => {
  const s = setup();
  await run(s.app, async (call) => {
    const t = s.staff;
    const list = await call('GET', '/api/admin/categories', { token: t });
    assert.deepEqual(list.body.categories.map((c) => [c.key, c.item_count]), [['starters', 1], ['mains', 0]]);   // tenant b's category is not visible
    assert.deepEqual(list.body.languages, ['en', 'ar']);

    const made = await call('POST', '/api/admin/categories', { token: t, body: { label: { en: 'Desserts', ar: 'حلويات' } } });
    assert.equal(made.status, 201);
    assert.equal(made.body.category.key, 'desserts');
    assert.equal(made.body.category.sort_order, 3);                         // goes to the end
    assert.equal(s.db.rowsOf('bg_categories').find((c) => c.key === 'desserts').tenant_id, 'tenant-a');

    assert.equal((await call('POST', '/api/admin/categories', { token: t, body: { label: { en: 'Desserts' } } })).status, 409);   // same key
    assert.equal((await call('POST', '/api/admin/categories', { token: t, body: { label: { ar: 'x' } } })).status, 400);          // default language missing
    assert.equal((await call('POST', '/api/admin/categories', { token: t, body: { label: { en: 'Z' }, key: 'Bad Key!' } })).status, 400);
    const arabicOnly = await call('POST', '/api/admin/categories', { token: t, body: { label: { en: 'حلويات!' } } });
    assert.match(arabicOnly.body.category.key, /^cat-[0-9a-f]{6}$/);        // no usable latin letters -> generated key

    const id = made.body.category.id;
    const ren = await call('PATCH', `/api/admin/categories/${id}`, { token: t, body: { label: { ar: 'سويت' }, sort_order: 0 } });
    assert.deepEqual(ren.body.category.label, { en: 'Desserts', ar: 'سويت' });  // english kept, arabic replaced
    assert.equal((await call('PATCH', `/api/admin/categories/${id}`, { token: t, body: { key: 'starters' } })).status, 409);
    assert.equal((await call('PATCH', `/api/admin/categories/${id}`, { token: t, body: {} })).status, 400);
    assert.equal((await call('PATCH', '/api/admin/categories/9', { token: t, body: { sort_order: 5 } })).status, 404);   // other restaurant's

    assert.equal((await call('DELETE', '/api/admin/categories/1', { token: t })).status, 409);       // still has Soup
    assert.equal((await call('DELETE', `/api/admin/categories/${id}`, { token: t })).status, 200);
    assert.equal((await call('DELETE', '/api/admin/categories/9', { token: t })).status, 404);
    assert.ok(s.db.rowsOf('bg_categories').some((c) => c.id === 9));
    assert.ok(s.events.length >= 4);                                                                   // storefront cache was refreshed
  });
});

test('items: create validates everything and stays inside the restaurant', async () => {
  const s = setup();
  await run(s.app, async (call) => {
    const t = s.staff, post = (body) => call('POST', '/api/admin/items', { token: t, body });
    const ok = await post({ category_id: 2, name: { en: ' Biryani ', ar: 'برياني', fr: 'ignored' }, description: { en: 'Rice' }, price: '12.50', calories: 640, rating: 4.46, is_offer: true, image_url: 'https://x.test/a.jpg', model_url: 'models/b.glb' });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.body.item.name, { en: 'Biryani', ar: 'برياني' });    // trimmed; unknown language dropped
    assert.equal(ok.body.item.price, 12.5);
    assert.equal(ok.body.item.rating, 4.5);
    assert.equal(ok.body.item.sort_order, 2);
    assert.equal(ok.body.item.is_available, true);
    const row = s.db.rowsOf('bg_menu_items').find((r) => r.id === ok.body.item.id);
    assert.equal(row.tenant_id, 'tenant-a');

    for (const [why, body] of [
      ['no name', { category_id: 2, price: 1 }],
      ['no price', { category_id: 2, name: { en: 'X' } }],
      ['blank price', { category_id: 2, name: { en: 'X' }, price: '' }],
      ['negative price', { category_id: 2, name: { en: 'X' }, price: -1 }],
      ['3 decimals', { category_id: 2, name: { en: 'X' }, price: 1.005 }],
      ['rating 6', { category_id: 2, name: { en: 'X' }, price: 1, rating: 6 }],
      ['calories 1.5', { category_id: 2, name: { en: 'X' }, price: 1, calories: 1.5 }],
      ['javascript url', { category_id: 2, name: { en: 'X' }, price: 1, image_url: 'javascript:alert(1)' }],
      ['model not glb', { category_id: 2, name: { en: 'X' }, price: 1, model_url: 'https://x.test/a.png' }],
      ['string boolean', { category_id: 2, name: { en: 'X' }, price: 1, is_offer: 'yes' }],
      ['long name', { category_id: 2, name: { en: 'x'.repeat(121) }, price: 1 }],
      ['no category', { name: { en: 'X' }, price: 1 }],
      ['other restaurant category', { category_id: 9, name: { en: 'X' }, price: 1 }],
    ]) assert.equal((await post(body)).status, 400, why);
  });
});

test('items: partial update, move category, hide, delete; other restaurants are untouchable', async () => {
  const s = setup();
  await run(s.app, async (call) => {
    const t = s.staff, patch = (id, body) => call('PATCH', `/api/admin/items/${id}`, { token: t, body });
    const hidden = await patch(10, { is_available: false });                       // quick toggle sends only this
    assert.equal(hidden.status, 200);
    assert.equal(hidden.body.item.is_available, false);
    assert.equal(hidden.body.item.price, 5);
    assert.deepEqual(hidden.body.item.name, { en: 'Soup', ar: 'شوربة' });

    const edit = await patch(10, { name: { ar: '' }, price: 6.25, category_id: 2, description: { en: 'Hot' }, image_url: '' });
    assert.deepEqual(edit.body.item.name, { en: 'Soup' });                          // empty string removes the arabic name
    assert.equal(edit.body.item.category_id, 2);
    assert.equal(s.db.rowsOf('bg_menu_items').find((r) => r.id === 10).price, 6.25);
    assert.equal((await patch(10, { name: { en: '' } })).status, 400);              // the default language cannot be removed
    assert.equal((await patch(10, { category_id: 9 })).status, 400);
    assert.equal((await patch(10, {})).status, 400);
    assert.equal((await patch(90, { price: 1 })).status, 404);                      // tenant b's dish
    assert.equal((await patch('abc', { price: 1 })).status, 400);

    assert.equal((await call('DELETE', '/api/admin/items/90', { token: t })).status, 404);
    assert.ok(s.db.rowsOf('bg_menu_items').some((r) => r.id === 90));
    assert.equal((await call('DELETE', '/api/admin/items/10', { token: t })).status, 200);
    assert.equal(s.db.rowsOf('bg_menu_items').some((r) => r.id === 10), false);
    const left = await call('GET', '/api/admin/items', { token: t });
    assert.equal(left.body.items.length, 0);
  });
});

test('list includes hidden dishes; image upload checks the real file type and size', async () => {
  const s = setup();
  s.db.rowsOf('bg_menu_items').push({ id: 11, tenant_id: 'tenant-a', category_id: 1, name: { en: 'Hidden' }, description: {}, price: 1, sort_order: 2, is_available: false });
  await run(s.app, async (call) => {
    const t = s.staff;
    assert.deepEqual((await call('GET', '/api/admin/items', { token: t })).body.items.map((i) => i.id), [10, 11]);

    const up = await call('POST', '/api/admin/items/image', { token: t, image: PNG });
    assert.equal(up.status, 201);
    assert.match(up.body.url, /^https:\/\/files\.test\/menu\/tenant-a\/items\/\d+-[0-9a-f]{8}\.png$/);
    assert.equal(s.stored.size, 1);

    assert.equal((await call('POST', '/api/admin/items/image', { token: t, image: Buffer.from('<script>alert(1)</script> not an image') })).status, 400);
    assert.equal((await call('POST', '/api/admin/items/image', { token: t, image: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) })).status, 413);
    assert.equal((await call('POST', '/api/admin/items/image', { token: t })).status, 400);
    assert.equal(s.stored.size, 1);
  });
  const broken = setup({ uploadError: true });
  await run(broken.app, async (call) => assert.equal((await call('POST', '/api/admin/items/image', { token: broken.staff, image: PNG })).status, 502));
});
