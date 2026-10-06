'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fakeDb');
const { makeApp, withServer } = require('./helpers/httpApp');
const { createAuth } = require('../src/middleware/auth');
const { createCartRouter } = require('../src/routes/cart');

const item = (id, tenant, name, price, extra = {}) => ({ id, tenant_id: tenant, name: { en: name, ar: 'ع' + name }, price, image_url: null, is_available: true, ...extra });

function setup() {
  const db = makeDb({
    bg_menu_items: [
      item(1, 'tenant-a', 'Tea', 0.1),
      item(2, 'tenant-a', 'Biryani', 12.5),
      item(3, 'tenant-a', 'Sold Out', 5, { is_available: false }),
      item(50, 'tenant-b', 'Noodles', 9),
    ],
    bg_cart_items: [], bg_profiles: [], bg_tenant_members: [],
  });
  const auth = createAuth({ supabase: db.supabase });
  const app = makeApp((a) => a.use('/api/cart', createCartRouter({ supabase: db.supabase, auth })));
  return { db, app };
}

test('every cart route needs a signed-in customer', async () => {
  const { app } = setup();
  await withServer(app, async (call) => {
    for (const [m, p, body] of [['GET', '/api/cart'], ['POST', '/api/cart', { menu_item_id: 1, quantity: 1 }],
      ['POST', '/api/cart/merge', { items: [] }], ['DELETE', '/api/cart/1'], ['DELETE', '/api/cart']]) {
      assert.equal((await call(m, p, { body })).status, 401, `${m} ${p}`);
      assert.equal((await call(m, p, { body, token: 'forged' })).status, 401, `${m} ${p} forged`);
    }
  });
});

test('set, replace, remove and clear lines; totals are cent-exact', async () => {
  const { db, app } = setup();
  const sam = db.addUser('sam@x.com');
  const t = db.token(sam);
  await withServer(app, async (call) => {
    assert.deepEqual((await call('GET', '/api/cart', { token: t })).body, { items: [], count: 0, subtotal: 0 });

    await call('POST', '/api/cart', { token: t, body: { menu_item_id: 1, quantity: 3 } });
    const r = await call('POST', '/api/cart', { token: t, body: { menu_item_id: 2, quantity: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.body.subtotal, 12.8);
    assert.equal(r.body.count, 4);
    assert.deepEqual(r.body.items.map((i) => [i.menu_item_id, i.name, i.price, i.quantity, i.available]), [[1, 'Tea', 0.1, 3, true], [2, 'Biryani', 12.5, 1, true]]);

    const replaced = await call('POST', '/api/cart', { token: t, body: { menu_item_id: 1, quantity: 1 } });   // sets, does not add
    assert.equal(replaced.body.items[0].quantity, 1);

    assert.equal((await call('POST', '/api/cart', { token: t, body: { menu_item_id: 1, quantity: 0 } })).body.items.length, 1);
    assert.equal((await call('DELETE', '/api/cart/2', { token: t })).body.items.length, 0);

    await call('POST', '/api/cart', { token: t, body: { menu_item_id: 2, quantity: 2 } });
    assert.equal((await call('DELETE', '/api/cart', { token: t })).body.count, 0);
  });
});

test('bad lines are rejected: other restaurant, sold out, out-of-range quantity, junk ids', async () => {
  const { db, app } = setup();
  const t = db.token(db.addUser('sam@x.com'));
  await withServer(app, async (call) => {
    const post = (body) => call('POST', '/api/cart', { token: t, body });
    assert.equal((await post({ menu_item_id: 50, quantity: 1 })).status, 404);      // belongs to restaurant B
    assert.equal((await post({ menu_item_id: 3, quantity: 1 })).status, 404);       // sold out
    assert.equal((await post({ menu_item_id: 1, quantity: 51 })).status, 400);
    assert.equal((await post({ menu_item_id: 1, quantity: -1 })).status, 400);
    assert.equal((await post({ menu_item_id: 1, quantity: 1.5 })).status, 400);
    assert.equal((await post({ menu_item_id: 0, quantity: 1 })).status, 400);
    assert.equal((await post({ menu_item_id: 'abc', quantity: 1 })).status, 400);
    assert.equal((await call('DELETE', '/api/cart/abc', { token: t })).status, 400);
    assert.equal(db.tables.bg_cart_items.length, 0);
  });
});

test('baskets are per restaurant and per customer', async () => {
  const { db, app } = setup();
  const sam = db.token(db.addUser('sam@x.com'));
  const kim = db.token(db.addUser('kim@x.com'));
  await withServer(app, async (call) => {
    await call('POST', '/api/cart', { token: sam, body: { menu_item_id: 1, quantity: 2 } });
    assert.equal((await call('GET', '/api/cart', { token: sam, tenant: 'b' })).body.items.length, 0);   // same person, other restaurant
    assert.equal((await call('GET', '/api/cart', { token: kim })).body.items.length, 0);                 // other person, same restaurant
    await call('POST', '/api/cart', { token: sam, tenant: 'b', body: { menu_item_id: 50, quantity: 1 } });
    assert.equal((await call('GET', '/api/cart', { token: sam })).body.items.length, 1);
    assert.equal((await call('GET', '/api/cart', { token: sam, tenant: 'b' })).body.items[0].name, 'Noodles');
  });
});

test('names follow ?lang= and fall back to the default', async () => {
  const { db, app } = setup();
  const t = db.token(db.addUser('sam@x.com'));
  await withServer(app, async (call) => {
    await call('POST', '/api/cart', { token: t, body: { menu_item_id: 1, quantity: 1 } });
    assert.equal((await call('GET', '/api/cart?lang=ar', { token: t })).body.items[0].name, 'عTea');
    assert.equal((await call('GET', '/api/cart?lang=zz', { token: t })).body.items[0].name, 'Tea');
  });
});

test('merge: guest basket is added on top, capped at 50, unavailable and foreign items skipped', async () => {
  const { db, app } = setup();
  const sam = db.addUser('sam@x.com');
  const t = db.token(sam);
  db.tables.bg_cart_items.push({ tenant_id: 'tenant-a', user_id: sam.id, menu_item_id: 1, quantity: 2 },
    { tenant_id: 'tenant-a', user_id: sam.id, menu_item_id: 2, quantity: 49 });
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/cart/merge', { token: t, body: { items: [
      { menu_item_id: 1, quantity: 3 }, { menu_item_id: 1, quantity: 1 },          // duplicates in the guest basket are combined
      { menu_item_id: 2, quantity: 5 },                                            // 49 + 5 -> capped
      { menu_item_id: 3, quantity: 1 }, { menu_item_id: 50, quantity: 1 },         // sold out / other restaurant: skipped
    ] } });
    assert.equal(r.status, 200);
    const q = Object.fromEntries(r.body.items.map((i) => [i.menu_item_id, i.quantity]));
    assert.deepEqual(q, { 1: 6, 2: 50 });

    assert.equal((await call('POST', '/api/cart/merge', { token: t, body: { items: [] } })).status, 200);
    assert.equal((await call('POST', '/api/cart/merge', { token: t, body: { items: 'x' } })).status, 400);
    assert.equal((await call('POST', '/api/cart/merge', { token: t, body: { items: [{ menu_item_id: 1, quantity: 0 }] } })).status, 400);
    assert.equal((await call('POST', '/api/cart/merge', { token: t, body: {} })).status, 400);
  });
});

test('an item hidden after it was added is flagged, left out of totals and can still be removed', async () => {
  const { db, app } = setup();
  const sam = db.addUser('sam@x.com');
  const t = db.token(sam);
  await withServer(app, async (call) => {
    await call('POST', '/api/cart', { token: t, body: { menu_item_id: 1, quantity: 10 } });
    await call('POST', '/api/cart', { token: t, body: { menu_item_id: 2, quantity: 2 } });
    db.tables.bg_menu_items.find((i) => i.id === 2).is_available = false;

    const r = await call('GET', '/api/cart', { token: t });
    assert.deepEqual(r.body.items.map((i) => [i.menu_item_id, i.available]), [[1, true], [2, false]]);
    assert.equal(r.body.subtotal, 1);
    assert.equal(r.body.count, 10);

    const removed = await call('POST', '/api/cart', { token: t, body: { menu_item_id: 2, quantity: 0 } });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.items.length, 1);
  });
});
