'use strict';
// Small RFC 4180 CSV reader/writer (quoted fields, doubled quotes, CRLF, embedded newlines, BOM).
// No dependency so the import path stays easy to audit.

function parseCsv(text) {
  let s = String(text == null ? '' : text);
  if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
  const rows = [];
  let row = []; let field = ''; let inQuotes = false; let i = 0; let sawAny = false;
  while (i < s.length) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQuotes = true; sawAny = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; sawAny = true; i++; continue; }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = ''; i++;
      if (sawAny || row.length > 1 || row[0] !== '') rows.push(row);
      row = []; sawAny = false; continue;
    }
    field += c; sawAny = true; i++;
  }
  if (inQuotes) throw new Error('The file has an unclosed quote');
  if (sawAny || field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Header row + data rows -> [{header: value}] with trimmed, lower-cased headers.
function parseCsvObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const records = rows.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 };
    headers.forEach((h, k) => { if (h) o[h] = (r[k] == null ? '' : r[k]).trim(); });
    return o;
  });
  return { headers, records };
}

// Cells that start with = + - @ are formulas in Excel/Sheets; prefix so an exported file cannot run one.
function safeCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => safeCell(r[h])).join(','));
  return lines.join('\r\n') + '\r\n';
}

module.exports = { parseCsv, parseCsvObjects, toCsv };
