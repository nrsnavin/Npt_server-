import User from '../models/User.js';
import { EVENTS, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { raiseTask } from '../services/task.service.js';

/**
 * The enquiry module's outbound edge into pricing [BLUEPRINT §5, §41.8].
 *
 * The pricing module itself is Phase 3 and does not exist. The handover does, and it is the
 * governing principle rather than a feature of that module [§C.1]: completing a stage
 * creates the next department's task, so the chain must not depend on someone remembering to
 * mention it. Until Phase 3 lands the task is what pricing has; after it lands the task is
 * still what tells a person to go and do it.
 *
 * Building only the far side later would also mean building it against traffic that never
 * arrived, and quietly losing every enquiry that reached pricing in the meantime.
 */

const safely = (name, handler) => async (payload) => {
  try {
    await handler(payload);
  } catch (error) {
    console.error(`[pricing] ${name} failed:`, error);
  }
};

/**
 * Who prices a job.
 *
 * This organisation has no costing team, so `pricing: write` sits with management [§7]. The
 * grant is read rather than the department, so granting a marketing person pricing rights
 * puts them in the queue without anything here changing.
 */
async function costingTeam() {
  const holders = await User.find({
    isActive: { $ne: false },
    moduleAccess: { $elemMatch: { module: 'pricing', level: 'write' } },
  }).select('_id');

  if (holders.length) return holders;

  // Nobody holds it, so the request would land nowhere. Admins are the fallback, not the
  // default — the same rule the sample queue follows.
  return User.find({ isActive: { $ne: false }, role: 'admin' }).select('_id');
}

let registered = [];

export function registerPricingSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];

  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  subscribe(
    EVENTS.ENQUIRY_PRICING_REQUIRED,
    safely('costing request', async ({ enquiry }) => {
      const team = await costingTeam();
      const requirement = enquiry.requirement || {};

      await Promise.all(
        team.map((member) =>
          raiseTask({
            user: member._id,
            title: `Price ${enquiry.number}`,
            notes:
              `${requirement.modelNumber || 'New development'} · ${requirement.quantity ?? '?'} pc` +
              `${enquiry.targetPrice ? ` · buyer's target ₹${enquiry.targetPrice}` : ''}`,
            dueDate: enquiry.requiredDeliveryDate,
            priority: 'high',
            link: `/enquiries/${enquiry._id}`,
            // One per enquiry: an enquiry that goes back and forth through pricing must not
            // leave a queue of identical instructions behind it.
            originKey: `enquiry:${enquiry._id}:pricing`,
          })
        )
      );
    })
  );
}
