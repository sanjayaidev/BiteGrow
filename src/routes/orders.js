'use strict';
// Placing and looking up orders: dine-in (table), pickup and delivery.
//
//   POST /api/orders              guest or signed in; price-checked on the server
//   GET  /api/orders/:number      order number + the secret token from creation, or the owner, or staff
//   GET  /api/table/:token        what a table's QR code points at -> the table label
//
// Rules that hold for every order:
//   * only this restaurant's available items can be ordered; ids from another
//     restaurant are rejected, never priced;
//   * names and prices are read from the database, never from the browser;
//   * totals are computed in whole cents, delivery fee comes from the restaurant's settings;
//   * orders start unpaid (no payment is taken here).

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { pick } = require('../render');
const { toCents, fromCents, normalizeLines, fetchAvailableItems } = require('../lib/orderMath');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^[0-9+()\-\s]{7,20}$/;
const ORDER_NUMBER_RE = /^[A-Z0-9]{2,6}-\d{6}-\d{4,}$/;
const TABLE_TOKEN_RE = /^[0-9a-f]{8,64}$/;
const TYPE_LABEL = { dine_in: 'Dine-in', pickup: 'Pickup', delivery: 'Delivery' };

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// The message a customer sends to the restaurant's WhatsApp number. Built here so its format lives in one place.
function whatsappUrl(tenant, order, details) {
  const s = tenant.settings;
  const number = String(s.whatsappNumber || '').replace(/\D/g, '');
  if (!number || !(s.features && s.features.whatsappOrder)) return null;
  const sym = tenant.currencySymbol;
  const m = (c) => `${sym}${(c / 100).toFixed(2)}`;
  const lines = [
    `${s.brandName} - order ${order.order_number}`,
    `Type: ${TYPE_LABEL[details.orderType]}${details.tableLabel ? ` (table ${details.tableLabel})` : ''}`,
    `Name: ${details.name}`,
    ...(details.phone ? [`Phone: ${details.phone}`] : []),
    ...(details.address ? [`Address: ${details.address}`] : []),
    '',
    ...details.items.map((i) => `${i.quantity} x ${i.name} - ${m(i.lineCents)}`),
    '',
    `Subtotal: ${m(details.subtotalCents)}`,
    ...(details.feeCents ? [`Delivery: ${m(details.feeCents)}`] : []),
    `Total: ${m(details.totalCents)}`,
    ...(details.notes ? ['', `Notes: ${details.notes}`] : []),
  ];
  return `https://wa.me/${number}?text=${encodeURIComponent(lines.join('\n'))}`;
}

function createOrdersRouter({ supabase, auth, createLimit = 20, lookupLimit = 60 }) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  const limiter = (limit, message) => rateLimit({
    windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false, message: { error: message },
  });
  const createLimiter = limiter(createLimit, 'Too many orders from this connection. Please wait a while and try again.');
  const lookupLimiter = limiter(lookupLimit, 'Too many requests. Please wait a while and try again.');

  // The table for a dine-in order: from the QR token, or a typed number when the restaurant has no table list.
  async function resolveTable(tenantId, body) {
    const { data, error } = await supabase.from('bg_dining_tables')
      .select('label, token').eq('tenant_id', tenantId).eq('is_active', true);
    if (error) throw error;
    const tables = data || [];

    if (typeof body.table_token === 'string' && body.table_token) {
      const t = tables.find((x) => x.token === body.table_token);
      return t ? { label: t.label } : { error: 'This table code is not valid' };
    }
    const label = clean(body.table_label, 20);
    if (!label) return { error: 'Table number is required for dine-in' };
    if (!tables.length) return { label };
    const t = tables.find((x) => x.label.toLowerCase() === label.toLowerCase());
    return t ? { label: t.label } : { error: 'Unknown table' };
  }

  router.post('/orders', createLimiter, asyncHandler(async (req, res) => {
    const tenant = req.tenant;
    const b = req.body || {};

    const orderType = b.order_type;
    if (!['dine_in', 'pickup', 'delivery'].includes(orderType) || !tenant.settings.orderTypes.includes(orderType)) {
      return res.status(400).json({ error: 'This order type is not available' });
    }

    const name = clean(b.customer_name, 80);
    const phone = clean(b.customer_phone, 20);
    const address = clean(b.delivery_address, 300);
    const notes = clean(b.notes, 300);
    const email = clean(b.customer_email, 254);

    if (!name) return res.status(400).json({ error: 'Your name is required' });
    if (orderType !== 'dine_in' && !phone) return res.status(400).json({ error: 'A phone number is required' });
    if (phone && !PHONE_RE.test(phone)) return res.status(400).json({ error: 'That phone number does not look right' });
    if (orderType === 'delivery' && !address) return res.status(400).json({ error: 'A delivery address is required' });
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'That email does not look right' });

    const { lines, error: badLines } = normalizeLines(b.items);
    if (badLines) return res.status(400).json({ error: badLines });

    // A token that is sent but wrong is an error (the page should refresh the session), not a silent guest order.
    let user = null;
    if (req.get('authorization')) {
      user = await auth.getAuthUser(req);
      if (!user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }

    let tableLabel = null;
    if (orderType === 'dine_in') {
      const t = await resolveTable(tenant.id, b);
      if (t.error) return res.status(400).json({ error: t.error });
      tableLabel = t.label;
    }

    const menu = await fetchAvailableItems(supabase, tenant.id, lines.map((l) => l.id));
    const gone = lines.filter((l) => !menu.has(l.id)).map((l) => l.id);
    if (gone.length) return res.status(400).json({ error: 'Some items are no longer available', unavailable: gone });

    let subtotalCents = 0;
    const items = lines.map((l) => {
      const row = menu.get(l.id);
      const unitCents = toCents(row.price);
      const lineCents = unitCents * l.qty;
      subtotalCents += lineCents;
      return { id: l.id, name: pick(row.name, tenant.defaultLang, tenant.defaultLang), quantity: l.qty, unitCents, lineCents };
    });
    const feeCents = orderType === 'delivery' ? toCents(tenant.settings.deliveryFee) : 0;
    const totalCents = subtotalCents + feeCents;

    const { data: order, error: oErr } = await supabase.from('bg_orders').insert({
      tenant_id: tenant.id,
      user_id: user ? user.id : null,
      order_type: orderType,
      table_label: tableLabel,
      customer_name: name,
      customer_phone: phone || null,
      customer_email: email || (user && user.email) || null,
      delivery_address: orderType === 'delivery' ? address : null,
      status: 'pending',
      payment_status: 'unpaid',
      channel: 'web',
      subtotal: fromCents(subtotalCents),
      delivery_fee: fromCents(feeCents),
      total: fromCents(totalCents),
      notes: notes || null,
    }).select('id, order_number, order_token, status, payment_status').single();
    if (oErr) throw oErr;

    const { error: iErr } = await supabase.from('bg_order_items').insert(items.map((i) => ({
      tenant_id: tenant.id,
      order_id: order.id,
      menu_item_id: i.id,
      name_snapshot: i.name,
      unit_price: fromCents(i.unitCents),
      quantity: i.quantity,
      line_total: fromCents(i.lineCents),
    })));
    if (iErr) {
      // No transaction across two inserts here, so take the header back out rather than leave an empty order in the kitchen's list.
      const { error: rErr } = await supabase.from('bg_orders').delete().eq('tenant_id', tenant.id).eq('id', order.id);
      if (rErr) console.error(`[${tenant.slug}] could not roll back order ${order.order_number}:`, rErr.message);
      throw iErr;
    }

    // A signed-in customer's saved basket at THIS restaurant has just become an order.
    if (user) {
      const { error: cErr } = await supabase.from('bg_cart_items').delete().eq('tenant_id', tenant.id).eq('user_id', user.id);
      if (cErr) console.error(`[${tenant.slug}] could not clear cart after order:`, cErr.message);
    }

    res.status(201).json({
      order_number: order.order_number,
      order_token: order.order_token,           // shown once; the only way for a guest to look this order up again
      order_type: orderType,
      table_label: tableLabel,
      subtotal: fromCents(subtotalCents),
      delivery_fee: fromCents(feeCents),
      total: fromCents(totalCents),
      currency: tenant.currency,
      status: order.status,
      payment_status: order.payment_status,
      whatsapp_url: whatsappUrl(tenant, order, {
        orderType, tableLabel, name, phone, address: orderType === 'delivery' ? address : '', notes,
        items, subtotalCents, feeCents, totalCents,
      }),
    });
  }));

  // Order numbers are guessable (RH-261007-0042), so seeing an order needs the token from creation, being its owner, or staff here.
  router.get('/orders/:number', lookupLimiter, asyncHandler(async (req, res) => {
    const number = String(req.params.number || '').toUpperCase();
    if (!ORDER_NUMBER_RE.test(number)) return res.status(404).json({ error: 'Order not found' });

    const { data: order, error } = await supabase.from('bg_orders').select('*')
      .eq('tenant_id', req.tenant.id).eq('order_number', number).maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const token = typeof req.query.token === 'string' ? req.query.token : '';
    let allowed = !!token && sameSecret(token, order.order_token);
    if (!allowed && req.get('authorization')) {
      const user = await auth.getAuthUser(req);
      if (user) {
        allowed = (!!order.user_id && order.user_id === user.id) || !!(await auth.getStaffRole(user.id, req.tenant.id));
      }
    }
    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this order' });

    const { data: rows, error: iErr } = await supabase.from('bg_order_items')
      .select('name_snapshot, quantity, unit_price, line_total')
      .eq('tenant_id', req.tenant.id).eq('order_id', order.id);
    if (iErr) throw iErr;

    res.json({
      order_number: order.order_number,
      order_type: order.order_type,
      table_label: order.table_label,
      customer_name: order.customer_name,
      customer_phone: order.customer_phone,
      customer_email: order.customer_email,
      delivery_address: order.delivery_address,
      status: order.status,
      payment_status: order.payment_status,
      subtotal: Number(order.subtotal),
      delivery_fee: Number(order.delivery_fee),
      total: Number(order.total),
      currency: order.currency,
      notes: order.notes,
      created_at: order.created_at,
      items: (rows || []).map((r) => ({
        name: r.name_snapshot, quantity: r.quantity, unit_price: Number(r.unit_price), line_total: Number(r.line_total),
      })),
    });
  }));

  // A table's QR code opens the menu with ?table=<token>; the page asks this which table that is.
  router.get('/table/:token', lookupLimiter, asyncHandler(async (req, res) => {
    const token = String(req.params.token || '');
    if (!TABLE_TOKEN_RE.test(token)) return res.status(404).json({ error: 'Table not found' });
    const { data, error } = await supabase.from('bg_dining_tables').select('label')
      .eq('tenant_id', req.tenant.id).eq('token', token).eq('is_active', true).maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Table not found' });
    res.json({ label: data.label });
  }));

  return router;
}

module.exports = { createOrdersRouter, whatsappUrl };
