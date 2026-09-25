import mongoose from 'mongoose';
import { protectWrites } from '../utils/concurrency.js';

/**
 * A filter set somebody named and pinned — "My unanswered", "Despatch this week".
 *
 * Personal: a view is somebody's way into a list, not a record anybody else reads. It stores
 * the list's own query string and nothing more, so opening one is the same request the filters
 * would have made by hand — the list still decides what the person may see.
 */
export const VIEW_PAGES = ['queries', 'enquiries', 'samples', 'leads', 'customers', 'pricings'];
export const MAX_VIEWS = 20;

const savedViewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    page: { type: String, enum: VIEW_PAGES, required: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    /** The list's filters, as the query string it already understands. Strings only. */
    params: { type: Map, of: String, default: {} },
    pinned: { type: Boolean, default: true },
  },
  { timestamps: true }
);

savedViewSchema.index({ user: 1, page: 1, name: 1 }, { unique: true });

protectWrites(savedViewSchema);
export default mongoose.model('SavedView', savedViewSchema);
