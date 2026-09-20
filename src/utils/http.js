import { serialize } from './serialize.js';

/** Consistent JSON envelope + error plumbing for every endpoint. */

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new ApiError(400, 'BAD_REQUEST', message, details);
export const notFound = (message) => new ApiError(404, 'NOT_FOUND', message);
export const upstream = (message, details) => new ApiError(502, 'UPSTREAM_UNAVAILABLE', message, details);

export function ok(res, data, meta = {}) {
  return res.json({
    data: serialize(data),
    meta: { ...serialize(meta), serverTime: new Date().toISOString() },
  });
}

export const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function createErrorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, next) => {
    const status = error.status || 500;
    if (status >= 500) logger.error(`${req.method} ${req.originalUrl} failed: ${error.message}`, error.stack);
    else logger.warn(`${req.method} ${req.originalUrl} → ${status} ${error.message}`);

    res.status(status).json({
      error: {
        code: error.code || (status === 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED'),
        message:
          status === 500 && process.env.NODE_ENV === 'production'
            ? 'Something went wrong on our side. The travel desk has been notified.'
            : error.message,
        details: error.details || undefined,
        path: req.originalUrl,
        at: new Date().toISOString(),
      },
    });
  };
}
