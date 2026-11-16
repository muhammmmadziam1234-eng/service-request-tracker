import {randomBytes, randomUUID} from 'node:crypto';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import {readFile} from 'node:fs/promises';
import type {DatabaseSync} from 'node:sqlite';
import {
  clearedCookie, COOKIE_NAME, createSessions, csrfMatches, readCookie, sessionCookie, type ActiveSession
} from './auth.ts';
import {
  badRequest, csrfFailed, forbidden, HttpError, invalid, invalidCredentials, methodNotAllowed, notFound,
  tooLarge, tooManyRequests, unauthenticated, unavailable, unsupportedMedia
} from './errors.ts';
import {logPath, type ErrorLog, type RequestLog} from './logger.ts';
import {hashPassword, needsRehash, verifyPassword} from './passwords.ts';
import type {Role} from './policy.ts';
import {createStore} from './store.ts';
import {createLoginThrottle, type LoginThrottle} from './throttle.ts';
import {findByUsername, listAssignees, listUsers, setPasswordHash} from './users.ts';
import {parseChanges, parseComment, parseListQuery, parseNewRequest} from './validate.ts';

const MAX_BODY = 8192;
const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const baseHeaders = (id: string): Record<string, string> => ({
  'X-Request-Id': id, 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer'
});
export interface AppOptions {
  db: DatabaseSync;
  now?: () => number;
  cookieSecure?: boolean;
  throttle?: LoginThrottle;
  verify?: (password: string, stored: string) => Promise<boolean>;
  /** Receives one entry per request (and one per unexpected error). Omit to log nothing. */
  log?: (event: RequestLog | ErrorLog) => void;
}
export interface RouteInfo {method: string; path: string}
export interface App {server: Server; routes: readonly RouteInfo[]; close(graceMs?: number): Promise<void>}

interface Context {
  req: IncomingMessage; res: ServerResponse; params: string[]; url: URL;
  body(): Promise<Record<string, unknown>>;
  /** Attributes the request to a user in the log (login does this once the password is right). */
  setUser(id: number): void;
  send(status: number, value?: unknown, headers?: Record<string, string>): void;
}
type Route = {method: string; path: string; regex: RegExp} & (
  | {access: 'public'; handler: (c: Context) => void | Promise<void>}
  | {access: 'user'; roles?: readonly Role[]; csrf?: boolean; handler: (c: Context, s: ActiveSession) => void | Promise<void>});

const assets: [path: string, file: string, type: string][] = [
  ['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/api.js', 'api.js', 'text/javascript'],
  ['/style.css', 'style.css', 'text/css'], ['/favicon.svg', 'favicon.svg', 'image/svg+xml']
];
// One dummy hash per process: unknown usernames are verified against it so they cost the same time as real ones.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> => (dummyHash ??= hashPassword(randomBytes(16).toString('hex')));

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers['content-type'] || '').split(';')[0]!.trim().toLowerCase() !== 'application/json') throw unsupportedMedia();
  if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { req.resume(); throw tooLarge(); }
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const part of req.iterator({destroyOnReturn: false}) as AsyncIterable<Buffer>) {
    length += part.length;
    if (length > MAX_BODY) { req.resume(); throw tooLarge(); }
    chunks.push(part);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw badRequest('Invalid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw badRequest('Expected a JSON object.');
  return parsed as Record<string, unknown>;
}

export function createApp(options: AppOptions): App {
  const {db} = options, now = options.now ?? Date.now, verify = options.verify ?? verifyPassword, secure = options.cookieSecure ?? false;
  const throttle = options.throttle ?? createLoginThrottle({now}), sessions = createSessions(db, now), store = createStore(db), log = options.log;
  const routes: Route[] = [];
  const compile = (path: string): RegExp => new RegExp('^' + path.replace('{id}', '([0-9]{1,10})') + '$');
  const pub = (method: string, path: string, handler: (c: Context) => void | Promise<void>) => routes.push({method, path, regex: compile(path), access: 'public', handler});
  const user = (method: string, path: string, handler: (c: Context, s: ActiveSession) => void | Promise<void>, extra: {roles?: readonly Role[]; csrf?: boolean} = {}) =>
    routes.push({method, path, regex: compile(path), access: 'user', handler, ...extra});
  const item = (c: Context, status: number, value: {revision: number}, headers: Record<string, string> = {}) => c.send(status, value, {ETag: '"' + value.revision + '"', ...headers});

  // Probes: liveness never touches the database; readiness proves it can answer.
  pub('GET', '/healthz', c => c.send(200, {status: 'ok'}));
  pub('GET', '/readyz', c => {
    try { db.prepare('SELECT 1').get(); } catch { throw unavailable('The database is not answering.'); }
    c.send(200, {status: 'ready'});
  });
  pub('GET', '/openapi.json', async c => {
    const content = await readFile(new URL('../openapi.json', import.meta.url));
    c.res.writeHead(200, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache'}).end(content);
  });
  pub('POST', '/api/login', async c => {
    const body = await c.body(), {username, password} = body;
    if (typeof username !== 'string' || !username.trim() || username.length > 64) throw invalid('Username is required.');
    if (typeof password !== 'string' || !password || password.length > 200) throw invalid('Password is required.');
    const key = username.trim().toLowerCase() + '|' + (c.req.socket.remoteAddress ?? 'unknown');
    const decision = throttle.begin(key);   // counted now, before the slow password check, so parallel attempts cannot all slip through
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds);
    const account = findByUsername(db, username.trim());
    const ok = await verify(password, account?.password_hash ?? await getDummyHash());
    if (!account || !ok) throw invalidCredentials();
    throttle.reset(key);
    c.setUser(account.id);
    if (needsRehash(account.password_hash)) setPasswordHash(db, account.id, await hashPassword(password));   // the cost was raised since this hash was made
    const {token, csrfToken, maxAge} = sessions.create(account.id);
    c.res.setHeader('Set-Cookie', sessionCookie(token, maxAge, secure));
    c.send(200, {user: {id: account.id, username: account.username, display_name: account.display_name, role: account.role}, csrf_token: csrfToken});
  });
  user('POST', '/api/logout', c => {
    const token = readCookie(c.req.headers.cookie, COOKIE_NAME);
    if (token) sessions.destroy(token);
    c.res.setHeader('Set-Cookie', clearedCookie(secure));
    c.send(204);
  });
  user('GET', '/api/session', (c, s) => c.send(200, {user: s.user, csrf_token: s.csrfToken}));
  user('GET', '/api/requests', (c, s) => c.send(200, store.list(s.user, parseListQuery(c.url.searchParams))));
  user('POST', '/api/requests', async (c, s) => {
    const created = store.create(s.user, parseNewRequest(await c.body()));
    item(c, 201, created, {Location: '/api/requests/' + created.id});
  });
  user('GET', '/api/requests/{id}', (c, s) => item(c, 200, store.get(s.user, Number(c.params[0]))));
  user('PATCH', '/api/requests/{id}', async (c, s) => {
    const header = /^"([1-9][0-9]*)"$/.exec(String(c.req.headers['if-match'] ?? '')), revision = header ? Number(header[1]) : null;
    const changes = parseChanges(await c.body());
    item(c, 200, store.update(s.user, Number(c.params[0]), changes, revision !== null && Number.isSafeInteger(revision) ? revision : null));
  });
  user('POST', '/api/requests/{id}/comments', async (c, s) => c.send(201, store.addComment(s.user, Number(c.params[0]), parseComment(await c.body()))));
  user('GET', '/api/users', c => c.send(200, {items: listUsers(db)}), {roles: ['admin']});
  user('GET', '/api/assignees', c => c.send(200, {items: listAssignees(db)}), {roles: ['agent', 'admin']});
  for (const [path, file, type] of assets) {
    pub('GET', path, async c => {
      const content = await readFile(new URL('../public/' + file, import.meta.url));
      c.res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-cache'}).end(content);
    });
  }

  function authenticate(req: IncomingMessage, res: ServerResponse): ActiveSession {
    const token = readCookie(req.headers.cookie, COOKIE_NAME), session = token ? sessions.lookup(token) : null;
    if (!session) throw unauthenticated();
    if (session.renewMaxAge !== null) res.setHeader('Set-Cookie', sessionCookie(token!, session.renewMaxAge, secure));
    return session;
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now(), offered = req.headers['x-request-id'];
    const id = typeof offered === 'string' && REQUEST_ID.test(offered) ? offered : randomUUID();
    let userId: number | null = null;
    for (const [name, value] of Object.entries(baseHeaders(id))) res.setHeader(name, value);
    if (log) res.once('close', () => log({ts: new Date().toISOString(), id, method: req.method ?? '', path: logPath(req.url), status: res.statusCode, ms: Math.round((performance.now() - started) * 10) / 10, user: userId}));
    const send: Context['send'] = (status, value, headers = {}) => {
      if (value === undefined) { res.writeHead(status, {'Cache-Control': 'no-store', ...headers}).end(); return; }
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers}).end(JSON.stringify(value));
    };
    try {
      let url: URL;
      try { url = new URL(req.url ?? '/', 'http://localhost'); } catch { throw badRequest('Malformed request address.'); }
      const method = req.method ?? 'GET', matches = routes.filter(route => route.regex.test(url.pathname));
      const route = matches.find(candidate => candidate.method === method);
      if (!route) {
        if (matches.length) throw methodNotAllowed([...new Set(matches.map(m => m.method))].sort().join(', '));
        throw notFound();
      }
      const context: Context = {req, res, url, params: route.regex.exec(url.pathname)!.slice(1), body: () => readJson(req), send, setUser: user => { userId = user; }};
      if (route.access === 'public') { await route.handler(context); return; }
      const session = authenticate(req, res);
      userId = session.user.id;
      if (method !== 'GET' && route.csrf !== false && !csrfMatches(session.csrfToken, req.headers['x-csrf-token'])) throw csrfFailed();
      if (route.roles && !route.roles.includes(session.user.role)) throw forbidden();
      await route.handler(context, session);
    } catch (error) {
      if (error instanceof HttpError) { send(error.status, {error: {code: error.code, message: error.message}}, error.headers); return; }
      log?.({ts: new Date().toISOString(), level: 'error', id, message: error instanceof Error ? error.message : String(error)});
      send(500, {error: {code: 'internal_error', message: 'The request could not be completed.'}});
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  // Slow-header and slow-body clients are cut off instead of holding a socket open.
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  // A request Node cannot even parse never reaches handle(); answer it in the same shape, with the same headers.
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return;
    const id = randomUUID(), body = JSON.stringify({error: {code: 'bad_request', message: 'The request could not be parsed.'}});
    const headers = {...baseHeaders(id), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(Buffer.byteLength(body)), Connection: 'close'};
    socket.end('HTTP/1.1 400 Bad Request\r\n' + Object.entries(headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n' + body);
    log?.({ts: new Date().toISOString(), id, method: '-', path: '(unparsed)', status: 400, ms: 0, user: null});
  });
  return {
    server,
    routes: routes.map(({method, path}) => ({method, path})),
    close: (graceMs = 5000) => new Promise<void>(resolve => {
      const force = setTimeout(() => server.closeAllConnections(), graceMs);
      force.unref();
      server.close(() => { clearTimeout(force); resolve(); });
      server.closeIdleConnections();
    })
  };
}
