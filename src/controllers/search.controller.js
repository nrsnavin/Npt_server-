import Customer from '../models/Customer.js';
import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import SalesOrder from '../models/SalesOrder.js';
import Mould from '../models/Mould.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter } from '../services/ownership.service.js';
import { canRead } from '../services/access.service.js';
import { normalisePhone } from '../utils/phone.js';

/**
 * One search across everything [BLUEPRINT §32].
 *
 * The blueprint asks for customer, mobile, PO number, order number, invoice, model,
 * quotation number and sample number to retrieve the entire related history. Half those
 * records do not exist yet; the half that does is searched now and the rest join as their
 * modules land — the same way the customer timeline grows.
 *
 * Three things decide whether this is worth having.
 *
 * **A phone number is the query people actually type**, and they type it however it is
 * written on the card: `9876543210`, `098765 43210`, `+91 98765 43210`. Stored numbers are
 * normalised, so the query is normalised the same way before matching, or the one search
 * everybody reaches for is the one that returns nothing.
 *
 * **Grants and ownership both apply.** A search that reaches past them is a data leak with a
 * text box in front of it — and a marketing person searching a colleague's customer must get
 * the same nothing they would get from the list screen.
 *
 * **Grouped, not ranked into one list.** "SMP-2026-0004" and "Trendline Apparels" are
 * different questions, and a single relevance-sorted list makes the reader find the type
 * they meant among types they did not. Each group also says how many more it is not showing.
 */

/** Enough to recognise the record, not enough to be a list screen. */
const PER_GROUP = 6;

/** A search box takes user input; a stray `(` must not throw. */
const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Everything the query could be matched against.
 *
 * A number is matched both as typed and normalised: normalised catches the stored form, and
 * as-typed catches a partial — somebody remembering the last five digits.
 */
function patternsFor(query) {
  const patterns = [new RegExp(escape(query), 'i')];

  const normalised = normalisePhone(query);
  if (normalised && normalised !== query) patterns.push(new RegExp(escape(normalised), 'i'));

  return patterns;
}

/** `sample_required` is a database value; a person reading a list wants "Sample required". */
const readable = (value) =>
  typeof value === 'string' && value
    ? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    : value;

const anyOf = (fields, patterns) =>
  fields.flatMap((field) => patterns.map((pattern) => ({ [field]: pattern })));

export const globalSearch = asyncHandler(async (req, res) => {
  const query = String(req.query.q || '').trim();

  // Two characters matches most of the database and helps nobody.
  if (query.length < 2) {
    return res.json({ success: true, data: { query, groups: [] } });
  }

  const patterns = patternsFor(query);
  const user = req.user;

  /*
   * §32 does not ask for matching rows, it asks for "the entire related history". Typing a
   * customer's name has to reach their enquiries and their samples, which carry the customer
   * as a reference and not as text — matching each collection against the words alone would
   * answer a narrower question than the one being asked, and the reader would conclude the
   * customer has no samples rather than that the search does not join.
   *
   * Scoped like everything else, so the related records can only be ones already visible.
   */
  const matchedCustomers = canRead(user, 'customers')
    ? await Customer.find({
        $and: [
          { $or: anyOf(['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'], patterns) },
          ownershipFilter(user),
        ],
      })
        .select('_id')
        .limit(50)
    : [];

  const relatedTo = matchedCustomers.map((row) => row._id);

  /**
   * One group per record type. `module` is the grant it needs, and `scope` the ownership
   * filter for that type — samples scope on who asked for the sample, everything else on
   * who owns the record.
   */
  const sources = [
    {
      key: 'customers',
      label: 'Customers',
      module: 'customers',
      model: Customer,
      fields: ['name', 'code', 'gstin', 'mobile', 'whatsapp', 'email'],
      scope: () => ownershipFilter(user),
      select: 'code name city mobile customerType rating',
      sort: 'name',
      link: (row) => `/customers/${row._id}`,
      title: (row) => row.name,
      subtitle: (row) => [row.code, row.city, row.mobile].filter(Boolean).join(' · '),
    },
    {
      key: 'enquiries',
      label: 'Enquiries',
      module: 'enquiries',
      model: Enquiry,
      fields: ['number', 'requirement.modelNumber', 'remarks'],
      related: true,
      scope: () => ownershipFilter(user),
      select: 'number status enquiryDate requirement.modelNumber requirement.quantity customer',
      populate: { path: 'customer', select: 'name' },
      sort: '-enquiryDate',
      link: (row) => `/enquiries/${row._id}`,
      title: (row) => row.number,
      subtitle: (row) =>
        [row.customer?.name, row.requirement?.modelNumber, readable(row.status)]
          .filter(Boolean)
          .join(' · '),
    },
    {
      /*
       * A PO number is what a buyer quotes down the phone, far more often than our own order
       * number — so it is searchable, and it is the field this source exists for.
       */
      key: 'orders',
      label: 'Sales orders',
      module: 'orders',
      model: SalesOrder,
      fields: ['number', 'customerPo.number', 'lines.modelNumber'],
      related: true,
      scope: () => ownershipFilter(user),
      select: 'number status orderDate customerPo.number customer lines.modelNumber',
      populate: { path: 'customer', select: 'name' },
      sort: '-orderDate',
      link: (row) => `/orders/${row._id}`,
      title: (row) => row.number,
      subtitle: (row) =>
        [row.customer?.name, row.customerPo?.number, readable(row.status)]
          .filter(Boolean)
          .join(' · '),
    },
    {
      key: 'samples',
      label: 'Samples',
      module: 'samples',
      model: Sample,
      fields: ['number', 'modelNumber', 'awbNumber'],
      related: true,
      // A sample is marketing's through whoever asked for it, not whoever is making it.
      scope: () => ownershipFilter(user, 'requestedBy'),
      select: 'number status requestedAt modelNumber quantity customer',
      populate: { path: 'customer', select: 'name' },
      sort: '-requestedAt',
      link: (row) => `/samples/${row._id}`,
      title: (row) => row.number,
      subtitle: (row) =>
        [row.customer?.name || 'Internal trial', row.modelNumber, readable(row.status)]
          .filter(Boolean)
          .join(' · '),
    },
    {
      key: 'leads',
      label: 'Leads',
      module: 'enquiries',
      model: Lead,
      fields: ['company', 'number', 'contactName', 'mobile', 'whatsapp', 'email'],
      scope: () => ownershipFilter(user),
      select: 'number company contactName mobile status city',
      sort: '-createdAt',
      link: (row) => `/leads/${row._id}`,
      title: (row) => row.company,
      subtitle: (row) => [row.number, row.contactName, readable(row.status)].filter(Boolean).join(' · '),
    },
    {
      key: 'moulds',
      label: 'Models',
      module: 'moulds',
      model: Mould,
      fields: ['mouldCode', 'name'],
      // The register is shared: there is no such thing as somebody's own tool.
      scope: () => ({}),
      select: 'mouldCode name category sizeMm material status',
      sort: 'mouldCode',
      link: () => '/moulds',
      title: (row) => `${row.mouldCode} — ${row.name}`,
      subtitle: (row) =>
        [readable(row.category), readable(row.material), row.sizeMm && `${row.sizeMm}mm`]
          .filter(Boolean)
          .join(' · '),
    },
  ];

  const allowed = sources.filter((source) => canRead(user, source.module));

  const groups = await Promise.all(
    allowed.map(async (source) => {
      const matches = anyOf(source.fields, patterns);
      // Joined to the customers the query found, where the record hangs off one.
      if (source.related && relatedTo.length) matches.push({ customer: { $in: relatedTo } });

      const filter = { $and: [{ $or: matches }, source.scope()] };

      const [rows, total] = await Promise.all([
        source.model
          .find(filter)
          .select(source.select)
          .populate(source.populate || [])
          .sort(source.sort)
          .limit(PER_GROUP),
        source.model.countDocuments(filter),
      ]);

      return {
        key: source.key,
        label: source.label,
        total,
        results: rows.map((row) => ({
          _id: row._id,
          title: source.title(row),
          subtitle: source.subtitle(row),
          link: source.link(row),
        })),
      };
    })
  );

  return res.json({
    success: true,
    data: {
      query,
      // Empty groups are noise: the reader is looking for what matched, not what did not.
      groups: groups.filter((group) => group.total > 0),
      total: groups.reduce((sum, group) => sum + group.total, 0),
    },
  });
});
