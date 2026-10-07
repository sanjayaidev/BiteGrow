// Chat bubble for the restaurant assistant. Loaded only when the restaurant has switched it on.
(function () {
  const cfg = window.CONFIG || {};
  if (!cfg.assistant) return;

  let sid = '';
  try { sid = localStorage.getItem('bg_chat_sid') || ''; } catch (e) { /* private mode */ }
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(sid)) {
    sid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    try { localStorage.setItem('bg_chat_sid', sid); } catch (e) { /* ignore */ }
  }

  const css = document.createElement('style');
  css.textContent = `
  .ai-fab{position:fixed;right:max(14px,calc(50% - 226px));bottom:calc(var(--tabs,62px) + 14px + env(safe-area-inset-bottom,0px));z-index:40;width:52px;height:52px;border-radius:50%;border:0;background:var(--gold,#e3b23c);color:#1a1408;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5);display:grid;place-items:center}
  .ai-fab svg{width:24px;height:24px}
  .ai-panel{position:fixed;right:max(10px,calc(50% - 230px));bottom:calc(var(--tabs,62px) + 74px + env(safe-area-inset-bottom,0px));z-index:41;width:min(340px,calc(100vw - 20px));height:min(460px,60vh);background:var(--surface,#1c1a18);border:1px solid var(--line,#2c2925);border-radius:14px;display:none;flex-direction:column;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  .ai-panel.open{display:flex}
  .ai-head{padding:11px 14px;font-weight:600;font-size:14px;border-bottom:1px solid var(--line,#2c2925);display:flex;justify-content:space-between;align-items:center}
  .ai-head button{background:none;border:0;color:var(--muted,#a99f8f);font-size:20px;cursor:pointer;line-height:1}
  .ai-log{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;font-size:13px;line-height:1.45}
  .ai-m{max-width:85%;padding:8px 11px;border-radius:12px;white-space:pre-wrap;word-wrap:break-word}
  .ai-m.bot{background:#2a2622;align-self:flex-start}
  .ai-m.me{background:var(--gold,#e3b23c);color:#1a1408;align-self:flex-end}
  .ai-m.err{background:#4a201b;align-self:flex-start}
  .ai-form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line,#2c2925)}
  .ai-form input{flex:1;min-width:0;background:#121110;border:1px solid var(--line,#2c2925);color:var(--text,#f4efe6);border-radius:8px;padding:9px 10px;font:inherit;font-size:16px}
  .ai-form button{background:var(--gold,#e3b23c);color:#1a1408;border:0;border-radius:8px;padding:0 14px;font-weight:700;cursor:pointer}
  .ai-form button:disabled{opacity:.5}
  @media (prefers-reduced-motion:no-preference){.ai-panel.open{animation:aiin .15s ease-out}@keyframes aiin{from{opacity:0;transform:translateY(8px)}}}`;
  document.head.appendChild(css);

  const fab = document.createElement('button');
  fab.className = 'ai-fab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Chat with us');
  fab.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z"/></svg>';
  const panel = document.createElement('div');
  panel.className = 'ai-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Chat assistant');
  panel.innerHTML = '<div class="ai-head"><span></span><button type="button" aria-label="Close chat">×</button></div><div class="ai-log" aria-live="polite"></div><form class="ai-form"><input type="text" maxlength="500" placeholder="Ask about the menu…" aria-label="Your message" autocomplete="off"><button type="submit">Send</button></form>';
  document.body.append(fab, panel);

  const log = panel.querySelector('.ai-log');
  const form = panel.querySelector('form');
  const input = panel.querySelector('input');
  const send = panel.querySelector('form button');
  panel.querySelector('.ai-head span').textContent = cfg.brand || 'Assistant';

  const add = (cls, text) => { const d = document.createElement('div'); d.className = 'ai-m ' + cls; d.textContent = text; log.appendChild(d); log.scrollTop = log.scrollHeight; return d; };
  add('bot', cfg.assistantGreeting || 'Hi! Ask me about our menu or how to order.');

  const toggle = (open) => { panel.classList.toggle('open', open); if (open) input.focus(); };
  fab.onclick = () => toggle(!panel.classList.contains('open'));
  panel.querySelector('.ai-head button').onclick = () => toggle(false);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; send.disabled = true;
    add('me', text);
    const wait = add('bot', '…');
    try {
      const r = await fetch('/api/assistant/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: text, session_id: sid }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Something went wrong');
      wait.textContent = j.reply;
    } catch (err) { wait.className = 'ai-m err'; wait.textContent = err.message; }
    send.disabled = false; input.focus(); log.scrollTop = log.scrollHeight;
  };
})();
