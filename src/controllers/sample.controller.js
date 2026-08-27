import Sample, {
  CLOSED_SAMPLE_STATUSES, FEEDBACK_STATUSES, NOT_ESCALATED_STATUSES,
  SAMPLE_STATUSES, WITH_CUSTOMER_STATUSES,
} from '../models/Sample.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownershipFilter, ownsRecord } from '../services/ownership.service.js';
import { canWrite } from '../services/access.service.js';
import { EVENTS, publish, sampleStatusEvent } from '../services/events.service.js';
import { createSampleRequest, defaultRequiredDate } from '../services/sampling.service.js';
import { notifyCustomer, previewFor } from '../services/customerMessage.service.js';
import CustomerMessage from '../models/CustomerMessage.js';
import { listParams, paginated } from '../utils/query.js';

/**
 * Marketing's view of a sample runs through `requestedBy`, not `assignedTo` — the sample is
 * worked by the sample team, so scoping on who is doing the work would hide every sample from
 * the person who asked for it. Sampling itself is not ownership-scoped and sees the lot.
 */
const scope = (user) => ownershipFilter(user, 'requestedBy');
const owns = (user, sample) => ownsRecord(user, sample, 'requestedBy');

const POPULATE = [
  { path: 'customer', select: 'code name' },
  { path: 'enquiry', select: 'number status requirement.quantity' },
  { path: 'requestedBy', select: 'name' },
  { path: 'assignedTo', select: 'name' },
  { path: 'product', select: 'modelCode name' },
  { path: 'referencePhoto', select: 'key filename mimeType size' },
];

const LINKED = [
  { path: 'previousSample', select: 'number status' },
  { path: 'supersededBy', select: 'number status' },
];

/**
 * Every response carries the same shape, including the ones that answer an action.
 *
 * A save() returns the raw document, so responding with it would hand the screen a thinner
 * record than the one it is already showing — the customer, enquiry and model would blank
 * out until the next reload. Re-reading is one query and keeps the contract identical.
 */
const withRefs = (sample) => sample.populate([...POPULATE, ...LINKED]);

export const listSamples = asyncHandler(async (req, res) => {
  const { page, limit, sort, filter } = listParams(req.query, {
    searchFields: ['number', 'modelNumber', 'colour', 'remarks'],
    defaultSort: 'requiredDate',
  });

  Object.assign(filter, scope(req.user));
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.open === 'true') filter.status = { $nin: CLOSED_SAMPLE_STATUSES };
  if (req.query.purpose) filter.purpose = req.query.purpose;
  if (req.query.customer) filter.customer = req.query.customer;
  if (req.query.enquiry) filter.enquiry = req.query.enquiry;
  // Matches a field that was never set and one that was cleared, which are the same thing
  // to the queue but not to Mongo.
  if (req.query.unassigned === 'true') filter.assignedTo = null;
  if (req.query.mine === 'true') filter.assignedTo = req.user._id;

  /**
   * The escalation query [§25]. Overdue is a virtual on the model, so it cannot be sorted or
   * paged on; this expresses the same rule as a filter, from the same list of exclusions.
   */
  if (req.query.overdue === 'true') {
    filter.requiredDate = { $lt: new Date() };
    filter.status = { $nin: NOT_ESCALATED_STATUSES };
  }

  const [data, total] = await Promise.all([
    Sample.find(filter).populate(POPULATE).sort(sort).skip((page - 1) * limit).limit(limit),
    Sample.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

export const getSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id).populate([...POPULATE, ...LINKED]);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  res.json({ success: true, data: sample });
});

/**
 * Raises a request by hand.
 *
 * The usual path is the automation: moving an enquiry to `sample_required` raises one [§6].
 * This exists for the cases automation cannot see — a second sample after a modification, or
 * a request the sample team takes directly.
 */
export const createSample = asyncHandler(async (req, res) => {
  const { enquiry: enquiryId, customer: customerId, ...input } = req.body;

  let enquiry = null;
  if (enquiryId) {
    enquiry = await Enquiry.findById(enquiryId);
    if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
    // Raising a request against an enquiry you cannot see would put it in its owner's list.
    if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  }

  let customer = null;
  if (customerId) {
    customer = await Customer.findById(customerId);
    if (!customer) throw ApiError.badRequest('That customer does not exist');
    if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');
  }

  /*
   * With no enquiry to inherit from, the request has to say what to make on its own. A
   * sample nobody can identify is a job the bench cannot start, so this is refused here
   * rather than discovered at the bench.
   */
  if (!enquiry && !input.product && !input.modelNumber) {
    throw ApiError.badRequest(
      'Pick a model, or describe what to make, when there is no enquiry to take it from'
    );
  }

  const { sample, created } = await createSampleRequest(
    { enquiry, customer: customer?._id ?? undefined, ...input },
    req.user
  );

  if (!created) {
    throw ApiError.conflict(
      `${sample.number} is already open against ${enquiry.number}. Work that one, or record its outcome first.`
    );
  }

  res.status(201).json({ success: true, data: await withRefs(sample) });
});

/**
 * Attaches a standalone request to the enquiry that turns up after it.
 *
 * The walk-in who asked for a sample on Monday raises an enquiry on Thursday, and the two
 * should be one story. Only ever set, never moved: re-pointing a sample at a different
 * enquiry would rewrite what was made for whom.
 */
export const linkEnquiry = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (sample.enquiry) throw ApiError.badRequest('This request already belongs to an enquiry');

  const enquiry = await Enquiry.findById(req.body.enquiry);
  if (!enquiry) throw ApiError.badRequest('That enquiry does not exist');
  if (!ownsRecord(req.user, enquiry)) throw ApiError.notFound('Enquiry not found');
  if (sample.customer && String(sample.customer) !== String(enquiry.customer)) {
    throw ApiError.badRequest('That enquiry belongs to a different customer');
  }

  sample.enquiry = enquiry._id;
  if (!sample.customer) sample.customer = enquiry.customer;
  sample.statusHistory.push({
    from: sample.status,
    to: sample.status,
    by: req.user._id,
    note: `Attached to ${enquiry.number}`,
  });
  await sample.save();

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Names the buyer on a request raised without one.
 *
 * The counter request and the internal trial both start with nobody attached — that is the
 * point of allowing it — but a trial that turns into real work needs the buyer on it, and
 * re-keying the whole request to get them there loses the history of what was already made.
 *
 * Set once, like the enquiry: moving a sample to a different customer would rewrite what was
 * made for whom. A sample that came from an enquiry takes its customer from that enquiry, so
 * this refuses rather than letting the two disagree.
 */
export const linkCustomer = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (sample.customer) throw ApiError.badRequest('This request already names a customer');
  if (sample.enquiry) {
    throw ApiError.badRequest(
      'This request belongs to an enquiry, and takes its customer from there'
    );
  }

  const customer = await Customer.findById(req.body.customer);
  if (!customer) throw ApiError.badRequest('That customer does not exist');
  if (!ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');

  sample.customer = customer._id;
  sample.statusHistory.push({
    from: sample.status,
    to: sample.status,
    by: req.user._id,
    note: `Customer set to ${customer.name}`,
  });
  await sample.save();

  res.json({ success: true, data: await withRefs(sample) });
});

export const updateSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (req.body.status) {
    throw ApiError.badRequest('Use the status action to move a sample through its stages');
  }
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample can no longer be edited`);
  }

  Object.assign(sample, req.body);
  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/** Picking a request off the shared queue, or handing it to a colleague. */
export const assignSample = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  // An explicit null hands it back to the shared queue; omitting it takes it yourself.
  sample.assignedTo = req.body.assignedTo === null ? null : req.body.assignedTo || req.user._id;
  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Courier, tracking number, date and quantity — recorded whenever they are known.
 *
 * Separate from the dispatch move for two reasons. They are often arranged before the sample
 * leaves, and knowing them early changes what the customer is told when it is ready. And a
 * tracking number typed wrong is worth correcting afterwards, which the move cannot do
 * because a sample only dispatches once.
 */
export const setDispatchDetails = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample can no longer be edited`);
  }

  for (const field of ['courier', 'awbNumber', 'dispatchedAt', 'dispatchedQuantity']) {
    if (req.body[field] !== undefined) sample[field] = req.body[field] ?? undefined;
  }

  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Moves a sample to a new stage.
 *
 * Two rules from §6 are enforced here rather than reported afterwards. Dispatching demands
 * the courier, AWB, date and quantity, because a sample the customer cannot be told how to
 * expect is a sample nobody chases. And the three feedback stages are not the sample team's
 * to set — see `recordFeedback`.
 */
export const setSampleStatus = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const { status, note, courier, awbNumber, dispatchedAt, dispatchedQuantity } = req.body;

  if (status === sample.status) throw ApiError.badRequest(`Already at ${status}`);
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`A ${sample.status} sample cannot be moved again`);
  }
  if (FEEDBACK_STATUSES.includes(status)) {
    throw ApiError.badRequest(
      'What the customer said is recorded through the feedback action, by whoever spoke to them'
    );
  }

  if (status === 'dispatched') {
    // Whatever was arranged earlier stands unless this call overrides it, so details entered
    // in advance do not have to be typed a second time to get the sample out of the door.
    const details = {
      courier: courier ?? sample.courier,
      awbNumber: awbNumber ?? sample.awbNumber,
      dispatchedQuantity: dispatchedQuantity ?? sample.dispatchedQuantity,
    };

    const missing = [
      !details.courier && 'courier',
      !details.awbNumber && 'AWB number',
      details.dispatchedQuantity == null && 'dispatched quantity',
    ].filter(Boolean);

    if (missing.length) {
      throw ApiError.badRequest(`Dispatching needs the ${missing.join(', ')}`);
    }

    Object.assign(sample, details);
    sample.dispatchedAt = dispatchedAt || sample.dispatchedAt || new Date();
  }

  if (status === 'delivered') sample.deliveredAt = new Date();

  const from = sample.status;
  sample.status = status;
  sample.statusHistory.push({ from, to: status, by: req.user._id, note });
  await sample.save();

  publish(EVENTS.SAMPLE_STATUS_CHANGED, { sample, from, to: status, by: req.user });
  const specific = sampleStatusEvent(status);
  if (specific) publish(specific, { sample, from, by: req.user });

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Records what the customer said.
 *
 * Deliberately a separate action on a separate grant. The sample team owns making the
 * sample; only the person talking to the customer knows the answer, and letting the maker
 * mark their own work approved is how a sample register stops being worth reading.
 */
export const recordFeedback = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const { outcome, note } = req.body;

  /*
   * The rule that the maker does not mark their own work approved protects the customer's
   * verdict. A request with no customer has none to protect — an internal trial is the
   * bench's to judge — so the check applies only where there is somebody to have spoken to.
   */
  if (sample.customer && !canWrite(req.user, 'enquiries')) {
    throw ApiError.forbidden(
      'Recording what the customer said needs write access to enquiries — the person who spoke to them.'
    );
  }

  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) {
    throw ApiError.badRequest(`This sample was already ${sample.status}`);
  }
  /*
   * A verdict needs the sample to have reached whoever gives it. For a customer that means
   * dispatched; for an internal trial with no customer it means made, since the bench is
   * looking at the thing on its own bench.
   */
  const ready = sample.customer
    ? WITH_CUSTOMER_STATUSES.includes(sample.status)
    : ['sample_ready', ...WITH_CUSTOMER_STATUSES].includes(sample.status);

  if (!ready) {
    throw ApiError.badRequest(
      sample.customer
        ? 'The customer cannot have an opinion on a sample that has not reached them yet'
        : 'Judge it once it has been made — move it to sample ready first'
    );
  }

  const from = sample.status;
  sample.status = outcome;
  sample.feedbackAt = new Date();
  sample.feedbackBy = req.user._id;
  sample.feedbackNote = note;
  sample.statusHistory.push({ from, to: outcome, by: req.user._id, note });
  await sample.save();

  publish(EVENTS.SAMPLE_STATUS_CHANGED, { sample, from, to: outcome, by: req.user });
  publish(sampleStatusEvent(outcome), { sample, from, by: req.user });

  res.json({ success: true, data: await withRefs(sample) });
});

/**
 * Raises the next attempt after `modification_required`, carrying everything forward and
 * linking the two, so the register reads as a sequence of attempts rather than a pile of
 * unrelated requests.
 */
export const resample = asyncHandler(async (req, res) => {
  const previous = await Sample.findById(req.params.id);
  if (!previous) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, previous)) throw ApiError.notFound('Sample not found');
  if (previous.status !== 'modification_required') {
    throw ApiError.badRequest('Only a sample the customer asked to modify can be re-sampled');
  }
  if (previous.supersededBy) throw ApiError.conflict('A follow-up sample already exists');

  // A standalone request re-samples too: there is simply no enquiry to inherit from.
  const enquiry = previous.enquiry ? await Enquiry.findById(previous.enquiry) : null;
  if (previous.enquiry && !enquiry) {
    throw ApiError.badRequest('The enquiry behind this sample no longer exists');
  }

  const carried = {
    customer: previous.customer,
    product: previous.product,
    modelNumber: previous.modelNumber,
    category: previous.category,
    sizeMm: previous.sizeMm,
    material: previous.material,
    standaloneReason: previous.standaloneReason,
    colour: previous.colour,
    printing: previous.printing,
    hookType: previous.hookType,
    quantity: previous.quantity,
    purpose: previous.purpose,
    remarks: previous.feedbackNote,
    ...req.body,
    previousSample: previous._id,
    requiredDate: req.body.requiredDate || defaultRequiredDate(enquiry),
  };

  const { sample, created } = await createSampleRequest({ enquiry, ...carried }, req.user);
  if (!created) throw ApiError.conflict(`${sample.number} is already open against ${enquiry.number}`);

  previous.supersededBy = sample._id;
  await previous.save();

  res.status(201).json({ success: true, data: { sample: await withRefs(sample), previous } });
});

/** Counts and overdue per stage, for the sampling dashboard [§22]. */
export const samplePipeline = asyncHandler(async (req, res) => {
  const match = scope(req.user);
  const now = new Date();

  const rows = await Sample.aggregate([
    ...(Object.keys(match).length ? [{ $match: match }] : []),
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        overdue: {
          $sum: {
            $cond: [
              {
                $and: [
                  { $ne: ['$requiredDate', null] },
                  { $lt: ['$requiredDate', now] },
                  { $not: [{ $in: ['$status', NOT_ESCALATED_STATUSES] }] },
                ],
              },
              1,
              0,
            ],
          },
        },
      },
    },
    { $project: { _id: 0, status: '$_id', count: 1, overdue: 1 } },
  ]);

  // Report every stage, including the empty ones: a funnel with gaps hides where work stalls.
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, row]));
  const data = SAMPLE_STATUSES.map(
    (status) => byStatus[status] || { status, count: 0, overdue: 0 }
  );

  res.json({ success: true, data });
});

/* --------------------------- Telling the customer [§42] --------------------------- */

/** Which eligible update a stage corresponds to, if any [§42.5]. */
const eventForStatus = (status) =>
  ({ sample_ready: 'sample_ready', dispatched: 'sample_dispatched' })[status] || null;

/**
 * The draft a person sees before sending, and what has already gone [§42.7].
 *
 * Rendered from the same context the automation uses, so what is approved here is what
 * would otherwise have been sent.
 */
export const previewCustomerMessage = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const event = req.query.event || eventForStatus(sample.status);
  if (!event) throw ApiError.badRequest('There is nothing to tell the customer at this stage');

  res.json({ success: true, data: await previewFor(sample, event) });
});

/**
 * Sends it, after the person has read and possibly edited the draft.
 *
 * This is §42's own flow, kept alongside the automatic path: a stage that stops sending
 * itself is still reachable by hand, and a failed automatic send can be retried without
 * moving the sample backwards.
 */
export const sendCustomerMessage = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const event = req.body.event || eventForStatus(sample.status);
  if (!event) throw ApiError.badRequest('There is nothing to tell the customer at this stage');

  const messages = await notifyCustomer({
    sample,
    event,
    user: req.user,
    channels: req.body.channels,
    subject: req.body.subject,
    body: req.body.body,
    force: req.body.force,
  });

  res.status(201).json({ success: true, data: messages });
});

/** Everything ever sent to this customer about this sample [§42.6]. */
export const listCustomerMessages = asyncHandler(async (req, res) => {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!owns(req.user, sample)) throw ApiError.notFound('Sample not found');

  const data = await CustomerMessage.find({ sample: sample._id })
    .populate('sentBy', 'name')
    .sort('-sentAt');

  res.json({ success: true, data });
});
