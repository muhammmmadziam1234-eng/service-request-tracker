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
