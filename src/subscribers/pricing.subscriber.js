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
 *   Enquiry → pricing required   ⇒ raise the quotation for costing
 *   A price under its minimum    ⇒ Admin is asked to sign it off [§9]
 *   Every line priced, cleared   ⇒ the owner is told it can go out
 *   A price refused              ⇒ it goes back to whoever costed it
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
  /* A price under its minimum: Admin is asked to sign it off [§9]. */
  subscribe(
    EVENTS.PRICING_APPROVAL_REQUIRED,
    safely('below-minimum approval', async ({ quotation }) => {
      if (!quotation) return;
      const approvers = await User.find({
        isActive: { $ne: false },
        $or: [{ role: 'admin' }, { department: 'management' }],
      }).select('_id');

      const waiting = (quotation.lines || []).filter((line) => line.status === 'approval_pending');
      await Promise.all(
        approvers.map((member) =>
          raiseTask({
            user: member._id,
            title: `Approve the price on ${quotation.number}`,
            notes: `${waiting.map((line) => line.modelNumber).filter(Boolean).join(', ') || 'A line'} is below the approved minimum, so it cannot be sent until it is signed off.`,
            priority: 'high',
            link: `/quotations/${quotation._id}`,
            originKey: key(quotation._id, 'approval'),
          })
        )
      );
    })
  );

  /* Every line priced and cleared: whoever owns the buyer may send it. */
  subscribe(
    EVENTS.PRICING_APPROVED,
    safely('tell marketing they may send', async ({ quotation }) => {
      if (!quotation) return;
      await resolveTasks(key(quotation._id, 'approval'));
      if (quotation.enquiry) await resolveTasks(`enquiry:${quotation.enquiry}:pricing`);
      const to = quotation.assignedTo || quotation.requestedBy;
      if (!to) return;

      await raiseTask({
        user: to,
        title: `Price ready on ${quotation.number}`,
        notes: 'Every line is priced and cleared — the quotation can go out.',
        priority: 'high',
        link: `/quotations/${quotation._id}`,
        originKey: key(quotation._id, 'ready'),
      });
    })
  );

  /* A price Admin refused goes back to whoever costed it. */
  subscribe(
    EVENTS.PRICING_REJECTED,
    safely('send it back', async ({ quotation, lineId }) => {
      if (!quotation) return;
      await resolveTasks(key(quotation._id, 'approval'));
      if (!quotation.costedBy) return;
      const line = (quotation.lines || []).find((row) => String(row._id) === String(lineId));

      await raiseTask({
        user: quotation.costedBy,
        title: `Price refused on ${quotation.number}${line?.modelNumber ? ` — ${line.modelNumber}` : ''}`,
        notes: line?.rejectionNote || 'Change the price and it goes back for approval.',
        priority: 'high',
        link: `/quotations/${quotation._id}`,
        originKey: key(quotation._id, `refused:${lineId}`),
      });
    })
  );
}
