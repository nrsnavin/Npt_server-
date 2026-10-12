import Todo from '../models/Todo.js';
import Customer, { DELIVERY_MODES } from '../models/Customer.js';
import SalesOrder from '../models/SalesOrder.js';
import Transporter from '../models/Transporter.js';
import DeliveryRoute from '../models/DeliveryRoute.js';
import { findHandoff } from '../config/handoffs.js';
import { paymentStanding } from './paymentGates.service.js';
import { setTaskStatus } from './handoff.service.js';
import { listTrips, requestsOnTrips } from './trip.service.js';
import Vehicle from '../models/Vehicle.js';
import ApiError from '../utils/ApiError.js';
import { km, nearestOrder } from '../utils/geo.js';
import { latestQcByEnquiry } from './records.service.js';

/**
 * Planning tomorrow's dispatch: the open dispatch requests, put into groups that can go together
 * [web: components/TripPlanner.jsx]. The app suggests; the person at the desk confirms.
 *
 * It thinks in the order the desk does:
 *
 *   1. Only what can go. A request whose goods are not ready (Dispatch said so, or Production has
 *      not said Ready for Dispatch after being asked) waits in "Not ready yet"; one whose order
 *      still owes the money due before dispatch waits in "Waiting for payment".
 *   2. How it travels — from the request's own Booking / Collection answer, else the buyer's
 *      usual way: our vehicle, a transport booking, the party collecting, or a courier.
 *   3. Then together: transport bookings by transporter (one drop at its booking office); our own
 *      deliveries by route, then landmark (spelling-tolerant), then area, then PIN, then town.
 *   4. Most urgent first, by the schedule asked for: Top Most Urgent, Today, Today Evening,
 *      Tomorrow First, Tomorrow.
 *
 * Every group says in plain words why it is a group — "Same transporter: KPN, Tiruppur office" —
 * so nobody has to trust a box they cannot read.
 */

export { DELIVERY_MODES };
export const MODE_LABELS = {
  own_vehicle: 'Our vehicle',
  transport: 'Transport booking',
  party_collects: 'Party collects',
  courier: 'Courier',
};

/* The Booking / Collection answer on the request [config/departmentTaskForms.js invoice_dispatch]. */
const MODE_FROM_BOOKING = {
  'Normal Booking': 'transport',
  'Book Before 4 PM': 'transport',
  'Book Before 7 PM': 'transport',
  'Party Will Collect': 'party_collects',
  'Local Delivery': 'own_vehicle',
};

/* The schedules, most urgent first; a request with none comes after all of them. */
const SCHEDULE_ORDER = ['Top Most Urgent Dispatch', 'Today Dispatch', 'Today Evening Dispatch', 'Tomorrow First Dispatch', 'Tomorrow Dispatch'];
const scheduleKey = (label) => label.toLowerCase().replace(/[^a-z]+/g, '_');
const RANK_BY_KEY = Object.fromEntries(SCHEDULE_ORDER.map((label, index) => [scheduleKey(label), index]));
export const SCHEDULE_STATUSES = SCHEDULE_ORDER.map((label) => ({ key: scheduleKey(label), label }));

/* What Production or Assembly says when the goods are ready to go. */
const PLANT_KINDS = ['ask_edd', 'ask_assembling_edd'];
const PLANT_READY = new Set(['ready_dispatch', 'completed', 'full_ready', 'closed']);

/**
 * One spelling for a landmark, however it was typed: "Kumar Nagar Bus Stand", "kumarnagar bus
 * stop" and "Near Kumar Nagar bus-stop." are one place to a driver, and now to the planner.
 */
export function landmarkKey(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(near|nr|opp|opposite|behind|beside|next to|front of|in front of)\b/g, ' ')
    .replace(/\bbus stand\b|\bbusstand\b|\bbus stop\b|\bbusstop\b/g, 'busstop')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\s+/g, '');
}

const plain = (text) => String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');

/** The most common way a group's members spelt it, for its label. */
function commonest(values) {
  const counts = new Map();
  for (const value of values.filter(Boolean)) counts.set(value.trim(), (counts.get(value.trim()) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

const addressOf = (customer) =>
  [customer?.address, customer?.area, customer?.landmark && `near ${customer.landmark}`, customer?.city, customer?.pincode].filter(Boolean).join(', ');

/** Where a request stands on readiness and money, and why — before anything is grouped. */
async function laneOf(task, { plantByEnquiry, ordersByEnquiry, statusLabel }) {
  if (task.status === 'not_ready') return { lane: 'not_ready', why: 'Dispatch marked it Goods Not Yet Ready' };
  const plant = plantByEnquiry.get(String(task.enquiry?._id || task.enquiry || ''));
  if (task.status === 'asked_production' && plant && !PLANT_READY.has(plant.status)) {
    return { lane: 'not_ready', why: `Asked Production — ${plant.label || 'no answer yet'}` };
  }
  for (const order of ordersByEnquiry.get(String(task.enquiry?._id || task.enquiry || '')) || []) {
    const standing = await paymentStanding(order);
    if (!standing.dispatch.met && !standing.dispatch.waived) {
      return { lane: 'waiting_payment', why: `${order.number} still owes ₹${Math.round(standing.dispatch.short).toLocaleString('en-IN')} before dispatch` };
    }
  }
  return { lane: 'ready', why: statusLabel(task.status) };
}

function modeOf(task, customer) {
  const fromBooking = MODE_FROM_BOOKING[task.brief?.booking];
  if (fromBooking) return { mode: fromBooking, from: 'request' };
  if (customer?.deliveryMode) return { mode: customer.deliveryMode, from: 'customer' };
  if (customer?.usualTransporter) return { mode: 'transport', from: 'customer' };
  return { mode: 'own_vehicle', from: 'guess' };
}

/** The group a ready request belongs in, with the reason in words. */
function groupOf(mode, customer, { transporters, routes }) {
  if (mode === 'party_collects') return { key: 'collect', by: 'collect', label: 'Party collects at the gate', reason: 'The buyer is collecting — no vehicle needed' };
  if (mode === 'courier') return { key: 'courier', by: 'courier', label: 'Courier pickup', reason: 'All going by courier — one pickup' };
  if (mode === 'transport') {
    const transporter = customer?.usualTransporter && transporters.get(String(customer.usualTransporter));
    if (transporter) {
      const label = `${transporter.name}${transporter.bookingOffice ? ` · ${transporter.bookingOffice}` : ''}`;
      return { key: `transporter:${transporter._id}`, by: 'transporter', label, reason: `Same transporter: ${label}` };
    }
    return { key: 'transporter:none', by: 'none', label: 'Transport — transporter not set', reason: 'Set the usual transporter on these buyers so they can be grouped' };
  }
  const route = customer?.deliveryRoute && routes.get(String(customer.deliveryRoute));
  if (route) return { key: `route:${route._id}`, by: 'route', label: route.name, reason: `Same delivery route: ${route.name}` };
  const city = plain(customer?.city);
  if (customer?.landmark && landmarkKey(customer.landmark)) {
    return { key: `landmark:${landmarkKey(customer.landmark)}|${city}`, by: 'landmark', label: null, reason: 'Same landmark' };
  }
  if (customer?.area) return { key: `area:${plain(customer.area)}|${city}`, by: 'area', label: `${customer.area}${customer.city ? `, ${customer.city}` : ''}`, reason: `Same area: ${customer.area}` };
  if (customer?.pincode) return { key: `pin:${plain(customer.pincode)}`, by: 'pincode', label: `PIN ${customer.pincode}${customer.city ? ` · ${customer.city}` : ''}`, reason: `Same PIN: ${customer.pincode}` };
  if (customer?.city) return { key: `city:${city}`, by: 'city', label: customer.city, reason: `Same town: ${customer.city}` };
  return { key: 'none', by: 'none', label: 'Needs an address', reason: 'Add the area or landmark on these buyers so they can be grouped' };
}

/** Lower is sooner. A late request is treated as Today at the latest. */
function urgencyOf(task) {
  let rank = RANK_BY_KEY[task.status] ?? (task.brief?.schedule ? RANK_BY_KEY[scheduleKey(task.brief.schedule)] : undefined) ?? SCHEDULE_ORDER.length;
  if (task.dueDate && new Date(task.dueDate) < new Date()) rank = Math.min(rank, 1);
  if (task.priority === 'high') rank = Math.min(rank, 1);
  return rank;
}

export async function dispatchPlan() {
  /* A request already on a trip is planned; it shows on its trip, not in a group. */
  const onTrips = await requestsOnTrips();
  const tasks = (await Todo.find({ kind: 'invoice_dispatch', completed: false })
    .select('enquiry customer title brief dueDate priority status user createdAt')
    .populate([{ path: 'enquiry', select: 'number customer' }, { path: 'user', select: 'name' }])
    .sort({ dueDate: 1, createdAt: 1 })
    .lean()).filter((task) => !onTrips.has(String(task._id)));

  const customerIdOf = (task) => String(task.customer || task.enquiry?.customer || '');
  const enquiryIds = [...new Set(tasks.map((task) => String(task.enquiry?._id || '')).filter(Boolean))];
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const [customers, transporters, routes, plantTasks, orders, vehicles, trips] = await Promise.all([
    Customer.find({ _id: { $in: [...new Set(tasks.map(customerIdOf).filter(Boolean))] } })
      .select('name code mobile whatsapp address area landmark city pincode deliveryMode usualTransporter deliveryRoute site.lat site.lng').lean(),
    Transporter.find({}).lean(),
    DeliveryRoute.find({}).lean(),
    Todo.find({ enquiry: { $in: enquiryIds }, kind: { $in: PLANT_KINDS } }).select('enquiry kind status updatedAt').sort({ updatedAt: -1 }).lean(),
    SalesOrder.find({ enquiry: { $in: enquiryIds }, status: { $nin: ['closed', 'cancelled'] } })
      .select('number enquiry totalValue paymentPlan paymentWaivers').lean(),
    Vehicle.find({ active: { $ne: false } }).sort({ number: 1 }).lean(),
    /* Trips still to go or on the road, and those finished today. */
    listTrips({ status: 'planned,loading,left' }).then(async (open) => [...open, ...(await listTrips({ from: today, to: today, status: 'completed' }))]),
  ]);
  /* The latest QC verdict on each enquiry's goods — shown on the stop, never a lock on it. */
  const qcByEnquiry = await latestQcByEnquiry(enquiryIds);
  const byId = (rows) => new Map(rows.map((row) => [String(row._id), row]));
  const customerMap = byId(customers);
  const lists = { transporters: byId(transporters), routes: byId(routes) };

  const plantByEnquiry = new Map();
  for (const task of plantTasks) {
    const key = String(task.enquiry);
    if (plantByEnquiry.has(key)) continue;
    const label = (findHandoff(task.kind)?.form?.statuses || []).find((entry) => entry.key === task.status)?.label;
    plantByEnquiry.set(key, { status: task.status, label });
  }
  const ordersByEnquiry = new Map();
  for (const order of orders) {
    const key = String(order.enquiry);
    ordersByEnquiry.set(key, [...(ordersByEnquiry.get(key) || []), order]);
  }
  const dispatchStatuses = findHandoff('invoice_dispatch')?.form?.statuses || [];
  const statusLabel = (key) => dispatchStatuses.find((entry) => entry.key === key)?.label || key || '';

  const groups = new Map();
  const waiting = { not_ready: [], waiting_payment: [] };
  for (const task of tasks) {
    const customer = customerMap.get(customerIdOf(task));
    const stop = {
      task: task._id,
      enquiry: task.enquiry ? { _id: task.enquiry._id, number: task.enquiry.number } : null,
      customer: customer ? { _id: customer._id, name: customer.name, phone: customer.whatsapp || customer.mobile || null } : null,
      address: addressOf(customer),
      landmark: customer?.landmark || null,
      site: customer?.site?.lat != null ? { lat: customer.site.lat, lng: customer.site.lng } : null,
      model: task.brief?.model || null,
      quantity: Number(task.brief?.quantity) || null,
      schedule: task.brief?.schedule || null,
      booking: task.brief?.booking || null,
      status: task.status,
      statusLabel: statusLabel(task.status),
      due: task.dueDate || null,
      with: task.user?.name || null,
      urgency: urgencyOf(task),
      qc: task.enquiry ? qcByEnquiry.get(String(task.enquiry._id)) || null : null,
    };
    const { lane, why } = await laneOf(task, { plantByEnquiry, ordersByEnquiry, statusLabel });
    if (lane !== 'ready') {
      waiting[lane].push({ ...stop, why });
      continue;
    }
    const { mode, from } = modeOf(task, customer);
    const group = groupOf(mode, customer, lists);
    const key = `${mode}|${group.key}`;
    if (!groups.has(key)) groups.set(key, { key, mode, modeLabel: MODE_LABELS[mode], ...group, stops: [] });
    groups.get(key).stops.push({ ...stop, modeFrom: from });
  }

  const list = [...groups.values()].map((group) => {
    group.stops.sort((a, b) => a.urgency - b.urgency || String(a.due || '9').localeCompare(String(b.due || '9')));
    if (group.by === 'landmark') {
      const spelt = commonest(group.stops.map((stop) => stop.landmark));
      const city = commonest(group.stops.map((stop) => customerMap.get(String(stop.customer?._id))?.city));
      group.label = `Near ${spelt}${city ? `, ${city}` : ''}`;
      group.reason = `Same landmark: ${spelt}`;
    }
    /* Our own vehicle: the pinned stops in the order the vehicle would reach them. */
    if (group.mode === 'own_vehicle' && group.stops.filter((stop) => stop.site).length > 1) {
      group.stops = nearestOrder(group.stops, (stop) => stop.site);
      group.orderedByDistance = true;
    }
    group.urgency = Math.min(...group.stops.map((stop) => stop.urgency));
    group.totals = { stops: group.stops.length, quantity: group.stops.reduce((sum, stop) => sum + (stop.quantity || 0), 0) };
    group.needsDetails = group.by === 'none';
    return group;
  });
  /*
   * Near enough to share a vehicle: another of our own groups with a pinned buyer within
   * NEARBY_KM of one of this group's. Said on the group, so the desk can put the two on one trip.
   */
  const NEARBY_KM = 3;
  const own = list.filter((group) => group.mode === 'own_vehicle' && group.stops.some((stop) => stop.site));
  for (const group of own) {
    group.nearby = own
      .filter((other) => other !== group)
      .map((other) => {
        let closest = null;
        for (const a of group.stops) for (const b of other.stops) {
          const d = km(a.site, b.site);
          if (d != null && (closest == null || d < closest)) closest = d;
        }
        return closest != null && closest <= NEARBY_KM ? { key: other.key, label: other.label, km: Math.round(closest * 10) / 10 } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.km - b.km);
  }
  const MODE_ORDER = { transport: 0, own_vehicle: 1, courier: 2, party_collects: 3 };
  list.sort((a, b) =>
    a.needsDetails - b.needsDetails || a.urgency - b.urgency || MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
    b.totals.stops - a.totals.stops || a.label.localeCompare(b.label));

  /* The data the grouping stands on: of the buyers waiting, how many it can place without guessing. */
  const waitingCustomers = [...new Set(tasks.map(customerIdOf).filter(Boolean))].map((id) => customerMap.get(id)).filter(Boolean);
  const placed = waitingCustomers.filter((customer) => customer.deliveryRoute || customer.usualTransporter || customer.landmark || customer.area).length;

  const ready = list.reduce((sum, group) => sum + group.stops.length, 0);
  return {
    groups: list,
    notReady: waiting.not_ready.sort((a, b) => a.urgency - b.urgency),
    waitingPayment: waiting.waiting_payment.sort((a, b) => a.urgency - b.urgency),
    counts: {
      ready,
      notReady: waiting.not_ready.length,
      waitingPayment: waiting.waiting_payment.length,
      needsDetails: list.filter((group) => group.needsDetails).reduce((sum, group) => sum + group.stops.length, 0),
    },
    coverage: { customers: waitingCustomers.length, placed, pinned: waitingCustomers.filter((customer) => customer.site?.lat != null).length },
    schedules: SCHEDULE_STATUSES,
    transporters: transporters.filter((row) => row.active !== false).map(({ _id, name, bookingOffice }) => ({ _id, name, bookingOffice })),
    routes: routes.filter((row) => row.active !== false).map(({ _id, name, areas, days }) => ({ _id, name, areas, days })),
    vehicles: vehicles.map(({ _id, number, kind, capacityCartons, driverName, driverPhone }) => ({ _id, number, kind, capacityCartons, driverName, driverPhone })),
    trips: trips.map(tripSummary),
    today,
  };
}

/** A trip as the planner's lane shows it. */
export function tripSummary(trip) {
  const cartons = trip.stops.reduce((sum, stop) => sum + (stop.cartons || 0), 0);
  const capacity = trip.vehicle?.capacityCartons || null;
  return {
    _id: trip._id,
    number: trip.number,
    date: trip.date,
    departAt: trip.departAt || null,
    mode: trip.mode,
    modeLabel: MODE_LABELS[trip.mode],
    status: trip.status,
    goesBy: trip.mode === 'transport'
      ? [trip.transporter?.name, trip.transporter?.bookingOffice].filter(Boolean).join(' · ')
      : trip.mode === 'own_vehicle' ? [trip.vehicle?.number, trip.vehicle?.kind].filter(Boolean).join(' · ') || 'Our vehicle' : MODE_LABELS[trip.mode],
    driver: [trip.driverName, trip.driverPhone].filter(Boolean).join(' · ') || null,
    stops: trip.stops.length,
    delivered: trip.stops.filter((stop) => stop.status === 'delivered').length,
    buyers: trip.stops.map((stop) => stop.customer?.name).filter(Boolean),
    cartons,
    capacity,
    over: Boolean(capacity && cartons > capacity),
  };
}

/**
 * One schedule for a whole group: "all of these go Tomorrow". Each request moves through its own
 * status door, with the remark, so each one's marketing person and Admin are told as they would be
 * for a move made by hand — and in one transaction, so the group moves together or not at all.
 */
export async function scheduleGroup({ tasks: ids, status, note }, user) {
  if (!SCHEDULE_STATUSES.some((entry) => entry.key === status)) throw ApiError.badRequest('Pick one of the dispatch schedules');
  const unique = [...new Set(ids.map(String))];
  const tasks = await Todo.find({ _id: { $in: unique }, kind: 'invoice_dispatch' });
  if (tasks.length !== unique.length) throw ApiError.notFound('One of those dispatch requests is no longer open — reload the plan');
  const label = SCHEDULE_STATUSES.find((entry) => entry.key === status).label;
  const remark = String(note || '').trim() || `${label} — planned together on the dispatch plan`;
  const moved = [];
  for (const task of tasks) moved.push(await setTaskStatus(task, user, { status, note: remark }));
  return { moved: moved.length, status, label };
}

/**
 * How a set of buyers' goods travel — usual way, transporter, route, area, landmark — set from the
 * planner in one go. Only those fields: the delivery facts are the dispatch desk's to keep; the
 * rest of the buyer's record stays with marketing.
 */
export async function setCustomerDelivery({ customers: ids, ...fields }) {
  const unique = [...new Set(ids.map(String))];
  const set = {};
  const unset = {};
  if (fields.deliveryMode !== undefined) (fields.deliveryMode ? (set.deliveryMode = fields.deliveryMode) : (unset.deliveryMode = 1));
  if (fields.usualTransporter !== undefined) {
    if (fields.usualTransporter && !(await Transporter.exists({ _id: fields.usualTransporter }))) throw ApiError.badRequest('That transporter is not on the list');
    fields.usualTransporter ? (set.usualTransporter = fields.usualTransporter) : (unset.usualTransporter = 1);
  }
  if (fields.deliveryRoute !== undefined) {
    if (fields.deliveryRoute && !(await DeliveryRoute.exists({ _id: fields.deliveryRoute }))) throw ApiError.badRequest('That route is not on the list');
    fields.deliveryRoute ? (set.deliveryRoute = fields.deliveryRoute) : (unset.deliveryRoute = 1);
  }
  for (const key of ['area', 'landmark', 'pincode']) {
    if (fields[key] !== undefined) (String(fields[key]).trim() ? (set[key] = String(fields[key]).trim()) : (unset[key] = 1));
  }
  if (!Object.keys(set).length && !Object.keys(unset).length) throw ApiError.badRequest('Nothing to change');
  const found = await Customer.countDocuments({ _id: { $in: unique } });
  if (found !== unique.length) throw ApiError.notFound('One of those buyers was not found');
  const result = await Customer.updateMany(
    { _id: { $in: unique } },
    { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }
  );
  return { updated: result.modifiedCount };
}

/**
 * Suggested trips for a day — the planner's groups made into a draft of trips in one press, for
 * the desk to look over, untick and confirm [web: components/SuggestTrips.jsx]. Nothing is saved.
 *
 *   transport bookings  one trip per transporter (one drop at its booking office)
 *   courier, collection one each
 *   our own deliveries  one per group, most urgent first, each given a vehicle in turn — the
 *                       biggest first — and a second run when there are more groups than vehicles
 *
 * Groups still missing delivery details are left out: what the trip would be is the question.
 */
export async function suggestTrips() {
  const plan = await dispatchPlan();
  const vehicles = [...plan.vehicles].sort((a, b) => (b.capacityCartons || 0) - (a.capacityCartons || 0));
  const transporters = new Map(plan.transporters.map((row) => [String(row._id), row]));
  const ready = plan.groups.filter((group) => !group.needsDetails);
  const own = ready.filter((group) => group.mode === 'own_vehicle');
  const trips = [];
  for (const group of ready.filter((entry) => entry.mode !== 'own_vehicle')) {
    const transporterId = group.mode === 'transport' ? group.key.split('transporter:')[1] : null;
    const transporter = transporterId && transporters.get(transporterId);
    trips.push({
      key: group.key, mode: group.mode, modeLabel: group.modeLabel, label: group.label, reason: group.reason,
      transporter: transporter ? { _id: transporter._id, name: transporter.name, bookingOffice: transporter.bookingOffice } : null,
      vehicle: null, run: 1, urgency: group.urgency, stops: group.stops,
    });
  }
  own.forEach((group, index) => {
    const vehicle = vehicles.length ? vehicles[index % vehicles.length] : null;
    trips.push({
      key: group.key, mode: 'own_vehicle', modeLabel: group.modeLabel, label: group.label, reason: group.reason,
      transporter: null, vehicle, run: vehicles.length ? Math.floor(index / vehicles.length) + 1 : 1, urgency: group.urgency, stops: group.stops,
    });
  });
  trips.sort((a, b) => a.urgency - b.urgency || a.run - b.run);
  return {
    trips,
    leftOut: plan.groups.filter((group) => group.needsDetails).reduce((sum, group) => sum + group.stops.length, 0),
    vehicles: plan.vehicles,
    transporters: plan.transporters,
  };
}
