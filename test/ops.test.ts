import test from 'node:test';
import assert from 'node:assert/strict';
import {startApp} from './helpers.ts';

test('/healthz answers 200 to anyone, without touching the database', async t => {
  const app = await startApp(t), client = app.client();
  app.db.close();
  const reply = await client.call('/healthz');
  assert.deepEqual([reply.status, reply.body], [200, {status: 'ok'}]);
  assert.equal(reply.headers.get('cache-control'), 'no-store');
});
test('/readyz is 200 while the database answers and 503 in the standard error shape when it does not', async t => {
  const app = await startApp(t), client = app.client();
  assert.deepEqual((await client.call('/readyz')).body, {status: 'ready'});
  app.db.close();
  const down = await client.call('/readyz');
  assert.equal(down.status, 503);
  assert.equal(down.body.error.code, 'unavailable');
});
test('the probes accept GET only', async t => {
  const app = await startApp(t), client = app.client();
  for (const path of ['/healthz', '/readyz']) {
    const reply = await client.send(path, {method: 'POST', body: {}});
    assert.equal(reply.status, 405);
    assert.equal(reply.headers.get('allow'), 'GET');
  }
  assert.equal((await client.send('/healthz/extra')).status, 404);
});
