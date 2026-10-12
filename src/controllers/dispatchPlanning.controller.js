import Transporter from '../models/Transporter.js';
import { latestQcByEnquiry } from '../services/records.service.js';
import DeliveryRoute from '../models/DeliveryRoute.js';
import Vehicle from '../models/Vehicle.js';
import Trip from '../models/Trip.js';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { expectVersion, withoutVersion } from '../utils/concurrency.js';
import { inTransaction, transactional } from '../utils/transaction.js';
import { recordChange, snapshot } from '../services/audit.service.js';
import { dispatchPlan, scheduleGroup, setCustomerDelivery, suggestTrips, tripSummary } from '../services/dispatchPlanning.service.js';
import {
  createTrip, dispatchReport, listTrips, makeTrips, populateTrip, renderTripSheet, setStopStatus, setTripStatus, tellBuyers, updateTrip,
} from '../services/trip.service.js';

/**
 * The dispatch planner and the two lists it groups by [services/dispatchPlanning.service.js]:
 * transporters (and their booking offices) and the plant's own delivery routes.
 */

export const getDispatchPlan = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await dispatchPlan() });
});

export const scheduleDispatchGroup = asyncHandler(transactional(async (req, res) => {
  res.json({ success: true, data: await scheduleGroup(req.body, req.user) });
}));

export const setDeliveryDetails = asyncHandler(transactional(async (req, res) => {
  res.json({ success: true, data: await setCustomerDelivery(req.body) });
}));

/** A plain list with an active flag — nothing is deleted, a transporter no longer used is switched off. */
function master(Model, label, sortKey = 'name') {
  const list = asyncHandler(async (req, res) => {
    const filter = req.query.active === 'true' ? { active: { $ne: false } } : {};
    res.json({ success: true, data: await Model.find(filter).sort({ active: -1, [sortKey]: 1 }).collation({ locale: 'en' }).lean() });
  });
  const create = asyncHandler(transactional(async (req, res) => {
    const [made] = await Model.create([withoutVersion(req.body)]);
    res.status(201).json({ success: true, data: made });
  }));
  const update = asyncHandler(transactional(async (req, res) => {
    const doc = await Model.findById(req.params.id);
    if (!doc) throw ApiError.notFound(`${label} not found`);
    expectVersion(doc, req.body);
    const before = snapshot(doc);
    doc.set(withoutVersion(req.body));
    await doc.save();
    await recordChange({ model: Model.modelName, doc, before, by: req.user });
    res.json({ success: true, data: doc });
  }));
  return { list, create, update };
}

export const transporters = master(Transporter, 'Transporter');
export const deliveryRoutes = master(DeliveryRoute, 'Route');
export const vehicles = master(Vehicle, 'Vehicle', 'number');

/* ---------------------------------------------------------------- trips --- */

async function tripFor(req) {
  if (!mongoose.isValidObjectId(req.params.id)) throw ApiError.notFound('Trip not found');
  const trip = await Trip.findById(req.params.id);
  if (!trip) throw ApiError.notFound('Trip not found');
  return trip;
}
const answerTrip = async (res, trip, status = 200) => res.status(status).json({ success: true, data: await populateTrip(trip) });

export const listTripsHandler = asyncHandler(async (req, res) => {
  const trips = await listTrips({ from: req.query.from, to: req.query.to, status: req.query.status });
  res.json({ success: true, data: trips.map(tripSummary) });
});

/* The trip, with the latest QC verdict beside each stop — shown to whoever loads it, never a lock. */
export const getTrip = asyncHandler(async (req, res) => {
  const data = (await populateTrip(await tripFor(req))).toJSON();
  const qc = await latestQcByEnquiry(data.stops.map((stop) => stop.enquiry?._id || stop.enquiry));
  data.stops = data.stops.map((stop) => ({ ...stop, qc: qc.get(String(stop.enquiry?._id || stop.enquiry)) || null }));
  res.json({ success: true, data });
});

export const createTripHandler = asyncHandler(transactional(async (req, res) => {
  await answerTrip(res, await createTrip(req.body, req.user), 201);
}));

export const updateTripHandler = asyncHandler(transactional(async (req, res) => {
  const trip = await tripFor(req);
  expectVersion(trip, req.body);
  await answerTrip(res, await updateTrip(trip, withoutVersion(req.body), req.user));
}));

export const setTripStatusHandler = asyncHandler(transactional(async (req, res) => {
  await answerTrip(res, await setTripStatus(await tripFor(req), req.body, req.user));
}));

export const setStopStatusHandler = asyncHandler(transactional(async (req, res) => {
  await answerTrip(res, await setStopStatus(await tripFor(req), req.params.stopId, req.body, req.user));
}));

/* Not in a transaction: it sends messages, and each one is logged whatever happens to the next. */
export const tellBuyersHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await tellBuyers(await tripFor(req), req.body || {}, req.user) });
});

export const tripSheet = asyncHandler(async (req, res) => {
  const trip = await tripFor(req);
  const pdf = await renderTripSheet(trip);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${trip.number}-trip-sheet.pdf"` });
  res.send(pdf);
});

export const suggestTripsHandler = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await suggestTrips() });
});

/* Each trip in its own transaction, so one refused does not undo the others. */
export const makeSuggestedTrips = asyncHandler(async (req, res) => {
  const { made, refused } = await makeTrips(req.body, req.user, { inTransaction });
  res.status(made.length ? 201 : 409).json({
    success: made.length > 0,
    data: { made: made.map((trip) => ({ _id: trip._id, number: trip.number })), refused },
    ...(made.length ? {} : { message: refused[0]?.message || 'No trip could be made' }),
  });
});

const indiaToday = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(Date.now() + offset * 86400000));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const dispatchReportHandler = asyncHandler(async (req, res) => {
  const from = DAY.test(req.query.from || '') ? req.query.from : indiaToday(-29);
  const to = DAY.test(req.query.to || '') ? req.query.to : indiaToday(7);
  res.json({ success: true, data: await dispatchReport({ from, to }) });
});
