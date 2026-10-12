import Customer from '../models/Customer.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { startOfDayIST } from '../services/handoff.service.js';

/** How much history one customer keeps — years of weekly calls, and no unbounded array. */
const LOG_LIMIT = 200;

async function ownedCustomer(req) {
  const customer = await Customer.findById(req.params.id).select('name code assignedTo sharedWith followUp');
  /* Somebody else's buyer is not there, the same as on the customer page. */
  if (!customer || !ownsRecord(req.user, customer)) throw ApiError.notFound('Customer not found');
  return customer;
}

function assertNotPast(date) {
  if (date < startOfDayIST()) throw ApiError.badRequest('A follow-up date cannot be in the past');
}

const historyOf = async (id) => {
  const customer = await Customer.findById(id)
    .select('name code followUp followUpLog')
    .populate('followUpLog.by', 'name')
    .populate('followUp.setBy', 'name')
    .lean();
  return {
    _id: customer._id,
    name: customer.name,
    code: customer.code,
    followUp: customer.followUp || null,
    log: [...(customer.followUpLog || [])].reverse(),
  };
};

/** The customer's open follow-up and every call logged against it, newest first. */
export const customerFollowUpHistory = asyncHandler(async (req, res) => {
  const customer = await ownedCustomer(req);
  res.json({ success: true, data: await historyOf(customer._id) });
});

/**
 * Set, log or close a customer's follow-up [Customer `followUp`]. One write each, with its line
 * in the history; bookkeeping rather than an edit, so a customer form open elsewhere is not
 * told its record changed under it.
 */
export const customerFollowUp = asyncHandler(async (req, res) => {
  const customer = await ownedCustomer(req);
  const { action, note } = req.body;
  const by = req.user._id;
  const at = new Date();
  let update;

  if (action === 'set') {
    assertNotPast(req.body.due);
    update = {
      $set: { followUp: { due: req.body.due, note, priority: req.body.priority || 'normal', setBy: by, setAt: at } },
      $push: { followUpLog: { $each: [{ kind: 'set', note, due: req.body.due, by, at }], $slice: -LOG_LIMIT } },
    };
  } else if (action === 'log') {
    const next = req.body.next;
    if (next) assertNotPast(next);
    update = {
      $push: { followUpLog: { $each: [{ kind: 'log', note, due: next, by, at }], $slice: -LOG_LIMIT } },
      ...(next
        ? customer.followUp
          ? { $set: { 'followUp.due': next } }
          : { $set: { followUp: { due: next, note, priority: 'normal', setBy: by, setAt: at } } }
        : {}),
    };
  } else {
    if (!customer.followUp) throw ApiError.badRequest(`${customer.name} has no open follow-up to close`);
    update = {
      $unset: { followUp: 1 },
      $push: { followUpLog: { $each: [{ kind: 'close', note, by, at }], $slice: -LOG_LIMIT } },
    };
  }

  await Customer.updateOne({ _id: customer._id }, update, { keepVersion: true });
  res.json({ success: true, data: await historyOf(customer._id) });
});
