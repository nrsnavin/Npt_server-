import SampleRack, { rackKey } from '../models/SampleRack.js';
import Mould from '../models/Mould.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * The sample rack as a stock list [models/SampleRack.js; the sampling audit, item 12]: what is on
 * the rack by model and colour, kept by the bench, read by marketing before a visit, and debited
 * when a piece is handed over in person [sampling.service `debitRack`].
 */

const POPULATE = [{ path: 'updatedBy', select: 'name' }, { path: 'lastTaken.by', select: 'name' }, { path: 'lastTaken.sample', select: 'number' }, { path: 'mould', select: 'mouldCode name' }];

export const listRack = asyncHandler(async (req, res) => {
  const rows = await SampleRack.find().populate(POPULATE).sort({ modelKey: 1, colourKey: 1 }).lean();
  res.json({
    success: true,
    data: rows,
    meta: { lines: rows.length, pieces: rows.reduce((sum, row) => sum + (row.pieces || 0), 0), empty: rows.filter((row) => !row.pieces).length },
  });
});

/**
 * The rack counted: each line's pieces, by model and colour, written as counted. A line not on
 * the list is added; one listed and left out stays as it was — a count of three models is not a
 * statement about the fourth.
 */
export const setRack = asyncHandler(async (req, res) => {
  const rows = req.body.rows || [];
  const saved = [];
  for (const row of rows) {
    const modelNumber = String(row.modelNumber || '').trim();
    if (!modelNumber) throw ApiError.badRequest('Each rack line names a model');
    const colour = String(row.colour || '').trim();
    /* The same line however the code is typed: the first spelling stays on the list. */
    const line = (await SampleRack.findOne({ modelKey: rackKey(modelNumber), colourKey: rackKey(colour) })) || new SampleRack({ modelNumber, colour });
    line.pieces = Math.max(0, Math.floor(Number(row.pieces) || 0));
    if (row.shelf !== undefined) line.shelf = String(row.shelf || '').trim() || undefined;
    if (!line.mould) {
      const mould = row.mould ? await Mould.findById(row.mould).select('_id') : await Mould.findOne({ mouldCode: new RegExp(`^${modelNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id');
      if (mould) line.mould = mould._id;
    }
    line.updatedBy = req.user._id;
    await line.save();
    saved.push(line);
  }
  const data = await SampleRack.find({ _id: { $in: saved.map((line) => line._id) } }).populate(POPULATE).lean();
  res.json({ success: true, data });
});

export const removeRackLine = asyncHandler(async (req, res) => {
  const line = await SampleRack.findById(req.params.lineId);
  if (!line) throw ApiError.notFound('That rack line is not on the list');
  await line.deleteOne();
  res.json({ success: true, data: { removed: true } });
});
