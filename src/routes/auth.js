'use strict';
// Who is calling, and what may they do in THIS restaurant.
//
// Customer accounts are global (Supabase Auth + bg_profiles): one login works on
// every restaurant. Staff roles are per tenant (bg_tenant_members), plus an
// optional platform-wide super admin flag on the profile. A person can be a
// customer at one restaurant and owner of another.
//
// The server talks to Supabase with the service_role key, so nothing below relies
// on database RLS: each check is done here, against req.tenant.

const ROLES = ['owner', 'admin', 'staff'];

function createAuth({ supabase }) {
  // Valid Supabase access token in "Authorization: Bearer <token>" -> the auth user, else null.
  async function getAuthUser(req) {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !token) return null;
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) return null;
    return data.user;
  }

  // 'super' | 'owner' | 'admin' | 'staff' | null for this user in this tenant.
  async function getStaffRole(userId, tenantId) {
    const { data: profile, error: pErr } = await supabase
      .from('bg_profiles').select('is_super_admin').eq('id', userId).maybeSingle();
    if (pErr) throw pErr;
    if (profile && profile.is_super_admin) return 'super';

    const { data: member, error: mErr } = await supabase
      .from('bg_tenant_members').select('role').eq('tenant_id', tenantId).eq('user_id', userId).maybeSingle();
    if (mErr) throw mErr;
    return member ? member.role : null;
  }

  async function requireAuth(req, res, next) {
    try {
      const user = await getAuthUser(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      req.authUser = user;
      next();
    } catch (err) { next(err); }
  }

  // Signed in AND holding one of `roles` in req.tenant (super admins always pass).
  // Mount after the tenant resolver. Sets req.authUser and req.staffRole.
  const requireStaff = (roles = ROLES) => async (req, res, next) => {
    try {
      if (!req.tenant) return res.status(500).json({ error: 'Server error' });
      const user = await getAuthUser(req);
      if (!user) return res.status(401).json({ error: 'Authentication required' });
      const role = await getStaffRole(user.id, req.tenant.id);
      if (!role || (role !== 'super' && !roles.includes(role))) {
        return res.status(403).json({ error: 'Staff access required' });
      }
      req.authUser = user;
      req.staffRole = role;
      next();
    } catch (err) { next(err); }
  };

  return { getAuthUser, getStaffRole, requireAuth, requireStaff };
}

module.exports = { createAuth, ROLES };