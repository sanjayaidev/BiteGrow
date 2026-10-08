'use strict';
// Menu CSV import/export for one restaurant.
//
// Columns (header names are case-insensitive, order does not matter):
//   category*   name*   price*   description   calories   rating   is_offer   is_available   sort_order
//   image_url   bg_image_url   food_png_url   model_url
//   name_<lang>  description_<lang>   one pair per extra language the restaurant has enabled (e.g. name_ar)
// Rows are matched to existing items by name (default language, case-insensitive): a match is
// updated, anything else is created. Categories are matched by key or name and created when new.
// The whole file is validated first; if any row is bad nothing is written.

const { parseCsvObjects, toCsv } = require('./csv');
const { pick } = require('../render');

const MAX_ROWS = 2000;
const BASE_COLS = ['category', 'name', 'description', 'price', 'calories', 'rating', 'is_offer', 'is_available',
  'sort_order', 'image_url', 'bg_image_url', 'food_png_url', 'model_url'];
const URL_COLS = ['image_url', 'bg_image_url', 'food_png_url', 'model_url'];

const slug = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const BOOL_TRUE = new Set(['1', 'true', 'yes', 'y']);
const BOOL_FALSE = new Set(['0', 'false', 'no', 'n']);

function parseBool(v, dflt) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '') return { value: dflt };
  if (BOOL_TRUE.has(s)) return { value: true };
  if (BOOL_FALSE.has(s)) return { value: false };
  return { error: true };
}

// https URLs, or paths inside the site (img/a.png, /img/a.png). Never javascript:, data:, http:, //host, ../ or
// anything containing a quote, angle bracket, backtick or backslash (those could break out of an HTML attribute).
const BAD_URL_CHARS = /[\s"'<>`\\]/;
function okUrl(u) {
  if (typeof u !== 'string' || !u || u.length > 600 || BAD_URL_CHARS.test(u)) return false;
  if (/^https:\/\//i.test(u)) {
    try { const p = new URL(u); return p.protocol === 'https:' && !!p.hostname && !p.username && !p.password; } catch (e) { return false; }
  }
  if (u.startsWith('//') || u.split('/').includes('..')) return false;
  return /^(?!.*:)[\w\-./%]+$/.test(u);
}

function templateCsv(tenant) {
  const extra = tenant.languages.filter((l) => l !== tenant.defaultLang);
  const headers = [...BASE_COLS, ...extra.flatMap((l) => [`name_${l}`, `description_${l}`])];
  const sample = {
    category: 'Snacks', name: 'Veg Samosa', description: 'Crispy pastry with spiced potato', price: '40',
    calories: '260', rating: '4.6', is_offer: 'no', is_available: 'yes', sort_order: '1',
  };
  return toCsv(headers, [sample]);
}

// Validates parsed CSV against what the restaurant already has. Pure: no database access.
function planImport(text, tenant, existing) {
  let parsed;
  try { parsed = parseCsvObjects(text); } catch (e) { return { errors: [{ line: 1, message: e.message }] }; }
  const { headers, records } = parsed;
  const errors = [];
  for (const need of ['category', 'name', 'price']) {
    if (!headers.includes(need)) errors.push({ line: 1, message: `Missing required column "${need}"` });
  }
  if (errors.length) return { errors };
  if (!records.length) return { errors: [{ line: 1, message: 'The file has no menu rows' }] };
  if (records.length > MAX_ROWS) return { errors: [{ line: 1, message: `At most ${MAX_ROWS} rows per file` }] };

  const langs = tenant.languages.filter((l) => l !== tenant.defaultLang);
  const catByKey = new Map(existing.categories.map((c) => [c.key, c]));
  const catByName = new Map(existing.categories.map((c) => [pick(c.label, tenant.defaultLang, tenant.defaultLang).toLowerCase(), c]));
  const itemByName = new Map(existing.items.map((i) => [pick(i.name, tenant.defaultLang, tenant.defaultLang).toLowerCase(), i]));

  const newCats = new Map();       // key -> { key, label }
  const seen = new Set();
  const rows = [];

  for (const r of records) {
    const err = (message) => errors.push({ line: r.__line, message });
    const name = r.name;
    if (!name) { err('Name is required'); continue; }
    if (name.length > 120) { err('Name is longer than 120 characters'); continue; }
    const lname = name.toLowerCase();
    if (seen.has(lname)) { err(`"${name}" appears more than once in the file`); continue; }
    seen.add(lname);

    if (!r.category) { err('Category is required'); continue; }
    const price = Number(r.price);
    if (r.price === '' || !Number.isFinite(price) || price < 0 || price > 99999999) { err('Price must be a number, 0 or more'); continue; }
    if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) { err('Price can have at most 2 decimals'); continue; }

    let calories = null;
    if (r.calories) {
      calories = Number(r.calories);
      if (!Number.isInteger(calories) || calories < 0 || calories > 20000) { err('Calories must be a whole number'); continue; }
    }
    let rating = null;
    if (r.rating) {
      rating = Number(r.rating);
      if (!Number.isFinite(rating) || rating < 0 || rating > 5) { err('Rating must be between 0 and 5'); continue; }
      rating = Math.round(rating * 10) / 10;
    }
    let sort = null;
    if (r.sort_order) {
      sort = Number(r.sort_order);
      if (!Number.isInteger(sort) || Math.abs(sort) > 1e6) { err('Sort order must be a whole number'); continue; }
    }
    const offer = parseBool(r.is_offer, false);
    const avail = parseBool(r.is_available, true);
    if (offer.error) { err('is_offer must be yes or no'); continue; }
    if (avail.error) { err('is_available must be yes or no'); continue; }

    let badUrl = false;
    const urls = {};
    for (const c of URL_COLS) {
      if (!r[c]) continue;
      if (!okUrl(r[c])) { err(`${c} must be an https link or a path like img/photo.png`); badUrl = true; break; }
      urls[c] = r[c];
    }
    if (badUrl) continue;
    if (urls.model_url && !/\.glb(\?|$)/i.test(urls.model_url)) { err('model_url must point to a .glb file'); continue; }

    // Category: existing key, existing name, or a new one.
    const k = slug(r.category);
    let cat = catByKey.get(r.category.toLowerCase()) || catByKey.get(k) || catByName.get(r.category.toLowerCase());
    let catKey;
    if (cat) catKey = cat.key;
    else {
      if (!k || !/^[a-z0-9]/.test(k)) { err('Category name needs letters or numbers'); continue; }
      catKey = k;
      if (!newCats.has(k)) newCats.set(k, { key: k, label: { [tenant.defaultLang]: r.category } });
    }

    const nameMap = { [tenant.defaultLang]: name };
    const descMap = r.description ? { [tenant.defaultLang]: r.description.slice(0, 600) } : {};
    for (const l of langs) {
      if (r[`name_${l}`]) nameMap[l] = r[`name_${l}`].slice(0, 120);
      if (r[`description_${l}`]) descMap[l] = r[`description_${l}`].slice(0, 600);
    }

    const prev = itemByName.get(lname);
    rows.push({
      line: r.__line, catKey, existingId: prev ? prev.id : null,
      values: {
        name: prev ? { ...prev.name, ...nameMap } : nameMap,
        description: prev ? { ...prev.description, ...descMap } : descMap,
        price: Math.round(price * 100) / 100,
        is_offer: offer.value,
        is_available: avail.value,
        ...(calories !== null ? { calories } : {}),
        ...(rating !== null ? { rating } : {}),
        ...(sort !== null ? { sort_order: sort } : {}),
        ...Object.fromEntries(Object.entries(urls)),
      },
    });
  }

  if (errors.length) return { errors };
  return {
    errors: [],
    rows,
    newCategories: [...newCats.values()],
    summary: {
      rows: rows.length,
      created: rows.filter((r) => !r.existingId).length,
      updated: rows.filter((r) => r.existingId).length,
      categories_created: newCats.size,
    },
  };
}

async function loadExisting(supabase, tenantId) {
  const [cats, items] = await Promise.all([
    supabase.from('bg_categories').select('id, key, label, sort_order').eq('tenant_id', tenantId),
    supabase.from('bg_menu_items').select('id, name, description').eq('tenant_id', tenantId),
  ]);
  for (const r of [cats, items]) if (r.error) throw r.error;
  return { categories: cats.data || [], items: items.data || [] };
}

async function applyImport(supabase, tenant, plan, existing) {
  const tenantId = tenant.id;
  const idByKey = new Map(existing.categories.map((c) => [c.key, c.id]));
  const maxSort = existing.categories.reduce((m, c) => Math.max(m, c.sort_order || 0), 0);

  if (plan.newCategories.length) {
    const { data, error } = await supabase.from('bg_categories')
      .insert(plan.newCategories.map((c, n) => ({ tenant_id: tenantId, key: c.key, label: c.label, sort_order: maxSort + n + 1 })))
      .select('id, key');
    if (error) throw error;
    for (const c of data) idByKey.set(c.key, c.id);
  }

  const inserts = [];
  for (const r of plan.rows) {
    const category_id = idByKey.get(r.catKey);
    if (!category_id) throw new Error(`Category "${r.catKey}" could not be resolved (row ${r.line})`);
    if (r.existingId) {
      const { error } = await supabase.from('bg_menu_items').update({ ...r.values, category_id })
        .eq('tenant_id', tenantId).eq('id', r.existingId);
      if (error) throw error;
    } else {
      inserts.push({ tenant_id: tenantId, category_id, ...r.values });
    }
  }
  if (inserts.length) {
    const { error } = await supabase.from('bg_menu_items').insert(inserts);
    if (error) throw error;
  }
}

async function exportCsv(supabase, tenant) {
  const [cats, items] = await Promise.all([
    supabase.from('bg_categories').select('id, key, label').eq('tenant_id', tenant.id),
    supabase.from('bg_menu_items').select('*').eq('tenant_id', tenant.id).order('sort_order', { ascending: true }),
  ]);
  for (const r of [cats, items]) if (r.error) throw r.error;
  const catName = new Map((cats.data || []).map((c) => [c.id, pick(c.label, tenant.defaultLang, tenant.defaultLang) || c.key]));
  const extra = tenant.languages.filter((l) => l !== tenant.defaultLang);
  const headers = [...BASE_COLS, ...extra.flatMap((l) => [`name_${l}`, `description_${l}`])];
  const yn = (b) => (b ? 'yes' : 'no');
  const rows = (items.data || []).map((i) => ({
    category: catName.get(i.category_id) || '',
    name: pick(i.name, tenant.defaultLang, tenant.defaultLang),
    description: pick(i.description, tenant.defaultLang, tenant.defaultLang),
    price: Number(i.price).toFixed(2),
    calories: i.calories == null ? '' : i.calories,
    rating: i.rating == null ? '' : i.rating,
    is_offer: yn(i.is_offer), is_available: yn(i.is_available), sort_order: i.sort_order,
    image_url: i.image_url || '', bg_image_url: i.bg_image_url || '', food_png_url: i.food_png_url || '', model_url: i.model_url || '',
    ...Object.fromEntries(extra.flatMap((l) => [[`name_${l}`, (i.name || {})[l] || ''], [`description_${l}`, (i.description || {})[l] || '']])),
  }));
  return toCsv(headers, rows);
}

module.exports = { templateCsv, planImport, loadExisting, applyImport, exportCsv, MAX_ROWS, okUrl, slug };
