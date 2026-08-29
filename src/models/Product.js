import mongoose from 'mongoose';

export const HANGER_CATEGORIES = ['shirt', 'trouser', 'suit', 'skirt', 'kids', 'lingerie', 'coat', 'multi', 'accessory'];
/**
 * What the piece is made of.
 *
 * `pp` and `hips` are the two the costing sheet actually names — polypropylene and high-impact
 * polystyrene — and they matter to a price in a way "plastic" does not: they are bought at
 * different rates per kilo (₹160 against ₹90 on the current sheet), so a costing that records
 * only "plastic" cannot be checked against the resin bill it came from.
 */
export const MATERIALS = [
  'pp', 'hips', 'plastic', 'wood', 'metal', 'velvet', 'acrylic', 'recycled_pp',
];
export const HOOK_TYPES = ['fixed', 'swivel', 'metal_swivel', 'plastic', 'clip'];

/**
 * The product master [BLUEPRINT §28]. Marketing picks from here rather than typing model
 * names, so a model only enters once it is real — see `mouldAvailable`.
 */
const productSchema = new mongoose.Schema(
  {
    modelCode: { type: String, required: true, unique: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: HANGER_CATEGORIES, required: true },
    sizeMm: { type: Number, min: 0, required: true },
    material: { type: String, enum: MATERIALS, required: true },
    standardWeightGrams: { type: Number, min: 0 },
    availableColours: [{ type: String, trim: true }],
    hookType: { type: String, enum: HOOK_TYPES, default: 'fixed' },
    photoUrl: String,

    /** False for a model that exists on paper but has no mould cut yet. */
    mouldAvailable: { type: Boolean, default: false },
    mouldNumber: { type: String, trim: true },

    standardPrice: { type: Number, min: 0 },
    moq: { type: Number, min: 0, default: 0 },
    packingQty: { type: Number, min: 0, default: 0 },

    /** Set when the model came out of a new-development enquiry. */
    developedFromEnquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry' },

    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

productSchema.index({ name: 'text', modelCode: 'text' });

export default mongoose.model('Product', productSchema);
