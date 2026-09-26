import Sample, { ANSWERED_SAMPLE_STATUSES } from '../models/Sample.js';
import Mould from '../models/Mould.js';
import { copyRequirement } from '../models/requirement.schema.js';
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
  /*
   * And every model the enquiry asked about, row for row.
   *
   * An enquiry carries a list now, and the sample it raises is one bag holding all of them —
   * which is what the buyer asked for. Taking only the first would send one hanger against a
   * conversation about three, and the other two would be noticed at the bench or, worse, by the
   * buyer opening the envelope.
   *
   * Each row brings its own tool, because an enquiry row names one now. It did not use to: one
   * mould was named for the whole enquiry and belonged to model one, so the bench was told what
   * made the first hanger and nothing at all about the other two. A bag whose second model says
   * only "410mm, white" is a bag somebody has to come back and ask about.
   */
  items: (enquiry.items || []).map((item, index) => {
    /*
     * Everything except the quantity, which means opposite things on the two records. On an
     * enquiry it is a legacy guess at how big the order might be — 20,000 pieces — and on a
     * sample it is how many go in the courier bag. Carried across, it would put a buyer's
     * speculative annual volume on a bench instruction, which is exactly the number nobody
     * meant and the one the bench would have made.
     */
    const { quantity, ...wanted } = copyRequirement(item);
    /* The row's own tool, which it carries now. The enquiry's is the first row's, for a record
       raised before rows had one — those have the tool up on the enquiry and nowhere else. */
    return { ...wanted, mould: idOf(item.mould) || (index === 0 ? idOf(enquiry.mould) : undefined) };
  }),
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

/** The fields that live on a row as well as on the request's top line — see the model. */
const ROW_FIELDS = [
  'mould', 'modelNumber', 'category', 'sizeMm',
  'materialRef', 'hookRef', 'clipRef', 'printRef',
  'material', 'colour', 'colourMandatory', 'printing', 'packing', 'quantity',
];

/**
 * What the caller actually said, written onto the first row as well as the top line.
 *
 * The model keeps the top line and `items[0]` in step, and where the two disagree the *list*
 * wins — because the list is what somebody filled in on a form. That is right for an edit and
 * wrong here, where the two halves come from different places: the rows are inherited from an
 * enquiry or a previous attempt, and the top-line fields are the override the caller just
 * typed. Left alone, the inherited row quietly won: a re-sample asked for three pieces and the
 * bench was told to make one, which is the attempt being made wrong rather than merely
 * recorded wrong.
 *
 * Only the first row, because that is the one the top line *is*. An override naming a colour
 * says nothing about the second model in the bag, and spreading it across all of them would
 * invent an instruction nobody gave.
 */
function statedOnTheFirstRow(payload, said) {
  const rows = payload.items;
  if (!rows?.length) return payload;

  const overrides = Object.fromEntries(
    ROW_FIELDS.filter((field) => said[field] !== undefined).map((field) => [field, said[field]])
  );
  if (!Object.keys(overrides).length) return payload;

  const first = rows[0]?.toObject?.() ?? rows[0];
  return { ...payload, items: [{ ...first, ...overrides }, ...rows.slice(1)] };
}

/**
 * A sample raised without one already open against the same enquiry.
 *
 * Moving an enquiry to `sample_required` twice — which happens whenever marketing corrects a
 * status — must not produce two live requests for the same thing. A request that has already
 * been answered is not in the way, so a re-sample after `modification_required` still works.
 *
 * The list is `ANSWERED_SAMPLE_STATUSES` from the model rather than a copy of it here, and the
 * copy is what went wrong: it named approved, rejected and modification_required, and never
 * learned about `cancelled`. So the model called a cancelled request closed and this called it
 * open. Cancelling the sample for an enquiry — which §4 added precisely so that losing the
 * enquiry takes the sample off the bench — left it standing in the way of the next one, and
 * the refusal named a cancelled sample as "already open against" the enquiry.
 */
export async function openSampleFor(enquiryId) {
  return Sample.findOne({
    enquiry: enquiryId,
    status: { $nin: ANSWERED_SAMPLE_STATUSES },
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

  const said = stated(input);
  const sample = await Sample.create({
    ...statedOnTheFirstRow({ ...inherited, ...said }, said),
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

  await publish(EVENTS.SAMPLE_CREATED, { sample, enquiry, autoCreated });
  return { sample, created: true };
}

/** The enquiry automation's entry point, kept named for what it does [§6]. */
export const createSampleForEnquiry = (enquiry, overrides = {}, options = {}) =>
  createSampleRequest(
    { enquiry, ...overrides },
    { _id: enquiry.assignedTo?._id || enquiry.assignedTo },
    options
  );
