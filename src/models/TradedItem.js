import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';
import { HANGER_CATEGORIES } from './Mould.js';

/**
 * The trading master: what the plant buys in finished and resells, and what it pays for it.
 *
 * Five of the twenty-five models on the plant's own 26-27 sheet are traded — no tool, no resin,
 * no cycle time, nothing for the mould register to say. What a costing needs for them is one
 * figure, the inward price, and before this it lived in somebody's head or a supplier's
 * WhatsApp. Here it is a register like the resins: one row per item, the price dated, every
 * change kept, and a quotation line for the item takes the price from here
 * [controllers/quotation.controller.js].
 *
 * The inward price is cost, so it is shown to the Quotation department and Admin only
 * [services/pricingVisibility.js `tradedItemVisibleTo`]. Everyone else who quotes sees the item.
 */

export const PRICE_SOURCES = ['manual', 'upload'];

/** The key a model name is matched on: case and spacing do not make a different item. */
export const modelKeyOf = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();

const priceChangeSchema = new mongoose.Schema(
  {
    price: { type: Number, min: 0, required: true },
    /** What it was before, so the history reads as moves rather than a list of numbers. */
    from: { type: Number, min: 0 },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    source: { type: String, enum: PRICE_SOURCES, default: 'manual' },
    note: { type: String, trim: true },
  },
  { _id: false }
);

const tradedItemSchema = new mongoose.Schema(
  {
    /** The plant's own item code, where it has one. */
    code: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    /** The name the buyer and the quotation use — "PH-17", "Velvet 42cm". Required, and unique. */
    modelNumber: { type: String, trim: true, required: true },
    modelKey: { type: String, unique: true },
    description: { type: String, trim: true },
    category: { type: String, enum: HANGER_CATEGORIES },
    sizeMm: { type: Number, min: 0 },
    colour: { type: String, trim: true },
    /** Free text: a traded piece may be wood, metal or velvet, which the resin list does not cover. */
    material: { type: String, trim: true },

    supplier: { type: String, trim: true },
    /** The supplier's own code for it, which is what goes on the purchase order. */
    supplierItemCode: { type: String, trim: true },

    /** ₹ per piece, paid to the supplier. The one number a costing reads. */
    inwardPrice: { type: Number, min: 0, required: true },
    /** When the price was last confirmed, so a stale one can be spotted. */
    priceUpdatedAt: Date,
    priceHistory: { type: [priceChangeSchema], default: [] },

    /** The smallest order the rate we quote should hold for, offered to the quotation line. */
    moq: { type: Number, min: 0 },
    piecesPerCarton: { type: Number, min: 0 },
    hsnCode: { type: String, trim: true },
    gstPercent: { type: Number, min: 0, max: 100 },

    isActive: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

tradedItemSchema.pre('validate', function keyTheModel() {
  this.modelKey = modelKeyOf(this.modelNumber);
});

tradedItemSchema.index({ modelNumber: 'text', code: 'text', description: 'text', supplier: 'text' });
tradedItemSchema.index({ isActive: 1, modelNumber: 1 });

tradedItemSchema.set('toJSON', { virtuals: true });
tradedItemSchema.set('toObject', { virtuals: true });

protectWrites(tradedItemSchema);

export default mongoose.model('TradedItem', tradedItemSchema);
