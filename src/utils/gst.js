import { company } from '../config/company.js';

/**
 * GST on a sales order, the way an Indian tax invoice carries it.
 *
 *   HSN           the tariff heading each line is taxed under — the mould's, else the plant's
 *                 (3926 90, other articles of plastics, for a moulded hanger)
 *   rate          the line's GST %, else the order's; 0 on an export (zero-rated)
 *   split         within the plant's state the tax is CGST + SGST, half each; to another state
 *                 it is IGST at the full rate — decided by the place of supply, the buyer's
 *                 state (from their GSTIN's first two digits, else the state on their record)
 *   round-off     the invoice total is rounded to the rupee, the paise said on their own line
 *                 [CGST Act s.170]
 *
 * A quotation carries none of this: it is a rate, said to be "GST extra" — the tax is a fact
 * about the invoice [config/company.js `gstNote`].
 */

export const DEFAULT_GST_PERCENT = 18;

/** The state codes GSTINs begin with. */
export const GST_STATES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Daman & Diu', '26': 'Dadra & Nagar Haveli and Daman & Diu', '27': 'Maharashtra',
  '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman & Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

/* Names the register may hold for a state, beside the official one. */
const ALIASES = { orissa: '21', pondicherry: '34', uttaranchal: '05', bangalore: '29', bengaluru: '29', madras: '33', chennai: '33', tirupur: '33', coimbatore: '33', bombay: '27', mumbai: '27', calcutta: '19', kolkata: '19', newdelhi: '07' };
const plain = (value) => String(value || '').toLowerCase().replace(/[^a-z]/g, '');
const round2 = (value) => Math.round(value * 100) / 100;

/** A state's code from its name — "Tamil Nadu", "tamilnadu", "TN" — or null. */
export function stateCodeOfName(name) {
  const key = plain(name);
  if (!key) return null;
  if (ALIASES[key]) return ALIASES[key];
  const found = Object.entries(GST_STATES).find(([, state]) => plain(state) === key);
  if (found) return found[0];
  /* "Tamil Nadu, India", "Karnataka State" */
  const starts = Object.entries(GST_STATES).find(([, state]) => key.startsWith(plain(state)) || plain(state).startsWith(key) && key.length >= 5);
  return starts ? starts[0] : null;
}

/** The state a GSTIN begins with, or null when it is not one. */
export const stateCodeOfGstin = (gstin) => {
  const code = String(gstin || '').trim().slice(0, 2);
  return /^\d{2}$/.test(code) && GST_STATES[code] ? code : null;
};

/** The plant's own state — from its GSTIN. */
export const companyStateCode = () => stateCodeOfGstin(company.gstin) || '33';

/**
 * The place of supply for a buyer: their GSTIN's state first (a registered buyer is taxed where
 * they are registered), else the state on their record. `known` is false when neither says —
 * the split then assumes the plant's own state, and the order says so.
 */
export function placeOfSupplyFor(customer, { isExport = false } = {}) {
  const home = companyStateCode();
  if (isExport) return { code: null, state: 'Export', intraState: false, known: true, export: true };
  const code = stateCodeOfGstin(customer?.gstin) || stateCodeOfName(customer?.state) || null;
  return {
    code: code || home,
    state: GST_STATES[code || home],
    intraState: (code || home) === home,
    known: Boolean(code),
    export: false,
  };
}

const num = (value) => (value == null || value === '' ? null : Number(value));

/**
 * The tax on an order's lines. Each line: its HSN, rate, taxable value, the CGST/SGST or IGST
 * on it and its total; then the sums, the round-off and the invoice total to the rupee.
 */
export function taxOn({ lines = [], gstPercent, isExport = false, intraState = true, hsnCode } = {}) {
  /* An order with no rate on it or its lines carries no tax — the forms start a new order at 18%. */
  const orderRate = num(gstPercent) ?? 0;
  const rows = lines.map((line) => {
    const quantity = Number(line.quantity) || 0;
    const price = Number(line.unitPrice) || 0;
    const taxable = round2(quantity * price);
    const rate = isExport ? 0 : num(line.gstPercent) ?? orderRate;
    const tax = round2((taxable * rate) / 100);
    const half = round2(tax / 2);
    return {
      hsnCode: String(line.hsnCode || hsnCode || company.hsnCode || '').trim() || null,
      gstPercent: rate,
      taxable,
      cgst: intraState && !isExport ? half : 0,
      sgst: intraState && !isExport ? round2(tax - half) : 0,
      igst: !intraState && !isExport ? tax : 0,
      tax,
      total: round2(taxable + tax),
    };
  });
  const sum = (key) => round2(rows.reduce((total, row) => total + row[key], 0));
  const taxable = sum('taxable');
  const tax = sum('tax');
  const gross = round2(taxable + tax);
  const total = Math.round(gross);
  return {
    lines: rows,
    taxable,
    cgst: sum('cgst'),
    sgst: sum('sgst'),
    igst: sum('igst'),
    tax,
    gross,
    roundOff: round2(total - gross),
    total,
    intraState: Boolean(intraState) && !isExport,
    isExport: Boolean(isExport),
    /* The rates on the order, for the summary line — "GST 18%", or "GST 12% / 18%". */
    rates: [...new Set(rows.map((row) => row.gstPercent))].sort((a, b) => a - b),
  };
}
