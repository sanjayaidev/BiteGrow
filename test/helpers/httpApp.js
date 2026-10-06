'use strict';
// Mounts routers on a tiny express app with a fake tenant resolver and calls them over real HTTP.

const http = require('node:http');
const express = require('express');

const TENANT_A = {
  id: 'tenant-a', slug: 'a', name: 'A', currency: 'INR', currencySymbol: '₹', defaultLang: 'en', languages: ['en', 'ar'],
  settings: {
    brandName: 'RED HOUSE', pageTitle: 'Red House', cardBgUrl: null, phone: null, phone2: null, address: null, mapUrl: null,
    whatsappNumber: '+91 75047-04502', deliveryFee: 20, orderTypes: ['dine_in', 'pickup', 'delivery'], features: { whatsappOrder: true },
  },
};
const TENANT_B = {
  ...TENANT_A, id: 'tenant-b', slug: 'b', name: 'B',
  settings: { ...TENANT_A.settings, brandName: 'WOK STAR', whatsappNumber: '', deliveryFee: 0, orderTypes: ['pickup'], features: {} },
};
const TENANTS = { a: TENANT_A, b: TENANT_B };

// The client picks a restaurant with the x-tenant header, standing in for the Host header.
function makeApp(mount) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.tenant = TENANTS[req.get('x-tenant') || 'a']; next(); });
  mount(app);
  app.use((err, req, res, next) => res.status(500).json({ error: 'Server error' }));   // like server.js: details never leak
  return app;
}

async function withServer(app, fn) {
  const server = app.listen(0);
  const port = server.address().port;
  const call = (method, path, { body, token, tenant } = {}) => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    if (token) headers.authorization = 'Bearer ' + token;
    if (tenant) headers['x-tenant'] = tenant;
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try { await fn(call); } finally { server.close(); }
}

module.exports = { makeApp, withServer, TENANT_A, TENANT_B };
