'use strict';
// BiteGrow server: one deployment, many restaurants.
//
// Every request is matched to a tenant (src/tenant.js) from its hostname. The
// storefront HTML is rendered on the server from that tenant's database rows
// (src/render.js); there is no bundled menu. Routes added in later steps
// (auth, cart, orders, admin, chat assistant) mount at the marked spot below and
// receive req.tenant, which every database query on a bg_ table must filter by.

require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { supabase } = require('./src/db');
const { createTenantResolver, publicConfig } = require('./src/tenant');
const { createStorefront } = require('./src/render');
const { createAuth } = require('./src/middleware/auth');
const { createAuthRouter } = require('./src/routes/auth');
const { createCartRouter } = require('./src/routes/cart');
const { createOrdersRouter } = require('./src/routes/orders');
const { createAdminRouter } = require('./src/routes/admin');
const { createOrdersAdminRouter } = require('./src/routes/ordersAdmin');
const { createMetaRouter } = require('./src/routes/meta');
const { createAssistantRouter } = require('./src/routes/assistant');
const { createAssistant } = require('./src/lib/assistant');
const { createSecretBox } = require('./src/lib/secrets');

let compression = null;
try { compression = require('compression'); }
catch (e) { console.warn('compression is not installed (npm i compression): pages will be sent uncompressed.'); }

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const PRODUCTION = process.env.NODE_ENV === 'production';

const resolver = createTenantResolver({
  supabase,
  baseDomain: process.env.BASE_DOMAIN || '',
  defaultTenant: process.env.DEFAULT_TENANT || '',
  allowQueryOverride: !PRODUCTION,            // ?tenant=<slug> for local testing only
});
const storefront = createStorefront({ supabase, reloadTemplate: !PRODUCTION });
const auth = createAuth({ supabase });
const secretBox = createSecretBox();
const assistant = createAssistant({ supabase });

const app = express();
// Hosting platforms put the app behind a proxy; trusting its hop count gives real client IPs and hostnames.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.disable('x-powered-by');

// CSP stays off: the page carries inline data and the 3D viewer loads from a CDN (revisit once scripts are split out).
app.use(helmet({ contentSecurityPolicy: false }));
if (compression) app.use(compression());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Meta (WhatsApp / Instagram / Messenger) calls one URL for every restaurant and signs the raw body,
// so this mounts before the tenant resolver and before any JSON parsing.
app.use('/webhooks/meta', createMetaRouter({ supabase, assistant, secretBox }));

// The admin page is a static shell; it signs in through /api/auth and every /api/admin call re-checks the role.
app.get(['/admin', '/admin.html'], (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUBLIC_DIR, 'admin.html')));

// index.html is only a template for the renderer; served as a file it would show an unfilled page.
app.get('/index.html', (req, res) => res.redirect(301, '/'));

// Static assets are shared by all tenants and need no database lookup, so they are served before tenant
// resolution. index:false leaves "/" to the renderer. Videos support Range requests (needed for seeking).
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res, file) => {
    if (file.endsWith('.html')) return;
    if (/[\\/](videos|models)[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else res.set('Cache-Control', 'public, max-age=3600');
  },
}));

// Everything below belongs to a restaurant.
app.use(resolver.middleware);

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
}));
app.use('/api', express.json({ limit: '100kb' }));

// What the browser may know about this restaurant (no secrets).
app.get('/api/config', (req, res) => {
  res.set('Cache-Control', 'no-cache').json(publicConfig(req.tenant));
});

const languageOf = (req) => {
  const q = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : '';
  return req.tenant.languages.includes(q) ? q : req.tenant.defaultLang;
};

// The same data the page was rendered from, as JSON (for refreshing the menu without reloading the page).
app.get('/api/menu', async (req, res, next) => {
  try {
    const { menu } = await storefront.menuFor(req.tenant, languageOf(req));
    res.set('Cache-Control', 'no-cache').json(menu);
  } catch (err) { next(err); }
});

const onTenantChanged = (id) => { resolver.invalidate(id); storefront.invalidate(id); assistant.invalidate(id); };
const onMenuChanged = (id) => { storefront.invalidate(id); assistant.invalidate(id); };

app.use('/api/auth', createAuthRouter({ supabase, auth }));
app.use('/api/cart', createCartRouter({ supabase, auth }));
app.use('/api', createOrdersRouter({ supabase, auth }));       // /api/orders, /api/orders/:number, /api/table/:token

// The order desk is open to kitchen staff as well, so it mounts before the owner/admin-only router below.
app.use('/api/admin/orders', createOrdersAdminRouter({ supabase, auth }));
app.use('/api/admin', createAdminRouter({ supabase, auth, secretBox, assistant, onTenantChanged, onMenuChanged }));
app.use('/api/assistant', createAssistantRouter({ assistant }));

app.get('/', async (req, res, next) => {
  try {
    const lang = languageOf(req);
    const html = await storefront.renderPage(req.tenant, lang, publicConfig(req.tenant));
    // ETag revalidation: a repeat visit costs a header exchange, and a menu change shows up on the next load.
    res.set('Cache-Control', 'no-cache').set('Vary', 'Accept-Encoding').type('html').send(html);
  } catch (err) { next(err); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).type('text').send('Not found'));

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const wantsJson = req.originalUrl.startsWith('/api');
  // Bad input from the client (malformed JSON, body too large) is the client's mistake, not a server fault:
  // answer 4xx and skip the stack trace. Everything else is a real error.
  const clientStatus = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && err.expose ? err.status : 0;
  if (clientStatus) {
    const message = clientStatus === 413 ? 'That request is too large' : 'The request could not be read';
    res.status(clientStatus);
    return wantsJson ? res.json({ error: message }) : res.type('text').send(message);
  }
  console.error(`[${req.tenant ? req.tenant.slug : 'no-tenant'}] ${req.method} ${req.originalUrl}:`, err && err.stack || err);
  res.status(500);
  return wantsJson ? res.json({ error: 'Server error' }) : res.type('text').send('Something went wrong. Please try again.');
});

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.stack || e));

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`BiteGrow listening on http://localhost:${PORT}`));
  const stop = (sig) => { console.log(`${sig}: shutting down`); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

// Exported so later routes can bust caches after an admin edit, and so tests can mount the app.
module.exports = { app, resolver, storefront, auth };
