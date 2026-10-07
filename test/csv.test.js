'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv, parseCsvObjects, toCsv } = require('../src/lib/csv');

test('parses quotes, commas, doubled quotes, newlines, CRLF and a BOM', () => {
  const rows = parseCsv('\uFEFFa,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x, y', 'say "hi"'], ['2', 'line1\nline2', '']]);
});

test('skips blank lines and rejects an unclosed quote', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,2\n,\n'), [['a', 'b'], ['1', '2']]);
  assert.throws(() => parseCsv('a,b\n1,"oops'), /unclosed quote/);
});

test('objects use trimmed lower-case headers and report the file line', () => {
  const { headers, records } = parseCsvObjects(' Name , PRICE \nTea, 3\nCake,4');
  assert.deepEqual(headers, ['name', 'price']);
  assert.deepEqual(records.map((r) => [r.__line, r.name, r.price]), [[2, 'Tea', '3'], [3, 'Cake', '4']]);
});

test('toCsv quotes when needed and neutralises spreadsheet formulas', () => {
  const out = toCsv(['name', 'note'], [{ name: 'A, B', note: '=HYPERLINK("x")' }, { name: '-5', note: '-cmd' }]);
  assert.equal(out, 'name,note\r\n"A, B","\'=HYPERLINK(""x"")"\r\n-5,\'-cmd\r\n');
});
