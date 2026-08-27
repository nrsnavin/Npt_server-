import Sample, { CLOSED_SAMPLE_STATUSES, NOT_ESCALATED_STATUSES } from '../models/Sample.js';
import Enquiry, { CLOSED_STATUSES } from '../models/Enquiry.js';
import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import Product from '../models/Product.js';
import { findModule } from '../config/modules.js';
import { canRead } from './access.service.js';
import { ownershipFilter } from './ownership.service.js';
import { stalledSamples, stallAfterDays } from './anomaly.service.js';

/**
 * Ask Jarvis: answering the question the parser understood.
 *
 * Four rules decide whether this is trustworthy enough to act on, which is the only bar that
 * matters — an assistant nobody trusts gets asked once.
 *
 * **Never answer zero for something that does not exist.** "How many orders are pending?"
 * against a module that has not been built must not come back "0". The reader would conclude
 * there is no pending work and act on it. Every unbuilt subject answers with what it is and
 * when it lands, and `KNOWN` below is derived from the module catalogue so a module going
 * live cannot leave a stale apology behind.
 *
 * **Never answer a different question than the one asked.** If the parser found a subject but
 * no aspect, say so and offer the aspects that subject has. Quietly falling back to a summary
 * produces a confident, correct-looking answer to something nobody asked.
 *
 * **Grants and ownership apply exactly as they do on screen.** An assistant that reaches past
 * them is a data leak with a text box in front of it. A marketing person asking about the
 * bench gets their own samples, and the same nothing they would get from the list.
 *
 * **Every figure carries its records.** The answer is a sentence and a list of real rows with
 * links, so the reader can open one and check. A number nobody can verify is a rumour, and
 * the first time one is wrong the feature is finished.
 */

/** `sample_required` is a database value; a person reading a sentence wants "sample required". */
const readable = (value) =>
  typeof value === 'string' && value ? value.replace(/_/g, ' ') : value;

const sentenceCase = (value) => String(value).replace(/^./, (c) => c.toUpperCase());

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * How many days late something is, as a person would count it.
 *
 * Floor rather than ceiling: a date eleven days past is eleven days late, and rounding the
 * leftover hours up reports twelve. Small, and exactly the kind of detail that makes somebody
 * stop trusting the number — they can see the date on the record and count it themselves.
 * Floored at one, since anything reaching here is already past its date.
 */
const daysLate = (date) => Math.max(1, Math.floor((Date.now() - date.getTime()) / 86400000));

const daysAgo = (days) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
};

/** How many rows an answer carries. Enough to act on, not so many it becomes a list screen. */
const ROWS = 8;

/**
 * The subjects that have something behind them, and the grant each needs.
 *
 * A subject absent here is one the parser recognises and the system cannot answer yet.
 */
const KNOWN = {
  samples: 'samples',
  enquiries: 'enquiries',
  leads: 'enquiries',
  customers: 'customers',
  products: 'products',
};

/** The module key each unbuilt subject belongs to, so the reply can quote the catalogue. */
const UNBUILT = {
  orders: 'orders',
  quotations: 'quotations',
  dispatch: 'dispatch',
  payments: 'payments',
  production: 'production',
};

const reply = (answer, extra = {}) => ({ answer, rows: [], ...extra });

/* ------------------------------- Row shapes ------------------------------- */

const sampleRow = (row) => ({
  _id: row._id,
  title: row.number,
  subtitle: [row.customer?.name || 'Internal trial', row.modelNumber, readable(row.status)]
    .filter(Boolean)
    .join(' · '),
  meta: row.requiredDate ? `Due ${row.requiredDate.toISOString().slice(0, 10)}` : null,
  link: `/samples/${row._id}`,
});

const enquiryRow = (row) => ({
  _id: row._id,
  title: row.number,
  subtitle: [row.customer?.name, row.requirement?.modelNumber, readable(row.status)]
    .filter(Boolean)
    .join(' · '),
  meta: row.nextFollowUpDate ? `Follow up ${row.nextFollowUpDate.toISOString().slice(0, 10)}` : null,
  link: `/enquiries/${row._id}`,
});

const leadRow = (row) => ({
  _id: row._id,
  title: row.company,
  subtitle: [row.number, row.contactName, readable(row.status)].filter(Boolean).join(' · '),
  link: `/leads/${row._id}`,
});

const customerRow = (row) => ({
  _id: row._id,
  title: row.name,
  subtitle: [row.code, row.city, readable(row.status)].filter(Boolean).join(' · '),
  link: `/customers/${row._id}`,
});

/* ------------------------------ The answers ------------------------------ */

/** One named record, and what is actually happening to it. */
async function oneSample(user, number) {
  const sample = await Sample.findOne({ number, ...ownershipFilter(user, 'requestedBy') })
    .populate('customer', 'name')
    .populate('assignedTo', 'name')
    .populate('requestedBy', 'name');

  if (!sample) {
    return reply(`I cannot find ${number}. It may not exist, or it may belong to a colleague.`);
  }

  const parts = [`${sample.number} is at "${readable(sample.status)}"`];
  if (sample.customer?.name) parts.push(`for ${sample.customer.name}`);
  parts.push(sample.assignedTo?.name ? `with ${sample.assignedTo.name}` : 'and nobody has picked it up');

  let answer = `${parts.join(' ')}.`;

  if (sample.isOverdue) {
    const late = daysLate(sample.requiredDate);
    answer += ` It is overdue by ${plural(late, 'day')}.`;
  } else if (sample.requiredDate && !CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    answer += ` It is due on ${sample.requiredDate.toISOString().slice(0, 10)}.`;
  }

  if (sample.feedbackNote) answer += ` The customer said: "${sample.feedbackNote}".`;

  return { answer, rows: [sampleRow(sample)] };
}

async function oneEnquiry(user, number) {
  const enquiry = await Enquiry.findOne({ number, ...ownershipFilter(user) })
    .populate('customer', 'name')
    .populate('assignedTo', 'name');

  if (!enquiry) {
    return reply(`I cannot find ${number}. It may not exist, or it may belong to a colleague.`);
  }

  let answer = `${enquiry.number} is at "${readable(enquiry.status)}"`;
  if (enquiry.customer?.name) answer += ` for ${enquiry.customer.name}`;
  if (enquiry.assignedTo?.name) answer += `, with ${enquiry.assignedTo.name}`;
  answer += '.';

  if (!CLOSED_STATUSES.includes(enquiry.status) && enquiry.nextAction) {
    answer += ` Next: ${enquiry.nextAction}`;
    if (enquiry.nextFollowUpDate) {
      answer += ` by ${enquiry.nextFollowUpDate.toISOString().slice(0, 10)}`;
    }
    answer += '.';
  }
  if (enquiry.status === 'lost' && enquiry.lostReason) {
    answer += ` Lost on ${readable(enquiry.lostReason)}.`;
  }

  return { answer, rows: [enquiryRow(enquiry)] };
}

async function oneLead(user, number) {
  const lead = await Lead.findOne({ number, ...ownershipFilter(user) }).populate('assignedTo', 'name');
  if (!lead) return reply(`I cannot find ${number}. It may not exist, or it may belong to a colleague.`);

  let answer = `${lead.number} — ${lead.company} — is at "${readable(lead.status)}"`;
  if (lead.assignedTo?.name) answer += ` with ${lead.assignedTo.name}`;
  answer += '.';
  if (lead.nextAction) answer += ` Next: ${lead.nextAction}.`;

  return { answer, rows: [leadRow(lead)] };
}

async function oneCustomer(user, number) {
  const customer = await Customer.findOne({ code: number, ...ownershipFilter(user) });
  if (!customer) return reply(`I cannot find ${number}. It may not exist, or it may belong to a colleague.`);
  return customerStatus(user, customer);
}

/**
 * Everything open for one customer, gathered from each module that has any.
 *
 * The question "what is happening with Trendline" is not about one record, and answering with
 * the customer master alone would be true and useless.
 */
async function customerStatus(user, customer) {
  const [enquiries, samples] = await Promise.all([
    canRead(user, 'enquiries')
      ? Enquiry.find({ customer: customer._id, status: { $nin: CLOSED_STATUSES }, ...ownershipFilter(user) })
          .populate('customer', 'name')
          .sort('-enquiryDate')
          .limit(ROWS)
      : [],
    canRead(user, 'samples')
      ? Sample.find({
          customer: customer._id,
          status: { $nin: CLOSED_SAMPLE_STATUSES },
          ...ownershipFilter(user, 'requestedBy'),
        })
          .populate('customer', 'name')
          .sort('-requestedAt')
          .limit(ROWS)
      : [],
  ]);

  const open = [];
  if (enquiries.length) open.push(plural(enquiries.length, 'open enquiry', 'open enquiries'));
  if (samples.length) open.push(plural(samples.length, 'open sample'));

  const answer = open.length
    ? `${customer.name} (${customer.code}) has ${open.join(' and ')}.`
    : `${customer.name} (${customer.code}) has nothing open — no live enquiries and no samples on the bench.`;

  return {
    answer,
    rows: [...enquiries.map(enquiryRow), ...samples.map(sampleRow)],
  };
}

/**
 * What nobody is working on.
 *
 * The question management actually asks, and the one no other report answered: not "what has
 * passed its date" but "what has gone quiet". A sample due in ten days that nobody has opened
 * for three is invisible to the overdue list and is exactly what becomes it.
 */
async function stalled(user) {
  const rows = await stalledSamples({ filter: ownershipFilter(user, 'requestedBy') });

  if (!rows.length) {
    return reply(
      `Nothing has gone quiet — every open sample has been touched within ${plural(stallAfterDays(), 'working day')}.`
    );
  }

  const worst = rows[0];
  return {
    answer:
      `${sentenceCase(plural(rows.length, 'sample'))} ${rows.length === 1 ? 'has' : 'have'} had no work ` +
      `for more than ${plural(stallAfterDays(), 'working day')}. The quietest is ${worst.number}` +
      `${worst.customer ? ` for ${worst.customer}` : ''} — ${worst.reason.toLowerCase()}.`,
    rows: rows.slice(0, ROWS).map((row) => ({
      _id: row._id,
      title: row.number,
      subtitle: [row.customer || 'Internal trial', row.modelNumber, readable(row.status)]
        .filter(Boolean)
        .join(' · '),
      meta: row.reason,
      link: row.link,
    })),
    total: rows.length,
  };
}

/** What is late on the bench. */
async function overdueSamples(user) {
  const filter = {
    requiredDate: { $lt: new Date() },
    status: { $nin: NOT_ESCALATED_STATUSES },
    ...ownershipFilter(user, 'requestedBy'),
  };

  const [rows, total] = await Promise.all([
    Sample.find(filter).populate('customer', 'name').sort('requiredDate').limit(ROWS),
    Sample.countDocuments(filter),
  ]);

  if (!total) return reply('Nothing is overdue on the bench.');

  /*
   * The oldest is named in the sentence. "Four samples are overdue" is a number; "the oldest
   * by 11 days" is the one somebody does something about this morning.
   */
  const worst = daysLate(rows[0].requiredDate);

  return {
    answer:
      `${sentenceCase(plural(total, 'sample'))} ${total === 1 ? 'is' : 'are'} overdue, ` +
      `the oldest by ${plural(worst, 'day')} — ${rows[0].number}` +
      `${rows[0].customer?.name ? ` for ${rows[0].customer.name}` : ''}.`,
    rows: rows.map(sampleRow),
    total,
  };
}

/** What has come in lately. */
async function newRecords(user, subject, window) {
  const since = daysAgo(window.days);

  const sources = {
    enquiries: {
      model: Enquiry,
      filter: { enquiryDate: { $gte: since }, ...ownershipFilter(user) },
      populate: { path: 'customer', select: 'name' },
      sort: '-enquiryDate',
      row: enquiryRow,
      one: 'new enquiry',
      many: 'new enquiries',
    },
    samples: {
      model: Sample,
      filter: { requestedAt: { $gte: since }, ...ownershipFilter(user, 'requestedBy') },
      populate: { path: 'customer', select: 'name' },
      sort: '-requestedAt',
      row: sampleRow,
      one: 'new sample request',
    },
    leads: {
      model: Lead,
      filter: { createdAt: { $gte: since }, ...ownershipFilter(user) },
      sort: '-createdAt',
      row: leadRow,
      one: 'new lead',
    },
    customers: {
      model: Customer,
      filter: { createdAt: { $gte: since }, ...ownershipFilter(user) },
      sort: '-createdAt',
      row: customerRow,
      one: 'new customer',
    },
    products: {
      model: Product,
      filter: { createdAt: { $gte: since } },
      sort: '-createdAt',
      row: (r) => ({ _id: r._id, title: `${r.modelCode} — ${r.name}`, subtitle: readable(r.category), link: '/products' }),
      one: 'new model',
    },
  };

  const source = sources[subject];
  const [rows, total] = await Promise.all([
    source.model.find(source.filter).populate(source.populate || []).sort(source.sort).limit(ROWS),
    source.model.countDocuments(source.filter),
  ]);

  const label = plural(total, source.one, source.many);
  if (!total) return reply(`No ${source.many || `${source.one}s`} ${window.label}.`);

  return {
    answer: `${sentenceCase(label)} ${window.label}.`,
    rows: rows.map(source.row),
    total,
  };
}

/** What is still live, broken down by stage — the shape of the pile, not just its size. */
async function openRecords(user, subject) {
  const config = {
    samples: {
      model: Sample,
      filter: { status: { $nin: CLOSED_SAMPLE_STATUSES }, ...ownershipFilter(user, 'requestedBy') },
      populate: { path: 'customer', select: 'name' },
      sort: 'requiredDate',
      row: sampleRow,
      one: 'sample',
      where: 'on the bench',
    },
    enquiries: {
      model: Enquiry,
      filter: { status: { $nin: CLOSED_STATUSES }, ...ownershipFilter(user) },
      populate: { path: 'customer', select: 'name' },
      sort: 'nextFollowUpDate',
      row: enquiryRow,
      one: 'enquiry',
      many: 'enquiries',
      where: 'open',
    },
    leads: {
      model: Lead,
      filter: { status: { $nin: ['converted', 'disqualified'] }, ...ownershipFilter(user) },
      sort: '-createdAt',
      row: leadRow,
      one: 'lead',
      where: 'still being worked',
    },
    customers: {
      model: Customer,
      filter: { status: 'active', ...ownershipFilter(user) },
      sort: 'name',
      row: customerRow,
      one: 'customer',
      where: 'active',
    },
    products: {
      model: Product,
      filter: { isActive: { $ne: false } },
      sort: 'modelCode',
      row: (r) => ({ _id: r._id, title: `${r.modelCode} — ${r.name}`, subtitle: readable(r.category), link: '/products' }),
      one: 'model',
      where: 'in the catalogue',
    },
  }[subject];

  const [rows, total, byStage] = await Promise.all([
    config.model.find(config.filter).populate(config.populate || []).sort(config.sort).limit(ROWS),
    config.model.countDocuments(config.filter),
    config.model.aggregate([{ $match: config.filter }, { $group: { _id: '$status', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
  ]);

  if (!total) return reply(`Nothing ${config.where}.`);

  const stages = byStage
    .filter((entry) => entry._id)
    .slice(0, 4)
    .map((entry) => `${entry.count} ${readable(entry._id)}`)
    .join(', ');

  return {
    answer:
      `${sentenceCase(plural(total, config.one, config.many))} ${config.where}` +
      `${stages ? `: ${stages}` : ''}.`,
    rows: rows.map(config.row),
    total,
  };
}

/** The follow-ups whose date has arrived. */
async function dueFollowUps(user) {
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const filter = {
    status: { $nin: CLOSED_STATUSES },
    nextFollowUpDate: { $lte: endOfToday },
    ...ownershipFilter(user),
  };

  const [rows, total] = await Promise.all([
    Enquiry.find(filter).populate('customer', 'name').sort('nextFollowUpDate').limit(ROWS),
    Enquiry.countDocuments(filter),
  ]);

  if (!total) return reply('No follow-ups are due. Everything open has a date still ahead of it.');

  return {
    answer: `${sentenceCase(plural(total, 'follow-up'))} ${total === 1 ? 'is' : 'are'} due now or overdue.`,
    rows: rows.map(enquiryRow),
    total,
  };
}

/** Finding the customer somebody named in words rather than by code. */
async function byName(user, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matched = await Customer.find({
    name: new RegExp(escaped, 'i'),
    ...ownershipFilter(user),
  }).limit(5);

  if (!matched.length) return null;

  /*
   * More than one match is reported rather than resolved. Picking the first would answer
   * about a different customer than the one meant, and every figure after that is wrong in a
   * way the reader cannot see.
   */
  if (matched.length > 1) {
    return {
      answer: `${matched.length} customers match "${name}". Which one?`,
      rows: matched.map(customerRow),
    };
  }

  return customerStatus(user, matched[0]);
}

/* -------------------------------- Routing -------------------------------- */

const ASPECTS_FOR = {
  samples: ['what is stuck', 'what is overdue', 'what is open', 'what is new this week', 'or a number like SMP-2026-0004'],
  enquiries: ['what is new this week', 'what follow-ups are due', 'what is open', 'or a number like ENQ-2026-0001'],
  leads: ['what is new', 'what is still open', 'or a number like LEAD-2026-0001'],
  customers: ['what is new', 'or name one — "what is happening with Trendline"'],
  products: ['what is new', 'how many are in the catalogue'],
};

/**
 * Answers a parsed question.
 *
 * Takes the parse rather than the sentence, so the parser can be replaced — by a language
 * model, or by a better set of rules — without touching a single query.
 */
export async function answer(user, parsed) {
  const { subject, aspect, entities } = parsed;

  if (!parsed.text) return reply('Ask me about samples, enquiries, leads or customers.');

  /*
   * The unbuilt modules, answered by name. This is the one reply that matters most: an
   * assistant that says "0 orders" about a module nobody has written is worse than one that
   * says nothing, because the reader believes it.
   */
  if (UNBUILT[subject]) {
    const module = findModule(UNBUILT[subject]);
    return reply(
      `${module?.label || sentenceCase(subject)} is not built yet — it arrives in a later phase, ` +
        `so I have no figures for it and would rather say so than answer zero. ` +
        `I can answer on samples, enquiries, leads, customers and the catalogue.`
    );
  }

  // A record named by number, whatever else the sentence said.
  if (entities.reference) {
    const lookup = { samples: oneSample, enquiries: oneEnquiry, leads: oneLead, customers: oneCustomer }[subject];
    if (!canRead(user, KNOWN[subject])) {
      return reply(`You do not have access to ${KNOWN[subject]}, so I cannot look that up.`);
    }
    return lookup(user, entities.reference);
  }

  // A customer named in words.
  if (entities.party && (!subject || subject === 'customers')) {
    if (!canRead(user, 'customers')) return reply('You do not have access to customers, so I cannot look that up.');
    const found = await byName(user, entities.party);
    if (found) return found;
    return reply(`I cannot find a customer matching "${entities.party}".`);
  }

  if (!subject) {
    return reply(
      'I did not catch what that is about. Try naming one: samples, enquiries, leads, ' +
        'customers or the catalogue — or give me a number like SMP-2026-0004.'
    );
  }

  if (!canRead(user, KNOWN[subject])) {
    return reply(`You do not have access to ${KNOWN[subject]}, so I cannot answer that.`);
  }

  if (!aspect) {
    return reply(
      `I understood you are asking about ${subject}, but not what about them. Ask me ` +
        `${ASPECTS_FOR[subject].join(', ')}.`
    );
  }

  switch (aspect) {
    case 'stalled':
      /*
       * Only samples carry a record of being worked on — a stage history and a log. Saying so
       * beats answering about something else, or answering "none", which would read as an
       * assurance that nothing anywhere is stuck.
       */
      return subject === 'samples'
        ? stalled(user)
        : reply(`Nothing records progress on ${subject} the way the bench does, so I cannot tell you what has gone quiet there. Ask me about samples.`);

    case 'overdue':
      if (subject !== 'samples') {
        // Enquiries carry a follow-up date rather than a deadline, so "overdue" means that.
        return subject === 'enquiries'
          ? dueFollowUps(user)
          : reply(`Nothing tracks a deadline on ${subject}, so none of them can be overdue.`);
      }
      return overdueSamples(user);

    case 'due':
      return subject === 'enquiries'
        ? dueFollowUps(user)
        : reply(`Follow-up dates are kept on enquiries. Ask me what is due there.`);

    case 'new':
      return newRecords(user, subject, entities.window);

    case 'open':
    case 'count':
    case 'status':
      return openRecords(user, subject);

    default:
      return reply(`I do not know how to answer that about ${subject} yet.`);
  }
}
