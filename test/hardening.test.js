'use strict';
// Small fixes: strict image links, 4xx answers for unreadable request bodies, /index.html, and the storefront's checkout.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.DEFAULT_TENANT = 'redhouse';
process.env.TRUST_PROXY_HOPS = '0';

const { makeDb } = require('./helpers/fakeDb');
const { okUrl } = require('../src/lib/menuImport');

test('okUrl accepts https links and site paths only', () => {
  for (const good of ['https://cdn.example.com/a.png', 'https://cdn.example.com/a.png?v=2', 'img/photo.png', '/img/photo.png', 'models/model-3.glb']) {
    assert.equal(okUrl(good), true, good);
  }
  for (const bad of [
    'https://x/"onerror="alert(1)', "https://x/'onerror='alert(1)", 'https://x/<script>', 'https://x/a`b', 'https://x/a\\b',
    'http://insecure.example/a.png', '//evil.example/p.png', '../../secret.png', 'img/../../secret.png', 'javascript:alert(1)', 'data:text/html,hi',
    'https://user:pass@x.example/a.png', 'https://', '', ' ', 'img/a b.png', `https://x/${'a'.repeat(600)}`, null, undefined, 42,
  ]) {
    assert.equal(okUrl(bad), false, String(bad));
  }
});

test('server answers 4xx for unreadable bodies, redirects /index.html, and the storefront posts orders to the API', async (t) => {
  const db = makeDb({
    bg_tenants: [{
      id: 'id-r', slug: 'redhouse', name: 'Red', status: 'active', timezone: 'UTC', currency: 'INR', currency_symbol: '₹', default_lang: 'en', languages: ['en'], order_prefix: 'RH',
      settings: { brand_name: 'RED', page_title: 'Red', features: {} },
    }],
    bg_categories: [], bg_menu_items: [], bg_tenant_media: [], bg_tenant_integrations: [],
  });
  require('../src/db').supabase.from = db.supabase.from;
  require('../src/db').supabase.auth.getUser = db.supabase.auth.getUser;
  const { app } = require('../server');
  const server = app.listen(0); t.after(() => server.close());
  const port = server.address().port;
  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {} }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s, headers: res.headers }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  const bad = await call('POST', '/api/auth/login', '{bad json');
  assert.equal(bad.status, 400);
  assert.match(bad.text, /could not be read/);

  const big = await call('POST', '/api/auth/login', JSON.stringify({ email: 'a'.repeat(120000) }));
  assert.equal(big.status, 413);

  const idx = await call('GET', '/index.html');
  assert.equal(idx.status, 301);
  assert.equal(idx.headers.location, '/');

  // Real faults still answer 500.
  assert.equal((await call('GET', '/health')).status, 200);

  // The storefront script: checkout saves the order on the server, and dish image links are escaped before use in markup.
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(js, /api\('\/api\/orders', \{ method: 'POST'/);
  assert.doesNotMatch(js, /(src|poster)="\$\{img\(i\)\}"/);
});
