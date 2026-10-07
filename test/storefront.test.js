'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// server.js loads src/db.js, which insists on credentials. These never reach a network: the client is replaced below.
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.DEFAULT_TENANT = 'redhouse';
process.env.TRUST_PROXY_HOPS = '0';

const { createStorefront, shapeMenu, buildVideos, pick, jsonForScript, modelSrc, chooseTopPick } = require('../src/render');

const tenantRow = (slug, over = {}) => ({
  id: 'id-' + slug, slug, name: slug, status: 'active', timezone: 'Asia/Kolkata', currency: 'INR',
  currency_symbol: '₹', default_lang: 'en', languages: ['en', 'ar'], order_prefix: 'RH',
  settings: { brand_name: slug.toUpperCase(), page_title: slug + ' title', card_bg_url: 'img/wood.png', features: {} },
  ...over,
});

const DATA = {
  bg_tenants: [tenantRow('redhouse'), tenantRow('wokstar', { id: 'id-wokstar' })],
  bg_categories: [
    { id: 1, tenant_id: 'id-redhouse', key: 'beef', label: { en: 'Beef', ar: 'لحم' }, sort_order: 1 },
    { id: 2, tenant_id: 'id-redhouse', key: 'rice', label: { en: 'Rice' }, sort_order: 2 },
    { id: 9, tenant_id: 'id-wokstar', key: 'noodles', label: { en: 'Noodles' }, sort_order: 1 },
  ],
  bg_menu_items: [
    { id: 10, tenant_id: 'id-redhouse', category_id: 1, name: { en: 'Pepper <b>Beef</b>', ar: 'بيف' }, description: { en: 'Hot' }, price: '12.5', rating: 4.8, popularity: 5, is_offer: true, is_available: true, image_url: 'https://cdn/x.jpg', bg_image_url: null, food_png_url: 'https://cdn/x.png', model_url: null, calories: 400, sort_order: 1 },
    { id: 11, tenant_id: 'id-redhouse', category_id: 2, name: { en: 'Egg Rice' }, description: {}, price: 8, rating: 4.1, popularity: 1, is_offer: false, is_available: true, image_url: null, bg_image_url: null, food_png_url: null, model_url: null, calories: null, sort_order: 2 },
    { id: 12, tenant_id: 'id-redhouse', category_id: 2, name: { en: 'Sold Out' }, description: {}, price: 1, rating: 5, is_available: false, sort_order: 3 },
    { id: 20, tenant_id: 'id-wokstar', category_id: 9, name: { en: 'Chow Mein' }, description: {}, price: 9, rating: 4.5, is_available: true, sort_order: 1 },
  ],
  bg_tenant_media: [
    { tenant_id: 'id-redhouse', slot: 'hero', video_url: 'https://cdn/hero.mp4', poster_url: 'https://cdn/hero.jpg', version: 7 },
    { tenant_id: 'id-redhouse', slot: 'pop1', video_url: null, poster_url: 'https://cdn/p1.jpg', version: 2 },
  ],
  bg_tenant_domains: [{ domain: 'wok.example.com', tenant_id: 'id-wokstar' }],
};

// Stand-in for the supabase-js query builder: filters by eq(), honours is_available, counts queries per table.
function fakeDb(data = DATA) {
  const calls = {};
  const from = (table) => {
    calls[table] = (calls[table] || 0) + 1;
    const filters = {};
    const b = {
      select() { return b; },
      order() { return b; },
      eq(col, val) { filters[col] = val; return b; },
      async maybeSingle() {
        if (table === 'bg_tenants') return { data: data.bg_tenants.find((t) => t.slug === filters.slug) || null, error: null };
        if (table === 'bg_tenant_domains') {
          const d = data.bg_tenant_domains.find((x) => x.domain === filters.domain);
          const t = d && data.bg_tenants.find((x) => x.id === d.tenant_id);
          return { data: t ? { tenant: t } : null, error: null };
        }
        return { data: null, error: null };
      },
      then(resolve, reject) {
        const rows = (data[table] || []).filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
        return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { from, calls };
}

const tenantObj = (over = {}) => ({
  id: 'id-redhouse', slug: 'redhouse', defaultLang: 'en', languages: ['en', 'ar'], currencySymbol: '₹',
  settings: { brandName: 'RED HOUSE', pageTitle: 'Red House', cardBgUrl: 'img/wood.png' }, ...over,
});

test('pick falls back: language, tenant default, en, anything', () => {
  assert.equal(pick({ en: 'A', ar: 'B' }, 'ar', 'en'), 'B');
  assert.equal(pick({ en: 'A' }, 'ar', 'en'), 'A');
  assert.equal(pick({ fr: 'F' }, 'ar', 'de'), 'F');
  assert.equal(pick(null, 'en', 'en'), '');
});

test('shapeMenu uses category keys, drops items without a category, converts numbers', () => {
  const m = shapeMenu({ categories: DATA.bg_categories.slice(0, 2), items: DATA.bg_menu_items.slice(0, 2) }, 'ar', 'en');
  assert.deepEqual(m.categories.map((c) => c.id), ['beef', 'rice']);
  assert.equal(m.categories[0].label, 'لحم');
  assert.equal(m.items[0].cat, 'beef');
  assert.equal(m.items[0].price, 12.5);
  assert.equal(m.items[1].cal, null);
  const orphan = shapeMenu({ categories: [], items: [DATA.bg_menu_items[0]] }, 'en', 'en');
  assert.equal(orphan.items.length, 0);
});

test('buildVideos versions urls and skips empty rows', () => {
  const v = buildVideos([
    { slot: 'hero', video_url: 'https://c/h.mp4', poster_url: 'https://c/h.jpg', version: 7 },
    { slot: 'pop2', video_url: null, poster_url: null, version: 1 },
    { slot: 'pop1', video_url: 'https://c/p.mp4?sig=1', poster_url: null, version: 3 },
  ]);
  assert.equal(v.hero.src, 'https://c/h.mp4?v=7');
  assert.equal(v.pop1.src, 'https://c/p.mp4?sig=1&v=3');
  assert.equal(v.pop2, undefined);
});

test('jsonForScript cannot close a script tag', () => {
  const s = jsonForScript({ a: '</script><script>alert(1)</script>' });
  assert.ok(!s.includes('</script>'));
  assert.deepEqual(JSON.parse(s), { a: '</script><script>alert(1)</script>' });
});

test('renderPage: menu is in the HTML, escaped, with no menu-data.js and no sold-out items', async () => {
  const { from } = fakeDb();
  const sf = createStorefront({ supabase: { from } });
  const html = await sf.renderPage(tenantObj(), 'en', { tenant: 'redhouse' });
  assert.match(html, /<title>Red House<\/title>/);
  assert.match(html, /<span class="brand">RED HOUSE<\/span>/);
  assert.match(html, /Pepper &lt;b&gt;Beef&lt;\/b&gt;/);          // escaped, not injected
  assert.ok(!html.includes('<b>Beef</b>'));
  assert.match(html, /data-c="beef">Beef</);
  assert.match(html, /₹12\.50/);
  assert.match(html, /OFFER/);
  assert.ok(!html.includes('Sold Out'));
  assert.ok(!html.includes('menu-data.js'));
  assert.match(html, /window\.MENU=\{/);
  assert.match(html, /poster="https:\/\/cdn\/p1\.jpg\?v=2"/);     // popular card 1 poster from the tenant's media
});

// ------------------------------------------------------------ homepage: logo, hero cover, top pick --

// The seed restaurant, with 3D models on two dishes.
const withModels = () => ({
  ...DATA,
  bg_menu_items: DATA.bg_menu_items.map((i) => (i.id === 10 ? { ...i, model_url: 'model-1.glb' } : i.id === 11 ? { ...i, model_url: 'https://cdn/egg.glb', rating: 4.9 } : i)),
});
const render = (data, tenant, lang = 'en') => createStorefront({ supabase: { from: fakeDb(data).from } }).renderPage(tenant, lang, {});

test('logo: full-width image when the restaurant has one, its name otherwise', async () => {
  const withLogo = await render(DATA, tenantObj({ settings: { brandName: 'RED "HOUSE"', pageTitle: 'x', logoUrl: 'https://cdn/logo.png', cardBgUrl: null } }));
  assert.match(withLogo, /<header class="logo-banner"><img class="logo" src="https:\/\/cdn\/logo\.png" alt="RED &quot;HOUSE&quot;"/);
  assert.ok(!withLogo.includes('<span class="brand">'));
  const without = await render(DATA, tenantObj());
  assert.match(without, /<header class="logo-banner"><span class="brand">RED HOUSE<\/span><\/header>/);
  assert.ok(!without.includes('class="logo"'));
});

test('hero cover: the first frame is in the HTML and preloaded, from the tenant or the shared default', async () => {
  const mine = await render(DATA, tenantObj());
  assert.match(mine, /<video id="heroVideo"[^>]*poster="https:\/\/cdn\/hero\.jpg\?v=7"/);
  assert.match(mine, /<link rel="preload" as="image" href="https:\/\/cdn\/hero\.jpg\?v=7"/);
  const none = await render({ ...DATA, bg_tenant_media: [] }, tenantObj());
  assert.match(none, /<video id="heroVideo"[^>]*poster="videos\/hero\.jpg"/);
  assert.match(none, /<link rel="preload" as="image" href="videos\/hero\.jpg"/);
});

test('top pick: the best-rated dish that has a 3D model, tied to its model file', async () => {
  const html = await render(withModels(), tenantObj());
  assert.match(html, /<section class="section" id="toppick">/);
  assert.match(html, /<div class="tp" data-id="11" data-model="https:\/\/cdn\/egg\.glb">/);   // 4.9 beats 4.8; a full URL is kept as is
  assert.match(html, /View in 3D/);
  assert.ok(html.indexOf('id="popular"') < html.indexOf('id="toppick"') && html.indexOf('id="toppick"') < html.indexOf('id="menu"'));
});

test('top pick: the restaurant can choose the dish, or switch the section off', async () => {
  const chosen = await render(withModels(), tenantObj({ settings: { brandName: 'R', pageTitle: 'R', features: { topPickItemId: 10 } } }));
  assert.match(chosen, /<div class="tp" data-id="10" data-model="models\/model-1\.glb">/);       // a bare file name is served from /models
  const stale = await render(withModels(), tenantObj({ settings: { brandName: 'R', pageTitle: 'R', features: { topPickItemId: 999 } } }));
  assert.match(stale, /data-id="11"/);                                                         // a dish that is gone falls back to the best one
  const off = await render(withModels(), tenantObj({ settings: { brandName: 'R', pageTitle: 'R', features: { topPick: false } } }));
  assert.ok(!off.includes('id="toppick"'));
});

test('top pick: no 3D models, no section; only available dishes count', async () => {
  assert.ok(!(await render(DATA, tenantObj())).includes('id="toppick"'));
  const soldOut = withModels();
  soldOut.bg_menu_items = soldOut.bg_menu_items.map((i) => (i.id === 12 ? { ...i, model_url: 'ghost.glb' } : i));   // sold out, rating 5
  const html = await render(soldOut, tenantObj());
  assert.ok(!html.includes('ghost.glb'));
});

test('chooseTopPick and modelSrc', () => {
  const menu = { items: [{ id: 1, model: 'a.glb', rating: 4, popularity: 1 }, { id: 2, model: 'b.glb', rating: 4, popularity: 9 }, { id: 3, model: null, rating: 5, popularity: 0 }] };
  assert.equal(chooseTopPick(menu, {}).id, 2);                      // tie on rating -> more popular
  assert.equal(chooseTopPick(menu, { topPickItemId: '1' }).id, 1);  // the id may come from JSON as a string
  assert.equal(chooseTopPick(menu, { topPickItemId: 3 }).id, 2);    // chosen dish has no model -> fall back
  assert.equal(chooseTopPick(menu, { topPick: false }), null);
  assert.equal(chooseTopPick({ items: [] }, {}), null);
  assert.equal(modelSrc('x.glb'), 'models/x.glb');
  assert.equal(modelSrc('https://c/x.glb'), 'https://c/x.glb');
  assert.equal(modelSrc('//c/x.glb'), '//c/x.glb');
  assert.equal(modelSrc('/uploads/x.glb'), '/uploads/x.glb');
});

test('homepage template: Special section with speed slider, sort + search + filter bar, WhatsApp button, no Demo tag', async () => {
  const html = await render(DATA, tenantObj());
  assert.match(html, /<h2>Special<\/h2>/);
  assert.match(html, /<input type="range" id="speed"/);
  assert.match(html, /<select id="sort"/);
  assert.match(html, /<input type="search" id="q"/);
  assert.match(html, /id="waFloat"[^>]*hidden/);                       // hidden until app.js finds a WhatsApp number
  assert.ok(!html.includes('class="tag"'));
  assert.match(html, /<div class="pop-row" id="popRow">/);           // the Special row is the same markup as before
});

test('renderPage: tenants are isolated', async () => {
  const { from } = fakeDb();
  const sf = createStorefront({ supabase: { from } });
  const wok = tenantObj({ id: 'id-wokstar', slug: 'wokstar', settings: { brandName: 'WOK', pageTitle: 'Wok', cardBgUrl: null } });
  const html = await sf.renderPage(wok, 'en', {});
  assert.match(html, /Chow Mein/);
  assert.ok(!html.includes('Pepper'));
  assert.ok(!html.includes('Egg Rice'));
});

test('renderPage: an empty menu renders without error', async () => {
  const { from } = fakeDb({ ...DATA, bg_categories: [], bg_menu_items: [], bg_tenant_media: [] });
  const sf = createStorefront({ supabase: { from } });
  const html = await sf.renderPage(tenantObj(), 'en', {});
  assert.match(html, /<div id="list"><\/div>/);
  assert.match(html, /<div class="pop-row" id="popRow"><\/div>/);
});

test('one database round trip is shared across visitors and languages until invalidated', async () => {
  const { from, calls } = fakeDb();
  let t = 0;
  const sf = createStorefront({ supabase: { from }, now: () => t });
  const tenant = tenantObj();
  await Promise.all([sf.renderPage(tenant, 'en', {}), sf.renderPage(tenant, 'ar', {}), sf.menuFor(tenant, 'en')]);
  await sf.renderPage(tenant, 'en', {});
  assert.equal(calls.bg_menu_items, 1);
  assert.equal(calls.bg_categories, 1);
  assert.equal(calls.bg_tenant_media, 1);

  sf.invalidate(tenant.id);
  await sf.renderPage(tenant, 'en', {});
  assert.equal(calls.bg_menu_items, 2);

  t += 31_000;                                                   // ttl (30 s) passes
  await sf.renderPage(tenant, 'en', {});
  assert.equal(calls.bg_menu_items, 3);
});

test('database errors are thrown and not cached', async () => {
  let fail = true;
  const good = fakeDb();
  const from = (table) => {
    const b = good.from(table);
    const then = b.then;
    b.then = (res, rej) => (fail && table === 'bg_menu_items' ? Promise.resolve({ data: null, error: new Error('db down') }).then(res, rej) : then(res, rej));
    return b;
  };
  const sf = createStorefront({ supabase: { from } });
  await assert.rejects(sf.renderPage(tenantObj(), 'en', {}), /db down/);
  fail = false;
  const html = await sf.renderPage(tenantObj(), 'en', {});
  assert.match(html, /Pepper/);
});

test('a template that lost an anchor fails loudly', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const p = path.join(os.tmpdir(), `bad-index-${process.pid}.html`);
  fs.writeFileSync(p, '<!doctype html><html lang="en"><title>x</title></html>');
  const sf = createStorefront({ supabase: fakeDb(), templatePath: p });
  await assert.rejects(sf.renderPage(tenantObj(), 'en', {}), /missing expected markup/);
  fs.unlinkSync(p);
});

// ------------------------------------------------------------------ the real app, over HTTP --

test('server: renders per host, serves config and menu JSON, rejects unknown hosts', async (t) => {
  const db = require('../src/db');
  const fake = fakeDb();
  db.supabase.from = fake.from;                                  // swap the real client for the fake
  const { app } = require('../server');
  const server = app.listen(0);
  t.after(() => server.close());
  const port = server.address().port;
  // node:http (not fetch) because fetch ignores a custom Host header, and the Host is what picks the tenant.
  const get = (p, host) => new Promise((resolve, reject) => {
    require('node:http').get({ host: '127.0.0.1', port, path: p, headers: host ? { host } : {} }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (k) => res.headers[k.toLowerCase()] },
        text: async () => body,
        json: async () => JSON.parse(body),
      }));
    }).on('error', reject);
  });

  // default tenant (localhost / unmatched host falls back to DEFAULT_TENANT)
  let r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(await r.text(), /Pepper &lt;b&gt;Beef/);

  // a custom domain resolves to a different restaurant
  r = await get('/', 'wok.example.com');
  const wokHtml = await r.text();
  assert.match(wokHtml, /Chow Mein/);
  assert.ok(!wokHtml.includes('Pepper'));

  r = await get('/api/config', 'wok.example.com');
  const cfg = await r.json();
  assert.equal(cfg.tenant, 'wokstar');
  assert.ok(!('id' in cfg) && !('status' in cfg));

  r = await get('/api/menu?lang=ar');
  const menu = await r.json();
  assert.equal(menu.categories[0].label, 'لحم');
  assert.equal(menu.items.length, 2);                            // sold-out item excluded

  r = await get('/api/menu?lang=zz');                            // unsupported language -> default
  assert.equal((await r.json()).categories[0].label, 'Beef');

  r = await get('/api/nope');
  assert.equal(r.status, 404);
  assert.deepEqual(await r.json(), { error: 'Not found' });

  r = await get('/admin');                                       // static shell; the API behind it checks the role
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');

  r = await get('/health');
  assert.equal(r.status, 200);

  // static files are served without touching the database
  const before = JSON.stringify(fake.calls);
  r = await get('/app.css');
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(fake.calls), before);
});