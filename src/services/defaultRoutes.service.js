import DeliveryRoute from '../models/DeliveryRoute.js';
import Customer from '../models/Customer.js';

/**
 * The roads out of Tiruppur the plant's vehicle runs, as delivery routes [models/DeliveryRoute.js]
 * — the customer form's Delivery route drop-down. Added once at start where missing (by name,
 * whatever its case), never renamed or re-activated; Dispatch adds and retires routes on its own
 * screen. A customer whose landmark was one of these roads (the old route drop-down on Landmark)
 * gets that route as its delivery route, where it has none.
 */
export const DEFAULT_ROUTES = [
  'Kangeyam Road', 'Uthukuli Road', 'Dharapuram Road', 'Palladam Road',
  'College Road', 'Mangalam Road', 'PN Road', 'Avinashi Road',
];

const sameName = (name) => ({ name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });

export async function ensureDefaultRoutes() {
  let added = 0;
  let linked = 0;
  for (const name of DEFAULT_ROUTES) {
    let route = await DeliveryRoute.findOne(sameName(name));
    if (!route) {
      route = await DeliveryRoute.create({ name });
      added += 1;
    }
    const moved = await Customer.updateMany(
      { ...{ landmark: sameName(name).name }, $or: [{ deliveryRoute: { $exists: false } }, { deliveryRoute: null }] },
      { $set: { deliveryRoute: route._id } },
      { timestamps: false },
    );
    linked += moved.modifiedCount || 0;
  }
  return { added, linked };
}

/** The active routes, for the customer form's drop-down — name only. */
export const activeRoutes = () => DeliveryRoute.find({ active: { $ne: false } }).select('name areas').sort({ name: 1 }).lean();
