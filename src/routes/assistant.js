'use strict';
// The chat bubble on the restaurant's own website.
//   POST /api/assistant/chat   { message, session_id } -> { reply }
// session_id is a random id the browser makes once and keeps, so the chat has memory without an account.

const express = require('express');
const rateLimit = require('express-rate-limit');

const SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function createAssistantRouter({ assistant, limit = 40 }) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, limit, standardHeaders: true, legacyHeaders: false,
    message: { error: 'You are sending messages too fast. Please wait a moment.' },
  });

  router.post('/chat', limiter, asyncHandler(async (req, res) => {
    const b = req.body || {};
    if (typeof b.message !== 'string' || !b.message.trim()) return res.status(400).json({ error: 'Type a message first' });
    if (typeof b.session_id !== 'string' || !SESSION_RE.test(b.session_id)) return res.status(400).json({ error: 'Invalid session' });
    try {
      const r = await assistant.reply({ tenant: req.tenant, channel: 'web', contactId: b.session_id, text: b.message });
      if (r.disabled) return res.status(404).json({ error: 'The assistant is not available' });
      if (r.limited) return res.status(429).json({ error: 'The assistant is busy right now. Please call us or order from the menu.' });
      res.json({ reply: r.text });
    } catch (err) {
      console.error(`[${req.tenant.slug}] assistant failed:`, err.message);
      res.status(502).json({ error: 'The assistant could not answer. Please try again.' });
    }
  }));

  return router;
}

module.exports = { createAssistantRouter };
