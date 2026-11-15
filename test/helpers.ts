import {once} from 'node:events';
import type {TestContext} from 'node:test';
import type {AddressInfo} from 'node:net';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db.ts';
import {hashPassword} from '../src/passwords.ts';
import {DEMO_PASSWORD, seedDemoUsers} from '../src/seed.ts';
import {createApp, type App, type AppOptions} from '../src/server.ts';

export {DEMO_PASSWORD};
let demoHash: Promise<string> | undefined;
/** One scrypt run per test process; every test database reuses the demo password hash. */
export const demoPasswordHash = (): Promise<string> => (demoHash ??= hashPassword(DEMO_PASSWORD));

export interface SendOptions {
  method?: string; body?: unknown; revision?: number; csrf?: string | false; headers?: Record<string, string>; cookie?: boolean;
}
/** A tiny cookie-jar client: remembers the session cookie and CSRF token after login(). */
export class Client {
  origin: string;
  cookie = '';
  csrf = '';
  constructor(origin: string) { this.origin = origin; }
  send(path: string, {method = 'GET', body, revision, csrf, headers = {}, cookie = true}: SendOptions = {}): Promise<Response> {
    const sent: Record<string, string> = {...headers};
    if (body !== undefined) sent['Content-Type'] ??= 'application/json';
    if (revision !== undefined) sent['If-Match'] = '"' + revision + '"';
    if (cookie && this.cookie) sent['Cookie'] = this.cookie;
    const token = csrf === undefined ? this.csrf : csrf;
    if (token) sent['X-CSRF-Token'] = token;
    return fetch(this.origin + path, {method, headers: sent, ...(body !== undefined ? {body: typeof body === 'string' ? body : JSON.stringify(body)} : {})});
  }
  /** Sends the request and returns the status, parsed JSON body and headers in one object. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async call(path: string, options: SendOptions = {}): Promise<{status: number; body: any; headers: Headers}> {
    const response = await this.send(path, options);
    const text = await response.text();
    return {status: response.status, body: text ? JSON.parse(text) : undefined, headers: response.headers};
  }
  async login(username: string, password: string = DEMO_PASSWORD): Promise<Response> {
    const response = await this.send('/api/login', {method: 'POST', body: {username, password}, csrf: false});
    const cookie = response.headers.getSetCookie().find(value => value.startsWith('relay_session='));
    if (response.ok && cookie) {
      this.cookie = cookie.split(';')[0]!;
      this.csrf = ((await response.clone().json()) as {csrf_token: string}).csrf_token;
    }
    return response;
  }
}

export interface TestApp {
  origin: string; port: number; db: DatabaseSync; app: App; clock: {t: number};
  client(): Client;
  login(username: string): Promise<Client>;
}
export async function startApp(t: TestContext, options: Partial<AppOptions> = {}): Promise<TestApp> {
  const db = openDatabase(':memory:');
  seedDemoUsers(db, await demoPasswordHash());
  const clock = {t: Date.parse('2026-06-10T09:00:00.000Z')};
  const app = createApp({db, now: () => clock.t, ...options});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const port = (app.server.address() as AddressInfo).port, origin = 'http://127.0.0.1:' + port;
  t.after(async () => { await app.close(); db.close(); });
  return {
    origin, port, db, app, clock,
    client: () => new Client(origin),
    async login(username) {
      const client = new Client(origin), response = await client.login(username);
      if (!response.ok) throw new Error('Demo login failed for ' + username + ': ' + response.status);
      return client;
    }
  };
}
