import Sample from '../models/Sample.js';
import SampleLog from '../models/SampleLog.js';
import Attachment from '../models/Attachment.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { put, remove, streamOf } from '../services/storage.service.js';
import { listParams, paginated } from '../utils/query.js';

/**
 * The sample's working record: notes, photos, and comments on either.
 *
 * Who may take part is deliberately wider than who may change the sample. Marketing holds
 * only `samples` read, and marketing is exactly who needs to look at a photo of the first
 * shot and say the shoulder is wrong. Gating this on write would put the conversation back
 * in WhatsApp, which is the thing it exists to replace — so reading the sample is enough to
 * join in, and the record-level ownership rule still decides which samples that is.
 */

const POPULATE = [
  { path: 'author', select: 'name department' },
  { path: 'comments.author', select: 'name department' },
  { path: 'attachment', select: 'key filename mimeType size' },
];

/** Loads the sample and refuses anyone who may not see it. */
async function reachableSample(req) {
  const sample = await Sample.findById(req.params.id);
  if (!sample) throw ApiError.notFound('Sample not found');
  if (!ownsRecord(req.user, sample, 'requestedBy')) throw ApiError.notFound('Sample not found');
  return sample;
}

/**
 * A page of the feed, newest first.
 *
 * Paged rather than whole because this is the one list with no natural ceiling: a sample that
 * ran through six attempts collects dozens of entries, most of them carrying a photograph
 * taken on a phone. Returning all of them made opening a sample download every picture ever
 * attached to it before anything appeared.
 *
 * Small default: the feed is read from the top, and the entries worth seeing on arrival are
 * the last few. The rest are one click away.
 */
export const listSampleLogs = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  const { page, limit } = listParams(req.query, { defaultLimit: 15 });

  const filter = { sample: sample._id };
  const [data, total] = await Promise.all([
    SampleLog.find(filter)
      .populate(POPULATE)
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit),
    SampleLog.countDocuments(filter),
  ]);

  paginated(res, data, { page, limit, total });
});

/**
 * Adds a note, a photo, or a photo with something written on it.
 *
 * The file and the log entry are written together: an attachment with no entry would be a
 * file nobody can reach, so a failure after the upload removes what was stored rather than
 * leaving it behind.
 */
export const addSampleLog = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  const body = req.body.body?.trim();

  if (!req.file && !body) throw ApiError.badRequest('Write something, or attach a photo');

  let attachment = null;
  if (req.file) {
    const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
    try {
      attachment = await Attachment.create({
        key,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        uploadedBy: req.user._id,
        sample: sample._id,
      });
    } catch (error) {
      await remove(key);
      throw error;
    }
  }

  const log = await SampleLog.create({
    sample: sample._id,
    author: req.user._id,
    kind: attachment ? 'photo' : 'note',
    body,
    attachment: attachment?._id,
  });

  res.status(201).json({ success: true, data: await log.populate(POPULATE) });
});

/** A comment, on a photo or on a note. */
export const addLogComment = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);

  const log = await SampleLog.findOne({ _id: req.params.logId, sample: sample._id });
  if (!log) throw ApiError.notFound('That entry is not on this sample');

  log.comments.push({ author: req.user._id, body: req.body.body.trim() });
  await log.save();

  res.status(201).json({ success: true, data: await log.populate(POPULATE) });
});

/**
 * Removes an entry.
 *
 * Only its author, and only their own — a log people can edit each other's is not a record.
 * The stored file goes with it, since nothing else can reach it once the entry is gone.
 */
export const removeSampleLog = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);

  const log = await SampleLog.findOne({ _id: req.params.logId, sample: sample._id });
  if (!log) throw ApiError.notFound('That entry is not on this sample');
  if (String(log.author) !== String(req.user._id) && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who wrote it can remove it');
  }

  if (log.attachment) {
    const attachment = await Attachment.findById(log.attachment);
    if (attachment) {
      await remove(attachment.key);
      await attachment.deleteOne();
    }
  }

  await log.deleteOne();
  res.json({ success: true, data: { removed: true } });
});

export const removeLogComment = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);

  const log = await SampleLog.findOne({ _id: req.params.logId, sample: sample._id });
  if (!log) throw ApiError.notFound('That entry is not on this sample');

  const comment = log.comments.id(req.params.commentId);
  if (!comment) throw ApiError.notFound('That comment is not on this entry');
  if (String(comment.author) !== String(req.user._id) && req.user.role !== 'admin') {
    throw ApiError.forbidden('Only the person who wrote it can remove it');
  }

  comment.deleteOne();
  await log.save();

  res.json({ success: true, data: await log.populate(POPULATE) });
});

/**
 * Serves a stored file.
 *
 * The key alone is not authority. Every file hangs off a record, and the caller is checked
 * against that record before a byte is sent — a photo of a buyer's sample is exactly as
 * confidential as the sample it is of.
 */
export const downloadAttachment = asyncHandler(async (req, res) => {
  const attachment = await Attachment.findOne({ key: req.params.key });
  if (!attachment) throw ApiError.notFound('File not found');

  const sample = await Sample.findById(attachment.sample);
  if (!sample) throw ApiError.notFound('File not found');
  if (!ownsRecord(req.user, sample, 'requestedBy')) throw ApiError.notFound('File not found');

  const stream = streamOf(attachment.key);
  if (!stream) throw ApiError.notFound('File not found');

  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Length', attachment.size);
  // Private: this passed an ownership check, so no shared cache may keep a copy.
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.filename || 'photo')}"`);

  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/**
 * The reference photo on the sample itself — what the buyer asked for, as opposed to the
 * log, which is what the bench produced. Replacing it removes what it replaced, since
 * nothing else points at the old file.
 */
export const setReferencePhoto = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  if (!req.file) throw ApiError.badRequest('Attach a photo');

  const previous = sample.referencePhoto;

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key,
      filename: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      uploadedBy: req.user._id,
      sample: sample._id,
    });
  } catch (error) {
    await remove(key);
    throw error;
  }

  sample.referencePhoto = attachment._id;
  await sample.save();

  if (previous) {
    const old = await Attachment.findById(previous);
    if (old) {
      await remove(old.key);
      await old.deleteOne();
    }
  }

  res.json({ success: true, data: await sample.populate({ path: 'referencePhoto', select: 'key filename mimeType size' }) });
});

export const clearReferencePhoto = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  if (!sample.referencePhoto) return res.json({ success: true, data: sample });

  const attachment = await Attachment.findById(sample.referencePhoto);
  sample.referencePhoto = undefined;
  await sample.save();

  if (attachment) {
    await remove(attachment.key);
    await attachment.deleteOne();
  }

  res.json({ success: true, data: sample });
});
