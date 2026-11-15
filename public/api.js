// @ts-check
// The only place the browser talks to the server. It adds the CSRF token to writes, turns every failure into an
// ApiError with the server's stable code, and never puts a value into HTML.

/** @typedef {{id: number, username: string, display_name: string, role: 'requester' | 'agent' | 'admin'}} User */
/** @typedef {{id: number, display_name: string, role: 'agent' | 'admin'}} Assignee */
/** @typedef {{id: number, title: string, requester: string, requester_id: number | null, team: string, status: string, priority: string,
 *   assignee: number | null, assignee_name: string | null, created_at: string, updated_at: string, revision: number}} RequestSummary */
/** @typedef {{id: number, kind: 'opened' | 'status' | 'assigned' | 'priority' | 'commented', actor_name: string | null, from: string | null, to: string | null, at: string}} HistoryEntry */
/** @typedef {{id: number, author_name: string, author_role: 'requester' | 'agent' | 'admin', body: string, created_at: string}} Comment */
/** @typedef {RequestSummary & {description: string, next: string[], history: HistoryEntry[], comments: Comment[]}} RequestDetail */
/** @typedef {{items: RequestSummary[], total: number, limit: number, offset: number}} RequestPage */
/** @typedef {{user: User, csrf_token: string}} Session */

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 when the server could not be reached
   * @param {string} code the stable error code from the server
   * @param {number | null} retryAfter seconds, from Retry-After
   */
  constructor(message, status, code, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

let csrfToken = '';
/** @param {string} token */
export function setCsrf(token) { csrfToken = token; }

/**
 * @param {string} url
 * @param {{method?: string, body?: unknown, revision?: number}} [options]
 * @returns {Promise<any>} the parsed JSON body, or null for 204
 */
export async function api(url, {method = 'GET', body, revision} = {}) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (revision !== undefined) headers['If-Match'] = '"' + revision + '"';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  let response;
  try {
    response = await fetch(url, {method, headers, credentials: 'same-origin', ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
  } catch {
    throw new ApiError('The server could not be reached. Check your connection and try again.', 0, 'network');
  }
  const text = await response.text();
  /** @type {any} */
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* a non-JSON error page from a proxy */ }
  if (!response.ok) {
    const retry = Number(response.headers.get('Retry-After'));
    throw new ApiError(payload?.error?.message || 'The request could not be completed.', response.status, payload?.error?.code || 'unknown', Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  return payload;
}
