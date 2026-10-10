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

test('customers can follow an order\'s status, and the refresh stops when the sheet closes or the order is finished', () => {
  assert.match(js, /\/api\/orders\/' \+ encodeURIComponent\(number\)/);
  assert.match(js, /data-act="track"/);
  assert.match(js, /const close = \(\) => \{ stopTrack\(\);/);          // closing the sheet stops the timer
  assert.match(js, /const open = html => \{ stopTrack\(\);/);           // so does opening any other view
  assert.match(js, /if \(FINISHED\.includes\(n\.status\)\) stopTrack\(\)/);
  // The order's secret token is kept on this device only, and every value from the server is escaped.
  assert.match(js, /store\.set\('last', \{ number: o\.order_number, token: o\.order_token \}\)/);
  assert.match(js, /esc\(STATUS_LABEL\[s\]\)/);
});

test('the admin page has a Tables screen wired to the tables API', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(admin, /data-t="tables"/);
  assert.match(admin, /data-p="tables"/);
  for (const call of ["json('tables')", "json('tables?qr=1')", '`tables/${t.id}/qr.svg`', "'tables/' + id"]) assert.ok(admin.includes(call), call);
  assert.match(admin, /esc\(t\.label\)/);                                // table names are escaped before going into markup
  assert.match(admin, /const brand = esc\(/);
});

test('signed-in customers can open their order history', () => {
  assert.match(js, /api\('\/api\/auth\/orders'\)/);
  assert.match(js, /data-act="orders"/);
  assert.match(js, /function openOrders/);
  // Everything from the server is escaped before it goes into markup.
  assert.match(js, /esc\(o\.order_number\)/);
  assert.match(js, /esc\(what\)/);
});

test('admin page: Team tab is owner-only, homepage layout and order sound are wired up', () => {
  const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.match(admin, /data-t="staff"/);
  assert.match(admin, /b\.dataset\.t === 'staff' && !isOwner/);                       // hidden for admins and kitchen staff
  for (const call of ["json('staff')", "json('staff', { method: 'POST'", "'staff/' + encodeURIComponent"]) assert.ok(admin.includes(call), call);
  for (const key of ['heroMode', 'heroSpeed', 'topPick', 'topPickItemId']) assert.ok(admin.includes(key), key);
  assert.match(admin, /sndGet\(\) && added\.some\(\(o\) => o\.status === 'pending'\)\) chime\(\)/);   // chime only for new, waiting orders
  assert.match(admin, /esc\(m\.email\)/);                                              // emails are escaped before going into markup
});

test('customers can order a past order again', () => {
  assert.match(js, /data-again="\$\{esc\(o\.order_number\)\}"/);
  assert.match(js, /else if \(d\.again\) reorder\(d\.again\)/);
  assert.match(js, /byId\(i\.menu_item_id\)/);                                         // dishes no longer on the menu are skipped
});
