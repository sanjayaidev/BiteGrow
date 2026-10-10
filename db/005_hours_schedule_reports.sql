-- BiteGrow: opening hours, pausing orders, scheduled pickup/delivery, and admin reporting.
-- Run after 004_staff_and_tables.sql (or base.sql + the later migrations). Safe to re-run.

-- The restaurant's own timezone. Opening hours and "ready by" times are local wall-clock
-- times in this zone, so a kitchen in Dubai and one in London can both say "opens 11:30".
alter table bg_tenants add column if not exists timezone text not null default 'Asia/Kolkata';

-- Opening hours + the manual "not taking orders" switch live with the other storefront settings.
--   open_hours   jsonb   { "mon": [{open:"11:30",close:"22:00"}], ..., "default": [...] } — an empty list means closed that day
--   open_note    text    free line shown under the hours ("last orders 30 minutes before close")
--   pause_orders boolean  owner flips this to stop all new orders immediately
--   pause_until  timestamptz optional; the pause lifts by itself after this moment
alter table bg_tenant_settings add column if not exists open_hours    jsonb  not null default '{}'::jsonb;
alter table bg_tenant_settings add column if not exists open_note     text   not null default '';
alter table bg_tenant_settings add column if not exists pause_orders  boolean not null default false;
alter table bg_tenant_settings add column if not exists pause_until   timestamptz;

-- Scheduled orders: when the customer wants it ready / delivered. NULL = as soon as possible.
-- lead_minutes records the minimum notice the restaurant asked for at the time of ordering,
-- so the desk can see whether a ticket was placed in a hurry.
alter table bg_orders add column if not exists ready_at      timestamptz;
alter table bg_orders add column if not exists lead_minutes  int;

-- Reports aggregate each order once per day instead of scanning the whole table every time.
-- A nightly job (or the admin opening the Analytics tab) fills these; they are append-only totals.
create table if not exists bg_daily_stats (
  tenant_id   uuid not null references bg_tenants(id) on delete cascade,
  day         date not null,                       -- calendar day in the restaurant's own timezone
  orders      int  not null default 0,             -- orders created that day (all statuses)
  revenue     numeric(12,2) not null default 0,    -- total of non-cancelled orders
  cancelled   int  not null default 0,
  avg_total   numeric(12,2) not null default 0,    -- revenue / paid-for orders
  updated_at  timestamptz not null default now(),
  primary key (tenant_id, day)
);
create index if not exists bg_daily_stats_day_idx on bg_daily_stats (day desc);

alter table bg_daily_stats enable row level security;
-- No policies: only the server (service_role) reads or writes this.
