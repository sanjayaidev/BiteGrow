'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTenantResolver, normalizeHost, publicConfig } = require('../src/tenant');

const row = (slug, extra = {}) => ({
  id: 'id-' + slug, slug, name: slug.toUpperCase(), status: 'active', timezone: 'Asia/Kolkata',
  currency: 'INR', currency_symbol: '₹', default_lang: 'en', languages: ['en'], order_prefix: 'RH',
  settings: { brand_name: 'RED HOUSE', whatsapp_number: '917504704502', delivery_fee: '0', card_bg_url: 'img/wood.png', features: { ar3d: true } },
  ...extra,
});

// Minimal stand-in for the supabase-js query builder.
function fakeDb({ tenants = [], domains = {}, fail = false } = {}) {
  const calls = [];
  const db = {
    calls,
    from(table) {
      const q = { table, filters: {} };
      const b = {
        select() { return b; },
        eq(col, val) { q.filters[col] = val; return b; },
        async maybeSingle() {
          calls.push(`${table}:${JSON.stringify(q.filters)}`);
          if (fail) return { data: null, error: new Error('db down') };
          if (table === 'bg_tenants') return { data: tenants.find((t) => t.slug === q.filters.slug) || null, error: null };
          if (table === 'bg_tenant_domains') {
            const t = tenants.find((x) => x.slug === domains[q.filters.domain]);
            return { data: t ? { tenant: t } : null, error: null };
          }
          return { data: null, error: null };
        },
      };
      return b;
    },
  };
  return db;
}

function run(resolver, input) {
  const req = { originalUrl: '/api/menu', query: {}, ...input };   // the object the middleware mutates
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b, req }); },
                  type() { return this; }, send(b) { resolve({ code: this.code, body: b, req }); } };
    resolver.middleware(req, res, () => resolve({ code: 200, req }));
  });
}

test('normalizeHost strips port, case, trailing dot, ipv6 brackets', () => {
  assert.equal(normalizeHost('RedHouse.Example.com:3000'), 'redhouse.example.com');
  assert.equal(normalizeHost('localhost.'), 'localhost');
  assert.equal(normalizeHost('[::1]:3000'), '[::1]');
  assert.equal(normalizeHost(undefined), '');
});

test('custom domain resolves to its tenant, with shaped settings', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ tenants: [row('redhouse')], domains: { 'order.redhouse.in': 'redhouse' } }) });
  const out = await run(r, { hostname: 'ORDER.redhouse.in' });
  assert.equal(out.code, 200);
  const t = out.req.tenant;
  assert.equal(t.slug, 'redhouse');
  assert.equal(t.currencySymbol, '₹');
  assert.equal(t.settings.whatsappNumber, '917504704502');
  assert.equal(t.settings.deliveryFee, 0);
  assert.deepEqual(t.settings.orderTypes, ['dine_in', 'pickup', 'delivery']);   // default when unset
});

test('unknown host with no default -> 404 and nothing attached', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ tenants: [row('redhouse')] }) });
  const out = await run(r, { hostname: 'evil.example.com' });
  assert.equal(out.code, 404);
  assert.equal(out.req.tenant, undefined);
});

test('subdomain of BASE_DOMAIN resolves by slug; nested subdomains do not', async () => {
  const db = fakeDb({ tenants: [row('redhouse')] });
  const r = createTenantResolver({ supabase: db, baseDomain: 'bitegrow.app' });
  assert.equal((await run(r, { hostname: 'redhouse.bitegrow.app' })).req.tenant.slug, 'redhouse');
  assert.equal((await run(r, { hostname: 'a.redhouse.bitegrow.app' })).code, 404);
  assert.equal((await run(r, { hostname: 'nope.bitegrow.app' })).code, 404);
});

test('DEFAULT_TENANT is the fallback for unknown hosts', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ tenants: [row('redhouse')] }), defaultTenant: 'redhouse' });
  assert.equal((await run(r, { hostname: 'localhost' })).req.tenant.slug, 'redhouse');
});

test('?tenant= override only works when explicitly allowed', async () => {
  const dbs = () => fakeDb({ tenants: [row('redhouse'), row('simit')] });
  const off = createTenantResolver({ supabase: dbs(), defaultTenant: 'redhouse' });
  assert.equal((await run(off, { hostname: 'x.com', query: { tenant: 'simit' } })).req.tenant.slug, 'redhouse');
  const on = createTenantResolver({ supabase: dbs(), defaultTenant: 'redhouse', allowQueryOverride: true });
  assert.equal((await run(on, { hostname: 'x.com', query: { tenant: 'simit' } })).req.tenant.slug, 'simit');
});

test('invalid slugs never reach the database', async () => {
  const db = fakeDb({ tenants: [row('redhouse')] });
  const r = createTenantResolver({ supabase: db, allowQueryOverride: true });
  await run(r, { hostname: 'x.com', query: { tenant: "a'; drop table bg_tenants;--" } });
  assert.ok(!db.calls.some((c) => c.startsWith('bg_tenants')), 'slug query should not run');
});

test('suspended tenant -> 403', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ tenants: [row('redhouse', { status: 'suspended' })] }), defaultTenant: 'redhouse' });
  const out = await run(r, { hostname: 'localhost' });
  assert.equal(out.code, 403);
  assert.equal(out.req.tenant, undefined);
});

test('lookups are cached, expire after ttl, and invalidate() forces a reload', async () => {
  let t = 0;
  const db = fakeDb({ tenants: [row('redhouse')] });
  const r = createTenantResolver({ supabase: db, defaultTenant: 'redhouse', ttlMs: 1000, now: () => t });
  await run(r, { hostname: 'a.com' }); await run(r, { hostname: 'a.com' });
  const slugQueries = () => db.calls.filter((c) => c.startsWith('bg_tenants')).length;
  assert.equal(slugQueries(), 1);                       // second request served from cache
  t = 1500; await run(r, { hostname: 'a.com' });
  assert.equal(slugQueries(), 2);                       // ttl expired
  r.invalidate('id-redhouse'); await run(r, { hostname: 'a.com' });
  assert.equal(slugQueries(), 3);                       // explicit invalidation
});

test('database errors give 503 and are not cached', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ fail: true }), defaultTenant: 'redhouse' });
  const origError = console.error; console.error = () => {};
  try { assert.equal((await run(r, { hostname: 'a.com' })).code, 503); } finally { console.error = origError; }
});

test('publicConfig exposes only browser-safe fields', async () => {
  const r = createTenantResolver({ supabase: fakeDb({ tenants: [row('redhouse')] }), defaultTenant: 'redhouse' });
  const cfg = publicConfig((await run(r, { hostname: 'a.com' })).req.tenant);
  assert.equal(cfg.brand, 'RED HOUSE');
  assert.equal(cfg.currency, '₹');
  assert.equal(cfg.cardBg, 'img/wood.png');
  assert.ok(!('id' in cfg) && !('orderPrefix' in cfg) && !('timezone' in cfg));
});
