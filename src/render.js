'use strict';
// Server-side rendering of the storefront.
//
// The menu is never bundled with the app: every request is for one tenant
// (req.tenant), and its categories, items and videos are read from the database
// here, turned into HTML on the server and placed into public/index.html. The
// browser receives a page that already shows the popular row, the category chips
// and the menu, so nothing waits on a second request or on JavaScript to draw them.
//
// Cost control: one database round trip (three parallel queries) per tenant per
// ttlMs, shared by all visitors and all languages; the rendered page is also cached
// per tenant + language. Call invalidate(tenantId) after an admin changes the menu.

const fs = require('fs');
const path = require('path');

const FOOD_FALLBACK = 'img/food.png';   // shared placeholder artwork, not menu data

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);

// JSON that is safe inside an inline <script>.
const jsonForScript = (v) => JSON.stringify(v)
  .replace(/</g, '\\u003c')
  .replace(/\u2028/g, '\\u2028')
  .replace(/\u2029/g, '\\u2029');

// {"en": "..", "ar": ".."} -> text for the visitor's language, falling back to the tenant's default.
function pick(map, lang, defaultLang) {
  if (!map || typeof map !== 'object') return '';
  return map[lang] || map[defaultLang] || map.en || Object.values(map).find(Boolean) || '';
}

// Database rows -> the shape the browser script works with.
function shapeMenu({ categories, items }, lang, defaultLang) {
  const keyById = new Map(categories.map((c) => [c.id, c.key]));
  return {
    categories: categories.map((c) => ({ id: c.key, label: pick(c.label, lang, defaultLang) })),
    items: items
      .filter((i) => keyById.has(i.category_id))
      .map((i) => ({
        id: i.id,
        cat: keyById.get(i.category_id),
        name: pick(i.name, lang, defaultLang),
        desc: pick(i.description, lang, defaultLang),
        price: Number(i.price),
        rating: i.rating == null ? 0 : Number(i.rating),
        cal: i.calories == null ? null : Number(i.calories),
        popularity: i.popularity || 0,
        offer: !!i.is_offer,
        img: i.image_url || null,        // main photo
        bg: i.bg_image_url || null,      // menu card layer 1
        png: i.food_png_url || null,     // menu card layer 3
        model: i.model_url || null,      // .glb for 3D / AR
      })),
  };
}

// bg_tenant_media rows -> { hero: { src, poster }, pop1: { .. } }. Only slots the tenant has uploaded.
function buildVideos(rows) {
  const out = {};
  const ver = (url, v) => (url ? `${url}${url.includes('?') ? '&' : '?'}v=${Number(v) || 0}` : null);
  for (const r of rows || []) {
    if (!r.video_url && !r.poster_url) continue;
    out[r.slot] = { src: ver(r.video_url, r.version), poster: ver(r.poster_url, r.version) };
  }
  return out;
}

const metaPixel = (id) => `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${id}');fbq('track','PageView');</script>\n`;

const money = (symbol, n) => `${symbol}${Number(n).toFixed(2)}`;
const corner = (p) => `<svg class="corner ${p}" viewBox="0 0 48 48" aria-hidden="true"><use href="#rh-corner"/></svg>`;

// Same markup the browser script produces, so the script can take over without a visual change.
function renderSections(menu, { currency, cardBg, videos }) {
  const chips = [{ id: 'all', label: 'All' }, ...menu.categories]
    .map((c) => `<button class="chip${c.id === 'all' ? ' on' : ''}" data-c="${esc(c.id)}">${esc(c.label)}</button>`)
    .join('');

  const list = menu.items.map((i) => {
    const bg = i.bg || cardBg;
    return `<article class="row" data-id="${i.id}" data-cat="${esc(i.cat)}">
      ${bg ? `<img class="bg" src="${esc(bg)}" alt="" loading="lazy" decoding="async">` : ''}
      <div class="card">${corner('tl')}${corner('tr')}${corner('bl')}${corner('br')}
        <svg class="flourish" viewBox="0 0 120 24" aria-hidden="true"><use href="#rh-flourish"/></svg>
        <h3 class="name">${esc(i.name)}</h3><p class="price">${esc(money(currency, i.price))}</p>
      </div>
      ${i.offer ? '<span class="offer">OFFER</span>' : ''}
      <div class="food"><img src="${esc(i.png || i.img || FOOD_FALLBACK)}" alt="" loading="lazy" decoding="async"></div>
      <button class="open" type="button" aria-label="${esc(i.name)}"></button>
      <button class="add" type="button">Add to cart</button>
    </article>`;
  }).join('');

  const popular = [...menu.items]
    .sort((a, b) => b.rating - a.rating || b.popularity - a.popularity)
    .slice(0, 3)
    .map((i, n) => {
      const slot = `pop${n + 1}`;
      const poster = videos[slot] && videos[slot].poster;
      return `<div class="pop" data-id="${i.id}" data-slot="${slot}">
    <div class="vid">
      <video${poster ? ` poster="${esc(poster)}"` : ''} muted playsinline preload="none" aria-hidden="true"></video>
      <div class="hint"><i>‹</i><span>Drag</span><i>›</i></div>
      <div class="scrub"><b></b></div>
    </div>
    <p class="nm">${esc(i.name)}</p>
    <p class="pr">${esc(money(currency, i.price))}</p>
  </div>`;
    })
    .join('');

  return { chips, list, popular };
}

// A model_url is either a file in public/models ("model-3.glb") or a full URL (uploaded to storage).
const modelSrc = (m) => (/^(https?:)?\/\//.test(m) || m.startsWith('/') ? m : `models/${m}`);

// The "Top pick" 3D feature. Optional per restaurant: features.topPick === false switches it off, and
// features.topPickItemId chooses the dish. Without a choice it is the best-rated dish that has a 3D model.
// A restaurant with no 3D models gets no section at all.
function chooseTopPick(menu, features = {}) {
  if (features.topPick === false) return null;
  const withModel = menu.items.filter((i) => i.model);
  if (!withModel.length) return null;
  const chosen = withModel.find((i) => i.id === Number(features.topPickItemId));
  if (chosen) return chosen;
  return [...withModel].sort((a, b) => b.rating - a.rating || b.popularity - a.popularity)[0];
}

function renderTopPick(item, { currency }) {
  if (!item) return '';
  const poster = item.png || item.img || FOOD_FALLBACK;
  return `<section class="section" id="toppick">
    <div class="sec-head"><h2>Top pick</h2><span class="sub">Tap to view in 3D</span></div>
    <div class="tp" data-id="${item.id}" data-model="${esc(modelSrc(item.model))}">
      <div class="tp-stage"><img src="${esc(poster)}" alt="${esc(item.name)}" loading="lazy" decoding="async"><button class="tp-3d" type="button">View in 3D</button></div>
      <div class="tp-info"><p class="nm">${esc(item.name)}</p><p class="pr">${esc(money(currency, item.price))}</p></div>
    </div>
  </section>`;
}

// Replace one anchor in the template. A missing anchor is a deployment bug, so it fails loudly.
function swap(html, anchor, replacement) {
  if (!html.includes(anchor)) throw new Error(`index.html is missing expected markup: ${anchor}`);
  return html.replace(anchor, () => replacement);
}

// Same as swap(), but the anchor is a pattern, so the template's placeholder content can change freely.
function swapRe(html, re, replacement) {
  if (!re.test(html)) throw new Error(`index.html is missing expected markup: ${re}`);
  return html.replace(re, () => replacement);
}

function createStorefront({
  supabase,
  templatePath = path.join(__dirname, '..', 'public', 'index.html'),
  ttlMs = 30_000,
  now = Date.now,
  reloadTemplate = false,           // true in development: pick up index.html edits without a restart
}) {
  let template = null;
  const getTemplate = () => (template && !reloadTemplate ? template : (template = fs.readFileSync(templatePath, 'utf8')));

  const dataCache = new Map();      // tenantId -> { at, p }
  const pageCache = new Map();      // tenantId:lang -> { at, tenant, html }

  // Rows for one tenant. Concurrent callers share the same in-flight promise.
  function load(tenantId) {
    const hit = dataCache.get(tenantId);
    if (hit && now() - hit.at < ttlMs) return hit.p;
    const p = (async () => {
      const [cats, items, media] = await Promise.all([
        supabase.from('bg_categories').select('id, key, label, sort_order').eq('tenant_id', tenantId)
          .order('sort_order', { ascending: true }).order('id', { ascending: true }),
        supabase.from('bg_menu_items')
          .select('id, category_id, name, description, price, image_url, bg_image_url, food_png_url, model_url, is_offer, popularity, calories, rating, sort_order')
          .eq('tenant_id', tenantId).eq('is_available', true)
          .order('sort_order', { ascending: true }).order('id', { ascending: true }),
        supabase.from('bg_tenant_media').select('slot, video_url, poster_url, version').eq('tenant_id', tenantId),
      ]);
      for (const r of [cats, items, media]) if (r.error) throw r.error;     // errors are not cached
      return { categories: cats.data || [], items: items.data || [], media: media.data || [] };
    })();
    dataCache.set(tenantId, { at: now(), p });
    p.catch(() => { if (dataCache.get(tenantId) && dataCache.get(tenantId).p === p) dataCache.delete(tenantId); });
    return p;
  }

  async function menuFor(tenant, lang) {
    const rows = await load(tenant.id);
    return { menu: shapeMenu(rows, lang, tenant.defaultLang), videos: buildVideos(rows.media) };
  }

  async function renderPage(tenant, lang, config) {
    const key = `${tenant.id}:${lang}`;
    const hit = pageCache.get(key);
    // `tenant` is a fresh object whenever the resolver reloads settings, so a settings change also busts this.
    if (hit && hit.tenant === tenant && now() - hit.at < ttlMs) return hit.html;

    const { menu, videos } = await menuFor(tenant, lang);
    const s = tenant.settings;
    const parts = renderSections(menu, { currency: tenant.currencySymbol, cardBg: s.cardBgUrl, videos });

    let html = getTemplate();
    html = swap(html, '<html lang="en">', `<html lang="${esc(lang)}">`);
    html = swap(html, '<title>Red House — Demo</title>', `<title>${esc(s.pageTitle)}</title>`);
    // Logo: full width across the top. A restaurant without a logo gets its name in the same place.
    html = swapRe(html, /<header class="logo-banner">[\s\S]*?<\/header>/,
      s.logoUrl
        ? `<header class="logo-banner"><img class="logo" src="${esc(s.logoUrl)}" alt="${esc(s.brandName)}" fetchpriority="high" decoding="async"></header>`
        : `<header class="logo-banner"><span class="brand">${esc(s.brandName)}</span></header>`);
    // Hero cover: the first frame is in the HTML itself (poster) and is preloaded, so it shows before any script or video arrives.
    const cover = (videos.hero && videos.hero.poster) || 'videos/hero.jpg';
    html = swap(html, 'poster="videos/hero.jpg"', `poster="${esc(cover)}"`);
    html = swap(html, '<!--HEAD_EXTRA-->', `<link rel="preload" as="image" href="${esc(cover)}" fetchpriority="high">`);
    html = swap(html, '<!--TOP_PICK-->', renderTopPick(chooseTopPick(menu, s.features), { currency: tenant.currencySymbol }));
    html = swap(html, '<div class="pop-row" id="popRow"></div>', `<div class="pop-row" id="popRow">${parts.popular}</div>`);
    html = swap(html, '<div class="chips" id="chips"></div>', `<div class="chips" id="chips">${parts.chips}</div>`);
    html = swap(html, '<div id="list"></div>', `<div id="list">${parts.list}</div>`);
    html = swap(html, '<script src="menu-data.js"></script>',
      `<script>window.CONFIG=${jsonForScript({ ...config, lang })};window.MENU=${jsonForScript(menu)};window.VIDEOS=${jsonForScript(videos)};</script>`);

    // Optional per-restaurant extras. Both ids are validated (digits only) before they reach the tenant object.
    const ig = tenant.integrations || {};
    if (ig.metaPixelId) html = swap(html, '</head>', metaPixel(ig.metaPixelId) + '</head>');
    if (config && config.assistant) html = swap(html, '</body>', '<script src="assistant.js" defer></script>\n</body>');

    pageCache.set(key, { at: now(), tenant, html });
    return html;
  }

  const invalidate = (tenantId) => {
    if (!tenantId) { dataCache.clear(); pageCache.clear(); return; }
    dataCache.delete(tenantId);
    for (const k of pageCache.keys()) if (k.startsWith(tenantId + ':')) pageCache.delete(k);
  };

  return { renderPage, menuFor, invalidate };
}

module.exports = { createStorefront, shapeMenu, buildVideos, renderSections, chooseTopPick, renderTopPick, modelSrc, pick, esc, jsonForScript };