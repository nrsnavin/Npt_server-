import Customer from '../models/Customer.js';
import { normalisePhone } from '../utils/phone.js';
import { catalogue, shortlist, trigramLikeness } from './modelCatalogue.service.js';
import { ownershipFilter, ownsRecord } from './ownership.service.js';

/**
 * What a draft enquiry may already be on the master as, offered beside the draft to pick with
 * one tap [web: BuyerCards `CardEditor`]: the customers the buyer could be, and for each model
 * the buyer named, the master models it could mean.
 *
 * Suggestions only — nothing is chosen for the salesperson, and saving still goes through every
 * check on the confirm [buyerCard.service `confirmCard`].
 */

/** Words that say what kind of company it is, not which one. */
const LEGAL = new Set([
  'pvt', 'private', 'ltd', 'limited', 'llp', 'and', 'the', 'co', 'company', 'inc', 'india', 'ms',
  'sri', 'shri', 'sree', 'new', 'enterprises', 'enterprise', 'industries', 'traders',
]);

const nameWords = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
  .filter((word) => word.length >= 3 && !LEGAL.has(word));
const nameKey = (name) => nameWords(name).join('');
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MOST_CUSTOMERS = 4;

/**
 * Customers the draft could be. The same phone or email is the buyer for certain, and is said
 * even when the customer is another salesperson's — so they ask rather than add the buyer twice
 * (the save refuses a duplicate anyway). A name that is only alike is offered from the person's
 * own customers alone: it is a guess, and another's list is not theirs to browse.
 */
export async function customerSuggestions({ company, mobile, whatsapp, email, city } = {}, user) {
  const found = new Map();
  const add = (customer, score, why) => {
    const id = String(customer._id);
    const had = found.get(id);
    if (!had || had.score < score) found.set(id, { customer, score, why });
  };
  const fields = 'code name city mobile whatsapp email assignedTo';

  const phones = [normalisePhone(mobile), normalisePhone(whatsapp)].filter(Boolean);
  const mail = String(email || '').trim().toLowerCase();
  const contact = [
    ...phones.flatMap((phone) => [{ mobile: phone }, { whatsapp: phone }, { 'contacts.mobile': phone }, { 'contacts.whatsapp': phone }]),
    ...(mail ? [{ email: mail }, { 'contacts.email': mail }] : []),
  ];
  if (contact.length) {
    const same = await Customer.find({ $or: contact }).select(`${fields} contacts`).populate('assignedTo', 'name').limit(5).lean();
    for (const customer of same) {
      const numbers = [customer.mobile, customer.whatsapp, ...(customer.contacts || []).flatMap((c) => [c.mobile, c.whatsapp])];
      const samePhone = phones.some((phone) => numbers.includes(phone));
      add(customer, 100, samePhone ? 'Same phone number' : 'Same email');
    }
  }

  const words = nameWords(company);
  if (words.length) {
    /* Each word by its first letters, so "Garment" finds "Garments" and "Murugan" "Murugans". */
    const near = await Customer.find({
      ...ownershipFilter(user),
      $or: words.slice(0, 5).map((word) => ({ name: { $regex: escape(word.slice(0, Math.max(4, word.length - 2))), $options: 'i' } })),
    }).select(fields).populate('assignedTo', 'name').limit(200).lean();
    const key = nameKey(company);
    const town = String(city || '').trim().toLowerCase();
    for (const customer of near) {
      const theirs = nameWords(customer.name);
      const shared = words.filter((word) => theirs.some((other) => other.startsWith(word.slice(0, 4)) && word.startsWith(other.slice(0, 4)))).length;
      const alike = Math.max(trigramLikeness(key, nameKey(customer.name)), (0.9 * shared) / Math.max(words.length, theirs.length));
      const sameTown = town && String(customer.city || '').trim().toLowerCase() === town;
      const score = Math.round(alike * 100) + (sameTown ? 10 : 0);
      if (score >= 45) add(customer, Math.min(score, 99), sameTown ? 'Similar name, same city' : 'Similar name');
    }
  }

  return [...found.values()]
    .sort((a, b) => b.score - a.score || a.customer.name.localeCompare(b.customer.name))
    .slice(0, MOST_CUSTOMERS)
    .map(({ customer, score, why }) => {
      const mayUse = ownsRecord(user, customer);
      return {
        _id: customer._id, code: customer.code, name: customer.name, city: customer.city || undefined, score, why, mayUse,
        ...(mayUse ? {} : { holder: customer.assignedTo?.name || 'another marketing person' }),
      };
    });
}

const MOST_MODELS = 3;

/** For each model the buyer named, the master models it could mean, best first. */
export async function modelSuggestions(asked = []) {
  const rows = await catalogue();
  return asked.map((words) => shortlist(String(words || '').slice(0, 120), rows, { limit: MOST_MODELS })
    .map(({ row, score }) => ({ ref: row.ref, kind: row.kind, code: row.code, name: row.name || undefined, score })));
}
