/**
 * How Accounts records a payment call [role requirements §10: "Record payment status, including
 * TPCF. Maintain commitment date, callback date, promised payment date and next follow-up date"].
 *
 * THE LIST TO EDIT. Rename a status, add one or drop one here; the payment screen reads this list
 * from the server, so nothing else changes. A key already stored on a follow-up should be kept
 * (renaming its label is fine), so old calls still read correctly.
 */
export const FOLLOW_UP_STATUSES = [
  { key: 'no_answer', label: 'Called — no answer' },
  { key: 'callback', label: 'Asked us to call back' },
  { key: 'promised', label: 'Promised to pay' },
  /* The plant's own term, kept as it is written in the requirements. */
  { key: 'tpcf', label: 'TPCF' },
  { key: 'payment_sent', label: 'Says payment is sent' },
  { key: 'part_paid', label: 'Part paid' },
  { key: 'disputed', label: 'Disputes the invoice' },
  { key: 'other', label: 'Other' },
];

export const FOLLOW_UP_STATUS_KEYS = FOLLOW_UP_STATUSES.map((status) => status.key);

/** How the buyer was reached. */
export const FOLLOW_UP_MODES = ['call', 'whatsapp', 'email', 'visit'];
