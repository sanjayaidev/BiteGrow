'use strict';
// Works out which restaurant (tenant) a request is for and puts it on req.tenant.
//
// Resolution order (first match wins):
//   1. ?tenant=<slug>              only when allowQueryOverride is on (development)
//   2. exact hostname              bg_tenant_domains (custom domains, localhost)
//   3. <slug>.<BASE_DOMAIN>        e.g. redhouse.bitegrow.app
//   4. DEFAULT_TENANT              single-client / local fallback
//
// The host comes from req.hostname, which Express fills from X-Forwarded-Host
// only when "trust proxy" is set, so a client cannot spoof it by itself.

const BASE_SELECT = '*, timezone, settings:bg_tenant_settings(*)';
const INTEGRATION_COLS = 'meta_pixel_id, ai_enabled, ai_greeting, ai_channels';
const SELECT = `${BASE_SELECT}, integrations:bg_tenant_integrations(${INTEGRATION_COLS})`;
const TENANT_SELECT = SELECT;

// PostgREST cannot embed bg_tenant_integrations when migration 002 has not been run, or when its schema cache is
// stale (fix: run db/004_reload_schema.sql). The storefront must still load in that case, so the lookup retries
// without the embed and reads the integrations row separately (missing -> no pixel, assistant off).
const isRelationshipError = (e) => !!e && (e.code === 'PGRST200' || e.code === 'PGRST205' || /relationship|schema cache|bg_tenant_integrations/i.test(e.message || ''));
let warnedIntegrations = false;
async function attachIntegrations(supabase, row) {
  if (!row) return row;
  if (!warnedIntegrations) { warnedIntegrations = true; console.warn('bg_tenant_integrations is not visible to the API (run db/002_admin_meta_ai.sql, db/003_ai_alibaba.sql, then db/004_reload_schema.sql). Continuing without it.'); }
  try {
    const { data, error } = await supabase.from('bg_tenant_integrations').select(INTEGRATION_COLS).eq('tenant_id', row.id).maybeSingle();
    row.integrations = error ? null : data;
  } catch (e) { row.integrations = null; }
  return row;
}
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function normalizeHost(h) {
  let host = String(h || '').trim().toLowerCase();
  if (host.startsWith('[')) host = host.slice(0, host.indexOf(']') + 1);   // [::1]:3000
  else host = host.split(':')[0];
  return host.replace(/\.$/, '');
}

// Database row -> the shape the rest of the app uses.
function shapeTenant(row) {
  const s = row.settings || {};
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status,
    timezone: row.timezone,
    currency: row.currency,
    currencySymbol: row.currency_symbol,
    defaultLang: row.default_lang,
    languages: row.languages || ['en'],
    orderPrefix: row.order_prefix,
    settings: {
      brandName: s.brand_name || row.name,
      pageTitle: s.page_title || row.name,
      logoUrl: s.logo_url || null,
      cardBgUrl: s.card_bg_url || null,
      phone: s.phone || null,
      phone2: s.phone2 || null,
      address: s.address || null,
      mapUrl: s.map_url || null,
      whatsappNumber: s.whatsapp_number || '',
      deliveryFee: Number(s.delivery_fee || 0),
      orderTypes: s.order_types || ['dine_in', 'pickup', 'delivery'],
      features: s.features || {},
      // Opening hours and the manual "not taking orders" switch (see src/lib/hours.js).
      openHours: s.open_hours && typeof s.open_hours === 'object' ? s.open_hours : {},
      openNote: s.open_note || '',
      pauseOrders: !!s.pause_orders,
      pauseUntil: s.pause_until || null,
    },
    // Only the public-safe parts of the integrations row (never tokens or keys).
    integrations: {
      metaPixelId: row.integrations && /^\d{5,25}$/.test(row.integrations.meta_pixel_id || '') ? row.integrations.meta_pixel_id : null,
      assistantOn: !!(row.integrations && row.integrations.ai_enabled && (row.integrations.ai_channels || []).includes('web') && (s.features || {}).assistant),
      assistantGreeting: (row.integrations && row.integrations.ai_greeting) || '',
    },
  };
}

// What the browser is allowed to know. Replaces the old config.json / window.CONFIG.
// The opening-hours schedule travels with it (wall-clock times + the restaurant's own timezone),
// so the storefront can show "Open until 22:00" and stop checkout while the kitchen is closed.
function publicConfig(t, now = new Date()) {
  const s = t.settings;
  const hours = require('./lib/hours');
  // The library reads the raw database column names (open_hours / open_note / pause_orders /
  // pause_until), while shapeTenant hands us camelCase fields — translate before asking for status.
  const raw = {
    open_hours: s.openHours, open_note: s.openNote,
    pause_orders: s.pauseOrders, pause_until: s.pauseUntil,
    timezone: t.timezone,
  };
  const status = hours.isOpen(raw, now);
  // The schedule the storefront prints in its footer: every weekday present (missing days read as
  // closed), falling back to the "default" row — the same shape formatLines uses server-side.
  const dayRows = raw.open_hours && typeof raw.open_hours === 'object' ? raw.open_hours : {};
  const openHours = hours.DAYS.reduce((acc, d) => {
    acc[d] = Array.isArray(dayRows[d]) ? dayRows[d] : (Array.isArray(dayRows.default) ? dayRows.default : []);
    return acc;
  }, {});
  return {
    openStatus: { open: status.open, reason: status.reason || null, message: status.message },
    canSchedule: true,        // a "ready by" order is exactly how a closed restaurant still takes orders
    tenant: t.slug,
    brand: s.brandName,
    pageTitle: s.pageTitle,
    logo: s.logoUrl,
    cardBg: s.cardBgUrl,
    currency: t.currencySymbol,
    currencyCode: t.currency,
    languages: t.languages,
    defaultLang: t.defaultLang,
    phone: s.phone,
    phone2: s.phone2,
    address: s.address,
    mapUrl: s.mapUrl,
    whatsappNumber: s.whatsappNumber,
    deliveryFee: s.deliveryFee,
    orderTypes: s.orderTypes,
    features: s.features,
    // Opening hours for the footer and the "ready by" picker. Wall-clock strings in the restaurant's own timezone.
    openHours,
    openNote: s.openNote,
    timezone: t.timezone || 'UTC',
    assistant: !!(t.integrations && t.integrations.assistantOn),
    assistantGreeting: (t.integrations && t.integrations.assistantGreeting) || '',
  };
}

function createTenantResolver({
  supabase,
  baseDomain = '',
  defaultTenant = '',
  allowQueryOverride = false,
  ttlMs = 60_000,
  missTtlMs = 10_000,
  now = Date.now,
}) {
  const cache = new Map();   // key -> { at, ttl, value }
  const base = baseDomain.toLowerCase().replace(/^\./, '');

  async function cached(key, loader) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < hit.ttl) return hit.value;
    const value = await loader();              // errors propagate and are not cached
    cache.set(key, { at: now(), ttl: value ? ttlMs : missTtlMs, value });
    return value;
  }

  const bySlug = (slug) => SLUG_RE.test(slug)
    ? cached('s:' + slug, async () => {
        let { data, error } = await supabase.from('bg_tenants').select(SELECT).eq('slug', slug).maybeSingle();
        if (error && isRelationshipError(error)) {
          ({ data, error } = await supabase.from('bg_tenants').select(BASE_SELECT).eq('slug', slug).maybeSingle());
          if (!error) await attachIntegrations(supabase, data);
        }
        if (error) throw error;
        return data ? shapeTenant(data) : null;
      })
    : Promise.resolve(null);

  const byDomain = (host) => host
    ? cached('d:' + host, async () => {
        let { data, error } = await supabase
          .from('bg_tenant_domains').select(`tenant:bg_tenants(${SELECT})`).eq('domain', host).maybeSingle();
        if (error && isRelationshipError(error)) {
          ({ data, error } = await supabase
            .from('bg_tenant_domains').select(`tenant:bg_tenants(${BASE_SELECT})`).eq('domain', host).maybeSingle());
          if (!error && data && data.tenant) await attachIntegrations(supabase, data.tenant);
        }
        if (error) throw error;
        return data && data.tenant ? shapeTenant(data.tenant) : null;
      })
    : Promise.resolve(null);

  async function find(req) {
    if (allowQueryOverride && req.query && typeof req.query.tenant === 'string') {
      const t = await bySlug(req.query.tenant.toLowerCase());
      if (t) return t;
    }
    const host = normalizeHost(req.hostname);
    let t = await byDomain(host);
    if (t) return t;
    if (base && host.endsWith('.' + base)) {
      const sub = host.slice(0, -(base.length + 1));
      if (sub && !sub.includes('.')) {
        t = await bySlug(sub);
        if (t) return t;
      }
    }
    return defaultTenant ? bySlug(defaultTenant) : null;
  }

  async function middleware(req, res, next) {
    try {
      const t = await find(req);
      const isApi = req.originalUrl.startsWith('/api');
      if (!t) {
        return isApi ? res.status(404).json({ error: 'Unknown restaurant' }) : res.status(404).type('text').send('Restaurant not found');
      }
      if (t.status !== 'active') {
        return isApi ? res.status(403).json({ error: 'This restaurant is currently unavailable' }) : res.status(403).type('text').send('This restaurant is currently unavailable');
      }
      req.tenant = t;
      next();
    } catch (err) {
      console.error('tenant lookup failed:', err.message || err);
      res.status(503).json({ error: 'Service temporarily unavailable' });
    }
  }

  // Call after changing a tenant's settings/domains so the change shows up immediately.
  const invalidate = (tenantId) => {
    for (const [k, v] of cache) if (!tenantId || (v.value && v.value.id === tenantId)) cache.delete(k);
  };

  return { middleware, find, invalidate };
}

module.exports = { createTenantResolver, publicConfig, shapeTenant, normalizeHost, TENANT_SELECT, BASE_SELECT };
