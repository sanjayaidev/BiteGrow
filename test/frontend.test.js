'use strict';
// The storefront script runs in the browser against the live DOM, so these checks read its source.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const file = path.join(__dirname, '..', 'public', 'app.js');
const js = fs.readFileSync(file, 'utf8');

test('app.js has no syntax errors', () => {
  execFileSync(process.execPath, ['--check', file]);
});

test('Meta Pixel events are sent through a guard that does nothing without a pixel', () => {
  assert.match(js, /typeof window\.fbq === 'function'/);
  for (const ev of ['AddToCart', 'InitiateCheckout', 'Purchase']) assert.match(js, new RegExp(`track\\('${ev}'`), ev);
  // Pixel currency must be the ISO code (USD), never the display symbol ($).
  assert.doesNotMatch(js, /currency: CFG\.currency[,\s}]/);
  assert.match(js, /currency: CFG\.currencyCode/);
});

test('signed-in customers can open their order history', () => {
  assert.match(js, /api\('\/api\/auth\/orders'\)/);
  assert.match(js, /data-act="orders"/);
  assert.match(js, /function openOrders/);
  // Everything from the server is escaped before it goes into markup.
  assert.match(js, /esc\(o\.order_number\)/);
  assert.match(js, /esc\(what\)/);
});
