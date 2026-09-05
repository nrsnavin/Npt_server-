import { CLOSED_ORDER_STATUSES, PRE_RELEASE_STATUSES } from '../models/SalesOrder.js';

/**
 * What you can actually *do* to a sales order, as a list of named actions.
 *
 * The same argument as `enquiryActions.js`, and it applies harder here. §12's ladder is
 * fourteen statuses long, and "move to `approved_for_production`" is a database word — what a
 * person does is *release it to production*, which is a decision with a gate in front of it.
 * A dropdown of fourteen would let somebody step straight from `po_received` to
 * `fully_dispatched` with nothing made and nothing shipped, and the screen would have no way
 * to say why that is wrong.
 *
 * **`needs` is the whole contract with the screen**, exactly as on an enquiry: each action
 * declares what it cannot be done without, so the form asks for that and nothing else rather
 * than showing every field on every move and letting the server refuse afterwards.
 *
 * **`gate` is what this file adds.** An action may name a precondition the order has to satisfy
 * before it is even offered — `release` needs §13's eight checks — so the screen can draw it
 * disabled with the reason, instead of presenting a button that always fails.
 */

/**
 * @typedef {Object} OrderAction
 * @property {string}   label   What the button says.
 * @property {string}   hint    What it will do, in the person's own terms.
 * @property {string}   [to]    The status it moves to. Absent means the status does not change.
 * @property {string[]} needs   What the screen must ask for.
 * @property {string}   [gate]  A precondition — currently only `verified`.
 * @property {string}   [raises] The department this hands the work to, named for the screen.
 * @property {string}   [from]  Restricts where it may be done from. Absent means anywhere open.
 */
export const ORDER_ACTIONS = {
  start_verification: {
    label: 'Start verification',
    hint: 'Begins the eight checks §13 requires before anything is released',
    to: 'order_verification',
    needs: [],
    from: ['po_received', 'clarification_pending'],
  },

  raise_clarification: {
    label: 'Something needs clarifying',
    hint: 'Parks the order until the buyer or the plant answers',
    to: 'clarification_pending',
    needs: ['clarificationNote'],
    from: ['po_received', 'order_verification'],
  },

  /**
   * The gate [§13].
   *
   * Deliberately the only way into `approved_for_production`. Everything downstream — the
   * plant's queue, the reservation, the dispatch — assumes an order it is working on passed
   * these eight checks, and an order that reached production down some other route would carry
   * that assumption without having earned it.
   */
  release: {
    label: 'Release to production',
    hint: 'Hands the order to the plant. Needs all eight checks [§13]',
    to: 'approved_for_production',
    needs: [],
    gate: 'verified',
    from: PRE_RELEASE_STATUSES,
    raises: 'production',
  },

  cancel: {
    label: 'Cancel the order',
    hint: 'The buyer withdrew it, or it is being re-cut as another order',
    to: 'cancelled',
    needs: ['cancellationReason'],
  },

  close: {
    label: 'Close it',
    hint: 'Everything dispatched and paid — nothing left to do',
    to: 'closed',
    needs: [],
    from: ['fully_dispatched', 'payment_pending'],
  },
};

export const ORDER_ACTION_KEYS = Object.keys(ORDER_ACTIONS);

/**
 * Which actions make sense from where the order is now.
 *
 * Permissive about order in the same way enquiries are — a repeat job for a customer who has
 * bought the same model for years still goes through verification, but which of the eight get
 * ticked first is nobody's business but the checker's. What it refuses is the action that
 * cannot mean anything from here: the status it is already at, anything at all on a closed
 * order, and anything whose `from` list does not include the current status.
 *
 * Note that `release` is *listed* even when the checks are outstanding, carrying its gate. A
 * screen that hides it until the last box is ticked hides the thing the person is working
 * towards; one that shows it greyed with "still needs three checks" tells them where they are.
 */
export function orderActionsFrom(status) {
  if (CLOSED_ORDER_STATUSES.includes(status)) return [];

  return ORDER_ACTION_KEYS.filter((key) => {
    const action = ORDER_ACTIONS[key];
    if (action.to === status) return false;
    if (action.from && !action.from.includes(status)) return false;
    return true;
  });
}
