'use strict';
// Payment method per order type (cash / pay at pickup / COD) and the signed webhook an outside server uses to mark orders paid.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { makeDb } = require('./helpers/fakeDb');
const { makeApp, withServer } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createOrdersRouter } = require('../src/routes/orders');
const { createPaymentWebhookRouter } = require('../src/routes/paymentWebhook');
const { methodFor, methodOf, labelFor } = require('../src/lib/payment');

// ---------------------------------------------------------------- the rule
test('payment: dine-in is cash, pickup is pay at pickup, delivery is cash on delivery', () => {
  assert.equal(methodFor('dine_in'), 'cash');
  assert.equal(methodFor('pickup'), 'pay_at_pickup');
  assert.equal(methodFor('delivery'), 'cod');
  assert.equal(labelFor('cash'), 'Cash');
  assert.equal(labelFor('cod'), 'Cash on delivery');
  assert.equal(labelFor('pay_at_pickup'), 'Pay at pickup');
  assert.equal(labelFor('nope'), '');
});

test('payment: an order saved before this feature still shows a method from its order type', () => {
  assert.equal(methodOf({ order_type: 'delivery', payment_method: null }), 'cod');
  assert.equal(methodOf({ order_type: 'delivery', payment_method: 'cash' }), 'cash');   // a stored value wins
});

// ---------------------------------------------------------------- placing orders
function ordersSetup() {
  const db = makeDb({
    bg_menu_items: [{ id: 1, tenant_id: 'tenant-a', name: { en: 'Tea' }, price: 10, image_url: null, is_available: true }],
    bg_dining_tables: [{ tenant_id: 'tenant-a', label: 'T5', token: 'abc12345def', is_active: true }],
    bg_orders: [], bg_order_items: [], bg_cart_items: [], bg_profiles: [], bg_tenant_members: [],
  });
  let n = 0;
  db.hooks.bg_orders = (row) => {
    row.order_number = `RH-261007-${String(++n).padStart(4, '0')}`;
    row.order_token = db.uuid();
    row.currency = 'INR';
    row.created_at = '2026-10-07T00:00:00Z';
  };
  const auth = createAuth({ supabase: db.supabase });
  const app = makeApp((a) => a.use('/api', createOrdersRouter({ supabase: db.supabase, auth })));
  return { db, app };
}
const base = { customer_name: 'Sam', customer_phone: '+91 98765 43210', items: [{ menu_item_id: 1, quantity: 1 }] };

test('orders: the method follows the order type, is stored, and is returned', async () => {
  const { db, app } = ordersSetup();
  await withServer(app, async (call) => {
    const dine = await call('POST', '/api/orders', { body: { ...base, order_type: 'dine_in', table_token: 'abc12345def' } });
    const pick = await call('POST', '/api/orders', { body: { ...base, order_type: 'pickup' } });
    const deli = await call('POST', '/api/orders', { body: { ...base, order_type: 'delivery', delivery_address: '12 Lake Rd' } });
    assert.deepEqual([dine.status, pick.status, deli.status], [201, 201, 201]);
    assert.deepEqual([dine.body.payment_method, pick.body.payment_method, deli.body.payment_method], ['cash', 'pay_at_pickup', 'cod']);
    assert.deepEqual([dine.body.payment_method_label, pick.body.payment_method_label, deli.body.payment_method_label],
      ['Cash', 'Pay at pickup', 'Cash on delivery']);
    assert.deepEqual(db.tables.bg_orders.map((o) => [o.payment_method, o.payment_status]),
      [['cash', 'unpaid'], ['pay_at_pickup', 'unpaid'], ['cod', 'unpaid']]);
  });
});

test('orders: the customer cannot choose the method from the browser', async () => {
  const { db, app } = ordersSetup();
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: { ...base, order_type: 'delivery', delivery_address: '12 Lake Rd', payment_method: 'cash', payment_status: 'paid' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.payment_method, 'cod');
    assert.equal(r.body.payment_status, 'unpaid');
    assert.equal(db.tables.bg_orders[0].payment_method, 'cod');
    assert.equal(db.tables.bg_orders[0].payment_status, 'unpaid');
  });
});

test('orders: looking an order up shows its method, including old orders without one', async () => {
  const { db, app } = ordersSetup();
  await withServer(app, async (call) => {
    const made = await call('POST', '/api/orders', { body: { ...base, order_type: 'delivery', delivery_address: '12 Lake Rd' } });
    const got = await call('GET', `/api/orders/${made.body.order_number}?token=${made.body.order_token}`);
    assert.equal(got.status, 200);
    assert.equal(got.body.payment_method, 'cod');
    assert.equal(got.body.payment_method_label, 'Cash on delivery');

    db.tables.bg_orders[0].payment_method = null;                                   // saved before the feature existed
    const old = await call('GET', `/api/orders/${made.body.order_number}?token=${made.body.order_token}`);
    assert.equal(old.body.payment_method, 'cod');
  });
});

// ---------------------------------------------------------------- webhook
const SECRET = 'a-long-shared-secret-123';
const sign = (raw, secret = SECRET) => 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');

function hookSetup({ secret = SECRET } = {}) {
  const db = makeDb({
    bg_tenants: [{ id: 'tenant-a', slug: 'redhouse' }, { id: 'tenant-b', slug: 'wokstar' }],
    bg_orders: [
      { id: 1, tenant_id: 'tenant-a', order_number: 'RH-261010-0001', order_type: 'delivery', status: 'ready', payment_status: 'unpaid' },
      { id: 2, tenant_id: 'tenant-a', order_number: 'RH-261010-0002', order_type: 'pickup', status: 'cancelled', payment_status: 'unpaid' },
      { id: 3, tenant_id: 'tenant-b', order_number: 'WS-261010-0001', order_type: 'pickup', status: 'pending', payment_status: 'unpaid' },
    ],
  });
  const changes = [];
  const app = express();
  app.use('/webhooks/payments', createPaymentWebhookRouter({ supabase: db.supabase, secret, onOrderChanged: (t, o) => changes.push([t, o.id, o.payment_status]) }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));
  return { db, app, changes };
}

async function post(app, fn) {
  const server = app.listen(0); const port = server.address().port;
  const send = async (payload, { signature, raw } = {}) => {
    const body = raw !== undefined ? raw : JSON.stringify(payload);
    const headers = { 'content-type': 'application/json' };
    const sig = signature === undefined ? sign(body) : signature;
    if (sig) headers['x-bitegrow-signature'] = sig;
    const r = await fetch(`http://127.0.0.1:${port}/webhooks/payments`, { method: 'POST', headers, body });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  try { await fn(send); } finally { server.close(); }
}
const ok = { tenant: 'redhouse', order_number: 'RH-261010-0001', payment_status: 'paid' };

test('webhook: switched off without a long enough secret', async () => {
  for (const secret of [null, '', 'short']) {                           // null, not undefined: undefined would pick the default secret
    const { app, db } = hookSetup({ secret });
    await post(app, async (send) => {
      const r = await send(ok, { signature: sign(JSON.stringify(ok), 'short') });
      assert.equal(r.status, 503);
      assert.equal(db.tables.bg_orders[0].payment_status, 'unpaid');
    });
  }
});

test('webhook: a missing or wrong signature changes nothing', async () => {
  const { app, db, changes } = hookSetup();
  await post(app, async (send) => {
    assert.equal((await send(ok, { signature: '' })).status, 401);
    assert.equal((await send(ok, { signature: sign(JSON.stringify(ok), 'another-secret-entirely') })).status, 401);
    assert.equal((await send(ok, { signature: 'sha256=zz' })).status, 401);
    const tampered = JSON.stringify(ok);
    assert.equal((await send(null, { raw: tampered.replace('0001', '0002'), signature: sign(tampered) })).status, 401);
    assert.equal(db.tables.bg_orders[0].payment_status, 'unpaid');
    assert.equal(changes.length, 0);
  });
});

test('webhook: a signed request marks the order paid, and repeating it is harmless', async () => {
  const { app, db, changes } = hookSetup();
  await post(app, async (send) => {
    const first = await send(ok);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true, changed: true, payment_status: 'paid' });
    assert.equal(db.tables.bg_orders[0].payment_status, 'paid');
    const again = await send(ok);
    assert.equal(again.status, 200);
    assert.equal(again.body.changed, false);
    assert.deepEqual(changes, [['tenant-a', 1, 'paid']]);              // announced once
  });
});

test('webhook: paid can be refunded, refunded cannot go back, a cancelled order cannot be paid', async () => {
  const { app, db } = hookSetup();
  await post(app, async (send) => {
    assert.equal((await send(ok)).status, 200);
    const refund = await send({ ...ok, payment_status: 'refunded' });
    assert.equal(refund.status, 200);
    assert.equal(db.tables.bg_orders[0].payment_status, 'refunded');
    assert.equal((await send(ok)).status, 409);                         // refunded -> paid is refused
    const cancelled = await send({ ...ok, order_number: 'RH-261010-0002' });
    assert.equal(cancelled.status, 409);
    assert.equal(db.tables.bg_orders[1].payment_status, 'unpaid');
  });
});

test('webhook: orders are found only inside the named restaurant', async () => {
  const { app, db } = hookSetup();
  await post(app, async (send) => {
    const wrongShop = await send({ ...ok, order_number: 'WS-261010-0001' });          // exists, but belongs to wokstar
    assert.equal(wrongShop.status, 404);
    assert.equal(db.tables.bg_orders[2].payment_status, 'unpaid');
    assert.equal((await send({ ...ok, tenant: 'nowhere' })).status, 404);
    assert.equal((await send({ ...ok, order_number: 'RH-261010-9999' })).status, 404);
    assert.equal((await send({ ...ok, tenant: 'wokstar', order_number: 'WS-261010-0001' })).status, 200);
    assert.equal(db.tables.bg_orders[2].payment_status, 'paid');
  });
});

test('webhook: bad bodies are refused', async () => {
  const { app } = hookSetup();
  await post(app, async (send) => {
    assert.equal((await send(null, { raw: 'not json' })).status, 400);
    assert.equal((await send(null, { raw: '[]' })).status, 400);
    assert.equal((await send({ ...ok, payment_status: 'unpaid' })).status, 400);       // only paid or refunded can be pushed in
    assert.equal((await send({ ...ok, payment_status: 'pending' })).status, 400);
    assert.equal((await send({ ...ok, order_number: 'x' })).status, 400);
    assert.equal((await send({ ...ok, tenant: '' })).status, 400);
  });
});
