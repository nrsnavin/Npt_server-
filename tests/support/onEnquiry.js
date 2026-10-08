/**
 * Fixture: every sample, costing sheet, quotation and sales order is raised on an enquiry
 * [src/services/enquiryLink.service.js].
 *
 * Tests about something further along — a dispatch, a payment, a quality hold — still need the
 * order underneath, and the order now needs its enquiry. `withEnquiries(api)` gives a test's
 * request helper that one step: a create posted without an enquiry gets a fresh one raised for
 * that buyer first, owned by the buyer's marketing person (or whoever is asking). A new enquiry
 * each time, because the app allows one open sample per enquiry and a test raising two would
 * otherwise be refused for a reason that has nothing to do with it.
 *
 * The rule itself is tested without this, in tests/enquiry-required.test.js.
 */
import jwt from 'jsonwebtoken';

const RAISED_ON_ENQUIRY = /^\/api\/(samples|pricings|quotations|orders)(\?.*)?$/;

export async function raiseEnquiryFor({ customer, owner }) {
  const { default: Enquiry } = await import('../../src/models/Enquiry.js');
  const { default: Customer } = await import('../../src/models/Customer.js');
  const { nextNumber } = await import('../../src/services/numbering.service.js');

  if (!owner) {
    const { default: User } = await import('../../src/models/User.js');
    owner = (await User.findOne({ role: 'admin' }).select('_id'))?._id || (await User.findOne().select('_id'))?._id;
  }
  let buyer = customer ? await Customer.findById(customer) : null;
  if (!buyer) {
    buyer = await Customer.create({
      code: `FIX${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e4)}`,
      name: `Fixture buyer ${Math.floor(Math.random() * 1e6)}`,
      mobile: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      assignedTo: owner,
    });
  }
  return Enquiry.create({
    number: await nextNumber('ENQ'),
    customer: buyer._id,
    assignedTo: buyer.assignedTo || owner,
    /* Says nothing about what to make, so whatever the test sends is all the record knows. */
    requirement: {},
  });
}

/** Who a bearer token belongs to — the fallback owner of a fixture enquiry. */
const userOf = (token) => {
  try { return jwt.decode(token)?.id || jwt.decode(token)?.sub || jwt.decode(token)?._id; } catch { return undefined; }
};

export function withEnquiries(api) {
  return async (path, options = {}) => {
    const { method = 'GET', body, token } = options;
    if (method === 'POST' && RAISED_ON_ENQUIRY.test(path) && body && typeof body === 'object' && !body.enquiry) {
      const enquiry = await raiseEnquiryFor({ customer: body.customer, owner: userOf(token) });
      return api(path, { ...options, body: { ...body, enquiry: String(enquiry._id), customer: body.customer ?? String(enquiry.customer) } });
    }
    return api(path, options);
  };
}
