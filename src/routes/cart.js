'use strict';
// A signed-in customer's basket, saved on the server so it follows them across
// devices. Guests keep their basket in the browser and fold it in with
// POST /merge right after they sign in. The basket is per restaurant: the same
// customer has a separate one at each.

const express = require('express');
const { pick } = require('../render');
const { MAX_QTY, toCents, fromCents, toInt, normalizeLines, fetchAvailableItems } = require('../lib/orderMath');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createCartRouter({ supabase, auth }) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(auth.requireAuth);

  const langOf = (req) => {
    const q = typeof req.query.lang === 'string' ? req.query.lang.toLowerCase() : '';
    return req.tenant.languages.includes(q) ? q : req.tenant.defaultLang;
  };

  const mine = (req) => ({ tenant_id: req.tenant.id, user_id: req.authUser.id });

  // The basket with live names and prices. Lines whose item was hidden or sold out since are kept (available:false) so the page can offer to remove them.
  async function readCart(req) {
    const { data: rows, error } = await supabase.from('bg_cart_items')
      .select('menu_item_id, quantity')
      .eq('tenant_id', req.tenant.id).eq('user_id', req.authUser.id)
      .order('updated_at', { ascending: true });
    if (error) throw error;

    const ids = (rows || []).map((r) => r.menu_item_id);
    const { data: items, error: iErr } = ids.length
      ? await supabase.from('bg_menu_items').select('id, name, price, image_url, is_available')
        .eq('tenant_id', req.tenant.id).in('id', ids)
      : { data: [], error: null };
    if (iErr) throw iErr;

    const byId = new Map((items || []).map((i) => [i.id, i]));
    const lang = langOf(req);
    let cents = 0;
    let count = 0;
    const lines = (rows || []).map((r) => {
      const it = byId.get(r.menu_item_id);
      const available = !!(it && it.is_available);
      if (available) { cents += toCents(it.price) * r.quantity; count += r.quantity; }
      return {
        menu_item_id: r.menu_item_id,
        quantity: r.quantity,
        name: it ? pick(it.name, lang, req.tenant.defaultLang) : '',
        price: it ? Number(it.price) : 0,
        image_url: it ? it.image_url : null,
        available,
      };
    });
    return { items: lines, count, subtotal: fromCents(cents) };
  }

  router.get('/', asyncHandler(async (req, res) => { res.json(await readCart(req)); }));

  // Set one line's quantity (0 removes it).
  router.post('/', asyncHandler(async (req, res) => {
    const id = toInt(req.body.menu_item_id);
    const qty = toInt(req.body.quantity);
    if (id === null || id <= 0) return res.status(400).json({ error: 'Invalid menu item' });
    if (qty === null || qty < 0 || qty > MAX_QTY) return res.status(400).json({ error: `Quantity must be between 0 and ${MAX_QTY}` });

    if (qty === 0) {
      const { error } = await supabase.from('bg_cart_items').delete().match({ ...mine(req), menu_item_id: id });
      if (error) throw error;
      return res.json(await readCart(req));
    }

    const available = await fetchAvailableItems(supabase, req.tenant.id, [id]);
    if (!available.has(id)) return res.status(404).json({ error: 'This item is not available' });

    const { error } = await supabase.from('bg_cart_items').upsert(
      { ...mine(req), menu_item_id: id, quantity: qty, updated_at: new Date().toISOString() },
      { onConflict: 'tenant_id,user_id,menu_item_id' });
    if (error) throw error;
    res.json(await readCart(req));
  }));

  // Fold a guest basket into the account: adds on top of what is already saved, never overwrites.
  router.post('/merge', asyncHandler(async (req, res) => {
    const { lines, error: bad } = normalizeLines(req.body.items, { allowEmpty: true });
    if (bad) return res.status(400).json({ error: bad });

    if (lines.length) {
      const available = await fetchAvailableItems(supabase, req.tenant.id, lines.map((l) => l.id));
      const wanted = lines.filter((l) => available.has(l.id));
      if (wanted.length) {
        const { data: existing, error: eErr } = await supabase.from('bg_cart_items')
          .select('menu_item_id, quantity')
          .eq('tenant_id', req.tenant.id).eq('user_id', req.authUser.id)
          .in('menu_item_id', wanted.map((l) => l.id));
        if (eErr) throw eErr;
        const have = new Map((existing || []).map((r) => [r.menu_item_id, r.quantity]));
        const now = new Date().toISOString();
        const rows = wanted.map((l) => ({
          ...mine(req), menu_item_id: l.id, quantity: Math.min(MAX_QTY, (have.get(l.id) || 0) + l.qty), updated_at: now,
        }));
        const { error } = await supabase.from('bg_cart_items').upsert(rows, { onConflict: 'tenant_id,user_id,menu_item_id' });
        if (error) throw error;
      }
    }
    res.json(await readCart(req));
  }));

  router.delete('/:menuItemId', asyncHandler(async (req, res) => {
    const id = toInt(req.params.menuItemId);
    if (id === null || id <= 0) return res.status(400).json({ error: 'Invalid menu item' });
    const { error } = await supabase.from('bg_cart_items').delete().match({ ...mine(req), menu_item_id: id });
    if (error) throw error;
    res.json(await readCart(req));
  }));

  router.delete('/', asyncHandler(async (req, res) => {
    const { error } = await supabase.from('bg_cart_items').delete().match(mine(req));
    if (error) throw error;
    res.json(await readCart(req));
  }));

  return router;
}

module.exports = { createCartRouter };
