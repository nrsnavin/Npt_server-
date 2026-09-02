import mongoose from 'mongoose';

/**
 * The material register: what the plant buys, in what colour, at what rate.
 *
 * Until now a costing carried a bare `rawMaterialRate` typed into a box. That is a number with
 * no provenance — nobody can say which resin it was, which grade, which colour, or when the
 * rate was last true — so two costings raised a week apart at ₹160 and ₹152 look like a
 * disagreement rather than a price movement. A register gives the rate a name and one place to
 * be corrected: change it here and the next costing is right, while every costing already
 * built keeps the rate it was built on.
 *
 * The **grammage factor** is the other half, and it is the part that is easy to get wrong by
 * hand. A mould's cavity is a fixed volume, so the same tool throws a heavier part in a denser
 * resin: PP is about 0.905 g/cc and HIPS about 1.05, which is why the plant works to "HIPS is
 * PP plus 18%". Rather than hard-coding a check on the resin's name — which silently does
 * nothing the first time somebody adds a grade it has never heard of — the uplift is a field
 * on the material itself. PP and LD sit at 0 because the mould's grammage is recorded in PP.
 */

/**
 * The polymer families the plant actually buys, plus what they are called on the shop floor.
 *
 * `ld` is low-density polyethylene, which the sheet writes as LD. It is close enough to PP in
 * density that the plant treats their grammage as the same, and the factor below says so
 * rather than this list implying it.
 */
export const MATERIAL_TYPES = ['pp', 'hips', 'ld', 'abs', 'ps', 'recycled_pp', 'other'];

const materialSchema = new mongoose.Schema(
  {
    /** What the store calls it. `PP Natural`, `HIPS White`, `LD Black`. */
    name: { type: String, required: true, trim: true },
    /** The plant's own code, where it has one. Unique so two entries cannot claim it. */
    code: { type: String, trim: true, uppercase: true, unique: true, sparse: true },

    type: { type: String, enum: MATERIAL_TYPES, default: 'pp', index: true },
    /** Natural, White, Black, Smoke Grey — the same resin at different rates. */
    colour: { type: String, trim: true },

    /** What a kilo costs today. The one number a costing reads. */
    ratePerKg: { type: Number, min: 0, required: true },

    /**
     * How much heavier a piece is in this resin than the mould's PP grammage, as a percentage.
     *
     * Zero for PP and LD, because that is the basis the register records a tool's grammage in.
     * 18 for HIPS, which is the plant's working figure and close to the density ratio. Held
     * here rather than derived from `type` so a grade that behaves differently can say so
     * without anybody editing code — and so the figure is visible to the person who owns it.
     */
    grammageFactorPercent: { type: Number, min: -50, max: 200, default: 0 },

    supplier: { type: String, trim: true },
    /** When the rate above was last confirmed, so a stale one can be spotted. */
    rateUpdatedAt: Date,

    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

materialSchema.index({ name: 'text', code: 'text' });
materialSchema.index({ type: 1, isActive: 1 });

/** The rate per gram, which is what a per-piece costing actually multiplies by. */
materialSchema.virtual('ratePerGram').get(function ratePerGram() {
  return (this.ratePerKg || 0) / 1000;
});

/**
 * What a piece recorded at `ppGrams` on the mould actually weighs in this resin.
 *
 * The mould's grammage is a PP figure by convention — see the register — so this is where the
 * conversion happens, once, rather than in each screen that needs it.
 */
materialSchema.methods.grammageFor = function grammageFor(ppGrams) {
  return grammageFrom(ppGrams, this.grammageFactorPercent);
};

materialSchema.set('toJSON', { virtuals: true });
materialSchema.set('toObject', { virtuals: true });

/**
 * The conversion on its own, for callers holding a factor rather than a document.
 *
 * Rounded to three decimals for the same reason the mould's figures are: a tenth of a gram on
 * a 30 g part is a third of a percent of the resin bill, and carrying fifteen decimals means
 * the costing and anything that recomputes it disagree in the last digit.
 */
export function grammageFrom(ppGrams, factorPercent = 0) {
  if (!ppGrams) return 0;
  return Math.round(ppGrams * (1 + (factorPercent || 0) / 100) * 1000) / 1000;
}

export default mongoose.model('Material', materialSchema);
