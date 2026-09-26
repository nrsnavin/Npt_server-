import { EventEmitter } from 'node:events';
import { afterCommit, currentTransaction } from '../utils/transaction.js';
import Outbox from '../models/Outbox.js';
import { deliver, recoverOutbox, serialize } from './outbox.service.js';

/**
 * Domain events.
 *
 * The blueprint's core principle is that completing a stage creates the next department's
 * task automatically [§C.1]. Those downstream modules do not exist yet, so the enquiry
 * publishes what happened and nothing listens. When sampling lands in Phase 2 it subscribes
 * to `enquiry.sample_required` and creates its request; pricing subscribes in Phase 3.
 *
 * Publishing now costs nothing and means the enquiry module never has to be reopened to
 * bolt automation on.
 */
const bus = new EventEmitter();

// Automation is a background concern: a listener that throws must not fail the request
// that triggered it, and must be loud enough to notice.
bus.on('error', (error) => console.error('[events] listener failed:', error));

export const EVENTS = {
  LEAD_CONVERTED: 'lead.converted',
  ENQUIRY_CREATED: 'enquiry.created',
  ENQUIRY_STATUS_CHANGED: 'enquiry.status_changed',
  /** Phase 2 — sampling creates a sample request from this. */
  ENQUIRY_SAMPLE_REQUIRED: 'enquiry.sample_required',
  /** Phase 3 — pricing creates a costing request from this. */
  ENQUIRY_PRICING_REQUIRED: 'enquiry.pricing_required',
  ENQUIRY_WON: 'enquiry.won',
  ENQUIRY_LOST: 'enquiry.lost',

  /** Phase 3 — pricing and quoting [§7, §9, §10]. */
  PRICING_REQUESTED: 'pricing.requested',
  /** The sheet is built and the price is at or above the floor: marketing may quote it. */
  PRICING_APPROVED: 'pricing.approved',
  /** Below the floor [§9]: nothing may be quoted until somebody signs it off. */
  PRICING_APPROVAL_REQUIRED: 'pricing.approval_required',
  PRICING_REJECTED: 'pricing.rejected',

  QUOTATION_CREATED: 'quotation.created',
  QUOTATION_SENT: 'quotation.sent',
  QUOTATION_APPROVAL_REQUIRED: 'quotation.approval_required',
  QUOTATION_ACCEPTED: 'quotation.accepted',
  QUOTATION_REJECTED: 'quotation.rejected',

  SAMPLE_CREATED: 'sample.created',
  SAMPLE_STATUS_CHANGED: 'sample.status_changed',
  /** Marketing is told the moment the sample is ready to go out [§6]. */
  SAMPLE_READY: 'sample.ready',
  /** Moves the enquiry to sample feedback pending [§6]. */
  SAMPLE_DISPATCHED: 'sample.dispatched',
  SAMPLE_APPROVED: 'sample.approved',
  SAMPLE_MODIFICATION_REQUIRED: 'sample.modification_required',
  SAMPLE_REJECTED: 'sample.rejected',
};

/**
 * Publishing an event.
 *
 * The event is written to the outbox first — inside the transaction when there is one, so it
 * exists exactly when the change that caused it does — and then handed to its listeners at once,
 * with the documents it was published with. If a listener fails, or the process dies before they
 * finish, the row stays pending and `recoverEvents` delivers it again. So a handover is never
 * lost to a restart, and never delivered for a change that was rolled back.
 *
 * Awaited by callers: inside a transaction the row has to be written before the commit.
 */
export async function publish(event, payload = {}) {
  const listeners = bus.listeners(event);
  if (!listeners.length) return;

  let row = null;
  try {
    [row] = await Outbox.create([{ event, payload: serialize(payload) }]);
  } catch (error) {
    /* Better delivered from memory than not at all; the log says it was not written down. */
    console.error(`[events] could not record ${event}, delivering from memory only:`, error.message);
  }

  const run = () => {
    if (row) {
      deliver(row, payload, bus.listeners(event)).catch((error) =>
        console.error(`[events] delivering ${event} failed:`, error.message));
    } else {
      for (const listener of bus.listeners(event)) {
        Promise.resolve().then(() => listener(payload)).catch(() => {});
      }
    }
  };

  if (currentTransaction()?.real) afterCommit(run);
  else run();
}

/** Delivers again whatever is still pending — run by the background sweep on one process. */
export const recoverEvents = (options = {}) => recoverOutbox({ ...options, listenersFor: (event) => bus.listeners(event) });

export const subscribe = (event, listener) => bus.on(event, listener);
export const unsubscribe = (event, listener) => bus.off(event, listener);

/** Test helper: drop every listener so suites do not leak into each other. */
export const clearListeners = () => bus.removeAllListeners();

/** Maps an enquiry status onto the event that status raises, if any. */
export const statusEvent = (status) =>
  ({
    sample_required: EVENTS.ENQUIRY_SAMPLE_REQUIRED,
    pricing_required: EVENTS.ENQUIRY_PRICING_REQUIRED,
    won: EVENTS.ENQUIRY_WON,
    lost: EVENTS.ENQUIRY_LOST,
  })[status] || null;

/** The same, for a sample status [§6]. */
export const sampleStatusEvent = (status) =>
  ({
    sample_ready: EVENTS.SAMPLE_READY,
    dispatched: EVENTS.SAMPLE_DISPATCHED,
    approved: EVENTS.SAMPLE_APPROVED,
    modification_required: EVENTS.SAMPLE_MODIFICATION_REQUIRED,
    rejected: EVENTS.SAMPLE_REJECTED,
  })[status] || null;
