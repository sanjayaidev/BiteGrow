'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { TENANT_A, TENANT_B } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createOrdersAdminRouter } = require('../src/routes/ordersAdmin');

const TENANTS = { a: TENANT_A, b: TENANT_B };
const order = (o) => ({
  tenant_id: 'tenant-a', order_type: 'pickup', customer_name: 'Asha', customer_phone: '9999999999', status: 'pending', payment_status: 'unpaid',
  channel: 'web', subtotal: '100.00', delivery_fee: '0.00', total: '100.00', currency: 'INR', created_at: '2026-10-09T10:00:00Z', ...o,
});

function setup() {
  const db = makeDb({
    bg_profiles: [],
    bg_tenant_members: [],
    bg_orders: [
      order({ id: 1, order_number: 'RH-261009-0001', created_at: '2026-10-09T10:00:00Z' }),
      order({ id: 2, order_number: 'RH-261009-0002', status: 'ready', payment_status: 'paid', created_at: '2026-10-09T11:00:00Z' }),
      order({ id: 3, order_number: 'RH-261009-0003', status: 'completed', created_at: '2026-10-09T09:00:00Z' }),
      order({ id: 4, order_number: 'RH-261009-0004', status: 'cancelled', created_at: '2026-10-09T08:00:00Z' }),
      order({ id: 5, tenant_id: 'tenant-b', order_number: 'WS-261009-0001' }),
    ],
    bg_order_items: [
      { tenant_id: 'tenant-a', order_id: 1, name_snapshot: 'Veg Samosa', quantity: 2, line_total: '80.00' },
      { tenant_id: 'tenant-a', order_id: 1, name_snapshot: 'Momos', quantity: 1, line_total: '20.00' },
      { tenant_id: 'tenant-b', order_id: 5, name_snapshot: 'Noodles', quantity: 1, line_total: '50.00' },
    ],
  });
  const owner = db.addUser('owner@a.test');
  const crew = db.addUser('crew@a.test');
  const stranger = db.addUser('cust@a.test');
  const other = db.addUser('owner@b.test');
  db.rowsOf('bg_tenant_members').push(
    { tenant_id: 'tenant-a', user_id: owner.id, role: 'owner' },
    { tenant_id: 'tenant-a', user_id: crew.id, role: 'staff' },
    { tenant_id: 'tenant-b', user_id: other.id, role: 'owner' },
  );
  const changes = [];
  const app = express();
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use(express.json());
  app.use('/api/admin/orders', createOrdersAdminRouter({ supabase: db.supabase, auth: createAuth({ supabase: db.supabase }), onOrderChanged: (id, o) => changes.push([id, o.id, o.status, o.payment_status]) }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, changes, tok: { owner: db.token(owner), crew: db.token(crew), stranger: db.token(stranger), other: db.token(other) } };
}

async function run(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const call = (method, p, { token, body, tenant } = {}) => new Promise((resolve, reject) => {
    const headers = {}; let data = null;
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    if (body !== undefined) { data = Buffer.from(JSON.stringify(body)); headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

test('only signed-in staff of this restaurant can use the order desk', async () => {
  const { app, tok } = setup();
  await run(app, async (call) => {
    assert.equal((await call('GET', '/api/admin/orders')).status, 401);
    assert.equal((await call('GET', '/api/admin/orders', { token: tok.stranger })).status, 403);
    assert.equal((await call('GET', '/api/admin/orders', { token: tok.other })).status, 403, 'staff of restaurant B have no access to A');
    assert.equal((await call('GET', '/api/admin/orders', { token: tok.crew })).status, 200, 'kitchen staff are allowed');
    assert.equal((await call('PATCH', '/api/admin/orders/1', { token: tok.stranger, body: { status: 'confirmed' } })).status, 403);
  });
});

test('lists this restaurant\'s orders newest first with their items, by filter', async () => {
  const { app, tok } = setup();
  await run(app, async (call) => {
    const active = await call('GET', '/api/admin/orders', { token: tok.owner });
    assert.deepEqual(active.body.orders.map((o) => o.order_number), ['RH-261009-0002', 'RH-261009-0001']);
    const first = active.body.orders.find((o) => o.id === 1);
    assert.deepEqual(first.items, [{ name: 'Veg Samosa', quantity: 2, line_total: 80 }, { name: 'Momos', quantity: 1, line_total: 20 }]);
    assert.deepEqual(first.next_statuses, ['confirmed', 'cancelled']);
    assert.equal(first.total, 100);
    assert.equal('order_token' in first, false, 'the guest lookup secret never goes to the desk list');

    const done = await call('GET', '/api/admin/orders?status=done', { token: tok.owner });
    assert.deepEqual(done.body.orders.map((o) => o.id), [3, 4]);
    assert.equal((await call('GET', '/api/admin/orders?status=all', { token: tok.owner })).body.orders.length, 4, 'restaurant B\'s order is never listed');
    assert.equal((await call('GET', '/api/admin/orders?status=ready', { token: tok.owner })).body.orders.length, 1);
    assert.equal((await call('GET', '/api/admin/orders?status=bogus', { token: tok.owner })).status, 400);
    assert.equal((await call('GET', '/api/admin/orders', { token: tok.other, tenant: 'b' })).body.orders.map((o) => o.id)[0], 5);
  });
});

test('orders move forward one step at a time and finished ones stay finished', async () => {
  const { app, tok, db, changes } = setup();
  await run(app, async (call) => {
    const patch = (id, body, token = tok.crew) => call('PATCH', '/api/admin/orders/' + id, { token, body });

    const ok = await patch(1, { status: 'confirmed' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.order.status, 'confirmed');
    assert.deepEqual(ok.body.order.next_statuses, ['preparing', 'cancelled']);
    assert.equal(db.rowsOf('bg_orders').find((o) => o.id === 1).status, 'confirmed');
    assert.deepEqual(changes, [['tenant-a', 1, 'confirmed', 'unpaid']]);

    assert.equal((await patch(1, { status: 'ready' })).status, 409, 'cannot skip preparing');
    assert.equal((await patch(1, { status: 'pending' })).status, 409, 'cannot go backwards');
    assert.equal((await patch(3, { status: 'preparing' })).status, 409, 'completed stays completed');
    assert.equal((await patch(4, { status: 'confirmed' })).status, 409, 'cancelled stays cancelled');
    assert.equal((await patch(1, { status: 'cancelled' })).status, 200);
    assert.equal(changes.length, 2);

    assert.equal((await patch(1, { status: 'confirmed' }, tok.owner)).status, 409);
    assert.equal((await patch(2, { status: 'ready' })).status, 200, 'setting the status it already has changes nothing');
    assert.equal(changes.length, 2, 'and does not announce a change');
  });
});

test('payment goes unpaid -> paid -> refunded, and a cancelled order cannot be paid', async () => {
  const { app, tok } = setup();
  await run(app, async (call) => {
    const patch = (id, body) => call('PATCH', '/api/admin/orders/' + id, { token: tok.owner, body });
    assert.equal((await patch(1, { payment_status: 'refunded' })).status, 409, 'unpaid cannot be refunded');
    assert.equal((await patch(1, { payment_status: 'paid' })).body.order.payment_status, 'paid');
    assert.equal((await patch(1, { payment_status: 'unpaid' })).status, 409);
    assert.equal((await patch(1, { payment_status: 'refunded' })).body.order.payment_status, 'refunded');
    assert.equal((await patch(1, { payment_status: 'paid' })).status, 409, 'refunded is final');

    assert.equal((await patch(4, { payment_status: 'paid' })).status, 409, 'cancelled order cannot be marked paid');
    const both = await patch(2, { status: 'completed', payment_status: 'refunded' });
    assert.deepEqual([both.status, both.body.order.status, both.body.order.payment_status], [200, 'completed', 'refunded']);
    assert.equal((await patch(3, { status: 'cancelled', payment_status: 'paid' })).status, 409, 'completed order cannot be cancelled, even with a payment change attached');
  });
});

test('bad input and other restaurants\' orders are refused', async () => {
  const { app, tok, db } = setup();
  await run(app, async (call) => {
    const patch = (id, body, token = tok.owner, tenant) => call('PATCH', '/api/admin/orders/' + id, { token, body, tenant });
    assert.equal((await patch('abc', { status: 'confirmed' })).status, 400);
    assert.equal((await patch(1, {})).status, 400);
    assert.equal((await patch(1, { status: 'shipped' })).status, 400);
    assert.equal((await patch(1, { payment_status: 'maybe' })).status, 400);
    assert.equal((await patch(999, { status: 'confirmed' })).status, 404);
    assert.equal((await patch(5, { status: 'confirmed' })).status, 404, 'order 5 belongs to restaurant B');
    assert.equal(db.rowsOf('bg_orders').find((o) => o.id === 5).status, 'pending');
    assert.equal((await patch(5, { status: 'confirmed' }, tok.other, 'b')).status, 200, 'its own staff can');
  });
});

test('a change made by someone else in the meantime is not overwritten', async () => {
  const { app, tok, db } = setup();
  // Simulate the race: the row changes after the desk read it but before its update lands.
  const realFrom = db.supabase.from;
  let raced = false;
  db.supabase.from = (table) => {
    const b = realFrom(table);
    if (table === 'bg_orders') {
      const upd = b.update.bind(b);
      b.update = (p) => { if (!raced) { raced = true; db.rowsOf('bg_orders').find((o) => o.id === 1).status = 'confirmed'; } return upd(p); };
    }
    return b;
  };
  await run(app, async (call) => {
    const r = await call('PATCH', '/api/admin/orders/1', { token: tok.owner, body: { status: 'confirmed' } });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /just changed/);
  });
});

test('the order desk is wired into the server and the admin page', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.ok(server.indexOf("'/api/admin/orders'") > -1 && server.indexOf("'/api/admin/orders'") < server.indexOf("app.use('/api/admin', createAdminRouter"), 'mounted before the owner/admin router');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(page, /data-t="orders"/);
  assert.match(page, /json\('orders\?status='/);
  assert.match(page, /'staff'\]\.includes\(me\.staff\)/);
});
