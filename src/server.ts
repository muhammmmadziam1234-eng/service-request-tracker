import {randomBytes} from 'node:crypto';
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
import {hashPassword, verifyPassword} from './passwords.ts';
import type {Role} from './policy.ts';
import {createStore} from './store.ts';
import {createLoginThrottle, type LoginThrottle} from './throttle.ts';
import {findByUsername, listAssignees, listUsers} from './users.ts';
import {parseChanges, parseComment, parseListQuery, parseNewRequest} from './validate.ts';

const MAX_BODY = 8192;
export interface AppOptions {
  db: DatabaseSync;
  now?: () => number;
  cookieSecure?: boolean;
  throttle?: LoginThrottle;
  verify?: (password: string, stored: string) => Promise<boolean>;
}
export interface RouteInfo {method: string; path: string}
export interface App {server: Server; routes: readonly RouteInfo[]; close(): Promise<void>}

interface Context {
  req: IncomingMessage; res: ServerResponse; params: string[]; url: URL;
  body(): Promise<Record<string, unknown>>;
  send(status: number, value?: unknown, headers?: Record<string, string>): void;
}
type Route = {method: string; path: string; regex: RegExp} & (
  | {access: 'public'; handler: (c: Context) => void | Promise<void>}
  | {access: 'user'; roles?: readonly Role[]; csrf?: boolean; handler: (c: Context, s: ActiveSession) => void | Promise<void>});

const assets: [path: string, file: string, type: string][] = [['/', 'index.html', 'text/html'], ['/app.mjs', 'app.mjs', 'text/javascript'], ['/style.css', 'style.css', 'text/css']];
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
  const throttle = options.throttle ?? createLoginThrottle({now}), sessions = createSessions(db, now), store = createStore(db);
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
  pub('POST', '/api/login', async c => {
    const body = await c.body(), {username, password} = body;
    if (typeof username !== 'string' || !username.trim() || username.length > 64) throw invalid('Username is required.');
    if (typeof password !== 'string' || !password || password.length > 200) throw invalid('Password is required.');
    const key = username.trim().toLowerCase() + '|' + (c.req.socket.remoteAddress ?? 'unknown');
    const decision = throttle.check(key);
    if (!decision.allowed) throw tooManyRequests(decision.retryAfterSeconds);
    const account = findByUsername(db, username.trim());
    const ok = await verify(password, account?.password_hash ?? await getDummyHash());
    if (!account || !ok) { throttle.fail(key); throw invalidCredentials(); }
    throttle.reset(key);
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
      c.res.writeHead(200, {'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff'}).end(content);
    });
  }

  function authenticate(req: IncomingMessage, res: ServerResponse): ActiveSession {
    const token = readCookie(req.headers.cookie, COOKIE_NAME), session = token ? sessions.lookup(token) : null;
    if (!session) throw unauthenticated();
    if (session.renewMaxAge !== null) res.setHeader('Set-Cookie', sessionCookie(token!, session.renewMaxAge, secure));
    return session;
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send: Context['send'] = (status, value, headers = {}) => {
      if (value === undefined) { res.writeHead(status, headers).end(); return; }
      res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}).end(JSON.stringify(value));
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
      const context: Context = {req, res, url, params: route.regex.exec(url.pathname)!.slice(1), body: () => readJson(req), send};
      if (route.access === 'public') { await route.handler(context); return; }
      const session = authenticate(req, res);
      if (method !== 'GET' && route.csrf !== false && !csrfMatches(session.csrfToken, req.headers['x-csrf-token'])) throw csrfFailed();
      if (route.roles && !route.roles.includes(session.user.role)) throw forbidden();
      await route.handler(context, session);
    } catch (error) {
      if (error instanceof HttpError) { send(error.status, {error: {code: error.code, message: error.message}}, error.headers); return; }
      console.error(error);
      send(500, {error: {code: 'internal_error', message: 'The request could not be completed.'}});
    }
  }
  const server = createServer((req, res) => { void handle(req, res); });
  return {
    server,
    routes: routes.map(({method, path}) => ({method, path})),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); })
  };
}
