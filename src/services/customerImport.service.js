import Customer, { CUSTOMER_SOURCES, CUSTOMER_TYPES, DELIVERY_MODES, RATINGS } from '../models/Customer.js';
import User from '../models/User.js';
import { normalisePhone } from '../utils/phone.js';
import { GST_STATES, stateCodeOfGstin } from '../utils/gst.js';
import { canOwnBuyer } from './assignment.service.js';
import { nextNumber } from './numbering.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { customerKeys } from '../utils/customerKeys.js';
import { xlsxBuffer } from '../utils/xlsxWriter.js';

/**
 * Customers from an Excel sheet [controllers/customerImport.controller.js] — the customer master
 * the business already keeps, brought in at once.
 *
 * The template [`templateBuffer`] has the columns and one sample row, and a second sheet saying
 * what goes in each. The header is found by its words, so a sheet of the business's own with
 * the same headings reads too. Nothing is written until the person has seen what would happen:
 * the same call answers a preview first, and creates only when asked to.
 *
 *   contacts the contact person (primary), a Purchase contact and an Accounts contact — each
 *            with name, mobile and email; the accounts one is Accounts & Payments on the card
 *   needed   Customer name, Mobile, and a marketing owner — the Marketing owner column (their
 *            email or name), or one picked on the upload screen for every row that leaves it blank
 *   checked  the GST number's shape, the email, a 6-digit pincode, the drop-down words
 *   skipped  a customer already on the books, by GST number or phone — and the second of two
 *            rows naming the same buyer
 */

/** Each column: the field, its heading in the template, the other headings it is known by. */
export const COLUMNS = [
  { field: 'name', heading: 'Customer name', also: ['customer', 'company', 'company name', 'name', 'buyer', 'party', 'party name', 'customer name'], required: true, help: 'The company name, as on the GST certificate', sample: 'Sri Lakshmi Garments' },
  { field: 'customerType', heading: 'Customer type', also: ['type', 'business type', 'category'], help: 'One of: Garment factory, Exporter, Buying house, Retailer, Domestic distributor, Overseas buyer. Blank = Garment factory', sample: 'Garment factory' },
  { field: 'contactPerson', heading: 'Contact person', also: ['contact', 'contact name', 'person'], help: 'Who you talk to there', sample: 'R. Senthil Kumar' },
  { field: 'designation', heading: 'Designation', also: ['role', 'position'], help: 'Their role — Owner, Director, Manager', sample: 'Owner' },
  { field: 'mobile', heading: 'Mobile', also: ['mobile number', 'mobile no', 'phone', 'phone number', 'contact number', 'cell'], required: true, help: '10-digit mobile number (a +country code for an overseas buyer)', sample: '9876543210' },
  { field: 'whatsapp', heading: 'WhatsApp', also: ['whatsapp number', 'whatsapp no'], help: 'Blank = same as Mobile', sample: '9876543210' },
  { field: 'email', heading: 'Email', also: ['email id', 'mail', 'e mail', 'email address'], help: 'The company’s main email', sample: 'info@srilakshmigarments.in' },
  { field: 'purchaseName', heading: 'Purchase contact', also: ['purchase person', 'purchase name', 'purchase contact name', 'purchase manager'], help: 'Who places the orders — saved as a contact marked Purchase', sample: 'M. Priya' },
  { field: 'purchaseMobile', heading: 'Purchase mobile', also: ['purchase phone', 'purchase number', 'purchase contact mobile'], help: 'Their mobile number', sample: '9894012345' },
  { field: 'purchaseEmail', heading: 'Purchase email', also: ['purchase mail', 'purchase contact email'], help: 'Their email — purchase orders and quotations', sample: 'purchase@srilakshmigarments.in' },
  { field: 'accountsName', heading: 'Accounts contact', also: ['accounts person', 'accounts name', 'accounts contact name', 'accountant', 'payments contact'], help: 'Who settles the bills — shown as Accounts & Payments on the buyer’s contact card', sample: 'K. Ramesh' },
  { field: 'accountsMobile', heading: 'Accounts mobile', also: ['accounts phone', 'accounts number', 'accounts contact mobile'], help: 'Their mobile number — payment follow-ups', sample: '9894054321' },
  { field: 'accountsEmail', heading: 'Accounts email', also: ['accounts mail', 'accounts contact email'], help: 'Their email — invoices and statements', sample: 'accounts@srilakshmigarments.in' },
  { field: 'gstin', heading: 'GST number', also: ['gstin', 'gst', 'gst no', 'gstin no', 'gst number'], help: '15 characters, like 33ABCDE1234F1Z5. Blank if the buyer has none (overseas, unregistered)', sample: '33ABCDE1234F1Z5' },
  { field: 'address', heading: 'Address', also: ['address line', 'address 1', 'street', 'door no', 'billing address'], help: 'Door number and street — where a lorry delivers', sample: 'No. 12, 3rd Street, Kumaran Nagar' },
  { field: 'area', heading: 'Area', also: ['locality'], help: 'Locality or industrial estate', sample: 'Avinashi Road' },
  { field: 'landmark', heading: 'Landmark', also: [], help: 'Optional — near what', sample: 'Opp. Bus Stand' },
  { field: 'city', heading: 'City', also: ['town', 'district'], help: 'City or town', sample: 'Tiruppur' },
  { field: 'state', heading: 'State', also: [], help: 'Blank = read from the GST number', sample: 'Tamil Nadu' },
  { field: 'pincode', heading: 'Pincode', also: ['pin', 'pin code', 'postal code', 'zip'], help: '6 digits', sample: '641603' },
  { field: 'country', heading: 'Country', also: [], help: 'Blank = India', sample: 'India' },
  { field: 'deliveryMode', heading: 'Delivery mode', also: ['delivery', 'dispatch mode', 'mode of delivery'], help: 'One of: Own vehicle, Transport, Party collects, Courier', sample: 'Transport' },
  { field: 'creditTermsDays', heading: 'Credit days', also: ['credit', 'credit period', 'credit terms', 'credit terms days'], help: 'Number of days, like 30. Blank = 0', sample: '30' },
  { field: 'paymentTerms', heading: 'Payment terms', also: ['terms'], help: 'In words — 30 days from invoice, 50% advance', sample: '30 days from invoice' },
  { field: 'rating', heading: 'Rating', also: ['grade'], help: 'A, B or C', sample: 'A' },
  { field: 'source', heading: 'Source', also: ['lead source', 'how found'], help: 'One of: Manual, Phone, Email, Walk-in, Referral, Trade show, WhatsApp, IndiaMART. Blank = Manual', sample: 'Referral' },
  { field: 'owner', heading: 'Marketing owner', also: ['owner', 'marketing owner email', 'marketing person', 'sales person', 'salesperson', 'assigned to', 'account owner'], help: 'The marketing person’s email or name in the app. Blank = the owner you pick on the upload screen', sample: '' },
  { field: 'notes', heading: 'Notes', also: ['remarks', 'comments'], help: 'Anything else', sample: 'Sample row — replace it with your customers' },
];

const FIELDS = COLUMNS.map((column) => column.field);
const LABEL = Object.fromEntries(COLUMNS.map((column) => [column.field, column.heading]));
const squeeze = (text) => String(text || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const words = (key) => key.replace(/_/g, ' ');
/** "Garment factory", "garment-factory", "GARMENT FACTORY" → garment_factory; "IndiaMART" → indiamart. */
const pick = (raw, options) => {
  const said = squeeze(raw).replace(/\s+/g, '');
  return options.find((option) => option.replace(/_/g, '').toLowerCase() === said) || null;
};

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Which field each column of a header row is, or null for one nobody asked for. */
export function headerMap(header) {
  return header.map((cell) => {
    const word = squeeze(cell);
    if (!word) return null;
    return COLUMNS.find((column) => squeeze(column.heading) === word || column.also.includes(word))?.field || null;
  });
}

/** The header row: the first of the opening ten naming the customer. */
export function findHeader(rows) {
  for (let at = 0; at < Math.min(rows.length, 10); at += 1) {
    const map = headerMap(rows[at] || []);
    if (map.includes('name')) return { at, map };
  }
  return null;
}

/** One row as a customer's fields, with what is wrong with it. */
export function readRow(cells, map) {
  const raw = {};
  map.forEach((field, index) => {
    if (field && raw[field] === undefined) raw[field] = String(cells[index] ?? '').trim();
  });
  const fields = {};
  const problems = [];
  for (const field of FIELDS) {
    const value = raw[field];
    if (!value) continue;
    switch (field) {
      case 'customerType': {
        const type = pick(value, CUSTOMER_TYPES);
        if (type) fields.customerType = type;
        else problems.push(`Customer type "${value}" — use ${CUSTOMER_TYPES.map(words).join(', ')}`);
        break;
      }
      case 'deliveryMode': {
        const mode = pick(value, DELIVERY_MODES);
        if (mode) fields.deliveryMode = mode;
        else problems.push(`Delivery mode "${value}" — use ${DELIVERY_MODES.map(words).join(', ')}`);
        break;
      }
      case 'source': {
        const source = pick(value, CUSTOMER_SOURCES);
        if (source) fields.source = source;
        else problems.push(`Source "${value}" — use ${CUSTOMER_SOURCES.map(words).join(', ')}`);
        break;
      }
      case 'rating': {
        const rating = value.toUpperCase();
        if (RATINGS.includes(rating)) fields.rating = rating;
        else problems.push(`Rating "${value}" — use A, B or C`);
        break;
      }
      case 'creditTermsDays': {
        const days = Number(value.replace(/days?/i, '').trim());
        if (Number.isInteger(days) && days >= 0 && days <= 365) fields.creditTermsDays = days;
        else problems.push(`Credit days "${value}" is not a number of days`);
        break;
      }
      case 'gstin': {
        const gstin = value.toUpperCase().replace(/\s+/g, '');
        if (GSTIN.test(gstin)) fields.gstin = gstin;
        else problems.push(`GST number "${value}" is not 15 characters like 33ABCDE1234F1Z5`);
        break;
      }
      case 'email':
      case 'purchaseEmail':
      case 'accountsEmail':
        if (EMAIL.test(value)) fields[field] = value.toLowerCase();
        else problems.push(`${LABEL[field]} "${value}" is not an email address`);
        break;
      case 'mobile':
      case 'whatsapp':
      case 'purchaseMobile':
      case 'accountsMobile': {
        const number = normalisePhone(value.replace(/\.0+$/, ''));
        const digits = String(number || '').replace(/\D/g, '');
        if (number && digits.length >= 10 && digits.length <= 15) fields[field] = number;
        else problems.push(`${LABEL[field]} "${value}" is not a phone number`);
        break;
      }
      case 'pincode': {
        const pin = value.replace(/\s+/g, '').replace(/\.0+$/, '');
        if (/^\d{6}$/.test(pin) || (raw.country && !/^india$/i.test(raw.country))) fields.pincode = pin;
        else problems.push(`Pincode "${value}" is not 6 digits`);
        break;
      }
      default:
        fields[field] = value.slice(0, field === 'address' || field === 'notes' ? 500 : 160);
    }
  }
  if (!fields.name) problems.unshift('No customer name');
  else if (fields.name.length < 2) problems.push('Customer name is too short');
  if (!fields.mobile && !raw.mobile) problems.push('No mobile number');
  /* The state from the GST number where the sheet leaves it out. */
  if (!fields.state && fields.gstin) fields.state = GST_STATES[stateCodeOfGstin(fields.gstin)] || undefined;
  if (fields.mobile && !fields.whatsapp) fields.whatsapp = fields.mobile;
  return { fields, problems };
}

/** A customer's record from a row's fields: the contact person as the primary contact. */
function recordOf(fields, assignedTo) {
  const {
    contactPerson, designation, owner, purchaseName, purchaseMobile, purchaseEmail, accountsName, accountsMobile, accountsEmail, ...rest
  } = fields;
  const contacts = [];
  if (contactPerson) contacts.push({ name: contactPerson, designation, mobile: fields.mobile, whatsapp: fields.whatsapp, email: fields.email, isPrimary: true });
  /* The purchase contact: a contact of its own, marked Purchase — the primary one when no contact person is given. */
  if (purchaseName || purchaseMobile || purchaseEmail) {
    contacts.push({ name: purchaseName || 'Purchase', designation: 'Purchase', mobile: purchaseMobile, whatsapp: purchaseMobile, email: purchaseEmail, isPrimary: !contacts.length });
  }
  return {
    ...rest,
    source: rest.source || 'manual',
    ...(contacts.length ? { contacts } : {}),
    /* Accounts & Payments on the buyer's contact card [Customer `accountsContact`]. */
    ...(accountsName || accountsMobile || accountsEmail ? { accountsContact: { sameAsOrder: false, name: accountsName, phone: accountsMobile, email: accountsEmail } } : {}),
    assignedTo,
  };
}

/** The marketing people a sheet may name, by email and by name. */
async function ownersByWord() {
  const people = await User.find({ isActive: { $ne: false }, $or: [{ department: 'marketing' }, { role: 'admin' }] }).select('name email department role isActive').lean();
  const map = new Map();
  for (const person of people) {
    if (!(await canOwnBuyer(person))) continue;
    if (person.email) map.set(person.email.toLowerCase(), person);
    if (person.name && !map.has(person.name.toLowerCase())) map.set(person.name.toLowerCase(), person);
  }
  return map;
}

/**
 * What the upload would do, row by row: create, skip one already on the books, or refuse with
 * the reason. `defaultOwner` is the marketing person picked on the screen, for rows naming none.
 */
export async function planImport(rows, { defaultOwner = null } = {}) {
  const header = findHeader(rows);
  if (!header) return { error: 'No header row with a Customer name column in the first ten rows — start from the template.' };

  const read = rows.slice(header.at + 1)
    .map((cells, offset) => ({ row: header.at + offset + 2, ...readRow(cells, header.map) }))
    .filter((entry) => Object.values(entry.fields).some(Boolean) && !(Object.keys(entry.fields).length === 1 && entry.fields.state));

  const owners = await ownersByWord();
  const fallback = defaultOwner ? await User.findById(defaultOwner).select('name email department role isActive').lean() : null;
  if (defaultOwner && !(fallback && (await canOwnBuyer(fallback)))) {
    return { error: 'The owner picked is not an active marketing person or administrator — pick another.' };
  }

  const gstins = read.map((entry) => entry.fields.gstin).filter(Boolean);
  const phones = read.flatMap((entry) => [entry.fields.mobile, entry.fields.whatsapp]).filter(Boolean);
  const existing = await Customer.find({ $or: [{ gstin: { $in: gstins } }, { mobile: { $in: phones } }, { whatsapp: { $in: phones } }] })
    .select('code name gstin mobile whatsapp').lean();
  const known = (fields) => existing.find((row) => (fields.gstin && row.gstin === fields.gstin)
    || [fields.mobile, fields.whatsapp].filter(Boolean).some((number) => number === row.mobile || number === row.whatsapp));

  const seen = new Map();
  const plan = read.map(({ row, fields, problems }) => {
    const out = { row, fields };
    /* Already a customer — by GST number or phone: skipped, whatever else the row lacks. */
    const match = known(fields);
    if (match) return { ...out, action: 'exists', existing: { _id: match._id, code: match.code, name: match.name } };
    const ownerWord = String(fields.owner || '').trim().toLowerCase();
    const owner = ownerWord ? owners.get(ownerWord) : fallback;
    if (ownerWord && !owner) problems.push(`Marketing owner "${fields.owner}" is not a marketing person in the app — use their email`);
    else if (!owner) problems.push('No marketing owner — fill the column, or pick an owner on the upload screen');
    if (problems.length) return { ...out, action: 'error', problems };
    const keys = customerKeys(fields);
    const twin = keys.map((key) => seen.get(key)).find(Boolean);
    if (twin) return { ...out, action: 'error', problems: [`Same GST number or phone as row ${twin}`] };
    keys.forEach((key) => seen.set(key, row));
    return { ...out, action: 'create', owner: { _id: owner._id, name: owner.name } };
  });

  const count = (action) => plan.filter((entry) => entry.action === action).length;
  return { plan, summary: { create: count('create'), exists: count('exists'), error: count('error') } };
}

/** Writes a plan's new customers, each with its CUST number — checked once more for a twin made meanwhile. */
export async function applyImport(plan) {
  let created = 0;
  let skipped = 0;
  const made = [];
  for (const entry of plan.filter((row) => row.action === 'create')) {
    const record = recordOf(entry.fields, entry.owner._id);
    // eslint-disable-next-line no-await-in-loop
    await withCreateLocks(customerKeys(record), async () => {
      const numbers = [record.mobile, record.whatsapp].filter(Boolean);
      const twin = await Customer.exists({ $or: [...(record.gstin ? [{ gstin: record.gstin }] : []), ...(numbers.length ? [{ mobile: { $in: numbers } }, { whatsapp: { $in: numbers } }] : [])] });
      if (twin) { skipped += 1; return; }
      const customer = await Customer.create({ ...record, code: await nextNumber('CUST') });
      made.push({ row: entry.row, _id: customer._id, code: customer.code, name: customer.name });
      created += 1;
    });
  }
  return { created, skipped, made };
}

/** The template: the Customers sheet with its headings and one sample row, and How to fill. */
export function templateBuffer() {
  return xlsxBuffer([
    {
      name: 'Customers',
      header: true,
      rows: [COLUMNS.map((column) => (column.required ? `${column.heading} *` : column.heading)), COLUMNS.map((column) => column.sample)],
      widths: COLUMNS.map((column) => Math.max(14, Math.min(34, Math.max(column.heading.length + 4, String(column.sample).length + 2)))),
    },
    {
      name: 'How to fill',
      header: true,
      rows: [
        ['Column', 'Needed?', 'What to write', 'Example'],
        ...COLUMNS.map((column) => [column.heading, column.required ? 'Yes' : column.field === 'owner' ? 'Yes — or pick one when uploading' : 'No', column.help, column.sample]),
        [],
        ['One row per customer. Keep the heading row as it is; delete the sample row (or keep it to try the upload).'],
        ['A customer already in the app — same GST number or phone — is skipped, never doubled.'],
        ['The upload shows what it will do first; nothing is created until you press Import.'],
      ],
      widths: [20, 30, 80, 32],
    },
  ]);
}
