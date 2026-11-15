/** An error that maps to one HTTP response: {"error":{"code","message"}} with a stable machine-readable code. */
export class HttpError extends Error {
  status: number;
  code: string;
  headers: Record<string, string>;
  constructor(status: number, code: string, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
export const unauthenticated = () => new HttpError(401, 'unauthenticated', 'Sign in to continue.');
export const invalidCredentials = () => new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');
export const forbidden = (message = 'Your role does not allow this action.') => new HttpError(403, 'forbidden', message);
export const csrfFailed = () => new HttpError(403, 'csrf_failed', 'The CSRF token is missing or wrong. Reload the page and try again.');
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const methodNotAllowed = (allow: string) => new HttpError(405, 'method_not_allowed', 'Method not allowed.', {Allow: allow});
export const conflict = (message: string) => new HttpError(409, 'conflict', message);
export const preconditionFailed = (message: string) => new HttpError(412, 'precondition_failed', message);
export const tooLarge = () => new HttpError(413, 'payload_too_large', 'Request body is too large.');
export const unsupportedMedia = () => new HttpError(415, 'unsupported_media_type', 'Send JSON for this request.');
export const preconditionRequired = (message: string) => new HttpError(428, 'precondition_required', message);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new HttpError(429, 'too_many_requests', 'Too many failed sign-in attempts. Try again later.', {'Retry-After': String(retryAfterSeconds)});
export const unavailable = (message: string) => new HttpError(503, 'unavailable', message);
