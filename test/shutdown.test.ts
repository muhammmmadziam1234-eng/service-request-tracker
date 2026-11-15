import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {existsSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/config.ts';
import {start} from '../src/run.ts';

const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for ' + what);
}
test('SIGTERM stops the listener, ends cleanly with code 0 and closes the database (the WAL file is gone)', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-shutdown-')), db = join(dir, 'r.sqlite');
  t.after(() => rm(dir, {recursive: true, force: true}));
  const child = spawn(process.execPath, [main], {env: {...process.env, PORT: '0', HOST: '127.0.0.1', REQUEST_DB: db, SEED_DEMO: '0', LOG: 'on'}, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '';
  child.stdout.on('data', (chunk: Buffer) => { out += chunk; });
  t.after(() => { child.kill('SIGKILL'); });
  const url = await waitFor(() => /"url":"([^"]+)"/.exec(out)?.[1], 'the listening line');
  assert.equal((await fetch(url + '/healthz')).status, 200);
  assert.ok(existsSync(db + '-wal'), 'WAL mode is on while the server runs');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.deepEqual([code, signal], [0, null]);
  assert.match(out, /"msg":"shutting down","signal":"SIGTERM"/);
  assert.match(out, /"msg":"stopped"/);
  await assert.rejects(fetch(url + '/healthz'), 'nothing listens any more');
  assert.equal(existsSync(db + '-wal'), false, 'closing the last connection checkpoints and removes the WAL');
});
test('an invalid environment stops the process at start with every problem listed and exit code 1', async () => {
  const child = spawn(process.execPath, [main], {env: {...process.env, PORT: 'abc', LOG: 'loud'}, stdio: ['ignore', 'pipe', 'pipe']});
  let err = '';
  child.stderr.on('data', (chunk: Buffer) => { err += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.match(err, /PORT must be a whole number/);
  assert.match(err, /LOG must be on or off/);
});
test('start() and stop() are in-process: stop closes the listener and the database; LOG=off prints nothing at all', async () => {
  const lines: string[] = [];
  const running = await start(loadConfig({PORT: '0', REQUEST_DB: ':memory:', LOG: 'off', SEED_DEMO: '1'}), {out: line => lines.push(line), err: line => lines.push(line)});
  assert.equal((await fetch(running.url + '/readyz')).status, 200);
  await running.stop();
  assert.equal(running.server.listening, false);
  assert.throws(() => running.db.prepare('SELECT 1'), /not open/);
  assert.deepEqual(lines, []);
});
