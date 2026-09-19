import mongoose from 'mongoose';
import Query, { inTheRoom, roomFilter, seesEveryQuery } from '../models/Query.js';
import Customer from '../models/Customer.js';
import User from '../models/User.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { nextNumber } from '../services/numbering.service.js';
import { listParams, paginated } from '../utils/query.js';
import { customerScope, isOwnershipScoped, ownsCustomer } from '../services/ownership.service.js';
import { assertAssignable } from '../services/assignment.service.js';
import { DEPARTMENT_KEYS, findDepartment } from '../config/modules.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { summarise } from '../services/querySummary.llm.js';
import { filtersFromPhrase } from '../services/querySearch.llm.js';

/**
 * Queries: a question about a buyer, and everybody pulled in to answer it.
 *
 * **Who may see one is the whole of the interesting access story**, and it is not the usual
 * rule. Everywhere else in this app, access flows from the record: you may read an order
 * because you may read orders, and a marketing person may read theirs because they own the
 * customer. A query inverts it — the *thread* decides, and being in the thread is what grants
 * sight of the buyer it names, not the other way round.
 *
 * That is deliberate and it is the point of the feature: despatch cannot own a customer and
 * never will, so a rule that said "you may see queries about buyers you can see" would mean
 * despatch could never be asked anything. The thread is its own permission.
 *
 * It is also a door, so it is built like one:
 *
 *   **Every grant is signed.** A participant row carries who added it and when, and the buyer
 *   records the grant on `sharedWith`. "Who else can see this customer, and why" is answerable
 *   off the record rather than by reasoning about threads.
 *
 *   **Anybody in the room may widen it.** That is what was asked for, and it is what makes the
 *   thread reach the person who actually knows. The cost is that the list only grows, so the
 *   signature above is what keeps it accountable rather than a rule nobody can audit.
 *
 *   **Reading is not writing.** The grant lets a participant open the buyer. It does not let
 *   them change the buyer, and it does not carry §8's prices or §29's enquiries with it — see
 *   `sharedWith` on the customer model.
 */

const POPULATE = [
  { path: 'customer', select: 'code name city state assignedTo' },
  { path: 'raisedBy', select: 'name department' },
  { path: 'participants.user', select: 'name department' },
  { path: 'participants.addedBy', select: 'name' },
  { path: 'messages.by', select: 'name department' },
  { path: 'closedBy', select: 'name' },
];

/** Every response carries the same shape, including the ones that answer an action. */
const withRefs = (query) => query.populate(POPULATE);

/**
 * The buyer this question is about, or a refusal that gives nothing away about them existing.
 *
 * Raising uses the asker's *own* reach — `customerScope`, which is their book plus anything
 * already shared with them. You cannot start a thread about a buyer you have never been able to
 * see; that would make "raise a query" a way to enumerate the customer master.
 */
async function askableCustomer(id, user) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Choose the customer this is about');

  const customer = await Customer.findById(id);
  if (!customer) throw ApiError.notFound('Customer not found');
  if (!ownsCustomer(user, customer)) throw ApiError.notFound('Customer not found');
  return customer;
}


/** The thread, if this person is in it. One refusal, so a probe learns nothing from the wording. */
async function readableQuery(id, user) {
  const query = await Query.findById(id);
  if (!query) throw ApiError.notFound('Query not found');
  if (!seesEveryQuery(user) && !inTheRoom(query, user)) throw ApiError.notFound('Query not found');
  return query;
}

/**
 * Writes the grant onto the buyer, so ownership stays one cheap filter.
 *
 * `$addToSet` rather than a read-modify-write: two people adding participants at the same moment
 * both walk through the gap between a read and a save, and the loser's grant disappears — which
 * is a colleague who was told they had been added and cannot open the record.
 */
async function shareCustomerWith(customerId, userIds) {
  const ids = userIds.filter(Boolean);
  if (!ids.length) return;
  await Customer.updateOne({ _id: customerId }, { $addToSet: { sharedWith: { $each: ids } } });
}

/**
 * Everybody a participant row stands for, as user ids.
 *
 * A row naming a person is that person. A row naming only a department is everybody in it *at
 * the time the row was added* — resolved now rather than left as a rule, because the grant has
 * to be a list on the customer for ownership to stay cheap. Somebody who joins the department
 * next month is in the thread (the thread matches on department) but is not retro-granted the
 * buyer; they get the grant the moment they are named, which is honest about when the door
 * actually opened.
 */
async function peopleBehind(participant) {
  if (participant.user) return [participant.user];

  const members = await User.find({
    department: participant.department,
    isActive: { $ne: false },
  }).select('_id');
  return members.map((member) => member._id);
}

/* --------------------------------- Raising --------------------------------- */

export const createQuery = asyncHandler(async (req, res) => {
  const { customer: customerId, subject, question, participants = [] } = req.body;

  const customer = await askableCustomer(customerId, req.user);

  /*
   * At least one participant, because a query addressed to nobody is a note to self and the
   * to-do list already exists for those. Refused here rather than accepted and left to rot on a
   * list nobody reads.
   */
  if (!participants.length) {
    throw ApiError.badRequest('Ask somebody — choose a department, or a person in one');
  }

  const rows = [];
  for (const asked of participants) {
    rows.push(await participantRow(asked, req.user));
  }

  const query = await Query.create({
    number: await nextNumber('QRY'),
    customer: customer._id,
    subject,
    question,
    raisedBy: req.user._id,
    participants: rows,
  });

  /* The buyer is shared with everybody the rows stand for, and with the asker, who may have
     raised this about a customer that was itself shared with them. */
  const granted = (await Promise.all(rows.map(peopleBehind))).flat();
  await shareCustomerWith(customer._id, [...granted, req.user._id]);

  res.status(201).json({ success: true, data: await withRefs(query) });
});

/**
 * One participant, validated.
 *
 * A person is always reached *through* a department, so a row naming somebody carries their own
 * department rather than whichever one the caller typed — two fields that can disagree about
 * where a person works is a filter that stops finding them.
 */
async function participantRow(asked, addedBy) {
  const department = String(asked?.department || '').trim();

  if (asked?.user) {
    const person = await assertAssignable(asked.user);
    return { department: person.department, user: person._id, addedBy: addedBy._id };
  }

  if (!DEPARTMENT_KEYS.includes(department)) {
    throw ApiError.badRequest('That is not a department anybody works in');
  }
  return { department, addedBy: addedBy._id };
}

/* --------------------------------- Reading --------------------------------- */

export const listQueries = asyncHandler(async (req, res) => {
  /*
   * What somebody typed, read for filters before the list is built — "unanswered despatch
   * queries for SCM last week" is four filters in one phrase, and the alternative is four
   * dropdowns nobody opens.
   *
   * **The plain search still runs on the same words, always.** The model adds filters; it
   * cannot take the search away. A misread phrase therefore gives a narrower list than expected
   * with the words still doing their work, rather than a wrong one — and `read` goes back so the
   * screen can show what was applied and let the reader drop it.
   */
  const read = req.query.ai === 'false' ? null : await filtersFromPhrase(req.query.search);
  if (read) applyRead(req.query, read);

  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'subject', 'question', 'messages.body'],
    defaultSort: '-updatedAt',
    sortable: ['number', 'createdAt', 'updatedAt', 'status'],
  });

  const scoped = await queryFilter(req, filter);

  const [data, total] = await Promise.all([
    Query.find(scoped).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Query.countDocuments(scoped),
  ]);

  /* `read` travels beside the page rather than inside it: the screen shows what the phrase was
     taken to mean so the reader can see it and drop it. Fourth argument, not a pagination key. */
  paginated(res, data, { page, limit, total }, read ? { read } : undefined);
});

/**
 * The phrase's filters, folded into the request the list already understands.
 *
 * Written onto `req.query` rather than into the mongo filter directly, so there is exactly one
 * place that turns a request into a query — `queryFilter` below — and a filter the model
 * proposed is indistinguishable from one a dropdown set. Two paths into the same filter is how
 * one of them ends up missing the ownership clause.
 *
 * **Anything the person set explicitly wins.** They picked a department from the dropdown and
 * then typed a phrase; the dropdown is the deliberate act and the phrase is the guess.
 *
 * Exported for its own test: with no key this never runs, so the precedence rule — the one thing
 * standing between a guess and somebody's deliberate choice — would otherwise be the only part of
 * the search with no test at all.
 */
export function applyRead(params, read) {
  if (read.customerName && !params.customerName) params.customerName = read.customerName;
  if (read.department && !params.department) params.department = read.department;
  if (read.status && !params.status) params.status = read.status;
  if (read.days && !params.since) {
    params.since = new Date(Date.now() - read.days * 86400000).toISOString();
  }
  /* The leftover subject, so the text search matches a thread rather than the whole sentence. */
  if (read.text) params.search = read.text;
}

/**
 * What the list understands, in one function.
 *
 * `$and` throughout rather than assignment, because three of these are `$or`s — the room, the
 * text search, and a customer-name match — and one `$or` assigned over another is the second
 * silently winning. That bug returns a plausible list, which is the worst kind.
 */
async function queryFilter(req, filter) {
  const clauses = [];

  if (!seesEveryQuery(req.user)) clauses.push(roomFilter(req.user));
  if (filter.$or) {
    clauses.push({ $or: filter.$or });
    delete filter.$or;
  }

  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $ne: 'closed' };
  if (req.query.department) filter['participants.department'] = req.query.department;
  if (req.query.mine === 'true') filter.raisedBy = req.user._id;

  /* How far back, from a phrase that said so or a control that set it. */
  if (req.query.since) {
    const from = new Date(req.query.since);
    if (!Number.isNaN(from.getTime())) filter.createdAt = { $gte: from };
  }

  if (req.query.customer) {
    if (!mongoose.isValidObjectId(req.query.customer)) throw ApiError.badRequest('That is not a customer');
    filter.customer = req.query.customer;
  }

  /*
   * Searching by the buyer's name, which is how people actually look for a thread.
   *
   * The name lives on the customer, so it is resolved to ids first — two queries rather than a
   * copy of the name on every query that would have to be kept true when a buyer is renamed.
   * Narrowed by the reader's own customer scope, so this cannot be used to discover which
   * buyers exist.
   */
  if (req.query.customerName) {
    const escaped = String(req.query.customerName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = await Customer.find({
      ...customerScope(req.user),
      $or: [{ name: new RegExp(escaped, 'i') }, { code: new RegExp(escaped, 'i') }],
    }).select('_id');

    filter.customer = { $in: matches.map((row) => row._id) };
  }

  if (clauses.length) filter.$and = [...(filter.$and || []), ...clauses];
  return filter;
}

export const getQuery = asyncHandler(async (req, res) => {
  const query = await readableQuery(req.params.id, req.user);
  await withRefs(query);

  /*
   * The summary rides beside the thread rather than on it, and that placement is the whole
   * safety argument: it is regenerated per read, held in no field, and so cannot be picked up
   * by a report, a count, an export or a notification. A summary that cannot be persisted
   * cannot become a record. `writtenBy` says whose sentence it is — see `querySummary.llm.js`.
   */
  res.json({ success: true, data: query, gist: await summarise(query) });
});

/* --------------------------------- Saying something --------------------------------- */

/**
 * A reply or a note.
 *
 * A reply answers something and moves an open query to `answered`; a note does not. That is the
 * whole difference and it is why they are one endpoint with a `kind` rather than two: they land
 * in the same list, in the order they were said, and the only thing that differs is whether the
 * thread has been advanced.
 *
 * A **closed** query takes neither. Re-opening is a decision, and a reply that silently revives
 * a thread somebody had finished with is how a closed queue fills back up without anybody
 * choosing.
 */
export const addMessage = asyncHandler(async (req, res) => {
  const query = await readableQuery(req.params.id, req.user);
  const { kind = 'reply', body } = req.body;

  if (query.status === 'closed') {
    throw ApiError.badRequest(
      `${query.number} is closed. Re-open it if there is more to say, so somebody has decided to.`
    );
  }

  query.messages.push({ kind, body, by: req.user._id });

  /* Only a reply advances it. Answering is the plant's part; closing is the asker's. */
  if (kind === 'reply' && query.status === 'open') query.status = 'answered';

  await query.save();
  res.status(201).json({ success: true, data: await withRefs(query) });
});

/* --------------------------------- Widening the room --------------------------------- */

/**
 * Pulling somebody else in — the action the whole feature turns on.
 *
 * Anybody already in the room may do it, which is what was asked for and what makes the thread
 * reach the person who actually knows. Two things make that safe rather than merely convenient:
 * the row records who opened the door, and the answer says plainly what was granted, so the
 * screen can tell the person pressing it rather than leaving them to find out.
 */
export const addParticipant = asyncHandler(async (req, res) => {
  const query = await readableQuery(req.params.id, req.user);

  /*
   * A closed thread takes nobody new, for the same reason it takes no replies — and here it
   * matters more, because this is not only a message, it is a grant. Adding somebody to a
   * finished question would open a buyer's record to them for a conversation nobody is working,
   * and a door opened for no live reason is the kind that never gets noticed.
   *
   * Re-opening is the way in, exactly as it is for a reply: then somebody has decided the thread
   * is live again, and the grant has a reason anybody can see.
   */
  if (query.status === 'closed') {
    throw ApiError.badRequest(
      `${query.number} is closed. Re-open it before pulling somebody in — being added to a query `
      + 'also opens this customer’s record to them.'
    );
  }

  const row = await participantRow(req.body, req.user);

  /*
   * Already there is not an error, it is a no-op with a sentence. A person named individually
   * when their whole department is already in is still a *narrowing* somebody meant, so that is
   * allowed; the same person twice is not.
   */
  const already = query.participants.some(
    (participant) =>
      participant.department === row.department &&
      String(participant.user || '') === String(row.user || '')
  );

  if (already) {
    const who = row.user ? 'That person is' : `${findDepartment(row.department)?.label} is`;
    throw ApiError.conflict(`${who} already in this query`);
  }

  const before = snapshot(query);
  query.participants.push(row);
  await query.save();
  await recordChange({ model: 'Query', doc: query, before, by: req.user, note: 'Added a participant' });

  /* The grant, written onto the buyer where ownership can read it cheaply. */
  const granted = await peopleBehind(row);
  await shareCustomerWith(query.customer, granted);

  res.status(201).json({
    success: true,
    data: await withRefs(query),
    /*
     * What that press actually did, said back. Adding somebody to a thread also lets them open
     * the buyer, and a consequence nobody is told about is one they meet later as a colleague
     * who knows something they should not have.
     */
    granted: {
      people: granted.length,
      customer: true,
    },
  });
});

/* --------------------------------- Finishing --------------------------------- */

/**
 * Closing, which is the asker's alone.
 *
 * The same rule `OrderQuery` holds: an answer that did not answer is the common case, and
 * letting the answerer close is letting them mark their own work. Admins can too, because
 * somebody has to be able to tidy up after a person who has left.
 */
export const closeQuery = asyncHandler(async (req, res) => {
  const query = await readableQuery(req.params.id, req.user);

  const isAsker = String(query.raisedBy) === String(req.user._id);
  if (!isAsker && req.user.role !== 'admin') {
    throw ApiError.forbidden(
      'Only whoever asked can close a query — an answer that did not answer is theirs to judge'
    );
  }

  if (query.status === 'closed') throw ApiError.badRequest('This query is already closed');

  query.status = 'closed';
  query.closedBy = req.user._id;
  query.closedAt = new Date();
  await query.save();

  res.json({ success: true, data: await withRefs(query) });
});

/** Re-opening, so a reply to a finished thread is a decision rather than a side effect. */
export const reopenQuery = asyncHandler(async (req, res) => {
  const query = await readableQuery(req.params.id, req.user);
  if (query.status !== 'closed') throw ApiError.badRequest('This query is not closed');

  query.status = query.messages.some((message) => message.kind === 'reply') ? 'answered' : 'open';
  query.closedBy = undefined;
  query.closedAt = undefined;
  await query.save();

  res.json({ success: true, data: await withRefs(query) });
});

/**
 * Who a participant may be, for the picker.
 *
 * The departments, and the people in each — so the form can offer "production" or "Ramesh in
 * production" without the screen inventing either list. Inactive people are left out: adding
 * somebody who has left is the stranding every owner check in this app exists to prevent.
 */
export const participantOptions = asyncHandler(async (req, res) => {
  const people = await User.find({ isActive: { $ne: false } })
    .select('_id name department')
    .sort({ department: 1, name: 1 });

  res.json({
    success: true,
    data: DEPARTMENT_KEYS.map((key) => ({
      key,
      label: findDepartment(key)?.label || key,
      people: people
        .filter((person) => person.department === key)
        .map((person) => ({ _id: person._id, name: person.name })),
    })).filter((department) => department.people.length || !isOwnershipScoped(req.user)),
  });
});
