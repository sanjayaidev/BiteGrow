(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = t => t * t * (3 - 2 * t);
const money = n => '$' + n.toFixed(2);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const { categories, items } = window.MENU;
const byId = id => items.find(i => i.id === id);
const img = i => i.id === 1 ? 'img/beef.png' : 'img/food.png';
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ================= SPEED CONTROL (1-10, remembered on this device) =================
   Drag: how much of a video one full-width drag covers (speed 4 = 48%, 10 = 120%).
   Wheel / trackpad: scales the step per notch (speed 4 = normal). */
let speedUI = 4;
try { const v = parseInt(localStorage.getItem('scrubSpeedUI'), 10); if (v >= 1 && v <= 10) speedUI = v; } catch (_) {}
const speedInput = $('#speed'), speedVal = $('#speedval');
speedInput.value = speedUI; speedVal.textContent = speedUI;
speedInput.addEventListener('input', () => {
  speedUI = parseInt(speedInput.value, 10) || 4;
  speedVal.textContent = speedUI;
  try { localStorage.setItem('scrubSpeedUI', speedUI); } catch (_) {}
});
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
const slides = [...hero.querySelectorAll('.slide')].map(el => ({ el, s: +el.dataset.start, e: +el.dataset.end }));
const FADE = 0.05, EASE = reduce ? 1 : 0.16;
let target = 0, cur = 0, lastT = -1, ready = false, raf = 0, holdUntil = 0;

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
  canStart: () => ready,
  start: () => target,
  move: (base, dx) => heroTo(base - dx / innerWidth * dragGain())
});

// PC: mouse wheel scrubs while the page is at the top. At either end of the video the wheel
// goes back to scrolling the page, so you can never get stuck.
addEventListener('wheel', e => {
  if (!ready || e.ctrlKey || scrollY > 2 || document.querySelector('.sheet.open')) return;
  let d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!d) return;
  if (e.deltaMode === 1) d *= 33; else if (e.deltaMode === 2) d *= innerHeight;
  const now = performance.now();
  if (now < holdUntil) { e.preventDefault(); return; }          // absorb trackpad inertia right after reaching an end
  if ((d > 0 && target >= 1) || (d < 0 && target <= 0)) return; // at an end: let the page scroll
  e.preventDefault();
  const np = clamp(target + d / 2500 * wheelMul(), 0, 1);
  if (np === 1 || np === 0) holdUntil = now + 350;
  heroTo(np);
}, { passive: false });

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
const popItems = [...items].sort((a, b) => b.rating - a.rating).slice(0, 6);
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
let activeCat = 'all';
$('#chips').innerHTML = [{ id: 'all', label: 'All' }, ...categories].map(c => `<button class="chip${c.id === 'all' ? ' on' : ''}" data-c="${c.id}">${esc(c.label)}</button>`).join('');
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  activeCat = b.dataset.c;
  document.querySelectorAll('.chip').forEach(x => x.classList.toggle('on', x === b));
  renderList();
});

function renderList() {
  $('#list').innerHTML = items.filter(i => activeCat === 'all' || i.cat === activeCat).map(i => `<button class="row" data-id="${i.id}"> <span class="th"><img src="${img(i)}" alt="" loading="lazy"></span> <span class="in"><p class="nm">${esc(i.name)}</p><p class="pr">${i.offer ? '<span class="offer">OFFER</span>' : ''}${money(i.price)}</p></span> </button>`).join('');
}
$('#list').addEventListener('click', e => { const r = e.target.closest('.row'); if (r) openItem(+r.dataset.id); });
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

function openItem(id) {
  const i = byId(id);
  open( `<img class="big" src="${img(i)}" alt="${esc(i.name)}"> <h3>${esc(i.name)}</h3> <p class="muted">${esc(i.desc)}</p> <div class="line"><span>${i.rating.toFixed(1)} ★ · ${i.cal} kcal</span><b style="color:var(--gold)">${money(i.price)}</b></div> <button class="btn" data-add="${i.id}">Add to basket</button> <button class="btn ghost" data-close>Close</button>` );
}

function openBasket(done) {
  if (done) return open( `<h3>Order sent ✓</h3><p class="muted">Demo order <b>${done}</b> — no real order was placed.</p><button class="btn" data-close>Done</button>` );
  if (!basket.size) return open( `<h3>Your basket</h3><p class="muted">Nothing here yet. Add something from the menu.</p><button class="btn" data-goto="menu">Browse menu</button>` );
  let total = 0;
  const lines = [...basket].map(([id, q]) => { const i = byId(id); total += i.price * q; return  `<div class="line"><span>${esc(i.name)}<br><small style="color:var(--muted)">${money(i.price)}</small></span><span class="qty"><button data-dec="${id}">−</button> ${q} <button data-add="${id}" data-stay>+</button></span></div>` ; }).join('');
  open( `<h3>Your basket</h3>${lines}<div class="total"><span>Total</span><span>${money(total)}</span></div><button class="btn" data-order>Place order (demo)</button><button class="btn ghost" data-close>Keep browsing</button>` );
}

cardEl.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.dataset.add) { const id = +t.dataset.add; basket.set(id, (basket.get(id) || 0) + 1); badge(); if ('stay' in t.dataset) openBasket(); else { close(); toast('Added to basket'); } }
  else if (t.dataset.dec) { const id = +t.dataset.dec, q = basket.get(id) - 1; q > 0 ? basket.set(id, q) : basket.delete(id); badge(); openBasket(); }
  else if ('order' in t.dataset) { const d = new Date(), p = n => String(n).padStart(2, '0'); const no = `RH-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${String(Math.floor(Math.random() * 9000) + 1000)}` ; basket.clear(); badge(); openBasket(no); }
  else if (t.dataset.goto) { close(); go(t.dataset.goto); }
  else if ('close' in t.dataset) close();
});

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