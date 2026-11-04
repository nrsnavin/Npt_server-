import multer from 'multer';
import ApiError from '../utils/ApiError.js';
import { MAX_BYTES, isAllowed, isAllowedDocument } from '../services/storage.service.js';

/**
 * Accepts one image into memory, for the storage service to write.
 *
 * Memory rather than multer's own disk storage, because the storage service owns where files
 * go — that is what keeps the move to S3 a single-file change. The size limit bounds what a
 * request can hold, so a large upload cannot be used to exhaust the process.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (isAllowed(file.mimetype)) return callback(null, true);
    callback(ApiError.badRequest('Only JPEG, PNG, WebP and HEIC images can be attached'));
  },
});

/**
 * Multer reports its own failures through the error chain, where they arrive as unhelpful
 * codes. Translating here means a file that is too big says so, rather than surfacing as a
 * 500 the user cannot act on.
 */
export const singleImage = (field = 'photo') => (req, res, next) =>
  upload.single(field)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.badRequest(`That image is too large — the limit is ${MAX_BYTES / 1024 / 1024}MB`));
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach one image at a time'));
    }
    return next(error);
  });

/**
 * The same, for a document rather than a photo — a drawing, artwork, a signed approval [§27].
 *
 * A separate uploader rather than a wider filter on the existing one: the sample log takes
 * pictures of a physical thing, and a PDF in that feed is a different kind of object. Keeping
 * the two lists apart means neither has to loosen to accommodate the other.
 */
const documents = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (isAllowedDocument(file.mimetype)) return callback(null, true);
    callback(ApiError.badRequest('Attach a photo, a PDF, or a Word or Excel file'));
  },
});

export const singleDocument = (field = 'file') => (req, res, next) =>
  documents.single(field)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(ApiError.badRequest(`That file is too large — the limit is ${MAX_BYTES / 1024 / 1024}MB`));
    }
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach one file at a time'));
    }
    return next(error);
  });

/**
 * The file sent with a department task — a drawing, a PO, a PI as a PDF, or a photo of one: JPEG,
 * PNG, WebP, HEIC (an iPhone's), GIF, BMP or TIFF. It travels to the department's phones, not into
 * a document archive, so a PDF is one megabyte at most and a photo — which a phone takes at two to
 * four — five.
 */
export const TASK_PDF_BYTES = 1024 * 1024;
export const TASK_PHOTO_BYTES = 5 * 1024 * 1024;
export const TASK_ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/pjpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/gif', 'image/bmp', 'image/tiff'];
const taskAttachments = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TASK_PHOTO_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (TASK_ATTACHMENT_TYPES.includes(file.mimetype)) return callback(null, true);
    callback(ApiError.badRequest('Attach a PDF or a photo (JPEG, PNG, WebP, HEIC)'));
  },
});

export const singlePdf = (field = 'file') => (req, res, next) =>
  taskAttachments.single(field)(req, res, (error) => {
    if (!error) {
      /* The PDF's own limit, under the photo's. */
      if (req.file?.mimetype === 'application/pdf' && req.file.size > TASK_PDF_BYTES) return next(ApiError.badRequest('That PDF is too large — the limit is 1 MB'));
      return next();
    }
    if (error.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('That file is too large — the limit is 1 MB for a PDF, 5 MB for a photo'));
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach one file'));
    }
    return next(error);
  });

/**
 * The work a department uploads to finish a step — the sales order (a PDF), the LR copy (a PDF or
 * a photo of it). One megabyte at most, like every task file; which types a step takes is the
 * workflow's [config/departmentTaskForms.js `resultTypes`], checked by the controller.
 */
export const TASK_RESULT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];
const taskResults = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: TASK_PDF_BYTES, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (TASK_RESULT_TYPES.includes(file.mimetype)) return callback(null, true);
    callback(ApiError.badRequest('Attach a PDF, or a JPEG / PNG photo'));
  },
});

export const singleTaskResult = (field = 'file') => (req, res, next) =>
  taskResults.single(field)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('That file is too large — the limit is 1 MB'));
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Attach one file'));
    }
    return next(error);
  });

/**
 * A spreadsheet for a register import — .xlsx or .csv, read in memory and never stored. Told
 * apart by content in services/sheetRows.js, because browsers send CSV under four different
 * types depending on the machine.
 */
const SHEET_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv', 'application/csv', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream',
];
const sheets = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (SHEET_TYPES.includes(file.mimetype) && /\.(xlsx|csv)$/i.test(file.originalname || '')) return callback(null, true);
    callback(ApiError.badRequest('Upload the list as an Excel (.xlsx) or CSV file'));
  },
});

export const singleSheet = (field = 'file') => (req, res, next) =>
  sheets.single(field)(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') return next(ApiError.badRequest('That file is too large — the limit is 5MB'));
    if (error.code === 'LIMIT_FILE_COUNT' || error.code === 'LIMIT_UNEXPECTED_FILE') {
      return next(ApiError.badRequest('Upload one file at a time'));
    }
    return next(error);
  });
