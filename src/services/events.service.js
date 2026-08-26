import { EventEmitter } from 'node:events';

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
};

export function publish(event, payload) {
  try {
    bus.emit(event, payload);
  } catch (error) {
    console.error(`[events] publishing ${event} failed:`, error);
  }
}

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
