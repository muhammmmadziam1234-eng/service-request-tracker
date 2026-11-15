import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp, demoPasswordHash, type Client} from './helpers.ts';
import {createUser} from '../src/users.ts';

type Actor = 'requester' | 'agent' | 'admin' | 'anonymous';
const actors: Actor[] = ['requester', 'agent', 'admin', 'anonymous'];
const payload = {title: 'Replace meeting room projector', team: 'IT', description: 'The HDMI port is not working.'};
interface Fresh {own: {id: number}; others: {id: number}; rileyId: number}
type Cell = [action: string, run: (who: Client, f: Fresh) => Promise<Response>, expected: Record<Actor, number>];
const row = (requester: number, agent: number, admin: number, anonymous = 401): Record<Actor, number> => ({requester, agent, admin, anonymous});
const patch = (body: unknown) => (who: Client, f: Fresh, target: 'own' | 'others') => who.send('/api/requests/' + f[target].id, {method: 'PATCH', body, revision: 1});

// Every role x action cell. "own" is a request casey opened; "others" belongs to a second requester, dana.
const matrix: Cell[] = [
  ['list requests', who => who.send('/api/requests'), row(200, 200, 200)],
  ['open a request', who => who.send('/api/requests', {method: 'POST', body: payload}), row(201, 201, 201)],
  ['read own request', (who, f) => who.send('/api/requests/' + f.own.id), row(200, 200, 200)],
  ['read another requester\'s request', (who, f) => who.send('/api/requests/' + f.others.id), row(404, 200, 200)],
  ['change status of own request', (who, f) => patch({status: 'Assigned'})(who, f, 'own'), row(403, 200, 200)],
  ['change status of another\'s request', (who, f) => patch({status: 'Assigned'})(who, f, 'others'), row(404, 200, 200)],
  ['change priority of own request', (who, f) => patch({priority: 'High'})(who, f, 'own'), row(403, 200, 200)],
  ['change priority of another\'s request', (who, f) => patch({priority: 'High'})(who, f, 'others'), row(404, 200, 200)],
  ['assign own request', (who, f) => patch({assignee: f.rileyId})(who, f, 'own'), row(403, 200, 200)],
  ['assign another\'s request', (who, f) => patch({assignee: f.rileyId})(who, f, 'others'), row(404, 200, 200)],
  ['comment on own request', (who, f) => who.send('/api/requests/' + f.own.id + '/comments', {method: 'POST', body: {body: 'Hello'}}), row(201, 201, 201)],
  ['comment on another\'s request', (who, f) => who.send('/api/requests/' + f.others.id + '/comments', {method: 'POST', body: {body: 'Hello'}}), row(404, 201, 201)],
  ['list users', who => who.send('/api/users'), row(403, 403, 200)],
  ['list assignees', who => who.send('/api/assignees'), row(403, 200, 200)],
  ['read own session', who => who.send('/api/session'), row(200, 200, 200)]
];

test('role x action matrix: allowed -> 2xx, denied -> 403, other people\'s requests -> 404, anonymous -> 401', async t => {
  const app = await startApp(t);
  createUser(app.db, {username: 'dana', display_name: 'Dana Whitt', role: 'requester', passwordHash: await demoPasswordHash()});
  const clients: Record<Actor, Client> = {requester: await app.login('casey'), agent: await app.login('riley'), admin: await app.login('morgan'), anonymous: app.client()};
  const dana = await app.login('dana');
  const rileyId = (await clients.agent.call('/api/session')).body.user.id;
  for (const [action, run, expected] of matrix) {
    for (const actor of actors) {
      await t.test(`${action}: ${actor} -> ${expected[actor]}`, async () => {
        const own = (await clients.requester.call('/api/requests', {method: 'POST', body: payload})).body;
        const others = (await dana.call('/api/requests', {method: 'POST', body: payload})).body;
        const response = await run(clients[actor], {own, others, rileyId});
        assert.equal(response.status, expected[actor], await response.text());
      });
    }
  }
});
test('a denied write changes nothing: no revision bump, no history entry, no comment', async t => {
  const app = await startApp(t), casey = await app.login('casey'), riley = await app.login('riley');
  const made = (await casey.call('/api/requests', {method: 'POST', body: payload})).body;
  assert.equal((await casey.send('/api/requests/' + made.id, {method: 'PATCH', body: {priority: 'Urgent'}, revision: 1})).status, 403);
  const after = (await riley.call('/api/requests/' + made.id)).body;
  assert.deepEqual([after.revision, after.priority, after.history.length, after.comments.length], [1, 'Normal', 1, 0]);
});
