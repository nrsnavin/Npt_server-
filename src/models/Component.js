import mongoose from 'mongoose';

/**
 * The bought-in parts and processes a hanger carries, priced per piece.
 *
 * Hooks, clips and printing sit beside the material register and answer the same question it
 * does: what does this cost today, and when was that last true. The material register handles
 * the resin, which is bought by the kilo and needs a grammage conversion; everything here is
 * bought or charged by the piece, so the rate goes straight onto a costing line with no
 * arithmetic in between.
 *
 * **One model with a `kind`, rather than three copies.** They differ in what they are called
 * and in nothing else — same fields, same rules, same people maintaining them — and three
 * near-identical schemas is three places for a field to be added twice and a validation to be
 * added once. The screens are still three separate registers, because that is how the plant
 * thinks about them; the storage underneath is one table, which is what keeps a fourth register
 * (packing, poly bags, tags) a row of configuration rather than a day of copying files.
 */

/**
 * What kind of thing this is.
 *
 * `print` is a process rather than a part, and grouping it here is a deliberate call: it is
 * charged per piece exactly as a hook is, it goes onto the same kind of costing line, and the
 * person who knows this week's print rate is the person who knows this week's hook rate.
 */
export const COMPONENT_KINDS = ['hook', 'clip', 'print'];

/** What each register is called on screen, so the label lives with the data rather than in a page. */
export const COMPONENT_LABELS = {
  hook: 'Hook register',
  clip: 'Clip register',
  print: 'Print register',
};

const componentSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: COMPONENT_KINDS, required: true, index: true },

    /** What the store calls it. `Swivel metal hook`, `Wooden clip 25mm`, `1 colour screen`. */
    name: { type: String, required: true, trim: true },
    /**
     * The plant's own code.
     *
     * Unique **within a kind** rather than across all of them, because a hook and a clip may
     * perfectly reasonably both be called `STD-01` in their own stores. A global unique index
     * would refuse the second one for a reason nobody could see from the screen they were on.
     */
    code: { type: String, trim: true, uppercase: true },

    colour: { type: String, trim: true },

    /**
     * What one costs, in rupees.
     *
     * Named for its unit rather than left as a bare `rate`: the material register is priced per
     * kilo and this one per piece, and two fields called `rate` on adjacent screens is how a
     * per-kilo figure ends up on a per-piece line — a mistake worth about a thousand times the
     * number itself.
     */
    ratePerPiece: { type: Number, min: 0, required: true },

    supplier: { type: String, trim: true },
    /** When the rate above was last confirmed, so a stale one can be spotted. */
    rateUpdatedAt: Date,

    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

/**
 * A code is unique within its register, and only when there is one.
 *
 * **Partial, not sparse**, and the difference is not academic. A compound sparse index skips a
 * document only when *every* indexed field is missing — `kind` is always present, so a codeless
 * row indexes as `{ kind: 'hook', code: null }` and the second one collides. That would have
 * allowed exactly one unnamed entry per register: the first hook saves, the next is refused
 * with a duplicate-key error naming a code neither of them has.
 */
componentSchema.index(
  { kind: 1, code: 1 },
  { unique: true, partialFilterExpression: { code: { $exists: true } } }
);
componentSchema.index({ kind: 1, isActive: 1 });
componentSchema.index({ name: 'text', code: 'text' });

componentSchema.set('toJSON', { virtuals: true });
componentSchema.set('toObject', { virtuals: true });

export default mongoose.model('Component', componentSchema);
