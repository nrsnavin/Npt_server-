import mongoose from 'mongoose';

/**
 * The sample rack as a stock list [the sampling audit, item 12]: the pieces kept at the plant for
 * a marketing person to take on a visit, by model and colour. An in-person hand-over debits it
 * [sampling.service `recordHandover`], so a second marketer does not take the last piece without
 * knowing, and the bench sees what to top up.
 */
const sampleRackSchema = new mongoose.Schema(
  {
    mould: { type: mongoose.Schema.Types.ObjectId, ref: 'Mould' },
    modelNumber: { type: String, required: true, trim: true },
    colour: { type: String, trim: true, default: '' },
    pieces: { type: Number, min: 0, default: 0 },
    /** Where on the rack, for whoever walks up to it. */
    shelf: { type: String, trim: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    /** The last piece taken: by whom, for which sample, when. */
    lastTaken: {
      type: new mongoose.Schema({ at: Date, by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, sample: { type: mongoose.Schema.Types.ObjectId, ref: 'Sample' }, pieces: Number }, { _id: false }),
      default: undefined,
    },
  },
  { timestamps: true }
);

/** One line per model and colour; the key is case- and space-blind. */
sampleRackSchema.index({ modelKey: 1, colourKey: 1 }, { unique: true });
sampleRackSchema.add({ modelKey: { type: String, index: true }, colourKey: { type: String } });
sampleRackSchema.pre('validate', function keys() {
  this.modelKey = rackKey(this.modelNumber);
  this.colourKey = rackKey(this.colour);
});

export const rackKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export default mongoose.model('SampleRack', sampleRackSchema);
