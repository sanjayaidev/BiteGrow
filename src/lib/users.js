'use strict';
// supabase-js has no "find user by email", so page through the accounts until the address turns up.
// Shared by the restaurant team page (routes/staffAdmin.js) and the platform page (routes/platform.js).

async function findUserByEmail(supabase, email) {
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

module.exports = { findUserByEmail };
