'use strict';
// Payment status from an outside server.
//
// Nothing on this server talks to a payment provider. Orders are paid in cash (dine-in), on delivery (COD) or at
// pickup, and staff mark them paid in the order desk. If you also run a separate payment service, it can tell this
// server that an order was paid (or refunded) with one signed request:
//
//   POST /webhooks/payments
//   X-BiteGrow-Signature: sha256=<hex HMAC-SHA256 of the exact request body, keyed with PAYMENT_WEBHOOK_SECRET>
//   { "tenant": "redhouse", "order_number": "RH-261010-0001", "payment_status": "paid" }      ("paid" or "refunded")
//
// Answers: 200 { ok: true, changed: true|false }   changed:false = the order was already in that state (safe to retry)
//          400 bad body   401 bad signature   404 unknown restaurant or order   409 not allowed for this order
//          503 the secret is not set on this server, so the endpoint is switched off
//
// It follows the same rules as the order desk: unpaid -> paid -> refunded, and a cancelled order cannot be marked paid.
// Mount BEFORE the tenant resolver and BEFORE express.json (the signature covers the raw bytes).

const crypto = require('node:crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { PAYMENT_NEXT } = require('./ordersAdmin');

const MIN_SECRET_LENGTH = 16;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const ORDER_NUMBER_RE = /^[A-Z0-9]{2,6}-\d{6}-\d{4,}$/;
const SETTABLE = ['paid', 'refunded'];

function validSignature(raw, header, secret) {
  if (!secret || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createPaymentWebhookRouter({ supabase, secret = process.env.PAYMENT_WEBHOOK_SECRET, onOrderChanged = () => {}, limit = 300 }) {
  const router = express.Router();
  const enabled = typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;

  router.use((req, res, next) => (enabled ? next() : res.status(503).json({
    error: `Payment webhook is switched off. Set PAYMENT_WEBHOOK_SECRET (at least ${MIN_SECRET_LENGTH} characters) on the server and restart it.`,
  })));

  router.use(rateLimit({
    windowMs: 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
  }));

  router.post('/', express.raw({ type: '*/*', limit: '16kb' }), asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!validSignature(raw, req.get('x-bitegrow-signature'), secret)) return res.status(401).json({ error: 'Bad signature' });

    let b;
    try { b = JSON.parse(raw.toString('utf8')); } catch (e) { return res.status(400).json({ error: 'The body must be JSON' }); }
    b = b && typeof b === 'object' && !Array.isArray(b) ? b : {};

    const slug = typeof b.tenant === 'string' ? b.tenant.trim().toLowerCase() : '';
    const number = typeof b.order_number === 'string' ? b.order_number.trim().toUpperCase() : '';
    const want = b.payment_status;
    if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'tenant must be the restaurant web name' });
    if (!ORDER_NUMBER_RE.test(number)) return res.status(400).json({ error: 'order_number does not look right' });
    if (!SETTABLE.includes(want)) return res.status(400).json({ error: 'payment_status must be paid or refunded' });

    const { data: tenant, error: tErr } = await supabase.from('bg_tenants').select('id, slug').eq('slug', slug).maybeSingle();
    if (tErr) throw tErr;
    if (!tenant) return res.status(404).json({ error: 'Unknown restaurant' });

    const { data: order, error: oErr } = await supabase.from('bg_orders').select('*')
      .eq('tenant_id', tenant.id).eq('order_number', number).maybeSingle();
    if (oErr) throw oErr;
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.payment_status === want) return res.json({ ok: true, changed: false, payment_status: want });
    if (!(PAYMENT_NEXT[order.payment_status] || []).includes(want)) {
      return res.status(409).json({ error: `Payment that is ${order.payment_status} cannot be set to ${want}` });
    }
    if (want === 'paid' && order.status === 'cancelled') return res.status(409).json({ error: 'A cancelled order cannot be marked paid' });

    // Only applies if nobody changed the order since it was read (a staff tap racing this request).
    const { data: saved, error: uErr } = await supabase.from('bg_orders').update({ payment_status: want })
      .eq('tenant_id', tenant.id).eq('id', order.id).eq('status', order.status).eq('payment_status', order.payment_status)
      .select('*').maybeSingle();
    if (uErr) throw uErr;
    if (!saved) return res.status(409).json({ error: 'The order was just changed. Try again.' });
    onOrderChanged(tenant.id, saved);
    res.json({ ok: true, changed: true, payment_status: saved.payment_status });
  }));

  return router;
}

module.exports = { createPaymentWebhookRouter, validSignature, MIN_SECRET_LENGTH };
