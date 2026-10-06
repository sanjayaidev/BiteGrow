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

const SELECT = '*, settings:bg_tenant_settings(*)';
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
    },
  };
}

// What the browser is allowed to know. Replaces the old config.json / window.CONFIG.
function publicConfig(t) {
  const s = t.settings;
  return {
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
        const { data, error } = await supabase.from('bg_tenants').select(SELECT).eq('slug', slug).maybeSingle();
        if (error) throw error;
        return data ? shapeTenant(data) : null;
      })
    : Promise.resolve(null);

  const byDomain = (host) => host
    ? cached('d:' + host, async () => {
        const { data, error } = await supabase
          .from('bg_tenant_domains').select(`tenant:bg_tenants(${SELECT})`).eq('domain', host).maybeSingle();
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

module.exports = { createTenantResolver, publicConfig, shapeTenant, normalizeHost };
