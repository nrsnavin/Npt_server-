import {
  CLOSED_DISPATCH_STATUSES,
  GONE_DISPATCH_STATUSES,
  PRE_LOAD_DISPATCH_STATUSES,
} from '../models/Dispatch.js';

/**
 * What you can actually *do* to a consignment, as a list of named actions [BLUEPRINT §18–19].
 *
 * The same argument as `orderActions.js`. §18's ladder is ten statuses long, and a dropdown of
 * ten would let somebody step from "dispatch request received" straight to "delivered" with no
 * invoice, no lorry and no LR number — and the screen would have no way to say why that is
 * wrong.
 *
 * **`gate: 'shippable'` is the one that matters.** §19 promises marketing sees the quantity, the
 * invoice, the LR and the transporter the moment a consignment is dispatched. That promise is
 * only keepable if those exist, so the action that makes it refuses until they do — the same
 * shape as §13's release gate on an order, and for the same reason: a promise the system cannot
 * keep is worse than no promise, because somebody stops checking.
 *
 * Everything before that gate is deliberately loose. Despatch skips steps — a repeat consignment
 * for a regular customer goes from request to loaded in one morning without anybody ticking
 * "packing" — and a ladder that insisted on every rung would be a ladder people work around by
 * leaving the record behind.
 */

/** Everything before the lorry leaves, from which the pre-dispatch steps can be taken. */
const BEFORE_IT_GOES = [...PRE_LOAD_DISPATCH_STATUSES, 'loaded'];

/**
 * @typedef {Object} DispatchAction
 * @property {string}   label   What the button says.
 * @property {string}   hint    What it will do, in the person's own terms.
 * @property {string}   to      The status it moves to.
 * @property {string[]} needs   What it cannot be done without — on the body or already recorded.
 * @property {string}   [gate]  A precondition on the record itself — currently only `shippable`.
 * @property {string[]} [from]  Where it may be done from. Absent means anywhere still open.
 */
export const DISPATCH_ACTIONS = {
  prepare_invoice: {
    label: 'Raise the invoice',
    hint: 'Accounts is cutting the invoice for this load',
    to: 'invoice_preparation',
    needs: [],
    from: PRE_LOAD_DISPATCH_STATUSES,
  },

  start_packing: {
    label: 'Start packing',
    hint: 'The cartons are being made up',
    to: 'packing',
    needs: [],
    from: PRE_LOAD_DISPATCH_STATUSES,
  },

  await_vehicle: {
    label: 'Waiting for a vehicle',
    hint: 'Packed, and the transporter has not sent a lorry yet',
    to: 'vehicle_pending',
    needs: [],
    from: PRE_LOAD_DISPATCH_STATUSES,
  },

  ready_to_load: {
    label: 'Ready to load',
    hint: 'Cartons at the gate, waiting on the lorry',
    to: 'ready_to_load',
    needs: [],
    from: PRE_LOAD_DISPATCH_STATUSES,
  },

  load: {
    label: 'Loaded',
    hint: 'On the lorry. The load can no longer be changed',
    to: 'loaded',
    /* The vehicle number, because "which lorry" is the first thing asked when one goes missing. */
    needs: ['vehicleNumber'],
    from: PRE_LOAD_DISPATCH_STATUSES,
  },

  /**
   * The moment §19 is about.
   *
   * Gated on the paperwork, and the only action that is. Everything downstream — what marketing
   * tells the buyer, what accounts invoices against, what the payment module will one day chase
   * — assumes a dispatched consignment has an invoice number against it, and one that arrived
   * at `dispatched` down some other route would carry that assumption without having earned it.
   */
  dispatch: {
    label: 'Dispatched',
    hint: 'It has left. Marketing sees the invoice, LR and transporter immediately [§19]',
    to: 'dispatched',
    needs: [],
    gate: 'shippable',
    /*
     * Reachable from anywhere before it has gone, including straight from the request. A repeat
     * consignment for a regular customer is raised and loaded the same afternoon, and a ladder
     * that made somebody tick four intermediate rungs first would be a ladder they work around
     * by ticking them all at once afterwards — which records a sequence that never happened.
     * The gate below is what actually protects this transition.
     */
    from: BEFORE_IT_GOES,
    raises: 'marketing',
  },

  deliver: {
    label: 'Delivered',
    hint: 'The customer has it',
    to: 'delivered',
    needs: [],
    from: ['dispatched', 'pod_pending'],
  },

  await_pod: {
    label: 'Waiting on the POD',
    hint: 'Delivered, and the signed copy has not come back',
    to: 'pod_pending',
    needs: [],
    from: ['dispatched', 'delivered'],
  },

  close: {
    label: 'Close it',
    hint: 'Delivered and the proof is on file — nothing left to do',
    to: 'closed',
    needs: [],
    from: ['delivered', 'pod_pending'],
  },

  /**
   * Cancelling, which is what puts reserved pieces back on the floor.
   *
   * Only before it goes. A consignment that has left cannot be un-sent, and letting somebody
   * cancel one would silently return stock to the available figure that is physically on a
   * lorry halfway to Bangalore. A load that went out wrong is corrected by a return, which is
   * a document this module does not have yet and should not pretend to.
   */
  cancel: {
    label: 'Cancel this consignment',
    hint: 'Puts the pieces it was holding back on the floor',
    to: 'cancelled',
    needs: ['cancellationReason'],
    from: BEFORE_IT_GOES,
  },
};

export const DISPATCH_ACTION_KEYS = Object.keys(DISPATCH_ACTIONS);

/**
 * Which actions make sense from where the consignment is now.
 *
 * Permissive in the same way an order's are: the forward steps are all reachable from anywhere
 * before the load, so despatch can skip the rungs they do not use and go back a step when an
 * invoice has to be redone. What it refuses is what cannot mean anything from here — the status
 * it is already at, anything at all once it is closed or cancelled, and anything reaching
 * backwards across the moment the goods left.
 *
 * `dispatch` is *listed* even when the paperwork is short, carrying its gate, for the reason
 * `release` is listed on an unverified order: hiding the button hides the thing the person is
 * working towards, and showing it greyed with "still needs an invoice number" tells them where
 * they are.
 */
export function dispatchActionsFrom(status) {
  if (CLOSED_DISPATCH_STATUSES.includes(status)) return [];

  return DISPATCH_ACTION_KEYS.filter((key) => {
    const action = DISPATCH_ACTIONS[key];
    if (action.to === status) return false;
    if (action.from && !action.from.includes(status)) return false;
    /* Nothing reaches back across the gate: once it has gone, the pre-dispatch rungs are history. */
    if (GONE_DISPATCH_STATUSES.includes(status) && PRE_LOAD_DISPATCH_STATUSES.includes(action.to)) {
      return false;
    }
    return true;
  });
}
