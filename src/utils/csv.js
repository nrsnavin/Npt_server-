/**
 * CSV, for the export button every list screen needs.
 *
 * The plant runs on spreadsheets alongside this, and will for years. An export is not a
 * concession to that — it is how somebody builds a figure nobody thought to put on a
 * dashboard, and refusing it means they keep a parallel sheet by hand instead, which is the
 * thing the CRM exists to stop.
 *
 * Two details decide whether the file opens correctly on the machines it lands on.
 *
 * **Excel needs the byte-order mark** to read UTF-8. Without it, a customer named
 * "Sri Vēnkatēswara" arrives as mojibake on every Windows desktop in the office, and the
 * person who exported it concludes the data is wrong rather than the file.
 *
 * **A leading `=`, `+`, `-` or `@` is a formula**, not text. A remarks field beginning with
 * one is executed on open — that is CSV injection, and the field it most often appears in is
 * the free-text one somebody pasted from an email. Prefixed with a quote so it stays text.
 */

const DANGEROUS = /^[=+\-@\t\r]/;

/** One cell, escaped so a comma, a quote or a newline inside it cannot end it early. */
export function cell(value) {
  if (value === null || value === undefined) return '';

  let text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);

  /*
   * Neutralise a leading formula character before quoting, not after — on text only. A number
   * cannot be a formula, and prefixing one turned every negative balance and margin into the
   * text "'-5000", which no column total will add.
   */
  if (typeof value !== 'number' && DANGEROUS.test(text)) text = `'${text}`;

  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Rows into a CSV body.
 *
 * `columns` is a list of `[header, valueOf]`, so the file's shape is stated in one place and
 * reads as the table it becomes.
 */
export function toCsv(rows, columns) {
  const header = columns.map(([label]) => cell(label)).join(',');
  const body = rows.map((row) => columns.map(([, valueOf]) => cell(valueOf(row))).join(','));

  return [header, ...body].join('\r\n');
}

/** A turn of the event loop, so other people's requests are answered in between. */
const breathe = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The rows of an export query, read through a cursor in batches rather than all at once.
 *
 * An export can be five thousand populated records. Loading them in one go turned them into
 * documents in one uninterrupted stretch of a second or two, and every other request in the
 * process waited behind it — exports were 2% of clicks and set everybody's p95. Read in batches,
 * with a pause for the event loop after each, the export takes about as long and nobody else
 * notices it.
 */
export async function collect(query, { batchSize = 200 } = {}) {
  const rows = [];
  for await (const row of query.cursor({ batchSize })) {
    rows.push(row);
    if (rows.length % batchSize === 0) await breathe();
  }
  return rows;
}

/** Sends a CSV as a download, named for what it is and when it was taken. Written in chunks. */
export async function sendCsv(res, filename, rows, columns, { chunk = 500 } = {}) {
  const stamp = new Date().toISOString().slice(0, 10);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${stamp}.csv"`);
  /*
   * The byte-order mark, without which Excel reads UTF-8 as the local codepage and every
   * non-ASCII name arrives as mojibake.
   *
   * Worth knowing when testing this: the UTF-8 decoder strips a leading BOM, so reading the
   * response as text will never show it. Assert on the bytes, or the check passes on a file
   * that has one and fails on a file that does not, for the same reason.
   */
  res.write(`\uFEFF${columns.map(([label]) => cell(label)).join(',')}`);
  for (let start = 0; start < rows.length; start += chunk) {
    const lines = rows.slice(start, start + chunk).map((row) => columns.map(([, valueOf]) => cell(valueOf(row))).join(','));
    res.write(`\r\n${lines.join('\r\n')}`);
    if (start + chunk < rows.length) await breathe();
  }
  res.end();
}
