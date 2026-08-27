import Customer from '../models/Customer.js';
import Enquiry, { CLOSED_STATUSES } from '../models/Enquiry.js';
import Sample, { WITH_CUSTOMER_STATUSES, CLOSED_SAMPLE_STATUSES } from '../models/Sample.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter } from '../services/ownership.service.js';

/**
 * Marketing's own dashboard [BLUEPRINT §21, DASHBOARDS §3].
 *
 * The rows §21 asks for span every module; the ones the built modules can answer are here,
 * and the rest join as pricing, quotations, orders, production and payments land. Shipping
 * the answerable half now is the same call the customer timeline made — a dashboard that
 * waits for the last module is a dashboard nobody uses while the plant needs it.
 *
 * Two rules from the dashboards guide shape all of it. **Every figure is a filter somebody
 * can open**, so each row carries the records behind it rather than only a count — a number
 * nobody can open is a number nobody trusts. And **ageing beats counts** wherever there is an
 * SLA: "12 samples pending" hides the one that has sat three weeks, so anything with a clock
 * on it is ranked worst-first with its age.
 *
 * Scoped by ownership throughout, which is what makes it *this person's* dashboard: a
 * marketing person sees their own, and management sees the team through the same endpoint.
 */

const DAY = 24 * 60 * 60 * 1000;
const ageInDays = (from, now) => Math.max(0, Math.floor((now - new Date(from).getTime()) / DAY));

/**
 * How many days late something is, counted the way a person counts them.
 *
 * Elapsed 24-hour periods are the wrong unit here: a follow-up due at five yesterday
 * afternoon is fourteen hours old at seven this morning, and reporting "0d late" in a row
 * the dashboard has just coloured red reads as a bug rather than as a number. Whole days
 * between the two dates is what somebody looking at a calendar would say.
 */
const daysLate = (due, startOfToday) => {
  const dueDay = new Date(due);
  dueDay.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((startOfToday - dueDay) / DAY));
};

/** Enough to act on this morning. A dashboard that lists forty things is a list screen. */
const TOP = 8;

/** How long without an enquiry before a customer has gone quiet [DASHBOARDS §3]. */
const DORMANT_DAYS = 90;

const enquiryCard = (enquiry, startOfToday) => ({
  _id: enquiry._id,
  number: enquiry.number,
  customer: enquiry.customer?.name || null,
  modelNumber: enquiry.requirement?.modelNumber || null,
  status: enquiry.status,
  nextAction: enquiry.nextAction || null,
  nextFollowUpDate: enquiry.nextFollowUpDate || null,
  estimatedValue: enquiry.estimatedValue ?? null,
  overdueDays: enquiry.nextFollowUpDate ? daysLate(enquiry.nextFollowUpDate, startOfToday) : 0,
});

export const marketingDashboard = asyncHandler(async (req, res) => {
  const now = Date.now();
  const scope = ownershipFilter(req.user);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday.getTime() + DAY);
  const startOfMonth = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
  const dormantBefore = new Date(now - DORMANT_DAYS * DAY);

  const [enquiries, samples, customers] = await Promise.all([
    Enquiry.find(scope)
      .select('number status enquiryDate requirement estimatedValue nextAction nextFollowUpDate customer lostReason source')
      .populate('customer', 'name'),
    Sample.find(ownershipFilter(req.user, 'requestedBy'))
      .select('number status requestedAt requiredDate modelNumber customer dispatchedAt statusHistory')
      .populate('customer', 'name'),
    Customer.find(scope).select('code name'),
  ]);

  const openEnquiries = enquiries.filter((entry) => !CLOSED_STATUSES.includes(entry.status));

  /* --------------------------------- Today --------------------------------- */

  const overdue = openEnquiries
    .filter((entry) => entry.nextFollowUpDate && new Date(entry.nextFollowUpDate) < startOfToday)
    .sort((a, b) => new Date(a.nextFollowUpDate) - new Date(b.nextFollowUpDate));

  const dueToday = openEnquiries.filter(
    (entry) =>
      entry.nextFollowUpDate &&
      new Date(entry.nextFollowUpDate) >= startOfToday &&
      new Date(entry.nextFollowUpDate) < endOfToday
  );

  /*
   * §3 forbids an open enquiry without a next action, and the module enforces it on write.
   * Reported anyway: a record that predates the rule, or one a future import brings in, is
   * exactly the enquiry that goes quiet — and a rule with no way of telling you it has been
   * broken is a rule you find out about from the customer.
   */
  const noNextAction = openEnquiries.filter(
    (entry) => !entry.nextAction || !entry.nextFollowUpDate
  );

  // The commonest silent stall [DASHBOARDS §3]: it reached them, and then nothing.
  const awaitingFeedback = samples
    .filter((sample) => WITH_CUSTOMER_STATUSES.includes(sample.status))
    .map((sample) => ({
      _id: sample._id,
      number: sample.number,
      customer: sample.customer?.name || null,
      modelNumber: sample.modelNumber || null,
      status: sample.status,
      ageDays: ageInDays(sample.dispatchedAt || sample.requestedAt, now),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);

  const samplesOverdue = samples
    .filter(
      (sample) =>
        sample.requiredDate &&
        new Date(sample.requiredDate) < new Date(now) &&
        !CLOSED_SAMPLE_STATUSES.includes(sample.status) &&
        !WITH_CUSTOMER_STATUSES.includes(sample.status)
    )
    .map((sample) => ({
      _id: sample._id,
      number: sample.number,
      customer: sample.customer?.name || null,
      modelNumber: sample.modelNumber || null,
      status: sample.status,
      lateDays: daysLate(sample.requiredDate, startOfToday),
    }))
    .sort((a, b) => b.lateDays - a.lateDays);

  /* ------------------------------- Performance ------------------------------- */

  const raisedThisMonth = enquiries.filter(
    (entry) => new Date(entry.enquiryDate || entry.createdAt) >= startOfMonth
  );

  const value = (rows) => rows.reduce((sum, entry) => sum + (entry.estimatedValue || 0), 0);

  const countBy = (rows, keyOf) =>
    Object.entries(
      rows.reduce((counts, row) => {
        const key = keyOf(row);
        if (!key) return counts;
        counts[key] = counts[key] || { count: 0, value: 0 };
        counts[key].count += 1;
        counts[key].value += row.estimatedValue || 0;
        return counts;
      }, {})
    )
      .map(([label, entry]) => ({ label, ...entry }))
      .sort((a, b) => b.count - a.count);

  const lost = enquiries.filter((entry) => entry.status === 'lost');
  const won = enquiries.filter((entry) => entry.status === 'won');

  /*
   * A customer with nothing on them for three months. Computed from the enquiries already
   * loaded rather than a query per customer: the point is who to ring, and that answer is a
   * set difference, not ninety round trips.
   */
  const lastEnquiryBy = new Map();
  for (const entry of enquiries) {
    const id = String(entry.customer?._id || entry.customer);
    const at = new Date(entry.enquiryDate || entry.createdAt);
    if (!lastEnquiryBy.has(id) || at > lastEnquiryBy.get(id)) lastEnquiryBy.set(id, at);
  }

  const dormant = customers
    .map((customer) => ({
      _id: customer._id,
      code: customer.code,
      name: customer.name,
      lastEnquiryAt: lastEnquiryBy.get(String(customer._id)) || null,
    }))
    .filter((row) => !row.lastEnquiryAt || row.lastEnquiryAt < dormantBefore)
    .sort((a, b) => (a.lastEnquiryAt || 0) - (b.lastEnquiryAt || 0));

  res.json({
    success: true,
    data: {
      today: {
        overdueFollowUps: { count: overdue.length, rows: overdue.slice(0, TOP).map((e) => enquiryCard(e, startOfToday)) },
        dueToday: { count: dueToday.length, rows: dueToday.slice(0, TOP).map((e) => enquiryCard(e, startOfToday)) },
        noNextAction: { count: noNextAction.length, rows: noNextAction.slice(0, TOP).map((e) => enquiryCard(e, startOfToday)) },
        awaitingFeedback: { count: awaitingFeedback.length, rows: awaitingFeedback.slice(0, TOP) },
        samplesOverdue: { count: samplesOverdue.length, rows: samplesOverdue.slice(0, TOP) },
      },
      performance: {
        openEnquiries: { count: openEnquiries.length, value: value(openEnquiries) },
        raisedThisMonth: { count: raisedThisMonth.length, value: value(raisedThisMonth) },
        won: { count: won.length, value: value(won) },
        lost: { count: lost.length, value: value(lost) },
        // Both are needed to read either: a high win count on a low win value is a different
        // problem from the reverse, and one figure cannot say which.
        winRatePercent: won.length + lost.length
          ? Math.round((won.length / (won.length + lost.length)) * 100)
          : null,
        byStage: countBy(openEnquiries, (row) => row.status),
        bySource: countBy(enquiries, (row) => row.source),
        lostReasons: countBy(lost, (row) => row.lostReason),
      },
      dormantCustomers: { count: dormant.length, days: DORMANT_DAYS, rows: dormant.slice(0, TOP) },
    },
  });
});
