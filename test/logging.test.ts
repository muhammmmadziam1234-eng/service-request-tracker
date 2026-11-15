import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp, DEMO_PASSWORD} from './helpers.ts';
import type {LogEvent, RequestLog} from '../src/logger.ts';

async function until(events: LogEvent[], count: number): Promise<void> {
  for (let i = 0; i < 100 && events.length < count; i++) await new Promise(resolve => setTimeout(resolve, 10));
}
test('one line per request: timestamp, id, method, path, status, duration and user id, nothing else', async t => {
  const events: LogEvent[] = [], app = await startApp(t, {log: event => events.push(event)});
  const anonymous = await app.client().send('/healthz');
  const riley = await app.login('riley');
  const reply = await riley.send('/api/requests');
  await until(events, 3);
  assert.equal(events.length, 3);
  const [first, second, last] = events as [RequestLog, RequestLog, RequestLog];
  assert.deepEqual(Object.keys(first).sort(), ['id', 'method', 'ms', 'path', 'status', 'ts', 'user']);
  assert.deepEqual([first.method, first.path, first.status, first.user], ['GET', '/healthz', 200, null]);
  assert.equal(first.id, anonymous.headers.get('x-request-id'));
  assert.ok(!Number.isNaN(Date.parse(first.ts)) && first.ts.endsWith('Z'));
  assert.ok(typeof first.ms === 'number' && first.ms >= 0);
  assert.equal(last.id, reply.headers.get('x-request-id'));
  assert.equal(last.user, (await riley.call('/api/session')).body.user.id);
  assert.equal(second.path, '/api/login');
  assert.equal(second.user, last.user, 'a successful login is attributed to the user who signed in');
});
test('query values, cookies, tokens and passwords never reach the log', async t => {
  const events: LogEvent[] = [], app = await startApp(t, {log: event => events.push(event)});
  const client = app.client();
  await client.login('casey', 'wrong-password-123');
  await client.login('casey', DEMO_PASSWORD);
  await client.send('/api/requests?q=needle-value&status=Open', {});
  await client.send('/api/requests?q=needle-value&status=Open&q2=x');
  await until(events, 4);
  const text = JSON.stringify(events);
  for (const secret of ['needle-value', 'wrong-password-123', DEMO_PASSWORD, client.cookie.split('=')[1]!, client.csrf, 'relay_session', 'Cookie'])
    assert.ok(!text.includes(secret), 'leaked: ' + secret);
  assert.equal((events as RequestLog[])[2]?.path, '/api/requests?q&status', 'parameter names are kept, values are not');
});
test('an unexpected failure is answered with a generic 500 and logged without leaking details to the client', async t => {
  const events: LogEvent[] = [], app = await startApp(t, {log: event => events.push(event)});
  const riley = await app.login('riley');
  app.db.close();   // every query now throws
  const reply = await riley.call('/api/requests');
  assert.equal(reply.status, 500);
  assert.deepEqual(reply.body, {error: {code: 'internal_error', message: 'The request could not be completed.'}});
  await until(events, 3);
  assert.ok(events.some(e => 'level' in e && e.level === 'error' && e.id === reply.headers.get('x-request-id')));
  assert.ok(events.some(e => 'status' in e && e.status === 500));
});
