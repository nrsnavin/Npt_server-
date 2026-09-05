import ApiError from '../utils/ApiError.js';
import { accessLevel } from './access.service.js';
import { levelSatisfies } from '../config/modules.js';

/**
 * Who may see what on a costing sheet [BLUEPRINT §8].
 *
 * This is the one rule the module system cannot express. A grant says whether you may open
 * pricing at all; §8 says that *within* a sheet you may open, marketing sees the quoted price,
 * the validity and the terms — and never the raw material rate, the full cost, the gross margin
 * or the minimum approved price. The blueprint is explicit that enforcing it is the module's
 * own job, and it is worth being clear about why: those figures are what a competitor would
 * pay for, and what a departing salesperson could take with them.
 *
 * **Redacted on the way out, in one function.** Not by asking each endpoint to remember which
 * fields to strip — that is a rule with as many copies as there are routes, and the copy
 * somebody forgets is the leak. Every path that returns a costing goes through `visibleTo`.
 *
 * **Deny by default.** `CONFIDENTIAL` lists what to remove rather than `ALLOWED` listing what
 * to keep, which is the weaker of the two shapes — a field added to the model later is visible
 * until somebody remembers. So the test that guards this walks the *model's own paths* and
 * fails on any money-shaped field that is neither listed as confidential nor as public: adding
 * a cost line to the sheet without deciding who may see it breaks the build.
 */

/**
 * The figures §8 keeps to management and costing.
 *
 * `cost` is the whole sub-document: every line in it is a component of the full cost, so
 * naming them individually would be a list to keep in step with the schema.
 */
export const CONFIDENTIAL = [
  'cost',
  'materialCost',
  'totalCost',
  'grossMarginPercent',
  'effectiveMarkupPercent',
  'markupPercent',
  'minimumSellingPrice',
  'minimumOverride',
  /*
   * The tier table is the cost base in disguise. Three prices in a fixed 10 / 15 / 20 ratio
   * let anyone divide back to the cost in one step, so publishing them would undo the rest of
   * this list — the most expensive kind of leak, because every individual field on it looks
   * innocent.
   */
  'tiers',
];

/**
 * Money-shaped fields that marketing is *meant* to see, named so the guard test can tell the
 * difference between "decided to be public" and "nobody has thought about it yet".
 */
export const PUBLIC_FIGURES = [
  'approvedSellingPrice',
  'calculatedSellingPrice',
  'targetPrice',
  'quantity',
];

/**
 * True when this person may see the confidential half.
 *
 * Read off the pricing grant rather than the department: §7 notes this organisation has no
 * costing team so `pricing: write` sits with management, and that granting a marketing person
 * pricing rights should put them inside the sheet without anything here changing.
 */
export const seesCosting = (user) =>
  user?.role === 'admin' ||
  (user?.moduleAccess || []).some((grant) => grant.module === 'pricing' && grant.level === 'write');

/**
 * One costing, as this person is allowed to see it.
 *
 * A marketing reader still learns the one thing they need about the floor — whether the price
 * is under it, and therefore whether they may quote yet — without learning where the floor is.
 * That distinction is the whole design: the block has to be explainable, or it reads as the
 * system being broken.
 */
export function visibleTo(pricing, user) {
  const plain = typeof pricing?.toJSON === 'function' ? pricing.toJSON() : { ...pricing };
  if (seesCosting(user)) return plain;

  for (const field of CONFIDENTIAL) delete plain[field];

  /*
   * The mould travels with the sheet, and it carries its own money. Redacting the cost lines
   * here while the tool populated beside them reports a machine rate and a cost per piece would
   * be the leak arriving through the door this function is standing in front of.
   *
   * Only when it is actually populated — an unpopulated reference serialises to an id, and
   * spreading a string produces an object of numbered characters.
   */
  if (plain.mould && typeof plain.mould === 'object') {
    plain.mould = mouldVisibleTo(plain.mould, user);
  }

  /*
   * Kept: facts about what may happen next, not figures. `needsApproval` is the one the screen
   * should show — a sheet MD has signed off is still under the floor and is cleared to quote,
   * and saying "needs approval" beside a badge reading Approved is the screen contradicting
   * itself.
   */
  plain.belowMinimum = Boolean(pricing.belowMinimum);
  plain.needsApproval = Boolean(pricing.needsApproval);
  plain.costingHidden = true;
  return plain;
}

export const allVisibleTo = (rows, user) => rows.map((row) => visibleTo(row, user));

/**
 * One costing as it appears *on a quotation line*, which is a different question from §8's usual
 * one and worth its own function.
 *
 * A costing knows what it is worth at the price it was approved at. A quotation line knows what
 * was actually offered — and those diverge the moment anybody negotiates, which is most of the
 * time. So the margin here is computed against the **line's** price, not the sheet's:
 * `grossMarginPercent` on the costing answers "what would we make at the approved price", and
 * nobody is being charged the approved price. Neither record answers "what are we making on this
 * line" on its own, and that is the number a quotation screen exists to show.
 *
 * The wall stands exactly where §8 puts it. The cost base, the floor and the margin go only to
 * someone who may already open the costing; everyone else gets `belowFloor` — whether the price
 * offered sits under the minimum, without learning where the minimum is. That is the same
 * distinction `visibleTo` above draws for `belowMinimum`, and it is drawn again here rather than
 * inherited because the comparison is against a different price.
 *
 * @param {object} pricing   the populated costing, or null
 * @param {number} unitPrice what this line actually quotes
 * @param {object} user
 */
export function lineCosting(pricing, unitPrice, user) {
  if (!pricing) return null;

  /*
   * An allow-list, never a `select`. The costing's totals are virtuals and are recomputed on the
   * way out whatever a projection said — see the note on `getQuotation`. Building the answer up
   * from named fields is the only version that cannot drift into leaking one.
   */
  const seen = {
    _id: pricing._id,
    number: pricing.number,
    status: pricing.status,
    approvedSellingPrice: pricing.approvedSellingPrice,
  };

  const floor = pricing.minimumSellingPrice;
  /* Only a real comparison counts: an uncosted sheet has no floor, and `undefined < n` is false
     for the wrong reason. */
  seen.belowFloor =
    floor != null && unitPrice != null ? unitPrice < floor : false;

  if (!seesCosting(user)) return seen;

  const cost = pricing.totalCost;
  seen.totalCost = cost;
  seen.minimumSellingPrice = floor;

  if (cost != null && unitPrice) {
    seen.marginPerPiece = Math.round((unitPrice - cost) * 100) / 100;
    /* Margin on the price, markup on the cost — the sheet speaks in both, and confusing them is
       how a 20% markup gets read as a 20% margin. */
    seen.marginPercent = Math.round(((unitPrice - cost) / unitPrice) * 1000) / 10;
    seen.markupPercent = cost
      ? Math.round(((unitPrice - cost) / cost) * 1000) / 10
      : null;
  }

  return seen;
}

/**
 * The mould register's own confidential half.
 *
 * §8 is written about the costing sheet, but the rule it states is about *figures*, not about a
 * collection — and a machine hour rate is a cost by any reading. Left in the open it also
 * defeats the redaction above rather than merely sitting beside it: the register publishes the
 * gram weight and the pieces per hour, so an hourly rate hands a reader the conversion cost
 * directly and the resin cost as soon as they know a rate per kilo, which is a phone call. The
 * fields §8 protects on the sheet would then be reconstructible from a screen it never mentions.
 *
 * Everything else stays visible to anyone holding the register's own grant. Cavities, weights,
 * cycle time and output are how the plant plans and how marketing answers "can we make it and
 * how fast" — the point of the register is that those stop being one person's knowledge.
 */
export const MOULD_CONFIDENTIAL = [
  'machineCostPerPiece',
  /*
   * The per-piece conversion costs the register now carries. These are the cost base — they are
   * copied straight onto a costing sheet, where §8 hides them — so leaving them readable here
   * would mean the same figures are secret on one screen and published on another, which is not
   * a rule, it is a detour.
   */
  'jobWorkCost',
  'hookCost',
  'clipsCost',
  'printingCost',
  'packingCost',
];

/**
 * Who may see the rate: whoever prices, and whoever keeps the register.
 *
 * The second half is not a concession, it is a correction. Gating this on the costing grant
 * alone hid the rate from the production department — the people who own the register, who
 * measured the machine and who are the only ones who will ever update it. That is not a
 * redaction but a trap: their edit form loads the field blank, and the next unrelated change
 * they save writes that blank back over a figure they were never shown. A field somebody may
 * write and may not read will be destroyed, and nobody will be able to say when.
 *
 * §8 is about keeping the cost base away from the people who leave with it. Production is not
 * that risk; marketing, who hold read on the register and nothing else, still cannot see it.
 */
export const seesMachineRate = (user) =>
  seesCosting(user) || levelSatisfies(accessLevel(user, 'moulds'), 'write');

export function mouldVisibleTo(mould, user) {
  const plain = typeof mould?.toJSON === 'function' ? mould.toJSON() : { ...mould };
  if (seesMachineRate(user)) return plain;

  for (const field of MOULD_CONFIDENTIAL) delete plain[field];
  /* The rate itself, without flattening the rest of the machine — the press and its tonnage
     are shop-floor facts, and hiding which machine a tool runs on protects nothing. */
  if (plain.machine) {
    const { hourRate, ...machine } = plain.machine;
    plain.machine = machine;
  }
  plain.rateHidden = true;
  return plain;
}

export const allMouldsVisibleTo = (rows, user) => rows.map((row) => mouldVisibleTo(row, user));

/**
 * Refuses a write that only costing may make.
 *
 * Reading is split by field; writing is not split at all — building the sheet is costing's job
 * end to end. Marketing raising the request and reading the answer is the whole of their part.
 */
export function assertMayCost(user) {
  if (!seesCosting(user)) {
    throw ApiError.forbidden('Only costing or management can build a costing sheet');
  }
}

/* ------------------------------- Sales orders ------------------------------- */

/**
 * Who may see what an order is worth.
 *
 * **Not `seesCosting`, and the difference matters.** §8 protects the *cost base* — the resin
 * rate, the conversion, the floor — because that is what walks out of the door with somebody
 * who leaves. What a customer agreed to pay is a different secret with a different shape: order
 * confirmation books it, accounts invoices against it, and neither can do their job blind.
 * Gating this on costing hid the order value from the very department that owns the module.
 *
 * So the rule is the one the grants already draw: whoever may read a quotation may see what
 * was agreed on the order it became, and whoever chases the money may see what is owed. That
 * is marketing, order confirmation, accounts and management — and not production, quality,
 * despatch or sampling, none of whom hold either grant and none of whom need the figure.
 */
export const seesOrderValue = (user) =>
  user?.role === 'admin' ||
  Boolean(accessLevel(user, 'quotations')) ||
  Boolean(accessLevel(user, 'payments'));

/**
 * One order, as this person is allowed to see it.
 *
 * An order line carries the rate it was sold at, and the plant does not need it: production
 * needs the model, the quantity and the date, and despatch needs the quantity and the address.
 * An order detail page is the easiest place in the whole system to read a price off in passing.
 *
 * An allow-list on the way out rather than a `.select()` on the way in, for the reason written
 * at the top of this file: the line's `lineValue` and the order's `netValue` are virtuals, and
 * a virtual recomputes on serialisation whatever was projected. Projecting `unitPrice` away
 * would hide the column and leave the totals sitting underneath it, which is not a redaction
 * but a subtraction problem with the answer printed next to it.
 *
 * What survives is the shape of the order without its money: how many pieces, of what, by when,
 * and how far the plant has got. That is what the people downstream actually need.
 */
export function orderVisibleTo(order, user) {
  const plain = typeof order?.toJSON === 'function' ? order.toJSON() : { ...order };
  if (seesOrderValue(user)) return plain;

  delete plain.netValue;
  delete plain.totalValue;
  delete plain.gstPercent;
  delete plain.paymentTerms;

  plain.lines = (plain.lines || []).map((line) => {
    const { unitPrice, lineValue, pricing, ...rest } = line;
    return rest;
  });

  plain.valueHidden = true;
  return plain;
}

export const allOrdersVisibleTo = (rows, user) => rows.map((row) => orderVisibleTo(row, user));
