import mongoose from 'mongoose';
import { HANGER_CATEGORIES, MATERIALS } from './Mould.js';

/**
 * One thing a buyer wants, wherever in the pipeline it is being recorded.
 *
 * A lead, an enquiry and a costing all describe the same object — a hanger, in a material, a
 * colour and a size, with a hook, a clip and a print — and until now each wrote that description
 * out for itself. One definition here instead, because the whole value of carrying the four
 * register references from the first record is that they are *the same references* all the way
 * down: the enquiry, the sample the buyer approved and the price they were given point at one
 * row in the mould register and one in the material register, so §13's "correct colour" is a
 * comparison rather than two boxes of similar text. Three copies of the shape is three chances
 * for one of them to drift.
 *
 * **Every field is optional, and that is what a requirement is.** At lead stage almost none of
 * it is known; at enquiry stage some of it is; by the time a costing is raised most of it has to
 * be. Enforcing more here would mean refusing to record a conversation that actually happened.
 *
 * `_id` is on, unlike the single `requirement` this was extracted from, because these now live
 * in arrays: a row needs a stable identity for a screen to key on, for a reader to point at, and
 * for a quotation to say which of five models it priced.
 */

/**
 * The fields, as a plain object.
 *
 * Handed out rather than a built `Schema` so each model can decide its own options — the
 * enquiry's original single `requirement` keeps `{ _id: false }` and the arrays do not — and so
 * a model can add a field of its own alongside without reaching into a shared instance and
 * changing it for everybody.
 */
export const requirementFields = () => ({
  modelNumber: { type: String, trim: true },
  category: { type: String, enum: HANGER_CATEGORIES },
  sizeMm: { type: Number, min: 0 },

  /* The four register references [§28]. Optional throughout, because a register that has to be
     complete before anything can be recorded is a register nobody starts filling. */
  materialRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Material' },
  hookRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
  clipRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },
  printRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Component' },

  material: { type: String, enum: MATERIALS },
  colour: { type: String, trim: true },

  /**
   * Whether that colour is a condition or a preference — see `colourMandatory` on the sample.
   *
   * Asked here as well as on the sample because most samples are not raised by hand: moving an
   * enquiry to `sample_required` raises one automatically [§6], and the only person who knows
   * whether the buyer said "this white" or "white-ish" is whoever took the call. Asking the
   * bench later means asking the one person in the building who was not on it.
   */
  colourMandatory: { type: Boolean, default: false },
  printing: { type: String, trim: true },
  packing: { type: String, trim: true },

  /**
   * Legacy on the enquiry's own `requirement`, and no longer asked for there.
   *
   * An enquiry used to require a quantity and it was the wrong question at the wrong moment:
   * nothing before the purchase order knows how many, and the figure a buyer gives to be polite
   * travels the whole chain as if it were a commitment. Kept on the shape because the enquiries
   * already raised do not lose what they recorded.
   */
  quantity: { type: Number, min: 0 },
});

/** A sub-document schema over those fields. Rows in a list get an `_id`; a lone one does not. */
export const requirementSchema = ({ withId = true } = {}) =>
  new mongoose.Schema(requirementFields(), { _id: withId });

/** Whether anybody actually typed anything into a row — an empty one is not an item. */
export const hasRequirement = (item) =>
  Boolean(
    item
    && (item.modelNumber || item.category || item.sizeMm || item.material || item.colour
      || item.printing || item.packing || item.materialRef || item.hookRef || item.clipRef
      || item.printRef || item.quantity)
  );

/**
 * The fields worth copying when one record's item becomes another's.
 *
 * A lead's items become the enquiry's on conversion, and an enquiry's become a costing's when
 * one is raised. Copied field by field rather than by spreading the whole sub-document, because
 * a sub-document carries `_id` and mongoose internals that have no business being written into
 * a different record — and because a field added to the shape later should have to be thought
 * about here rather than arriving silently.
 */
export const copyRequirement = (item = {}) => ({
  modelNumber: item.modelNumber,
  category: item.category,
  sizeMm: item.sizeMm,
  materialRef: item.materialRef,
  hookRef: item.hookRef,
  clipRef: item.clipRef,
  printRef: item.printRef,
  material: item.material,
  colour: item.colour,
  colourMandatory: item.colourMandatory,
  printing: item.printing,
  packing: item.packing,
  quantity: item.quantity,
});
