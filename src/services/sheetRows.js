import { decode, entriesOf, partOf } from './officeText.js';

/**
 * The rows of an uploaded table — the first sheet of an .xlsx, or a .csv — as arrays of cell
 * text, with blank cells kept in their column so a header lines up with its values.
 *
 * For registers kept in Excel (the trading master first): read here, mapped by header in the
 * service that owns the register. Untrusted input, so the archive limits in officeText apply
 * and a row count is capped.
 */

export const MAX_ROWS = 5000;

const XLSX_MAGIC = 0x04034b50;

/** "C" → 2, "AB" → 27. */
const columnIndex = (letters) =>
  [...letters].reduce((total, letter) => total * 26 + (letter.charCodeAt(0) - 64), 0) - 1;

function xlsxRows(buffer) {
  const entries = entriesOf(buffer);
  if (!entries) return null;
  const sharedXml = partOf(buffer, entries.get('xl/sharedStrings.xml')) || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    decode([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''))
  );
  const first = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]))[0];
  const xml = first && partOf(buffer, entries.get(first));
  if (xml == null) return null;

  const rows = [];
  for (const [, body] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    let next = 0;
    for (const [, attrs, inner = ''] of body.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
      const at = ref ? columnIndex(ref) : next;
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      let value;
      if (type === 'inlineStr') value = decode((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
      else {
        const raw = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = raw == null ? '' : type === 's' ? shared[Number(raw)] ?? '' : decode(raw);
      }
      row[at] = String(value).trim();
      next = at + 1;
    }
    rows.push(Array.from(row, (cell) => cell ?? ''));
    if (rows.length > MAX_ROWS) break;
  }
  return rows;
}

/** RFC 4180 enough: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { cell += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(cell.trim()); cell = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_ROWS) return rows;
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows;
}

/** The rows of an .xlsx or .csv, told apart by content; null when it is neither. */
export function sheetRows(buffer) {
  if (!buffer?.length) return null;
  try {
    if (buffer.length > 4 && buffer.readUInt32LE(0) === XLSX_MAGIC) return xlsxRows(buffer);
    const text = buffer.toString('utf8');
    if (text.includes('\u0000')) return null;
    return csvRows(text);
  } catch {
    return null;
  }
}
