import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import type {PublicUser} from './users.ts';

export const COOKIE_NAME = 'relay_session';
export const IDLE_MS = 8 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

export interface ActiveSession {user: PublicUser; csrfToken: string; renewMaxAge: number | null}
export interface Sessions {
  create(userId: number): {token: string; csrfToken: string; maxAge: number};
  lookup(token: string): ActiveSession | null;
  destroy(token: string): void;
}
interface SessionRow {csrf_token: string; created_at: number; last_seen_at: number; id: number; username: string; display_name: string; role: PublicUser['role']}

/** Server-side sessions. The cookie holds 32 random bytes; the table holds only their SHA-256. */
export function createSessions(db: DatabaseSync, now: () => number = Date.now): Sessions {
  const insert = db.prepare('INSERT INTO sessions(token_hash,user_id,csrf_token,created_at,last_seen_at) VALUES(?,?,?,?,?)');
  const find = db.prepare(`SELECT s.csrf_token,s.created_at,s.last_seen_at,u.id,u.username,u.display_name,u.role
    FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`);
  const touch = db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?');
  const remove = db.prepare('DELETE FROM sessions WHERE token_hash=?');
  const sweep = db.prepare('DELETE FROM sessions WHERE last_seen_at<=? OR created_at<=?');
  // The cookie never outlives the session: at most the idle window, and never past the absolute limit.
  const maxAge = (createdAt: number, t: number): number => Math.max(1, Math.floor(Math.min(IDLE_MS, createdAt + ABSOLUTE_MS - t) / 1000));
  return {
    create(userId) {
      const t = now(), token = randomBytes(32).toString('base64url'), csrfToken = randomBytes(32).toString('base64url');
      sweep.run(t - IDLE_MS, t - ABSOLUTE_MS);
      insert.run(sha256(token), userId, csrfToken, t, t);
      return {token, csrfToken, maxAge: maxAge(t, t)};
    },
    lookup(token) {
      if (!TOKEN_SHAPE.test(token)) return null;
      const hash = sha256(token), row = find.get(hash) as SessionRow | undefined;
      if (!row) return null;
      const t = now();
      if (t - row.last_seen_at >= IDLE_MS || t - row.created_at >= ABSOLUTE_MS) { remove.run(hash); return null; }
      let renewMaxAge: number | null = null;
      if (t - row.last_seen_at >= RENEW_AFTER_MS) { touch.run(t, hash); renewMaxAge = maxAge(row.created_at, t); }
      return {user: {id: row.id, username: row.username, display_name: row.display_name, role: row.role}, csrfToken: row.csrf_token, renewMaxAge};
    },
    destroy(token) { if (TOKEN_SHAPE.test(token)) remove.run(sha256(token)); }
  };
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}
export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
export const clearedCookie = (secure: boolean): string => sessionCookie('', 0, secure);

/** Constant-time comparison of the CSRF header with the session's token. */
export function csrfMatches(expected: string, sent: string | string[] | undefined): boolean {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(expected), b = Buffer.from(sent);
  return a.length === b.length && timingSafeEqual(a, b);
}
