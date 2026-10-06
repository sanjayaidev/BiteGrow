-- BiteGrow seed: first tenant "Red House" with 10 sample menu items.
-- Run after 001_bg_core_multitenant.sql. Safe to re-run: existing rows are kept,
-- missing ones are added (menu items are matched on tenant + English name).
--
-- Images are NOT set here. Save each item's image URL in the database:
--   update bg_menu_items set image_url = 'https://...'      -- main photo / food PNG
--   where tenant_id = (select id from bg_tenants where slug = 'redhouse')
--     and name->>'en' = 'Veg Samosa';
-- (bg_image_url = card background, food_png_url = transparent PNG layer, model_url = .glb)
-- Any item left empty falls back to the default food image, and the card
-- background falls back to bg_tenant_settings.card_bg_url.

begin;

insert into bg_tenants (slug, name, timezone, currency, currency_symbol, default_lang, languages, order_prefix)
values ('redhouse', 'Red House', 'Asia/Kolkata', 'INR', '₹', 'en', array['en'], 'RH')
on conflict (slug) do nothing;

-- localhost resolves to this tenant for local development.
insert into bg_tenant_domains (domain, tenant_id, is_primary)
select 'localhost', id, false from bg_tenants where slug = 'redhouse'
on conflict (domain) do nothing;

insert into bg_tenant_settings
  (tenant_id, brand_name, page_title, card_bg_url, phone, whatsapp_number, delivery_fee, order_types, features)
select id, 'RED HOUSE', 'Red House', 'img/wood.png',
       '+91 75047 04502', '917504704502', 0,
       array['dine_in', 'pickup', 'delivery'],
       '{"ar3d": true, "whatsappOrder": true, "assistant": false}'::jsonb
from bg_tenants where slug = 'redhouse'
on conflict (tenant_id) do nothing;

-- Categories
insert into bg_categories (tenant_id, key, label, sort_order)
select t.id, v.key, v.label::jsonb, v.sort_order
from bg_tenants t,
(values
  ('snacks',  '{"en":"Snacks"}',       1),
  ('south',   '{"en":"South Indian"}', 2),
  ('chinese', '{"en":"Chinese"}',      3),
  ('italian', '{"en":"Italian"}',      4),
  ('mains',   '{"en":"Main Course"}',  5),
  ('bakery',  '{"en":"Bakery"}',       6)
) as v(key, label, sort_order)
where t.slug = 'redhouse'
on conflict (tenant_id, key) do nothing;

-- Menu items: (category, name, description, price INR, calories, rating, is_offer, sort)
insert into bg_menu_items
  (tenant_id, category_id, name, description, price, calories, rating, is_offer, sort_order)
select t.id, c.id, jsonb_build_object('en', v.name), jsonb_build_object('en', v.descr),
       v.price, v.cal, v.rating, v.offer, v.sort
from bg_tenants t
join (values
  ('snacks',  'Veg Samosa',         'Crispy pastry stuffed with spiced potato and peas, served with mint and tamarind chutney',  40, 260, 4.6, false,  1),
  ('snacks',  'Veg Momos',          'Steamed dumplings filled with cabbage, carrot and herbs, served with spicy red chutney',     99, 320, 4.5, true,   2),
  ('south',   'Idli Sambar',        'Soft steamed rice cakes with hot sambar and coconut chutney',                                60, 210, 4.4, false,  3),
  ('chinese', 'Hakka Noodles',      'Wok-tossed noodles with crunchy vegetables, garlic and soy',                                120, 480, 4.3, false,  4),
  ('italian', 'Margherita Pizza',   'Hand-stretched base, tomato sauce, fresh mozzarella and basil',                             249, 780, 4.7, true,   5),
  ('italian', 'Penne Pasta',        'Penne in creamy white sauce with herbs and cheese',                                         180, 620, 4.2, false,  6),
  ('mains',   'Butter Naan',        'Tandoor-baked soft bread brushed with butter',                                               45, 260, 4.5, false,  7),
  ('mains',   'Paneer Butter Masala','Cottage cheese cubes in a rich tomato-butter gravy',                                       220, 560, 4.8, false,  8),
  ('mains',   'Butter Chicken',     'Tender tandoori chicken in a creamy tomato gravy',                                          280, 690, 4.9, false,  9),
  ('bakery',  'Chocolate Pastry',   'Soft sponge layered with rich chocolate cream and ganache',                                  85, 340, 4.4, false, 10)
) as v(cat, name, descr, price, cal, rating, offer, sort) on true
join bg_categories c on c.tenant_id = t.id and c.key = v.cat
where t.slug = 'redhouse'
  and not exists (
    select 1 from bg_menu_items x where x.tenant_id = t.id and x.name->>'en' = v.name);

-- Scroll-scrubbed videos (hero + 3 popular)
insert into bg_tenant_media (tenant_id, slot, video_url, poster_url, version)
select t.id, s.slot, 'videos/' || s.slot || '.mp4', 'videos/' || s.slot || '.jpg', 1
from bg_tenants t, (values ('hero'), ('pop1'), ('pop2'), ('pop3')) as s(slot)
where t.slug = 'redhouse'
on conflict (tenant_id, slot) do nothing;

-- Dine-in tables 1-10 (each gets a QR token automatically)
insert into bg_dining_tables (tenant_id, label)
select t.id, n::text from bg_tenants t, generate_series(1, 10) n
where t.slug = 'redhouse'
on conflict (tenant_id, label) do nothing;

commit;
