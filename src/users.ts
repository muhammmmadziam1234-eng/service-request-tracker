import type {DatabaseSync} from 'node:sqlite';
import type {Role} from './policy.ts';

export interface PublicUser {id: number; username: string; display_name: string; role: Role}
export interface UserRecord extends PublicUser {password_hash: string; created_at: string}

export function findByUsername(db: DatabaseSync, username: string): UserRecord | undefined {
  return db.prepare('SELECT id,username,display_name,role,password_hash,created_at FROM users WHERE username=?').get(username) as UserRecord | undefined;
}
export function usersExist(db: DatabaseSync): boolean {
  return db.prepare('SELECT 1 AS found FROM users LIMIT 1').get() !== undefined;
}
export function createUser(db: DatabaseSync, input: {username: string; display_name: string; role: Role; passwordHash: string}, now: Date = new Date()): number {
  const result = db.prepare('INSERT INTO users(username,display_name,role,password_hash,created_at) VALUES(?,?,?,?,?)')
    .run(input.username, input.display_name, input.role, input.passwordHash, now.toISOString());
  return Number(result.lastInsertRowid);
}

export interface UserListing extends PublicUser {created_at: string}
export function listUsers(db: DatabaseSync): UserListing[] {
  return db.prepare('SELECT id,username,display_name,role,created_at FROM users ORDER BY id').all() as unknown as UserListing[];
}
/** Who a request can be assigned to: agents and admins, by name. */
export function listAssignees(db: DatabaseSync): {id: number; display_name: string; role: Role}[] {
  return db.prepare("SELECT id,display_name,role FROM users WHERE role IN ('agent','admin') ORDER BY display_name").all() as unknown as {id: number; display_name: string; role: Role}[];
}

export function setPasswordHash(db: DatabaseSync, id: number, passwordHash: string): void {
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, id);
}
