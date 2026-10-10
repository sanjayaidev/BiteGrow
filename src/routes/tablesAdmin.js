'use strict';
// Dine-in tables and their QR codes. Mounted by admin.js, so every route has already passed
// requireStaff(['owner', 'admin']) for req.tenant, and every query below is filtered by that tenant.
//
//   GET    /api/admin/tables            all tables, each with the address its QR code opens (?qr=1 adds the images)
//   POST   /api/admin/tables            { label }  or  { from, to, prefix? } to add a numbered range at once
//   PATCH  /api/admin/tables/:id        { label?, is_active? }  renaming keeps the same QR code
//   DELETE /api/admin/tables/:id        past orders keep their own table name
//   GET    /api/admin/tables/:id/qr.svg the QR code as an SVG image
//
// A table's QR code opens the storefront with ?table=<token>. Once a restaurant has any table here, checkout
// only accepts those tables; with none, customers type their own table number (see routes/orders.js).

const express = require('express');
const QRCode = require('qrcode');
const { toInt } = require('../lib/orderMath');

const MAX_LABEL = 20;        // the same cap checkout puts on a typed table number
const MAX_RANGE = 100;       // tables added by one request
const MAX_TABLES = 500;      // per restaurant
const COLS = 'id, label, token, is_active';

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const tidy = (v) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');

function createTablesRouter({ supabase }) {
  const router = express.Router();

  const origin = (req) => `${req.protocol}://${req.get('host')}`;
  const urlFor = (req, t) => `${origin(req)}/?table=${t.token}`;
  const view = (req, t) => ({ id: t.id, label: t.label, token: t.token, is_active: !!t.is_active, url: urlFor(req, t) });

  async function loadAll(tenantId) {
    const { data, error } = await supabase.from('bg_dining_tables').select(COLS).eq('tenant_id', tenantId).order('id', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function loadOne(req, res) {
    const id = toInt(req.params.id);
    if (id === null || id <= 0) { res.status(400).json({ error: 'Invalid table' }); return null; }
    const { data, error } = await supabase.from('bg_dining_tables').select(COLS).eq('tenant_id', req.tenant.id).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) { res.status(404).json({ error: 'Table not found' }); return null; }
    return data;
  }

  // A clash is judged ignoring capital letters, because checkout matches typed table names that way.
  const clash = (rows, label, exceptId) => rows.some((t) => t.id !== exceptId && String(t.label).toLowerCase() === label.toLowerCase());
  const labelError = (label) => (!label ? 'Give the table a name or number' : label.length > MAX_LABEL ? `Table names can be at most ${MAX_LABEL} characters` : null);

  const qrSvg = (req, t) => QRCode.toString(urlFor(req, t), { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });

  // ?qr=1 adds each table's QR code as "qr_svg", so the page can print them all with one request.
  router.get('/', asyncHandler(async (req, res) => {
    const rows = await loadAll(req.tenant.id);
    const tables = rows.map((t) => view(req, t));
    if (req.query.qr === '1') await Promise.all(tables.map(async (t, i) => { t.qr_svg = await qrSvg(req, rows[i]); }));
    res.json({ tables });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const existing = await loadAll(req.tenant.id);

    if (b.label !== undefined) {
      const label = tidy(b.label);
      const bad = labelError(label);
      if (bad) return res.status(400).json({ error: bad });
      if (existing.length >= MAX_TABLES) return res.status(400).json({ error: `A restaurant can have at most ${MAX_TABLES} tables` });
      if (clash(existing, label)) return res.status(409).json({ error: 'A table with that name already exists' });
      const { data, error } = await supabase.from('bg_dining_tables').insert({ tenant_id: req.tenant.id, label }).select(COLS).single();
      if (error) {
        if (error.code === '23505') return res.status(409).json({ error: 'A table with that name already exists' });
        throw error;
      }
      return res.status(201).json({ table: view(req, data) });
    }

    // A numbered range, e.g. tables 1 to 20, or T1 to T12 with prefix "T". Names already in use are skipped.
    const from = toInt(b.from); const to = toInt(b.to);
    if (from === null || to === null || from < 0 || to > 99999 || to < from) {
      return res.status(400).json({ error: 'Give a table name, or the first and last table number' });
    }
    if (to - from + 1 > MAX_RANGE) return res.status(400).json({ error: `Add at most ${MAX_RANGE} tables at a time` });
    const rawPrefix = b.prefix === undefined || b.prefix === null ? '' : b.prefix;
    if (typeof rawPrefix !== 'string') return res.status(400).json({ error: 'Prefix must be text' });
    const prefix = tidy(rawPrefix);

    const wanted = [];
    for (let n = from; n <= to; n++) wanted.push(`${prefix}${n}`);
    const tooLong = wanted.find((l) => l.length > MAX_LABEL);
    if (tooLong) return res.status(400).json({ error: `Table names can be at most ${MAX_LABEL} characters` });

    const skipped = wanted.filter((l) => clash(existing, l));
    const fresh = wanted.filter((l) => !skipped.includes(l));
    if (existing.length + fresh.length > MAX_TABLES) return res.status(400).json({ error: `A restaurant can have at most ${MAX_TABLES} tables` });
    if (!fresh.length) return res.json({ created: [], skipped });

    const { data, error } = await supabase.from('bg_dining_tables')
      .insert(fresh.map((label) => ({ tenant_id: req.tenant.id, label }))).select(COLS);
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Some of those tables already exist. Refresh and try again.' });
      throw error;
    }
    res.status(201).json({ created: (data || []).map((t) => view(req, t)), skipped });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const table = await loadOne(req, res); if (!table) return;
    const b = req.body || {};
    const u = {};
    if (b.label !== undefined) {
      const label = tidy(b.label);
      const bad = labelError(label);
      if (bad) return res.status(400).json({ error: bad });
      if (clash(await loadAll(req.tenant.id), label, table.id)) return res.status(409).json({ error: 'A table with that name already exists' });
      u.label = label;
    }
    if (b.is_active !== undefined) {
      if (typeof b.is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be true or false' });
      u.is_active = b.is_active;
    }
    if (!Object.keys(u).length) return res.status(400).json({ error: 'Nothing to change' });

    const { data, error } = await supabase.from('bg_dining_tables').update(u)
      .eq('tenant_id', req.tenant.id).eq('id', table.id).select(COLS).maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'A table with that name already exists' });
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Table not found' });
    res.json({ table: view(req, data) });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const table = await loadOne(req, res); if (!table) return;
    const { error } = await supabase.from('bg_dining_tables').delete().eq('tenant_id', req.tenant.id).eq('id', table.id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  router.get('/:id/qr.svg', asyncHandler(async (req, res) => {
    const table = await loadOne(req, res); if (!table) return;
    res.type('image/svg+xml').send(await qrSvg(req, table));
  }));

  return router;
}

module.exports = { createTablesRouter, MAX_LABEL, MAX_RANGE, MAX_TABLES };
