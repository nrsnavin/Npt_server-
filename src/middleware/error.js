import mongoose from 'mongoose';
import { isProduction } from '../config/env.js';
import ApiError from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let error = err;

  if (err instanceof mongoose.Error.VersionError || err instanceof mongoose.Error.DocumentNotFoundError) {
    error = ApiError.conflict('Someone else changed this record. Reload it and try your change again.');
  } else if (err instanceof mongoose.Error.ValidationError) {
    error = ApiError.badRequest(
      'Validation failed',
      Object.values(err.errors).map((item) => ({ field: item.path, message: item.message }))
    );
  } else if (err instanceof mongoose.Error.CastError) {
    error = ApiError.badRequest(`Invalid value for ${err.path}`);
  } else if (err?.code === 11000) {
    const fields = Object.keys(err.keyValue || {});
    const index = err.message?.match(/index: (\S+)/)?.[1];

    /*
     * Every key null means the index is on fields these documents do not have — almost
     * always one left behind by an earlier schema, or by whatever used the database before.
     * Mongo then sees every document as the same null tuple, so the first save claims it and
     * every save afterwards collides. The symptom is that all creation fails at once, which
     * "a record with this id already exists" does nothing to explain.
     */
    const phantom = fields.length > 0 && fields.every((field) => err.keyValue[field] === null);

    if (phantom) {
      console.error(
        `[db] index ${index || 'unknown'} is unique on ${fields.join(', ')}, which no document sets. ` +
          'Every save will collide. Run: npm run doctor:indexes'
      );
      error = new ApiError(
        500,
        'The database has a leftover unique index on a field this application does not use, ' +
          'so no record can be saved. An administrator can clear it with: npm run doctor:indexes -- --fix'
      );
    } else {
      error = ApiError.conflict(`A record with this ${fields.join(', ') || 'value'} already exists`);
    }
  } else if (!(err instanceof ApiError)) {
    const status = err.statusCode || err.status || 500;
    /*
     * An error nobody wrote for a reader. In production its text is the server's own —
     * "Cannot read properties of undefined (reading 'lines')", a driver message naming a
     * collection — and says more about the code than it tells the person. Logged in full below;
     * the reader gets a sentence. Errors that carry their own status (body-parser's 413, a
     * malformed JSON 400) were written to be read and keep their message.
     */
    const unexpected = status >= 500 && isProduction;
    error = new ApiError(
      status,
      unexpected
        ? `Something went wrong on the server. It has been logged${req.id ? ` (reference ${req.id})` : ''}.`
        : err.message || 'Internal server error'
    );
  }

  if (error.statusCode >= 500) {
    console.error(`[request ${req.id || '-'}] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(isProduction ? {} : { stack: err.stack }),
  });
}
