-- BiteGrow: multi-tenant core schema (Supabase / Postgres).
-- Every table, function and index is prefixed bg_ so it can share a Supabase
-- project with other apps (MenuSystem, smorders) without name clashes.
-- Run in Supabase -> SQL Editor. Safe to re-run.
--
-- Design
--   * One database, many restaurants ("tenants"). Every business table carries
--     tenant_id, and child rows are tied to their parent's tenant with composite
--     foreign keys, so a row can never point at another tenant's data.
--   * A tenant is resolved from the request host (tenant_domains) or its slug.
--   * Customer accounts (auth.users + profiles) are global: one login works on
--     every restaurant. Orders, carts and staff roles are per tenant.
--   * Names/descriptions/labels are jsonb keyed by language ({"en":"..","ar":".."})
--     so each tenant chooses its own languages without schema changes.
--   * The Node server uses the service_role key (bypasses RLS). The policies
--     below are defence in depth for anything that talks to Supabase directly.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- tenants --

create table if not exists bg_tenants (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique
              check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name        text not null,
  status      text not null default 'active' check (status in ('active', 'suspended')),
  timezone    text not null default 'UTC',          -- IANA name, drives order numbers
  currency    text not null default 'USD',          -- ISO code
  currency_symbol text not null default '$',
  default_lang text not null default 'en',
  languages   text[] not null default array['en'],
  order_prefix text not null default 'ORD' check (order_prefix ~ '^[A-Z0-9]{2,6}$'),
  created_at  timestamptz not null default now(),
  check (default_lang = any (languages))
);

-- Hostnames that map to a tenant (custom domains and <slug>.yourdomain.com).
create table if not exists bg_tenant_domains (
  domain     text primary key check (domain = lower(domain)),
  tenant_id  uuid not null references bg_tenants(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists bg_idx_tenant_domains_tenant on bg_tenant_domains(tenant_id);

-- One row of branding, contact and feature switches per tenant.
create table if not exists bg_tenant_settings (
  tenant_id    uuid primary key references bg_tenants(id) on delete cascade,
  brand_name   text not null default '',
  page_title   text not null default '',
  logo_url     text,
  card_bg_url  text,
  phone        text,
  phone2       text,
  address      text,
  map_url      text,
  whatsapp_number text,                              -- digits only, no + or 00
  delivery_fee numeric(10,2) not null default 0 check (delivery_fee >= 0),
  order_types  text[] not null default array['dine_in', 'pickup', 'delivery']
               check (order_types <@ array['dine_in', 'pickup', 'delivery']),
  features     jsonb not null default '{"ar3d": true, "whatsappOrder": true, "assistant": false}'::jsonb,
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------- users and staff --

create table if not exists bg_profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  display_name   text not null default '',
  phone          text,
  address        text,
  is_super_admin boolean not null default false,     -- platform owner, sees all bg_tenants
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists bg_tenant_members (
  tenant_id  uuid not null references bg_tenants(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'staff' check (role in ('owner', 'admin', 'staff')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists bg_idx_tenant_members_user on bg_tenant_members(user_id);

-- ------------------------------------------------------------------- menu --

create table if not exists bg_categories (
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references bg_tenants(id) on delete cascade,
  key        text not null,
  label      jsonb not null default '{}'::jsonb,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, key),
  unique (tenant_id, id)
);

create table if not exists bg_menu_items (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references bg_tenants(id) on delete cascade,
  category_id  bigint not null,
  name         jsonb not null default '{}'::jsonb,
  description  jsonb not null default '{}'::jsonb,
  price        numeric(10,2) not null check (price >= 0),
  image_url    text,
  bg_image_url text,                                 -- menu card layer 1
  food_png_url text,                                 -- menu card layer 3
  model_url    text,                                 -- .glb for the 3D / AR viewer
  is_offer     boolean not null default false,
  is_available boolean not null default true,
  popularity   int not null default 0,
  calories     int,
  rating       numeric(2,1) check (rating between 0 and 5),
  sort_order   int not null default 0,
  created_at   timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, category_id) references bg_categories (tenant_id, id) on delete restrict
);
create index if not exists bg_idx_menu_items_tenant_cat on bg_menu_items(tenant_id, category_id);

-- Scroll-scrubbed videos: slots are hero, pop1, pop2, pop3 (and more later).
create table if not exists bg_tenant_media (
  tenant_id  uuid not null references bg_tenants(id) on delete cascade,
  slot       text not null check (slot ~ '^[a-z0-9_]{1,20}$'),
  video_url  text,
  poster_url text,
  version    bigint not null default 0,              -- cache-buster, bumped on upload
  updated_at timestamptz not null default now(),
  primary key (tenant_id, slot)
);

-- Dine-in tables. `token` goes in the table's QR code so a scan fills in the table.
create table if not exists bg_dining_tables (
  id        bigint generated always as identity primary key,
  tenant_id uuid not null references bg_tenants(id) on delete cascade,
  label     text not null,
  token     text not null unique default encode(gen_random_bytes(9), 'hex'),
  is_active boolean not null default true,
  unique (tenant_id, label)
);

-- ----------------------------------------------------------------- orders --

create table if not exists bg_orders (
  id               bigint generated always as identity primary key,
  tenant_id        uuid not null references bg_tenants(id) on delete restrict,
  user_id          uuid references auth.users(id) on delete set null,
  order_number     text,                              -- set by trigger, e.g. RH-260928-0042
  order_type       text not null check (order_type in ('dine_in', 'pickup', 'delivery')),
  table_label      text,
  customer_name    text not null,
  customer_phone   text,
  customer_email   text,
  delivery_address text,
  status           text not null default 'pending'
                   check (status in ('pending', 'confirmed', 'preparing', 'ready', 'completed', 'cancelled')),
  payment_status   text not null default 'unpaid' check (payment_status in ('unpaid', 'paid', 'refunded')),
  payment_method   text,
  channel          text not null default 'web'
                   check (channel in ('web', 'whatsapp', 'instagram', 'facebook', 'assistant')),
  subtotal         numeric(10,2) not null default 0,
  delivery_fee     numeric(10,2) not null default 0,
  total            numeric(10,2) not null default 0,
  currency         text not null default 'USD',
  notes            text,
  order_token      uuid not null default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, order_number),
  check (order_type <> 'dine_in'  or coalesce(trim(table_label), '') <> ''),
  check (order_type <> 'delivery' or coalesce(trim(delivery_address), '') <> ''),
  check (order_type <> 'delivery' or coalesce(trim(customer_phone), '') <> '')
);
create unique index if not exists bg_idx_orders_token on bg_orders(order_token);
create index if not exists bg_idx_orders_tenant_created on bg_orders(tenant_id, created_at desc);
create index if not exists bg_idx_orders_tenant_status on bg_orders(tenant_id, status);
create index if not exists bg_idx_orders_user on bg_orders(user_id);

create table if not exists bg_order_items (
  id            bigint generated always as identity primary key,
  tenant_id     uuid not null,
  order_id      bigint not null,
  menu_item_id  bigint,
  name_snapshot text not null,
  unit_price    numeric(10,2) not null,
  quantity      int not null check (quantity > 0),
  line_total    numeric(10,2) not null,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, order_id) references bg_orders (tenant_id, id) on delete cascade
);
create index if not exists bg_idx_order_items_order on bg_order_items(order_id);

create table if not exists bg_cart_items (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  menu_item_id bigint not null,
  quantity     int not null check (quantity > 0),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, user_id, menu_item_id),
  foreign key (tenant_id, menu_item_id) references bg_menu_items (tenant_id, id) on delete cascade
);
create index if not exists bg_idx_cart_items_user on bg_cart_items(tenant_id, user_id);

-- ---------------------------------------------------------- order numbers --
-- <PREFIX>-<YYMMDD>-<NNNN>: the date is in the tenant's timezone and NNNN
-- counts that tenant's orders for that day, starting at 0001. The counter row
-- is incremented with an atomic upsert, so concurrent orders never collide.

create table if not exists bg_order_counters (
  tenant_id uuid not null references bg_tenants(id) on delete cascade,
  day       date not null,
  last      int  not null default 0,
  primary key (tenant_id, day)
);

create or replace function bg_set_order_number() returns trigger
language plpgsql as $$
declare
  t record;
  d date;
  n int;
begin
  select order_prefix, timezone, currency into t from bg_tenants where id = new.tenant_id;
  if not found then
    raise exception 'unknown tenant %', new.tenant_id;
  end if;
  d := (coalesce(new.created_at, now()) at time zone t.timezone)::date;
  insert into bg_order_counters (tenant_id, day, last) values (new.tenant_id, d, 1)
    on conflict (tenant_id, day) do update set last = bg_order_counters.last + 1
    returning last into n;
  new.order_number := t.order_prefix || '-' || to_char(d, 'YYMMDD') || '-' || lpad(n::text, 4, '0');
  new.currency := t.currency;          -- always the tenant's currency, never client-supplied
  return new;
end $$;

drop trigger if exists trg_set_order_number on bg_orders;
create trigger trg_set_order_number before insert on bg_orders
  for each row execute function bg_set_order_number();

create or replace function bg_touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists trg_orders_touch on bg_orders;
create trigger trg_orders_touch before update on bg_orders
  for each row execute function bg_touch_updated_at();
drop trigger if exists trg_profiles_touch on bg_profiles;
create trigger trg_profiles_touch before update on bg_profiles
  for each row execute function bg_touch_updated_at();
drop trigger if exists trg_settings_touch on bg_tenant_settings;
create trigger trg_settings_touch before update on bg_tenant_settings
  for each row execute function bg_touch_updated_at();

-- -------------------------------------------------------------------- RLS --

create or replace function bg_is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from bg_profiles where id = auth.uid()), false);
$$;

create or replace function bg_is_tenant_staff(tid uuid, roles text[] default array['owner', 'admin', 'staff'])
returns boolean language sql stable security definer set search_path = public as $$
  select bg_is_super_admin() or exists (
    select 1 from bg_tenant_members
    where tenant_id = tid and user_id = auth.uid() and role = any (roles));
$$;

alter table bg_tenants         enable row level security;
alter table bg_tenant_domains  enable row level security;
alter table bg_tenant_settings enable row level security;
alter table bg_profiles        enable row level security;
alter table bg_tenant_members  enable row level security;
alter table bg_categories      enable row level security;
alter table bg_menu_items      enable row level security;
alter table bg_tenant_media    enable row level security;
alter table bg_dining_tables   enable row level security;
alter table bg_orders          enable row level security;
alter table bg_order_items     enable row level security;
alter table bg_cart_items      enable row level security;
alter table bg_order_counters  enable row level security;   -- no policies: server only

-- Public storefront data (only for active tenants).
drop policy if exists "public read tenants" on bg_tenants;
create policy "public read tenants" on bg_tenants for select using (status = 'active');
drop policy if exists "public read domains" on bg_tenant_domains;
create policy "public read domains" on bg_tenant_domains for select using (true);
drop policy if exists "public read settings" on bg_tenant_settings;
create policy "public read settings" on bg_tenant_settings for select
  using (exists (select 1 from bg_tenants t where t.id = tenant_id and t.status = 'active'));
drop policy if exists "public read categories" on bg_categories;
create policy "public read categories" on bg_categories for select
  using (exists (select 1 from bg_tenants t where t.id = tenant_id and t.status = 'active'));
drop policy if exists "public read menu" on bg_menu_items;
create policy "public read menu" on bg_menu_items for select
  using (exists (select 1 from bg_tenants t where t.id = tenant_id and t.status = 'active'));
drop policy if exists "public read media" on bg_tenant_media;
create policy "public read media" on bg_tenant_media for select
  using (exists (select 1 from bg_tenants t where t.id = tenant_id and t.status = 'active'));

-- Staff manage their own tenant's data.
do $$
declare tbl text;
begin
  foreach tbl in array array['bg_categories', 'bg_menu_items', 'bg_tenant_media', 'bg_dining_tables', 'bg_tenant_settings'] loop
    execute format('drop policy if exists "staff manage %1$s" on %1$I', tbl);
    execute format(
      'create policy "staff manage %1$s" on %1$I for all
         using (bg_is_tenant_staff(tenant_id, array[''owner'', ''admin'']))
         with check (bg_is_tenant_staff(tenant_id, array[''owner'', ''admin'']))', tbl);
  end loop;
end $$;

drop policy if exists "staff read tables" on bg_dining_tables;
create policy "staff read tables" on bg_dining_tables for select using (bg_is_tenant_staff(tenant_id));

-- Profiles: own row, or any row for a super admin.
drop policy if exists "own profile read" on bg_profiles;
create policy "own profile read" on bg_profiles for select using (auth.uid() = id or bg_is_super_admin());
drop policy if exists "own profile update" on bg_profiles;
create policy "own profile update" on bg_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id and is_super_admin = (select p.is_super_admin from bg_profiles p where p.id = auth.uid()));

drop policy if exists "own memberships read" on bg_tenant_members;
create policy "own memberships read" on bg_tenant_members for select
  using (user_id = auth.uid() or bg_is_tenant_staff(tenant_id, array['owner']));

-- Orders: the customer sees their own, staff see (and update) their tenant's.
drop policy if exists "customer reads own orders" on bg_orders;
create policy "customer reads own orders" on bg_orders for select
  using (auth.uid() = user_id or bg_is_tenant_staff(tenant_id));
drop policy if exists "staff update orders" on bg_orders;
create policy "staff update orders" on bg_orders for update
  using (bg_is_tenant_staff(tenant_id)) with check (bg_is_tenant_staff(tenant_id));

drop policy if exists "read order items" on bg_order_items;
create policy "read order items" on bg_order_items for select using (
  bg_is_tenant_staff(tenant_id) or exists (
    select 1 from bg_orders o where o.id = bg_order_items.order_id and o.user_id = auth.uid()));

drop policy if exists "own cart" on bg_cart_items;
create policy "own cart" on bg_cart_items for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Order creation, profile creation and tenant setup go through the server
-- (service_role); no public insert policies are granted on orders/order_items.