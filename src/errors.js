export class ApiError extends Error {
  constructor(code, reason, message) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.reason = reason;
  }
}

export function isNotFound(err) {
  return err instanceof ApiError && err.code === 404;
}

export function isAlreadyExists(err) {
  return err instanceof ApiError && err.code === 409 && err.reason === 'AlreadyExists';
}

export function isConflict(err) {
  return err instanceof ApiError && err.code === 409 && err.reason === 'Conflict';
}
