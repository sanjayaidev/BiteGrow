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

/* ================= HERO: seekable video via horizontal swipe/wheel ================= */
const hero = $('#hero'), stage = $('.hero-stage'), vid = $('#heroVideo');
const slides = [...hero.querySelectorAll('.slide')].map(el => ({ el, s: +el.dataset.start, e: +el.dataset.end }));
const FADE = 0.05, EASE = reduce ? 1 : 0.16;
let target = 0, cur = 0, lastT = -1, ready = false, raf = 0;

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

function seek(p) {
  if (!vid.duration) return;
  const t = clamp(p, 0, 1) * (vid.duration - 0.04);
  if (Math.abs(t - lastT) < 0.008 || vid.seeking) return;
  lastT = t;
  vid.fastSeek ? vid.fastSeek(t) : (vid.currentTime = t);
}

function tick() {
  raf = 0;
  cur += (target - cur) * EASE;
  if (Math.abs(target - cur) < 0.0004) cur = target;
  seek(cur); setSlides(cur);
  if (cur !== target) raf = requestAnimationFrame(tick);
}

// Mobile: Horizontal swipe scrubs hero video
let heroTouchStartX = 0, heroTouchStartY = 0, heroStartProgress = 0;
hero.addEventListener('touchstart', (e) => {
  heroTouchStartX = e.touches[0].clientX;
  heroTouchStartY = e.touches[0].clientY;
  heroStartProgress = target;
}, { passive: true });

hero.addEventListener('touchmove', (e) => {
  const dx = e.touches[0].clientX - heroTouchStartX;
  const dy = e.touches[0].clientY - heroTouchStartY;
  if (Math.abs(dx) > Math.abs(dy)) {
    e.preventDefault(); // Prevent vertical page scroll if strictly horizontal
    const progressDelta = -dx / window.innerWidth;
    target = clamp(heroStartProgress + progressDelta, 0, 1);
    if (!raf) raf = requestAnimationFrame(tick);
  }
}, { passive: false });

// PC: Horizontal wheel or Shift+Wheel scrubs hero video
hero.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
    const delta = e.deltaX || e.deltaY;
    const progressDelta = -(delta / 1000) * 0.5;
    target = clamp(target + progressDelta, 0, 1);
    if (!raf) raf = requestAnimationFrame(tick);
    e.preventDefault();
  }
}, { passive: false });

function unlock() {
  if (ready) return; ready = true;
  hero.classList.add('ready'); document.body.classList.remove('is-locked');
  target = cur = 0; seek(cur); setSlides(cur);
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
vid.load();
setSlides(0);

const kick = () => [vid, ...document.querySelectorAll('.pop video')].forEach(v => v.play().then(() => v.pause()).catch(() => {}));
['touchstart', 'pointerdown', 'wheel'].forEach(ev => addEventListener(ev, kick, { once: true, passive: true }));

/* ================= POPULAR: 2 col, 3 row, independent video scroll ================= */
const popItems = [...items].sort((a, b) => b.rating - a.rating).slice(0, 6);
const row = $('#popRow');
row.innerHTML = popItems.map((it, i) => `
  <div class="pop" data-id="${it.id}">
    <div class="vid">
      <video src="videos/pop${i % 3 + 1}.mp4" poster="videos/pop${i % 3 + 1}.jpg" muted playsinline preload="auto" aria-hidden="true"></video>
    </div>
    <p class="nm">${esc(it.name)}</p>
    <p class="pr">${money(it.price)}</p>
  </div>
`).join('');

// Setup independent controls for each popular video card
const popCards = row.querySelectorAll('.pop');
popCards.forEach(card => {
  const video = card.querySelector('video');
  video.pause();

  // PC: Hover scroll (wheel) scrubs individual video
  card.addEventListener('wheel', (e) => {
    if (!video.duration) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const scrubAmount = -(delta / 100) * video.duration * 0.05;
    video.currentTime = clamp(video.currentTime + scrubAmount, 0, video.duration - 0.04);
    e.preventDefault(); // Prevents page scroll when hovering directly over the video
  }, { passive: false });

  // Mobile: Left/right swipe scrubs individual video
  let touchStartX = 0, touchStartY = 0, touchStartTime = 0;
  card.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    touchStartTime = video.currentTime;
  }, { passive: true });

  card.addEventListener('touchmove', (e) => {
    if (!video.duration) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy)) {
      e.preventDefault(); // Prevents vertical page scroll if swiping horizontally on the video
      const progress = -dx / card.clientWidth;
      video.currentTime = clamp(touchStartTime + progress * video.duration, 0, video.duration - 0.04);
    }
    // If vertical (dy > dx), we do nothing, allowing the browser to naturally scroll the page
  }, { passive: false });
});

row.addEventListener('click', e => { const p = e.target.closest('.pop'); if (p) openItem(+p.dataset.id); });

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