/**
 * How marketing reached the buyer about an enquiry [role requirements §2: "Log calls, WhatsApp
 * messages, emails, visits and meetings against the enquiry"].
 *
 * THE LIST TO EDIT. Add or rename here; the enquiry screen and the Activities page read it from
 * the server. A key already stored on a logged activity should be kept (renaming its label is
 * fine), so old entries still read correctly.
 */
export const ENQUIRY_ACTIVITY_TYPES = [
  { key: 'call', label: 'Call' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'email', label: 'Email' },
  { key: 'visit', label: 'Visit' },
  { key: 'meeting', label: 'Meeting' },
];

export const ENQUIRY_ACTIVITY_KEYS = ENQUIRY_ACTIVITY_TYPES.map((type) => type.key);
