import { inflateRawSync } from 'node:zlib';

/**
 * The words inside a Word (.docx) or Excel (.xlsx) file, so a model can read what a buyer's PO or
 * price list says. Both are zip archives of XML; this reads the archive's directory, inflates the
 * parts that hold text, and strips the markup. The older binary .doc and .xls are not read.
 *
 * Limits are deliberate: a file is untrusted, so an archive that claims more than it should
 * inflate to, or has too many entries, is refused rather than unpacked.
 */

const MAX_ENTRIES = 2000;
const MAX_PART_BYTES = 8 * 1024 * 1024;
/** More than a model needs to say what a document is and what it states. */
export const MAX_TEXT = 12000;

function entriesOf(buffer) {
  /* The end-of-central-directory record: within the last 64 KB + 22 bytes. */
  const floor = Math.max(0, buffer.length - 65557);
  let end = -1;
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) return null;
  const count = buffer.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) return null;
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) return null;
    const method = buffer.readUInt16LE(at + 10);
    const packed = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.set(name, { method, packed, size, local });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function partOf(buffer, entry) {
  if (!entry || entry.size > MAX_PART_BYTES) return null;
  const at = entry.local;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const data = buffer.subarray(start, start + entry.packed);
  try {
    if (entry.method === 0) return data.toString('utf8');
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_PART_BYTES }).toString('utf8');
  } catch {
    return null;
  }
  return null;
}

const decode = (text) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

const tidy = (text) => text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);

/** Paragraphs and table cells of a .docx, one per line. */
function wordText(entries, buffer) {
  const xml = partOf(buffer, entries.get('word/document.xml'));
  if (xml == null) return null;
  return tidy(
    decode(
      xml
        .replace(/<w:tab\/>/g, '\t')
        .replace(/<\/w:tc>/g, ' | ')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
    )
  );
}

/** Each sheet's rows, cells separated by " | ", shared strings resolved. */
function sheetText(entries, buffer) {
  const sharedXml = partOf(buffer, entries.get('xl/sharedStrings.xml')) || '';
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(([, si]) =>
    decode([...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(([, t]) => t).join(''))
  );
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!sheets.length) return null;
  const out = [];
  for (const name of sheets) {
    const xml = partOf(buffer, entries.get(name));
    if (xml == null) continue;
    if (sheets.length > 1) out.push(`[${name.match(/sheet\d+/)[0]}]`);
    for (const [, row] of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map(([, attrs, inner = '']) => {
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        if (type === 'inlineStr') return decode((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || '');
        const value = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (value == null) return '';
        return type === 's' ? shared[Number(value)] ?? '' : decode(value);
      });
      if (cells.some((cell) => cell.trim())) out.push(cells.join(' | '));
      if (out.join('\n').length > MAX_TEXT) break;
    }
  }
  return tidy(out.join('\n'));
}

export const OFFICE_TYPES = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': wordText,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': sheetText,
};

/** The text of a .docx or .xlsx, or null when it is not one or cannot be read. Never throws. */
export function officeText(buffer, mimeType) {
  const read = OFFICE_TYPES[mimeType];
  if (!read || !buffer?.length) return null;
  try {
    const entries = entriesOf(buffer);
    return entries ? read(entries, buffer) || null : null;
  } catch {
    return null;
  }
}
