'use strict';
// The real server.js with only the database swapped for the in-memory fake.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
process.env.DEFAULT_TENANT = 'redhouse';
process.env.TRUST_PROXY_HOPS = '0';
process.env.META_APP_SECRET = 'app-secret';
process.env.META_VERIFY_TOKEN = 'verify-me';
process.env.APP_SECRET_KEY = 'unit-test-secret-key-123';

const { makeDb } = require('./helpers/fakeDb');

test('server wires the admin page, Meta webhook, assistant chat, pixel and chat script', async (t) => {
  const db = makeDb({
    bg_tenants: [{
      id: 'id-r', slug: 'redhouse', name: 'Red', status: 'active', timezone: 'UTC', currency: 'INR', currency_symbol: '₹', default_lang: 'en', languages: ['en'], order_prefix: 'RH',
      settings: { brand_name: 'RED', page_title: 'Red', features: { assistant: true } },
      integrations: { meta_pixel_id: '123456789', ai_enabled: true, ai_greeting: 'Welcome in', ai_channels: ['web'] },
    }],
    bg_categories: [], bg_menu_items: [], bg_tenant_media: [], bg_tenant_integrations: [], bg_chat_sessions: [], bg_ai_usage: [],
  });
  require('../src/db').supabase.from = db.supabase.from;
  require('../src/db').supabase.auth.getUser = db.supabase.auth.getUser;
  const { app } = require('../server');
  const server = app.listen(0); t.after(() => server.close());
  const port = server.address().port;
  const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s, headers: res.headers }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  const page = await call('GET', '/');
  assert.equal(page.status, 200);
  assert.match(page.text, /fbq\('init','123456789'\)/);
  assert.match(page.text, /<script src="assistant.js" defer><\/script>/);
  assert.match(page.text, /"assistant":true/);
  assert.match(page.text, /Welcome in/);

  const hs = await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=777');
  assert.deepEqual([hs.status, hs.text], [200, '777']);
  const body = JSON.stringify({ object: 'page', entry: [] });
  assert.equal((await call('POST', '/webhooks/meta', { body })).status, 401);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(body).digest('hex');
  assert.equal((await call('POST', '/webhooks/meta', { body, headers: { 'x-hub-signature-256': sig } })).status, 200);

  assert.equal((await call('GET', '/api/admin/settings')).status, 401);
  assert.equal((await call('POST', '/api/admin/menu/import')).status, 401);
  const chat = await call('POST', '/api/assistant/chat', { body: JSON.stringify({ message: 'hi', session_id: 'short' }) });
  assert.equal(chat.status, 400);
  assert.equal((await call('GET', '/admin')).status, 200);
});
