'use strict';
// Customer accounts: register, login, token refresh, profile, order history, password reset.
//
// Accounts are global (one login works on every restaurant); order history is
// per restaurant, so a customer only sees their orders from req.tenant.
//
// Env: SUPABASE_ANON_KEY is used to check passwords on a throwaway client. If it
// is not set, the service key is used on that same throwaway client, which works
// too. Password reset emails link back to the host the customer is on, so the
// wildcard / each restaurant domain must be listed under Supabase ->
// Authentication -> URL Configuration -> Redirect URLs.

const express = require('express');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');

const PROFILE_COLS = 'id, display_name, phone, address, created_at, updated_at';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LIMITS = { display_name: 80, phone: 30, address: 300 };

// Verifying a password signs the user in on whichever client does it, and that client
// then sends requests as that user. Never do it on the shared service_role client: use a new client each time.
function defaultAuthClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  // Node < 22 has no native WebSocket, and supabase-js builds a realtime client even though this one never uses it.
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);

function createAuthRouter({ supabase, auth, createAuthClient = defaultAuthClient, limit = 20 }) {
  const router = express.Router();

  // Credential guessing and email spam are limited per IP.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait a while and try again.' },
  });

  async function getOrCreateProfile(user) {
    const read = () => supabase.from('bg_profiles').select(PROFILE_COLS).eq('id', user.id).maybeSingle();
    const first = await read();
    if (first.error) throw first.error;
    if (first.data) return first.data;
    // ignoreDuplicates: two simultaneous first logins don't fail on the primary key, the loser just re-reads.
    const { error } = await supabase.from('bg_profiles').upsert(
      { id: user.id, display_name: (user.user_metadata && user.user_metadata.display_name) || '' },
      { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw error;
    const again = await read();
    if (again.error) throw again.error;
    return again.data;
  }

  router.post('/register', limiter, asyncHandler(async (req, res) => {
    const email = clean(req.body.email, 254);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const displayName = clean(req.body.display_name, LIMITS.display_name) || '';

    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (password.length > 72) return res.status(400).json({ error: 'Password must be at most 72 characters' });

    const { data, error } = await supabase.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { display_name: displayName },
    });
    if (error) return res.status(400).json({ error: error.message });

    try {
      const profile = await getOrCreateProfile(data.user);
      return res.status(201).json({ profile });
    } catch (err) {
      await supabase.auth.admin.deleteUser(data.user.id);     // no half-created accounts
      throw err;
    }
  }));

  router.post('/login', limiter, asyncHandler(async (req, res) => {
    const email = clean(req.body.email, 254);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const { data, error } = await createAuthClient().auth.signInWithPassword({ email, password });
    if (error || !data || !data.session) return res.status(401).json({ error: 'Invalid email or password' });

    const profile = await getOrCreateProfile(data.user);
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
      profile,
    });
  }));

  // Access tokens are short-lived; the browser trades its refresh token for a new pair instead of logging the customer out.
  router.post('/refresh', limiter, asyncHandler(async (req, res) => {
    const refreshToken = typeof req.body.refresh_token === 'string' ? req.body.refresh_token : '';
    if (!refreshToken) return res.status(400).json({ error: 'refresh_token is required' });
    const { data, error } = await createAuthClient().auth.refreshSession({ refresh_token: refreshToken });
    if (error || !data || !data.session) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    res.json({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_at: data.session.expires_at,
    });
  }));

  router.get('/me', auth.requireAuth, asyncHandler(async (req, res) => {
    const [profile, staffRole] = await Promise.all([
      getOrCreateProfile(req.authUser),
      auth.getStaffRole(req.authUser.id, req.tenant.id),
    ]);
    // `staff` tells the page whether to show an admin link for this restaurant. It is not a permission: every admin route re-checks.
    res.json({ user_id: req.authUser.id, email: req.authUser.email, profile, staff: staffRole });
  }));

  router.patch('/me', auth.requireAuth, asyncHandler(async (req, res) => {
    const updates = {};
    for (const field of Object.keys(LIMITS)) {
      const v = clean(req.body[field], LIMITS[field]);
      if (v !== undefined) updates[field] = v;
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No profile fields supplied' });

    await getOrCreateProfile(req.authUser);
    const { data: profile, error } = await supabase.from('bg_profiles')
      .update(updates).eq('id', req.authUser.id).select(PROFILE_COLS).single();
    if (error) throw error;
    res.json({ profile });
  }));

  // The customer's orders at THIS restaurant only.
  router.get('/orders', auth.requireAuth, asyncHandler(async (req, res) => {
    const { data: orders, error } = await supabase.from('bg_orders')
      .select('id, order_number, order_type, table_label, status, payment_status, payment_method, total, currency, created_at, bg_order_items(menu_item_id, name_snapshot, quantity, line_total)')
      .eq('tenant_id', req.tenant.id)
      .eq('user_id', req.authUser.id)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ orders });
  }));

  router.post('/request-password-reset', limiter, asyncHandler(async (req, res) => {
    const email = clean(req.body.email, 254);
    if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    // Back to the restaurant the customer is on. Supabase only honours addresses on its Redirect URLs list,
    // so a forged Host header cannot send the link somewhere else.
    const redirectTo = `${req.protocol}://${req.get('host')}/reset-password.html`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) console.error('resetPasswordForEmail:', error.message);
    res.json({ ok: true });                // same answer whether or not the email exists
  }));

  router.post('/reset-password', limiter, asyncHandler(async (req, res) => {
    const accessToken = typeof req.body.access_token === 'string' ? req.body.access_token : '';
    const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';
    if (!accessToken || !newPassword) return res.status(400).json({ error: 'access_token and new_password are required' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    if (newPassword.length > 72) return res.status(400).json({ error: 'Password must be at most 72 characters' });

    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
    }
    const { error: updateError } = await supabase.auth.admin.updateUserById(data.user.id, { password: newPassword });
    if (updateError) throw updateError;
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createAuthRouter };