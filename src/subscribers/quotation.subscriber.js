import Enquiry from '../models/Enquiry.js';
import { EVENTS, publish, statusEvent, subscribe as busSubscribe, unsubscribe } from '../services/events.service.js';
import { raiseTask, resolveTasks } from '../services/task.service.js';

/**
 * The quotation module's edge back into the enquiry [BLUEPRINT §C.1, §10].
 *
 *   Quotation sent      ⇒ the enquiry moves to Quote submitted, and the chase is set
 *   Quotation accepted  ⇒ the enquiry moves to PO expected
 *   Quotation rejected  ⇒ marketing is told; whether the enquiry is lost is their call
 *
 * The last one is the important restraint. A refused quote is very often re-priced rather than
 * abandoned — that is what a revision is for — so closing the enquiry here would take the
 * decision away from the only person who has spoken to the buyer.
 */

const safely = (name, handler) => async (payload) => {
  try {
    await handler(payload);
  } catch (error) {
    console.error(`[quotation] ${name} failed:`, error);
  }
};

const key = (quotation, kind) => `quotation:${quotation._id}:${kind}`;

/**
 * Moves the enquiry without going through the controller's guards, the same way the sampling
 * subscriber does and for the same reasons — see that file. It publishes the same events, so a
 * department downstream cannot tell whether a person or an automation moved it.
 *
 * The next action is left alone: the enquiry already carries whatever marketing last set, and
 * blanking it would break the §3 rule the enquiry module enforces on write.
 */
async function advanceEnquiry(enquiryId, to, note) {
  if (!enquiryId) return null;

  const enquiry = await Enquiry.findById(enquiryId);
  if (!enquiry || enquiry.status === to) return null;
  // A closed enquiry is finished; a late quotation update must not reopen it.
  if (['won', 'lost'].includes(enquiry.status)) return null;

  const from = enquiry.status;
  enquiry.status = to;
  enquiry.statusHistory.push({ from, to, note });
  await enquiry.save();

  publish(EVENTS.ENQUIRY_STATUS_CHANGED, { enquiry, from, to });
  const specific = statusEvent(to);
  if (specific) publish(specific, { enquiry, from });

  return enquiry;
}

let registered = [];

export function registerQuotationSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];

  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  subscribe(
    EVENTS.QUOTATION_SENT,
    safely('quote submitted', async ({ quotation }) => {
      await advanceEnquiry(
        quotation.enquiry,
        'quote_submitted',
        `${quotation.number} rev ${quotation.revision} sent`
      );

      await raiseTask({
        user: quotation.assignedTo,
        title: `Follow up on ${quotation.number}`,
        notes: `Rev ${quotation.revision} at ₹${quotation.unitPrice} went out. Ask what they think.`,
        dueDate: quotation.validUntil,
        priority: 'normal',
        link: `/quotations/${quotation._id}`,
        originKey: key(quotation, 'follow-up'),
      });
    })
  );

  subscribe(
    EVENTS.QUOTATION_ACCEPTED,
    safely('quote accepted', async ({ quotation }) => {
      await resolveTasks(key(quotation, 'follow-up'));
      await advanceEnquiry(quotation.enquiry, 'po_expected', `${quotation.number} accepted`);

      await raiseTask({
        user: quotation.assignedTo,
        title: `Collect the PO for ${quotation.number}`,
        notes: 'The price is agreed — get the purchase order in writing.',
        priority: 'high',
        link: `/quotations/${quotation._id}`,
        originKey: key(quotation, 'po'),
      });
    })
  );

  subscribe(
    EVENTS.QUOTATION_REJECTED,
    safely('quote refused', async ({ quotation }) => {
      await resolveTasks(key(quotation, 'follow-up'));

      /*
       * Deliberately does not close the enquiry. A refused quote is usually re-priced rather
       * than abandoned, and whether this is lost is marketing's call — they are the only ones
       * who have spoken to the buyer.
       */
      await raiseTask({
        user: quotation.assignedTo,
        title: `${quotation.number} was refused`,
        notes: quotation.rejectionNote
          ? `${quotation.rejectionNote} — revise the price or close the enquiry.`
          : 'Revise the price or close the enquiry.',
        priority: 'high',
        link: `/quotations/${quotation._id}`,
        originKey: key(quotation, 'refused'),
      });
    })
  );
}
