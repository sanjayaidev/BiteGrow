'use strict';
// Shared by the cart and order routes: validate what the browser sends, do the
// money in whole cents (so 0.10 x 3 is exactly 0.30), and look up real prices.
//
// Nothing the browser says about a price or a name is ever used. It sends item
// ids and quantities; the server reads the rest from this restaurant's own menu.

const MAX_QTY = 50;       // per item
const MAX_LINES = 50;     // distinct items per request

// Money in whole cents. Prices come from numeric(10,2) columns.
const toCents = (n) => Math.round(Number(n) * 100);
const fromCents = (c) => c / 100;

// 12, "12" -> 12; 1.5, "1.5", "", null, "abc", NaN -> null
function toInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  if (typeof v === 'string' && /^-?\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
}

// [{ menu_item_id, quantity }] -> { lines: [{ id, qty }] } with duplicates merged, or { error }.
function normalizeLines(items, { allowEmpty = false } = {}) {
  if (!Array.isArray(items)) return { error: 'items must be a list' };
  if (!items.length && !allowEmpty) return { error: 'Add at least one item' };
  if (items.length > MAX_LINES) return { error: 'Too many items in one request' };

  const merged = new Map();
  for (const l of items) {
    const id = toInt(l && l.menu_item_id);
    const qty = toInt(l && l.quantity);
    if (id === null || id <= 0) return { error: 'Invalid menu item' };
    if (qty === null || qty < 1 || qty > MAX_QTY) return { error: `Quantity must be between 1 and ${MAX_QTY}` };
    const total = (merged.get(id) || 0) + qty;
    if (total > MAX_QTY) return { error: `At most ${MAX_QTY} of one item per order` };
    merged.set(id, total);
  }
  return { lines: [...merged].map(([id, qty]) => ({ id, qty })) };
}

// This restaurant's orderable items by id -> Map(id -> row). Another restaurant's ids, hidden and sold-out items simply do not appear.
async function fetchAvailableItems(supabase, tenantId, ids) {
  if (!ids.length) return new Map();
  const { data, error } = await supabase.from('bg_menu_items')
    .select('id, name, price, image_url')
    .eq('tenant_id', tenantId)
    .eq('is_available', true)
    .in('id', ids);
  if (error) throw error;
  return new Map((data || []).map((r) => [r.id, r]));
}

module.exports = { MAX_QTY, MAX_LINES, toCents, fromCents, toInt, normalizeLines, fetchAvailableItems };
