import type {DatabaseSync} from 'node:sqlite';
import {hashPassword} from './passwords.ts';
import {roles, type Role} from './policy.ts';
import {createUser, findByUsername} from './users.ts';

export interface NewAccount {username: string; role: string; display_name: string; password: string}

/** Creates a real account: validated, scrypt-hashed, never overwriting an existing user. Returns the new user id. */
export async function addAccount(db: DatabaseSync, input: NewAccount): Promise<number> {
  const problems: string[] = [], name = input.display_name.trim();
  if (!/^[a-z][a-z0-9._-]{1,31}$/i.test(input.username)) problems.push('username must be 2 to 32 characters: letters, digits, dot, underscore or hyphen, starting with a letter');
  if (!(roles as readonly string[]).includes(input.role)) problems.push('role must be one of: ' + roles.join(', '));
  if (!name || name.length > 60 || /[\u0000-\u001F\u007F]/.test(name)) problems.push('display name must be 1 to 60 characters with no control characters');
  if (input.password.length < 12 || input.password.length > 200) problems.push('password must be at least 12 and at most 200 characters');
  if (problems.length) throw new Error('Cannot create the account: ' + problems.join('; ') + '.');
  if (findByUsername(db, input.username)) throw new Error(`A user named ${input.username} already exists.`);
  return createUser(db, {username: input.username, display_name: name, role: input.role as Role, passwordHash: await hashPassword(input.password)});
}
