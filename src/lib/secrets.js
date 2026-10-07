'use strict';
// Encrypts integration secrets (Meta token, AI key) before they reach the database.
// AES-256-GCM; the key is derived from APP_SECRET_KEY. Output: v1.<iv>.<tag>.<data> (base64url).
const crypto = require('crypto');

function keyFrom(secret) {
  if (!secret || String(secret).length < 16) throw new Error('APP_SECRET_KEY must be set (16+ characters) to store integration secrets');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

function createSecretBox(secret = process.env.APP_SECRET_KEY) {
  const enc = (plain) => {
    const key = keyFrom(secret);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  };
  const dec = (blob) => {
    if (!blob) return null;
    const [v, iv, tag, data] = String(blob).split('.');
    if (v !== 'v1' || !iv || !tag || !data) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
    } catch (e) { return null; }       // wrong key or tampered value
  };
  return { encrypt: enc, decrypt: dec };
}

// "EAAG...abcd" -> "••••abcd" for showing that a secret is set without revealing it.
const mask = (plain) => (plain ? '••••' + String(plain).slice(-4) : '');

module.exports = { createSecretBox, mask };
