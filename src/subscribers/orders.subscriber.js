import User from '../models/User.js';
import { EVENTS, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { raiseTask } from '../services/task.service.js';

/**
 * The enquiry module's outbound edge into order confirmation [BLUEPRINT §C.1].
 *
 * A won enquiry is a sales order waiting to be raised, and until now nothing at all happened
 * when one was won: `ENQUIRY_WON` was published and nobody was listening. The enquiry went
 * green on a dashboard and the order got raised because somebody remembered — which is the
 * exact failure §C.1 exists to prevent, and the one place in the chain where forgetting costs
 * a confirmed order rather than a follow-up.
 *
 * The sales order module itself is Phase 3 and does not exist. The handover does, and that is
 * the point: the same argument the pricing subscriber makes. Until Phase 3 lands the task is
 * what order confirmation has; after it lands the task is still what tells a person to go and
 * raise the order. Building only the far side later would mean building it against traffic
 * that never arrived, and quietly losing every order won in the meantime.
 */

const safely = (name, handler) => async (payload) => {
  try {
    await handler(payload);
  } catch (error) {
    console.error(`[orders] ${name} failed:`, error);
  }
};

/**
 * Who raises a sales order.
 *
 * Read off the grant rather than the department, like the sample and costing queues: giving a
 * marketing person `orders: write` puts them in this queue without anything here changing.
 */
async function orderTeam() {
  const holders = await User.find({
    isActive: { $ne: false },
    moduleAccess: { $elemMatch: { module: 'orders', level: 'write' } },
  }).select('_id');

  if (holders.length) return holders;

  // Nobody holds it yet, so the instruction would land nowhere. Admins are the fallback, not
  // the default — the same rule the other two queues follow.
  return User.find({ isActive: { $ne: false }, role: 'admin' }).select('_id');
}

let registered = [];

export function registerOrderSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];

  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  subscribe(
    EVENTS.ENQUIRY_WON,
    safely('sales order request', async ({ enquiry }) => {
      const team = await orderTeam();
      const requirement = enquiry.requirement || {};

      await Promise.all(
        team.map((member) =>
          raiseTask({
            user: member._id,
            title: `Raise the sales order for ${enquiry.number}`,
            notes:
              `${requirement.modelNumber || 'New development'} · ${requirement.quantity ?? '?'} pc` +
              `${enquiry.estimatedValue ? ` · ₹${enquiry.estimatedValue} confirmed` : ''}`,
            dueDate: enquiry.requiredDeliveryDate,
            priority: 'high',
            link: `/enquiries/${enquiry._id}`,
            /*
             * One per enquiry. A won enquiry that is reopened and won again is the same order,
             * not a second one — and a queue with two identical instructions in it is a queue
             * somebody raises two orders from.
             */
            originKey: `enquiry:${enquiry._id}:sales-order`,
          })
        )
      );
    })
  );
}
