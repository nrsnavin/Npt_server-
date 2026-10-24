/**
 * A load sent on a Dispatch request the way the dispatch form sends it [handoff.controller
 * `handoffDispatchLoad`]: the models (named, or every model not yet sent), the pieces of each (named,
 * or what is left of the order — half of it for a part load — at least one), how it travels, and
 * the paper that proves it. The app reads Part Quantity Dispatched or Fully Dispatched from what went.
 */
export async function dispatchLoad({ baseUrl, token, taskId, status, note, models, pieces, mode = 'transporter' }) {
  const auth = { Authorization: `Bearer ${token}` };
  const sheet = (await (await fetch(`${baseUrl}/api/workspace/todos/${taskId}/dispatch`, { headers: auth })).json()).data || { models: [] };
  const named = (Array.isArray(models) ? models : String(models || '').split(',')).map((model) => String(model).trim()).filter(Boolean);
  const rows = named.length
    ? named.map((model) => sheet.models.find((row) => row.model.toLowerCase() === model.toLowerCase()) || { model, ordered: 0, sent: 0 })
    : sheet.models.filter((row) => row.ordered - row.sent > 0 || !row.ordered);
  const each = pieces && rows.length ? Math.max(1, Math.floor(Number(pieces) / rows.length)) : null;
  const lines = (rows.length ? rows : [{ model: 'All models', ordered: 1, sent: 0 }])
    /* A part load sends half of what is left (the app reads Part Quantity Dispatched from it); any other, all of it. */
    .map((row) => ({ model: row.model, quantity: each || (status === 'part_dispatched' ? Math.max(1, Math.floor((row.ordered - row.sent) / 2)) : Math.max(1, row.ordered - row.sent)) }));
  const form = new FormData();
  form.append('status', status);
  form.append('mode', mode);
  form.append('lines', JSON.stringify(lines));
  if (note) form.append('note', note);
  form.append('file', new Blob(['%PDF-1.4 proof'], { type: 'application/pdf' }), mode === 'transporter' ? 'lr-copy.pdf' : 'proof.pdf');
  const response = await fetch(`${baseUrl}/api/workspace/todos/${taskId}/dispatch`, { method: 'POST', headers: auth, body: form });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}
