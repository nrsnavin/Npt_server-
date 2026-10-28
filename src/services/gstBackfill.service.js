import SalesOrder from '../models/SalesOrder.js';
import Customer from '../models/Customer.js';
import { placeOfSupplyFor } from '../utils/gst.js';

/**
 * The orders booked before the place of supply was kept on them [utils/gst.js]: each gets its
 * buyer's — the GSTIN's state, else the state on the record — once, at start [background.js].
 * Idempotent: an order that has one is left alone, so a second run or a second process adds
 * nothing. Returns how many were written, and how many of those assumed the plant's own state
 * because the buyer's record gave no state or GSTIN.
 */
export async function backfillPlacesOfSupply() {
  const orders = await SalesOrder.find({ 'placeOfSupply.code': { $exists: false } }).select('customer isExport').lean();
  if (!orders.length) return { written: 0, assumed: 0 };
  const customers = await Customer.find({ _id: { $in: [...new Set(orders.map((order) => String(order.customer)))] } }).select('state gstin').lean();
  const byId = new Map(customers.map((customer) => [String(customer._id), customer]));
  let written = 0;
  let assumed = 0;
  for (const order of orders) {
    const place = placeOfSupplyFor(byId.get(String(order.customer)) || {}, { isExport: order.isExport });
    const { export: _exported, ...kept } = place;
    const done = await SalesOrder.updateOne({ _id: order._id, 'placeOfSupply.code': { $exists: false } }, { $set: { placeOfSupply: kept } }, { keepVersion: true });
    if (done.modifiedCount) {
      written += 1;
      if (!place.known && !place.export) assumed += 1;
    }
  }
  return { written, assumed };
}

/** The buyers with no state and no GSTIN on record — the GST on their orders assumes the plant's own state. */
export const GST_UNKNOWN = { $and: [
  { $or: [{ gstin: { $exists: false } }, { gstin: null }, { gstin: '' }] },
  { $or: [{ state: { $exists: false } }, { state: null }, { state: '' }] },
] };
