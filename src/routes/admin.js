'use strict';
// Restaurant admin API. Every route needs a signed-in owner/admin of THIS restaurant (or a super admin).
//
//   GET  /api/admin/menu/template.csv      blank CSV with the right headers
//   GET  /api/admin/menu/export.csv        current menu as CSV
//   POST /api/admin/menu/import            multipart "file"; ?dry_run=1 only checks
//   GET/PUT /api/admin/settings            brand, contact, order types, feature switches
//   GET  /api/admin/integrations           Meta + AI settings (secrets are never returned, only masked)
//   PUT  /api/admin/integrations/meta
//   PUT  /api/admin/integrations/ai
//   POST /api/admin/integrations/ai/test   try the assistant from the admin page
//   /api/admin/media/*                     hero + special videos and the five Special dishes (see media.js)

const express = require('express');
const multer = require('multer');
const { mask } = require('../lib/secrets');
const { templateCsv, planImport, loadExisting, applyImport, exportCsv } = require('../lib/menuImport');
const { defaultsFor, CHANNELS } = require('../lib/assistant');
const { createMediaRouter } = require('./media');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const ORDER_TYPES = ['dine_in', 'pickup', 'delivery'];
const FEATURE_KEYS = ['ar3d', 'whatsappOrder'];     // "assistant" follows the AI switch, see PUT /integrations/ai
const AI_MODEL_RE = /^[a-z0-9][a-z0-9.\-_]{2,60}$/i;

function createAdminRouter({ supabase, auth, secretBox, assistant, onTenantChanged = () => {}, onMenuChanged = () => {}, mediaOptions = {} }) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(auth.requireStaff(['owner', 'admin']));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 1 } });

  // ---- homepage videos ---------------------------------------------------
  router.use('/media', createMediaRouter({ supabase, onMediaChanged: onMenuChanged, ...mediaOptions }));

  // ---- menu CSV ----------------------------------------------------------
  const sendCsv = (res, name, body) => res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="${name}"`)
    .send('\uFEFF' + body);                            // BOM so Excel reads accents/Arabic correctly

  router.get('/menu/template.csv', (req, res) => sendCsv(res, 'menu-template.csv', templateCsv(req.tenant)));

  router.get('/menu/export.csv', asyncHandler(async (req, res) => {
    sendCsv(res, `${req.tenant.slug}-menu.csv`, await exportCsv(supabase, req.tenant));
  }));

  router.post('/menu/import', (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The file is larger than 1 MB' : 'Upload a single CSV file in the "file" field' });
  }), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a CSV file to upload' });
    const existing = await loadExisting(supabase, req.tenant.id);
    const plan = planImport(req.file.buffer.toString('utf8'), req.tenant, existing);
    if (plan.errors.length) return res.status(400).json({ error: 'The file has problems. Nothing was imported.', errors: plan.errors.slice(0, 50), error_count: plan.errors.length });
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    if (!dryRun) {
      await applyImport(supabase, req.tenant, plan, existing);
      onMenuChanged(req.tenant.id);
    }
    res.json({ dry_run: dryRun, ...plan.summary });
  }));

  // ---- settings ----------------------------------------------------------
  const readSettings = async (tenantId) => {
    const { data, error } = await supabase.from('bg_tenant_settings').select('*').eq('tenant_id', tenantId).maybeSingle();
    if (error) throw error;
    return data || {};
  };
  const settingsView = (s) => ({
    brand_name: s.brand_name || '', page_title: s.page_title || '', phone: s.phone || '', phone2: s.phone2 || '',
    address: s.address || '', map_url: s.map_url || '', whatsapp_number: s.whatsapp_number || '',
    delivery_fee: Number(s.delivery_fee || 0), order_types: s.order_types || ORDER_TYPES, features: s.features || {},
  });

  router.get('/settings', asyncHandler(async (req, res) => res.json(settingsView(await readSettings(req.tenant.id)))));

  router.put('/settings', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const u = {};
    for (const [field, max] of [['brand_name', 80], ['page_title', 120], ['phone', 30], ['phone2', 30], ['address', 300]]) {
      const v = str(b[field], max); if (v !== undefined) u[field] = v;
    }
    if (b.brand_name !== undefined && !u.brand_name) return res.status(400).json({ error: 'Brand name cannot be empty' });
    if (b.map_url !== undefined) {
      const v = str(b.map_url, 500);
      if (v && !/^https:\/\//i.test(v)) return res.status(400).json({ error: 'Map link must start with https://' });
      u.map_url = v || null;
    }
    if (b.whatsapp_number !== undefined) {
      const v = String(b.whatsapp_number || '').replace(/\D/g, '');
      if (v && (v.length < 8 || v.length > 15)) return res.status(400).json({ error: 'WhatsApp number must be 8-15 digits with country code' });
      u.whatsapp_number = v || null;
    }
    if (b.delivery_fee !== undefined) {
      const n = Number(b.delivery_fee);
      if (!Number.isFinite(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'Delivery fee must be 0 or more' });
      u.delivery_fee = Math.round(n * 100) / 100;
    }
    if (b.order_types !== undefined) {
      if (!Array.isArray(b.order_types) || !b.order_types.length || !b.order_types.every((t) => ORDER_TYPES.includes(t))) {
        return res.status(400).json({ error: 'Choose at least one of dine_in, pickup, delivery' });
      }
      u.order_types = [...new Set(b.order_types)];
    }
    if (b.features !== undefined) {
      if (!b.features || typeof b.features !== 'object') return res.status(400).json({ error: 'features must be an object' });
      const current = (await readSettings(req.tenant.id)).features || {};
      u.features = { ...current };
      for (const k of FEATURE_KEYS) if (typeof b.features[k] === 'boolean') u.features[k] = b.features[k];
    }
    if (!Object.keys(u).length) return res.status(400).json({ error: 'No settings supplied' });

    const { error } = await supabase.from('bg_tenant_settings').update(u).eq('tenant_id', req.tenant.id);
    if (error) throw error;
    onTenantChanged(req.tenant.id);
    res.json(settingsView({ ...(await readSettings(req.tenant.id)) }));
  }));

  // ---- integrations ------------------------------------------------------
  const readIntegration = async (tenantId) => {
    const { data, error } = await supabase.from('bg_tenant_integrations').select('*').eq('tenant_id', tenantId).maybeSingle();
    if (error) throw error;
    return { ...defaultsFor(), meta_enabled: false, ...(data || {}) };
  };
  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const integrationView = (req, i) => ({
    meta: {
      enabled: !!i.meta_enabled,
      whatsapp_phone_id: i.meta_whatsapp_phone_id || '',
      page_id: i.meta_page_id || '',
      instagram_id: i.meta_instagram_id || '',
      pixel_id: i.meta_pixel_id || '',
      access_token: i.meta_access_token_enc ? mask(secretBox.decrypt(i.meta_access_token_enc) || '????') : '',
      webhook_url: `${origin(req)}/webhooks/meta`,
      webhook_ready: !!(process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN),
    },
    ai: {
      enabled: !!i.ai_enabled,
      model: i.ai_model,
      persona: i.ai_persona || '',
      greeting: i.ai_greeting || '',
      handoff_phone: i.ai_handoff_phone || '',
      channels: i.ai_channels,
      daily_limit: i.ai_daily_limit,
      api_key: i.ai_api_key_enc ? mask(secretBox.decrypt(i.ai_api_key_enc) || '????') : '',
      server_key_available: !!process.env.ANTHROPIC_API_KEY,
    },
  });

  const saveIntegration = async (tenantId, fields) => {
    const { error } = await supabase.from('bg_tenant_integrations').upsert({ tenant_id: tenantId, ...fields }, { onConflict: 'tenant_id' });
    if (error) {
      if (error.code === '23505' || /duplicate|unique/i.test(error.message || '')) {
        const e = new Error('That ID is already connected to another restaurant'); e.status = 409; throw e;
      }
      throw error;
    }
  };

  // Secret fields: undefined/"" keep what is stored, null clears, a string replaces.
  const secretField = (v, name, res) => {
    if (v === undefined || v === '') return { keep: true };
    if (v === null) return { value: null };
    if (typeof v !== 'string' || v.length < 8 || v.length > 600 || /\s/.test(v)) { res.status(400).json({ error: `${name} does not look right` }); return { bad: true }; }
    try { return { value: secretBox.encrypt(v.trim()) }; }
    catch (e) { res.status(503).json({ error: 'Server is missing APP_SECRET_KEY, so secrets cannot be saved' }); return { bad: true }; }
  };

  router.get('/integrations', asyncHandler(async (req, res) => res.json(integrationView(req, await readIntegration(req.tenant.id)))));

  router.put('/integrations/meta', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const f = {};
    const idField = (key, col, label) => {
      if (b[key] === undefined) return true;
      const v = String(b[key] || '').trim();
      if (v && !/^\d{5,25}$/.test(v)) { res.status(400).json({ error: `${label} should be digits only` }); return false; }
      f[col] = v || null; return true;
    };
    if (!idField('whatsapp_phone_id', 'meta_whatsapp_phone_id', 'WhatsApp phone number ID')) return;
    if (!idField('page_id', 'meta_page_id', 'Facebook Page ID')) return;
    if (!idField('instagram_id', 'meta_instagram_id', 'Instagram account ID')) return;
    if (!idField('pixel_id', 'meta_pixel_id', 'Pixel ID')) return;
    if (b.enabled !== undefined) f.meta_enabled = !!b.enabled;
    const tok = secretField(b.access_token, 'Access token', res);
    if (tok.bad) return;
    if (!tok.keep) f.meta_access_token_enc = tok.value;

    const cur = await readIntegration(req.tenant.id);
    const next = { ...cur, ...f };
    if (next.meta_enabled && !next.meta_access_token_enc) return res.status(400).json({ error: 'Add an access token before turning Meta on' });
    if (next.meta_enabled && !next.meta_whatsapp_phone_id && !next.meta_page_id && !next.meta_instagram_id) {
      return res.status(400).json({ error: 'Add a WhatsApp number ID, Facebook Page ID or Instagram account ID first' });
    }
    await saveIntegration(req.tenant.id, f);
    onTenantChanged(req.tenant.id);
    res.json(integrationView(req, await readIntegration(req.tenant.id)));
  }));

  router.put('/integrations/ai', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const f = {};
    if (b.enabled !== undefined) f.ai_enabled = !!b.enabled;
    if (b.model !== undefined) {
      if (typeof b.model !== 'string' || !AI_MODEL_RE.test(b.model.trim())) return res.status(400).json({ error: 'Model name does not look right' });
      f.ai_model = b.model.trim();
    }
    if (b.persona !== undefined) { const v = str(b.persona, 2000); if (v === undefined) return res.status(400).json({ error: 'Instructions must be text' }); f.ai_persona = v; }
    if (b.greeting !== undefined) { const v = str(b.greeting, 200); if (v === undefined) return res.status(400).json({ error: 'Greeting must be text' }); f.ai_greeting = v; }
    if (b.handoff_phone !== undefined) {
      const v = str(b.handoff_phone, 30) || '';
      if (v && !/^[0-9+()\-\s]{7,30}$/.test(v)) return res.status(400).json({ error: 'Phone number does not look right' });
      f.ai_handoff_phone = v || null;
    }
    if (b.channels !== undefined) {
      if (!Array.isArray(b.channels) || !b.channels.every((c) => CHANNELS.includes(c))) return res.status(400).json({ error: 'Unknown channel' });
      f.ai_channels = [...new Set(b.channels)];
    }
    if (b.daily_limit !== undefined) {
      const n = Number(b.daily_limit);
      if (!Number.isInteger(n) || n < 0 || n > 100000) return res.status(400).json({ error: 'Daily limit must be a whole number from 0 to 100000' });
      f.ai_daily_limit = n;
    }
    const key = secretField(b.api_key, 'API key', res);
    if (key.bad) return;
    if (!key.keep) f.ai_api_key_enc = key.value;

    if (!Object.keys(f).length) return res.status(400).json({ error: 'No assistant settings supplied' });
    const cur = await readIntegration(req.tenant.id);
    const next = { ...cur, ...f };
    if (next.ai_enabled && !next.ai_api_key_enc && !process.env.ANTHROPIC_API_KEY) {
      return res.status(400).json({ error: 'Add an API key before turning the assistant on' });
    }
    await saveIntegration(req.tenant.id, f);

    // The storefront reads features.assistant, so keep it in step with the switch.
    if (f.ai_enabled !== undefined) {
      const features = { ...((await readSettings(req.tenant.id)).features || {}), assistant: f.ai_enabled };
      const { error } = await supabase.from('bg_tenant_settings').update({ features }).eq('tenant_id', req.tenant.id);
      if (error) throw error;
    }
    onTenantChanged(req.tenant.id);
    res.json(integrationView(req, await readIntegration(req.tenant.id)));
  }));

  router.post('/integrations/ai/test', asyncHandler(async (req, res) => {
    const message = str((req.body || {}).message, 500);
    if (!message) return res.status(400).json({ error: 'Type a message to test' });
    try {
      const r = await assistant.reply({ tenant: req.tenant, channel: 'web', contactId: `admin-test-${req.authUser.id}`, text: message });
      if (r.disabled) return res.status(409).json({ error: 'Turn the assistant on (and enable the website channel) first' });
      if (r.limited) return res.status(429).json({ error: 'Daily assistant limit reached' });
      res.json({ reply: r.text });
    } catch (err) {
      console.error(`[${req.tenant.slug}] assistant test failed:`, err.message);
      res.status(502).json({ error: 'The AI provider did not answer. Check the API key and model name.' });
    }
  }));

  // Errors raised with a status (e.g. a duplicate Meta ID) keep it; everything else goes to the server's handler.
  router.use((err, req, res, next) => (err && err.status ? res.status(err.status).json({ error: err.message }) : next(err)));

  return router;
}

module.exports = { createAdminRouter };
