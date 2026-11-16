import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {startApp, DEMO_PASSWORD} from './helpers.ts';
import {hashPassword, needsRehash, verifyPassword} from '../src/passwords.ts';

const HOUR = 3_600_000;
const cookieOf = (response: Response) => response.headers.getSetCookie().find(value => value.startsWith('relay_session='))!;
const payload = {title: 'Replace meeting room projector', team: 'IT', description: 'The HDMI port is not working.'};

test('login sets an HttpOnly, SameSite=Strict session cookie and stores only the hash of the token', async t => {
  const app = await startApp(t), client = app.client();
  const response = await client.login('casey');
  assert.equal(response.status, 200);
  const cookie = cookieOf(response);
  assert.match(cookie, /^relay_session=[A-Za-z0-9_-]{43};/, '32 random bytes as base64url');
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']) assert.ok(cookie.includes(attribute), attribute + ' in ' + cookie);
  assert.ok(!cookie.includes('Secure'), 'Secure only when COOKIE_SECURE is set');
  const body = await response.json();
  assert.deepEqual(body.user, {id: body.user.id, username: 'casey', display_name: 'Casey Lee', role: 'requester'});
  assert.match(body.csrf_token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(body).includes('password'));
  const token = cookie.split(';')[0]!.slice('relay_session='.length);
  const rows = app.db.prepare('SELECT token_hash FROM sessions').all() as {token_hash: string}[];
  assert.deepEqual(rows.map(r => r.token_hash), [createHash('sha256').update(token).digest('hex')]);
});
test('the cookie is marked Secure when the deployment says it is served over HTTPS', async t => {
  const app = await startApp(t, {cookieSecure: true});
  assert.match(cookieOf(await app.client().login('riley')), /; Secure/);
});
test('wrong password and unknown user are indistinguishable, and the unknown user still costs a hash comparison', async t => {
  const stored: string[] = [];
  const app = await startApp(t, {verify: async (password, hash) => { stored.push(hash); return verifyPassword(password, hash); }});
  const wrong = await app.client().call('/api/login', {method: 'POST', body: {username: 'casey', password: 'not the password'}, csrf: false});
  const unknown = await app.client().call('/api/login', {method: 'POST', body: {username: 'nobody', password: 'not the password'}, csrf: false});
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown, {...wrong, headers: unknown.headers});
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  assert.equal(stored.length, 2, 'both attempts compared a hash');
  assert.notEqual(stored[0], stored[1], 'the unknown user was compared against a dummy hash');
});
test('login input is validated before any password work', async t => {
  const app = await startApp(t), client = app.client();
  assert.equal((await client.call('/api/login', {method: 'POST', body: {username: 'casey'}})).status, 400);
  assert.equal((await client.call('/api/login', {method: 'POST', body: {username: 5, password: 'x'}})).status, 400);
  assert.equal((await client.call('/api/login', {method: 'POST', body: 'username=casey', headers: {'Content-Type': 'text/plain'}})).status, 415);
});
test('without a session every protected route answers 401 in the standard error shape', async t => {
  const app = await startApp(t), client = app.client();
  for (const [path, method] of [['/api/session', 'GET'], ['/api/requests', 'GET'], ['/api/requests', 'POST'], ['/api/requests/1042', 'GET'], ['/api/logout', 'POST']] as const) {
    const reply = await client.call(path, {method, ...(method === 'POST' ? {body: {}} : {})});
    assert.equal(reply.status, 401, method + ' ' + path);
    assert.equal(reply.body.error.code, 'unauthenticated');
  }
  assert.equal((await client.call('/api/session', {headers: {Cookie: 'relay_session=' + 'A'.repeat(43)}})).status, 401);
});
test('GET /api/session returns the user and the per-session CSRF token', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const reply = await riley.call('/api/session');
  assert.equal(reply.status, 200);
  assert.equal(reply.body.user.role, 'agent');
  assert.equal(reply.body.csrf_token, riley.csrf);
  assert.notEqual((await (await app.login('casey')).call('/api/session')).body.csrf_token, riley.csrf);
});
test('state-changing requests need the CSRF header; a missing or wrong token is 403', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  for (const csrf of [false, 'wrong-token', riley.csrf.slice(1)] as const) {
    const reply = await riley.call('/api/requests', {method: 'POST', body: payload, csrf});
    assert.equal(reply.status, 403);
    assert.equal(reply.body.error.code, 'csrf_failed');
  }
  assert.equal((await riley.call('/api/requests', {method: 'POST', body: payload})).status, 201);
  assert.equal((await riley.call('/api/requests', {method: 'GET', csrf: false})).status, 200, 'reads need no token');
  assert.equal((await riley.call('/api/logout', {method: 'POST', csrf: false})).status, 403);
  assert.equal((await riley.call('/api/session')).status, 200, 'a refused logout leaves the session alone');
});
test('logout invalidates the session on the server and clears the cookie', async t => {
  const app = await startApp(t), casey = await app.login('casey');
  const response = await casey.send('/api/logout', {method: 'POST'});
  assert.equal(response.status, 204);
  assert.match(cookieOf(response), /^relay_session=;.*Max-Age=0/);
  assert.equal((await casey.send('/api/session')).status, 401, 'the old cookie no longer works');
  assert.equal((app.db.prepare('SELECT count(*) AS n FROM sessions').get() as {n: number}).n, 0);
});
test('sessions slide for 8 hours of inactivity but never outlive 24 hours', async t => {
  const app = await startApp(t), casey = await app.login('casey');
  for (const elapsed of [7, 14, 21]) { app.clock.t += 7 * HOUR; assert.equal((await casey.send('/api/session')).status, 200, elapsed + ' h'); }
  app.clock.t += 7 * HOUR;
  assert.equal((await casey.send('/api/session')).status, 401, 'active for 28 h, so the 24 h limit ends it');
  const idle = await app.login('riley');
  app.clock.t += 8 * HOUR - 1;
  assert.equal((await idle.send('/api/session')).status, 200);
  app.clock.t += 8 * HOUR;
  assert.equal((await idle.send('/api/session')).status, 401, 'idle for 8 h');
});
test('the cookie is renewed at most once a minute while the session is in use', async t => {
  const app = await startApp(t), casey = await app.login('casey');
  assert.equal((await casey.send('/api/session')).headers.getSetCookie().length, 0);
  app.clock.t += 2 * 60_000;
  assert.match((await casey.send('/api/session')).headers.getSetCookie()[0] ?? '', /Max-Age=28800/);
});
test('expired rows are removed when they are used, and swept at the next login', async t => {
  const app = await startApp(t), count = () => (app.db.prepare('SELECT count(*) AS n FROM sessions').get() as {n: number}).n;
  const one = await app.login('casey'); await app.login('riley');
  assert.equal(count(), 2);
  app.clock.t += 9 * HOUR;
  assert.equal((await one.send('/api/session')).status, 401);
  assert.equal(count(), 1, 'the expired row that was presented is deleted');
  await app.login('morgan');
  assert.equal(count(), 1, 'the other expired row was swept by the new login');
});
test('five failed logins block that username from that address for 15 minutes, even with the right password', async t => {
  const app = await startApp(t);
  for (let i = 0; i < 5; i++) assert.equal((await app.client().login('casey', 'wrong-' + i)).status, 401);
  const blocked = await app.client().call('/api/login', {method: 'POST', body: {username: 'casey', password: DEMO_PASSWORD}, csrf: false});
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'too_many_requests');
  assert.equal(blocked.headers.get('retry-after'), String(15 * 60));
  assert.equal((await app.client().login('riley')).status, 200, 'other users are unaffected');
  app.clock.t += 15 * 60_000;
  assert.equal((await app.client().login('casey')).status, 200);
});
test('parallel sign-in attempts cannot get around the limit: at most five are checked, and the rest are refused', async t => {
  const app = await startApp(t);
  const attempts = await Promise.all(Array.from({length: 30}, (_, i) =>
    app.client().call('/api/login', {method: 'POST', body: {username: 'riley', password: i === 17 ? DEMO_PASSWORD : 'wrong-' + i}, csrf: false})));
  const checked = attempts.filter(a => a.status !== 429);
  assert.ok(checked.length <= 5, checked.length + ' attempts were checked, the limit is 5');
  assert.equal(attempts.filter(a => a.status === 429).length, 30 - checked.length);
  for (const refused of attempts.filter(a => a.status === 429)) assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal((await app.client().login('casey')).status, 200, 'another user is not affected');
});
test('a hash made with a lower cost is upgraded to the current cost at the next successful sign-in, and only then', async t => {
  const app = await startApp(t), stored = () => (app.db.prepare("SELECT password_hash FROM users WHERE username='casey'").get() as {password_hash: string}).password_hash;
  const cheap = await hashPassword(DEMO_PASSWORD, {N: 2048, r: 8, p: 1});
  app.db.prepare("UPDATE users SET password_hash=? WHERE username='casey'").run(cheap);
  assert.equal((await app.client().login('casey', 'wrong password')).status, 401);
  assert.equal(stored(), cheap, 'a failed sign-in changes nothing');
  assert.equal((await app.client().login('casey')).status, 200);
  assert.notEqual(stored(), cheap);
  assert.equal(needsRehash(stored()), false);
  assert.equal((await app.client().login('casey')).status, 200, 'the new hash verifies');
});
