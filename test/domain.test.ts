import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp, demoPasswordHash} from './helpers.ts';
import {createUser} from '../src/users.ts';

const payload = {title: 'Replace meeting room projector', team: 'IT', description: 'The HDMI port is not working.'};

test('a request belongs to the person who opened it, defaults to Normal priority, and records who opened it', async t => {
  const app = await startApp(t), casey = await app.login('casey');
  const reply = await casey.call('/api/requests', {method: 'POST', body: payload});
  assert.equal(reply.status, 201);
  const caseyId = (await casey.call('/api/session')).body.user.id;
  const {body} = reply;
  assert.deepEqual([body.requester, body.requester_id, body.priority, body.assignee, body.assignee_name, body.revision], ['Casey Lee', caseyId, 'Normal', null, null, 1]);
  assert.deepEqual(body.next, ['Assigned']);
  assert.deepEqual(body.comments, []);
  assert.deepEqual(body.history.map((h: Record<string, unknown>) => [h['kind'], h['actor_name'], h['from'], h['to']]), [['opened', 'Casey Lee', null, 'Open']]);
  assert.equal(reply.headers.get('etag'), '"1"');
  assert.equal(reply.headers.get('location'), '/api/requests/' + body.id);
});
test('the requester comes from the session: sending one, or any unknown field, is a 400', async t => {
  const app = await startApp(t), casey = await app.login('casey');
  for (const extra of [{requester: 'Someone Else'}, {requester_id: 1}, {status: 'Completed'}]) {
    const reply = await casey.call('/api/requests', {method: 'POST', body: {...payload, ...extra}});
    assert.equal(reply.status, 400);
    assert.equal(reply.body.error.code, 'validation_failed');
    assert.match(reply.body.error.message, /Unknown field/);
  }
  for (const bad of [{title: ''}, {title: 'x'.repeat(101)}, {team: 'Other'}, {description: ' '}, {priority: 'Huge'}, {title: 'line\nbreak'}, {title: 'nul\u0000'}])
    assert.equal((await casey.call('/api/requests', {method: 'POST', body: {...payload, ...bad}})).status, 400, JSON.stringify(bad));
  assert.equal((await casey.call('/api/requests', {method: 'POST', body: {...payload, priority: 'Urgent'}})).body.priority, 'Urgent');
});
test('one PATCH may change status, assignee and priority together: one revision bump, one history entry per change, each with the actor', async t => {
  const app = await startApp(t), casey = await app.login('casey'), riley = await app.login('riley');
  const made = (await casey.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + made.id;
  const rileyId = (await riley.call('/api/session')).body.user.id;
  const reply = await riley.call(path, {method: 'PATCH', body: {status: 'Assigned', assignee: rileyId, priority: 'High'}, revision: 1});
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('etag'), '"2"');
  assert.deepEqual([reply.body.revision, reply.body.status, reply.body.priority, reply.body.assignee, reply.body.assignee_name], [2, 'Assigned', 'High', rileyId, 'Riley Okafor']);
  assert.deepEqual(reply.body.history.map((h: Record<string, unknown>) => [h['kind'], h['actor_name'], h['from'], h['to']]), [
    ['opened', 'Casey Lee', null, 'Open'], ['status', 'Riley Okafor', 'Open', 'Assigned'],
    ['assigned', 'Riley Okafor', null, 'Riley Okafor'], ['priority', 'Riley Okafor', 'Normal', 'High']]);
  const unassigned = await riley.call(path, {method: 'PATCH', body: {assignee: null}, revision: 2});
  assert.equal(unassigned.body.assignee, null);
  assert.deepEqual(unassigned.body.history.at(-1), {...unassigned.body.history.at(-1), kind: 'assigned', from: 'Riley Okafor', to: null});
  assert.equal((await casey.call(path)).body.assignee_name, null, 'the requester sees assignment changes too');
});
test('values that already match are ignored: no new revision, no history; a stale revision is still refused', async t => {
  const app = await startApp(t), riley = await app.login('riley');
  const made = (await riley.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + made.id;
  const same = await riley.call(path, {method: 'PATCH', body: {priority: 'Normal', status: 'Open', assignee: null}, revision: 1});
  assert.deepEqual([same.status, same.body.revision, same.body.history.length], [200, 1, 1]);
  assert.equal((await riley.call(path, {method: 'PATCH', body: {priority: 'Normal'}, revision: 7})).status, 412);
  assert.equal((await riley.call(path, {method: 'PATCH', body: {priority: 'Low'}})).status, 428);
});
test('PATCH rejects empty bodies, unknown fields, bad values and assignees who are not staff', async t => {
  const app = await startApp(t), casey = await app.login('casey'), riley = await app.login('riley');
  const made = (await casey.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + made.id;
  const caseyId = (await casey.call('/api/session')).body.user.id;
  for (const body of [{}, {title: 'new'}, {priority: 'Huge'}, {status: 'Nope'}, {assignee: 'riley'}, {assignee: 1.5}, {assignee: caseyId}, {assignee: 99999}, {assignee: 0}]) {
    const reply = await riley.call(path, {method: 'PATCH', body, revision: 1});
    assert.equal(reply.status, 400, JSON.stringify(body));
    assert.equal(reply.body.error.code, 'validation_failed');
  }
  assert.equal((await riley.call(path, {method: 'PATCH', body: {status: 'Completed'}, revision: 1})).status, 409);
  assert.equal((await riley.call(path)).body.revision, 1);
});
test('comments append without touching the revision, record who wrote them, and move the request up the queue', async t => {
  const app = await startApp(t), casey = await app.login('casey'), riley = await app.login('riley');
  const made = (await casey.call('/api/requests', {method: 'POST', body: payload})).body, path = '/api/requests/' + made.id;
  const first = await riley.call(path + '/comments', {method: 'POST', body: {body: '  Which room?\nSecond line.  '}});
  assert.equal(first.status, 201);
  assert.deepEqual([first.body.author_name, first.body.author_role, first.body.body], ['Riley Okafor', 'agent', 'Which room?\nSecond line.']);
  await casey.call(path + '/comments', {method: 'POST', body: {body: 'Studio B.'}});
  const detail = await casey.call(path);
  assert.deepEqual(detail.body.comments.map((c: {author_name: string}) => c.author_name), ['Riley Okafor', 'Casey Lee']);
  assert.deepEqual([detail.body.revision, detail.headers.get('etag')], [1, '"1"']);
  assert.deepEqual(detail.body.history.map((h: {kind: string}) => h.kind), ['opened', 'commented', 'commented']);
  assert.ok(detail.body.updated_at > made.updated_at || detail.body.updated_at === made.updated_at);
  assert.equal((await riley.call(path, {method: 'PATCH', body: {priority: 'High'}, revision: 1})).status, 200, 'the old revision is still current after comments');
  for (const bad of [{body: ''}, {body: '   '}, {body: 'x'.repeat(2001)}, {body: 5}, {body: 'ok', extra: 1}, {}])
    assert.equal((await casey.call(path + '/comments', {method: 'POST', body: bad})).status, 400, JSON.stringify(bad));
});
test('a requester sees only their own requests, in the list and in the totals; staff see everything', async t => {
  const app = await startApp(t), casey = await app.login('casey'), riley = await app.login('riley');
  createUser(app.db, {username: 'dana', display_name: 'Dana Whitt', role: 'requester', passwordHash: await demoPasswordHash()});
  const dana = await app.login('dana');
  await casey.call('/api/requests', {method: 'POST', body: payload});
  await dana.call('/api/requests', {method: 'POST', body: payload});
  await dana.call('/api/requests', {method: 'POST', body: payload});
  app.db.prepare("INSERT INTO requests(id,title,requester,team,description,status,created_at,updated_at) VALUES(1,'Legacy','Avery Cole','IT','Before accounts existed.','Open','2026-06-01T09:00:00.000Z','2026-06-01T09:00:00.000Z')").run();
  assert.deepEqual([(await casey.call('/api/requests')).body.total, (await dana.call('/api/requests')).body.total, (await riley.call('/api/requests')).body.total], [1, 2, 4]);
  assert.equal((await casey.call('/api/requests/1')).status, 404, 'a request without an owner is not anyone\'s to read');
  assert.equal((await riley.call('/api/requests/1')).status, 200);
  assert.equal((await casey.call('/api/requests?q=legacy')).body.total, 0);
});
test('admins list users without password hashes; agents and admins list who can be assigned', async t => {
  const app = await startApp(t), morgan = await app.login('morgan'), riley = await app.login('riley');
  const users = (await morgan.call('/api/users')).body.items;
  assert.deepEqual(users.map((u: {username: string}) => u.username), ['casey', 'riley', 'morgan']);
  assert.deepEqual(Object.keys(users[0]).sort(), ['created_at', 'display_name', 'id', 'role', 'username']);
  const assignees = (await riley.call('/api/assignees')).body.items;
  assert.deepEqual(assignees.map((u: {display_name: string}) => u.display_name), ['Morgan Brooks', 'Riley Okafor']);
  assert.deepEqual(Object.keys(assignees[0]).sort(), ['display_name', 'id', 'role']);
});
