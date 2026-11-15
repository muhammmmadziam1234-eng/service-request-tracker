import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {openDatabase} from '../src/db.ts';
import {createStore} from '../src/store.ts';
import {createUser} from '../src/users.ts';
import {startApp} from './helpers.ts';

const payload = {title: 'Replace meeting room projector', team: 'IT' as const, description: 'The HDMI port is not working.'};
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let reply = '';
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    socket.setTimeout(3000, () => socket.destroy(new Error('No reply to: ' + request.split('\r\n')[0])));
    socket.on('data', (chunk: Buffer) => { reply += chunk; }).on('error', reject).on('close', () => resolve(reply));
  });
}
test('create, filter, and advance a request with durable activity', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const created = await riley.send('/api/requests', {method: 'POST', body: payload});
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('etag'), '"1"');
  const item = await created.json(), path = '/api/requests/' + item.id;
  assert.equal(item.history.length, 1);
  assert.equal((await riley.send(path, {method: 'PATCH', body: {status: 'Assigned'}, revision: 1})).status, 200);
  const matching = (await riley.call('/api/requests?status=Assigned&q=projector')).body.items;
  assert.deepEqual(matching.map((x: {id: number}) => x.id), [item.id]);
  const current = (await riley.call(path)).body;
  assert.deepEqual(current.history.map((x: {to: string}) => x.to), ['Open', 'Assigned']);
});
test('invalid input and forbidden transitions do not write activity', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  assert.equal((await riley.send('/api/requests', {method: 'POST', body: {...payload, team: 'Other'}})).status, 400);
  const item = (await riley.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + item.id;
  assert.equal((await riley.send(path, {method: 'PATCH', body: {status: 'Completed'}, revision: 1})).status, 409);
  assert.equal((await riley.call(path)).body.history.length, 1);
  assert.equal((await riley.send('/api/requests/9999')).status, 404);
});
test('a stale write cannot overwrite another tab or append phantom history', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const created = (await riley.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + created.id;
  assert.equal((await riley.send(path, {method: 'PATCH', body: {status: 'Assigned'}})).status, 428);
  const [a, b] = await Promise.all([
    riley.send(path, {method: 'PATCH', body: {status: 'Assigned'}, revision: 1}),
    riley.send(path, {method: 'PATCH', body: {status: 'Assigned'}, revision: 1})
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 412]);
  const get = await riley.send(path);
  assert.equal(get.headers.get('etag'), '"2"');
  assert.deepEqual((await get.json()).history.map((x: {to: string}) => x.to), ['Open', 'Assigned']);
});
test('saved requests and history survive reopening the database', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-test-')), path = join(dir, 'requests.sqlite');
  try {
    let db = openDatabase(path), store = createStore(db);
    const agent = {id: createUser(db, {username: 'riley', display_name: 'Riley Okafor', role: 'agent', passwordHash: 'x'}), username: 'riley', display_name: 'Riley Okafor', role: 'agent' as const};
    const {id} = store.create(agent, {...payload, priority: 'Normal'});
    store.update(agent, id, {status: 'Assigned'}, 1);
    db.close();
    db = openDatabase(path); store = createStore(db);
    try { assert.equal(store.get(agent, id).status, 'Assigned'); assert.equal(store.get(agent, id).history.length, 2); } finally { db.close(); }
  } finally { await rm(dir, {recursive: true, force: true}); }
});
test('a malformed address is a client error, and the server keeps answering', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const reply = await raw(app.port, 'GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  assert.match(reply, /^HTTP\/1\.1 400/);
  assert.match(reply, /Malformed request address/);
  assert.equal((await riley.send('/api/requests')).status, 200);
});
test('a method the route does not offer gets 405 with the methods it does', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const created = (await riley.call('/api/requests', {method: 'POST', body: payload})).body;
  for (const [path, method, allow] of [['/api/requests', 'PUT', 'GET, POST'], ['/api/requests', 'DELETE', 'GET, POST'],
    ['/api/requests/' + created.id, 'DELETE', 'GET, PATCH'], ['/', 'POST', 'GET'], ['/app.js', 'PUT', 'GET']] as [string, string, string][]) {
    const response = await riley.send(path, {method});
    assert.equal(response.status, 405, method + ' ' + path);
    assert.equal(response.headers.get('allow'), allow, method + ' ' + path);
  }
  assert.equal((await riley.send('/nothing-here')).status, 404);
  assert.equal((await riley.send('/api/requests/abc')).status, 404);
});
