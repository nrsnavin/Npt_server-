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
    callback(ApiError.badRequest('Attach a PDF or an image'));
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
