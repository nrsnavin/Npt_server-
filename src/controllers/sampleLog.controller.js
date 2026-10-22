import { isManagement } from '../utils/departments.js';
import Sample from '../models/Sample.js';
import Customer from '../models/Customer.js';
import Enquiry from '../models/Enquiry.js';
import SampleLog from '../models/SampleLog.js';
import Attachment from '../models/Attachment.js';
import Query, { inTheRoom, seesEveryQuery } from '../models/Query.js';
import ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';
import { ownsRecord } from '../services/ownership.service.js';
import { canRead } from '../services/access.service.js';
import { put, remove, streamOf } from '../services/storage.service.js';
import { listParams, paginated } from '../utils/query.js';
import { CLOSED_SAMPLE_STATUSES } from '../models/Sample.js';
import { canWrite } from '../services/access.service.js';
import { SAMPLE_POPULATE, withRefs } from './sample.controller.js';
import { signatureValid } from '../utils/signedLink.js';
import { safeFilename } from '../services/storage.service.js';
import Mould from '../models/Mould.js';
import {
  checkFinishedPiece, keepReading, keptReading, matchToRegister, pictureOf, readCourierSlip, specWords, visionConfigured,
} from '../services/sampleVision.llm.js';

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

  /* A note that reads as a problem raises the flag the queue and the sweep see [item 11]. */
  const { flagProblemFrom } = await import('../services/sampleProblems.service.js');
  const flagged = await flagProblemFrom(sample, log, req.user).catch(() => null);

  res.status(201).json({ success: true, data: await log.populate(POPULATE), meta: { problem: flagged } });
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
  /* Only Admin deletes [middleware/auth.js `adminOnly`], which the route has already checked. */

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
  /* Only Admin deletes [middleware/auth.js `adminOnly`], which the route has already checked. */

  comment.deleteOne();
  await log.save();

  res.json({ success: true, data: await log.populate(POPULATE) });
});

/**
 * The record a file belongs to, and the field that decides who owns it.
 *
 * Exactly one of these is set on any attachment. Returning the field name alongside the
 * record keeps the ownership rule with the model it applies to — a sample is marketing's
 * through `requestedBy`, everything else through `assignedTo`.
 */
async function ownerOf(attachment) {
  if (attachment.sample) {
    const record = await Sample.findById(attachment.sample);
    return record && { record, ownership: 'requestedBy', module: 'samples' };
  }
  if (attachment.customer) {
    const record = await Customer.findById(attachment.customer);
    return record && { record, ownership: 'assignedTo', module: 'customers' };
  }
  if (attachment.enquiry) {
    const record = await Enquiry.findById(attachment.enquiry);
    return record && { record, ownership: 'assignedTo', module: 'enquiries' };
  }
  return null;
}

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

  /*
   * Access is the owning record's, and a file now hangs off a sample, a customer or an
   * enquiry [§27]. Checking only the sample would have served every customer drawing to
   * anybody holding the key — and the keys are random, but "unguessable" is not a permission
   * model. A file whose owner cannot be resolved is served to nobody.
   */
  /*
   * A part photo off the mould register is the exception, and it is not an ownership question.
   *
   * A mould belongs to nobody — it is the model master [§28], readable by everyone holding the
   * grant, and the photograph of what it makes goes out on the price quote to customers. So the
   * check is the module's, not a record owner's.
   *
   * This is what was wrong: `ownerOf` knew about samples, customers and enquiries, so a photo
   * hanging off a mould resolved to no owner and the route refused it to *everybody*. The
   * register could take a photograph and could never show one — an upload that succeeded and a
   * picture that never appeared, which reads as the upload having silently failed.
   */
  if (attachment.mould) {
    if (!canRead(req.user, 'moulds')) throw ApiError.notFound('File not found');
  } else if (attachment.tradedItem) {
    /* The trading master's photo: whoever may read the master [routes: `tradingRead`]. */
    if (!canRead(req.user, 'materials') && !canRead(req.user, 'pricing')) throw ApiError.notFound('File not found');
  } else if (attachment.task) {
    /* A department task's PDF: whoever may work the task, whoever raised it, the enquiry's owner, Admin. */
    const { default: Todo } = await import('../models/Todo.js');
    const { inDepartment } = await import('../utils/departments.js');
    const task = await Todo.findById(attachment.task).select('department user createdBy enquiry');
    const me = String(req.user._id);
    const enquiry = task?.enquiry ? await Enquiry.findById(task.enquiry).select('assignedTo') : null;
    const mayRead = task && (isManagement(req.user) || inDepartment(req.user, task.department)
      || [task.user, task.createdBy, enquiry?.assignedTo].some((id) => id && String(id) === me));
    if (!mayRead) throw ApiError.notFound('File not found');
  } else if (attachment.salesOrder) {
    /*
     * A sales order's paper — the buyer's PO, a line's print artwork — read as the Production
     * workflow is [productionQueue.controller READERS]: by the plant's departments, who make and
     * print from it, the order team, and a marketing person only on their own buyer's order.
     */
    const { default: SalesOrder } = await import('../models/SalesOrder.js');
    const order = await SalesOrder.findById(attachment.salesOrder).select('assignedTo');
    const mayRead = order && ownsRecord(req.user, order)
      && ['production', 'dispatch', 'quality', 'orders', 'enquiries'].some((moduleKey) => canRead(req.user, moduleKey));
    if (!mayRead) throw ApiError.notFound('File not found');
  } else if (attachment.query) {
    /* A file posted in a query thread is exactly as readable as the thread. */
    const query = await Query.findById(attachment.query).select('raisedBy participants');
    const mayRead = query && canRead(req.user, 'queries') && (seesEveryQuery(req.user) || inTheRoom(query, req.user));
    if (!mayRead) throw ApiError.notFound('File not found');
  } else {
    const owner = await ownerOf(attachment);
    if (!owner) throw ApiError.notFound('File not found');
    /* The record's module as well as its owner — ownership alone narrows only marketing, so
       every account without the grant was served the file. */
    if (!canRead(req.user, owner.module) || !ownsRecord(req.user, owner.record, owner.ownership)) {
      throw ApiError.notFound('File not found');
    }
  }

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

/* ------------------------- The two pictures on each model row ------------------------- */

/**
 * One row of the bag, or a refusal that names it. The bag's rows carry their own ids once
 * saved; a request written the old way, with the model on its top line only, has none.
 */
function rowOf(sample, itemId) {
  const row = sample.items?.id?.(itemId) || null;
  if (!row) throw ApiError.notFound('That model is not in this bag');
  return row;
}

/** The two slots on a row, and who may fill each [the sampling audit, items 1 and 2]. */
const ROW_PHOTOS = {
  /* The finished piece: the bench's, at Sample Ready. Marketing reads it; the bench takes it. */
  photo: { docType: 'finished_photo', title: (row) => `Finished piece — ${row.modelNumber || 'sample'}`, may: (user) => canWrite(user, 'samples'), onSet: (row, user) => { row.photoAt = new Date(); row.photoBy = user._id; }, onClear: (row) => { row.photoAt = undefined; row.photoBy = undefined; } },
  /* The buyer's reference for this model: marketing's, who spoke to the buyer, or the bench's. */
  referencePhoto: { docType: 'reference_photo', title: (row) => `Buyer's reference — ${row.modelNumber || 'sample'}`, may: (user) => canWrite(user, 'samples') || canWrite(user, 'enquiries'), onSet: () => {}, onClear: () => {} },
};

const setRowPhoto = (field) => asyncHandler(async (req, res) => {
  const slot = ROW_PHOTOS[field];
  const sample = await reachableSample(req);
  if (!slot.may(req.user)) throw ApiError.forbidden('You cannot add photos to this sample');
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) throw ApiError.badRequest(`A ${sample.status} sample can no longer take photos`);
  if (!req.file) throw ApiError.badRequest('Attach a photo');
  const row = rowOf(sample, req.params.itemId);
  const previous = row[field];

  const key = await put({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  let attachment;
  try {
    attachment = await Attachment.create({
      key, filename: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size,
      uploadedBy: req.user._id, sample: sample._id, docType: slot.docType, title: slot.title(row),
    });
  } catch (error) {
    await remove(key);
    throw error;
  }

  row[field] = attachment._id;
  slot.onSet(row, req.user);
  /* A new picture is a new question: the old check and match no longer describe it. */
  if (field === 'photo') { row.check = undefined; row.checkAccepted = undefined; }
  if (field === 'referencePhoto') row.match = undefined;
  await sample.save();

  if (previous) {
    const old = await Attachment.findById(previous);
    if (old) {
      await remove(old.key).catch(() => null);
      await old.deleteOne();
    }
  }

  /* The finished piece is checked against the reference as it lands — a line under the photo, never a gate [item 4]. */
  if (field === 'photo' && visionConfigured()) await runCheck(sample, row, { buffer: req.file.buffer, mimeType: req.file.mimetype, attachment }).catch((error) => console.error(`[sample-check] ${error.message}`));

  res.json({ success: true, data: await withRefs(sample), meta: { item: String(row._id), field } });
});

/** The reference a row is checked against: its own, or the request's. */
const referenceFor = (sample, row) => row.referencePhoto || sample.referencePhoto || null;

/** Runs the check for one row and keeps it on the row and on the picture. `finished` is the bytes when the caller has them. */
async function runCheck(sample, row, finished = null) {
  const photo = finished?.attachment || await Attachment.findById(row.photo);
  if (!photo) return null;
  const referenceId = referenceFor(sample, row);
  const reference = referenceId ? await Attachment.findById(referenceId) : null;
  const salt = `check:${reference?._id || 'none'}:${specWords(row)}`;
  let result = await keptReading(photo, 'check', salt);
  if (!result) {
    const bytes = finished?.buffer ? { buffer: finished.buffer, mimeType: finished.mimeType } : await pictureOf(photo);
    result = await checkFinishedPiece({ finished: bytes, reference: reference ? await pictureOf(reference) : null, spec: specWords(row) });
    if (result?.verdict) await keepReading(photo, 'check', result, salt);
  }
  if (!result?.verdict) return result;
  row.check = { verdict: result.verdict, findings: result.findings, summary: result.summary, at: new Date(), reference: reference?._id };
  await sample.save();
  return result;
}

/** Re-run the check on one row — after the reference arrived, or to look again. */
export const checkItemPhoto = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  const row = rowOf(sample, req.params.itemId);
  if (!row.photo) throw ApiError.badRequest('Photograph the finished piece first');
  const result = await runCheck(sample, row);
  res.json({ success: true, data: await withRefs(sample), meta: { item: String(row._id), check: result } });
});

/**
 * The buyer's photo on a row against the mould register [item 3]: three nearest models with a
 * confidence each, or "not one of ours" with what the model saw. Kept on the row and on the
 * picture; a person picks one [pickMatchedModel] — nothing is filled in by itself.
 */
export const matchItemPhoto = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  const row = rowOf(sample, req.params.itemId);
  const referenceId = referenceFor(sample, row);
  if (!referenceId) throw ApiError.badRequest('Add the buyer\'s photo of this model first');
  const reference = await Attachment.findById(referenceId);
  if (!reference) throw ApiError.notFound('The reference photo is missing');
  let result = await keptReading(reference, 'match');
  if (!result || req.query.fresh === 'true') {
    const bytes = await pictureOf(reference);
    result = bytes ? await matchToRegister({ ...bytes, caption: row.modelNumber }) : { candidates: [], none: true, seen: null, problem: 'The picture could not be opened.' };
    if (!result.problem) await keepReading(reference, 'match', result);
  }
  row.match = { candidates: result.candidates, none: result.none, seen: result.seen, at: new Date(), problem: result.problem || undefined };
  await sample.save();
  res.json({ success: true, data: await withRefs(sample), meta: { item: String(row._id), match: result } });
});

/** Tapping one of the matched models fills the row's model from the register — the person's choice, not the model's. */
export const pickMatchedModel = asyncHandler(async (req, res) => {
  const sample = await reachableSample(req);
  if (!canWrite(req.user, 'samples') && !canWrite(req.user, 'enquiries')) throw ApiError.forbidden('You cannot change this sample');
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) throw ApiError.badRequest(`A ${sample.status} sample can no longer be changed`);
  const row = rowOf(sample, req.params.itemId);
  const ref = String(req.body.ref || '');
  const candidate = row.match?.candidates?.find((entry) => entry.ref === ref);
  if (!candidate) throw ApiError.badRequest('Pick one of the models the photo was matched to');
  if (candidate.kind !== 'mould') throw ApiError.badRequest('Only a model on the mould register can be picked onto a sample row');
  const mould = await Mould.findById(candidate.id).select('mouldCode category sizeMm hookType material');
  if (!mould) throw ApiError.notFound('That mould is no longer on the register');
  row.mould = mould._id;
  row.modelNumber = mould.mouldCode;
  /* Matched to a tool on the register, it is no longer a development with no steel. */
  if (row.isNewDevelopment !== undefined) row.isNewDevelopment = false;
  /* The tool says what it makes: its category and size replace the guess typed off the photo. */
  if (mould.category) row.category = mould.category;
  if (mould.sizeMm) row.sizeMm = mould.sizeMm;
  if (!row.material && mould.material) row.material = mould.material;
  /* The first row is the top line, kept in step by the model; say it was picked from the photo. */
  if (String(sample.items[0]?._id) === String(row._id)) { sample.mould = mould._id; sample.modelNumber = mould.mouldCode; }
  sample.statusHistory.push({ from: sample.status, to: sample.status, by: req.user._id, note: `${mould.mouldCode} picked from the buyer's photo (matched at ${Math.round((candidate.confidence || 0) * 100)}%)` });
  await sample.save();
  res.json({ success: true, data: await withRefs(sample) });
});

/** The courier and the AWB read off the courier copy [item 9] — a suggestion the bench checks, into the dispatch fields. */
export const readCourierCopy = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Attach a photo of the courier copy');
  const reading = await readCourierSlip({ buffer: req.file.buffer, mimeType: req.file.mimetype });
  res.json({ success: true, data: reading });
});

const clearRowPhoto = (field) => asyncHandler(async (req, res) => {
  const slot = ROW_PHOTOS[field];
  const sample = await reachableSample(req);
  if (!slot.may(req.user)) throw ApiError.forbidden('You cannot remove photos from this sample');
  if (CLOSED_SAMPLE_STATUSES.includes(sample.status)) throw ApiError.badRequest(`A ${sample.status} sample can no longer be changed`);
  const row = rowOf(sample, req.params.itemId);
  const attachment = row[field] ? await Attachment.findById(row[field]) : null;
  row[field] = undefined;
  slot.onClear(row);
  await sample.save();
  if (attachment) {
    await remove(attachment.key).catch(() => null);
    await attachment.deleteOne();
  }
  res.json({ success: true, data: await withRefs(sample) });
});

/** The finished piece on a model row: taken on the bench at Sample Ready, replaced if retaken. */
export const setItemPhoto = setRowPhoto('photo');
export const clearItemPhoto = clearRowPhoto('photo');
/** The buyer's reference for one model row, beside the finished piece. */
export const setItemReferencePhoto = setRowPhoto('referencePhoto');
export const clearItemReferencePhoto = clearRowPhoto('referencePhoto');

/* The link WhatsApp fetches a sample photo from: signed, lapsing, no session [customerMessage.service `samplePhotoUrl`]. */
export const SAMPLE_PHOTO_LINK = 'sample-photo';

/** A finished-piece photo behind a signed link. The signature is the permission; a bent or lapsed one says only that it expired. */
export const publicSamplePhoto = asyncHandler(async (req, res) => {
  const { id, expires, signature } = req.params;
  if (!signatureValid(SAMPLE_PHOTO_LINK, id, expires, signature)) throw ApiError.notFound('This link has expired.');
  const attachment = await Attachment.findById(id).catch(() => null);
  /* Only a sample's own pictures travel this way — never a buyer's drawing or an order's PO. */
  if (!attachment?.sample || !['finished_photo', 'reference_photo'].includes(attachment.docType)) throw ApiError.notFound('This link has expired.');
  const stream = streamOf(attachment.key);
  if (!stream) throw ApiError.notFound('This link has expired.');
  res.setHeader('Content-Type', attachment.mimeType);
  res.setHeader('Content-Length', attachment.size);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename(attachment.filename || 'sample.jpg', 'sample.jpg')}"`);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

/** Exported for the sample's own doors that answer with the populated record. */
export { SAMPLE_POPULATE };
