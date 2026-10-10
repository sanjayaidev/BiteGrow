'use strict';
// Admin reporting on top of the order desk (owner/admin only — kitchen staff never see takings).
// Mounted at /api/admin inside createAdminRouter, so auth and Cache-Control come from there.
//
//   GET /api/admin/reports?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=<IANA>&type=pickup&status=completed
//       -> { range, totals, days[], items[] }
//          One row per calendar day (in the restaurant's own timezone): how many orders, what they
//          took, which order types made up the day, plus the most-ordered dishes in the period.
//
//   GET /api/admin/orders/:id/ticket
//       -> text/plain kitchen ticket: what to cook, for whom, when it should be ready. Printable.
//
// Everything is computed from bg_orders rows; dates are bucketed with src/lib/hours.js so "today's
// sales" means today at the restaurant, not today on the server.

const express = require('express');
const { localMidnightMs, localNow } = require('../lib/hours');
const { toInt } = require('../lib/orderMath');

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ORDER_TYPES = ['dine_in', 'pickup', 'delivery'];
const STATUSES = ['pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled'];
const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 366;                       // refuse a query that would pull years of rows
const DEFAULT_DAYS = 30;                         // no ?from given: the last month up to today
const MAX_ITEMS = 15;                            // "top dishes" list length

// A timezone string either parses as IANA or does not; bad input falls back rather than throwing.
function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0); return tz; }
  catch (e) { return 'UTC'; }
}

// "YYYY-MM-DD" -> [startMs, endMs) real timestamps for that calendar day in tz.
function dayRange(tz, ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const start = localMidnightMs(tz, y, mo, d);
  if (!Number.isFinite(start)) return null;
  return { start, end: start + DAY_MS };
}

// Which local calendar day an order belongs to ("2026-10-09"), in tz.
function dayOf(isoCreated, tz) {
  const ms = Date.parse(isoCreated);
  if (isNaN(ms)) return null;
  const l = localNow(tz, ms);
  return l.iso;
}

function createReportsRouter({ supabase }) {
  const router = express.Router();

  router.get('/reports', asyncHandler(async (req, res) => {
    const tenant = req.tenant;
    const tz = safeTz(typeof req.query.tz === 'string' && req.query.tz ? req.query.tz : (tenant.timezone || 'UTC'));

    // ---- date window -------------------------------------------------------
    const today = localNow(tz).iso;
    const to = typeof req.query.to === 'string' && DATE_RE.test(req.query.to) ? req.query.to : today;
    const from = typeof req.query.from === 'string' && DATE_RE.test(req.query.from) ? req.query.from
      : dayShift(tz, to, -(DEFAULT_DAYS - 1));
    if (from > to) return res.status(400).json({ error: 'The start date must be on or before the end date' });
    const rFrom = dayRange(tz, from), rTo = dayRange(tz, to);
    if (!rFrom || !rTo) return res.status(400).json({ error: 'Those dates do not look right' });
    if (rTo.end - rFrom.start > MAX_SPAN_DAYS * DAY_MS) return res.status(400).json({ error: `Reports cover at most ${MAX_SPAN_DAYS} days at a time` });

    // ---- optional filters --------------------------------------------------
    let q = supabase.from('bg_orders').select('*')
      .eq('tenant_id', tenant.id)
      .gte('created_at', new Date(rFrom.start).toISOString())
      .lt('created_at', new Date(rTo.end).toISOString());
    const type = typeof req.query.type === 'string' ? req.query.type : '';
    if (type && !ORDER_TYPES.includes(type)) return res.status(400).json({ error: 'Unknown order type' });
    if (type) q = q.eq('order_type', type);
    const status = typeof req.query.status === 'string' ? req.query.status : '';
    if (status && !STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown order status' });
    if (status) q = q.eq('status', status);

    const { data, error } = await q.order('created_at', { ascending: true }).limit(20000);
    if (error) throw error;
    const rows = data || [];

    // ---- per-day buckets ---------------------------------------------------
    const byDay = new Map();
    for (let ms = rFrom.start; ms < rTo.end; ms += DAY_MS) {
      const l = localNow(tz, ms);
      byDay.set(l.iso, { day: l.iso, orders: 0, revenue: 0, cancelled: 0, by_type: { dine_in: 0, pickup: 0, delivery: 0 }, by_channel: {} });
    }
    const itemTotals = new Map();
    const totals = { orders: 0, revenue: 0, cancelled: 0, canceled_value: 0, by_type: { dine_in: 0, pickup: 0, delivery: 0 } };
    for (const o of rows) {
      const key = dayOf(o.created_at, tz);
      const b = key && byDay.has(key) ? byDay.get(key) : null;   // rows outside the window can only come from clock skew
      const cent = Math.round(Number(o.total || 0) * 100) / 100;
      const cancelled = o.status === 'cancelled';
      totals.orders++;
      totals.by_type[o.order_type] = (totals.by_type[o.order_type] || 0) + 1;
      if (cancelled) totals.cancelled++; else totals.revenue = round2(totals.revenue + cent);
      if (b) {
        b.orders++;
        b.by_type[o.order_type] = (b.by_type[o.order_type] || 0) + 1;
        b.by_channel[o.channel || 'web'] = (b.by_channel[o.channel || 'web'] || 0) + 1;
        if (cancelled) b.cancelled++; else b.revenue = round2(b.revenue + cent);
      }
    }
    // Most-ordered dishes: join the line items of exactly the orders counted above.
    const ids = new Set(rows.map((o) => o.id));
    if (ids.size) {
      const idList = [...ids];
      for (let i = 0; i < idList.length; i += 500) {         // keep the IN list a sane size
        const { data: lines, error: lErr } = await supabase.from('bg_order_items')
          .select('order_id, name_snapshot, quantity, line_total')
          .eq('tenant_id', tenant.id).in('order_id', idList.slice(i, i + 500));
        if (lErr) throw lErr;
        const okLine = new Map(rows.map((o) => [o.id, o.status !== 'cancelled']));
        for (const ln of lines || []) {
          if (!okLine.get(ln.order_id)) continue;            // cancelled orders sold nothing
          const k = String(ln.name_snapshot || '?');
          const e = itemTotals.get(k) || { name: k, quantity: 0, revenue: 0 };
          e.quantity += Number(ln.quantity || 0);
          e.revenue = round2(e.revenue + Number(ln.line_total || 0));
          itemTotals.set(k, e);
        }
      }
    }

    const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((d) => ({ ...d, revenue: round2(d.revenue), avg_order: d.orders - d.cancelled ? round2(d.revenue / (d.orders - d.cancelled)) : 0 }));
    res.json({
      range: { from, to, timezone: tz },
      currency: tenant.currency,
      truncated: rows.length >= 20000,
      totals: { ...totals, avg_order: totals.orders - totals.cancelled ? round2(totals.revenue / (totals.orders - totals.cancelled)) : 0 },
      days,
      items: [...itemTotals.values()].sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue).slice(0, MAX_ITEMS),
    });
  }));

  // ---- printable kitchen ticket -------------------------------------------
  router.get('/orders/:id/ticket', asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (id === null || id <= 0) return res.status(400).json({ error: 'Invalid order' });
    const { data: order, error } = await supabase.from('bg_orders').select('*')
      .eq('tenant_id', req.tenant.id).eq('id', id).maybeSingle();
    if (error) throw error;
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { data: lines, error: iErr } = await supabase.from('bg_order_items')
      .select('name_snapshot, quantity, line_total').eq('tenant_id', req.tenant.id).eq('order_id', order.id);
    if (iErr) throw iErr;

    const s = req.tenant.settings || {};
    const money = (n) => `${req.tenant.currencySymbol}${Number(n || 0).toFixed(2)}`;
    const fmt = (iso) => {
      const ms = Date.parse(iso);
      if (isNaN(ms)) return '';
      return new Intl.DateTimeFormat('en-GB', { timeZone: req.tenant.timezone || 'UTC', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
    };
    const L = [];
    L.push(s.brandName || req.tenant.name || '');
    L.push(`TICKET ${order.order_number}`);
    L.push(`Placed ${new Date(order.created_at).toLocaleString('en-GB', { timeZone: req.tenant.timezone || 'UTC' })}`);
    const TYPE = { dine_in: 'DINE-IN', pickup: 'PICKUP', delivery: 'DELIVERY' };
    L.push(`${TYPE[order.order_type] || String(order.order_type).toUpperCase()}${order.table_label ? ` — table ${order.table_label}` : ''}`);
    if (order.ready_at) L.push(`READY BY ${fmt(order.ready_at)}${order.customer_phone ? ` · call ${order.customer_phone}` : ''}`);
    L.push(''.padEnd(28, '='));
    for (const ln of lines || []) L.push(`${ln.quantity} x ${ln.name_snapshot}`);
    L.push(''.padEnd(28, '-'));
    if (Number(order.delivery_fee)) L.push(`delivery  ${money(order.delivery_fee)}`);
    L.push(`TOTAL   ${money(order.total)}`);
    if (order.customer_name) L.push(`For: ${order.customer_name}`);
    if (order.notes) L.push(`Notes: ${order.notes}`);
    if (order.delivery_address) L.push(`Address: ${order.delivery_address}`);
    res.set('Content-Type', 'text/plain; charset=utf-8')
      .set('Content-Disposition', `inline; filename="ticket-${order.order_number}.txt"`)
      .send(L.filter((x) => x !== '').join('\n') + '\n');
  }));

  return router;
}

// The calendar date DEFAULT_DAYS back from "YYYY-MM-DD", still in tz (month ends and DST included).
function dayShift(tz, ymd, deltaDays) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const ms = localMidnightMs(tz, y, mo, d) + deltaDays * DAY_MS;
  return localNow(tz, ms).iso;
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

module.exports = { createReportsRouter, dayRange, dayOf, safeTz };
