'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { createMetaRouter, extractMessages, validSignature } = require('../src/routes/meta');
const { createSecretBox } = require('../src/lib/secrets');

process.env.META_APP_SECRET = 'app-secret';
process.env.META_VERIFY_TOKEN = 'verify-me';
const box = createSecretBox('unit-test-secret-key-123');

const tenantRow = (id, over = {}) => ({
  id, slug: id, name: id, status: 'active', timezone: 'UTC', currency: 'INR', currency_symbol: '₹', default_lang: 'en', languages: ['en'],
  order_prefix: 'RH', settings: { brand_name: id, features: { assistant: true } }, ...over,
});
const integ = (tenant_id, over = {}) => ({
  tenant_id, meta_enabled: true, meta_whatsapp_phone_id: 'WA100', meta_page_id: 'PG200', meta_instagram_id: 'IG300',
  meta_access_token_enc: box.encrypt('TOKEN-' + tenant_id), ...over,
});

function setup({ tenants = [tenantRow('t1')], integrations = [integ('t1')], replyFn } = {}) {
  const db = makeDb({ bg_tenants: tenants, bg_tenant_integrations: integrations, bg_webhook_events: [] });
  const sent = []; const asked = [];
  const assistant = { reply: replyFn || (async (x) => { asked.push(x); return { text: 'Answer: ' + x.text }; }) };
  const fetchImpl = async (url, opts) => { sent.push({ url, auth: opts.headers.authorization, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  const quiet = { error() {} };
  const router = createMetaRouter({ supabase: db.supabase, assistant, secretBox: box, fetchImpl, log: quiet });
  return { db, sent, asked, router };
}

const wa = (text, over = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ value: { metadata: { phone_number_id: 'WA100' }, contacts: [{ wa_id: '9190', profile: { name: 'Asha' } }],
    messages: [{ from: '9190', id: 'wamid.1', type: 'text', text: { body: text } }] } }] }], ...over,
});
const sign = (raw) => 'sha256=' + crypto.createHmac('sha256', 'app-secret').update(raw).digest('hex');

test('signature check accepts only the exact signed bytes', () => {
  const raw = Buffer.from('{"a":1}');
  assert.equal(validSignature(raw, sign(raw), 'app-secret'), true);
  assert.equal(validSignature(Buffer.from('{"a":2}'), sign(raw), 'app-secret'), false);
  assert.equal(validSignature(raw, 'sha256=00', 'app-secret'), false);
  assert.equal(validSignature(raw, undefined, 'app-secret'), false);
  assert.equal(validSignature(raw, sign(raw), ''), false);
});

test('extractMessages reads WhatsApp, Messenger and Instagram and drops echoes', () => {
  assert.deepEqual(extractMessages(wa('hi')).map((m) => [m.channel, m.accountId, m.contactId, m.text, m.name]), [['whatsapp', 'WA100', '9190', 'hi', 'Asha']]);
  const msgr = { object: 'page', entry: [{ id: 'PG200', messaging: [
    { sender: { id: 'u1' }, message: { mid: 'm1', text: 'menu?' } },
    { sender: { id: 'PG200' }, message: { mid: 'm2', text: 'echo', is_echo: true } },
    { sender: { id: 'u1' }, delivery: { mids: ['x'] } },
    { sender: { id: 'u2' }, message: { mid: 'm3', attachments: [{}] } }] }] };
  assert.deepEqual(extractMessages(msgr).map((m) => [m.messageId, m.text]), [['m1', 'menu?'], ['m3', null]]);
  assert.equal(extractMessages({ object: 'instagram', entry: [{ id: 'IG300', messaging: [{ sender: { id: 'u9' }, message: { mid: 'i1', text: 'hey' } }] }] })[0].channel, 'instagram');
  assert.deepEqual(extractMessages(null), []);
  assert.deepEqual(extractMessages({ object: 'weird', entry: [{}] }), []);
});

test('a WhatsApp message gets an assistant answer sent with that restaurant\'s own token', async () => {
  const { router, sent, asked } = setup();
  await router.processPayload(wa('What is vegetarian?'));
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].tenant.id, asked[0].channel, asked[0].contactId], ['t1', 'whatsapp', '9190']);
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /graph\.facebook\.com\/v[\d.]+\/WA100\/messages$/);
  assert.equal(sent[0].auth, 'Bearer TOKEN-t1');
  assert.deepEqual(sent[0].body, { messaging_product: 'whatsapp', to: '9190', type: 'text', text: { body: 'Answer: What is vegetarian?' } });
});

test('Meta redelivery is answered once', async () => {
  const { router, sent } = setup();
  await router.processPayload(wa('hi')); await router.processPayload(wa('hi'));
  assert.equal(sent.length, 1);
});

test('messages for unknown, disabled or suspended accounts are ignored', async () => {
  const unknown = setup();
  const nope = wa('hi'); nope.entry[0].changes[0].value.metadata.phone_number_id = 'NOPE';
  await unknown.router.processPayload(nope);
  assert.equal(unknown.sent.length, 0);
  const off = setup({ integrations: [integ('t1', { meta_enabled: false })] }); await off.router.processPayload(wa('hi'));
  assert.equal(off.sent.length, 0);
  const susp = setup({ tenants: [tenantRow('t1', { status: 'suspended' })] }); await susp.router.processPayload(wa('hi'));
  assert.equal(susp.sent.length, 0);
});

test('two restaurants never see each other\'s messages or tokens', async () => {
  const { router, sent, asked } = setup({
    tenants: [tenantRow('t1'), tenantRow('t2')],
    integrations: [integ('t1'), integ('t2', { meta_whatsapp_phone_id: 'WA999', meta_page_id: 'PG999', meta_instagram_id: 'IG999' })],
  });
  const body = wa('order please'); body.entry[0].changes[0].value.metadata.phone_number_id = 'WA999';
  await router.processPayload(body);
  assert.equal(asked[0].tenant.id, 't2');
  assert.equal(sent[0].auth, 'Bearer TOKEN-t2');
  assert.match(sent[0].url, /\/WA999\/messages/);
});

test('Messenger and Instagram replies use the page endpoint and recipient id', async () => {
  const { router, sent } = setup();
  await router.processPayload({ object: 'page', entry: [{ id: 'PG200', messaging: [{ sender: { id: 'u1' }, message: { mid: 'm1', text: 'hi' } }] }] });
  await router.processPayload({ object: 'instagram', entry: [{ id: 'IG300', messaging: [{ sender: { id: 'u2' }, message: { mid: 'm2', text: 'hello' } }] }] });
  assert.match(sent[0].url, /\/PG200\/messages$/);
  assert.deepEqual(sent[0].body, { recipient: { id: 'u1' }, messaging_type: 'RESPONSE', message: { text: 'Answer: hi' } });
  assert.match(sent[1].url, /\/PG200\/messages$/);                      // Instagram replies go through the linked Page
  assert.equal(sent[1].body.recipient.id, 'u2');
});

test('non-text messages get a polite hint; disabled bot stays silent; limit gives a fallback', async () => {
  const a = setup(); const img = wa(''); img.entry[0].changes[0].value.messages[0] = { from: '9190', id: 'wamid.img', type: 'image' };
  await a.router.processPayload(img);
  assert.match(a.sent[0].body.text.body, /text messages only/);
  assert.equal(a.asked.length, 0);

  const off = setup({ replyFn: async () => ({ disabled: true }) }); await off.router.processPayload(wa('hi'));
  assert.equal(off.sent.length, 0);
  const lim = setup({ replyFn: async () => ({ limited: true }) }); await lim.router.processPayload(wa('hi'));
  assert.match(lim.sent[0].body.text.body, /very busy/);
});

test('one failing message does not stop the others', async () => {
  let n = 0;
  const { router, sent } = setup({ replyFn: async (x) => { if (++n === 1) throw new Error('model down'); return { text: 'ok ' + x.text }; } });
  const body = wa('one'); body.entry[0].changes[0].value.messages.push({ from: '9191', id: 'wamid.2', type: 'text', text: { body: 'two' } });
  await router.processPayload(body);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.text.body, 'ok two');
});

// ---- HTTP: verification handshake and signature enforcement
async function withApp(router, fn) {
  const app = express(); app.use('/webhooks/meta', router);
  const server = app.listen(0); const port = server.address().port;
  const call = (method, path, { body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(body);
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers } }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, text: s }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

test('GET handshake echoes the challenge only for the right verify token', async () => {
  await withApp(setup().router, async (call) => {
    const ok = await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
    assert.deepEqual([ok.status, ok.text], [200, '12345']);
    assert.equal((await call('GET', '/webhooks/meta?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1')).status, 403);
    assert.equal((await call('GET', '/webhooks/meta')).status, 403);
  });
});

test('POST needs a valid signature over the raw body', async () => {
  const { router, sent } = setup();
  await withApp(router, async (call) => {
    const body = JSON.stringify(wa('signed hello'));
    assert.equal((await call('POST', '/webhooks/meta', { body })).status, 401);
    assert.equal((await call('POST', '/webhooks/meta', { body, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } })).status, 401);
    assert.equal((await call('POST', '/webhooks/meta', { body: 'not json', headers: { 'x-hub-signature-256': sign(Buffer.from('not json')) } })).status, 400);
    assert.equal(sent.length, 0);
    assert.equal((await call('POST', '/webhooks/meta', { body, headers: { 'x-hub-signature-256': sign(Buffer.from(body)) } })).status, 200);
    await new Promise((r) => setTimeout(r, 50));                       // the reply is sent after the 200
    assert.equal(sent.length, 1);
  });
});
