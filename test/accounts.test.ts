import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {addAccount} from '../src/accounts.ts';
import {openDatabase} from '../src/db.ts';
import {startApp} from './helpers.ts';

const script = fileURLToPath(new URL('../scripts/create-user.ts', import.meta.url));
const input = {username: 'jordan', role: 'agent', display_name: 'Jordan Reyes', password: 'a long passphrase 42'};

test('an account made with addAccount can sign in; only a scrypt hash of the password is stored', async t => {
  const app = await startApp(t), id = await addAccount(app.db, input), client = app.client();
  assert.equal((await client.login('jordan', input.password)).status, 200);
  assert.equal((await client.login('JORDAN', input.password)).status, 200, 'usernames are not case-sensitive');
  assert.equal((await client.call('/api/session')).body.user.role, 'agent');
  const {password_hash: stored} = app.db.prepare('SELECT password_hash FROM users WHERE id=?').get(id) as {password_hash: string};
  assert.match(stored, /^scrypt\$16384\$8\$1\$/);
  assert.ok(!stored.includes('passphrase'));
});
test('addAccount refuses bad input with a message that says what to fix, and never overwrites an account', async t => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  for (const [change, message] of [[{username: 'j'}, /username/], [{username: 'has space'}, /username/], [{role: 'owner'}, /role must be one of/], [{display_name: ' '}, /display name/], [{password: 'short'}, /at least 12/]] as const)
    await assert.rejects(addAccount(db, {...input, ...change}), message);
  await addAccount(db, input);
  await assert.rejects(addAccount(db, input), /already exists/);
  await assert.rejects(addAccount(db, {...input, username: 'JORDAN', password: 'another long passphrase'}), /already exists/);
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as {n: number}).n, 1);
});
test('the script reads the password from the environment, never from the arguments, and prints nothing secret', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-user-')), path = join(dir, 'r.sqlite');
  t.after(() => rm(dir, {recursive: true, force: true}));
  const run = (args: string[], password: string) => spawnSync(process.execPath, [script, ...args], {env: {...process.env, REQUEST_DB: path, NEW_USER_PASSWORD: password}, encoding: 'utf8'});
  const ok = run(['sam', 'requester', 'Sam Ito'], 'correct horse battery');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Created requester sam/);
  assert.ok(!(ok.stdout + ok.stderr).includes('correct horse'));
  const missing = run(['sam2', 'requester', 'Sam Two'], '');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /NEW_USER_PASSWORD/);
  const again = run(['sam', 'agent', 'Sam Ito'], 'correct horse battery');
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already exists/);
  const usage = spawnSync(process.execPath, [script], {env: {...process.env, REQUEST_DB: path}, encoding: 'utf8'});
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage:/);
  const db = openDatabase(path);
  try { assert.deepEqual(db.prepare('SELECT username,role FROM users').all().map(row => ({...row})), [{username: 'sam', role: 'requester'}]); } finally { db.close(); }
});
