import mongoose from 'mongoose';
import Sample from '../models/Sample.js';
import Attachment from '../models/Attachment.js';

/**
 * Where the finished-piece photo travels once the bench has taken it [Sample items `photo`; the
 * sampling audit, item 1]: the mould register, as the model's latest real photo when the
 * register has none of its own, and the order screen, beside the approved-sample check that
 * used to compare a word with a word.
 */

const idOf = (value) => String(value?._id || value || '');

/**
 * The latest finished-piece photo per mould, from the samples made on it — `Map(mouldId →
 * { key, fromSample, at })`. One aggregate for a page of tools.
 */
export async function latestSamplePhotosByMould(mouldIds = []) {
  /* Cast by hand: an aggregate does not cast a filter the way `find` does, and the register's rows arrive as plain objects. */
  const ids = mouldIds.filter((id) => id && mongoose.isValidObjectId(String(id))).map((id) => new mongoose.Types.ObjectId(String(id)));
  if (!ids.length) return new Map();
  const rows = await Sample.aggregate([
    /* `$elemMatch`, not a dotted `$ne`: on an array that would drop every bag with one row still unphotographed. */
    { $match: { items: { $elemMatch: { mould: { $in: ids }, photo: { $exists: true, $ne: null } } } } },
    { $unwind: '$items' },
    { $match: { 'items.mould': { $in: ids }, 'items.photo': { $exists: true, $ne: null } } },
    { $sort: { 'items.photoAt': -1, updatedAt: -1 } },
    { $group: { _id: '$items.mould', photo: { $first: '$items.photo' }, number: { $first: '$number' }, at: { $first: '$items.photoAt' } } },
  ]);
  if (!rows.length) return new Map();
  const files = await Attachment.find({ _id: { $in: rows.map((row) => row.photo) } }).select('key').lean();
  const keyOf = new Map(files.map((file) => [String(file._id), file.key]));
  return new Map(
    rows
      .filter((row) => keyOf.has(String(row.photo)))
      .map((row) => [String(row._id), { key: keyOf.get(String(row.photo)), fromSample: row.number, at: row.at || null }])
  );
}

/**
 * The register's rows with a sample's photo where the register has none. Plain objects in, the
 * same out: a tool with its own photo keeps it, a tool without one wears the latest piece made
 * on it, marked with the sample it came from.
 */
export async function withSamplePhotos(moulds = []) {
  const bare = moulds.filter((mould) => mould && !mould.photo?.key);
  if (!bare.length) return moulds;
  const photos = await latestSamplePhotosByMould(bare.map((mould) => mould._id));
  if (!photos.size) return moulds;
  for (const mould of bare) {
    const found = photos.get(idOf(mould));
    if (found) mould.photo = { key: found.key, fromSample: found.fromSample };
  }
  return moulds;
}

/**
 * The sample the buyer approved on an enquiry, with each model's finished piece and reference
 * — what the order's "sample approved" and "correct colour" checks are made against. The
 * latest approved one; null where none has been.
 */
export async function approvedSampleFor(enquiryId) {
  if (!enquiryId) return null;
  const sample = await Sample.findOne({ enquiry: enquiryId, status: 'approved' })
    .sort({ feedbackAt: -1, updatedAt: -1 })
    .select('number feedbackAt feedbackNote dispatchedColour colour items modelNumber')
    .populate('items.photo', 'key')
    .populate('items.referencePhoto', 'key')
    .lean();
  if (!sample) return null;
  const rows = sample.items?.length ? sample.items : [sample];
  return {
    _id: sample._id,
    number: sample.number,
    approvedAt: sample.feedbackAt || null,
    note: sample.feedbackNote || null,
    colourSent: sample.dispatchedColour || sample.colour || null,
    items: rows.map((row) => ({
      _id: row._id ? String(row._id) : null,
      model: row.modelNumber || null,
      colour: row.colour || null,
      photo: row.photo?.key || null,
      referencePhoto: row.referencePhoto?.key || null,
    })),
  };
}
