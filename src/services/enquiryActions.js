/**
 * What you can actually *do* to an enquiry, as a list of named actions.
 *
 * The screen used to offer a stage dropdown of twelve and a free-text box. Both are the wrong
 * question. "Move to sample_required" is a database word, not a thing a marketing person does;
 * what they do is *raise a sample request*. And the free-text next action meant the same
 * intention was typed a hundred different ways — "chase sample", "follow up sampling", "ask
 * bench" — none of which any screen or report could group, count or act on.
 *
 * So the enquiry now takes actions. Each one names the work, moves the stage that work implies,
 * and writes its own next action, which is the part that matters: the automation behind these
 * stages already existed — moving to `sample_required` has always raised the sample request and
 * `pricing_required` has always queued the costing — it was just buried under a dropdown nobody
 * would find it in. This is that machinery given a front door.
 *
 * **`needs` is the whole contract with the screen.** Each action declares what it cannot be
 * done without, so the form asks for exactly that and nothing else — rather than showing every
 * field on every move and letting the server refuse afterwards.
 *
 * **`nextAction` is written, not typed.** The action already says what happens next, so the
 * system fills it in and the person edits it only if their case is unusual. That is what turns
 * the field from a hundred spellings into something a follow-up list can group.
 */

/**
 * @typedef {Object} EnquiryAction
 * @property {string} label      What the button says.
 * @property {string} hint       What it will do, in the person's own terms.
 * @property {string} [to]       The stage it moves to. Absent means the stage does not change.
 * @property {string} nextAction The follow-up it writes, unless the person edits it.
 * @property {string} type       The kind of next step, so a list can show a typed chip.
 * @property {number} inDays     When to chase it, if the person does not say.
 * @property {string[]} needs    What the screen must ask for: value, lostReason, holdReason.
 * @property {string} [raises]   The department this hands work to, named for the screen.
 */

export const ENQUIRY_ACTIONS = {
  raise_sample: {
    label: 'Raise a sample request',
    hint: 'Creates the request and puts it on the sample team’s queue',
    to: 'sample_required',
    nextAction: 'Chase the sample with the bench',
    type: 'send_sample',
    inDays: 3,
    needs: [],
    raises: 'the sample team',
  },
  request_pricing: {
    label: 'Ask for a price',
    hint: 'Queues the costing, with the buyer’s target attached',
    to: 'pricing_required',
    nextAction: 'Chase the costing',
    type: 'other',
    inDays: 2,
    needs: [],
    raises: 'whoever prices a job',
  },
  send_quote: {
    label: 'Quote sent',
    hint: 'Records that the price went out, and sets the chase',
    to: 'quote_submitted',
    nextAction: 'Follow up on the quote',
    type: 'send_quote',
    inDays: 3,
    needs: [],
  },
  negotiating: {
    label: 'They are negotiating',
    hint: 'The price is being argued rather than accepted',
    to: 'negotiation',
    nextAction: 'Call about the revised price',
    type: 'call',
    inDays: 2,
    needs: [],
  },
  await_decision: {
    label: 'Waiting on their decision',
    hint: 'Everything is with the buyer; nothing is owed by us',
    to: 'customer_decision_pending',
    nextAction: 'Ask whether a decision has been taken',
    type: 'call',
    inDays: 5,
    needs: [],
  },
  expect_po: {
    label: 'A PO is promised',
    hint: 'They have said yes; the paperwork is coming',
    to: 'po_expected',
    nextAction: 'Collect the purchase order',
    type: 'call',
    inDays: 3,
    needs: [],
  },
  clarify: {
    label: 'Clarify the requirement',
    hint: 'Something about what they want is not yet pinned down',
    to: 'requirement_clarification',
    nextAction: 'Confirm the specification with the buyer',
    type: 'call',
    inDays: 2,
    needs: [],
  },
  confirm_order: {
    label: 'Order confirmed',
    hint: 'Wins the enquiry and hands it to order confirmation',
    to: 'won',
    nextAction: null, // Winning clears the follow-up: there is nothing left to chase.
    type: null,
    inDays: null,
    needs: ['value'],
    raises: 'order confirmation',
  },
  mark_lost: {
    label: 'Lost',
    hint: 'Closes it, and cancels any sample still on the bench',
    to: 'lost',
    nextAction: null,
    type: null,
    inDays: null,
    needs: ['lostReason'],
  },
  hold: {
    label: 'Put it on hold',
    hint: 'Parks it until something outside our control changes',
    to: 'hold',
    nextAction: 'Check whether it can move again',
    type: 'call',
    inDays: 14,
    needs: ['holdReason'],
  },
  /**
   * The one action that changes no stage.
   *
   * Most days nothing moves — the buyer has not called back, the sample is still on the bench —
   * and the honest record of that is a next action with a new date, not a stage that pretends
   * something happened. Without it people move the stage to record having chased, which is how
   * a funnel stops meaning anything.
   */
  follow_up: {
    label: 'Just set a follow-up',
    hint: 'Nothing has moved; say when to come back to it',
    to: null,
    nextAction: 'Follow up',
    type: 'call',
    inDays: 3,
    needs: ['nextAction'],
  },
};

export const ENQUIRY_ACTION_KEYS = Object.keys(ENQUIRY_ACTIONS);

/** The kinds of next step an enquiry can carry, for the model's enum. */
export const ENQUIRY_NEXT_ACTION_TYPES = [
  'call',
  'whatsapp',
  'email',
  'meeting',
  'visit',
  'send_quote',
  'send_sample',
  'other',
];

/**
 * Which actions make sense from where the enquiry is now.
 *
 * Deliberately permissive about order: a repeat buyer needs no sample, and a rigid graph would
 * have people fighting the tool to record what actually happened. What it does refuse is the
 * action that cannot mean anything from here — moving to the stage it is already at, and
 * anything at all on a closed enquiry, which reopens through its own door.
 */
export function actionsFrom(status) {
  const closed = ['won', 'lost'].includes(status);
  if (closed) return [];

  return ENQUIRY_ACTION_KEYS.filter((key) => ENQUIRY_ACTIONS[key].to !== status);
}
