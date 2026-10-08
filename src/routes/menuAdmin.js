'use strict';
// Per-item and per-category menu editing. Mounted by admin.js, so every route has already passed
// requireStaff(['owner', 'admin']) for req.tenant, and every query below is filtered by that tenant.
//
//   GET    /api/admin/categories        all categories with their item counts
//   POST   /api/admin/categories        { label: { en: "Starters" }, key?, sort_order? }
//   PATCH  /api/admin/categories/:id    any of label (merged per language), key, sort_order
//   DELETE /api/admin/categories/:id    refused while the category still has items
//   GET    /api/admin/items             every item, including hidden / sold-out ones
//   POST   /api/admin/items             create (category_id, name, price are required)
//   PATCH  /api/admin/items/:id         change any subset of fields (e.g. just is_available)
//   DELETE /api/admin/items/:id         order history keeps its own name / price snapshot
//   POST   /api/admin/items/image       multipart "image" -> Supabase Storage bucket "menu" -> { url }
//                                       (create a public "menu" bucket in Supabase -> Storage, 5 MB file limit)
//
// Names, descriptions and category labels are { "<lang>": "text" } maps. Languages outside the
// restaurant's own list are ignored, the default language is required for names and labels, and an
// empty string removes a translation.

const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { toInt } = require('../lib/orderMath');
const { okUrl, slug } = require('../lib/menuImport');

const IMAGE_BUCKET = 'menu';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const KEY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const URL_FIELDS = ['image_url', 'bg_image_url', 'food_png_url', 'model_url'];

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (message) => ({ error: message });

// Real file type from the first bytes, because the browser-supplied type can be anything.
function sniffImage(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 12 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'GIF8') return { ext: 'gif', type: 'image/gif' };
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

// Merge a { lang: text } map from the request into the stored one.
function mergeMap(input, existing, tenant, { label, max, required }) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return bad(`${label} must be a map of language to text`);
  const out = { ...(existing && typeof existing === 'object' ? existing : {}) };
  for (const lang of tenant.languages) {
    if (!(lang in input)) continue;
    const v = input[lang];
    if (v !== null && typeof v !== 'string') return bad(`${label} (${lang}) must be text`);
    const t = (v || '').trim();
    if (t.length > max) return bad(`${label} (${lang}) is longer than ${max} characters`);
    if (t) out[lang] = t; else delete out[lang];
  }
  if (required && !out[tenant.defaultLang]) return bad(`${label} is required in ${tenant.defaultLang.toUpperCase()}`);
  return { value: out };
}

const nullableInt = (v, name, min, max) => {
  if (v === null || v === '' || v === undefined) return { value: null };
  const n = toInt(v);
  if (n === null || n < min || n > max) return bad(`${name} must be a whole number from ${min} to ${max}`);
  return { value: n };
};

// Request body -> database columns. `existing` is the current row for PATCH, null for POST.
function itemColumns(body, tenant, existing) {
  const b = body || {};
  const u = {};
  const create = !existing;
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);

  if (create || has('name')) {
    const r = mergeMap(has('name') ? b.name : {}, existing && existing.name, tenant, { label: 'Name', max: 120, required: true });
    if (r.error) return r; u.name = r.value;
  }
  if (has('description')) {
    const r = mergeMap(b.description, existing && existing.description, tenant, { label: 'Description', max: 600, required: false });
    if (r.error) return r; u.description = r.value;
  }
  if (create || has('price')) {
    const raw = b.price;
    const n = typeof raw === 'string' ? (raw.trim() === '' ? NaN : Number(raw)) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 99999999) return bad('Price must be a number, 0 or more');
    if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return bad('Price can have at most 2 decimals');
    u.price = Math.round(n * 100) / 100;
  }
  if (has('calories')) { const r = nullableInt(b.calories, 'Calories', 0, 20000); if (r.error) return r; u.calories = r.value; }
  if (has('rating')) {
    if (b.rating === null || b.rating === '') u.rating = null;
    else {
      const n = Number(b.rating);
      if (!Number.isFinite(n) || n < 0 || n > 5) return bad('Rating must be between 0 and 5');
      u.rating = Math.round(n * 10) / 10;
    }
  }
  if (has('popularity')) { const r = nullableInt(b.popularity, 'Popularity', 0, 1000000); if (r.error) return r; u.popularity = r.value || 0; }
  if (has('sort_order')) {
    const n = toInt(b.sort_order);
    if (n === null || Math.abs(n) > 1000000) return bad('Sort order must be a whole number');
    u.sort_order = n;
  }
  for (const k of ['is_offer', 'is_available']) {
    if (!has(k)) continue;
    if (typeof b[k] !== 'boolean') return bad(`${k} must be true or false`);
    u[k] = b[k];
  }
  for (const k of URL_FIELDS) {
    if (!has(k)) continue;
    const v = typeof b[k] === 'string' ? b[k].trim() : '';
    if (b[k] !== null && typeof b[k] !== 'string') return bad(`${k} must be a link`);
    if (v && (v.length > 600 || !okUrl(v))) return bad(`${k} must be an https link or a path like img/photo.png`);
    if (k === 'model_url' && v && !/\.glb(\?|$)/i.test(v)) return bad('3D model must be a .glb file');
    u[k] = v || null;
  }
  if (!create && !Object.keys(u).length && !has('category_id')) return bad('Nothing to change');
  return { values: u };
}

const itemView = (r) => ({
  id: r.id, category_id: r.category_id, name: r.name || {}, description: r.description || {},
  price: Number(r.price), calories: r.calories == null ? null : Number(r.calories), rating: r.rating == null ? null : Number(r.rating),
  popularity: r.popularity || 0, sort_order: r.sort_order || 0, is_offer: !!r.is_offer, is_available: r.is_available !== false,
  image_url: r.image_url || null, bg_image_url: r.bg_image_url || null, food_png_url: r.food_png_url || null, model_url: r.model_url || null,
});
const categoryView = (r, count) => ({ id: r.id, key: r.key, label: r.label || {}, sort_order: r.sort_order || 0, item_count: count || 0 });

function createMenuAdminRouter({ supabase, onMenuChanged = () => {} }) {
  const router = express.Router();

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } });
  const duplicate = (e) => e && (e.code === '23505' || /duplicate|unique/i.test(e.message || ''));

  async function getCategory(tenantId, id) {
    const { data, error } = await supabase.from('bg_categories').select('id, key, label, sort_order').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function getItem(tenantId, id) {
    const { data, error } = await supabase.from('bg_menu_items').select('*').eq('tenant_id', tenantId).eq('id', id).maybeSingle();
    if (error) throw error;
    return data;
  }
  async function allCategories(tenantId) {
    const { data, error } = await supabase.from('bg_categories').select('id, key, label, sort_order').eq('tenant_id', tenantId);
    if (error) throw error;
    return data || [];
  }
  const nextSort = (rows) => rows.reduce((m, r) => Math.max(m, r.sort_order || 0), 0) + 1;
  const idParam = (req, res) => {
    const id = toInt(req.params.id);
    if (id === null || id <= 0) { res.status(400).json({ error: 'Invalid id' }); return null; }
    return id;
  };

  // ---- categories ------------------------------------------------------------------------
  router.get('/categories', asyncHandler(async (req, res) => {
    const [cats, items] = await Promise.all([
      allCategories(req.tenant.id),
      supabase.from('bg_menu_items').select('id, category_id').eq('tenant_id', req.tenant.id),
    ]);
    if (items.error) throw items.error;
    const count = new Map();
    for (const i of items.data || []) count.set(i.category_id, (count.get(i.category_id) || 0) + 1);
    const list = cats.sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id)).map((c) => categoryView(c, count.get(c.id)));
    res.json({ categories: list, languages: req.tenant.languages, default_lang: req.tenant.defaultLang });
  }));

  router.post('/categories', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const label = mergeMap(b.label, {}, req.tenant, { label: 'Category name', max: 60, required: true });
    if (label.error) return res.status(400).json(label);

    let key = typeof b.key === 'string' && b.key.trim() ? b.key.trim().toLowerCase() : (slug(label.value[req.tenant.defaultLang]) || `cat-${crypto.randomBytes(3).toString('hex')}`);
    if (key.length > 40 || !KEY_RE.test(key)) return res.status(400).json({ error: 'Key may only use lowercase letters, numbers, hyphens and underscores (40 characters at most)' });

    const existing = await allCategories(req.tenant.id);
    if (existing.some((c) => c.key === key)) return res.status(409).json({ error: 'A category with this key already exists' });
    let sort = nextSort(existing);
    if (b.sort_order !== undefined && b.sort_order !== '') {
      sort = toInt(b.sort_order);
      if (sort === null || Math.abs(sort) > 1000000) return res.status(400).json({ error: 'Sort order must be a whole number' });
    }
    const { data, error } = await supabase.from('bg_categories').insert({ tenant_id: req.tenant.id, key, label: label.value, sort_order: sort }).select('id, key, label, sort_order').single();
    if (error) { if (duplicate(error)) return res.status(409).json({ error: 'A category with this key already exists' }); throw error; }
    onMenuChanged(req.tenant.id);
    res.status(201).json({ category: categoryView(data, 0) });
  }));

  router.patch('/categories/:id', asyncHandler(async (req, res) => {
    const id = idParam(req, res); if (id === null) return;
    const row = await getCategory(req.tenant.id, id);
    if (!row) return res.status(404).json({ error: 'Category not found' });
    const b = req.body || {};
    const u = {};
    if (b.label !== undefined) {
      const label = mergeMap(b.label, row.label, req.tenant, { label: 'Category name', max: 60, required: true });
      if (label.error) return res.status(400).json(label);
      u.label = label.value;
    }
    if (b.key !== undefined) {
      const key = String(b.key || '').trim().toLowerCase();
      if (key.length > 40 || !KEY_RE.test(key)) return res.status(400).json({ error: 'Key may only use lowercase letters, numbers, hyphens and underscores (40 characters at most)' });
      if (key !== row.key) {
        if ((await allCategories(req.tenant.id)).some((c) => c.key === key)) return res.status(409).json({ error: 'A category with this key already exists' });
        u.key = key;
      }
    }
    if (b.sort_order !== undefined) {
      const n = toInt(b.sort_order);
      if (n === null || Math.abs(n) > 1000000) return res.status(400).json({ error: 'Sort order must be a whole number' });
      u.sort_order = n;
    }
    if (!Object.keys(u).length) return res.status(400).json({ error: 'Nothing to change' });
    const { error } = await supabase.from('bg_categories').update(u).eq('tenant_id', req.tenant.id).eq('id', id);
    if (error) { if (duplicate(error)) return res.status(409).json({ error: 'A category with this key already exists' }); throw error; }
    onMenuChanged(req.tenant.id);
    res.json({ category: categoryView({ ...row, ...u }) });
  }));

  router.delete('/categories/:id', asyncHandler(async (req, res) => {
    const id = idParam(req, res); if (id === null) return;
    if (!(await getCategory(req.tenant.id, id))) return res.status(404).json({ error: 'Category not found' });
    const { data: used, error: uErr } = await supabase.from('bg_menu_items').select('id').eq('tenant_id', req.tenant.id).eq('category_id', id).limit(1);
    if (uErr) throw uErr;
    if ((used || []).length) return res.status(409).json({ error: 'Move or delete this category\'s dishes first' });
    const { error } = await supabase.from('bg_categories').delete().eq('tenant_id', req.tenant.id).eq('id', id);
    if (error) throw error;
    onMenuChanged(req.tenant.id);
    res.json({ ok: true });
  }));

  // ---- items -----------------------------------------------------------------------------
  router.get('/items', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('bg_menu_items').select('*').eq('tenant_id', req.tenant.id).order('sort_order', { ascending: true });
    if (error) throw error;
    res.json({ items: (data || []).sort((a, b) => ((a.sort_order || 0) - (b.sort_order || 0)) || (a.id - b.id)).map(itemView) });
  }));

  async function categoryId(req, value) {
    const id = toInt(value);
    if (id === null || id <= 0 || !(await getCategory(req.tenant.id, id))) return null;
    return id;
  }

  router.post('/items', asyncHandler(async (req, res) => {
    const r = itemColumns(req.body, req.tenant, null);
    if (r.error) return res.status(400).json(r);
    const cat = await categoryId(req, (req.body || {}).category_id);
    if (cat === null) return res.status(400).json({ error: 'Choose a category from this restaurant' });
    const values = r.values;
    if (values.sort_order === undefined) {
      const { data, error } = await supabase.from('bg_menu_items').select('id, sort_order').eq('tenant_id', req.tenant.id);
      if (error) throw error;
      values.sort_order = nextSort(data || []);
    }
    const { data, error } = await supabase.from('bg_menu_items').insert({ tenant_id: req.tenant.id, category_id: cat, description: {}, ...values }).select('*').single();
    if (error) throw error;
    onMenuChanged(req.tenant.id);
    res.status(201).json({ item: itemView(data) });
  }));

  router.patch('/items/:id', asyncHandler(async (req, res) => {
    const id = idParam(req, res); if (id === null) return;
    const row = await getItem(req.tenant.id, id);
    if (!row) return res.status(404).json({ error: 'Dish not found' });
    const r = itemColumns(req.body, req.tenant, row);
    if (r.error) return res.status(400).json(r);
    const values = r.values;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'category_id')) {
      const cat = await categoryId(req, req.body.category_id);
      if (cat === null) return res.status(400).json({ error: 'Choose a category from this restaurant' });
      values.category_id = cat;
    }
    const { error } = await supabase.from('bg_menu_items').update(values).eq('tenant_id', req.tenant.id).eq('id', id);
    if (error) throw error;
    onMenuChanged(req.tenant.id);
    res.json({ item: itemView({ ...row, ...values }) });
  }));

  router.delete('/items/:id', asyncHandler(async (req, res) => {
    const id = idParam(req, res); if (id === null) return;
    if (!(await getItem(req.tenant.id, id))) return res.status(404).json({ error: 'Dish not found' });
    const { error } = await supabase.from('bg_menu_items').delete().eq('tenant_id', req.tenant.id).eq('id', id);
    if (error) throw error;
    onMenuChanged(req.tenant.id);
    res.json({ ok: true });
  }));

  // One picture for a dish (main photo, card background or food PNG). The browser then saves the returned link on the dish.
  router.post('/items/image', (req, res, next) => upload.single('image')(req, res, (err) => {
    if (!err) return next();
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'The image must be smaller than 5 MB' : 'Upload a single image in the "image" field' });
  }), asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose an image to upload' });
    const kind = sniffImage(req.file.buffer);
    if (!kind) return res.status(400).json({ error: 'Choose a JPEG, PNG, WebP or GIF image' });
    const objectPath = `${req.tenant.id}/items/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${kind.ext}`;
    const store = supabase.storage.from(IMAGE_BUCKET);
    const { error } = await store.upload(objectPath, req.file.buffer, { contentType: kind.type, cacheControl: '31536000' });
    if (error) {
      console.error(`[${req.tenant.slug}] image upload failed:`, error.message);
      return res.status(502).json({ error: 'Could not reach the "menu" storage bucket. Check that it exists and is public.' });
    }
    res.status(201).json({ url: store.getPublicUrl(objectPath).data.publicUrl });
  }));

  return router;
}

module.exports = { createMenuAdminRouter, itemColumns, sniffImage, IMAGE_BUCKET };
