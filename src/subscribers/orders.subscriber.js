import { unsubscribe } from '../services/events.service.js';

/**
 * The enquiry module's outbound edge into order confirmation [BLUEPRINT §C.1].
 *
 * A won enquiry is a sales order waiting to be raised. That used to raise "Raise the sales
 * order" for every person on the order team. It is now the enquiry itself: winning it moves it
 * to PO & SO, where it is Sales / SO's task until they move it on [subscribers/handoff.subscriber.js
 * `STATUS_MOVES`]. A second copy here would be the same job on the queue twice — so nothing is
 * subscribed, and this stays as the place that says where the handover went.
 */

let registered = [];

export function registerOrderSubscribers() {
  for (const [event, listener] of registered) unsubscribe(event, listener);
  registered = [];
}
