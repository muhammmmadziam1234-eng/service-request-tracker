import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {startApp, DEMO_PASSWORD, type Client, type TestApp} from './helpers.ts';

// ajv ships CommonJS; this keeps its types and works under native ESM.
const require = createRequire(import.meta.url);
const {default: Ajv2020} = require('ajv/dist/2020.js') as typeof import('ajv/dist/2020.js');
const {default: addFormats} = require('ajv-formats') as typeof import('ajv-formats');

/* eslint-disable @typescript-eslint/no-explicit-any */
const doc: any = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const DOC = 'https://relay.example/openapi.json';
const ajv = new Ajv2020({strict: true, allErrors: true, allowUnionTypes: true});
addFormats(ajv);
// The document root is an OpenAPI object, not a schema: let strict mode accept its own top-level keywords, and nothing else.
for (const keyword of ['openapi', 'info', 'servers', 'tags', 'paths', 'components']) ajv.addKeyword(keyword);
ajv.addSchema({...doc, $id: DOC});

const resolve = (node: any): any => {
  if (!node?.$ref) return node;
  assert.ok(node.$ref.startsWith('#/'), 'only local references: ' + node.$ref);
  return node.$ref.slice(2).split('/').reduce((at: any, key: string) => { assert.ok(at && key in at, 'dangling $ref ' + node.$ref); return at[key]; }, doc);
};
const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const validator = (ref: string) => { if (!validators.has(ref)) validators.set(ref, ajv.compile({$ref: DOC + ref})); return validators.get(ref)!; };
/** Asserts a value we are about to send is itself valid under the documented request schema. */
const valid = <T>(schema: string, value: T): T => { const check = validator('#/components/schemas/' + schema); assert.ok(check(value), schema + ': ' + ajv.errorsText(check.errors)); return value; };

const operations = new Map<string, {op: any; method: string; path: string}>();
for (const [path, item] of Object.entries<any>(doc.paths))
  for (const [method, op] of Object.entries<any>(item)) if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) {
    assert.ok(op.operationId && !operations.has(op.operationId), 'unique operationId at ' + method + ' ' + path);
    operations.set(op.operationId, {op, method: method.toUpperCase(), path});
  }

/** The response must be one the operation declares, with the declared media type, schema and required headers. */
async function conforms(op: any, response: Response, label: string): Promise<void> {
  const declared = op.responses[String(response.status)];
  assert.ok(declared, `${label}: ${op.operationId} answered ${response.status}, which the contract does not declare`);
  const spec = resolve(declared), text = await response.text();
  if (!spec.content) assert.equal(text, '', label + ': declared as empty');
  else {
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!;
    const media = spec.content[type];
    assert.ok(media, `${label}: content type ${type} is not declared`);
    if (type === 'application/json') {
      assert.ok(media.schema?.$ref, label + ': JSON responses name a component schema');
      const check = validator(media.schema.$ref);
      assert.ok(check(JSON.parse(text)), `${label}: ${ajv.errorsText(check.errors)} in ${text.slice(0, 300)}`);
    } else assert.ok(text.length > 0, label + ': has a body');
  }
  for (const [name, header] of Object.entries<any>(spec.headers ?? {})) {
    const h = resolve(header), value = response.headers.get(name);
    if (h.required) assert.ok(value !== null, `${label}: header ${name} is required`);
    if (value !== null) assert.ok(ajv.compile(h.schema)(value), `${label}: header ${name}=${value}`);
  }
}
type Check = (pending: Promise<Response>, expected: number, label?: string) => Promise<Response>;
const request = {title: 'Replace meeting room projector', team: 'IT', description: 'The HDMI port is not working.'};
const create = async (client: Client) => (await client.call('/api/requests', {method: 'POST', body: valid('NewRequest', request)})).body;

// One scenario per operation: the success path plus every error a client can reasonably provoke.
const scenarios: Record<string, (app: TestApp, check: Check) => Promise<void>> = {
  async healthz(app, check) { await check(app.client().send('/healthz'), 200); },
  async readyz(app, check) { await check(app.client().send('/readyz'), 200); app.db.close(); await check(app.client().send('/readyz'), 503, 'database down'); },
  async openapi(app, check) { const response = await check(app.client().send('/openapi.json'), 200); assert.deepEqual(await response.clone().json().catch(() => doc), doc, 'the served document is the file'); },
  async getIndex(app, check) { await check(app.client().send('/'), 200); },
  async getAppScript(app, check) { await check(app.client().send('/app.mjs'), 200); },
  async getStyles(app, check) { await check(app.client().send('/style.css'), 200); },
  async login(app, check) {
    const anon = app.client();
    await check(anon.send('/api/login', {method: 'POST', body: valid('LoginRequest', {username: 'casey', password: DEMO_PASSWORD})}), 200);
    await check(anon.send('/api/login', {method: 'POST', body: {username: 'casey'}}), 400, 'missing password');
    await check(anon.send('/api/login', {method: 'POST', body: {username: 'casey', password: 'wrong'}}), 401);
    await check(anon.send('/api/login', {method: 'POST', body: 'x', headers: {'Content-Type': 'text/plain'}}), 415);
    await check(anon.send('/api/login', {method: 'POST', body: JSON.stringify({username: 'x'.repeat(9000), password: 'y'})}), 413);
    for (let i = 0; i < 4; i++) await anon.send('/api/login', {method: 'POST', body: {username: 'nobody', password: 'wrong'}});
    await check(anon.send('/api/login', {method: 'POST', body: {username: 'nobody', password: 'wrong'}}), 401, 'fifth failure');
    await check(anon.send('/api/login', {method: 'POST', body: {username: 'nobody', password: 'wrong'}}), 429, 'sixth attempt');
  },
  async logout(app, check) {
    const casey = await app.login('casey'), riley = await app.login('riley');
    await check(riley.send('/api/logout', {method: 'POST', csrf: false}), 403, 'no CSRF token');
    await check(casey.send('/api/logout', {method: 'POST'}), 204);
    await check(casey.send('/api/logout', {method: 'POST'}), 401, 'already signed out');
  },
  async getSession(app, check) {
    const riley = await app.login('riley');
    await check(riley.send('/api/session'), 200);
    await check(app.client().send('/api/session'), 401);
    app.db.close();
    await check(riley.send('/api/session'), 500, 'database down');
  },
  async listRequests(app, check) {
    const riley = await app.login('riley');
    await create(riley);
    await check(riley.send('/api/requests?limit=5&sort=priority&order=desc&status=Open&priority=Normal&assignee=none&q=projector'), 200);
    await check(riley.send('/api/requests?limit=0'), 400);
    await check(app.client().send('/api/requests'), 401);
  },
  async createRequest(app, check) {
    const riley = await app.login('riley');
    await check(riley.send('/api/requests', {method: 'POST', body: valid('NewRequest', {...request, priority: 'High'})}), 201);
    await check(riley.send('/api/requests', {method: 'POST', body: {...request, team: 'Nowhere'}}), 400);
    await check(riley.send('/api/requests', {method: 'POST', body: request, csrf: false}), 403);
    await check(app.client().send('/api/requests', {method: 'POST', body: request}), 401);
    await check(riley.send('/api/requests', {method: 'POST', body: 'x', headers: {'Content-Type': 'text/plain'}}), 415);
    await check(riley.send('/api/requests', {method: 'POST', body: JSON.stringify({...request, description: 'x'.repeat(9000)})}), 413);
  },
  async getRequest(app, check) {
    const riley = await app.login('riley'), casey = await app.login('casey'), made = await create(riley);
    await check(riley.send('/api/requests/' + made.id), 200);
    await check(casey.send('/api/requests/' + made.id), 404, 'someone else\'s request');
    await check(riley.send('/api/requests/99999'), 404);
    await check(app.client().send('/api/requests/' + made.id), 401);
  },
  async updateRequest(app, check) {
    const riley = await app.login('riley'), casey = await app.login('casey'), made = await create(casey), path = '/api/requests/' + made.id;
    const rileyId = (await riley.call('/api/session')).body.user.id;
    await check(riley.send(path, {method: 'PATCH', body: valid('RequestChanges', {status: 'Assigned', priority: 'High', assignee: rileyId}), revision: 1}), 200);
    await check(riley.send(path, {method: 'PATCH', body: {priority: 'Low'}, revision: 1}), 412, 'stale revision');
    await check(riley.send(path, {method: 'PATCH', body: {priority: 'Low'}}), 428, 'no If-Match');
    await check(riley.send(path, {method: 'PATCH', body: {status: 'Completed'}, revision: 2}), 409);
    await check(riley.send(path, {method: 'PATCH', body: {}, revision: 2}), 400, 'empty body');
    await check(casey.send(path, {method: 'PATCH', body: {priority: 'Urgent'}, revision: 2}), 403, 'a requester');
    await check(riley.send('/api/requests/99999', {method: 'PATCH', body: {priority: 'Low'}, revision: 1}), 404);
    await check(riley.send(path, {method: 'PATCH', body: {priority: 'Low'}, revision: 2, csrf: false}), 403, 'no CSRF token');
    await check(app.client().send(path, {method: 'PATCH', body: {priority: 'Low'}, revision: 2}), 401);
    await check(riley.send(path, {method: 'PATCH', body: 'x', headers: {'Content-Type': 'text/plain'}, revision: 2}), 415);
    await check(riley.send(path, {method: 'PATCH', body: JSON.stringify({priority: 'x'.repeat(9000)}), revision: 2}), 413);
  },
  async addComment(app, check) {
    const riley = await app.login('riley'), casey = await app.login('casey'), made = await create(riley), path = '/api/requests/' + made.id + '/comments';
    await check(riley.send(path, {method: 'POST', body: valid('NewComment', {body: 'Looking into it.'})}), 201);
    await check(riley.send(path, {method: 'POST', body: {body: ''}}), 400);
    await check(casey.send(path, {method: 'POST', body: {body: 'Mine?'}}), 404, 'not the requester\'s request');
    await check(riley.send(path, {method: 'POST', body: {body: 'x'}, csrf: false}), 403);
    await check(app.client().send(path, {method: 'POST', body: {body: 'x'}}), 401);
    await check(riley.send(path, {method: 'POST', body: 'x', headers: {'Content-Type': 'text/plain'}}), 415);
    await check(riley.send(path, {method: 'POST', body: JSON.stringify({body: 'x'.repeat(9000)})}), 413);
  },
  async listUsers(app, check) {
    await check((await app.login('morgan')).send('/api/users'), 200);
    await check((await app.login('riley')).send('/api/users'), 403);
    await check(app.client().send('/api/users'), 401);
  },
  async listAssignees(app, check) {
    await check((await app.login('riley')).send('/api/assignees'), 200);
    await check((await app.login('morgan')).send('/api/assignees'), 200);
    await check((await app.login('casey')).send('/api/assignees'), 403);
    await check(app.client().send('/api/assignees'), 401);
  }
};

test('the contract lists exactly the routes the server has, and a scenario for each operation', async t => {
  const app = await startApp(t);
  const served = app.app.routes.map(route => route.method + ' ' + route.path).sort();
  const documented = [...operations.values()].map(({method, path}) => method + ' ' + path).sort();
  assert.deepEqual(served, documented, 'a route is missing from openapi.json, or documented but not served');
  assert.deepEqual(Object.keys(scenarios).sort(), [...operations.keys()].sort(), 'every operation needs a contract scenario');
});
test('the document is self-consistent: every $ref resolves, every operation declares security and a 500', () => {
  const walk = (node: any): void => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') { if (typeof node.$ref === 'string') resolve(node); Object.values(node).forEach(walk); }
  };
  walk(doc);
  assert.equal(doc.openapi, '3.1.0');
  for (const {op, method, path} of operations.values()) {
    assert.ok(op.responses['500'], method + ' ' + path + ' documents 500');
    assert.ok(op.security !== undefined, method + ' ' + path + ' states its security (an empty list means public)');
    for (const requirement of op.security) for (const name of Object.keys(requirement)) assert.ok(doc.components.securitySchemes[name], 'scheme ' + name);
    if (['POST', 'PATCH'].includes(method) && op.security.length) assert.ok(op.security[0].csrfToken, method + ' ' + path + ' needs the CSRF scheme');
  }
});
for (const [operationId, run] of Object.entries(scenarios)) {
  test('contract: ' + operationId, async t => {
    const app = await startApp(t), {op} = operations.get(operationId)!;
    await run(app, async (pending, expected, label = '') => {
      const response = await pending;
      assert.equal(response.status, expected, `${operationId} ${label}`);
      await conforms(op, response.clone(), `${operationId} ${label}`.trim());
      return response;
    });
  });
}
test('unknown paths and wrong methods answer in the documented error shape, with Allow', async t => {
  const app = await startApp(t), notFound = await app.client().send('/nowhere'), wrong = await app.client().send('/api/requests', {method: 'DELETE'});
  for (const response of [notFound, wrong]) assert.ok(validator('#/components/schemas/Error')(await response.json()));
  assert.deepEqual([notFound.status, wrong.status, wrong.headers.get('allow')], [404, 405, 'GET, POST']);
});
