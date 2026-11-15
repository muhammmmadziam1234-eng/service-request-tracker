import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {startApp} from './helpers.ts';

const CSP = "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    socket.setTimeout(3000, () => socket.destroy(new Error('No reply')));
    socket.on('data', (chunk: Buffer) => { reply += chunk; }).on('error', reject).on('close', () => resolve(reply));
  });
}
test('every kind of response carries the security headers and a request id', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const ids = new Set<string | null>();
  const cases: [string, Promise<Response>][] = [
    ['page', app.client().send('/')], ['stylesheet', app.client().send('/style.css')], ['probe', app.client().send('/healthz')],
    ['401', app.client().send('/api/requests')], ['200', riley.send('/api/requests')], ['201', riley.send('/api/requests', {method: 'POST', body: {title: 'T', team: 'IT', description: 'D'}})],
    ['400', riley.send('/api/requests?limit=0')], ['403', riley.send('/api/users')], ['404', riley.send('/api/requests/9999')],
    ['404 route', app.client().send('/nope')], ['405', app.client().send('/', {method: 'POST', body: {}})], ['415', app.client().send('/api/login', {method: 'POST', body: 'x', headers: {'Content-Type': 'text/plain'}})]
  ];
  for (const [label, pending] of cases) {
    const response = await pending;
    assert.equal(response.headers.get('content-security-policy'), CSP, label);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', label);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', label);
    assert.match(response.headers.get('x-request-id') ?? '', /^[A-Za-z0-9._-]{1,64}$/, label);
    ids.add(response.headers.get('x-request-id'));
    await response.arrayBuffer();
  }
  assert.equal(ids.size, cases.length, 'each response has its own id');
});
test('everything under /api (and the probes) is no-store; the pages are revalidated, never cached blindly', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  for (const response of [await riley.send('/api/requests'), await app.client().send('/api/requests'), await riley.send('/api/requests/9999'), await app.client().send('/api/nope'), await app.client().send('/healthz'), await app.client().send('/readyz')])
    assert.equal(response.headers.get('cache-control'), 'no-store', response.url);
  assert.equal((await app.client().send('/')).headers.get('cache-control'), 'no-cache');
});
test('a request id from the caller is kept if it is plain, and replaced if it could confuse a log', async t => {
  const app = await startApp(t), client = app.client();
  assert.equal((await client.send('/healthz', {headers: {'X-Request-Id': 'trace-123.abc_DEF'}})).headers.get('x-request-id'), 'trace-123.abc_DEF');
  for (const bad of ['has space', 'x'.repeat(65), 'quote"inside', '{"json":1}']) {
    const id = (await client.send('/healthz', {headers: {'X-Request-Id': bad}})).headers.get('x-request-id');
    assert.notEqual(id, bad);
    assert.match(id ?? '', /^[0-9a-f-]{36}$/);
  }
});
test('even a request Node itself refuses (not valid HTTP) gets the headers and the standard error body', async t => {
  const app = await startApp(t);
  const reply = await raw(app.port, 'THIS IS NOT HTTP\r\n\r\n');
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.match(reply, /content-security-policy: default-src 'self'/i);
  assert.match(reply, /x-request-id: /i);
  assert.match(reply, /"code":"bad_request"/);
});
