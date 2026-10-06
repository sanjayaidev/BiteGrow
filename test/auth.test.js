'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuth } = require('../src/middleware/auth');
const { createAuthRouter } = require('../src/routes/auth');

// ---------------------------------------------------------------- fake supabase --

function makeSupabase(seed = {}) {
  const tables = {
    bg_profiles: [], bg_tenant_members: [], bg_orders: [],
    ...seed.tables,
  };
  const users = new Map();                 // access token -> user
  const byEmail = new Map();               // email -> { user, password }
  const log = { deleted: [], passwordUpdates: [], resets: [], failProfileUpsert: false };
  let n = 0;

  const addUser = (email, password, meta = {}) => {
    const user = { id: 'u' + (++n), email, user_metadata: meta };
    byEmail.set(email, { user, password });
    users.set('tok-' + user.id, user);
    return user;
  };

  function from(table) {
    const q = { op: 'select', filters: [], payload: null, opts: {}, order: null, lim: null, single: false };
    const rows = () => tables[table];
    const match = (r) => q.filters.every(([k, v]) => r[k] === v);
    const run = () => {
      if (q.op === 'upsert') {
        if (log.failProfileUpsert) return { data: null, error: new Error('profile insert failed') };
        const exists = rows().some((r) => r.id === q.payload.id);
        if (!exists) rows().push({ phone: null, address: null, created_at: 'c', updated_at: 'u', ...q.payload });
        return { data: null, error: null };
      }
      if (q.op === 'update') {
        const hit = rows().filter(match);
        hit.forEach((r) => Object.assign(r, q.payload));
        return { data: q.single ? hit[0] || null : hit, error: null };
      }
      let out = rows().filter(match);
      if (q.order) out = [...out].sort((a, b) => (a[q.order.col] < b[q.order.col] ? 1 : -1) * (q.order.asc ? -1 : 1));
      if (q.lim != null) out = out.slice(0, q.lim);
      return { data: q.single ? out[0] || null : out, error: null };
    };
    const b = {
      select() { return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      order(col, o) { q.order = { col, asc: !(o && o.ascending === false) }; return b; },
      limit(x) { q.lim = x; return b; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; q.opts = o || {}; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      maybeSingle() { q.single = true; return Promise.resolve(run()); },
      single() { q.single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }

  const supabase = {
    from,
    auth: {
      async getUser(token) {
        const user = users.get(token);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error('bad jwt') };
      },
      async resetPasswordForEmail(email, opts) { log.resets.push({ email, ...opts }); return { error: null }; },
      admin: {
        async createUser({ email, password, user_metadata }) {
          if (byEmail.has(email)) return { data: null, error: new Error('A user with this email address has already been registered') };
          return { data: { user: addUser(email, password, user_metadata) }, error: null };
        },
        async deleteUser(id) { log.deleted.push(id); return { error: null }; },
        async updateUserById(id, attrs) { log.passwordUpdates.push({ id, ...attrs }); return { error: null }; },
      },
    },
  };

  const createAuthClient = () => ({
    auth: {
      async signInWithPassword({ email, password }) {
        const rec = byEmail.get(email);
        if (!rec || rec.password !== password) return { data: null, error: new Error('Invalid login credentials') };
        return { data: { user: rec.user, session: { access_token: 'tok-' + rec.user.id, refresh_token: 'ref-' + rec.user.id, expires_at: 999 } }, error: null };
      },
      async refreshSession({ refresh_token }) {
        const rec = [...byEmail.values()].find((r) => 'ref-' + r.user.id === refresh_token);
        if (!rec) return { data: null, error: new Error('bad refresh') };
        return { data: { session: { access_token: 'tok-' + rec.user.id, refresh_token: 'ref2-' + rec.user.id, expires_at: 1999 } }, error: null };
      },
    },
  });

  return { supabase, createAuthClient, tables, log, addUser };
}

// ------------------------------------------------------------------- test app --

const TENANTS = { a: { id: 'tenant-a', slug: 'a' }, b: { id: 'tenant-b', slug: 'b' } };

function makeApp(fake, { limit = 1000 } = {}) {
  const auth = createAuth({ supabase: fake.supabase });
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  app.use('/api/auth', createAuthRouter({ supabase: fake.supabase, auth, createAuthClient: fake.createAuthClient, limit }));
  app.get('/admin-only', auth.requireStaff(['owner', 'admin']), (req, res) => res.json({ role: req.staffRole }));
  app.get('/any-staff', auth.requireStaff(), (req, res) => res.json({ role: req.staffRole }));
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));   // mirrors server.js: no details leaked
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const port = server.address().port;
  const call = (method, path, { body, token, tenant, host } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    if (host) headers.host = host;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

// ----------------------------------------------------------------------- tests --

test('register: validates input, creates account + profile, rejects duplicates', async () => {
  const fake = makeSupabase();
  await withServer(makeApp(fake), async (call) => {
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'nope', password: 'password1' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@b.co', password: 'short' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { body: { email: 'a@b.co', password: 'x'.repeat(73) } })).status, 400);

    const ok = await call('POST', '/api/auth/register', { body: { email: 'sam@x.com', password: 'password1', display_name: '  Sam  ' } });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.profile.display_name, 'Sam');
    assert.ok(!('is_super_admin' in ok.body.profile));

    const dup = await call('POST', '/api/auth/register', { body: { email: 'sam@x.com', password: 'password1' } });
    assert.equal(dup.status, 400);
  });
});

test('register: if the profile cannot be saved the new account is deleted again', async () => {
  const fake = makeSupabase();
  fake.log.failProfileUpsert = true;
  await withServer(makeApp(fake), async (call) => {
    const r = await call('POST', '/api/auth/register', { body: { email: 'sam@x.com', password: 'password1' } });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, 'Server error');                    // no internal message leaked
    assert.equal(fake.log.deleted.length, 1);
  });
});

test('login: tokens + profile on success, one generic error otherwise', async () => {
  const fake = makeSupabase();
  fake.addUser('sam@x.com', 'password1', { display_name: 'Sam' });
  await withServer(makeApp(fake), async (call) => {
    const ok = await call('POST', '/api/auth/login', { body: { email: 'sam@x.com', password: 'password1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.access_token, 'tok-u1');
    assert.equal(ok.body.refresh_token, 'ref-u1');
    assert.equal(ok.body.profile.display_name, 'Sam');             // created from sign-up metadata on first login

    const wrongPw = await call('POST', '/api/auth/login', { body: { email: 'sam@x.com', password: 'nope' } });
    const noUser = await call('POST', '/api/auth/login', { body: { email: 'ghost@x.com', password: 'password1' } });
    assert.equal(wrongPw.status, 401);
    assert.deepEqual(wrongPw.body, noUser.body);                   // cannot tell which emails have accounts
    assert.equal((await call('POST', '/api/auth/login', { body: { email: 'sam@x.com' } })).status, 400);
  });
});

test('refresh: new token pair, or 401', async () => {
  const fake = makeSupabase();
  fake.addUser('sam@x.com', 'password1');
  await withServer(makeApp(fake), async (call) => {
    const ok = await call('POST', '/api/auth/refresh', { body: { refresh_token: 'ref-u1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.refresh_token, 'ref2-u1');
    assert.equal((await call('POST', '/api/auth/refresh', { body: { refresh_token: 'junk' } })).status, 401);
    assert.equal((await call('POST', '/api/auth/refresh', { body: {} })).status, 400);
  });
});

test('/me needs a valid token and reports the staff role for THIS restaurant only', async () => {
  const fake = makeSupabase({ tables: {
    bg_tenant_members: [{ tenant_id: 'tenant-a', user_id: 'u1', role: 'admin' }],
    bg_profiles: [{ id: 'u2', display_name: 'Root', is_super_admin: true }],
  } });
  fake.addUser('staff@x.com', 'password1');     // u1
  fake.addUser('root@x.com', 'password1');      // u2
  fake.addUser('cust@x.com', 'password1');      // u3
  await withServer(makeApp(fake), async (call) => {
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    assert.equal((await call('GET', '/api/auth/me', { token: 'forged' })).status, 401);

    assert.equal((await call('GET', '/api/auth/me', { token: 'tok-u1', tenant: 'a' })).body.staff, 'admin');
    assert.equal((await call('GET', '/api/auth/me', { token: 'tok-u1', tenant: 'b' })).body.staff, null);   // staff at A, plain customer at B
    assert.equal((await call('GET', '/api/auth/me', { token: 'tok-u2', tenant: 'b' })).body.staff, 'super');
    const cust = await call('GET', '/api/auth/me', { token: 'tok-u3' });
    assert.equal(cust.body.staff, null);
    assert.equal(cust.body.email, 'cust@x.com');
    assert.ok(!('is_super_admin' in cust.body.profile));
  });
});

test('PATCH /me: only name, phone, address; trimmed and capped; cannot grant super admin', async () => {
  const fake = makeSupabase();
  fake.addUser('sam@x.com', 'password1');
  await withServer(makeApp(fake), async (call) => {
    const r = await call('PATCH', '/api/auth/me', { token: 'tok-u1', body: {
      display_name: '  Sam  ', phone: '12345', address: 'a'.repeat(500), is_super_admin: true, id: 'someone-else',
    } });
    assert.equal(r.status, 200);
    assert.equal(r.body.profile.display_name, 'Sam');
    assert.equal(r.body.profile.address.length, 300);
    const row = fake.tables.bg_profiles.find((p) => p.id === 'u1');
    assert.equal(row.is_super_admin, undefined);
    assert.equal(row.id, 'u1');

    assert.equal((await call('PATCH', '/api/auth/me', { token: 'tok-u1', body: { is_super_admin: true } })).status, 400);
    assert.equal((await call('PATCH', '/api/auth/me', { body: { phone: '1' } })).status, 401);
  });
});

test('/orders: only this customer, only this restaurant, newest first', async () => {
  const o = (id, tenant, user, at) => ({ id, tenant_id: tenant, user_id: user, order_number: 'N' + id, created_at: at, bg_order_items: [] });
  const fake = makeSupabase({ tables: { bg_orders: [
    o(1, 'tenant-a', 'u1', '2026-10-01'), o(2, 'tenant-a', 'u1', '2026-10-03'),
    o(3, 'tenant-b', 'u1', '2026-10-02'), o(4, 'tenant-a', 'u2', '2026-10-02'),
  ] } });
  fake.addUser('sam@x.com', 'password1');
  fake.addUser('other@x.com', 'password1');
  await withServer(makeApp(fake), async (call) => {
    const a = await call('GET', '/api/auth/orders', { token: 'tok-u1', tenant: 'a' });
    assert.deepEqual(a.body.orders.map((x) => x.id), [2, 1]);
    const b = await call('GET', '/api/auth/orders', { token: 'tok-u1', tenant: 'b' });
    assert.deepEqual(b.body.orders.map((x) => x.id), [3]);
    assert.equal((await call('GET', '/api/auth/orders')).status, 401);
  });
});

test('password reset: same answer for any email, link returns to the restaurant host', async () => {
  const fake = makeSupabase();
  await withServer(makeApp(fake), async (call) => {
    const r = await call('POST', '/api/auth/request-password-reset', { body: { email: 'ghost@x.com' }, host: 'redhouse.example.com' });
    assert.deepEqual(r.body, { ok: true });
    assert.equal(fake.log.resets[0].redirectTo, 'http://redhouse.example.com/reset-password.html');
    assert.equal((await call('POST', '/api/auth/request-password-reset', { body: { email: 'bad' } })).status, 400);
  });
});

test('reset-password: needs a valid recovery token and a good password', async () => {
  const fake = makeSupabase();
  fake.addUser('sam@x.com', 'password1');
  await withServer(makeApp(fake), async (call) => {
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { access_token: 'forged', new_password: 'newpassword1' } })).status, 401);
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { access_token: 'tok-u1', new_password: 'short' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/reset-password', { body: { access_token: 'tok-u1' } })).status, 400);
    assert.equal(fake.log.passwordUpdates.length, 0);

    const ok = await call('POST', '/api/auth/reset-password', { body: { access_token: 'tok-u1', new_password: 'newpassword1' } });
    assert.deepEqual(ok.body, { ok: true });
    assert.deepEqual(fake.log.passwordUpdates, [{ id: 'u1', password: 'newpassword1' }]);
  });
});

test('requireStaff: role list is enforced per tenant; super admin always passes', async () => {
  const fake = makeSupabase({ tables: {
    bg_tenant_members: [
      { tenant_id: 'tenant-a', user_id: 'u1', role: 'staff' },
      { tenant_id: 'tenant-a', user_id: 'u2', role: 'owner' },
    ],
    bg_profiles: [{ id: 'u4', is_super_admin: true }],
  } });
  fake.addUser('waiter@x.com', 'password1');    // u1: staff at A
  fake.addUser('owner@x.com', 'password1');     // u2: owner at A
  fake.addUser('cust@x.com', 'password1');      // u3: nothing
  fake.addUser('root@x.com', 'password1');      // u4: super
  await withServer(makeApp(fake), async (call) => {
    assert.equal((await call('GET', '/admin-only')).status, 401);
    assert.equal((await call('GET', '/admin-only', { token: 'tok-u1' })).status, 403);   // staff cannot reach admin-only
    assert.equal((await call('GET', '/any-staff', { token: 'tok-u1' })).body.role, 'staff');
    assert.equal((await call('GET', '/admin-only', { token: 'tok-u2' })).body.role, 'owner');
    assert.equal((await call('GET', '/admin-only', { token: 'tok-u2', tenant: 'b' })).status, 403);  // owner of A is nobody at B
    assert.equal((await call('GET', '/any-staff', { token: 'tok-u3' })).status, 403);
    assert.equal((await call('GET', '/admin-only', { token: 'tok-u4', tenant: 'b' })).body.role, 'super');
  });
});

test('login attempts are rate limited per IP', async () => {
  const fake = makeSupabase();
  fake.addUser('sam@x.com', 'password1');
  await withServer(makeApp(fake, { limit: 3 }), async (call) => {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call('POST', '/api/auth/login', { body: { email: 'sam@x.com', password: 'wrong' } })).status);
    assert.deepEqual(codes, [401, 401, 401, 429, 429]);
  });
});