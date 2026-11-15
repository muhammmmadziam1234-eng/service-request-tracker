import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigError, loadConfig, warnings} from '../src/config.ts';

test('with nothing set the server binds to localhost on 4180 with sensible defaults', () => {
  const config = loadConfig({});
  assert.deepEqual({...config, db: config.db.endsWith('/data/requests.sqlite')}, {port: 4180, host: '127.0.0.1', db: true, cookieSecure: false, log: true, seedDemo: true});
});
test('valid settings are read as written; an empty value counts as unset', () => {
  assert.deepEqual(loadConfig({PORT: '0', HOST: '0.0.0.0', REQUEST_DB: ':memory:', COOKIE_SECURE: '1', LOG: 'off', SEED_DEMO: '0'}),
    {port: 0, host: '0.0.0.0', db: ':memory:', cookieSecure: true, log: false, seedDemo: false});
  assert.equal(loadConfig({PORT: '65535', HOST: '::1'}).port, 65535);
  assert.equal(loadConfig({HOST: 'localhost'}).host, 'localhost');
  assert.deepEqual([loadConfig({PORT: '', LOG: ''}).port, loadConfig({PORT: '', LOG: ''}).log], [4180, true]);
});
test('every bad value is reported at once, naming the variable and what was received', () => {
  const env = {PORT: '80.5', HOST: 'bad host!', COOKIE_SECURE: 'yes', LOG: 'verbose', SEED_DEMO: '2', REQUEST_DB: 'a\u0000b'};
  assert.throws(() => loadConfig(env), (error: unknown) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 6);
    for (const name of Object.keys(env)) assert.ok(error.message.includes(name), name);
    assert.match(error.message, /PORT must be a whole number from 0 to 65535 \(got "80\.5"\)/);
    return true;
  });
  for (const port of ['-1', '65536', 'abc', ' 80', '0x50', '1e3']) assert.throws(() => loadConfig({PORT: port}), ConfigError, port);
});
test('exposing the demo accounts or plain-HTTP cookies beyond localhost produces a warning', () => {
  assert.deepEqual(warnings(loadConfig({})), []);
  assert.deepEqual(warnings(loadConfig({HOST: '0.0.0.0', SEED_DEMO: '0', COOKIE_SECURE: '1'})), []);
  const open = warnings(loadConfig({HOST: '0.0.0.0'}));
  assert.equal(open.length, 2);
  assert.match(open.join('\n'), /demo accounts/);
  assert.match(open.join('\n'), /COOKIE_SECURE/);
});
