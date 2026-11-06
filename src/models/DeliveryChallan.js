import mongoose from 'mongoose';

/**
 * A delivery challan (DC): goods that leave the plant without an invoice yet — the PP sample
 * [services/ppSample.service.js]. Numbered DC-2026-0001, printed on the letterhead, and kept
 * "to be invoiced" until the pieces are added to the order's invoice: the Invoice & Dispatch
 * task lists it until somebody says which invoice took it.
 */
export const DC_STATUSES = ['to_invoice', 'invoiced'];
export const DC_MODES = ['courier', 'transporter', 'own_vehicle', 'hand_delivery', 'party_collects'];

const lineSchema = new mongoose.Schema(
  {
    model: { type: String, trim: true, required: true, maxlength: 80 },
    mould: { type: String, trim: true, maxlength: 120 },
    material: { type: String, trim: true, maxlength: 120 },
    hook: { type: String, trim: true, maxlength: 120 },
    clip: { type: String, trim: true, maxlength: 120 },
    printing: { type: String, trim: true, maxlength: 200 },
    pieces: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const deliveryChallanSchema = new mongoose.Schema(
  {
    number: { type: String, required: true, unique: true },
    kind: { type: String, enum: ['pp_sample'], default: 'pp_sample' },
    ppSample: { type: mongoose.Schema.Types.ObjectId, ref: 'PpSample', index: true },
    round: Number,
    enquiry: { type: mongoose.Schema.Types.ObjectId, ref: 'Enquiry', index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'SalesOrder', index: true },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', index: true },
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Todo' },
    lines: { type: [lineSchema], validate: { validator: (rows) => rows.length > 0, message: 'A DC lists at least one line' } },
    transport: {
      mode: { type: String, enum: DC_MODES },
      courier: { type: String, trim: true, maxlength: 120 },
      reference: { type: String, trim: true, maxlength: 120 },
      vehicle: { type: String, trim: true, maxlength: 60 },
      _id: false,
    },
    remarks: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: DC_STATUSES, default: 'to_invoice', index: true },
    invoice: {
      number: { type: String, trim: true, maxlength: 60 },
      date: String,
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      at: Date,
      _id: false,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

deliveryChallanSchema.virtual('pieces').get(function pieces() {
  return (this.lines || []).reduce((sum, line) => sum + (line.pieces || 0), 0);
});
deliveryChallanSchema.set('toJSON', { virtuals: true });
deliveryChallanSchema.set('toObject', { virtuals: true });

export default mongoose.model('DeliveryChallan', deliveryChallanSchema);
