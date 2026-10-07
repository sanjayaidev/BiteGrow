-- BiteGrow: per-restaurant integrations (Meta messaging + AI assistant) and chat memory.
-- Run after base.sql. Safe to re-run. Secrets are stored AES-256-GCM encrypted by the
-- server (APP_SECRET_KEY); the database never holds them in clear text.

create table if not exists bg_tenant_integrations (
  tenant_id            uuid primary key references bg_tenants(id) on delete cascade,

  -- Meta (WhatsApp Cloud API, Instagram DMs, Facebook Messenger)
  meta_enabled         boolean not null default false,
  meta_whatsapp_phone_id text unique,            -- WhatsApp "phone number id": routes webhooks to this tenant
  meta_page_id         text unique,              -- Facebook Page id (Messenger)
  meta_instagram_id    text unique,              -- Instagram business account id
  meta_access_token_enc text,                    -- encrypted long-lived / system-user token
  meta_pixel_id        text,                     -- optional, injected into the storefront

  -- AI assistant
  ai_enabled           boolean not null default false,
  ai_provider          text not null default 'anthropic' check (ai_provider in ('anthropic')),
  ai_model             text not null default 'claude-haiku-4-5-20251001',
  ai_api_key_enc       text,                     -- optional own key; falls back to server ANTHROPIC_API_KEY
  ai_persona           text not null default '' , -- extra instructions from the owner (tone, hours, policies)
  ai_greeting          text not null default '',
  ai_handoff_phone     text,                     -- shown when the bot cannot help
  ai_channels          text[] not null default array['web']
                       check (ai_channels <@ array['web', 'whatsapp', 'instagram', 'facebook']),
  ai_daily_limit       int not null default 500 check (ai_daily_limit between 0 and 100000),

  updated_at           timestamptz not null default now()
);

drop trigger if exists trg_integrations_touch on bg_tenant_integrations;
create trigger trg_integrations_touch before update on bg_tenant_integrations
  for each row execute function bg_touch_updated_at();

-- Short chat memory per contact and channel.
create table if not exists bg_chat_sessions (
  tenant_id  uuid not null references bg_tenants(id) on delete cascade,
  channel    text not null check (channel in ('web', 'whatsapp', 'instagram', 'facebook')),
  contact_id text not null,
  messages   jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, channel, contact_id)
);

-- Meta redelivers webhooks; remembering message ids makes handling idempotent.
create table if not exists bg_webhook_events (
  id         text primary key,
  tenant_id  uuid references bg_tenants(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Daily AI usage counter for cost control.
create table if not exists bg_ai_usage (
  tenant_id uuid not null references bg_tenants(id) on delete cascade,
  day       date not null,
  calls     int not null default 0,
  primary key (tenant_id, day)
);

alter table bg_tenant_integrations enable row level security;
alter table bg_chat_sessions       enable row level security;
alter table bg_webhook_events      enable row level security;
alter table bg_ai_usage            enable row level security;
-- No policies: only the server (service_role) reads or writes these.
