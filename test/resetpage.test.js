'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'public', 'reset-password.html');

test('the password-reset email link has a page to land on', () => {
  // routes/auth.js sends people to <host>/reset-password.html; a missing file here meant a 404.
  const auth = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'auth.js'), 'utf8');
  assert.match(auth, /\/reset-password\.html/);
  assert.ok(fs.existsSync(PAGE));
});

test('the page reads the recovery token from the URL fragment, hides it, and posts to the auth API', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.match(html, /type'\) !== 'recovery'/);
  assert.match(html, /history\.replaceState/);
  assert.match(html, /\/api\/auth\/reset-password/);
  assert.match(html, /access_token: accessToken, new_password/);
  assert.match(html, /maxlength="72"/);              // the API refuses passwords over 72 characters
});

test('the page never puts the token in a visible link or sends it anywhere else', () => {
  const html = fs.readFileSync(PAGE, 'utf8');
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);          // no external requests at all
  assert.match(html, /name="referrer" content="no-referrer"/);
});
