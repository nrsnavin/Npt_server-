export default class ApiError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, details);
  }

  static unauthorized(message = 'Not authenticated') {
    return new ApiError(401, message);
  }

  static forbidden(message = 'You do not have access to this resource') {
    return new ApiError(403, message);
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message);
  }

  /*
   * `details` carries what the caller needs to act on the conflict rather than only read about
   * it — the record that already exists, so a screen can offer it instead of asking the person
   * to go and find it. Advice a message gives that nothing on the screen can follow is worse
   * than no advice.
   */
  static conflict(message = 'Conflict', details) {
    return new ApiError(409, message, details);
  }
}
