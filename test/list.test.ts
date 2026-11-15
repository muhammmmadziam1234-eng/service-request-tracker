import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp, type Client, type TestApp} from './helpers.ts';

const base = {team: 'IT', description: 'Details.'};
interface Seeded {app: TestApp; riley: Client; casey: Client; ids: Record<string, number>}
// Five requests with fixed timestamps: titles A..E, created 1 minute apart; E is the most recently updated.
async function seeded(t: Parameters<typeof startApp>[0]): Promise<Seeded> {
  const app = await startApp(t), riley = await app.login('riley'), casey = await app.login('casey');
  const rileyId = (await riley.call('/api/session')).body.user.id;
  const spec: [string, string, string, string][] = [['A', 'Low', 'IT', 'Printer jam'], ['B', 'Urgent', 'Facilities', 'Broken chair'], ['C', 'Normal', 'IT', 'Badge reader'], ['D', 'High', 'People', 'Starter checklist'], ['E', 'Normal', 'Operations', 'CRM access']];
  const ids: Record<string, number> = {};
  for (const [key, priority, team, title] of spec) {
    const client = key === 'C' ? casey : riley;
    ids[key] = (await client.call('/api/requests', {method: 'POST', body: {...base, team, title, priority}})).body.id;
  }
  await riley.call('/api/requests/' + ids['B'], {method: 'PATCH', body: {assignee: rileyId, status: 'Assigned'}, revision: 1});
  await riley.call('/api/requests/' + ids['D'], {method: 'PATCH', body: {assignee: rileyId}, revision: 1});
  Object.values(ids).forEach((id, i) => app.db.prepare('UPDATE requests SET created_at=?,updated_at=? WHERE id=?').run(`2026-06-10T09:0${i}:00.000Z`, `2026-06-10T10:0${i}:00.000Z`, id));
  return {app, riley, casey, ids};
}
const idsOf = (body: {items: {id: number}[]}, ids: Record<string, number>) => body.items.map(item => Object.entries(ids).find(([, id]) => id === item.id)![0]).join('');

test('the list is a page: items, total, limit and offset, with limit 20 by default', async t => {
  const {riley} = await seeded(t);
  const {status, body} = await riley.call('/api/requests');
  assert.equal(status, 200);
  assert.deepEqual([body.items.length, body.total, body.limit, body.offset], [5, 5, 20, 0]);
});
test('limit and offset page through every request exactly once while total stays put', async t => {
  const {riley, ids} = await seeded(t);
  const seen: string[] = [];
  for (let offset = 0; offset < 6; offset += 2) {
    const {body} = await riley.call(`/api/requests?limit=2&offset=${offset}&sort=created&order=asc`);
    assert.equal(body.total, 5);
    assert.deepEqual([body.limit, body.offset], [2, offset]);
    seen.push(idsOf(body, ids));
  }
  assert.deepEqual(seen, ['AB', 'CD', 'E']);
  assert.deepEqual((await riley.call('/api/requests?limit=2&offset=50')).body.items, []);
});
test('limit must be 1..100 and offset 0 or more; anything else is a 400 naming the problem', async t => {
  const {riley} = await seeded(t);
  assert.equal((await riley.call('/api/requests?limit=100')).status, 200);
  for (const query of ['limit=101', 'limit=0', 'limit=-1', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=x', 'limit=1&limit=2']) {
    const reply = await riley.call('/api/requests?' + query);
    assert.equal(reply.status, 400, query);
    assert.equal(reply.body.error.code, 'validation_failed');
  }
});
test('sort=updated (default, newest first), created and priority, each with order=asc|desc', async t => {
  const {riley, ids} = await seeded(t);
  const order = async (query: string) => idsOf((await riley.call('/api/requests?' + query)).body, ids);
  assert.equal(await order(''), 'EDCBA');
  assert.equal(await order('sort=updated&order=asc'), 'ABCDE');
  assert.equal(await order('sort=created&order=desc'), 'EDCBA');
  assert.equal(await order('sort=created&order=asc'), 'ABCDE');
  assert.equal(await order('sort=priority'), 'BDECA', 'Urgent, High, then Normal (most recently updated first), then Low');
  assert.equal(await order('sort=priority&order=desc'), 'BDECA');
  assert.equal(await order('sort=priority&order=asc'), 'AECDB', 'Low, Normal (ties: most recently updated first), High, Urgent');
  for (const query of ['sort=title', 'order=up', 'sort=priority&sort=updated']) assert.equal((await riley.call('/api/requests?' + query)).status, 400, query);
});
test('filters by status, priority, assignee (an id, or none) and search text, alone and together', async t => {
  const {riley, ids} = await seeded(t);
  const rileyId = (await riley.call('/api/session')).body.user.id;
  const find = async (query: string) => idsOf((await riley.call('/api/requests?sort=created&order=asc&' + query)).body, ids);
  assert.equal(await find('status=Assigned'), 'B');
  assert.equal(await find('priority=Normal'), 'CE');
  assert.equal(await find('assignee=' + rileyId), 'BD');
  assert.equal(await find('assignee=none'), 'ACE');
  assert.equal(await find('q=BADGE'), 'C', 'case-insensitive, matches the title');
  assert.equal(await find('q=facilities'), 'B', 'matches the team');
  assert.equal(await find('q=SR-' + ids['D']), 'D', 'matches the SR number');
  assert.equal(await find('q=casey'), 'C', 'matches the requester name');
  assert.equal(await find('priority=Normal&assignee=none&q=crm'), 'E');
  assert.equal(await find('status=&priority=&assignee=&q='), 'ABCDE', 'empty values mean no filter');
  assert.equal((await riley.call('/api/requests?q=nomatch')).body.total, 0);
  assert.equal((await riley.call('/api/requests?assignee=none&limit=1')).body.total, 3, 'total counts every match, not just the page');
});
test('bad filter values and unknown parameters are refused', async t => {
  const {riley} = await seeded(t);
  for (const query of ['status=Done', 'priority=Huge', 'assignee=riley', 'assignee=0', 'assignee=-3', 'q=' + 'x'.repeat(101), 'colour=red', 'status=Open&status=Assigned'])
    assert.equal((await riley.call('/api/requests?' + query)).status, 400, query);
});
test('a requester\'s filters and totals only ever see their own requests', async t => {
  const {casey, ids} = await seeded(t);
  assert.equal(idsOf((await casey.call('/api/requests')).body, ids), 'C');
  assert.equal((await casey.call('/api/requests?q=printer')).body.total, 0, 'another user\'s title does not match');
  assert.equal((await casey.call('/api/requests?priority=Urgent')).body.total, 0);
});
