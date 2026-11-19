import BuyerCard from '../models/BuyerCard.js';
import Todo from '../models/Todo.js';
import { isManagement } from '../utils/departments.js';
import { mayReadTaskQueries } from './taskQuery.service.js';

/**
 * The screenshots an enquiry was made from — the WhatsApp chat, the email, the visiting card —
 * kept with the enquiry for good [models/BuyerCard.js holds the pictures]. They are shown on the
 * enquiry, and on any task the person raising it chose to forward them to [Todo `shotsForwarded`],
 * so the department sees what the buyer actually sent.
 */

const idOf = (value) => String(value?._id ?? value ?? '');

/** The draft the enquiry was saved from, when it was made from a picture. */
export const sourceCardOf = (enquiryId) => (enquiryId
  ? BuyerCard.findOne({ enquiry: idOf(enquiryId) }).sort({ createdAt: 1 })
  : null);

/** What there is to show: one entry per picture, the first and then the later screenshots of a long chat. */
export function shotsOf(card) {
  if (!card) return null;
  const images = [
    { n: 0, at: card.createdAt },
    ...(card.moreImages || []).map((image, at) => ({ n: at + 1, at: image.at })),
  ];
  return { kind: card.kind || 'card', images: images.length, list: images, at: card.createdAt, caption: card.caption || undefined };
}

/** One picture of the card: 0 the first, 1, 2… the later ones. */
export function imageOf(card, n) {
  const at = Number(n) || 0;
  return at === 0 ? card : card.moreImages?.[at - 1];
}

/**
 * May this person see the enquiry's screenshots? Its marketing person and Admin; anyone else —
 * another department, another salesperson — only through a task they work that they were
 * forwarded to, so forwarding is what decides who sees what the buyer sent.
 */
export async function mayViewEnquiryShots(user, enquiry) {
  if (isManagement(user) || (enquiry.assignedTo && idOf(enquiry.assignedTo) === idOf(user._id))) return true;
  const forwarded = await Todo.find({ enquiry: enquiry._id, shotsForwarded: true }).select('user department createdBy fromDepartment enquiry').limit(50);
  for (const task of forwarded) {
    // eslint-disable-next-line no-await-in-loop
    if (await mayReadTaskQueries(task, user)) return true;
  }
  return false;
}

/**
 * Forward the enquiry's screenshots to a task — on the form that raises it, or later from the
 * task. Nothing is set when the enquiry was not made from a picture. Returns whether it was.
 */
export async function forwardShotsTo(task, { card } = {}) {
  if (!task?._id || !task.enquiry) return false;
  const source = card || (await sourceCardOf(task.enquiry));
  if (!source) return false;
  if (!task.shotsForwarded) {
    await Todo.updateOne({ _id: task._id }, { $set: { shotsForwarded: true } });
    task.shotsForwarded = true;
  }
  return true;
}
