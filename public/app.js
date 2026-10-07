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
const vSrc = k => (VIDS[k] && VIDS[k].src) || `videos/${k}.mp4`;
const vPoster = k => (VIDS[k] && VIDS[k].poster) || `videos/${k}.jpg`;

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
const popItems = [...items].sort((a, b) => b.rating - a.rating).slice(0, 3);
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
  if (e.target.closest('.add')) { basket.set(id, (basket.get(id) || 0) + 1); badge(); toast('Added to basket'); }
  else openItem(id);
});
renderList();

/* ================= SIMULATED BASKET / SHEETS ================= */
const basket = new Map();
const sheet = $('#sheet'), cardEl = $('#sheetCard');
const open = html => { $('#toast').classList.remove('show'); cardEl.innerHTML = html; sheet.classList.add('open'); cardEl.scrollTop = 0; };
const close = () => sheet.classList.remove('open');
sheet.addEventListener('click', e => { if (e.target === sheet) close(); });
addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

let toastT; function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600); }
function badge() { const n = [...basket.values()].reduce((a, b) => a + b, 0); const b = $('#badge'); b.textContent = n; b.hidden = !n; }

function loadViewer() {
  if (customElements.get('model-viewer') || document.getElementById('mvScript')) return;
  const sc = document.createElement('script');
  sc.type = 'module'; sc.id = 'mvScript';
  sc.src = 'https://unpkg.com/@google/model-viewer@3.5.0/dist/model-viewer.min.js';
  document.head.appendChild(sc);
}
function openItem(id) {
  const i = byId(id);
  let media = `<img class="big" src="${img(i)}" alt="${esc(i.name)}">`;
  if (FEAT.ar3d && i.model) {
    loadViewer();   // only fetched the first time someone opens a 3D dish
    media = `<model-viewer src="${esc(modelSrc(i.model))}" poster="${img(i)}" alt="${esc(i.name)}" ar ar-modes="webxr scene-viewer quick-look" camera-controls auto-rotate shadow-intensity="1" environment-image="neutral" interaction-prompt="none"><button slot="ar-button" class="ar-btn">View on your table</button></model-viewer>`;
  }
  open( `${media} <h3>${esc(i.name)}</h3> <p class="muted">${esc(i.desc)}</p> <div class="line"><span>${i.rating.toFixed(1)} ★ · ${i.cal} kcal</span><b style="color:var(--gold)">${money(i.price)}</b></div> <button class="btn" data-add="${i.id}">Add to basket</button> <button class="btn ghost" data-close>Close</button>` );
}

function openBasket(done) {
  if (done) return open( `<h3>Order sent ✓</h3><p class="muted">Demo order <b>${done}</b> — no real order was placed.</p><button class="btn" data-close>Done</button>` );
  if (!basket.size) return open( `<h3>Your basket</h3><p class="muted">Nothing here yet. Add something from the menu.</p><button class="btn" data-goto="menu">Browse menu</button>` );
  let total = 0;
  const lines = [...basket].map(([id, q]) => { const i = byId(id); total += i.price * q; return  `<div class="line"><span>${esc(i.name)}<br><small style="color:var(--muted)">${money(i.price)}</small></span><span class="qty"><button data-dec="${id}">−</button> ${q} <button data-add="${id}" data-stay>+</button></span></div>` ; }).join('');
  open( `<h3>Your basket</h3>${lines}<div class="total"><span>Total</span><span>${money(total)}</span></div>${FEAT.whatsappOrder ? `<button class="btn wa" data-wa>Order on WhatsApp</button>` : ''}<button class="btn ${FEAT.whatsappOrder ? 'ghost' : ''}" data-order>Place order (demo)</button><button class="btn ghost" data-close>Keep browsing</button>` );
}

cardEl.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.add) { const id = +t.dataset.add; basket.set(id, (basket.get(id) || 0) + 1); badge(); if ('stay' in t.dataset) openBasket(); else { close(); toast('Added to basket'); } }
  else if (t.dataset.dec) { const id = +t.dataset.dec, q = basket.get(id) - 1; q > 0 ? basket.set(id, q) : basket.delete(id); badge(); openBasket(); }
  else if ('wa' in t.dataset) {
    let total = 0;
    const lines = [...basket].map(([id, q]) => { const i = byId(id); total += i.price * q; return `${q} x ${i.name} - ${money(i.price * q)}`; });
    const text = `${CFG.brand || 'Order'} order:\n${lines.join('\n')}\nTotal: ${money(total)}`;
    const num = String(CFG.whatsappNumber || '').replace(/\D/g, '');
    window.open(`https://wa.me/${num}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  else if ('order' in t.dataset) { const d = new Date(), p = n => String(n).padStart(2, '0'); const no = `RH-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}` ; basket.clear(); badge(); openBasket(no); }
  else if (t.dataset.goto) { close(); go(t.dataset.goto); }
  else if ('close' in t.dataset) close();
});

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