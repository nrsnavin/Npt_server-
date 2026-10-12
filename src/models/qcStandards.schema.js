import mongoose from 'mongoose';

/**
 * The test standards a model is checked against [models/Mould.js `qcStandards`], and a buyer's own
 * where they ask for more [models/Customer.js `qcStandards`] — the minimums a QC sheet starts with.
 * A buyer's figure wins over the model's; anything neither sets is left for the inspector.
 */
const num = (max = 100000) => ({ type: Number, min: 0, max });

export const QC_STANDARD_FIELDS = [
  'breakingMinKg', 'hookPullMinKg', 'clipGripMinKg', 'hangLoadKg', 'hangHours', 'allowedDeflectionMm',
  'weightToleranceG', 'widthToleranceMm', 'dropHeightCm', 'drops', 'moistureMaxPercent', 'mfiMin', 'mfiMax',
  'shrinkageMaxPercent', 'hookTurns', 'uvHours', 'cartonDropCm', 'piecesPerCarton', 'aql',
];

const qcStandardsSchema = new mongoose.Schema(
  {
    breakingMinKg: num(),
    hookPullMinKg: num(),
    clipGripMinKg: num(),
    hangLoadKg: num(),
    hangHours: num(1000),
    allowedDeflectionMm: num(),
    weightToleranceG: num(),
    widthToleranceMm: num(),
    dropHeightCm: num(),
    drops: num(1000),
    moistureMaxPercent: num(100),
    mfiMin: num(1000),
    mfiMax: num(1000),
    shrinkageMaxPercent: num(100),
    hookTurns: num(1000000),
    uvHours: num(10000),
    cartonDropCm: num(),
    piecesPerCarton: num(100000),
    aql: { type: Number, enum: [0.65, 1, 1.5, 2.5, 4, 6.5] },
    notes: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

export default qcStandardsSchema;
