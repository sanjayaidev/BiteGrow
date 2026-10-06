'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fakeDb');
const { makeApp, withServer } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createOrdersRouter } = require('../src/routes/orders');
const { normalizeLines, toInt, toCents, fromCents } = require('../src/lib/orderMath');

const menu = (id, tenant, name, price, extra = {}) => ({ id, tenant_id: tenant, name: { en: name, ar: 'ع' + name }, price, image_url: null, is_available: true, ...extra });

function setup({ tables = true, limit } = {}) {
  const db = makeDb({
    bg_menu_items: [
      menu(1, 'tenant-a', 'Tea', 0.1),
      menu(2, 'tenant-a', 'Biryani', 12.5),
      menu(3, 'tenant-a', 'Sold Out', 5, { is_available: false }),
      menu(50, 'tenant-b', 'Noodles', 9),
    ],
    bg_dining_tables: tables ? [
      { tenant_id: 'tenant-a', label: 'T5', token: 'abc12345def', is_active: true },
      { tenant_id: 'tenant-a', label: 'T9', token: 'dead0000beef', is_active: false },
    ] : [],
    bg_orders: [], bg_order_items: [], bg_cart_items: [], bg_profiles: [], bg_tenant_members: [],
  });
  let n = 0;
  db.hooks.bg_orders = (row) => {                       // what the database trigger does
    row.order_number = `RH-261007-${String(++n).padStart(4, '0')}`;
    row.order_token = db.uuid();
    row.currency = 'INR';
    row.created_at = '2026-10-07T00:00:00Z';
  };
  const auth = createAuth({ supabase: db.supabase });
  const app = makeApp((a) => a.use('/api', createOrdersRouter({ supabase: db.supabase, auth, ...(limit ? { createLimit: limit } : {}) })));
  return { db, app };
}

const order = (over = {}) => ({
  order_type: 'pickup', customer_name: 'Sam', customer_phone: '+91 98765 43210',
  items: [{ menu_item_id: 1, quantity: 3 }, { menu_item_id: 2, quantity: 1 }], ...over,
});

// ---------------------------------------------------------------- helpers --

test('orderMath: ids and quantities are validated and merged', () => {
  assert.equal(toInt('12'), 12);
  assert.equal(toInt(1.5), null);
  assert.equal(toInt(''), null);
  assert.equal(toInt('1e3'), null);
  assert.deepEqual(normalizeLines([{ menu_item_id: 1, quantity: 2 }, { menu_item_id: '1', quantity: '3' }]).lines, [{ id: 1, qty: 5 }]);
  for (const bad of [[], 'x', [{ menu_item_id: 0, quantity: 1 }], [{ menu_item_id: 1, quantity: 0 }], [{ menu_item_id: 1, quantity: 51 }],
    [{ menu_item_id: 1, quantity: 30 }, { menu_item_id: 1, quantity: 30 }], [null], [{ menu_item_id: 1.5, quantity: 1 }],
    Array.from({ length: 51 }, (_, i) => ({ menu_item_id: i + 1, quantity: 1 }))]) {
    assert.ok(normalizeLines(bad).error, JSON.stringify(bad).slice(0, 60));
  }
  assert.deepEqual(normalizeLines([], { allowEmpty: true }).lines, []);
  assert.equal(fromCents(toCents(0.1) * 3), 0.3);          // not 0.30000000000000004
});

// ------------------------------------------------------------ placing orders --

test('guest pickup order: priced from the database, unpaid, cent-exact, token returned once', async () => {
  const { db, app } = setup();
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: order({
      items: [{ menu_item_id: 1, quantity: 3, price: 0.01, name: 'Free' }, { menu_item_id: 2, quantity: 1, unit_price: 0 }],   // browser prices are ignored
      total: 0.01,
    }) });
    assert.equal(r.status, 201);
    assert.equal(r.body.subtotal, 12.8);
    assert.equal(r.body.total, 12.8);
    assert.equal(r.body.delivery_fee, 0);
    assert.equal(r.body.payment_status, 'unpaid');
    assert.equal(r.body.order_number, 'RH-261007-0001');
    assert.ok(r.body.order_token);
    assert.ok(!('id' in r.body));

    const row = db.tables.bg_orders[0];
    assert.equal(row.tenant_id, 'tenant-a');
    assert.equal(row.user_id, null);
    assert.equal(row.channel, 'web');
    assert.equal(row.total, 12.8);
    const lines = db.tables.bg_order_items;
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.find((l) => l.menu_item_id === 1), { tenant_id: 'tenant-a', order_id: row.id, menu_item_id: 1, name_snapshot: 'Tea', unit_price: 0.1, quantity: 3, line_total: 0.3, id: lines[0].id });

    const wa = new URL(r.body.whatsapp_url);
    assert.equal(wa.origin + wa.pathname, 'https://wa.me/917504704502');
    const text = wa.searchParams.get('text');
    assert.match(text, /RED HOUSE - order RH-261007-0001/);
    assert.match(text, /3 x Tea - ₹0\.30/);
    assert.match(text, /Total: ₹12\.80/);
  });
});

test('bad input is rejected before anything is written', async () => {
  const { db, app } = setup();
  const cases = [
    ['no name', { customer_name: '  ' }],
    ['pickup without phone', { customer_phone: '' }],
    ['odd phone', { customer_phone: 'call me' }],
    ['delivery without address', { order_type: 'delivery' }],
    ['unknown type', { order_type: 'drive_thru' }],
    ['bad email', { customer_email: 'nope' }],
    ['no items', { items: [] }],
    ['zero quantity', { items: [{ menu_item_id: 1, quantity: 0 }] }],
    ['huge quantity', { items: [{ menu_item_id: 1, quantity: 51 }] }],
    ['items not a list', { items: 'tea' }],
  ];
  await withServer(app, async (call) => {
    for (const [label, over] of cases) {
      const r = await call('POST', '/api/orders', { body: order(over) });
      assert.equal(r.status, 400, label);
    }
    assert.equal(db.tables.bg_orders.length, 0);
  });
});

test("another restaurant's items and sold-out items cannot be ordered", async () => {
  const { db, app } = setup();
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: order({ items: [{ menu_item_id: 1, quantity: 1 }, { menu_item_id: 50, quantity: 1 }, { menu_item_id: 3, quantity: 1 }] }) });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.unavailable.sort(), [3, 50]);
    assert.equal(db.tables.bg_orders.length, 0);
  });
});

test('delivery adds the restaurant\'s fee and keeps the address; pickup never stores one', async () => {
  const { db, app } = setup();
  await withServer(app, async (call) => {
    const d = await call('POST', '/api/orders', { body: order({ order_type: 'delivery', delivery_address: '12 Lake Rd', fee: 0, delivery_fee: 0 }) });
    assert.equal(d.status, 201);
    assert.equal(d.body.delivery_fee, 20);
    assert.equal(d.body.total, 32.8);
    assert.equal(db.tables.bg_orders[0].delivery_address, '12 Lake Rd');
    assert.match(new URL(d.body.whatsapp_url).searchParams.get('text'), /Delivery: ₹20\.00/);

    const p = await call('POST', '/api/orders', { body: order({ delivery_address: 'ignored' }) });
    assert.equal(p.body.delivery_fee, 0);
    assert.equal(db.tables.bg_orders[1].delivery_address, null);
  });
});

test('order types are per restaurant, and a restaurant without a WhatsApp number gets no link', async () => {
  const { db, app } = setup();
  await withServer(app, async (call) => {
    const dineIn = await call('POST', '/api/orders', { tenant: 'b', body: order({ order_type: 'dine_in', table_label: '1', items: [{ menu_item_id: 50, quantity: 1 }] }) });
    assert.equal(dineIn.status, 400);
    const ok = await call('POST', '/api/orders', { tenant: 'b', body: order({ items: [{ menu_item_id: 50, quantity: 2 }] }) });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.total, 18);
    assert.equal(ok.body.whatsapp_url, null);
    assert.equal(db.tables.bg_orders[0].tenant_id, 'tenant-b');
    // restaurant A's item ids do not work at B
    const cross = await call('POST', '/api/orders', { tenant: 'b', body: order() });
    assert.equal(cross.status, 400);
  });
});

test('dine-in: table from the QR token or a listed label; phone optional', async () => {
  const { db, app } = setup();
  const dine = (over) => order({ order_type: 'dine_in', customer_phone: '', ...over });
  await withServer(app, async (call) => {
    const viaToken = await call('POST', '/api/orders', { body: dine({ table_token: 'abc12345def' }) });
    assert.equal(viaToken.status, 201);
    assert.equal(viaToken.body.table_label, 'T5');
    assert.equal(db.tables.bg_orders[0].table_label, 'T5');
    assert.match(new URL(viaToken.body.whatsapp_url).searchParams.get('text'), /Dine-in \(table T5\)/);

    const viaLabel = await call('POST', '/api/orders', { body: dine({ table_label: ' t5 ' }) });
    assert.equal(viaLabel.body.table_label, 'T5');                         // matched case-insensitively, stored as the real label

    for (const [label, over] of [['bad token', { table_token: 'ffff0000ffff' }], ['unknown label', { table_label: 'T77' }],
      ['inactive table', { table_label: 'T9' }], ['inactive token', { table_token: 'dead0000beef' }], ['nothing', {}]]) {
      assert.equal((await call('POST', '/api/orders', { body: dine(over) })).status, 400, label);
    }
    assert.equal(db.tables.bg_orders.length, 2);
  });
});

test('dine-in at a restaurant with no table list accepts a typed table number', async () => {
  const { db, app } = setup({ tables: false });
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: order({ order_type: 'dine_in', customer_phone: '', table_label: 'Patio 2' }) });
    assert.equal(r.status, 201);
    assert.equal(db.tables.bg_orders[0].table_label, 'Patio 2');
  });
});

test('signed-in order is linked to the account, uses its email, and clears only this restaurant\'s saved basket', async () => {
  const { db, app } = setup();
  const sam = db.addUser('sam@x.com');
  db.tables.bg_cart_items.push(
    { tenant_id: 'tenant-a', user_id: sam.id, menu_item_id: 1, quantity: 2 },
    { tenant_id: 'tenant-b', user_id: sam.id, menu_item_id: 50, quantity: 1 });
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { token: db.token(sam), body: order() });
    assert.equal(r.status, 201);
    assert.equal(db.tables.bg_orders[0].user_id, sam.id);
    assert.equal(db.tables.bg_orders[0].customer_email, 'sam@x.com');
    assert.deepEqual(db.tables.bg_cart_items.map((c) => c.tenant_id), ['tenant-b']);

    const stale = await call('POST', '/api/orders', { token: 'expired', body: order() });
    assert.equal(stale.status, 401);                                       // not silently treated as a guest
    assert.equal(db.tables.bg_orders.length, 1);
  });
});

test('if the items cannot be saved the order is taken back out and nothing leaks', async () => {
  const { db, app } = setup();
  await withServer(app, async (call) => {
    db.failNext('bg_order_items', 'insert', 'constraint violated: secret detail');
    const r = await call('POST', '/api/orders', { body: order() });
    assert.equal(r.status, 500);
    assert.deepEqual(r.body, { error: 'Server error' });
    assert.equal(db.tables.bg_orders.length, 0);
  });
});

test('order creation is rate limited per IP', async () => {
  const { app } = setup({ limit: 2 });
  await withServer(app, async (call) => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await call('POST', '/api/orders', { body: order() })).status);
    assert.deepEqual(codes, [201, 201, 429, 429]);
  });
});

// ------------------------------------------------------------------- lookups --

test('order lookup: token, owner or staff of THIS restaurant; never another tenant', async () => {
  const { db, app } = setup();
  const owner = db.addUser('owner@x.com');
  const other = db.addUser('other@x.com');
  const waiter = db.addUser('waiter@x.com');
  const waiterElsewhere = db.addUser('elsewhere@x.com');
  const root = db.addUser('root@x.com');
  db.tables.bg_tenant_members.push({ tenant_id: 'tenant-a', user_id: waiter.id, role: 'staff' }, { tenant_id: 'tenant-b', user_id: waiterElsewhere.id, role: 'owner' });
  db.tables.bg_profiles.push({ id: root.id, is_super_admin: true });

  await withServer(app, async (call) => {
    const made = await call('POST', '/api/orders', { token: db.token(owner), body: order({ notes: 'no onions' }) });
    const { order_number: no, order_token: tok } = made.body;

    const byToken = await call('GET', `/api/orders/${no}?token=${tok}`);
    assert.equal(byToken.status, 200);
    assert.equal(byToken.body.order_number, no);
    assert.equal(byToken.body.notes, 'no onions');
    assert.deepEqual(byToken.body.items.map((i) => [i.name, i.quantity, i.line_total]).sort(), [['Biryani', 1, 12.5], ['Tea', 3, 0.3]]);
    for (const secret of ['order_token', 'user_id', 'id', 'tenant_id']) assert.ok(!(secret in byToken.body), secret);

    assert.equal((await call('GET', `/api/orders/${no.toLowerCase()}?token=${tok}`)).status, 200);
    assert.equal((await call('GET', `/api/orders/${no}?token=wrong`)).status, 403);
    assert.equal((await call('GET', `/api/orders/${no}`)).status, 403);

    assert.equal((await call('GET', `/api/orders/${no}`, { token: db.token(owner) })).status, 200);       // the account that placed it
    assert.equal((await call('GET', `/api/orders/${no}`, { token: db.token(other) })).status, 403);
    assert.equal((await call('GET', `/api/orders/${no}`, { token: db.token(waiter) })).status, 200);      // staff here
    assert.equal((await call('GET', `/api/orders/${no}`, { token: db.token(waiterElsewhere) })).status, 403);
    assert.equal((await call('GET', `/api/orders/${no}`, { token: db.token(root) })).status, 200);        // super admin

    // the same number and the right token, asked at another restaurant, does not exist there
    assert.equal((await call('GET', `/api/orders/${no}?token=${tok}`, { tenant: 'b' })).status, 404);

    assert.equal((await call('GET', '/api/orders/RH-261007-9999?token=x')).status, 404);
    assert.equal((await call('GET', '/api/orders/not-a-number?token=x')).status, 404);
  });
});

test('table lookup: only active tables of this restaurant', async () => {
  const { app } = setup();
  await withServer(app, async (call) => {
    assert.deepEqual((await call('GET', '/api/table/abc12345def')).body, { label: 'T5' });
    assert.equal((await call('GET', '/api/table/dead0000beef')).status, 404);        // inactive
    assert.equal((await call('GET', '/api/table/abc12345def', { tenant: 'b' })).status, 404);
    assert.equal((await call('GET', '/api/table/NOT-HEX!')).status, 404);
  });
});
