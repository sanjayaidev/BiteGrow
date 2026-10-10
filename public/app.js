(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const CFG = window.CONFIG || {}, FEAT = CFG.features || {};
if (CFG.pageTitle) document.title = CFG.pageTitle;
const brandEl = $('.brand');
if (CFG.brand && brandEl) brandEl.textContent = CFG.brand;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);
const money = n => (CFG.currency || '$') + Number(n).toFixed(2);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { categories, items } = window.MENU;
const byId = id => items.find(i => i.id === id);
const FOOD = 'img/food.png';
const img = i => i.img || i.png || FOOD;                  // main photo: item sheet, 3D poster
const modelSrc = m => (/^(https?:)?\/\/|^\//.test(m) ? m : 'models/' + m);   // file in /models or a full URL
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= HERO / SCRUB SETTINGS (set per restaurant in admin: features.heroMode, features.heroSpeed) =================
   heroMode  'both' (default): plays by itself and the visitor can drag / scroll it
             'auto'          : plays by itself only
             'manual'        : drag / scroll only
   heroSpeed 1-10 (4 = normal video speed). Drag: how much of a video one full-width drag covers (4 = 48%, 10 = 120%).
   Wheel / trackpad: scales the step per notch (4 = normal). */
const HERO_MODE = ['auto', 'manual', 'both'].includes(FEAT.heroMode) ? FEAT.heroMode : 'both';
const AUTO = HERO_MODE !== 'manual', MANUAL = HERO_MODE !== 'auto';
let speedUI = clamp(Math.round(Number(FEAT.heroSpeed)) || 4, 1, 10);
// The visitor's own Speed slider (Special section) wins over the restaurant's default, and is remembered on this device.
try { const s = Math.round(Number(localStorage.getItem('bg_speed'))); if (s >= 1 && s <= 10) speedUI = s; } catch (_) {}
const speedEl = $('#speed'), speedOut = $('#speedVal');
if (speedEl) {
  speedEl.value = speedUI; speedOut.textContent = speedUI;
  speedEl.addEventListener('input', () => {
    speedUI = clamp(Math.round(Number(speedEl.value)) || 4, 1, 10);
    speedOut.textContent = speedUI;
    try { localStorage.setItem('bg_speed', String(speedUI)); } catch (_) {}
  });
}
const dragGain = () => speedUI * 0.12;
const wheelMul = () => speedUI / 4;

/* ================= VIDEO SOURCES =================
   URLs come from the server with a version (?v=mtime). The browser caches videos for a year, and a
   replaced clip gets a new version, so only that clip is downloaded again. */
const VIDS = window.VIDEOS || {};
// The Special cards (pop1..pop5) share the one "special" clip the restaurant uploads; the bundled pop clips are the fallback.
const vSrc = k => (VIDS[k] && VIDS[k].src) || (k.startsWith('pop') && VIDS.special && VIDS.special.src) || `videos/${k}.mp4`;
const vPoster = k => (VIDS[k] && VIDS[k].poster) || (k.startsWith('pop') && VIDS.special && VIDS.special.poster) || `videos/${k}.jpg`;

/* Horizontal drag for touch AND mouse. Vertical movement is never captured, so the page always scrolls. */
function dragScrub(el, { canStart, start, move, flag = el }) {
  let id = null, x0 = 0, y0 = 0, base = 0, locked = false;
  el.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    delete flag.dataset.drag;
    if (canStart && !canStart()) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; base = start(); locked = false;
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - x0, dy = e.clientY - y0;
    if (!locked) {
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) { id = null; return; } // vertical gesture: leave it to the page scroll
      locked = true; flag.dataset.drag = '1'; el.classList.add('dragging');
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
    }
    move(base, dx);
  });
  const end = e => { if (e.pointerId !== id) return; id = null; locked = false; el.classList.remove('dragging'); };
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, end));
}

/* ================= HERO: video scrubs with mouse wheel (PC) or left/right drag (mobile) =================
   The page is never locked. Until the hero video is fully loaded, everything scrolls normally. */
const hero = $('#hero'), stage = $('.hero-stage'), vid = $('#heroVideo');
hero.classList.toggle('no-manual', !MANUAL);
const slides = [...hero.querySelectorAll('.slide')].map(el => ({ el, s: +el.dataset.start, e: +el.dataset.end }));
const FADE = 0.05, EASE = reduce ? 1 : 0.16;
let target = 0, cur = 0, lastT = -1, ready = false, raf = 0, holdUntil = 0;
const HERO_BOOST = 2;            // hero drag / wheel is this many times faster than the Speed slider alone
let autoPauseUntil = 0, lastAuto = 0;

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
scrollTo(0, 0);

function setSlides(p) {
  slides.forEach((x, i) => {
    const last = i === slides.length - 1;
    const a = i === 0 ? 1 : smooth(clamp((p - x.s) / FADE, 0, 1));
    const b = last ? 1 : 1 - smooth(clamp((p - x.e) / FADE, 0, 1));
    const o = Math.min(a, b);
    x.el.style.opacity = o;
    x.el.style.transform = `translateY(${(1 - o) * 14}px)`;
    x.el.classList.toggle('on', o > .5);
  });
}

// Returns true once the video has been asked for this position. If a previous seek is still in
// flight it returns false, and tick() keeps running until the final position is really requested
// (otherwise a fast swipe could end on a stale frame).
function seek(p) {
  if (!vid.duration) return true;
  const t = clamp(p, 0, 1) * (vid.duration - 0.04);
  if (Math.abs(t - lastT) < 0.008) return true;
  if (vid.seeking) return false;
  lastT = t;
  vid.fastSeek ? vid.fastSeek(t) : (vid.currentTime = t);
  return true;
}

function tick() {
  raf = 0;
  cur += (target - cur) * EASE;
  if (Math.abs(target - cur) < 0.0004) cur = target;
  const settled = seek(cur); setSlides(cur);
  if (cur !== target || !settled) raf = requestAnimationFrame(tick);
}

function heroTo(p) {
  target = clamp(p, 0, 1);
  hero.classList.add('used');
  if (!raf) raf = requestAnimationFrame(tick);
}

// Mobile (and mouse drag): horizontal drag scrubs. Vertical swipes scroll the page as usual.
dragScrub(stage, {
  canStart: () => ready && MANUAL,
  start: () => target,
  move: (base, dx) => heroTo(base - dx / innerWidth * dragGain() * HERO_BOOST)
});

// PC: mouse wheel scrubs while the page is at the top. At either end of the video the wheel
// goes back to scrolling the page, so you can never get stuck.
addEventListener('wheel', e => {
  if (!MANUAL || !ready || e.ctrlKey || scrollY > 2 || document.querySelector('.sheet.open')) return;
  let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  if (e.deltaMode === 1) d *= 33; else if (e.deltaMode === 2) d *= innerHeight;
  const now = performance.now();
  if (now < holdUntil) { e.preventDefault(); return; }          // absorb trackpad inertia right after reaching an end
  if ((d > 0 && target >= 1) || (d < 0 && target <= 0)) return; // at an end: let the page scroll
  e.preventDefault();
  autoPauseUntil = now + 2500;
  const np = clamp(target + d / 2500 * wheelMul() * HERO_BOOST, 0, 1);
  if (np === 1 || np === 0) holdUntil = now + 350;
  heroTo(np);
}, { passive: false });

// Auto-play: once loaded, the hero advances by itself. At Speed 4 it plays at normal video speed
// (the Speed slider scales it). It pauses while the visitor touches / drags / wheels the hero,
// resumes after 2.5 s idle, loops back to the start at the end, and never runs for reduced-motion users.
if (MANUAL) {
  stage.addEventListener('pointerdown', () => { autoPauseUntil = Infinity; });
  ['pointerup', 'pointercancel'].forEach(ev => stage.addEventListener(ev, () => { autoPauseUntil = performance.now() + 2500; }));
}

function autoStep(ts) {
  requestAnimationFrame(autoStep);
  const dt = lastAuto ? Math.min((ts - lastAuto) / 1000, 0.1) : 0;
  lastAuto = ts;
  if (!AUTO || reduce || !ready || !vid.duration) return;
  if (scrollY > 2 || document.hidden || ts < autoPauseUntil || document.querySelector('.sheet.open')) return;
  let next = target + dt / vid.duration * (speedUI / 4);
  if (next >= 1) { next = 0; cur = 0; lastT = -1; } // loop: jump back to the first frame
  target = next;
  if (!raf) raf = requestAnimationFrame(tick);
}
requestAnimationFrame(autoStep);

function unlock() {
  if (ready) return; ready = true;
  hero.classList.add('ready');
  target = cur = 0; seek(cur); setSlides(cur);
  scheduleLive(); // hero is done, popular videos may now load
}

function meter() {
  if (!vid.duration || !vid.buffered.length) return;
  const pct = Math.round(vid.buffered.end(vid.buffered.length - 1) / vid.duration * 100);
  $('#meterLabel').textContent = 'Loading ' + pct + '%';
  $('#meterFill').style.transform = `scaleX(${pct / 100})`;
  if (pct >= 99) unlock();
}

vid.addEventListener('progress', meter);
vid.addEventListener('loadeddata', meter);
vid.addEventListener('canplaythrough', unlock);
setTimeout(unlock, 8000);
vid.poster = vPoster('hero');
vid.src = vSrc('hero');
setSlides(0);

// iOS only renders seeked frames after a video has played once; do that on the first gesture.
const kick = () => [vid, ...cards.filter(c => c.live).map(c => c.video)].forEach(v => v.play().then(() => v.pause()).catch(() => {}));
['touchstart', 'pointerdown', 'wheel'].forEach(ev => addEventListener(ev, kick, { once: true, passive: true }));

/* ================= POPULAR: 1 column x 6 rows, max 3 videos loaded at once ================= */
const chosenSpecial = (Array.isArray(FEAT.specialItemIds) ? FEAT.specialItemIds : []).map(byId).filter(Boolean);
const popItems = chosenSpecial.length ? chosenSpecial : [...items].sort((a, b) => b.rating - a.rating).slice(0, 3);
const row = $('#popRow');
const MAX_LIVE = 3;
const word = matchMedia('(pointer: coarse)').matches ? 'Swipe' : 'Drag';
row.innerHTML = popItems.map((it, i) => `
  <div class="pop" data-id="${it.id}" data-slot="pop${i % 3 + 1}">
    <div class="vid">
      <video poster="${vPoster('pop' + (i % 3 + 1))}" muted playsinline preload="none" aria-hidden="true"></video>
      <div class="hint"><i>‹</i><span>${word}</span><i>›</i></div>
      <div class="scrub"><b></b></div>
    </div>
    <p class="nm">${esc(it.name)}</p>
    <p class="pr">${money(it.price)}</p>
  </div>
`).join('');

const hintsOff = () => document.body.classList.add('hints-off');

const cards = [...row.querySelectorAll('.pop')].map(el => {
  const video = el.querySelector('video'), box = el.querySelector('.vid'), bar = el.querySelector('.scrub b');
  // pos = where the visitor left it (kept while unloaded), target = where they are steering,
  // cur = eased value actually shown. The video chases cur, so it glides instead of jumping.
  const c = { el, video, bar, slot: el.dataset.slot, pos: 0, target: 0, cur: 0, lastT: -1, raf: 0, live: false };
  const dur = () => video.duration || 0;
  const setBar = () => { bar.style.transform = `scaleX(${c.cur})`; };

  function tick() {
    c.raf = 0;
    c.cur += (c.target - c.cur) * EASE;
    if (Math.abs(c.target - c.cur) < 0.0004) c.cur = c.target;
    setBar();
    let settled = true;
    if (dur()) {
      const t = c.cur * (dur() - 0.04);
      if (Math.abs(t - c.lastT) >= 0.008) {
        if (video.seeking) settled = false;            // previous seek still running: try again next frame
        else { c.lastT = t; video.currentTime = t; }
      }
    }
    if (c.cur !== c.target || !settled) c.raf = requestAnimationFrame(tick);
  }
  c.kick = () => { if (!c.raf) c.raf = requestAnimationFrame(tick); };

  // (re)loaded: go back to where the visitor left it
  video.addEventListener('loadedmetadata', () => {
    c.cur = c.target = c.pos; c.lastT = -1; setBar();
    if (c.pos) c.kick();
  });
  // iOS needs one play/pause before seeked frames render. Afterwards, re-seek to the CURRENT
  // position (not the one from when loading finished, which would snap the video back).
  video.addEventListener('loadeddata', () => {
    video.play().then(() => { video.pause(); if (c.live) { c.lastT = -1; c.kick(); } }).catch(() => {});
  });

  const goTo = p => {
    if (!dur()) return;
    c.target = clamp(p, 0, 1); c.pos = c.target;
    hintsOff(); c.kick();
  };

  dragScrub(box, {
    flag: el,
    canStart: () => c.live && dur() > 0,
    start: () => c.target,
    move: (base, dx) => goTo(base - dx / box.clientWidth * dragGain())
  });

  // Trackpad two-finger swipe / Shift+wheel scrubs. A plain vertical wheel keeps scrolling the page.
  box.addEventListener('wheel', e => {
    if (!c.live || !dur() || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    goTo(c.target + e.deltaX / 600 * wheelMul());
  }, { passive: false });

  return c;
});

function setLive(c, on) {
  if (c.live === on) return;
  c.live = on;
  const v = c.video;
  if (on) { v.preload = 'auto'; v.src = vSrc(c.slot); }
  else {
    cancelAnimationFrame(c.raf); c.raf = 0; c.lastT = -1;
    v.pause(); v.removeAttribute('src'); v.load(); // free the decoder and memory; poster shows again
    c.bar.style.transform = 'scaleX(0)';
  }
}

// Keep only the (up to) 3 cards closest to the middle of the screen loaded.
let liveRaf = 0;
function scheduleLive() { if (!liveRaf) liveRaf = requestAnimationFrame(refreshLive); }
function refreshLive() {
  liveRaf = 0;
  if (!ready && scrollY < 40) return; // the hero gets the bandwidth first
  const vh = innerHeight, mid = vh / 2;
  const want = cards
    .map(c => { const r = c.el.getBoundingClientRect(); return { c, d: Math.abs((r.top + r.bottom) / 2 - mid), near: r.bottom > -vh * .5 && r.top < vh * 1.5 }; })
    .filter(x => x.near).sort((a, b) => a.d - b.d).slice(0, MAX_LIVE).map(x => x.c);
  cards.forEach(c => { if (!want.includes(c)) setLive(c, false); }); // release first so we never exceed the cap
  want.forEach(c => setLive(c, true));
}
addEventListener('scroll', scheduleLive, { passive: true });
addEventListener('resize', scheduleLive);
scheduleLive();

row.addEventListener('click', e => {
  const p = e.target.closest('.pop');
  if (!p || p.dataset.drag) return; // a drag is not a tap
  openItem(+p.dataset.id);
});

/* ================= MENU ================= */
let activeCat = 'all', sortBy = 'rec', query = '', offersOnly = false;
const SORTS = {
  rec: null,                                                              // the restaurant's own order
  pa: (a, b) => a.price - b.price,
  pd: (a, b) => b.price - a.price,
  rt: (a, b) => b.rating - a.rating || b.popularity - a.popularity,
  po: (a, b) => b.popularity - a.popularity || b.rating - a.rating,
};
$('#sort').addEventListener('change', e => { sortBy = SORTS[e.target.value] !== undefined ? e.target.value : 'rec'; renderList(); });
$('#q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });
const offerBtn = $('#offerOnly');
offerBtn.hidden = !items.some(i => i.offer);
offerBtn.addEventListener('click', () => { offersOnly = !offersOnly; offerBtn.setAttribute('aria-pressed', String(offersOnly)); renderList(); });
$('#chips').innerHTML = [{ id: 'all', label: 'All' }, ...categories].map(c => `<button class="chip${c.id === 'all' ? ' on' : ''}" data-c="${c.id}">${esc(c.label)}</button>`).join('');
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  activeCat = b.dataset.c;
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
  renderList();
});

function renderList() {
  const corner = p => `<svg class="corner ${p}" viewBox="0 0 48 48" aria-hidden="true"><use href="#rh-corner"/></svg>`;
  let shown = items.filter(i => (activeCat === 'all' || i.cat === activeCat)
    && (!offersOnly || i.offer)
    && (!query || (i.name + ' ' + (i.desc || '')).toLowerCase().includes(query)));
  $('#empty').hidden = shown.length > 0;
  if (SORTS[sortBy]) shown = [...shown].sort(SORTS[sortBy]);
  $('#list').innerHTML = shown.map(i => {
    const p = money(i.price), food = esc(i.png || img(i));   // layer 3 falls back to the normal photo
    return `<article class="row" data-id="${i.id}">
      ${(i.bg || CFG.cardBg) ? `<img class="bg" src="${esc(i.bg || CFG.cardBg)}" alt="" loading="lazy" decoding="async">` : ''}
      <div class="card">${corner('tl')}${corner('tr')}${corner('bl')}${corner('br')}
        <svg class="flourish" viewBox="0 0 120 24" aria-hidden="true"><use href="#rh-flourish"/></svg>
        <h3 class="name">${esc(i.name)}</h3><p class="price">${p}</p>
      </div>
      ${i.offer ? '<span class="offer">OFFER</span>' : ''}
      <div class="food"><img src="${food}" alt="" loading="lazy" decoding="async"></div>
      <button class="open" type="button" aria-label="${esc(i.name)}"></button>
      <button class="add" type="button">Add to cart</button>
    </article>`;
  }).join('');
}
$('#list').addEventListener('click', e => {
  const r = e.target.closest('.row'); if (!r) return;
  const id = +r.dataset.id;
  if (e.target.closest('.add')) addToBasket(id);
  else openItem(id);
});
renderList();

/* ================= ACCOUNT, BASKET, CHECKOUT, ORDER TRACKING =================
   Guests keep the basket in this browser; a signed-in customer's basket is saved on the server (/api/cart) and a guest
   basket is folded in at sign-in. Orders are saved by the server (POST /api/orders); WhatsApp is an optional follow-up message. */
const TYPES = CFG.orderTypes && CFG.orderTypes.length ? CFG.orderTypes : ['dine_in', 'pickup', 'delivery'];
const TYPE_LABEL = { dine_in: 'Dine-in', pickup: 'Pickup', delivery: 'Delivery' };
const store = {
  get(k, d) { try { const v = localStorage.getItem('bg_' + k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { v == null ? localStorage.removeItem('bg_' + k) : localStorage.setItem('bg_' + k, JSON.stringify(v)); } catch (_) {} },
};
let session = store.get('auth', null), me = null, tableInfo = null;
const basket = new Map((store.get('cart', []) || []).filter(([id]) => byId(id)));
const sheet = $('#sheet'), cardEl = $('#sheetCard');
let trackTimer = null, tracking = null;   // the order-status view (see "order status" below)
const open = html => { stopTrack(); $('#toast').classList.remove('show'); cardEl.innerHTML = html; sheet.classList.add('open'); cardEl.scrollTop = 0; };
const close = () => { stopTrack(); sheet.classList.remove('open'); };
sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function badge() { const n = [...basket.values()].reduce((a, b) => a + b, 0); const b = $('#badge'); b.textContent = n; b.hidden = !n; }

/* ---- API helper: adds the token, renews it when it is about to expire, retries once on 401 ---- */
function signedOut() { session = null; me = null; store.set('auth', null); }
async function refresh() {
  if (!session) return false;
  try {
    const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: session.refresh_token }) });
    if (!r.ok) throw new Error('expired');
    session = { ...session, ...(await r.json()) }; store.set('auth', session); return true;
  } catch (_) { signedOut(); return false; }
}
async function api(path, { method = 'GET', body } = {}) {
  if (session && session.expires_at && session.expires_at * 1000 - Date.now() < 60000) await refresh();
  const call = () => fetch(path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session ? { authorization: 'Bearer ' + session.access_token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let r = await call();
  if (r.status === 401 && session && await refresh()) r = await call();
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; e.data = j; throw e; }
  return j;
}

/* ---- Meta Pixel events: window.fbq exists only when the restaurant has set a Pixel ID, so without one these do nothing ---- */
const track = (event, data) => { try { if (typeof window.fbq === 'function') window.fbq('track', event, data); } catch (_) {} };
const pixelLines = lines => ({ content_type: 'product', content_ids: lines.map(([id]) => String(id)), num_items: lines.reduce((n, [, q]) => n + q, 0) });

/* ---- basket ---- */
const saveCart = () => store.set('cart', [...basket]);
function setQty(id, q) {
  const before = basket.get(id) || 0;
  q > 0 ? basket.set(id, Math.min(50, q)) : basket.delete(id);
  const item = byId(id);
  if ((basket.get(id) || 0) > before && item) track('AddToCart', { content_type: 'product', content_ids: [String(id)], content_name: item.name, value: Number(item.price), currency: CFG.currencyCode });
  saveCart(); badge();
  if (session) api('/api/cart', { method: 'POST', body: { menu_item_id: id, quantity: basket.get(id) || 0 } }).catch(() => {});
}
const addToBasket = id => { setQty(id, (basket.get(id) || 0) + 1); toast('Added to basket'); };
const cartLines = () => [...basket].filter(([id]) => byId(id));
const cartTotal = () => cartLines().reduce((s, [id, q]) => s + Math.round(byId(id).price * 100) * q, 0) / 100;
async function pullCart() {
  const c = await api('/api/cart/merge', { method: 'POST', body: { items: cartLines().map(([id, q]) => ({ menu_item_id: id, quantity: q })) } });
  basket.clear(); c.items.forEach(l => { if (l.available && byId(l.menu_item_id)) basket.set(l.menu_item_id, l.quantity); });
  saveCart(); badge();
}
async function loadMe() { try { me = await api('/api/auth/me'); } catch (_) { me = null; } return me; }
async function startSession(tokens) {
  session = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: tokens.expires_at }; store.set('auth', session);
  await loadMe(); await pullCart().catch(() => {});
}
badge();
if (session) loadMe().then(m => m && pullCart()).catch(() => {});
const tt = new URLSearchParams(location.search).get('table');
if (tt && /^[0-9a-f]{8,64}$/.test(tt)) fetch('/api/table/' + tt).then(r => r.ok ? r.json() : null).then(j => { if (j) { tableInfo = { token: tt, label: j.label }; toast('Table ' + j.label); } }).catch(() => {});

/* ---- small form helpers ---- */
const field = (id, label, o = {}) => `<label class="fl" for="${id}">${label}</label><input class="fi" id="${id}" type="${o.type || 'text'}" value="${esc(o.value || '')}" ${o.attrs || ''}>`;
const val = id => { const el = $('#' + id, cardEl); return el ? el.value.trim() : ''; };
const say = (t, ok) => { const m = $('#fmsg', cardEl); if (m) { m.textContent = t; m.className = 'fmsg' + (ok ? ' ok' : ''); } };
const MSG = '<p class="fmsg" id="fmsg" role="status"></p>';
async function run(t, fn) { t.disabled = true; try { await fn(); } catch (e) { say(e.message); } finally { t.disabled = false; } }

/* ---- item sheet ---- */
function loadViewer() {
  if (customElements.get('model-viewer') || document.getElementById('mvScript')) return;
  const sc = document.createElement('script');
  sc.type = 'module'; sc.id = 'mvScript';
  sc.src = 'https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js';
  document.head.appendChild(sc);
}
function openItem(id) {
  const i = byId(id);
  let media = `<img class="big" src="${esc(img(i))}" alt="${esc(i.name)}">`;
  if (FEAT.ar3d && i.model) {
    loadViewer();   // only fetched the first time someone opens a 3D dish
    media = `<model-viewer src="${esc(modelSrc(i.model))}" poster="${esc(img(i))}" alt="${esc(i.name)}" ar ar-modes="webxr scene-viewer quick-look" camera-controls auto-rotate shadow-intensity="1" environment-image="neutral" interaction-prompt="none"><button slot="ar-button" class="ar-btn">View on your table</button></model-viewer>`;
  }
  const facts = [i.rating ? i.rating.toFixed(1) + ' ★' : '', i.cal != null ? i.cal + ' kcal' : ''].filter(Boolean).join(' · ');
  open(`${media} <h3>${esc(i.name)}</h3> <p class="muted">${esc(i.desc)}</p> <div class="line"><span>${facts}</span><b style="color:var(--gold)">${money(i.price)}</b></div> <button class="btn" data-add="${i.id}">Add to basket</button> <button class="btn ghost" data-close>Close</button>`);
}

/* ---- basket and checkout ---- */
function openBasket() {
  const lines = cartLines();
  if (!lines.length) return open(`<h3>Your basket</h3><p class="muted">Nothing here yet. Add something from the menu.</p>${MSG}<button class="btn" data-goto="menu">Browse menu</button>${store.get('last', null) ? '<button class="btn ghost" data-act="track">Track my last order</button>' : ''}`);
  const rows = lines.map(([id, q]) => { const i = byId(id); return `<div class="line"><span>${esc(i.name)}<br><small style="color:var(--muted)">${money(i.price)}</small></span><span class="qty"><button data-dec="${id}">−</button> ${q} <button data-add="${id}" data-stay>+</button></span></div>`; }).join('');
  open(`<h3>Your basket</h3>${rows}<div class="total"><span>Total</span><span>${money(cartTotal())}</span></div>${session ? '' : '<p class="muted" style="margin:10px 0 0">Sign in to keep your basket on every device.</p>'}<button class="btn" data-checkout>Checkout</button><button class="btn ghost" data-close>Keep browsing</button>`);
}
const readForm = () => ({ name: val('c_name'), phone: val('c_phone'), addr: val('c_addr'), notes: val('c_notes'), table: val('c_table') });
function openCheckout(prev = {}) {
  if (!cartLines().length) return openBasket();
  if (!prev.type) track('InitiateCheckout', { ...pixelLines(cartLines()), value: cartTotal(), currency: CFG.currencyCode });   // not again when only the order type is switched
  const p = (me && me.profile) || {};
  const type = TYPES.includes(prev.type) ? prev.type : (tableInfo && TYPES.includes('dine_in') ? 'dine_in' : TYPES[0]);
  const sub = cartTotal(), fee = type === 'delivery' ? Number(CFG.deliveryFee || 0) : 0;
  open(`<h3>Checkout</h3>
    <div class="seg">${TYPES.map(t => `<button data-type="${t}" class="${t === type ? 'on' : ''}">${esc(TYPE_LABEL[t] || t)}</button>`).join('')}</div>
    ${type === 'dine_in' ? (tableInfo ? `<p class="muted" style="margin:12px 0 0">Table <b>${esc(tableInfo.label)}</b></p>` : field('c_table', 'Table number', { value: prev.table, attrs: 'maxlength="20"' })) : ''}
    ${field('c_name', 'Your name', { value: prev.name != null ? prev.name : p.display_name, attrs: 'autocomplete="name" maxlength="80"' })}
    ${field('c_phone', 'Phone' + (type === 'dine_in' ? ' (optional)' : ''), { type: 'tel', value: prev.phone != null ? prev.phone : p.phone, attrs: 'autocomplete="tel" maxlength="20"' })}
    ${type === 'delivery' ? field('c_addr', 'Delivery address', { value: prev.addr != null ? prev.addr : p.address, attrs: 'autocomplete="street-address" maxlength="300"' }) : ''}
    ${field('c_notes', 'Notes (optional)', { value: prev.notes, attrs: 'maxlength="300"' })}
    <div class="line"><span>Subtotal</span><span>${money(sub)}</span></div>${fee ? `<div class="line"><span>Delivery</span><span>${money(fee)}</span></div>` : ''}
    <div class="total"><span>Total</span><span>${money(sub + fee)}</span></div>${MSG}
    <button class="btn" data-act="place">Place order</button><button class="btn ghost" data-act="basket">Back to basket</button>`);
}
// The server saves the order (prices are re-read from its own menu) and, when the restaurant has WhatsApp ordering on,
// returns a ready-made message link. The customer sends that message with a tap, because browsers block pop-ups opened after a wait.
async function placeOrder() {
  const f = readForm(), type = cardEl.querySelector('[data-type].on').dataset.type;
  if (!f.name) throw new Error('Your name is required');
  if (type !== 'dine_in' && !f.phone) throw new Error('A phone number is required');
  if (f.phone && !/^[0-9+()\-\s]{7,20}$/.test(f.phone)) throw new Error('That phone number does not look right');
  if (type === 'delivery' && !f.addr) throw new Error('A delivery address is required');
  const table = type === 'dine_in' ? (tableInfo ? tableInfo.label : f.table) : '';
  if (type === 'dine_in' && !table) throw new Error('Table number is required for dine-in');
  const lines = cartLines();   // kept for the Purchase event: the basket is emptied once the order is saved
  const body = {
    order_type: type, customer_name: f.name, customer_phone: f.phone, delivery_address: type === 'delivery' ? f.addr : '', notes: f.notes,
    items: lines.map(([id, q]) => ({ menu_item_id: id, quantity: q })),
  };
  if (type === 'dine_in') { if (tableInfo) body.table_token = tableInfo.token; else body.table_label = table; }

  let o;
  try { o = await api('/api/orders', { method: 'POST', body }); }
  catch (e) {
    if (e.data && Array.isArray(e.data.unavailable) && e.data.unavailable.length) {
      // Dishes that were hidden or sold out since the page loaded: drop them so the next attempt can go through.
      e.data.unavailable.forEach(id => basket.delete(id)); saveCart(); badge();
      throw new Error('Some dishes are no longer available and were removed from your basket. Please review it and try again.');
    }
    throw e;
  }
  basket.clear(); saveCart(); badge();   // the server also empties a signed-in customer's saved basket
  store.set('last', { number: o.order_number, token: o.order_token });   // lets a guest come back to this order's status
  track('Purchase', { ...pixelLines(lines), value: Number(o.total), currency: o.currency || CFG.currencyCode });
  const wa = o.whatsapp_url && /^https:\/\/wa\.me\//.test(o.whatsapp_url) ? o.whatsapp_url : '';
  open(`<h3>Order placed</h3><p class="muted">Your order number is <b>${esc(o.order_number)}</b>. Total ${money(o.total)}${o.payment_status === 'unpaid' ? ', to pay at the restaurant' : ''}.</p>
    ${wa ? `<p class="muted">Tap below to also send the details to ${esc(CFG.brand || 'the restaurant')} on WhatsApp.</p><a class="btn wa" href="${esc(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a>` : ''}
    ${MSG}<button class="btn" data-act="track">Track my order</button>${session ? '<button class="btn ghost" data-act="orders">My orders</button>' : ''}<button class="btn ghost" data-act="done">Done</button>`);
}

/* ---- account ---- */
async function openAccount(view = 'in') {
  if (session && !me) await loadMe();
  if (session && me) return openProfile();
  const up = view === 'up';
  if (view === 'forgot') return open(`<h3>Reset password</h3><p class="muted">We'll email you a link to choose a new one.</p>${field('f_email', 'Email', { type: 'email', attrs: 'autocomplete="email"' })}${MSG}<button class="btn" data-act="forgot">Send reset link</button><button class="btn ghost" data-acct="in">Back</button>`);
  open(`<h3>${up ? 'Create account' : 'Welcome back'}</h3>
    <div class="seg"><button data-acct="in" class="${up ? '' : 'on'}">Sign in</button><button data-acct="up" class="${up ? 'on' : ''}">Create account</button></div>
    ${up ? field('f_name', 'Name', { attrs: 'autocomplete="name" maxlength="80"' }) : ''}
    ${field('f_email', 'Email', { type: 'email', attrs: 'autocomplete="email"' })}
    ${field('f_pass', 'Password', { type: 'password', attrs: `autocomplete="${up ? 'new' : 'current'}-password" maxlength="72" placeholder="At least 8 characters"` })}${MSG}
    <button class="btn" data-act="${up ? 'up' : 'in'}">${up ? 'Create account' : 'Sign in'}</button>${up ? '' : '<button class="link" data-acct="forgot">Forgot password?</button>'}${store.get('last', null) ? '<button class="btn ghost" data-act="track">Track my last order</button>' : ''}<button class="btn ghost" data-close>Close</button>`);
}
function openProfile() {
  const p = me.profile || {};
  open(`<h3>${esc(p.display_name || 'My account')}</h3><p class="muted">${esc(me.email)}</p>
    ${field('p_name', 'Name', { value: p.display_name, attrs: 'maxlength="80"' })}${field('p_phone', 'Phone', { type: 'tel', value: p.phone, attrs: 'maxlength="30"' })}${field('p_addr', 'Delivery address', { value: p.address, attrs: 'maxlength="300"' })}${MSG}
    <button class="btn" data-act="save">Save details</button><button class="btn ghost" data-act="orders">My orders</button>${me.staff ? '<a class="btn ghost" href="/admin">Admin</a>' : ''}<button class="btn ghost" data-act="out">Sign out</button>`);
}
const STATUS_LABEL = { pending: 'Received', confirmed: 'Confirmed', preparing: 'Being prepared', ready: 'Ready', completed: 'Completed', cancelled: 'Cancelled' };
let shownOrders = [];   // the list on screen, so "Order again" can find an order's dishes
// Puts a past order's dishes back in the basket. Dishes that are no longer on the menu are left out and the customer is told.
function reorder(number) {
  const o = shownOrders.find(x => x.order_number === number); if (!o) return;
  let added = 0, missing = 0;
  for (const i of o.bg_order_items || []) {
    if (i.menu_item_id != null && byId(i.menu_item_id)) { setQty(i.menu_item_id, (basket.get(i.menu_item_id) || 0) + i.quantity); added++; } else missing++;
  }
  openBasket();
  toast(!added ? 'Those dishes are no longer on the menu' : missing ? 'Added. Some dishes are no longer on the menu' : 'Added to your basket');
}
function openOrders(orders) {
  shownOrders = orders || [];
  const list = shownOrders.map(o => {
    const when = new Date(o.created_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    const kind = (TYPE_LABEL[o.order_type] || o.order_type) + (o.table_label ? ' · table ' + o.table_label : '');
    const what = (o.bg_order_items || []).map(i => i.quantity + ' × ' + i.name_snapshot).join(', ');
    const status = (STATUS_LABEL[o.status] || o.status) + (o.payment_status === 'paid' ? ' · Paid' : '');
    const live = !['completed', 'cancelled'].includes(o.status);
    return `<div class="line"><span><b>${esc(o.order_number)}</b><br><small style="color:var(--muted)">${esc(when)} · ${esc(kind)}</small>${what ? `<br><small style="color:var(--muted)">${esc(what)}</small>` : ''}</span><span style="text-align:right">${money(o.total)}<br><small style="color:var(--muted)">${esc(status)}</small>${live ? `<br><button class="link" data-trk="${esc(o.order_number)}">Track</button>` : ''}<br><button class="link" data-again="${esc(o.order_number)}">Order again</button></span></div>`;
  }).join('');
  open(`<h3>My orders</h3>${list || '<p class="muted">You have not placed any orders here yet.</p>'}${MSG}<button class="btn ghost" data-act="profile">Back</button><button class="btn ghost" data-close>Close</button>`);
}

/* ---- order status: a step list that refreshes by itself until the order is finished. Guests reach it with the secret
   token saved on this device when they ordered; a signed-in customer's own orders need no token. ---- */
const TRACK_STEPS = ['pending', 'confirmed', 'preparing', 'ready', 'completed'];
const FINISHED = ['completed', 'cancelled'];
function stopTrack() { clearInterval(trackTimer); trackTimer = null; }
const fetchOrder = (number, token) => api('/api/orders/' + encodeURIComponent(number) + '?token=' + encodeURIComponent(token || ''));
function trackHtml(o) {
  const at = TRACK_STEPS.indexOf(o.status);
  const steps = o.status === 'cancelled'
    ? '<p class="muted" style="margin:12px 0"><b>This order was cancelled.</b> Please contact the restaurant if you have questions.</p>'
    : `<ol class="trk">${TRACK_STEPS.map((s, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${esc(STATUS_LABEL[s])}</li>`).join('')}</ol>`;
  const where = (TYPE_LABEL[o.order_type] || o.order_type) + (o.table_label ? ' · table ' + o.table_label : '');
  const rows = (o.items || []).map(i => `<div class="line"><span>${i.quantity} × ${esc(i.name)}</span><span>${money(i.line_total)}</span></div>`).join('');
  return `${steps}<p class="muted" style="margin:10px 0 0">${esc(where)}${FINISHED.includes(o.status) ? '' : ' · this page updates by itself'}</p>${rows}<div class="total"><span>Total</span><span>${money(o.total)}</span></div>`;
}
async function openTrack(number, token) {
  const o = await fetchOrder(number, token);          // an error here is shown by the button that asked
  tracking = { number, token: token || '' };
  open(`<h3>Order ${esc(o.order_number)}</h3><div id="trk">${trackHtml(o)}</div><button class="btn ghost" data-act="trackNow">Refresh</button><button class="btn ghost" data-close>Close</button>`);
  if (FINISHED.includes(o.status)) return;
  trackTimer = setInterval(async () => {
    const box = $('#trk', cardEl);
    if (!sheet.classList.contains('open') || !box) return stopTrack();
    try { const n = await fetchOrder(number, token); box.innerHTML = trackHtml(n); if (FINISHED.includes(n.status)) stopTrack(); } catch (_) { /* try again at the next tick */ }
  }, 15000);
}
async function trackLast() {
  const last = store.get('last', null);
  if (!last || !last.number || !last.token) throw new Error('There is no recent order on this device. Sign in to see your orders.');
  try { await openTrack(last.number, last.token); }
  catch (e) {
    if (e.status === 403 || e.status === 404) { store.set('last', null); throw new Error('We could not find that order any more.'); }
    throw e;
  }
}
const post = (path, body) => api(path, { method: 'POST', body });
async function afterSignIn() { toast('Signed in'); return basket.size ? openBasket() : openProfile(); }
const ACTS = {
  async in() { const j = await post('/api/auth/login', { email: val('f_email'), password: $('#f_pass', cardEl).value }); await startSession(j); await afterSignIn(); },
  async up() {
    const email = val('f_email'), password = $('#f_pass', cardEl).value;
    await post('/api/auth/register', { email, password, display_name: val('f_name') });
    await startSession(await post('/api/auth/login', { email, password })); await afterSignIn();
  },
  async forgot() { await post('/api/auth/request-password-reset', { email: val('f_email') }); say('If that email has an account, a reset link is on its way.', true); },
  async save() { const j = await api('/api/auth/me', { method: 'PATCH', body: { display_name: val('p_name'), phone: val('p_phone'), address: val('p_addr') } }); me.profile = j.profile; say('Saved', true); },
  async out() { signedOut(); basket.clear(); saveCart(); badge(); close(); toast('Signed out'); },
  async track() { await trackLast(); },
  async trackNow() { if (tracking) await openTrack(tracking.number, tracking.token); },
  async orders() { openOrders((await api('/api/auth/orders')).orders); },
  async profile() { openProfile(); },
  async place() { await placeOrder(); },
  async done() { close(); toast('Thanks! We have your order'); },
  async basket() { openBasket(); },
};

cardEl.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  const d = t.dataset;
  if (d.add) { const id = +d.add; setQty(id, (basket.get(id) || 0) + 1); if ('stay' in d) openBasket(); else { close(); toast('Added to basket'); } }
  else if (d.dec) { const id = +d.dec; setQty(id, (basket.get(id) || 0) - 1); openBasket(); }
  else if ('checkout' in d) openCheckout();
  else if (d.type) openCheckout({ ...readForm(), type: d.type });
  else if (d.act) run(t, ACTS[d.act]);
  else if (d.trk) run(t, () => openTrack(d.trk, ''));
  else if (d.again) reorder(d.again);
  else if (d.acct) openAccount(d.acct);
  else if (d.goto) { close(); go(d.goto); }
  else if ('close' in d) close();
});
// Enter submits the form's main button.
cardEl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) { const b = cardEl.querySelector('.btn[data-act]'); if (b) b.click(); } });

/* ---- footer: address, phone, language ---- */
(() => {
  const info = $('#info'), bits = [], safe = /^https?:\/\//i;
  if (CFG.address) bits.push(CFG.mapUrl && safe.test(CFG.mapUrl) ? `<a href="${esc(CFG.mapUrl)}" target="_blank" rel="noopener">${esc(CFG.address)}</a>` : esc(CFG.address));
  [CFG.phone, CFG.phone2].filter(Boolean).forEach(p => bits.push(`<a href="tel:${esc(String(p).replace(/[^\d+]/g, ''))}">${esc(p)}</a>`));
  info.innerHTML = bits.map(b => `<p>${b}</p>`).join('');
  if ((CFG.languages || []).length > 1) {
    info.insertAdjacentHTML('beforeend', `<label class="sort"><span>Language</span><select id="lang">${CFG.languages.map(l => `<option value="${esc(l)}"${l === CFG.lang ? ' selected' : ''}>${esc(l.toUpperCase())}</option>`).join('')}</select></label>`);
    $('#lang').addEventListener('change', e => { const u = new URL(location.href); u.searchParams.set('lang', e.target.value); location.href = u.href; });
  }
})();

/* ================= TOP PICK: tap "View in 3D" to swap the picture for the live model =================
   The server only renders this section when the restaurant keeps it on and has a model. The (large) 3D file and the
   viewer script are not downloaded until the visitor asks for them. */
const tp = $('#toppick .tp');
if (tp) {
  tp.addEventListener('click', e => {
    const item = byId(+tp.dataset.id);
    if (e.target.closest('.tp-3d')) {
      loadViewer();
      const stage = tp.querySelector('.tp-stage');
      stage.innerHTML = `<model-viewer src="${esc(tp.dataset.model)}" poster="${esc(item ? img(item) : FOOD)}" alt="${esc(item ? item.name : '')}" ar ar-modes="webxr scene-viewer quick-look" camera-controls auto-rotate shadow-intensity="1" environment-image="neutral" interaction-prompt="none"><button slot="ar-button" class="ar-btn">View on your table</button></model-viewer>`;
    } else if (item && e.target.closest('.nm, .pr')) openItem(item.id);
  });
}

/* ================= FLOATING WHATSAPP (only when the restaurant has a number) ================= */
const waNum = String(CFG.whatsappNumber || '').replace(/\D/g, '');
if (waNum) {
  const wa = $('#waFloat');
  wa.href = `https://wa.me/${waNum}?text=${encodeURIComponent('Hi ' + (CFG.brand || '') + '!')}`;
  wa.hidden = false;
  document.body.classList.add('has-wa');
}

/* ================= FOOTER NAV ================= */
function go(tab) {
  if (tab === 'basket') return openBasket();
  if (tab === 'account') return openAccount();
  if (tab === 'home') return scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
  $('#' + tab).scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) go(b.dataset.tab); });

const secs = [['home', hero], ['popular', $('#popular')], ['menu', $('#menu')]];
function activeTab() {
  const y = 120; let a = 'home';
  secs.forEach(([k, el]) => { if (el.getBoundingClientRect().top <= y) a = k; });
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === a));
}
addEventListener('scroll', activeTab, { passive: true }); activeTab();
})();