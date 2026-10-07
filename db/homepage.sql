-- BiteGrow: homepage settings + 3D models for the seed restaurant "Red House".
-- No schema change: everything lives in bg_tenant_settings.features (jsonb). Safe to re-run.
--
--   heroMode      'both' (plays by itself AND the visitor can drag / scroll it) | 'auto' | 'manual'
--   heroSpeed     1-10, 4 = normal video speed (also sets how far a drag moves the Special videos)
--   topPick       false hides the Top pick (3D) section; omit or true shows it when a dish has a model
--   topPickItemId id of the dish to feature; omit to use the best-rated dish that has a 3D model
--
-- The admin panel will edit these same keys.

update bg_tenant_settings
set features = features || '{"heroMode": "both", "heroSpeed": 4, "topPick": true}'::jsonb
where tenant_id = (select id from bg_tenants where slug = 'redhouse');

-- 3D models. model_url is a file name in public/models, or a full https:// URL once models are uploaded to storage.
-- model-3.glb is "Ricechicken" and is the lightest file (1.9 MB), so it goes on Butter Chicken.
update bg_menu_items set model_url = 'model-3.glb'
where tenant_id = (select id from bg_tenants where slug = 'redhouse') and name->>'en' = 'Butter Chicken';

-- Other models: set the dish each one shows (model-4 is a plate of potato, mushroom, bread and eggs):
-- update bg_menu_items set model_url = 'model-1.glb'
-- where tenant_id = (select id from bg_tenants where slug = 'redhouse') and name->>'en' = '<dish name>';
