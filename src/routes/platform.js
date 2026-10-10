'use strict';
// Platform admin: the owner of the whole BiteGrow deployment manages every restaurant from one page (/platform).
//
// Protection is one shared secret in the environment, PLATFORM_ADMIN_KEY. The page asks for it and sends it as
// "Authorization: Bearer <key>" on every call. With no key set (or one shorter than MIN_KEY_LENGTH) the whole
// thing is switched off, so a forgotten variable can never leave it open.
//
//   GET    /api/platform/session                       checks the key
//   GET    /api/platform/tenants                       every restaurant with its branding and domains
//   POST   /api/platform/tenants                       create one (+ optional first domain and owner)
//   PATCH  /api/platform/tenants/:id                   rename, suspend / activate, logo, timezone, currency, languages ...
//   POST   /api/platform/tenants/:id/domains           { domain }
//   DELETE /api/platform/tenants/:id/domains/:domain
//   GET    /api/platform/tenants/:id/members           the restaurant's team
//   POST   /api/platform/tenants/:id/owner             { email, password? } make someone an owner
//
// There is deliberately no "delete restaurant": that would wipe its menu, orders and customers' baskets in one
// click. Suspend it instead (its site answers "currently unavailable" and nothing is lost).
//
// Mounted in server.js BEFORE tenant resolution, so it works on any hostname.

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { okUrl } = require('../lib/menuImport');
const { findUserByEmail } = require('../lib/users');

const MIN_KEY_LENGTH = 12;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const PREFIX_RE = /^[A-Z0-9]{2,6}$/;
const LANG_RE = /^[a-z]{2,3}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATUSES = ['active', 'suspended'];
const TENANT_COLS = 'id, slug, name, status, timezone, currency, currency_symbol, default_lang, languages, order_prefix, created_at';
const MAX_TENANTS = 1000;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const keyMatches = (given, expected) => crypto.timingSafeEqual(digest(given), digest(expected));
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const raw = (v) => (typeof v === 'string' ? v.trim() : '');      // for codes: too long means refused, never silently cut short
const validZone = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch (e) { return false; } };
const bad = (error) => ({ error });

// Turns the request body into column changes for bg_tenants (t) and bg_tenant_settings (s), or { error }.
function parseFields(b, { create }) {
  const t = {}; const s = {};
  if (b.name !== undefined || create) {
    const v = text(b.name, 80);
    if (!v) return bad('Restaurant name is required');
    t.name = v;
  }
  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return bad('Status must be active or suspended');
    t.status = b.status;
  }
  if (b.timezone !== undefined) {
    const v = raw(b.timezone);
    if (!v || v.length > 64 || !validZone(v)) return bad('Timezone must be a name like Asia/Kolkata or Europe/London');
    t.timezone = v;
  }
  if (b.currency !== undefined) {
    const v = raw(b.currency).toUpperCase();
    if (!CURRENCY_RE.test(v)) return bad('Currency must be a 3-letter code like INR or USD');
    t.currency = v;
  }
  if (b.currency_symbol !== undefined) {
    const v = raw(b.currency_symbol);
    if (!v || v.length > 5) return bad('Currency symbol is required (1-5 characters)');
    t.currency_symbol = v;
  }
  if (b.order_prefix !== undefined) {
    const v = raw(b.order_prefix).toUpperCase();
    if (!PREFIX_RE.test(v)) return bad('Order prefix must be 2-6 letters or digits');
    t.order_prefix = v;
  }
  if (b.languages !== undefined) {
    const list = Array.isArray(b.languages) ? b.languages : String(b.languages).split(',');
    const langs = [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    if (!langs.length || langs.length > 8 || !langs.every((l) => LANG_RE.test(l))) return bad('Languages are 2-letter codes separated by commas, e.g. en, ar (the first one is the default)');
    t.languages = langs; t.default_lang = langs[0];
  }
  if (b.brand_name !== undefined) {
    const v = text(b.brand_name, 80);
    if (!v) return bad('Brand name cannot be empty');
    s.brand_name = v;
  }
  if (b.page_title !== undefined) {
    const v = text(b.page_title, 120);
    if (v === undefined) return bad('Browser tab title must be text');
    s.page_title = v;
  }
  if (b.logo_url !== undefined) {
    const v = b.logo_url === null ? '' : typeof b.logo_url === 'string' ? b.logo_url.trim() : undefined;
    if (v === undefined || (v && !okUrl(v))) return bad('Logo link must start with https:// or be a site file such as img/logo.png');
    s.logo_url = v || null;
  }
  return { t, s };
}

function createPlatformRouter({ supabase, key = process.env.PLATFORM_ADMIN_KEY, baseDomain = process.env.BASE_DOMAIN || '', onTenantChanged = () => {}, attempts = 10 }) {
  const router = express.Router();
  const base = String(baseDomain || '').toLowerCase().replace(/^\./, '');
  const enabled = typeof key === 'string' && key.length >= MIN_KEY_LENGTH;

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.use((req, res, next) => (enabled ? next() : res.status(503).json({
    error: `Platform admin is switched off. Set PLATFORM_ADMIN_KEY (at least ${MIN_KEY_LENGTH} characters) on the server and restart it.`,
  })));

  // Only wrong keys count against the limit, so normal use is never throttled but guessing is.
  router.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: attempts,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    requestWasSuccessful: (req, res) => res.statusCode !== 401,
    message: { error: 'Too many wrong passwords. Try again in 15 minutes.' },
  }));

  router.use((req, res, next) => {
    const [scheme, given] = (req.get('authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !given || !keyMatches(given, key)) return res.status(401).json({ error: 'Wrong password' });
    next();
  });

  router.use(express.json({ limit: '50kb' }));

  // ---- helpers ----------------------------------------------------------
  const siteUrl = (slug, domains) => {
    const real = domains.filter((d) => d.domain !== 'localhost');
    const d = real.find((x) => x.is_primary) || real[0];
    if (d) return `https://${d.domain}`;
    return base ? `https://${slug}.${base}` : null;
  };

  const view = (t, settings, domains) => ({
    id: t.id, slug: t.slug, name: t.name, status: t.status, timezone: t.timezone,
    currency: t.currency, currency_symbol: t.currency_symbol, default_lang: t.default_lang,
    languages: t.languages || ['en'], order_prefix: t.order_prefix, created_at: t.created_at,
    brand_name: (settings && settings.brand_name) || '', page_title: (settings && settings.page_title) || '',
    logo_url: (settings && settings.logo_url) || '',
    domains: domains.map((d) => ({ domain: d.domain, is_primary: !!d.is_primary })),
    url: siteUrl(t.slug, domains),
  });

  async function loadOne(id) {
    const { data: t, error } = await supabase.from('bg_tenants').select(TENANT_COLS).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!t) return null;
    const { data: s, error: sErr } = await supabase.from('bg_tenant_settings').select('tenant_id, brand_name, page_title, logo_url').eq('tenant_id', id).maybeSingle();
    if (sErr) throw sErr;
    const { data: d, error: dErr } = await supabase.from('bg_tenant_domains').select('domain, is_primary').eq('tenant_id', id);
    if (dErr) throw dErr;
    return view(t, s, d || []);
  }

  const group = (rows) => { const m = new Map(); for (const r of rows || []) { if (!m.has(r.tenant_id)) m.set(r.tenant_id, []); m.get(r.tenant_id).push(r); } return m; };

  // The restaurant named in the URL must exist; answers 400/404 itself otherwise.
  async function tenantParam(req, res) {
    const id = String(req.params.id || '');
    if (!ID_RE.test(id)) { res.status(400).json({ error: 'Invalid restaurant' }); return null; }
    const { data, error } = await supabase.from('bg_tenants').select('id, slug').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Restaurant not found' }); return null; }
    return data;
  }

  // Finds the account for an email, or creates it when a temporary password was given.
  // Returns { user, created } or { error, status }.
  async function resolveOwner(email, password) {
    let user = await findUserByEmail(supabase, email);
    if (user) return { user, created: false };
    if (!password) return { status: 404, error: 'No account uses that email yet. Enter a temporary password to create one.' };
    if (password.length < 8) return { status: 400, error: 'The temporary password must be at least 8 characters' };
    if (password.length > 72) return { status: 400, error: 'The temporary password must be at most 72 characters' };
    const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return { status: 400, error: error.message };
    return { user: data.user, created: true };
  }

  async function makeOwner(tenantId, userId) {
    const { data: cur, error } = await supabase.from('bg_tenant_members').select('user_id, role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    const r = cur
      ? await supabase.from('bg_tenant_members').update({ role: 'owner' }).eq('tenant_id', tenantId).eq('user_id', userId)
      : await supabase.from('bg_tenant_members').insert({ tenant_id: tenantId, user_id: userId, role: 'owner' });
    if (r.error) throw r.error;
  }

  // ---- routes -----------------------------------------------------------
  router.get('/session', (req, res) => res.json({ ok: true, base_domain: base }));

  router.get('/tenants', asyncHandler(async (req, res) => {
    const { data: tenants, error } = await supabase.from('bg_tenants').select(TENANT_COLS).order('name').limit(MAX_TENANTS);
    if (error) throw error;
    const { data: settings, error: sErr } = await supabase.from('bg_tenant_settings').select('tenant_id, brand_name, page_title, logo_url').limit(MAX_TENANTS);
    if (sErr) throw sErr;
    const { data: domains, error: dErr } = await supabase.from('bg_tenant_domains').select('tenant_id, domain, is_primary').limit(MAX_TENANTS * 10);
    if (dErr) throw dErr;
    const sById = new Map((settings || []).map((s) => [s.tenant_id, s]));
    const dById = group(domains);
    res.json({ base_domain: base, tenants: (tenants || []).map((t) => view(t, sById.get(t.id), dById.get(t.id) || [])) });
  }));

  router.post('/tenants', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'Web name must be 3-40 characters: lowercase letters, digits and dashes, not starting or ending with a dash' });
    const f = parseFields(b, { create: true });
    if (f.error) return res.status(400).json({ error: f.error });

    let domain = null;
    if (b.domain !== undefined && b.domain !== '' && b.domain !== null) {
      domain = String(b.domain).trim().toLowerCase();
      if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Domain must look like order.example.com (no https:// and no path)' });
    }
    let ownerEmail = '';
    if (b.owner_email !== undefined && b.owner_email !== '' && b.owner_email !== null) {
      ownerEmail = String(b.owner_email).trim().toLowerCase();
      if (ownerEmail.length > 254 || !EMAIL_RE.test(ownerEmail)) return res.status(400).json({ error: 'Owner email does not look right' });
    }
    const ownerPassword = typeof b.owner_password === 'string' ? b.owner_password : '';

    const { data: taken, error: tErr } = await supabase.from('bg_tenants').select('id').eq('slug', slug).maybeSingle();
    if (tErr) throw tErr;
    if (taken) return res.status(409).json({ error: 'That web name is already used by another restaurant' });
    if (domain) {
      const { data: dTaken, error: dErr } = await supabase.from('bg_tenant_domains').select('domain').eq('domain', domain).maybeSingle();
      if (dErr) throw dErr;
      if (dTaken) return res.status(409).json({ error: 'That domain is already used by another restaurant' });
    }
    // Check the owner can be set up before anything is created, so a typo does not leave half a restaurant behind.
    if (ownerEmail && !(await findUserByEmail(supabase, ownerEmail))) {
      if (!ownerPassword) return res.status(404).json({ error: 'No account uses the owner email yet. Enter a temporary password to create one, or leave the owner empty.' });
      if (ownerPassword.length < 8 || ownerPassword.length > 72) return res.status(400).json({ error: 'The temporary password must be 8 to 72 characters' });
    }

    const prefix = slug.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
    const { data: created, error } = await supabase.from('bg_tenants')
      .insert({ order_prefix: prefix, status: 'active', ...f.t, slug }).select(TENANT_COLS).single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That web name is already used by another restaurant' });
      throw error;
    }

    let ownerResult = null;
    try {
      const { error: sErr } = await supabase.from('bg_tenant_settings').insert({
        tenant_id: created.id, brand_name: f.s.brand_name || created.name, page_title: f.s.page_title || created.name, logo_url: f.s.logo_url || null,
      });
      if (sErr) throw sErr;
      if (domain) {
        const { error: dErr } = await supabase.from('bg_tenant_domains').insert({ domain, tenant_id: created.id, is_primary: true });
        if (dErr) throw dErr;
      }
      if (ownerEmail) {
        const r = await resolveOwner(ownerEmail, ownerPassword);
        if (r.error) { const e = new Error(r.error); e.status = r.status; e.expose = true; throw e; }
        await makeOwner(created.id, r.user.id);
        ownerResult = { email: ownerEmail, created_account: r.created };
      }
    } catch (err) {
      // Undo: deleting the restaurant cascades to its settings, domains and members.
      await supabase.from('bg_tenants').delete().eq('id', created.id);
      if (err.expose) return res.status(err.status || 400).json({ error: err.message });
      if (err.code === '23505') return res.status(409).json({ error: 'That domain is already used by another restaurant' });
      throw err;
    }

    onTenantChanged(created.id);
    res.status(201).json({ tenant: await loadOne(created.id), owner: ownerResult });
  }));

  router.patch('/tenants/:id', asyncHandler(async (req, res) => {
    const tenant = await tenantParam(req, res); if (!tenant) return;
    const f = parseFields(req.body || {}, { create: false });
    if (f.error) return res.status(400).json({ error: f.error });
    if (!Object.keys(f.t).length && !Object.keys(f.s).length) return res.status(400).json({ error: 'Nothing to change' });

    if (Object.keys(f.t).length) {
      const { error } = await supabase.from('bg_tenants').update(f.t).eq('id', tenant.id);
      if (error) throw error;
    }
    if (Object.keys(f.s).length) {
      const { error } = await supabase.from('bg_tenant_settings').upsert({ tenant_id: tenant.id, ...f.s }, { onConflict: 'tenant_id' });
      if (error) throw error;
    }
    onTenantChanged(tenant.id);
    res.json({ tenant: await loadOne(tenant.id) });
  }));

  router.post('/tenants/:id/domains', asyncHandler(async (req, res) => {
    const tenant = await tenantParam(req, res); if (!tenant) return;
    const domain = String((req.body || {}).domain || '').trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) return res.status(400).json({ error: 'Domain must look like order.example.com (no https:// and no path)' });
    const { data: existing, error: eErr } = await supabase.from('bg_tenant_domains').select('domain, tenant_id, is_primary').eq('domain', domain).maybeSingle();
    if (eErr) throw eErr;
    if (existing) return res.status(409).json({ error: existing.tenant_id === tenant.id ? 'That domain is already on this restaurant' : 'That domain is already used by another restaurant' });
    const { data: mine, error: mErr } = await supabase.from('bg_tenant_domains').select('domain, is_primary').eq('tenant_id', tenant.id);
    if (mErr) throw mErr;
    const hasPrimary = (mine || []).some((d) => d.is_primary && d.domain !== 'localhost');
    const { error } = await supabase.from('bg_tenant_domains').insert({ domain, tenant_id: tenant.id, is_primary: !hasPrimary });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That domain is already used by another restaurant' });
      throw error;
    }
    onTenantChanged(tenant.id);
    res.status(201).json({ tenant: await loadOne(tenant.id) });
  }));

  router.delete('/tenants/:id/domains/:domain', asyncHandler(async (req, res) => {
    const tenant = await tenantParam(req, res); if (!tenant) return;
    const domain = String(req.params.domain || '').toLowerCase();
    const { data: row, error: rErr } = await supabase.from('bg_tenant_domains').select('domain').eq('tenant_id', tenant.id).eq('domain', domain).maybeSingle();
    if (rErr) throw rErr;
    if (!row) return res.status(404).json({ error: 'That domain is not on this restaurant' });
    const { error } = await supabase.from('bg_tenant_domains').delete().eq('tenant_id', tenant.id).eq('domain', domain);
    if (error) throw error;
    onTenantChanged(tenant.id);
    res.json({ tenant: await loadOne(tenant.id) });
  }));

  router.get('/tenants/:id/members', asyncHandler(async (req, res) => {
    const tenant = await tenantParam(req, res); if (!tenant) return;
    const { data, error } = await supabase.from('bg_tenant_members').select('user_id, role').eq('tenant_id', tenant.id).limit(200);
    if (error) throw error;
    const order = { owner: 0, admin: 1, staff: 2 };
    const members = await Promise.all((data || []).map(async (m) => {
      const { data: u } = await supabase.auth.admin.getUserById(m.user_id);
      return { user_id: m.user_id, role: m.role, email: u && u.user ? u.user.email : '' };
    }));
    members.sort((a, b) => (order[a.role] - order[b.role]) || a.email.localeCompare(b.email));
    res.json({ members });
  }));

  router.post('/tenants/:id/owner', asyncHandler(async (req, res) => {
    const tenant = await tenantParam(req, res); if (!tenant) return;
    const b = req.body || {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    const r = await resolveOwner(email, typeof b.password === 'string' ? b.password : '');
    if (r.error) return res.status(r.status).json({ error: r.error });
    await makeOwner(tenant.id, r.user.id);
    res.status(201).json({ owner: { email, created_account: r.created } });
  }));

  router.use((req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}

module.exports = { createPlatformRouter, MIN_KEY_LENGTH };
