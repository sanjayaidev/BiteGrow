'use strict';
// The restaurant's own team. Mounted by admin.js, so every route has already passed requireStaff(['owner', 'admin'])
// for req.tenant; on top of that, only the owner (or the platform's super admin) may manage the team.
//
//   GET    /api/admin/staff                  everyone with a role here, with their email
//   POST   /api/admin/staff                  { email, role: 'admin' | 'staff', password? }
//   PATCH  /api/admin/staff/:userId          { role }
//   DELETE /api/admin/staff/:userId
//
// Accounts are global (one login works on every restaurant), so adding someone attaches an existing account to this
// restaurant. If the email has no account yet, a temporary password creates one; the person can change it later with
// "Forgot password". The owner's role can never be changed or removed here, and nobody can remove themselves.

const express = require('express');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ASSIGNABLE = ['admin', 'staff'];
const MAX_STAFF = 100;
const ID_RE = /^[0-9A-Za-z-]{1,64}$/;

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createStaffRouter({ supabase }) {
  const router = express.Router();

  router.use((req, res, next) => (
    req.staffRole === 'owner' || req.staffRole === 'super' ? next() : res.status(403).json({ error: 'Only the owner can manage the team' })));

  // supabase-js has no "find user by email", so page through the accounts until the address turns up.
  async function findUserByEmail(email) {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw error;
      const users = (data && data.users) || [];
      const hit = users.find((u) => String(u.email || '').toLowerCase() === email);
      if (hit) return hit;
      if (users.length < 200) return null;
    }
    return null;
  }

  async function memberOf(tenantId, userId) {
    const { data, error } = await supabase.from('bg_tenant_members').select('user_id, role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data;
  }

  router.get('/', asyncHandler(async (req, res) => {
    const { data, error } = await supabase.from('bg_tenant_members').select('user_id, role, created_at').eq('tenant_id', req.tenant.id).limit(MAX_STAFF);
    if (error) throw error;
    const rows = data || [];
    const ids = rows.map((r) => r.user_id);
    const { data: profiles, error: pErr } = ids.length
      ? await supabase.from('bg_profiles').select('id, display_name').in('id', ids) : { data: [], error: null };
    if (pErr) throw pErr;
    const names = new Map((profiles || []).map((p) => [p.id, p.display_name]));
    const emails = await Promise.all(ids.map(async (id) => {
      const { data: u } = await supabase.auth.admin.getUserById(id);
      return [id, u && u.user ? u.user.email : ''];
    }));
    const emailOf = new Map(emails);
    const order = { owner: 0, admin: 1, staff: 2 };
    const staff = rows.map((r) => ({
      user_id: r.user_id, email: emailOf.get(r.user_id) || '', display_name: names.get(r.user_id) || '', role: r.role,
      is_you: r.user_id === req.authUser.id,
    })).sort((a, b) => (order[a.role] - order[b.role]) || a.email.localeCompare(b.email));
    res.json({ staff });
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const b = req.body || {};
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'A valid email is required' });
    if (!ASSIGNABLE.includes(b.role)) return res.status(400).json({ error: 'Choose a role: admin or staff' });

    const { count, error: cErr } = await supabase.from('bg_tenant_members').select('user_id', { count: 'exact', head: true }).eq('tenant_id', req.tenant.id);
    if (cErr) throw cErr;
    if (count >= MAX_STAFF) return res.status(400).json({ error: `A restaurant can have at most ${MAX_STAFF} team members` });

    let user = await findUserByEmail(email);
    let createdAccount = false;
    if (!user) {
      const password = typeof b.password === 'string' ? b.password : '';
      if (!password) {
        return res.status(404).json({ error: 'No account uses that email yet. Enter a temporary password to create one, or ask the person to create an account on your site first.' });
      }
      if (password.length < 8) return res.status(400).json({ error: 'The temporary password must be at least 8 characters' });
      if (password.length > 72) return res.status(400).json({ error: 'The temporary password must be at most 72 characters' });
      const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) return res.status(400).json({ error: error.message });
      user = data.user; createdAccount = true;
    }

    const existing = await memberOf(req.tenant.id, user.id);
    if (existing) return res.status(409).json({ error: existing.role === 'owner' ? 'That person is the owner of this restaurant' : 'That person is already on your team' });

    const { error } = await supabase.from('bg_tenant_members').insert({ tenant_id: req.tenant.id, user_id: user.id, role: b.role });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'That person is already on your team' });
      throw error;
    }
    res.status(201).json({ member: { user_id: user.id, email, role: b.role, created_account: createdAccount } });
  }));

  // The person being changed must belong to THIS restaurant, and must not be its owner.
  async function target(req, res) {
    const id = String(req.params.userId || '');
    if (!ID_RE.test(id)) { res.status(400).json({ error: 'Invalid team member' }); return null; }
    const member = await memberOf(req.tenant.id, id);
    if (!member) { res.status(404).json({ error: 'Team member not found' }); return null; }
    if (member.role === 'owner') { res.status(403).json({ error: 'The owner cannot be changed or removed here' }); return null; }
    return member;
  }

  router.patch('/:userId', asyncHandler(async (req, res) => {
    const member = await target(req, res); if (!member) return;
    const role = (req.body || {}).role;
    if (!ASSIGNABLE.includes(role)) return res.status(400).json({ error: 'Choose a role: admin or staff' });
    const { error } = await supabase.from('bg_tenant_members').update({ role }).eq('tenant_id', req.tenant.id).eq('user_id', member.user_id);
    if (error) throw error;
    res.json({ member: { user_id: member.user_id, role } });
  }));

  router.delete('/:userId', asyncHandler(async (req, res) => {
    const member = await target(req, res); if (!member) return;
    if (member.user_id === req.authUser.id) return res.status(400).json({ error: 'You cannot remove yourself' });
    const { error } = await supabase.from('bg_tenant_members').delete().eq('tenant_id', req.tenant.id).eq('user_id', member.user_id);
    if (error) throw error;
    res.json({ ok: true });
  }));

  return router;
}

module.exports = { createStaffRouter, ASSIGNABLE, MAX_STAFF };
