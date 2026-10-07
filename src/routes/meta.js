'use strict';
// Meta messaging webhooks: WhatsApp Cloud API, Instagram DMs and Facebook Messenger share one URL,
//   GET/POST /webhooks/meta
//
// Meta calls ONE address for every restaurant, so the tenant is found from the account the message
// was sent to (WhatsApp phone number id / Page id / Instagram id saved in bg_tenant_integrations),
// not from the hostname. Mount this BEFORE the tenant resolver and BEFORE express.json:
// the signature is computed over the exact raw bytes.
//
// Env: META_APP_SECRET (signs every POST), META_VERIFY_TOKEN (checked once when you register the
// webhook), optional META_GRAPH_VERSION (default v21.0).

const crypto = require('crypto');
const express = require('express');
const { shapeTenant, BASE_SELECT } = require('../tenant');

const GRAPH = () => `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v21.0'}`;
const NON_TEXT_REPLY = 'Thanks! I can read text messages only. Please type your question.';

function validSignature(raw, header, secret) {
  if (!secret || !header || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

// Meta's payload -> [{ channel, accountId, contactId, messageId, text, name }]. Echoes and delivery receipts are dropped.
function extractMessages(body) {
  const out = [];
  if (!body || typeof body !== 'object') return out;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    if (body.object === 'whatsapp_business_account') {
      for (const ch of entry.changes || []) {
        const v = ch && ch.value; if (!v || !v.metadata) continue;
        const names = new Map((v.contacts || []).map((c) => [c.wa_id, c.profile && c.profile.name]));
        for (const m of v.messages || []) {
          out.push({
            channel: 'whatsapp', accountId: String(v.metadata.phone_number_id), contactId: String(m.from), messageId: m.id,
            text: m.type === 'text' && m.text ? String(m.text.body || '') : null, name: names.get(m.from) || '',
          });
        }
      }
    } else if (body.object === 'instagram' || body.object === 'page') {
      const channel = body.object === 'instagram' ? 'instagram' : 'facebook';
      for (const ev of entry.messaging || []) {
        if (!ev || !ev.message || ev.message.is_echo || !ev.sender) continue;
        out.push({
          channel, accountId: String(entry.id), contactId: String(ev.sender.id), messageId: ev.message.mid,
          text: typeof ev.message.text === 'string' ? ev.message.text : null, name: '',
        });
      }
    }
  }
  return out.filter((m) => m.accountId && m.contactId && m.messageId);
}

function createMetaRouter({ supabase, assistant, secretBox, fetchImpl = (...a) => fetch(...a), log = console }) {
  const router = express.Router();

  router.get('/', (req, res) => {
    const token = process.env.META_VERIFY_TOKEN;
    if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
      return res.type('text').send(String(req.query['hub.challenge'] || ''));
    }
    res.sendStatus(403);
  });

  // The tenant that owns this WhatsApp number / Page / Instagram account, with its Meta token.
  async function findAccount(channel, accountId) {
    const col = channel === 'whatsapp' ? 'meta_whatsapp_phone_id' : channel === 'instagram' ? 'meta_instagram_id' : 'meta_page_id';
    const { data: integ, error } = await supabase.from('bg_tenant_integrations').select('*').eq(col, accountId).eq('meta_enabled', true).maybeSingle();
    if (error) throw error;
    if (!integ) return null;
    const { data: row, error: tErr } = await supabase.from('bg_tenants').select(BASE_SELECT).eq('id', integ.tenant_id).maybeSingle();
    if (tErr) throw tErr;
    if (!row || row.status !== 'active') return null;
    row.integrations = integ;                                  // already loaded above, so no relationship embed is needed
    const token = secretBox.decrypt(integ.meta_access_token_enc);
    return token ? { tenant: shapeTenant(row), integ, token } : null;
  }

  async function send(channel, account, to, text) {
    const body = String(text).slice(0, 1000);
    let url; let payload;
    if (channel === 'whatsapp') {
      url = `${GRAPH()}/${account.integ.meta_whatsapp_phone_id}/messages`;
      payload = { messaging_product: 'whatsapp', to, type: 'text', text: { body } };
    } else {
      const from = channel === 'instagram' ? (account.integ.meta_page_id || account.integ.meta_instagram_id) : account.integ.meta_page_id;
      url = `${GRAPH()}/${from}/messages`;
      payload = { recipient: { id: to }, messaging_type: 'RESPONSE', message: { text: body } };
    }
    const res = await fetchImpl(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` }, body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`Meta send returned ${res.status}`);
  }

  // Meta retries deliveries, so each message id is claimed once before we answer it.
  async function claim(messageId, tenantId) {
    const { data, error } = await supabase.from('bg_webhook_events').select('id').eq('id', messageId).maybeSingle();
    if (error) throw error;
    if (data) return false;
    const { error: iErr } = await supabase.from('bg_webhook_events').insert({ id: messageId, tenant_id: tenantId });
    if (iErr) { if (iErr.code === '23505') return false; throw iErr; }
    return true;
  }

  async function processPayload(body) {
    for (const m of extractMessages(body)) {
      try {
        const account = await findAccount(m.channel, m.accountId);
        if (!account) continue;                                    // not one of ours, or switched off
        if (!(await claim(m.messageId, account.tenant.id))) continue;
        if (m.text === null) { await send(m.channel, account, m.contactId, NON_TEXT_REPLY); continue; }
        const r = await assistant.reply({ tenant: account.tenant, channel: m.channel, contactId: m.contactId, text: m.text });
        if (r.disabled) continue;
        const text = r.limited ? 'We are very busy right now. Please try again later or use our website to order.' : r.text;
        await send(m.channel, account, m.contactId, text);
      } catch (err) {
        log.error(`meta webhook: could not handle ${m.channel} message ${m.messageId}:`, err.message);
      }
    }
  }

  router.post('/', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!process.env.META_APP_SECRET) return res.sendStatus(503);
    if (!validSignature(raw, req.get('x-hub-signature-256'), process.env.META_APP_SECRET)) return res.sendStatus(401);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch (e) { return res.sendStatus(400); }
    res.sendStatus(200);                                           // answer Meta quickly; replies are sent afterwards
    processPayload(body).catch((e) => log.error('meta webhook failed:', e.message));
  });

  // Not named "handle": Express routers already use that name to dispatch requests.
  return Object.assign(router, { processPayload });
}

module.exports = { createMetaRouter, extractMessages, validSignature };
