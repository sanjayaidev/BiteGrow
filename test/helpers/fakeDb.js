'use strict';
// A small in-memory stand-in for the supabase-js client, enough for the routes' queries:
// select / insert / upsert / update / delete with eq, in, match, order, limit, single, maybeSingle.
// Also fakes supabase.auth.getUser with simple tokens ("tok-u1" is user u1).

const crypto = require('node:crypto');

function makeDb(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const counters = {};
  const users = new Map();            // token -> user
  const fail = new Map();             // "table:op" -> error message (consumed once)
  const log = [];                     // { table, op }
  const hooks = {};                   // table -> fn(row) run on insert, like a database trigger

  const rowsOf = (t) => (tables[t] = tables[t] || []);

  function from(table) {
    const q = { op: 'select', filters: [], payload: null, onConflict: 'id', ord: null, lim: null, one: false, strict: false };
    const match = (r) => q.filters.every(([k, v, kind]) => (kind === 'in' ? v.includes(r[k]) : r[k] === v));

    const run = () => {
      const failKey = `${table}:${q.op}`;
      log.push({ table, op: q.op });
      if (fail.has(failKey)) { const m = fail.get(failKey); fail.delete(failKey); return { data: null, error: new Error(m) }; }

      const stamp = (row) => {
        const out = { ...row };
        if (out.id === undefined && table !== 'bg_cart_items') out.id = counters[table] = (counters[table] || 0) + 1;
        if (hooks[table]) hooks[table](out);
        return out;
      };

      if (q.op === 'insert') {
        const list = (Array.isArray(q.payload) ? q.payload : [q.payload]).map(stamp);
        rowsOf(table).push(...list);
        return { data: Array.isArray(q.payload) ? list : list[0], error: null };
      }
      if (q.op === 'upsert') {
        const keys = q.onConflict.split(',');
        for (const row of Array.isArray(q.payload) ? q.payload : [q.payload]) {
          const hit = rowsOf(table).find((r) => keys.every((k) => r[k] === row[k]));
          if (hit) Object.assign(hit, row); else rowsOf(table).push(stamp(row));
        }
        return { data: null, error: null };
      }
      if (q.op === 'update') {
        const hit = rowsOf(table).filter(match);
        hit.forEach((r) => Object.assign(r, q.payload));
        return { data: q.one ? hit[0] || null : hit, error: null };
      }
      if (q.op === 'delete') {
        tables[table] = rowsOf(table).filter((r) => !match(r));
        return { data: null, error: null };
      }
      let out = rowsOf(table).filter(match).map((r) => ({ ...r }));
      if (q.ord) out.sort((a, b) => (a[q.ord.col] < b[q.ord.col] ? -1 : a[q.ord.col] > b[q.ord.col] ? 1 : 0) * (q.ord.asc ? 1 : -1));
      if (q.lim != null) out = out.slice(0, q.lim);
      if (q.one) {
        if (!out.length && q.strict) return { data: null, error: new Error('no rows') };
        return { data: out[0] || null, error: null };
      }
      return { data: out, error: null };
    };

    const b = {
      select() { return b; },
      insert(p) { q.op = 'insert'; q.payload = p; return b; },
      upsert(p, o) { q.op = 'upsert'; q.payload = p; if (o && o.onConflict) q.onConflict = o.onConflict; return b; },
      update(p) { q.op = 'update'; q.payload = p; return b; },
      delete() { q.op = 'delete'; return b; },
      eq(k, v) { q.filters.push([k, v]); return b; },
      in(k, v) { q.filters.push([k, v, 'in']); return b; },
      match(obj) { Object.entries(obj).forEach(([k, v]) => q.filters.push([k, v])); return b; },
      order(col, o) { q.ord = { col, asc: !(o && o.ascending === false) }; return b; },
      limit(n) { q.lim = n; return b; },
      maybeSingle() { q.one = true; return Promise.resolve(run()); },
      single() { q.one = true; q.strict = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }

  let n = 0;
  const addUser = (email) => {
    const user = { id: 'u' + (++n), email, user_metadata: {} };
    users.set('tok-' + user.id, user);
    return user;
  };

  const supabase = {
    from,
    auth: {
      async getUser(token) {
        const user = users.get(token);
        return user ? { data: { user }, error: null } : { data: { user: null }, error: new Error('bad jwt') };
      },
    },
  };

  return {
    supabase, tables, rowsOf, addUser, log, hooks,
    failNext: (table, op, message = 'boom') => fail.set(`${table}:${op}`, message),
    token: (user) => 'tok-' + user.id,
    uuid: () => crypto.randomUUID(),
  };
}

module.exports = { makeDb };
