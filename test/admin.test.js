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

const box = createSecretBox('unit-test-secret-key-123');
const T = { ...TENANT_A, languages: ['en', 'ar'], settings: { ...TENANT_A.settings, features: {}, orderTypes: ['dine_in', 'pickup', 'delivery'] } };
const TENANTS = { a: T, b: { ...TENANT_B, languages: ['en'] } };

function setup(extraSeed = {}) {
  const db = makeDb({
    bg_profiles: [], bg_categories: [], bg_menu_items: [], bg_tenant_settings: [{ tenant_id: 'tenant-a', brand_name: 'RED HOUSE', features: { ar3d: true } }],
    bg_tenant_integrations: [], bg_tenant_members: [], ...extraSeed,
  });
  const staff = db.addUser('owner@a.test');           // u1
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: staff.id, role: 'admin' });
  const plain = db.addUser('cust@a.test');            // u2
  const crew = db.addUser('crew@a.test');             // u3
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' });
  const events = [];
  const assistant = { reply: async (x) => { events.push(x); return { text: 'bot says hi' }; } };
  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ supabase: db.supabase, auth: createAuth({ supabase: db.supabase }), secretBox: box, assistant, onTenantChanged: (id) => events.push({ changed: id }), onMenuChanged: (id) => events.push({ menu: id }) }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, tokens: { staff: db.token(staff), plain: db.token(plain), crew: db.token(crew) }, events };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, path, { token, body, tenant, file, raw } = {}) => new Promise((resolve, reject) => {
    const headers = {};
    let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    if (file !== undefined) {
      const b = '----t' + Math.random().toString(16).slice(2);
      data = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="m.csv"\r\nContent-Type: text/csv\r\n\r\n${file}\r\n--${b}--\r\n`);
      headers['content-type'] = 'multipart/form-data; boundary=' + b;
    } else if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; }
    if (data) headers['content-length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: s, body: !raw && s && (res.headers['content-type'] || '').includes('json') ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

const CSV = 'category,name,description,price,calories,rating,is_offer,is_available\n' +
  'Snacks,Veg Samosa,Crispy,40,260,4.6,no,yes\nSnacks,Momos,Steamed,99,,,yes,\nMain Course,Butter Naan,,45,,,,\n';

test('admin routes need a signed-in owner/admin of this restaurant', async () => {
  const { app, tokens } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', '/api/admin/settings')).status, 401);
    assert.equal((await call('GET', '/api/admin/settings', { token: tokens.plain })).status, 403);
    assert.equal((await call('GET', '/api/admin/settings', { token: tokens.crew })).status, 403);     // plain staff is not enough
    assert.equal((await call('GET', '/api/admin/settings', { token: tokens.staff })).status, 200);
    assert.equal((await call('GET', '/api/admin/settings', { token: tokens.staff, tenant: 'b' })).status, 403);   // admin of A only
  });
});

test('import: a dry run changes nothing, a real run creates categories and items', async () => {
  const { app, db, tokens, events } = setup();
  await run(app, async (call) => {
    const dry = await call('POST', '/api/admin/menu/import?dry_run=1', { token: tokens.staff, file: CSV });
    assert.equal(dry.status, 200);
    assert.deepEqual([dry.body.dry_run, dry.body.created, dry.body.updated, dry.body.categories_created], [true, 3, 0, 2]);
    assert.equal(db.rowsOf('bg_menu_items').length, 0);

    const real = await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: CSV });
    assert.equal(real.status, 200);
    assert.equal(db.rowsOf('bg_categories').length, 2);
    const items = db.rowsOf('bg_menu_items');
    assert.equal(items.length, 3);
    assert.ok(items.every((i) => i.tenant_id === 'tenant-a'));
    const momos = items.find((i) => i.name.en === 'Momos');
    assert.deepEqual([momos.price, momos.is_offer, momos.is_available], [99, true, true]);
    assert.deepEqual(db.rowsOf('bg_categories').map((c) => c.key).sort(), ['main-course', 'snacks']);
    assert.ok(events.some((e) => e.menu === 'tenant-a'));            // storefront cache is dropped
  });
});

test('import: re-importing updates by name and never touches another restaurant', async () => {
  const { app, db, tokens } = setup({
    bg_categories: [{ id: 1, tenant_id: 'tenant-a', key: 'snacks', label: { en: 'Snacks' }, sort_order: 1 }, { id: 2, tenant_id: 'tenant-b', key: 'snacks', label: { en: 'Snacks' }, sort_order: 1 }],
    bg_menu_items: [
      { id: 1, tenant_id: 'tenant-a', category_id: 1, name: { en: 'Veg Samosa', ar: 'سمبوسة' }, description: {}, price: 10 },
      { id: 2, tenant_id: 'tenant-b', category_id: 2, name: { en: 'Veg Samosa' }, description: {}, price: 10 },
    ],
  });
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: 'category,name,price\nSnacks,veg samosa,55.5\n' });
    assert.deepEqual([r.body.created, r.body.updated, r.body.categories_created], [0, 1, 0]);
    assert.equal(db.rowsOf('bg_menu_items').find((i) => i.id === 1).price, 55.5);
    assert.equal(db.rowsOf('bg_menu_items').find((i) => i.id === 1).name.ar, 'سمبوسة');   // other languages are kept
    assert.equal(db.rowsOf('bg_menu_items').find((i) => i.id === 2).price, 10);
  });
});

test('import: any bad row rejects the whole file with line numbers and writes nothing', async () => {
  const { app, db, tokens } = setup();
  const bad = 'category,name,price,image_url,rating\nSnacks,Ok,10,,\nSnacks,Bad price,abc,,\nSnacks,Bad url,5,javascript:alert(1),\nSnacks,Bad rating,5,,9\nSnacks,ok,5,,\n';
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: bad });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.errors.map((e) => e.line), [3, 4, 5, 6]);
    assert.match(r.body.errors[3].message, /more than once/);
    assert.equal(db.rowsOf('bg_menu_items').length, 0);
    assert.equal(db.rowsOf('bg_categories').length, 0);

    assert.match((await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: 'name,price\nA,1\n' })).body.errors[0].message, /category/);
    assert.equal((await call('POST', '/api/admin/menu/import', { token: tokens.staff, body: {} })).status, 400);   // no file
  });
});

test('import: extra-language columns fill the language maps', async () => {
  const { app, db, tokens } = setup();
  await run(app, async (call) => {
    const r = await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: 'category,name,price,name_ar\nSnacks,Tea,3,شاي\n' });
    assert.equal(r.status, 200);
    assert.deepEqual(db.rowsOf('bg_menu_items')[0].name, { en: 'Tea', ar: 'شاي' });
  });
});

test('template and export download as CSV; export round-trips', async () => {
  const { app, db, tokens } = setup({
    bg_categories: [{ id: 1, tenant_id: 'tenant-a', key: 'snacks', label: { en: 'Snacks' }, sort_order: 1 }],
    bg_menu_items: [{ id: 1, tenant_id: 'tenant-a', category_id: 1, name: { en: 'Veg, Samosa' }, description: { en: 'a "good" one' }, price: '40.00', is_offer: true, is_available: true, sort_order: 1, calories: 260, rating: 4.6 }],
  });
  await run(app, async (call) => {
    const t = await call('GET', '/api/admin/menu/template.csv', { token: tokens.staff, raw: true });
    assert.match(t.headers['content-type'], /text\/csv/);
    assert.match(t.text, /category,name,description,price.*name_ar,description_ar/);
    const ex = await call('GET', '/api/admin/menu/export.csv', { token: tokens.staff, raw: true });
    assert.match(ex.text, /"Veg, Samosa","a ""good"" one",40.00/);
    const again = await call('POST', '/api/admin/menu/import', { token: tokens.staff, file: ex.text.replace(/^\uFEFF/, '') });
    assert.deepEqual([again.body.created, again.body.updated], [0, 1]);
    assert.equal(db.rowsOf('bg_menu_items').length, 1);
  });
});

test('settings: validates input and keeps unlisted feature flags', async () => {
  const { app, db, tokens, events } = setup();
  await run(app, async (call) => {
    const put = (body) => call('PUT', '/api/admin/settings', { token: tokens.staff, body });
    assert.equal((await put({ whatsapp_number: '12' })).status, 400);
    assert.equal((await put({ order_types: ['teleport'] })).status, 400);
    assert.equal((await put({ map_url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await put({ delivery_fee: -1 })).status, 400);
    assert.equal((await put({ brand_name: '  ' })).status, 400);
    assert.equal((await put({})).status, 400);

    const ok = await put({ brand_name: 'New Name', whatsapp_number: '+91 75047-04502', delivery_fee: '2.5', order_types: ['pickup'], features: { whatsappOrder: true, assistant: true, hack: true } });
    assert.equal(ok.status, 200);
    const row = db.rowsOf('bg_tenant_settings')[0];
    assert.deepEqual([row.brand_name, row.whatsapp_number, row.delivery_fee, row.order_types], ['New Name', '917504704502', 2.5, ['pickup']]);
    assert.deepEqual(row.features, { ar3d: true, whatsappOrder: true });          // ar3d kept, assistant/hack ignored
    assert.ok(events.some((e) => e.changed === 'tenant-a'));
  });
});

test('meta settings: token is stored encrypted and only ever returned masked', async () => {
  const { app, db, tokens } = setup();
  await run(app, async (call) => {
    const put = (body) => call('PUT', '/api/admin/integrations/meta', { token: tokens.staff, body });
    assert.equal((await put({ enabled: true })).status, 400);                         // nothing to reply with yet
    assert.equal((await put({ whatsapp_phone_id: 'abc' })).status, 400);
    assert.equal((await put({ access_token: 'short' })).status, 400);

    const r = await put({ enabled: true, whatsapp_phone_id: '1234567890', pixel_id: '99887766', access_token: 'EAAGsecrettokenvalue1234' });
    assert.equal(r.status, 200);
    assert.equal(r.body.meta.access_token, '••••1234');
    assert.ok(!JSON.stringify(r.body).includes('EAAGsecret'));
    const stored = db.rowsOf('bg_tenant_integrations')[0];
    assert.ok(!JSON.stringify(stored).includes('EAAGsecret'));
    assert.equal(box.decrypt(stored.meta_access_token_enc), 'EAAGsecrettokenvalue1234');

    await put({ page_id: '55555' });                                                  // omitting the token keeps it
    assert.equal(box.decrypt(db.rowsOf('bg_tenant_integrations')[0].meta_access_token_enc), 'EAAGsecrettokenvalue1234');
    const cleared = await put({ access_token: null, enabled: false });
    assert.equal(cleared.body.meta.access_token, '');

    db.failNext('bg_tenant_integrations', 'upsert', 'duplicate key value violates unique constraint');
    assert.equal((await put({ whatsapp_phone_id: '777777' })).status, 409);
    assert.equal((await call('GET', '/api/admin/integrations', { token: tokens.staff })).status, 200);
  });
});

test('assistant settings: needs the server AI account, validates input, switch syncs the storefront flag', async () => {
  const { app, db, tokens } = setup();
  const saved = { k: process.env.ALIBABA_API_KEY, w: process.env.ALIBABA_WORKSPACE_ID };
  delete process.env.ALIBABA_API_KEY; delete process.env.ALIBABA_WORKSPACE_ID;
  try {
    await run(app, async (call) => {
      const put = (body) => call('PUT', '/api/admin/integrations/ai', { token: tokens.staff, body });
      assert.equal((await put({ enabled: true })).status, 503);                         // the server has no AI account yet
      assert.equal((await call('GET', '/api/admin/integrations', { token: tokens.staff })).body.ai.available, false);
      assert.equal((await put({ channels: ['sms'] })).status, 400);
      assert.equal((await put({ daily_limit: -3 })).status, 400);

      process.env.ALIBABA_API_KEY = 'sk-server'; process.env.ALIBABA_WORKSPACE_ID = 'ws1';
      const r = await put({ enabled: true, persona: 'We close at 11pm.', channels: ['web', 'whatsapp'], daily_limit: 50, handoff_phone: '+91 75047 04502' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ai.available, true);
      assert.equal(r.body.ai.api_key, undefined);                                       // restaurants never see or set a key
      assert.equal(r.body.ai.model, undefined);
      assert.ok(!JSON.stringify(r.body).includes('sk-server'));
      assert.equal(db.rowsOf('bg_tenant_settings')[0].features.assistant, true);

      await put({ enabled: false });
      assert.equal(db.rowsOf('bg_tenant_settings')[0].features.assistant, false);
    });
  } finally {
    for (const [name, v] of [['ALIBABA_API_KEY', saved.k], ['ALIBABA_WORKSPACE_ID', saved.w]]) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  }
});

test('assistant test endpoint reports disabled and works when on', async () => {
  const { app, tokens } = setup();
  await run(app, async (call) => {
    const t = (message) => call('POST', '/api/admin/integrations/ai/test', { token: tokens.staff, body: { message } });
    assert.equal((await t('')).status, 400);
    assert.equal((await t('hello')).body.reply, 'bot says hi');
  });
});

test('settings: the restaurant admin can set, change and clear the logo link', async () => {
  const { app, tokens, db, events } = setup();
  await run(app, async (call) => {
    const put = (body) => call('PUT', '/api/admin/settings', { token: tokens.staff, body });
    assert.equal((await call('GET', '/api/admin/settings', { token: tokens.staff })).body.logo_url, '');

    let r = await put({ logo_url: ' https://cdn.example.com/logo.png ' });
    assert.equal(r.status, 200); assert.equal(r.body.logo_url, 'https://cdn.example.com/logo.png');
    assert.equal(db.rowsOf('bg_tenant_settings')[0].logo_url, 'https://cdn.example.com/logo.png');
    assert.ok(events.some((e) => e.changed === 'tenant-a'));                                    // storefront cache is cleared

    r = await put({ logo_url: 'img/logo.png' });                                                // a file shipped with the site
    assert.equal(r.body.logo_url, 'img/logo.png');

    for (const bad of ['javascript:alert(1)', 'http://insecure.example/a.png', '//evil.example/a.png', '../secret.png', 'https://x/"onerror="y', 42, {}]) {
      assert.equal((await put({ logo_url: bad })).status, 400, String(bad));
    }
    assert.equal(db.rowsOf('bg_tenant_settings')[0].logo_url, 'img/logo.png');                  // bad input changed nothing

    r = await put({ logo_url: '' });                                                            // clear: the site shows the name as text
    assert.equal(r.body.logo_url, ''); assert.equal(db.rowsOf('bg_tenant_settings')[0].logo_url, null);
    r = await put({ logo_url: null });
    assert.equal(r.status, 200);

    // other fields still save without touching the logo
    await put({ logo_url: 'img/logo.png' });
    await put({ brand_name: 'New Name' });
    assert.equal(db.rowsOf('bg_tenant_settings')[0].logo_url, 'img/logo.png');
  });
});
