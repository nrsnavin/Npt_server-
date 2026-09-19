import Lead from '../models/Lead.js';
import Enquiry from '../models/Enquiry.js';
import Sample from '../models/Sample.js';
import Quotation from '../models/Quotation.js';
import SalesOrder from '../models/SalesOrder.js';
import Dispatch from '../models/Dispatch.js';
import Receivable from '../models/Receivable.js';
import Query, { roomFilter, seesEveryQuery } from '../models/Query.js';
import { canRead } from './access.service.js';

/**
 * One buyer's whole relationship, gathered for a picture rather than a table [§2].
 *
 * The customer screen already shows most of this, one table at a time, and that is exactly the
 * limitation: a table can only show one relation, so "three enquiries, one of them quoted, the
 * quotation became an order, the order is half despatched and unpaid" is on the screen as five
 * separate facts and nowhere as one shape. This gathers the shape.
 *
 * **Every strand is gated on the reader's own module grant**, not on being able to see the
 * buyer. Opening a customer is one permission; knowing what they owe is another, and a map is
 * not a way round the second. A department without the payments grant simply has no receivables
 * branch — there is no greyed-out node saying money exists, because that is itself the fact
 * being withheld.
 *
 * **Queries are narrowed twice**: by the grant like everything else, and then by the room. A
 * thread is private to whoever was asked, so a map is not a way to learn that a conversation
 * about this buyer exists.
 *
 * **No money on the map, deliberately.** Values are what §8's field split governs and what a
 * table is for; a node is 190 pixels wide and would have to round them. The map answers "what
 * has happened and where is it stuck", the list answers "how much" — so the branches carry a
 * number, a state and a date, and nothing a reader would want to quote.
 */

/** Enough to see the shape; past this a branch is a wall rather than a picture. */
const PER_STRAND = 6;

/** Strip a mongoose document to what a node needs, and nothing more. */
const node = (id, label, sublabel, status) => ({ id: String(id), label, sublabel, status });

export async function customerMap(customer, user) {
  const of = { customer: customer._id };

  /*
   * Each strand is a promise or an empty array decided by the grant, so the gate is one
   * expression per strand and a new strand cannot be added without meeting a reader's rights.
   * Run together, because they are independent and a map is one screen's worth of waiting.
   */
  const may = (moduleKey) => canRead(user, moduleKey);

  const [leads, enquiries, samples, quotations, orders, consignments, receivables, queries] =
    await Promise.all([
      /* Where this buyer came from, and every later lead that turned out to be them. */
      may('enquiries')
        ? Lead.find({ convertedCustomer: customer._id })
          .select('number company convertedAt convertedFromStatus')
          .sort('-convertedAt')
          .limit(PER_STRAND)
        : [],

      may('enquiries')
        ? Enquiry.find(of)
          .select('number status enquiryDate requirement.modelNumber')
          .sort('-enquiryDate')
          .limit(PER_STRAND)
        : [],

      may('samples')
        ? Sample.find(of)
          .select('number status requestedAt modelNumber')
          .sort('-requestedAt')
          .limit(PER_STRAND)
        : [],

      may('pricing')
        ? Quotation.find(of)
          .select('number status validUntil createdAt')
          .sort('-createdAt')
          .limit(PER_STRAND)
        : [],

      may('orders')
        ? SalesOrder.find(of)
          .select('number status orderDate')
          .sort('-orderDate')
          .limit(PER_STRAND)
        : [],

      may('dispatch')
        ? Dispatch.find(of)
          .select('number status dispatchDate createdAt')
          .sort('-createdAt')
          .limit(PER_STRAND)
        : [],

      /*
       * A receivable has no stored status: where it stands is a virtual computed from the
       * invoice, the receipts and the date, so those have to come back or `state` answers
       * "paid" for everything. Selecting `number` and a status field that does not exist is
       * exactly how this branch first drew three nodes with no state on any of them.
       */
      may('payments')
        ? Receivable.find(of)
          .select('number invoice receipts dueBy judgement')
          .sort('-dueBy')
          .limit(PER_STRAND)
        : [],

      /*
       * Narrowed twice. The grant, and then the room — a thread is private to whoever was
       * asked, and a map must not be the place somebody learns that a conversation about this
       * buyer is going on without them.
       */
      may('queries')
        ? Query.find({ ...of, ...(seesEveryQuery(user) ? {} : roomFilter(user)) })
          .select('number subject status createdAt')
          .sort('-updatedAt')
          .limit(PER_STRAND)
        : [],
    ]);

  /*
   * The counts are of the whole strand, not of the six above, and they are only asked for where
   * the reader already has the rows — a count is a fact about the buyer too, and "you may not
   * see these eleven orders" is a sentence that gives away the eleven.
   */
  const [enquiryTotal, sampleTotal, quotationTotal, orderTotal, dispatchTotal, receivableTotal] =
    await Promise.all([
      may('enquiries') ? Enquiry.countDocuments(of) : 0,
      may('samples') ? Sample.countDocuments(of) : 0,
      may('pricing') ? Quotation.countDocuments(of) : 0,
      may('orders') ? SalesOrder.countDocuments(of) : 0,
      may('dispatch') ? Dispatch.countDocuments(of) : 0,
      may('payments') ? Receivable.countDocuments(of) : 0,
    ]);

  return {
    leads: leads.map((lead) =>
      node(lead._id, lead.number, lead.company, lead.convertedFromStatus || 'converted')),

    enquiries: enquiries.map((enquiry) =>
      node(enquiry._id, enquiry.number, enquiry.requirement?.modelNumber, enquiry.status)),

    samples: samples.map((sample) =>
      node(sample._id, sample.number, sample.modelNumber, sample.status)),

    quotations: quotations.map((quotation) =>
      node(quotation._id, quotation.number, null, quotation.status)),

    orders: orders.map((order) => node(order._id, order.number, null, order.status)),

    consignments: consignments.map((dispatch) =>
      node(dispatch._id, dispatch.number, null, dispatch.status)),

    receivables: receivables.map((receivable) =>
      node(receivable._id, receivable.number, null, receivable.state)),

    queries: queries.map((query) => node(query._id, query.number, query.subject, query.status)),

    totals: {
      leads: leads.length,
      enquiries: enquiryTotal,
      samples: sampleTotal,
      quotations: quotationTotal,
      orders: orderTotal,
      consignments: dispatchTotal,
      receivables: receivableTotal,
      queries: queries.length,
    },
  };
}
