import Sample from '../models/Sample.js';
import Mould from '../models/Mould.js';
import { nextNumber } from './numbering.service.js';
import { EVENTS, publish } from './events.service.js';

/**
 * When a sample is due by default [§6].
 *
 * **The day it is asked for.** The blueprint says "set due date" without naming a number, and
 * this used to allow a week — which sounded generous and was the wrong default in practice. A
 * buyer asking for a sample is asking for it now; a week's grace turns every request into one
 * that can sit for six days without being late, and the §25 escalation that exists to catch a
 * slipping sample cannot fire until the week is up. Most requests are a stock check and a bag.
 *
 * The bench is not being told a week's work must happen today: the date is what the sample is
 * *wanted* by, and a request that genuinely needs a mould change is re-dated to what the bench
 * can actually do — deliberately, on the record, where marketing can see it and tell the buyer.
 * That is the conversation a soft default hides.
 *
 * Five in the afternoon rather than midnight, so a sample raised this morning is not overdue
 * by lunchtime. An explicit date always wins, and the enquiry's own delivery date still caps
 * it: a sample due after the order is a sample due never.
 *
 * **And the evening shift is not born late.** Five o'clock today is not a due date at ten past
 * five — it is a request that arrives already overdue, red on the bench's day screen before
 * anybody has seen it. A screen that cries wolf on every request raised after the bench has
 * gone home is a screen whose red stops meaning anything, which costs more than the day of
 * grace it was protecting. So once the hour has gone, the sample is wanted by five tomorrow.
 */
export function defaultRequiredDate(enquiry, from = new Date()) {
  const target = new Date(from);
  target.setHours(17, 0, 0, 0);

  /* At exactly five, too: a sample due this instant is a sample that was never askable. */
  if (target <= from) target.setDate(target.getDate() + 1);

  const delivery = enquiry?.requiredDeliveryDate ? new Date(enquiry.requiredDeliveryDate) : null;
  return delivery && delivery < target ? delivery : target;
}

/** An id, whether the field was populated or left as a reference. */
const idOf = (value) => value?._id || value || undefined;

/**
 * What a sample takes from the enquiry that raised it, so nothing is re-keyed [§41.4].
 *
 * The four register references travel with the rest of it, and they are the part that matters
 * most. The coarse words alone — "HIPS", "White" — do not say which resin or which of the
 * eleven white hooks the buyer asked for, so a bench working from them picks the one nearest to
 * hand and the customer approves a sample nobody can reproduce. Worse, §13 then checks the
 * order against "the approved sample": that check is only a check when both sides point at the
 * same register row [§28], and an enquiry that recorded the row while the sample it raised
 * dropped it left §13 comparing a row against a word.
 */
const fromEnquiry = (enquiry) => ({
  customer: idOf(enquiry.customer),
  enquiry: enquiry._id,
  requestedBy: idOf(enquiry.assignedTo),
  mould: idOf(enquiry.mould),
  modelNumber: enquiry.requirement?.modelNumber,
  category: enquiry.requirement?.category,
  sizeMm: enquiry.requirement?.sizeMm,
  materialRef: idOf(enquiry.requirement?.materialRef),
  hookRef: idOf(enquiry.requirement?.hookRef),
  clipRef: idOf(enquiry.requirement?.clipRef),
  printRef: idOf(enquiry.requirement?.printRef),
  material: enquiry.requirement?.material,
  colour: enquiry.requirement?.colour,
  // Whether that colour binds the bench. Carried, because the person who knows is the one who
  // took the buyer's call, and by the time the bench sees the request they are long off it.
  colourMandatory: enquiry.requirement?.colourMandatory,
  printing: enquiry.requirement?.printing,
  referenceImageUrl: enquiry.referenceImageUrl,
});

/**
 * What the tool knows that the enquiry does not.
 *
 * An enquiry's requirement has no hook type — a buyer asks for a model, not for a swivel — so
 * a sample built only from the enquiry carries none, and anything analysing turnaround by hook
 * finds every sample blank. The mould is where that lives now, and it is the better source
 * besides: the hook, the category and the size are cut into the steel, so what the register
 * says is what the bench will actually produce.
 *
 * Only fills what is still missing: an explicit value on the request always wins, because a
 * sample often exists precisely to try something the standard piece does not do.
 */
async function fromMould(mouldId, alreadyKnown = {}) {
  if (!mouldId) return {};

  const mould = await Mould.findById(mouldId).select('hookType category material sizeMm');
  if (!mould) return {};

  const filled = {};
  for (const field of ['hookType', 'category', 'material', 'sizeMm']) {
    if (alreadyKnown[field] == null && mould[field] != null) filled[field] = mould[field];
  }
  return filled;
}

/**
 * The fields the caller actually stated, with the ones they left out dropped.
 *
 * Spreading the request straight over the inherited values looks equivalent and is not:
 * `{ ...{ customer: id }, ...{ customer: undefined } }` is `{ customer: undefined }`, so a
 * key merely *present* and empty destroys what the enquiry supplied. That is how a sample
 * raised by hand against an enquiry lost its customer — and losing it is not cosmetic, since
 * §6 and §42 tell the customer when the sample is ready and when it goes out, and there was
 * then nobody to tell. It failed on the path a person uses, never on the automated one, and
 * it failed quietly.
 *
 * Handled here rather than at the one call site that did it, because every controller
 * building a payload out of a request body has the same shape and would find the same edge.
 */
const stated = (input) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

/**
 * A sample raised without one already open against the same enquiry.
 *
 * Moving an enquiry to `sample_required` twice — which happens whenever marketing corrects a
 * status — must not produce two live requests for the same thing. A request that has already
 * been answered is not in the way, so a re-sample after `modification_required` still works.
 */
export async function openSampleFor(enquiryId) {
  return Sample.findOne({
    enquiry: enquiryId,
    status: { $nin: ['approved', 'rejected', 'modification_required'] },
  });
}

/**
 * Creates the sample request.
 *
 * One function for every way a request arrives — the enquiry automation, the sample team
 * raising one by hand, a re-sample, and a request with no enquiry behind it at all — so all
 * four produce the same record and walk the same status cycle afterwards.
 *
 * With an enquiry, everything the enquiry already knows is carried over so nothing is
 * re-keyed [§41.4]. Without one, the caller supplies it, and the deduplication that stops a
 * re-applied status raising a second request does not apply: there is no enquiry to
 * deduplicate on, and two walk-ins asking for the same model are two requests.
 */
export async function createSampleRequest(
  { enquiry = null, ...input },
  user,
  { autoCreated = false } = {}
) {
  if (enquiry) {
    const existing = await openSampleFor(enquiry._id);
    if (existing) return { sample: existing, created: false };
  }

  const inherited = enquiry ? fromEnquiry(enquiry) : {};
  Object.assign(inherited, await fromMould(input.mould ?? inherited.mould, inherited));
  const purpose =
    input.purpose || (enquiry?.isNewDevelopment ? 'new_development' : 'existing_model');

  const sample = await Sample.create({
    ...inherited,
    ...stated(input),
    purpose,
    number: await nextNumber('SMP'),
    requiredDate: input.requiredDate || defaultRequiredDate(enquiry),
    // Whoever asked for it. From the enquiry when there is one, otherwise whoever is asking.
    requestedBy: input.requestedBy || inherited.requestedBy || user._id,
    autoCreated,
    statusHistory: [
      {
        to: 'request_received',
        by: autoCreated ? undefined : user._id,
        note: autoCreated ? 'Raised by the enquiry moving to sample required' : undefined,
      },
    ],
  });

  publish(EVENTS.SAMPLE_CREATED, { sample, enquiry, autoCreated });
  return { sample, created: true };
}

/** The enquiry automation's entry point, kept named for what it does [§6]. */
export const createSampleForEnquiry = (enquiry, overrides = {}, options = {}) =>
  createSampleRequest(
    { enquiry, ...overrides },
    { _id: enquiry.assignedTo?._id || enquiry.assignedTo },
    options
  );
