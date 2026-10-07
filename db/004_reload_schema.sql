-- BiteGrow: make Supabase's API see the tables from 002/003.
-- Fixes: "Could not find a relationship between 'bg_tenants' and 'bg_tenant_integrations' in the schema cache".
-- Run order in the Supabase SQL editor: base.sql -> 002_admin_meta_ai.sql -> 003_ai_alibaba.sql -> this file.
-- Safe to re-run.

-- Tables created through SQL are visible to the server (service_role) key; make that explicit.
grant all on bg_tenant_integrations, bg_chat_sessions, bg_webhook_events, bg_ai_usage to service_role;

-- Ask PostgREST (the Supabase API) to reload its schema cache now.
notify pgrst, 'reload schema';
