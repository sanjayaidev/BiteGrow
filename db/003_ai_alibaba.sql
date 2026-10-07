-- BiteGrow: the AI assistant now uses ONE server-wide Alibaba Model Studio account (ALIBABA_* settings in .env),
-- so restaurants no longer bring their own key or choose a model. Safe to re-run. Run after 002_admin_meta_ai.sql.

alter table bg_tenant_integrations drop constraint if exists bg_tenant_integrations_ai_provider_check;
update bg_tenant_integrations set ai_provider = 'alibaba';
alter table bg_tenant_integrations alter column ai_provider set default 'alibaba';
alter table bg_tenant_integrations add constraint bg_tenant_integrations_ai_provider_check check (ai_provider in ('alibaba'));

-- Model name is a server setting now (ALIBABA_MODEL); the old per-restaurant value was an Anthropic model name.
update bg_tenant_integrations set ai_model = 'qwen-plus';
alter table bg_tenant_integrations alter column ai_model set default 'qwen-plus';

-- Any key a restaurant saved before was for the old provider and cannot work with the new one: clear it.
update bg_tenant_integrations set ai_api_key_enc = null;
