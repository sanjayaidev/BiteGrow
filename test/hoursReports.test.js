'use strict';
// Opening hours, order pausing, scheduled "ready by" orders, admin reports and platform analytics.

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDb } = require('./helpers/fakeDb');
const { TENANT_A } = require('./helpers/httpApp');
const H = require('../src/lib/hours');

const WEEK = { mon: [{ open: '11:30', close: '22:00' }], tue: [{ open: '11:30', close: '22:00' }], wed: [], thu: [], fri: [], sat: [], sun: [] };
const WEEK_ALL = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ open: '00:00', close: '23:59' }]]));

// ---------------------------------------------------------------- hours library
test('hours: a restaurant with no schedule stays open (legacy behaviour)', () => {
  const st = H.isOpen({ settings: {} }, new Date('2026-10-10T03:00:00Z'));
  assert.equal(st.open, true);
  assert.equal(st.reason, 'no_schedule');
});

test('hours: closed at 3 a.m., open during the window, closed day reported', () => {
  const s = { settings: { open_hours: WEEK }, timezone: 'UTC' };
  const inside = H.isOpen(s, new Date('2026-10-12T15:00:00Z'));              // Mon 15:00, inside 11:30-22:00
  assert.equal(inside.open, true);
  assert.match(inside.message, /until 22:00/);
  const lateNight = H.isOpen(s, new Date('2026-10-12T03:00:00Z'));           // Mon 03:00, before opening
  assert.equal(lateNight.open, false);
  assert.equal(lateNight.reason, 'before_open');
  assert.match(lateNight.message, /open at 11:30/);
  const sunday = H.isOpen(s, new Date('2026-10-11T12:00:00Z'));              // Sun: no windows
  assert.equal(sunday.open, false);
  assert.equal(sunday.reason, 'closed_day');
});

test('hours: windows that cross midnight keep the early-morning minutes open', () => {
  const s = { settings: { open_hours: { default: [{ open: '20:00', close: '02:00' }] } }, timezone: 'UTC' };
  assert.equal(H.isOpen(s, new Date('2026-10-12T01:00:00Z')).open, true);    // Mon 01:00 is still inside the Mon-night window (starts 20:00 previous evening semantics aside, 01:00 < 02:00 close)
  assert.equal(H.isOpen(s, new Date('2026-10-11T21:00:00Z')).open, true);    // Sun 21:00 inside 20:00-02:00(+1)
  assert.equal(H.isOpen(s, new Date('2026-10-12T03:00:00Z')).open, false);   // Mon 03:00: the overnight window ended at 02:00
});

test('hours: manual pause blocks everything, timed pause lifts itself', () => {
  const base = { settings: { open_hours: WEEK }, timezone: 'UTC' };
  const paused = { settings: { ...base.settings, pause_orders: true }, timezone: 'UTC' };
  const st = H.isOpen(paused, new Date('2026-10-12T15:00:00Z'));             // inside opening hours
  assert.equal(st.open, false);
  assert.equal(st.reason, 'paused');
  const expired = { settings: { ...base.settings, pause_orders: true, pause_until: '2026-10-12T14:00:00Z' }, timezone: 'UTC' };
  assert.equal(H.isOpen(expired, new Date('2026-10-12T15:00:00Z')).open, true);   // resume time passed on its own
});

test('hours: validateSchedule accepts days + default, rejects junk', () => {
  assert.deepEqual(H.validateSchedule({ mon: [{ open: '9:00', close: '21:30' }] }).hours, { mon: [{ open: '09:00', close: '21:30' }] });
  assert.ok(H.validateSchedule({ nope: [] }).error);
  assert.ok(H.validateSchedule({ mon: 'open all day' }).error);
  assert.ok(H.validateSchedule({ mon: [{ open: '25:00', close: '22:00' }] }).error);
  assert.deepEqual(H.validateSchedule('').hours, {});
});

test('hours: formatLines prints one line per weekday and the note', () => {
  const sch = H.scheduleFrom({ settings: { open_hours: { default: [{ open: '11:00', close: '22:00' }] }, open_note: 'Last orders 21:30' }, timezone: 'UTC' });
  const lines = H.formatLines(sch);
  assert.equal(lines.length, 8);                                   // 7 days + note
  assert.match(lines[0], /^Mon: 11:00–22:00$/);
  assert.equal(lines[7], 'Last orders 21:30');
});

// ---------------------------------------------------------------- public config
test('publicConfig exposes openStatus, openHours and canSchedule', () => {
  const { publicConfig } = require('../src/tenant');
  const t = { ...TENANT_A, timezone: 'UTC', settings: { ...TENANT_A.settings, open_hours: WEEK, open_note: 'Ramadan: after sunset' } };
  const cfg = publicConfig(t, new Date('2026-10-12T15:00:00Z'));
  assert.equal(cfg.openStatus.open, true);
  assert.deepEqual(cfg.openHours, WEEK);
  assert.equal(cfg.openNote, 'Ramadan: after sunset');
  assert.equal(typeof cfg.canSchedule, 'boolean');
  const closed = publicConfig(t, new Date('2026-10-12T03:00:00Z'));
  assert.equal(closed.openStatus.open, false);
  assert.match(closed.openStatus.message, /open at 11:30/);
});

// ---------------------------------------------------------------- assistant prompt
test('assistant system prompt carries the owner schedule and live status', () => {
  const { buildSystemPrompt } = require('../src/lib/assistant');
  const t = { ...TENANT_A, timezone: 'UTC', settings: { ...TENANT_A.settings, open_hours: WEEK } };
  const p = buildSystemPrompt({ tenant: t, menuText: 'Butter Naan ₹45', now: new Date('2026-10-12T15:00:00Z') });
  assert.match(p, /Opening hours/);
  assert.match(p, /Mon: 11:30–22:00/);
  assert.match(p, /Current status: OPEN/);
});

// ---------------------------------------------------------------- orders gate
const { createAuth } = require('../src/middleware/auth');
const { createOrdersRouter } = require('../src/routes/orders');
const { makeApp, withServer } = require('./helpers/httpApp');

function ordersSetup(settings, timezone) {
  const db = makeDb({ bg_menu_items: [
    { id: 1, tenant_id: 'tenant-a', category_id: 1, name: 'Samosa', price: 40, is_available: true },
  ], bg_orders: [], bg_order_items: [] });
  const auth = createAuth({ supabase: db.supabase });
  const T = { ...TENANT_A, timezone, settings: { ...TENANT_A.settings, ...settings } };
  // The tenant override has to be registered BEFORE the router, or the router never sees it.
  const app = makeApp((a) => {
    a.use((req, res, next) => { req.tenant = T; next(); });
    a.use('/api', createOrdersRouter({ supabase: db.supabase, auth }));
  });
  return { db, call: null, app };
}
const orderBody = { order_type: 'pickup', customer_name: 'Ash', customer_phone: '+917504704502', items: [{ menu_item_id: 1, quantity: 1 }] };

test('orders: rejected while paused, with the pause message', async () => {
  const { app, db } = ordersSetup({ pause_orders: true, open_hours: WEEK }, 'UTC');
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: orderBody });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Not taking orders/);
    assert.equal(db.rowsOf('bg_orders').length, 0);
  });
});

// A window that ended less than two hours ago: deterministic whether or not the machine's clock
// happens to sit inside it (it cannot — the window itself is one hour long).
function recentClosedSchedule(tz) {
  const H = require('../src/lib/hours');
  const now = H.localNow(tz);
  const end = now.hm - 60;                                 // closed an hour ago
  const start = end - 60;
  const shift = (m) => { const x = ((m % 1440) + 1440) % 1440; return H.hhmm(x); };
  const days = {}; for (const d of H.DAYS) days[d] = [];
  days[now.dow] = [{ open: shift(start), close: shift(end) }];
  return days;
}

test('orders: rejected outside the schedule with the hours message', async () => {
  const { app, db } = ordersSetup({ open_hours: recentClosedSchedule('Asia/Kolkata') }, 'Asia/Kolkata');
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: orderBody });
    assert.equal(r.status, 409);
    assert.equal(r.body.open_status.reason, 'after_close');
    assert.match(r.body.error, /closed/i);
    assert.equal(db.rowsOf('bg_orders').length, 0);        // nothing was stored
  });
});

test('orders: a restaurant without any schedule still accepts orders', async () => {
  const { app, db } = ordersSetup({}, 'UTC');
  await withServer(app, async (call) => {
    const r = await call('POST', '/api/orders', { body: orderBody });
    assert.equal(r.status, 201);
    assert.equal(r.body.ready_at, null);
    assert.equal(db.rowsOf('bg_orders').length, 1);
  });
});

test('orders: a scheduled "ready by" order stores the instant and the lead time', async () => {
  const { app, db } = ordersSetup({ open_hours: WEEK_ALL }, 'UTC');
  await withServer(app, async (call) => {
    const soon = new Date(Date.now() + 5 * 60_000).toISOString();
    const bad = await call('POST', '/api/orders', { body: { ...orderBody, ready_at: soon } });
    assert.equal(bad.status, 400);                       // below the 15-minute lead
    assert.equal(db.rowsOf('bg_orders').length, 0);
    const later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const ok = await call('POST', '/api/orders', { body: { ...orderBody, ready_at: later } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.ready_at, new Date(later).toISOString());
    const row = db.rowsOf('bg_orders')[0];
    assert.equal(row.ready_at, new Date(later).toISOString());
    assert.ok(Number(row.lead_minutes) >= 179);
  });
});

test('ready_at validation: lead time, horizon and the schedule itself', () => {
  const { parseReadyAt } = require('../src/routes/orders');
  const T = (days) => ({ timezone: 'UTC', settings: { ...TENANT_A.settings, open_hours: days } });
  const isoIn = (mins) => new Date(Date.now() + mins * 60_000).toISOString();
  const allWeek = {}; for (const d of H.DAYS) allWeek[d] = [{ open: '00:00', close: '23:59' }];

  assert.deepEqual(parseReadyAt(T(allWeek), ''), {});                              // ASAP order: no field
  assert.match(parseReadyAt(T(allWeek), 'not a date').error, /does not look right/);
  assert.match(parseReadyAt(T(allWeek), isoIn(5)).error, /at least 15 minutes/);   // too soon
  assert.match(parseReadyAt(T(allWeek), isoIn(31 * 24 * 60)).error, /30 days/);    // too far
  const ok = parseReadyAt(T(allWeek), isoIn(120));
  assert.ok(ok.readyAt && ok.leadMinutes >= 119 && ok.display);
  const closedSun = { mon: [{ open: '11:30', close: '22:00' }], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
  assert.match(parseReadyAt(T(closedSun), nextSundayNoon()).error, /not open/i);   // ready-by lands on a closed day
});
function nextSundayNoon() {
  const d = new Date();
  d.setDate(d.getDate() + ((0 - d.getDay() + 7) % 7 || 7));
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString();
}

// ---------------------------------------------------------------- reports endpoint
const express = require('express');
const { createAdminRouter } = require('../src/routes/admin');
const { createSecretBox } = require('../src/lib/secrets');

function adminSetup(seed = {}) {
  const db = makeDb({
    bg_profiles: [], bg_menu_items: [], bg_tenant_settings: [{ tenant_id: 'tenant-a', brand_name: 'RED HOUSE' }],
    bg_tenant_integrations: [], bg_tenant_members: [], bg_tenants: [], bg_orders: [], bg_order_items: [], ...seed,
  });
  const staffUser = db.addUser('owner@a.test');
  db.rowsOf('bg_tenant_members').push({ tenant_id: 'tenant-a', user_id: staffUser.id, role: 'admin' });
  const box = createSecretBox('unit-test-secret-key-123');
  const app = express();
  app.use((req, res, next) => { req.tenant = { ...TENANT_A, timezone: 'UTC' }; next(); });
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ supabase: db.supabase, auth: createAuth({ supabase: db.supabase }), secretBox: box, assistant: { reply: async () => ({ text: 'x' }) } }));
  app.use((err, req, res, next) => res.status(err && err.status || 500).json({ error: 'boom' }));
  return { db, app, token: db.token(staffUser) };
}

test('settings PUT stores, validates and returns opening hours and pause', async () => {
  const { app, db, token } = adminSetup();
  const server = app.listen(0); const port = server.address().port;
  const put = (body) => fetch(`http://127.0.0.1:${port}/api/admin/settings`, { method: 'PUT', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  try {
    const bad = await put({ open_hours: { monday: [{ open: '11:30', close: '22:00' }] } });
    assert.equal(bad.status, 400);
    const ok = await put({ open_hours: WEEK, open_note: 'Closed for Eid prayers at noon', pause_orders: true, pause_until: '2026-12-31T18:00:00.000Z' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.open_hours, WEEK);
    assert.equal(ok.body.pause_orders, true);
    const row = db.rowsOf('bg_tenant_settings')[0];
    assert.equal(row.open_note, 'Closed for Eid prayers at noon');
    assert.equal(row.pause_until, '2026-12-31T18:00:00.000Z');
    const resumed = await put({ pause_orders: false });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.pause_until, null);
  } finally { server.close(); }
});

test('reports: daily buckets, totals and top dishes in the tenant timezone', async () => {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const seed = {
    bg_orders: [
      { id: 1, tenant_id: 'tenant-a', order_number: 'A-1', order_type: 'pickup', status: 'completed', total: 100, channel: 'web', created_at: new Date().toISOString() },
      { id: 2, tenant_id: 'tenant-a', order_number: 'A-2', order_type: 'delivery', status: 'cancelled', total: 50, channel: 'whatsapp', created_at: new Date().toISOString() },
      { id: 3, tenant_id: 'tenant-b', order_number: 'B-1', order_type: 'pickup', status: 'completed', total: 999, channel: 'web', created_at: new Date().toISOString() },
    ],
    bg_order_items: [
      { order_id: 1, tenant_id: 'tenant-a', name_snapshot: 'Samosa', quantity: 2, line_total: 80 },
      { order_id: 2, tenant_id: 'tenant-a', name_snapshot: 'Naan', quantity: 1, line_total: 50 },   // cancelled order sells nothing
      { order_id: 3, tenant_id: 'tenant-b', name_snapshot: 'Other', quantity: 1, line_total: 999 },
    ],
  };
  const { app, token } = adminSetup(seed);
  const server = app.listen(0); const port = server.address().port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/admin/reports?from=${todayYmd}&to=${todayYmd}`, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.totals.orders, 2);                       // tenant-b excluded
    assert.equal(j.totals.revenue, 100);                    // cancelled excluded
    assert.equal(j.totals.cancelled, 1);
    const day = j.days.find((d) => d.orders > 0);
    assert.equal(day.by_channel.web, 1);
    assert.deepEqual(day.by_type, { dine_in: 0, pickup: 1, delivery: 1 });
    assert.deepEqual(j.items.map((i) => [i.name, i.quantity]), [['Samosa', 2]]);
    const badRange = await fetch(`http://127.0.0.1:${port}/api/admin/reports?from=2026-13-99&to=${todayYmd}`, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(badRange.status, 400);
  } finally { server.close(); }
});

test('kitchen ticket: plain text with READY BY, scoped to this tenant', async () => {
  const readyIso = new Date(Date.now() + 3600_000).toISOString();
  const { app, token } = adminSetup({
    bg_orders: [
      { id: 7, tenant_id: 'tenant-a', order_number: 'A-7', order_type: 'pickup', status: 'confirmed', total: 120, delivery_fee: 0, customer_name: 'Ash', customer_phone: '+917504704502', notes: 'extra spicy', ready_at: readyIso, created_at: new Date().toISOString() },
      { id: 8, tenant_id: 'tenant-b', order_number: 'B-8', order_type: 'pickup', status: 'confirmed', total: 1, created_at: new Date().toISOString() },
    ],
    bg_order_items: [{ order_id: 7, tenant_id: 'tenant-a', name_snapshot: 'Samosa', quantity: 3, line_total: 120 }],
  });
  const server = app.listen(0); const port = server.address().port;
  try {
    const mine = await fetch(`http://127.0.0.1:${port}/api/admin/orders/7/ticket`, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(mine.status, 200);
    assert.match(mine.headers.get('content-type'), /text\/plain/);
    const text = await mine.text();
    assert.match(text, /TICKET A-7/);
    assert.match(text, /READY BY \d{2}:\d{2}/);
    assert.match(text, /3 x Samosa/);
    assert.match(text, /Notes: extra spicy/);
    const foreign = await fetch(`http://127.0.0.1:${port}/api/admin/orders/8/ticket`, { headers: { authorization: 'Bearer ' + token } });
    assert.equal(foreign.status, 404);
  } finally { server.close(); }
});

// ---------------------------------------------------------------- platform analytics
test('analytics: per-restaurant performance, super admin only', async () => {
  const { app, db, token } = adminSetup({
    bg_tenants: [
      { id: 'tenant-a', slug: 'a', name: 'Red House', currency: 'INR', status: 'active', timezone: 'UTC' },
      { id: 'tenant-b', slug: 'b', name: 'Wok Star', currency: 'INR', status: 'active', timezone: 'UTC' },
    ],
    bg_orders: [
      { id: 1, tenant_id: 'tenant-a', order_type: 'pickup', status: 'completed', total: 100, created_at: new Date().toISOString() },
      { id: 2, tenant_id: 'tenant-b', order_type: 'delivery', status: 'cancelled', total: 50, created_at: new Date().toISOString() },
    ],
    bg_tenant_settings: [
      { tenant_id: 'tenant-a', open_hours: {}, pause_orders: false },
      { tenant_id: 'tenant-b', open_hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }, pause_orders: false },
    ],
  });
  const server = app.listen(0); const port = server.address().port;
  const get = (p, tok) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: 'Bearer ' + tok } });
  try {
    const denied = await get('/api/admin/analytics', token);          // admin of one restaurant: not super
    assert.equal(denied.status, 403);
    const superUser = db.addUser('root@platform.test');
    db.rowsOf('bg_profiles').push({ id: superUser.id, is_super_admin: true });
    const ok = await get('/api/admin/analytics', db.token(superUser));
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.equal(j.totals.restaurants, 2);
    assert.equal(j.totals.orders, 2);
    assert.equal(j.totals.revenue, 100);
    const a = j.restaurants.find((r) => r.slug === 'a');
    const b = j.restaurants.find((r) => r.slug === 'b');
    assert.equal(a.revenue, 100);
    assert.equal(b.cancelled, 1);
    assert.equal(b.open_now, false);        // schedule present but every day empty -> closed
    assert.equal(a.open_now, true);         // no schedule -> legacy always-open
    const filtered = await get('/api/admin/analytics?type=pickup', db.token(superUser));
    const fj = await filtered.json();
    assert.equal(fj.totals.orders, 1);
    const bogus = await get('/api/admin/analytics?type=nope', db.token(superUser));
    assert.equal(bogus.status, 400);
  } finally { server.close(); }
});

// ---------------------------------------------------------------- storefront markup
test('storefront HTML/CSS carry the hours UI', () => {
  const fs = require('node:fs');
  const appJs = fs.readFileSync('public/app.js', 'utf8');
  assert.match(appJs, /closed-bar/);
  assert.match(appJs, /Opening hours/);
  assert.match(appJs, /ready_at/);
  const css = fs.readFileSync('public/app.css', 'utf8');
  assert.match(css, /\.closed-bar/);
  assert.match(css, /\.hours\b/);
  const admin = fs.readFileSync('public/admin.html', 'utf8');
  assert.match(admin, /data-t="reports"/);
  assert.match(admin, /saveHrs/);
  assert.match(admin, /Print ticket/);
  assert.match(admin, /Compare restaurants/);
});
