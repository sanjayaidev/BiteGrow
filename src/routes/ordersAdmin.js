'use strict';
// The restaurant's order desk: what staff see and do with orders placed on the storefront.
// Mounted at /api/admin/orders BEFORE the owner/admin router, because kitchen staff (role "staff") need it too.
//
//   GET   /api/admin/orders?status=active|done|all|<one status>   newest first, at most 100, with their items
//   PATCH /api/admin/orders/:id    { status?, payment_status? }   moves the order along; skipping steps is refused
//
// Every query is filtered by req.tenant.id, so a staff member of one restaurant can never read or change another's.

const express = require('express');
const { toInt } = require('../lib/orderMath');
const { methodOf, labelFor } = require('../lib/payment');

const STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
const ACTIVE = ['pending', 'confirmed', 'preparing', 'ready'];
const DONE = ['completed', 'cancelled'];
const LIMIT = 100;

// One step forward at a time; any order that is not finished can be cancelled. Finished orders stay finished.
const NEXT = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const PAYMENT_NEXT = { unpaid: ['paid'], paid: ['refunded'], refunded: [] };

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const view = (o, items) => ({
  id: o.id,
  order_number: o.order_number,
  order_type: o.order_type,
  table_label: o.table_label || null,
  customer_name: o.customer_name,
  customer_phone: o.customer_phone || null,
  customer_email: o.customer_email || null,
  delivery_address: o.delivery_address || null,
  status: o.status,
  payment_status: o.payment_status,
  payment_method: methodOf(o),
  payment_method_label: labelFor(methodOf(o)),
  channel: o.channel,
  subtotal: Number(o.subtotal),
  delivery_fee: Number(o.delivery_fee),
  total: Number(o.total),
  currency: o.currency,
  notes: o.notes || null,
  ready_at: o.ready_at || null,
  created_at: o.created_at,
  items: (items || []).map((i) => ({ name: i.name_snapshot, quantity: i.quantity, line_total: Number(i.line_total) })),
  next_statuses: NEXT[o.status] || [],
  next_payment: PAYMENT_NEXT[o.payment_status] || [],
});

function createOrdersAdminRouter({ supabase, auth, onOrderChanged = () => {} }) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(auth.requireStaff());          // owner, admin and staff

  async function itemsFor(tenantId, orderIds) {
    if (!orderIds.length) return new Map();
    const { data, error } = await supabase.from('bg_order_items')
      .select('order_id, name_snapshot, quantity, line_total')
      .eq('tenant_id', tenantId).in('order_id', orderIds);
    if (error) throw error;
    const byOrder = new Map();
    for (const r of data || []) {
      if (!byOrder.has(r.order_id)) byOrder.set(r.order_id, []);
      byOrder.get(r.order_id).push(r);
    }
    return byOrder;
  }

  router.get('/', asyncHandler(async (req, res) => {
    const want = typeof req.query.status === 'string' ? req.query.status : 'active';
    let statuses;
    if (want === 'active') statuses = ACTIVE;
    else if (want === 'done') statuses = DONE;
    else if (want === 'all') statuses = STATUSES;
    else if (STATUSES.includes(want)) statuses = [want];
    else return res.status(400).json({ error: 'Unknown status filter' });

    const { data, error } = await supabase.from('bg_orders').select('*')
      .eq('tenant_id', req.tenant.id).in('status', statuses)
      .order('created_at', { ascending: false }).limit(LIMIT);
    if (error) throw error;
    const rows = data || [];
    const items = await itemsFor(req.tenant.id, rows.map((o) => o.id));
    res.json({ orders: rows.map((o) => view(o, items.get(o.id))), limit: LIMIT, server_time: new Date().toISOString() });
  }));

  router.patch('/:id', asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (id === null || id <= 0) return res.status(400).json({ error: 'Invalid order' });
    const b = req.body || {};
    const wantStatus = b.status;
    const wantPay = b.payment_status;
    if (wantStatus === undefined && wantPay === undefined) return res.status(400).json({ error: 'Nothing to change' });
    if (wantStatus !== undefined && !STATUSES.includes(wantStatus)) return res.status(400).json({ error: 'Unknown order status' });
    if (wantPay !== undefined && !Object.keys(PAYMENT_NEXT).includes(wantPay)) return res.status(400).json({ error: 'Unknown payment status' });

    const { data: order, error } = await supabase.from('bg_orders').select('*')
      .eq('tenant_id', req.tenant.id).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const update = {};
    if (wantStatus !== undefined && wantStatus !== order.status) {
      if (!(NEXT[order.status] || []).includes(wantStatus)) {
        return res.status(409).json({ error: `An order that is ${order.status} cannot be set to ${wantStatus}` });
      }
      update.status = wantStatus;
    }
    if (wantPay !== undefined && wantPay !== order.payment_status) {
      if (!(PAYMENT_NEXT[order.payment_status] || []).includes(wantPay)) {
        return res.status(409).json({ error: `Payment that is ${order.payment_status} cannot be set to ${wantPay}` });
      }
      const finalStatus = update.status || order.status;
      if (wantPay === 'paid' && finalStatus === 'cancelled') return res.status(409).json({ error: 'A cancelled order cannot be marked paid' });
      update.payment_status = wantPay;
    }

    if (Object.keys(update).length) {
      // Only applies if nobody else changed the order since it was read (two staff tapping the same button).
      const { data: saved, error: uErr } = await supabase.from('bg_orders').update(update)
        .eq('tenant_id', req.tenant.id).eq('id', id).eq('status', order.status).eq('payment_status', order.payment_status)
        .select('*').maybeSingle();
      if (uErr) throw uErr;
      if (!saved) return res.status(409).json({ error: 'This order was just changed by someone else. Refresh and try again.' });
      Object.assign(order, saved);
      onOrderChanged(req.tenant.id, order);
    }

    const items = await itemsFor(req.tenant.id, [order.id]);
    res.json({ order: view(order, items.get(order.id)) });
  }));

  return router;
}

module.exports = { createOrdersAdminRouter, NEXT, PAYMENT_NEXT, STATUSES, ACTIVE, DONE };
