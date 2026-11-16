/**
 * How an enquiry ended, as Admin records it when closing one whose statuses were never kept up
 * [services/enquiryClosure.service.js] — THE LIST TO EDIT.
 *
 *   status   the sales status it leaves the enquiry at: `won` (an order was taken), `lost`
 *            (it was cancelled) or none (left as it is)
 *   marketing  the Current Marketing Status it leaves [config/marketingStatuses.js] — the plant's
 *            word for where the order was, or Task Closed
 *   asks     what the form asks beside the note: `date` (when it happened), `reference` (the
 *            invoice, LR or order number), `lostReason` (why it was cancelled)
 */
export const CLOSE_OUTCOMES = [
  { key: 'order_completed', label: 'Order completed', hint: 'Goods delivered and nothing pending', status: 'won', marketing: 'task_closed', asks: ['date', 'reference'], dateLabel: 'Completed on' },
  { key: 'dispatched', label: 'Dispatched', hint: 'The goods have been sent', status: 'won', marketing: 'dispatch', asks: ['date', 'reference'], dateLabel: 'Dispatched on' },
  { key: 'in_production', label: 'Order in production', hint: 'The order was taken and is being made — followed outside the app', status: 'won', marketing: 'production', asks: ['date', 'reference'], dateLabel: 'Order taken on' },
  { key: 'cancelled_after_quote', label: 'Cancelled after quotation', hint: 'A quotation was given; the buyer did not order', status: 'lost', marketing: 'task_closed', asks: ['date', 'lostReason'], dateLabel: 'Cancelled on', defaultLostReason: 'price' },
  { key: 'cancelled', label: 'Enquiry cancelled', hint: 'Dropped before any quotation', status: 'lost', marketing: 'task_closed', asks: ['date', 'lostReason'], dateLabel: 'Cancelled on', defaultLostReason: 'requirement_dropped' },
  { key: 'other', label: 'Other', hint: 'Say what happened in the note', status: null, asks: ['date'], dateLabel: 'On', noteRequired: true },
];

export const CLOSE_OUTCOME_KEYS = CLOSE_OUTCOMES.map((entry) => entry.key);
export const findCloseOutcome = (key) => CLOSE_OUTCOMES.find((entry) => entry.key === key) || null;
