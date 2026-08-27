import Enquiry from '../models/Enquiry.js';
import Sample, { CLOSED_SAMPLE_STATUSES } from '../models/Sample.js';
import User from '../models/User.js';
import {
  EVENTS, publish, statusEvent, subscribe as busSubscribe, unsubscribe,
} from '../services/events.service.js';
import { createSampleForEnquiry } from '../services/sampling.service.js';
import { raiseTask, resolveTasks } from '../services/task.service.js';
import { AUTOMATIC, notifyCustomer } from '../services/customerMessage.service.js';

/**
 * The automation the blueprint is built around [§C.1, §6]: completing a stage creates the
 * next department's task, rather than someone remembering to.
 *
 *   Enquiry → sample required   ⇒ raise the request, queue it for the sample team
 *   Sample  → sample ready      ⇒ tell the marketing person who asked for it
 *   Sample  → dispatched        ⇒ move the enquiry to sample feedback pending
 *   Sample  → approved          ⇒ move the enquiry to pricing required
 *   Sample  → rejected          ⇒ hand the decision back to marketing
 *
 * Listeners run outside the request that triggered them. A failure here must never fail that
 * request — marketing moving an enquiry is a real thing that happened, and a broken
 * automation is not a reason to refuse it — so each one swallows and logs.
 */

const safely = (name, handler) => async (payload) => {
  try {
    await handler(payload);
  } catch (error) {
    console.error(`[sampling] ${name} failed:`, error);
  }
};

/** One stable key per handover, so the same instruction cannot queue twice. */
const key = (sample, kind) => `sample:${sample._id}:${kind}`;

/**
 * Moves the enquiry without going through the controller's guards.
 *
 * This is automation, not a user action: it never touches the next action, because the
 * enquiry already carries whatever marketing last set, and blanking it would break the §3
 * rule the enquiry module enforces on write.
 *
 * It publishes the same events the controller does, and that is not a detail. An enquiry
 * reaching `pricing_required` because the bench approved a sample is the same handover as
 * marketing moving it there by hand [§C.1] — the department downstream cannot care which
 * route it took. Announcing only the hand-typed one would give Phase 3 a pricing queue that
 * silently omits every enquiry the automation moved, which is most of them.
 */
async function advanceEnquiry(enquiryId, to, note) {
  const enquiry = await Enquiry.findById(enquiryId);
  if (!enquiry || enquiry.status === to) return null;
  // A closed enquiry is finished; a late sample update must not reopen it.
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

/**
 * The sample team's queue.
 *
 * A request is handed to the team rather than to a person: assigning it is the team's own
 * call, and picking a name here would guess at who is free. Everyone holding write on
 * `samples` gets the task, which is how a shared queue behaves when there is no queue view
 * open on someone's screen.
 */
async function sampleTeam() {
  const holders = await User.find({
    isActive: { $ne: false },
    moduleAccess: { $elemMatch: { module: 'samples', level: 'write' } },
  }).select('_id');

  if (holders.length) return holders;

  /*
   * Nobody holds the grant yet, so the request would land nowhere. Admins get it instead —
   * but only as a fallback: being able to do everything is not a reason to be handed the
   * bench's queue every time an enquiry needs a sample.
   */
  return User.find({ isActive: { $ne: false }, role: 'admin' }).select('_id');
}

/**
 * Registration is idempotent: calling it twice replaces the handlers rather than doubling
 * them, so a test that clears the bus between suites can register again without every
 * handover firing twice.
 */
let registered = [];

export function registerSamplingSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];

  const subscribe = (event, listener) => {
    registered.push([event, listener]);
    return busSubscribe(event, listener);
  };

  subscribe(
    EVENTS.ENQUIRY_SAMPLE_REQUIRED,
    safely('sample request', async ({ enquiry }) => {
      // Raising it publishes SAMPLE_CREATED, which is what queues the bench. Doing the
      // queueing there rather than here is the difference between "an enquiry needing a
      // sample tells the bench" and "a sample existing tells the bench" — and only the
      // second is true of a counter request, which nothing else in the system would notice.
      await createSampleForEnquiry(enquiry, {}, { autoCreated: true });
    })
  );

  subscribe(
    EVENTS.SAMPLE_CREATED,
    safely('queue the bench', async ({ sample, enquiry }) => {
      const team = await sampleTeam();
      const origin = enquiry ? `for ${enquiry.number}` : sample.standaloneReason || 'raised by hand';

      await Promise.all(
        team.map((member) =>
          raiseTask({
            user: member._id,
            title: `Prepare sample ${sample.number}`,
            notes: `${sample.modelNumber || 'New development'} · ${sample.quantity} pc · ${origin}`,
            dueDate: sample.requiredDate,
            priority: 'high',
            link: `/samples/${sample._id}`,
            originKey: key(sample, 'prepare'),
          })
        )
      );

      /*
       * Acknowledged back to whoever asked, so raising the request is visibly not a black
       * hole — unless they are on the bench themselves, in which case they already hold the
       * prepare task and a second row telling them about their own work is noise.
       */
      const onTheBench = team.some((member) => String(member._id) === String(sample.requestedBy));
      if (onTheBench) return;

      await raiseTask({
        user: sample.requestedBy,
        title: `Sample ${sample.number} is with the sample team`,
        notes: `${enquiry ? `Raised from ${enquiry.number}. ` : ''}Due ${new Date(sample.requiredDate).toDateString()}.`,
        dueDate: sample.requiredDate,
        priority: 'low',
        link: `/samples/${sample._id}`,
        originKey: key(sample, 'acknowledged'),
      });
    })
  );

  subscribe(
    EVENTS.SAMPLE_READY,
    safely('customer notice', async ({ sample }) => {
      if (AUTOMATIC.has('sample_ready')) {
        await notifyCustomer({ sample, event: 'sample_ready' });
      }
    })
  );

  subscribe(
    EVENTS.SAMPLE_DISPATCHED,
    safely('customer dispatch notice', async ({ sample }) => {
      if (AUTOMATIC.has('sample_dispatched')) {
        await notifyCustomer({ sample, event: 'sample_dispatched' });
      }
    })
  );

  subscribe(
    EVENTS.SAMPLE_READY,
    safely('ready notice', async ({ sample }) => {
      await resolveTasks(key(sample, 'prepare'));
      await raiseTask({
        user: sample.requestedBy,
        title: `Sample ${sample.number} is ready to go out`,
        notes: 'Confirm the courier details with the customer, then dispatch it.',
        priority: 'high',
        link: `/samples/${sample._id}`,
        originKey: key(sample, 'ready'),
      });
    })
  );

  subscribe(
    EVENTS.SAMPLE_DISPATCHED,
    safely('dispatch handover', async ({ sample }) => {
      await resolveTasks(key(sample, 'ready'));
      await advanceEnquiry(
        sample.enquiry,
        'sample_feedback_pending',
        `Sample ${sample.number} dispatched`
      );
      await raiseTask({
        user: sample.requestedBy,
        title: `Chase feedback on sample ${sample.number}`,
        notes: sample.awbNumber ? `Sent by ${sample.courier} · ${sample.awbNumber}` : undefined,
        priority: 'normal',
        link: `/samples/${sample._id}`,
        originKey: key(sample, 'feedback'),
      });
    })
  );

  subscribe(
    EVENTS.SAMPLE_APPROVED,
    safely('approval handover', async ({ sample }) => {
      await resolveTasks(key(sample, 'feedback'));
      // An approved sample is what pricing has been waiting for [§7].
      await advanceEnquiry(sample.enquiry, 'pricing_required', `Sample ${sample.number} approved`);
    })
  );

  subscribe(
    EVENTS.SAMPLE_REJECTED,
    safely('rejection notice', async ({ sample }) => {
      await resolveTasks(key(sample, 'feedback'));
      // Deliberately does not close the enquiry: a rejected sample is often re-tried, and
      // whether the enquiry is lost is marketing's call, not the sample team's.
      await raiseTask({
        user: sample.requestedBy,
        title: `Sample ${sample.number} was rejected`,
        notes: 'Decide whether to re-sample or close the enquiry.',
        priority: 'high',
        link: `/samples/${sample._id}`,
        originKey: key(sample, 'rejected'),
      });
    })
  );

  subscribe(
    EVENTS.ENQUIRY_LOST,
    safely('cancel work behind a lost enquiry', async ({ enquiry }) => {
      /*
       * A lost enquiry's sample is work nobody will buy. Left open it stays on the bench and
       * escalates as overdue forever, which is how an escalation list stops being read.
       *
       * Only losing does this. A won enquiry may still be waiting on a sample the customer
       * asked for, and cancelling that would destroy the record of what was sent.
       */
      const open = await Sample.find({
        enquiry: enquiry._id,
        status: { $nin: CLOSED_SAMPLE_STATUSES },
      });

      for (const sample of open) {
        const from = sample.status;
        sample.status = 'cancelled';
        sample.statusHistory.push({
          from,
          to: 'cancelled',
          note: `${enquiry.number} was lost`,
        });
        await sample.save();

        for (const kind of ['prepare', 'acknowledged', 'ready', 'feedback']) {
          await resolveTasks(key(sample, kind));
        }
      }
    })
  );

  subscribe(
    EVENTS.SAMPLE_MODIFICATION_REQUIRED,
    safely('modification handover', async ({ sample }) => {
      await resolveTasks(key(sample, 'feedback'));
      await raiseTask({
        user: sample.requestedBy,
        title: `Sample ${sample.number} needs modification`,
        notes: sample.feedbackNote || 'Raise the next attempt from this request.',
        priority: 'high',
        link: `/samples/${sample._id}`,
        originKey: key(sample, 'modification'),
      });
    })
  );
}
