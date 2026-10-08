import User from '../models/User.js';
import { EVENTS, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { raiseTask, resolveTasks } from '../services/task.service.js';
import { ensureCostingFor } from '../services/costingRequest.service.js';

/**
 * The enquiry module's edge into pricing, and pricing's edge back [BLUEPRINT §5, §9, §41.8].
 *
 * When only the task existed this file was the whole handover: Phase 3 had not been built, and
 * the argument for building the edge first was that the far side would otherwise be built
 * against traffic that never arrived. Phase 3 is here now, and the shape held — the task is
 * still what tells a person to go and do it, and the costing record is what they do it on.
 *
 *   Enquiry → pricing required   ⇒ raise the costing, queue whoever prices a job
 *   Costing → below the floor    ⇒ management is asked to sign it off [§9]
 *   Costing → approved           ⇒ marketing is told they may quote
 *   Costing → refused            ⇒ it goes back to whoever built it
 */

/**
 * A listener, named so the outbox can tell which listeners of an event have already succeeded,
 * and loud when it fails — the failure is logged here and handed back so the event is retried.
 */
const safely = (name, handler) => {
  const listener = async (payload) => {
    try {
      await handler(payload);
    } catch (error) {
      console.error(`[pricing] ${name} failed:`, error);
      throw error;
    }
  };
  listener.handoverName = `pricing:${name}`;
  return listener;
};

let registered = [];

export function registerPricingSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];

  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  /** One stable key per handover, so the same instruction cannot queue twice. */
  const key = (id, kind) => `pricing:${id}:${kind}`;

  subscribe(
    EVENTS.ENQUIRY_PRICING_REQUIRED,
    safely('costing request', async ({ enquiry }) => {
      /*
       * The costing record. Who prices it is no longer a task per person: the enquiry itself
       * moves to Quotation and is that department's task [subscribers/handoff.subscriber.js].
       */
      await ensureCostingFor(enquiry);
    })
  );

  /**
   * §9's approval queue.
   *
   * A price under the floor is the one thing in this module that cannot wait for somebody to
   * notice it: until it is signed off no quote can go out, so the enquiry behind it is simply
   * stopped. Management is told rather than left to find it on a list.
   */
  subscribe(
    EVENTS.PRICING_APPROVAL_REQUIRED,
    safely('below-minimum approval', async ({ pricing }) => {
      const approvers = await User.find({
        isActive: { $ne: false },
        $or: [{ role: 'admin' }, { department: 'management' }],
      }).select('_id');

      await Promise.all(
        approvers.map((member) =>
          raiseTask({
            user: member._id,
            title: `Approve the price on ${pricing.number}`,
            notes: 'It is below the approved minimum, so nothing can be quoted until it is signed off.',
            priority: 'high',
            link: `/pricings/${pricing._id}`,
            originKey: key(pricing._id, 'approval'),
          })
        )
      );
    })
  );

  subscribe(
    EVENTS.PRICING_APPROVED,
    safely('tell marketing they may quote', async ({ pricing }) => {
      await resolveTasks(key(pricing._id, 'approval'));
      if (pricing.enquiry) await resolveTasks(`enquiry:${pricing.enquiry}:pricing`);
      if (!pricing.requestedBy) return;

      await raiseTask({
        user: pricing.requestedBy,
        title: `Price ready on ${pricing.number}`,
        notes: 'The costing is approved — the quotation can go out.',
        priority: 'high',
        link: `/pricings/${pricing._id}`,
        originKey: key(pricing._id, 'ready'),
      });
    })
  );

  subscribe(
    EVENTS.PRICING_REJECTED,
    safely('send it back', async ({ pricing }) => {
      await resolveTasks(key(pricing._id, 'approval'));
      if (!pricing.costedBy) return;

      await raiseTask({
        user: pricing.costedBy,
        title: `Price refused on ${pricing.number}`,
        notes: pricing.rejectionNote || 'Rebuild the costing and send it back for approval.',
        priority: 'high',
        link: `/pricings/${pricing._id}`,
        originKey: key(pricing._id, 'refused'),
      });
    })
  );
}
