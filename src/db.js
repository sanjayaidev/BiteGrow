'use strict';
// Supabase client for the server. Uses the service_role key, which bypasses
// row-level security, so it must never reach the browser. Tenant isolation is
// therefore enforced in the server code: every query on a bg_ table has to be
// filtered by req.tenant.id.
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws'); // Node < 22 has no native WebSocket; realtime-js needs one

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Copy .env.example to .env and fill them in ' +
    '(Supabase -> Project Settings -> API).'
  );
}

const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});

module.exports = { supabase };
