'use strict';
// The real server: /platform and /api/platform work on any host (no restaurant needed) and only with PLATFORM_ADMIN_KEY.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.DEFAULT_TENANT = '';                    // nothing resolves to a restaurant, so these routes must not need one
process.env.TRUST_PROXY_HOPS = '0';
process.env.PLATFORM_ADMIN_KEY = 'a-long-platform-secret';
process.env.BASE_DOMAIN = 'bitegrow.app';

const { makeDb } = require('./helpers/fakeDb');

test('server: platform page and API are mounted ahead of tenant resolution and guarded by the env key', async (t) => {
  const db = makeDb({ bg_tenants: [], bg_tenant_settings: [], bg_tenant_domains: [], bg_tenant_members: [] });
  db.hooks.bg_tenants = (row) => { row.id = db.uuid(); row.languages = row.languages || ['en']; row.default_lang = row.default_lang || 'en'; };
  const { supabase } = require('../src/db');
  supabase.from = db.supabase.from;
  supabase.auth.getUser = db.supabase.auth.getUser;
  supabase.auth.admin = db.supabase.auth.admin;
  const { app } = require('../server');
  const server = app.listen(0); t.after(() => server.close());
  const port = server.address().port;
  const call = (method, p, { body, key } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = { host: 'some-random-host.test' };
    if (key) headers.authorization = 'Bearer ' + key;
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: s, headers: res.headers, json: () => JSON.parse(s) }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  // the page itself is a static shell: never cached, no key needed to load it
  const page = await call('GET', '/platform');
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'], /no-store/);
  assert.match(page.text, /Platform admin/);
  assert.equal((await call('GET', '/platform.html')).status, 200);

  // the API is not reachable without the key, and ordinary restaurant routes still need a restaurant
  assert.equal((await call('GET', '/api/platform/tenants')).status, 401);
  assert.equal((await call('GET', '/api/platform/tenants', { key: 'guess-guess-guess' })).status, 401);
  assert.equal((await call('GET', '/api/config')).status, 404);

  const key = process.env.PLATFORM_ADMIN_KEY;
  assert.equal((await call('GET', '/api/platform/session', { key })).status, 200);
  const created = await call('POST', '/api/platform/tenants', { key, body: { slug: 'wok-star', name: 'Wok Star', logo_url: 'img/logo.png' } });
  assert.equal(created.status, 201);
  assert.equal(created.json().tenant.url, 'https://wok-star.bitegrow.app');
  const list = await call('GET', '/api/platform/tenants', { key });
  assert.equal(list.json().tenants[0].logo_url, 'img/logo.png');

  // malformed JSON is the caller's mistake: 4xx, not a server error
  const badJson = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/platform/tenants', method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{oops');
  });
  assert.equal(badJson, 400);
});
