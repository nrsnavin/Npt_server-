import mongoose from 'mongoose';
import Customer from '../models/Customer.js';
import Query, { inTheRoom, seesEveryQuery } from '../models/Query.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { recordChange, snapshot } from '../services/audit.service.js';

/**
 * Pinning a buyer's site from a check-in, and taking the pin off.
 *
 * **The coordinates are never typed.** The request names a query and a message in it, and the
 * pin is copied from the location that message already carries. That is the whole design: a
 * pin with a check-in behind it can be traced to who stood at the gate and when; a typed
 * coordinate cannot, and a wrong one sends a lorry forty minutes the wrong way with nothing to
 * check it against.
 *
 * **Who may.** The account owner or an administrator — `ownsRecord`, the same rule as any other
 * edit to the buyer. Being in a thread about a customer lets somebody *read* them; it does not
 * let them change the customer's record, and a pin is part of the record. Despatch at the gate
 * shares the location in the thread; marketing, who owns the account, pins it.
 *
 * **And the message has to be about this customer.** A thread about SCM cannot pin Sunrise's
 * gate, however the ids are put together.
 */

/** The customer, if this person may edit them — one refusal, so a probe learns nothing. */
async function editableCustomer(id, user) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.notFound('Customer not found');
  const customer = await Customer.findById(id);
  if (!customer || !ownsRecord(user, customer)) throw ApiError.notFound('Customer not found');
  return customer;
}

export const pinSite = asyncHandler(async (req, res) => {
  const customer = await editableCustomer(req.params.id, req.user);
  const { query: queryId, message: messageId } = req.body;

  if (!mongoose.isValidObjectId(queryId) || !mongoose.isValidObjectId(messageId)) {
    throw ApiError.badRequest('Pin a location somebody shared in a query thread');
  }

  /* The thread has to be one the person can read — the same door the thread itself uses. */
  const query = await Query.findById(queryId);
  if (!query || (!seesEveryQuery(req.user) && !inTheRoom(query, req.user))) {
    throw ApiError.notFound('Query not found');
  }
  if (String(query.customer) !== String(customer._id)) {
    throw ApiError.badRequest(`${query.number} is about a different customer`);
  }

  const message = query.messages.id(messageId);
  if (!message?.location || message.location.lat == null) {
    throw ApiError.badRequest('That message has no location to pin');
  }

  const before = snapshot(customer);
  const { lat, lng, accuracyM, place } = message.location;
  customer.site = {
    lat,
    lng,
    accuracyM,
    place: place?.name ? { name: place.name, state: place.state, distanceKm: place.distanceKm } : undefined,
    setBy: req.user._id,
    setAt: new Date(),
    fromQuery: query._id,
    fromMessage: message._id,
  };

  await customer.save();
  await recordChange({ model: 'Customer', doc: customer, before, by: req.user });

  await customer.populate('site.setBy', 'name');
  res.json({ success: true, data: customer.site });
});

export const clearSite = asyncHandler(async (req, res) => {
  const customer = await editableCustomer(req.params.id, req.user);
  if (!customer.site) return res.json({ success: true, data: null });

  const before = snapshot(customer);
  customer.site = undefined;
  await customer.save();
  await recordChange({ model: 'Customer', doc: customer, before, by: req.user });

  return res.json({ success: true, data: null });
});
