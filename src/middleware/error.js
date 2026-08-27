import mongoose from 'mongoose';
import { isProduction } from '../config/env.js';
import ApiError from '../utils/ApiError.js';

export function notFoundHandler(req, _res, next) {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  let error = err;

  if (err instanceof mongoose.Error.ValidationError) {
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
    error = new ApiError(err.statusCode || 500, err.message || 'Internal server error');
  }

  if (error.statusCode >= 500) {
    console.error(err);
  }

  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
    ...(isProduction ? {} : { stack: err.stack }),
  });
}
