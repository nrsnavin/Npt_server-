import Customer from '../models/Customer.js';
import Mould from '../models/Mould.js';
import User from '../models/User.js';
import { nextNumber } from './numbering.service.js';
import { normalisePhone } from '../utils/phone.js';

/**
 * Joining an outside system's sales order to our own records [BLUEPRINT §2, §28, §29].
 *
 * The hard half of any import, and the half that has nothing to do with HTTP. Whatever Chirix's
 * API turns out to look like — and whatever comes after Chirix — the questions are the same
 * three: **which buyer, which tool, whose order.** So they live here rather than inside one
 * feed's client, and they take already-plain values rather than anybody's row shape.
 *
 * Every join follows the same discipline:
 *
 *   **Exact keys first, in order of how much they prove.** A GSTIN is a legal identity; a name is
 *   a spelling. Trying them in that order is the difference between matching a buyer and matching
 *   a buyer who happens to be typed the same way.
 *
 *   **No fuzzy matching, anywhere.** Not on the customer, and emphatically not on the mould. A
 *   wrong customer is embarrassing and correctable; a wrong tool is fifty thousand pieces on the
 *   wrong steel. Where a code does not match exactly, the answer is "unmatched" rather than
 *   "probably this one".
 *
 *   **A failed join never drops the order.** Refusing an order because the buyer is new loses
 *   real business, and an import people do not trust to arrive is an import nobody stops
 *   double-checking — at which point it has saved nothing. So the join degrades to a recorded
 *   unknown, and says so in a sentence.
 *
 * That last part is what `importReview` on the order is for: it carries what was guessed, in
 * words, so order confirmation reads it before ticking a single §13 check. The alternative — a
 * blank field — asks somebody to notice an absence, which is the thing people are worst at.
 */

const trimmed = (value) => {
  const text = String(value ?? '').trim();
  return text ? text : undefined;
};

/** Collapses case, punctuation and the usual suffixes so two spellings of one firm meet. */
export function normaliseCompany(name) {
  return String(name ?? '')
    .toLowerCase()
    /* Legal suffixes carry no identity: "Sri Kumaran Knits" and "Sri Kumaran Knits Pvt Ltd" are
       one buyer, and treating them as two puts two marketing people on the same account. */
    .replace(/\b(private|pvt|limited|ltd|llp|inc|co|company|and|&)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * The buyer this order belongs to.
 *
 * GSTIN first because it is the one field that is legally unique to a business — two firms cannot
 * share one, and a match on it is a fact rather than an inference. Only then the name, normalised,
 * with the mobile as corroboration where we have both.
 *
 * A buyer nobody has heard of is created rather than refused, and flagged. The alternative was to
 * hold the order back for somebody to add the customer first, which sounds careful and is not: it
 * puts a real order in a queue outside the order book, where the only thing that finds it is
 * somebody remembering to look.
 */
export async function matchCustomer({ gstin, name, mobile, city, state }, { owner, create = true } = {}) {
  const review = [];

  const cleanGstin = trimmed(gstin)?.toUpperCase();
  if (cleanGstin) {
    const byGstin = await Customer.findOne({ gstin: cleanGstin });
    if (byGstin) return { customer: byGstin, matchedOn: 'gstin', review };
  }

  const cleanName = trimmed(name);
  if (cleanName) {
    /*
     * Compared in memory rather than with a regex query, because the normalisation strips
     * punctuation and suffixes and no index can express that. The customer master is a few
     * thousand rows at most — this is a scan of a small collection, not of the order book.
     */
    const candidates = await Customer.find({}).select('name gstin mobile assignedTo code');
    const wanted = normaliseCompany(cleanName);
    const phone = normalisePhone(trimmed(mobile));

    const byName = candidates.filter((row) => normaliseCompany(row.name) === wanted);

    if (byName.length === 1) return { customer: byName[0], matchedOn: 'name', review };

    /*
     * Two customers with the same normalised name is a real situation — a group with two units —
     * and the mobile is what separates them. Without one, guessing would attach an order to the
     * wrong unit of the right group, which is worse than saying so.
     */
    if (byName.length > 1) {
      const byPhone = phone ? byName.find((row) => row.mobile === phone) : null;
      if (byPhone) return { customer: byPhone, matchedOn: 'name+mobile', review };

      review.push(
        `${cleanName} matches ${byName.length} customers and nothing separates them — check this is the right one`
      );
      return { customer: byName[0], matchedOn: 'ambiguous', review };
    }
  }

  if (!create) return { customer: null, matchedOn: 'none', review };

  /*
   * New to us. Created with the owner the caller resolved, because §29 requires every customer to
   * belong to one marketing person and a customer created without one is a record nobody chases.
   */
  const customer = await Customer.create({
    code: await nextNumber('CUST'),
    name: cleanName || 'Unnamed imported buyer',
    gstin: cleanGstin,
    mobile: normalisePhone(trimmed(mobile)),
    city: trimmed(city),
    state: trimmed(state),
    assignedTo: owner,
    source: 'manual',
  });

  review.push(`${customer.name} was not on the customer master and has been added — check the details`);
  return { customer, matchedOn: 'created', review };
}

/**
 * The tool this line runs on [§28].
 *
 * Exact on the mould code, then exact on the model number. Nothing else, and that restraint is
 * the whole point: an order line may legitimately have no mould — bought-in items and new
 * developments both — so the schema already carries free text alongside an empty `mould`. An
 * unmatched code is therefore a supported state rather than an error, which means there is never
 * a reason to guess.
 *
 * Inactive tools still match. A code that names a retired mould is information — the buyer has
 * ordered something we have stopped making, and somebody needs to know that — whereas silently
 * treating it as unmatched would hide it.
 */
export async function matchMould(code, { modelNumber } = {}) {
  const review = [];
  const wanted = trimmed(code)?.toUpperCase();

  if (wanted) {
    const byCode = await Mould.findOne({ mouldCode: wanted });
    if (byCode) {
      if (byCode.isActive === false) {
        review.push(`${byCode.mouldCode} is a retired tool — confirm this model is still made`);
      }
      return { mould: byCode, matchedOn: 'mouldCode', review };
    }
  }

  const model = trimmed(modelNumber);
  if (model) {
    const byModel = await Mould.findOne({ mouldCode: model.toUpperCase() });
    if (byModel) return { mould: byModel, matchedOn: 'modelNumber', review };
  }

  /*
   * Left for a person. Named in the review line rather than reported as "no mould", because the
   * useful sentence is which code failed to match — that is what somebody takes to the register.
   */
  review.push(
    wanted || model
      ? `No tool on the register matches "${wanted || model}" — pick the mould, or leave it as bought-in`
      : 'No model code was supplied — pick the mould'
  );
  return { mould: null, matchedOn: 'none', review };
}

/**
 * Whose order this is [§29].
 *
 * Three sources, narrowing from what the other system said to what we can always supply, because
 * `assignedTo` is required on an order and an import that cannot fill it cannot import anything.
 *
 *   1. The salesperson the outside system named, through a mapping the plant maintains. Their
 *      user list is not ours and never will be, so the join is a table rather than a guess at
 *      matching names — "R. Kumar" against "Ramesh Kumar" is exactly the fuzzy match this file
 *      refuses everywhere else.
 *   2. The customer's existing owner, which is the right answer surprisingly often: a repeat
 *      buyer already belongs to somebody.
 *   3. A configured fallback, so the order lands with a real person rather than nobody.
 *
 * The mapping is passed in rather than read from config here, so the caller decides where it
 * lives and this stays testable without one.
 */
export async function matchOwner({ salesperson, customer, mapping = {}, fallback } = {}) {
  const review = [];
  const named = trimmed(salesperson);

  if (named) {
    const mapped = mapping[named] || mapping[named.toLowerCase()];
    if (mapped) {
      const user = await User.findById(mapped).select('_id name isActive');
      if (user && user.isActive !== false) return { owner: user._id, matchedOn: 'mapping', review };
    }
    if (customer?.assignedTo) {
      review.push(`"${named}" is not mapped to anyone here — given to the customer's owner instead`);
    }
  }

  if (customer?.assignedTo) {
    return { owner: customer.assignedTo, matchedOn: 'customer', review };
  }

  if (fallback) {
    review.push(
      named
        ? `"${named}" is not mapped to anyone here, and the buyer has no owner — assigned to the default`
        : 'No salesperson was supplied — assigned to the default'
    );
    return { owner: fallback, matchedOn: 'fallback', review };
  }

  /*
   * Nothing left to try. Returning null rather than throwing so the caller can count the row and
   * carry on with the rest of the batch — one unassignable order must not stop the other
   * nineteen from arriving.
   */
  review.push('Nobody could be found to own this order');
  return { owner: null, matchedOn: 'none', review };
}

/**
 * All three joins, in the order they depend on each other.
 *
 * The owner has to be resolved twice over: a customer cannot be created without one, and the
 * best answer for the owner is usually the customer's. So the fallback settles a new customer,
 * and the full rule then runs against whichever customer we ended up with — an existing buyer's
 * own owner wins, which is the answer that matters most and would be lost by resolving once.
 */
export async function matchOrder(input, { mapping = {}, fallback, create = true } = {}) {
  const review = [];

  const { customer, matchedOn: customerMatch, review: customerReview } = await matchCustomer(
    input.customer || {},
    { owner: fallback, create }
  );
  review.push(...customerReview);

  const { owner, matchedOn: ownerMatch, review: ownerReview } = await matchOwner({
    salesperson: input.salesperson,
    customer,
    mapping,
    fallback,
  });
  review.push(...ownerReview);

  const lines = [];
  for (const line of input.lines || []) {
    const { mould, matchedOn, review: lineReview } = await matchMould(line.mouldCode, {
      modelNumber: line.modelNumber,
    });
    /* Prefixed with the model, because on a four-line order "no tool matches" is unactionable
       without knowing which line it is about. */
    review.push(...lineReview.map((note) => `${line.modelNumber || line.mouldCode || 'a line'}: ${note}`));
    lines.push({ ...line, mould: mould?._id, mouldMatchedOn: matchedOn });
  }

  return {
    customer,
    owner,
    lines,
    review,
    matchedOn: { customer: customerMatch, owner: ownerMatch },
    /** True when nothing had to be guessed — the only orders that need no second look. */
    clean: review.length === 0,
  };
}
