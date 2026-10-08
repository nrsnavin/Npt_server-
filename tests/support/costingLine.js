/**
 * Fixture: the costing sheet's old calls, answered by a quotation's first line.
 *
 * The costing sheet and the quotation are one record now [src/models/Quotation.js]: a costing
 * lives on a quotation line, raised with `POST /api/quotations` and built with
 * `PATCH /api/quotations/:id/lines/:lineId/cost`. Many register tests (grams, resin rates, part
 * rates, staleness) were written against the old sheet's single-model shape and test rules that
 * have not changed. This routes those calls to the quotation's first line and hands back the
 * line's fields flat, so the rules are still checked against the real endpoints.
 *
 * New tests should call the quotation endpoints directly — see tests/quotation-costing.test.js.
 */
const LINE_FIELDS = [
  'mould', 'materialRef', 'hookRef', 'clipRef', 'printRef', 'modelNumber', 'material',
  'procurement', 'printing', 'markupPercent', 'moq', 'colour', 'unitPrice',
];

/** The quotation, with its first line's fields at the top as the sheet used to read. */
const flatten = (quotation) => {
  if (!quotation?.lines) return quotation;
  const line = quotation.lines[0] || {};
  return { ...quotation, ...line, _id: quotation._id, number: quotation.number, lineId: line._id, status: line.status, quotationStatus: quotation.status };
};

const flat = (response) => {
  const data = response.json?.data;
  if (Array.isArray(data)) response.json.data = data.map(flatten);
  else if (data?.lines) response.json.data = flatten(data);
  return response;
};

export function withCostingLines(api) {
  const lineOf = async (id, token, named) =>
    named || (await api(`/api/quotations/${id}`, { token })).json.data?.lines?.[0]?._id;

  return async (path, options = {}) => {
    const { method = 'GET', body = {}, token } = options;
    const [route, query = ''] = path.split('?');
    const match = route.match(/^\/api\/pricings(?:\/([0-9a-f]{24}))?(?:\/(cost|decision))?$/);
    if (!match) return api(path, options);
    const [, id, action] = match;

    if (!id && method === 'POST') {
      const { customer, enquiry, targetPrice, remarks, lines } = body;
      const line = Object.fromEntries(Object.entries(body).filter(([key]) => LINE_FIELDS.includes(key)));
      if (!line.mould && !line.modelNumber) line.modelNumber = 'NH-400';
      return flat(await api('/api/quotations', {
        ...options, body: { customer, enquiry, targetPrice, remarks, lines: lines || [line] },
      }));
    }
    if (!id) return flat(await api(`/api/quotations${query ? `?${query}` : ''}`, options));
    if (!action) return flat(await api(`/api/quotations/${id}`, options));

    const { line: named, approvedSellingPrice, ...rest } = body;
    const lineId = await lineOf(id, token, named);
    const sent = action === 'cost'
      ? { ...rest, ...(approvedSellingPrice !== undefined ? { unitPrice: approvedSellingPrice } : {}) }
      : rest;
    return flat(await api(`/api/quotations/${id}/lines/${lineId}/${action}`, {
      ...options, method: action === 'cost' ? 'PATCH' : 'POST', body: sent,
    }));
  };
}
