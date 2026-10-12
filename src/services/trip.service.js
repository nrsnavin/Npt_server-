import Todo from '../models/Todo.js';
import Trip, { EDITABLE_TRIP_STATUSES, OPEN_TRIP_STATUSES } from '../models/Trip.js';
import Vehicle from '../models/Vehicle.js';
import Transporter from '../models/Transporter.js';
import Enquiry from '../models/Enquiry.js';
import Customer from '../models/Customer.js';
import CustomerMessage from '../models/CustomerMessage.js';
import { isProduction } from '../config/env.js';
import { isWhatsAppConfigured, sendWhatsApp, whatsappTemplate } from '../providers/whatsapp.js';
import { normalisePhone } from '../utils/phone.js';
import ApiError from '../utils/ApiError.js';
import { nextNumber } from './numbering.service.js';
import { setTaskStatus } from './handoff.service.js';
import { withCreateLocks } from './operationLock.service.js';
import { render, letterhead, facts, footer } from './recordPdf.js';

/**
 * Trips [models/Trip.js]: a group from the trip planner made into a vehicle on a day, then
 * loaded, sent and ticked off stop by stop.
 *
 * The trip does not keep its own copy of whether the goods went. Each stop is a dispatch request,
 * and the trip moves the request through the request's own statuses: making the trip for today or
 * tomorrow sets Today / Tomorrow Dispatch, and the trip leaving sets Dispatched — which is what
 * gives Reception the LR copy task and tells the enquiry's marketing person and Admin. So the
 * enquiry page, the department dashboards and the trip all say the same thing, because there is
 * only one thing to say it.
 */

const indiaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
const addDays = (day, n) => indiaDay(new Date(new Date(`${day}T12:00:00+05:30`).getTime() + n * 86400000));

/** The dispatch schedule a trip on this day means for its requests, if it means one. */
export function scheduleForDay(day) {
  if (day === indiaDay()) return 'today_dispatch';
  if (day === addDays(indiaDay(), 1)) return 'tomorrow_dispatch';
  return null;
}

/** What the trip goes on, in words: "TN 39 AB 4521 · Tata Ace", "KPN Parcel · Tiruppur office". */
function goesBy(trip) {
  if (trip.mode === 'party_collects') return 'collected by the buyer';
  if (trip.mode === 'courier') return 'courier';
  if (trip.mode === 'transport') return [trip.transporter?.name, trip.transporter?.bookingOffice].filter(Boolean).join(' · ') || 'transport';
  return [trip.vehicle?.number, trip.vehicle?.kind].filter(Boolean).join(' · ') || 'our vehicle';
}

const ACTIVE = { completed: false, kind: 'invoice_dispatch' };

/** The open dispatch requests named, each with its buyer — or a refusal naming what is wrong. */
async function openRequests(ids) {
  const unique = [...new Set(ids.map(String))];
  const tasks = await Todo.find({ _id: { $in: unique }, ...ACTIVE }).populate({ path: 'enquiry', select: 'number customer' });
  if (tasks.length !== unique.length) throw ApiError.badRequest('One of those dispatch requests is finished or no longer exists — reload the plan');
  return tasks;
}

/** Refuses requests already on another open trip, naming the trip. */
async function assertNotOnATrip(ids, exceptTrip) {
  const clash = await Trip.findOne({
    status: { $in: OPEN_TRIP_STATUSES },
    'stops.task': { $in: ids },
    ...(exceptTrip ? { _id: { $ne: exceptTrip } } : {}),
  }).select('number').lean();
  if (clash) throw ApiError.conflict(`One of those requests is already on ${clash.number}. Take it off that trip first.`);
}

const stopFor = (task, cartons) => ({
  task: task._id,
  enquiry: task.enquiry?._id || undefined,
  customer: task.customer || task.enquiry?.customer || undefined,
  model: task.brief?.model || undefined,
  quantity: Number(task.brief?.quantity) || undefined,
  cartons: cartons ?? undefined,
});

/** Who drives it and with what, checked against the lists. */
async function transportFields({ mode, vehicle, transporter, driverName, driverPhone }) {
  const fields = { mode };
  if (mode === 'own_vehicle') {
    if (vehicle) {
      const found = await Vehicle.findById(vehicle).lean();
      if (!found) throw ApiError.badRequest('That vehicle is not on the list');
      fields.vehicle = found._id;
      fields.driverName = driverName ?? found.driverName;
      fields.driverPhone = driverPhone ?? found.driverPhone;
    } else if (!driverName) {
      throw ApiError.badRequest('Pick the vehicle, or say who is driving');
    }
  }
  if (mode === 'transport') {
    const found = transporter && (await Transporter.findById(transporter).lean());
    if (!found) throw ApiError.badRequest('Pick the transporter the goods are booked with');
    fields.transporter = found._id;
  }
  if (driverName !== undefined && mode !== 'own_vehicle') fields.driverName = driverName;
  if (driverPhone !== undefined && mode !== 'own_vehicle') fields.driverPhone = driverPhone;
  return fields;
}

/** Moves each request to the schedule the trip's day means, with the trip in the remark. */
async function scheduleRequests(trip, tasks, user) {
  const status = scheduleForDay(trip.date);
  if (!status) return;
  for (const task of tasks) {
    if (task.completed || ['dispatched', 'fully_dispatched', status].includes(task.status)) continue;
    await setTaskStatus(task, user, { status, note: `On trip ${trip.number} — ${trip.date}${trip.departAt ? ` ${trip.departAt}` : ''}` });
  }
}

export async function createTrip({ tasks: asked, cartons = {}, date, departAt, note, ...transport }, user) {
  const ids = [...new Set(asked.map(String))];
  const day = date || addDays(indiaDay(), 1);
  if (day < indiaDay()) throw ApiError.badRequest('A trip cannot be planned for a day that has gone');
  return withCreateLocks(ids.map((id) => `trip-request:${id}`), async () => {
    const tasks = await openRequests(ids);
    await assertNotOnATrip(tasks.map((task) => task._id));
    const [trip] = await Trip.create([{
      number: await nextNumber('TRP'),
      date: day,
      departAt: departAt || undefined,
      note: note || undefined,
      ...(await transportFields(transport)),
      stops: ids.map((id) => tasks.find((task) => String(task._id) === String(id))).map((task) => stopFor(task, cartons[String(task._id)])),
      statusHistory: [{ to: 'planned', by: user._id }],
      createdBy: user._id,
    }]);
    await trip.populate([{ path: 'vehicle' }, { path: 'transporter' }]);
    await scheduleRequests(trip, tasks, user);
    return trip;
  });
}

/**
 * Changing a trip before it leaves: the day, the time, the vehicle or transporter, the driver,
 * the order of the stops and their cartons, stops taken off (`stops` lists those kept, in order)
 * and requests put on (`addTasks`).
 */
export async function updateTrip(trip, body, user) {
  if (!EDITABLE_TRIP_STATUSES.includes(trip.status)) throw ApiError.conflict(`${trip.number} has ${trip.status === 'left' ? 'left' : `been ${trip.status}`} — its load can no longer change`);
  const added = (body.addTasks || []).map(String).filter((id) => !trip.stops.some((stop) => String(stop.task) === id));
  return withCreateLocks(added.map((id) => `trip-request:${id}`), async () => {
    if (body.date !== undefined) {
      if (body.date < indiaDay()) throw ApiError.badRequest('A trip cannot be moved to a day that has gone');
      trip.date = body.date;
    }
    for (const key of ['departAt', 'note']) if (body[key] !== undefined) trip[key] = body[key] || undefined;
    if (body.mode !== undefined || body.vehicle !== undefined || body.transporter !== undefined) {
      const fields = await transportFields({
        mode: body.mode ?? trip.mode,
        vehicle: body.vehicle === undefined ? trip.vehicle : body.vehicle,
        transporter: body.transporter === undefined ? trip.transporter : body.transporter,
        driverName: body.driverName, driverPhone: body.driverPhone,
      });
      trip.set({ vehicle: undefined, transporter: undefined, ...fields });
    } else {
      if (body.driverName !== undefined) trip.driverName = body.driverName || undefined;
      if (body.driverPhone !== undefined) trip.driverPhone = body.driverPhone || undefined;
    }
    if (body.stops) {
      const kept = body.stops.map((entry) => {
        const stop = trip.stops.id(entry.id);
        if (!stop) throw ApiError.badRequest('One of those stops is not on this trip');
        if (entry.cartons !== undefined) stop.cartons = entry.cartons ?? undefined;
        return stop;
      });
      trip.stops = kept;
    }
    let addedTasks = [];
    if (added.length) {
      addedTasks = await openRequests(added);
      await assertNotOnATrip(addedTasks.map((task) => task._id), trip._id);
      for (const task of addedTasks) trip.stops.push(stopFor(task, body.cartons?.[String(task._id)]));
    }
    if (!trip.stops.length) throw ApiError.badRequest('A trip needs at least one stop — cancel it instead');
    await trip.save();
    await trip.populate([{ path: 'vehicle' }, { path: 'transporter' }]);
    /* A new day, or new stops, mean a new schedule on those requests. */
    const moved = body.date !== undefined ? await openRequests(trip.stops.map((stop) => stop.task)).catch(() => []) : addedTasks;
    await scheduleRequests(trip, moved, user);
    return trip;
  });
}

const NEXT = {
  planned: ['loading', 'left', 'cancelled'],
  loading: ['planned', 'left', 'cancelled'],
  left: ['completed'],
  completed: [],
  cancelled: [],
};

/** Copies what Reception will be asked for onto the LR copy task the departure raised. */
async function fillLrCopy(task, trip) {
  if (!task.enquiry) return;
  const lr = await Todo.findOne({ enquiry: task.enquiry?._id || task.enquiry, kind: 'lr_copy', completed: false });
  if (!lr) return;
  const brief = { ...(lr.brief || {}) };
  if (!brief.transporter) brief.transporter = trip.mode === 'transport' ? trip.transporter?.name : trip.mode === 'courier' ? 'Courier' : trip.mode === 'party_collects' ? 'Party collected' : 'Own vehicle';
  if (!brief.vehicleNumber && trip.vehicle?.number) brief.vehicleNumber = trip.vehicle.number;
  if (!brief.dispatchedOn) brief.dispatchedOn = indiaDay();
  lr.brief = brief;
  lr.markModified('brief');
  await lr.save();
}

export async function setTripStatus(trip, { status, note }, user) {
  if (!(NEXT[trip.status] || []).includes(status)) {
    throw ApiError.conflict(`${trip.number} is ${trip.status} — it cannot be marked ${status} now`);
  }
  await trip.populate([{ path: 'vehicle' }, { path: 'transporter' }]);
  const text = String(note || '').trim();
  if (status === 'left') {
    const remark = `Left on ${trip.number} · ${goesBy(trip)}${trip.driverName ? ` · driver ${trip.driverName}${trip.driverPhone ? ` ${trip.driverPhone}` : ''}` : ''}${text ? ` — ${text}` : ''}`;
    for (const stop of trip.stops) {
      const task = await Todo.findById(stop.task).populate({ path: 'enquiry', select: 'number customer' });
      /* Sent by hand already, or closed: nothing to move. */
      if (!task || task.completed || ['dispatched', 'fully_dispatched'].includes(task.status)) continue;
      await setTaskStatus(task, user, { status: 'dispatched', note: remark });
      await fillLrCopy(task, trip);
    }
    trip.leftAt = new Date();
  }
  if (status === 'completed') {
    for (const stop of trip.stops) {
      if (stop.status === 'planned') Object.assign(stop, { status: 'delivered', at: new Date() });
    }
    trip.completedAt = new Date();
  }
  trip.statusHistory.push({ from: trip.status, to: status, note: text || undefined, by: user._id });
  trip.status = status;
  await trip.save();
  return trip;
}

/** One stop ticked: delivered, or not — with why, which goes onto the request for marketing to see. */
export async function setStopStatus(trip, stopId, { status, note }, user) {
  if (trip.status !== 'left') throw ApiError.conflict(trip.status === 'completed' ? `${trip.number} is already completed` : `${trip.number} has not left yet`);
  const stop = trip.stops.id(stopId);
  if (!stop) throw ApiError.notFound('That stop is not on this trip');
  const text = String(note || '').trim();
  if (status === 'not_delivered' && text.length < 3) throw ApiError.badRequest('Say why it was not delivered');
  Object.assign(stop, { status, note: text || undefined, at: new Date() });
  if (status === 'not_delivered') {
    await Todo.updateOne(
      { _id: stop.task },
      { $push: { updates: { note: `Not delivered on ${trip.number}: ${text}`, by: user._id, at: new Date() } } },
      { keepVersion: true }
    );
  }
  await trip.save();
  return trip;
}

/**
 * Telling each buyer on the trip — "planned for dispatch on Tuesday" before it goes, "on the way"
 * once it has left — on WhatsApp from the company number, logged as a customer message either way.
 * Once per kind of news unless `force`: a buyer told twice that the lorry left starts to wonder
 * which lorry.
 */
export async function tellBuyers(trip, { force = false } = {}, user) {
  const kind = ['left', 'completed'].includes(trip.status) ? 'left' : 'planned';
  if (trip.status === 'cancelled') throw ApiError.conflict(`${trip.number} is cancelled — there is nothing to tell the buyers`);
  if (trip.notified?.[kind] && !force) throw ApiError.conflict(`The buyers were already told ${kind === 'left' ? 'it is on the way' : 'the plan'} — ${trip.notified[kind].toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}. Send again only if something changed.`, { needs: 'force' });
  await trip.populate([{ path: 'vehicle' }, { path: 'transporter' }]);

  const results = [];
  const stopsByCustomer = new Map();
  for (const stop of trip.stops) {
    if (!stop.customer) continue;
    const key = String(stop.customer);
    stopsByCustomer.set(key, [...(stopsByCustomer.get(key) || []), stop]);
  }
  for (const [customerId, stops] of stopsByCustomer) {
    const customer = await Customer.findById(customerId).select('name mobile whatsapp notifications').lean();
    const enquiries = await Enquiry.find({ _id: { $in: stops.map((stop) => stop.enquiry).filter(Boolean) } }).select('number').lean();
    const what = [enquiries.map((row) => row.number).join(', '), stops.reduce((sum, stop) => sum + (stop.quantity || 0), 0) && `${stops.reduce((sum, stop) => sum + (stop.quantity || 0), 0).toLocaleString('en-IN')} pcs`]
      .filter(Boolean).join(' · ') || 'your order';
    const how = kind === 'left'
      ? `It has left today by ${goesBy(trip)}${trip.driverName ? `. Driver: ${trip.driverName}${trip.driverPhone ? `, ${trip.driverPhone}` : ''}` : ''}.`
      : `It is planned for dispatch on ${new Date(`${trip.date}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}${trip.departAt ? `, ${trip.departAt}` : ''}, by ${goesBy(trip)}.`;
    const body = `Dear ${customer?.name || 'Sir/Madam'}, ${kind === 'left' ? 'your goods are on the way' : 'an update on your dispatch'} — ${what}. ${how}`;
    const base = { customer: customerId, enquiry: stops[0].enquiry, event: `trip_${kind}`, channel: 'whatsapp', body, sentBy: user._id };
    const phone = normalisePhone(customer?.whatsapp || customer?.mobile || '');
    if (customer?.notifications?.whatsapp === false) {
      results.push(await CustomerMessage.create({ ...base, status: 'skipped', skipReason: 'opted_out' }));
    } else if (!phone) {
      results.push(await CustomerMessage.create({ ...base, status: 'skipped', skipReason: 'no_address' }));
    } else if (!isWhatsAppConfigured()) {
      if (isProduction) {
        results.push(await CustomerMessage.create({ ...base, recipient: phone, status: 'skipped', skipReason: 'no_provider' }));
      } else {
        console.log(`\n[whatsapp] to ${phone}\n${body}\n`);
        results.push(await CustomerMessage.create({ ...base, recipient: phone, status: 'sent', providerStatus: 'logged' }));
      }
    } else {
      try {
        const template = whatsappTemplate('trip');
        const sent = await sendWhatsApp({ to: phone, body, ...(template ? { template, variables: { 1: customer?.name || '', 2: what, 3: how } } : {}) });
        results.push(await CustomerMessage.create({ ...base, recipient: phone, status: 'sent', providerId: sent.id, providerStatus: sent.status, usedTemplate: Boolean(template) }));
      } catch (error) {
        results.push(await CustomerMessage.create({ ...base, recipient: phone, status: 'failed', error: error.message }));
      }
    }
  }
  await Trip.updateOne({ _id: trip._id }, { $set: { [`notified.${kind}`]: new Date() } }, { keepVersion: true });
  return {
    kind,
    sent: results.filter((row) => row.status === 'sent').length,
    skipped: results.filter((row) => row.status === 'skipped').map((row) => ({ customer: row.customer, reason: row.skipReason })),
    failed: results.filter((row) => row.status === 'failed').length,
  };
}

const TRIP_POPULATE = [
  { path: 'vehicle' },
  { path: 'transporter' },
  { path: 'stops.customer', select: 'name mobile whatsapp address area landmark city pincode' },
  { path: 'stops.enquiry', select: 'number' },
  { path: 'stops.task', select: 'status completed title' },
  { path: 'createdBy', select: 'name' },
];
export const populateTrip = (trip) => trip.populate(TRIP_POPULATE);

export async function listTrips({ from, to, status } = {}) {
  const filter = {};
  if (from || to) filter.date = { ...(from ? { $gte: from } : {}), ...(to ? { $lte: to } : {}) };
  if (status) filter.status = { $in: String(status).split(',') };
  return Trip.find(filter).sort({ date: 1, createdAt: 1 }).limit(200).populate(TRIP_POPULATE);
}

/** The ids of every request on an open trip — the planner leaves these out of its groups. */
export async function requestsOnTrips() {
  const trips = await Trip.find({ status: { $in: OPEN_TRIP_STATUSES } }).select('stops.task').lean();
  return new Set(trips.flatMap((trip) => trip.stops.map((stop) => String(stop.task))));
}

/** The trip sheet the driver carries: the stops in order, who to ask for, what to hand over, a place to sign. */
export async function renderTripSheet(trip) {
  await populateTrip(trip);
  return render((doc) => {
    const MARGIN = 42;
    const WIDTH = 595.28 - MARGIN * 2;
    letterhead(doc, 'Trip sheet', trip.number);
    facts(doc, [
      ['Date', new Date(`${trip.date}T12:00:00+05:30`).toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })],
      ['Leaves at', trip.departAt],
      ['Goes by', goesBy(trip)],
      ['Booking office', trip.mode === 'transport' ? trip.transporter?.bookingOffice : null],
      ['Driver', [trip.driverName, trip.driverPhone].filter(Boolean).join(' · ')],
      ['Stops', `${trip.stops.length} · ${trip.stops.reduce((sum, stop) => sum + (stop.cartons || 0), 0) || '—'} cartons`],
      ['Note', trip.note],
    ]);
    doc.moveDown(0.4);
    const cols = [{ w: 22, t: '#' }, { w: 230, t: 'Buyer and address' }, { w: 95, t: 'Goods' }, { w: 50, t: 'Cartons' }, { w: WIDTH - 397, t: 'Received by / sign' }];
    const header = () => {
      let x = MARGIN;
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111111');
      const y = doc.y;
      for (const col of cols) { doc.text(col.t, x, y, { width: col.w - 4 }); x += col.w; }
      doc.moveDown(0.3);
      doc.moveTo(MARGIN, doc.y).lineTo(MARGIN + WIDTH, doc.y).strokeColor('#999999').lineWidth(0.6).stroke();
      doc.moveDown(0.3);
    };
    header();
    trip.stops.forEach((stop, index) => {
      const customer = stop.customer || {};
      const address = [customer.address, customer.area, customer.landmark && `near ${customer.landmark}`, customer.city, customer.pincode].filter(Boolean).join(', ');
      const buyer = [customer.name || 'Buyer', address, customer.whatsapp || customer.mobile].filter(Boolean).join('\n');
      const goods = [stop.enquiry?.number, stop.model, stop.quantity && `${stop.quantity.toLocaleString('en-IN')} pcs`].filter(Boolean).join('\n');
      doc.font('Helvetica').fontSize(8.5);
      const height = Math.max(doc.heightOfString(buyer, { width: cols[1].w - 4 }), doc.heightOfString(goods, { width: cols[2].w - 4 }), 30) + 8;
      if (doc.y + height > 800) { doc.addPage(); header(); }
      const y = doc.y;
      let x = MARGIN;
      const cells = [String(index + 1), buyer, goods, stop.cartons ? String(stop.cartons) : '', ''];
      cells.forEach((cell, i) => { doc.fillColor('#111111').text(cell, x, y, { width: cols[i].w - 4 }); x += cols[i].w; });
      doc.y = y + height;
      doc.moveTo(MARGIN, doc.y - 3).lineTo(MARGIN + WIDTH, doc.y - 3).strokeColor('#DDDDDD').lineWidth(0.5).stroke();
    });
    doc.moveDown(1.5);
    doc.font('Helvetica').fontSize(9).fillColor('#111111')
      .text('Loaded by: ______________________        Driver: ______________________        Time out: __________', MARGIN, doc.y, { width: WIDTH });
    footer(doc);
  });
}
