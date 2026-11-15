// Creates a real account in the database named by REQUEST_DB (the same setting the server uses).
// The password comes from the environment, not the command line, so it stays out of shell history and process listings.
// Usage: NEW_USER_PASSWORD='a long passphrase' node scripts/create-user.ts <username> <requester|agent|admin> "<Display name>"
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {addAccount} from '../src/accounts.ts';
import {loadConfig} from '../src/config.ts';
import {openDatabase} from '../src/db.ts';

const [username, role, displayName, ...extra] = process.argv.slice(2);
const fail = (message: string): never => { process.stderr.write(message + '\n'); process.exit(1); };
if (!username || !role || !displayName || extra.length) fail('Usage: NEW_USER_PASSWORD=... node scripts/create-user.ts <username> <requester|agent|admin> "<Display name>"');
const password = process.env['NEW_USER_PASSWORD'];
if (!password) fail('Set NEW_USER_PASSWORD to the new account\'s password (12 characters or more).');
try {
  const {db: path} = loadConfig(process.env);
  if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
  const db = openDatabase(path);
  try { await addAccount(db, {username: username!, role: role!, display_name: displayName!, password: password!}); } finally { db.close(); }
  console.log(`Created ${role} ${username} in ${path}`);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
