import test, {after, before, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import type {Browser, Page} from 'playwright-core';
import {DEMO_PASSWORD, fitsWidth, launch, openPage, serve, signIn, violations} from './harness.ts';

let browser: Browser;
before(async () => { browser = await launch(); });
after(async () => { await browser.close(); });

async function setup(t: TestContext, username?: string, viewport = {width: 1280, height: 800}) {
  const {origin} = await serve(t), context = await browser.newContext({viewport});
  t.after(() => context.close());
  const opened = await openPage(context);
  if (username) await signIn(opened.page, origin, username);
  return {origin, context, ...opened};
}
const ids = (page: Page) => page.locator('#requests button.row').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset['id']));
test('signing in: a wrong password gets one generic message, the right one opens the queue', async t => {
  const {origin, page, problems} = await setup(t);
  await page.goto(origin + '/');
  await page.getByLabel('Username').fill('riley');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.getByRole('alert').filter({hasText: 'Incorrect username or password.'}).waitFor();
  assert.equal(await page.getByRole('heading', {name: 'Service requests'}).count(), 0, 'still signed out');
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.getByRole('heading', {name: 'Service requests', level: 1}).waitFor();
  assert.match(await page.locator('#user').innerText(), /Riley Okafor.*Agent/);
  await page.reload();
  await page.getByRole('heading', {name: 'Service requests', level: 1}).waitFor();   // the cookie survives a reload
  assert.deepEqual(problems, []);
});
test('a requester sees only their own requests, can open a new one, and has no agent controls', async t => {
  const {page, problems} = await setup(t, 'casey');
  assert.deepEqual(await ids(page), ['1046', '1047', '1045'], 'only the three requests casey opened, latest activity first');
  assert.equal(await page.getByText('SR-1044').count(), 0);
  assert.match(await page.locator('#count').innerText(), /3 requests/);
  const record = page.locator('#record');
  await record.getByRole('heading', {level: 2}).waitFor();
  assert.equal(await record.getByRole('button', {name: 'Save changes'}).count(), 0, 'no update form');
  assert.equal(await record.getByLabel('Assignee').count(), 0);
  assert.equal(await page.locator('#assignee-filter').isVisible(), false, 'no assignee filter');
  assert.equal(await record.getByLabel('Add a comment').count(), 1, 'but they can comment on their own request');
  await page.getByRole('button', {name: '+ New request'}).click();
  const dialog = page.locator('#create');
  await dialog.getByLabel('Request title').fill('Replace the broken desk lamp');
  await dialog.getByLabel('Team').selectOption('Facilities');
  await dialog.getByLabel('Priority').selectOption('Low');
  await dialog.getByLabel('Description').fill('The lamp at desk B12 flickers and then goes out.');
  await dialog.getByRole('button', {name: 'Create request'}).click();
  await record.getByRole('heading', {name: 'Replace the broken desk lamp'}).waitFor();
  await page.locator('#message', {hasText: 'created'}).waitFor();
  assert.equal((await ids(page))[0], '1048', 'the new request leads the queue');
  assert.match(await record.innerText(), /Requester\s+Casey Lee/);
  const status = await page.evaluate(async () => (await fetch('/api/requests/1044')).status);
  assert.equal(status, 404, 'a request that is not theirs does not exist for them');
  assert.deepEqual(problems, []);
});
test('an agent changes priority, assignee and status together, then comments', async t => {
  const {page, problems} = await setup(t, 'riley');
  await page.locator('button.row[data-id="1045"]').click();
  const record = page.locator('#record');
  await record.getByRole('heading', {name: 'Book a room for the Friday planning session'}).waitFor();
  await record.getByLabel('Priority').selectOption('High');
  await record.getByLabel('Assignee').selectOption({label: 'Morgan Brooks'});
  await record.getByLabel('Status').selectOption('Assigned');
  await record.getByRole('button', {name: 'Save changes'}).click();
  await page.locator('#message', {hasText: 'SR-1045 updated.'}).waitFor();
  const text = await record.innerText();
  for (const expected of [/Open → Assigned/, /Assigned to Morgan Brooks/, /Priority Normal → High/, /Riley Okafor/]) assert.match(text, expected);
  assert.match(await page.locator('button.row[data-id="1045"]').innerText(), /High priority · Morgan Brooks/);
  // A second save straight afterwards must carry the new revision, or the server would answer 412 and nothing would change.
  await record.getByLabel('Priority').selectOption('Urgent');
  await record.getByRole('button', {name: 'Save changes'}).click();
  await record.locator('.record-head .pill.priority-urgent').waitFor();
  assert.match(await page.locator('button.row[data-id="1045"]').innerText(), /Urgent priority · Morgan Brooks/);
  await record.getByLabel('Add a comment').fill('Booked the large room on level 2.');
  await record.getByRole('button', {name: 'Post comment'}).click();
  await page.locator('#message', {hasText: 'Comment added'}).waitFor();
  assert.match(await record.locator('.thread').innerText(), /Riley Okafor[\s\S]*Booked the large room on level 2\./);
  assert.deepEqual(problems, []);
});
test('two browsers editing the same request: the second gets the conflict message and the fresh state', async t => {
  const {origin} = await serve(t);
  const first = await browser.newContext(), second = await browser.newContext();
  t.after(async () => { await first.close(); await second.close(); });
  const a = await openPage(first), b = await openPage(second);
  await signIn(a.page, origin, 'riley');
  await signIn(b.page, origin, 'riley');
  for (const {page} of [a, b]) await page.locator('button.row[data-id="1041"]').click();
  for (const {page} of [a, b]) await page.locator('#record').getByRole('heading', {name: 'Request access to the CRM'}).waitFor();
  await a.page.locator('#record').getByLabel('Priority').selectOption('High');
  await a.page.locator('#record').getByRole('button', {name: 'Save changes'}).click();
  await a.page.locator('#message', {hasText: 'SR-1041 updated.'}).waitFor();
  await b.page.locator('#record').getByLabel('Priority').selectOption('Low');   // b still holds revision 1
  await b.page.locator('#record').getByRole('button', {name: 'Save changes'}).click();
  await b.page.locator('#message', {hasText: 'Someone updated this request'}).waitFor();
  assert.equal(await b.page.locator('#record').getByLabel('Priority').inputValue(), 'High', 'b now shows a\'s change, not its own');
  assert.match(await b.page.locator('button.row[data-id="1041"]').innerText(), /High priority/);
  assert.deepEqual([...a.problems, ...b.problems], []);
});
test('signing out ends the session on the server, not just in the page', async t => {
  const {origin, context, page, problems} = await setup(t, 'casey');
  const cookie = (await context.cookies()).find(c => c.name === 'relay_session');
  assert.ok(cookie, 'a session cookie was set');
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.sameSite, 'Strict');
  await page.getByRole('button', {name: 'Sign out'}).click();
  await page.getByRole('heading', {name: 'Sign in', level: 1}).waitFor();
  assert.equal((await context.cookies()).some(c => c.name === 'relay_session' && c.value), false, 'the browser dropped the cookie');
  const replay = await fetch(origin + '/api/session', {headers: {Cookie: 'relay_session=' + cookie.value}});
  assert.equal(replay.status, 401, 'the old cookie is dead even if someone kept it');
  assert.deepEqual(problems, []);
});
test('a write without the CSRF token is refused even with a valid session cookie', async t => {
  const {page} = await setup(t, 'riley');
  const post = (headers: Record<string, string>) => page.evaluate(async (extra) => (await fetch('/api/requests', {method: 'POST', headers: {'Content-Type': 'application/json', ...extra}, body: JSON.stringify({title: 'T', team: 'IT', description: 'D'})})).status, headers);
  assert.equal(await post({}), 403);
  assert.equal(await post({'X-CSRF-Token': 'forged'}), 403);
});
test('repeated wrong passwords are throttled and the message says how long to wait', async t => {
  const {origin, page, problems} = await setup(t);
  await page.goto(origin + '/');
  for (let attempt = 1; attempt <= 6; attempt++) {
    await page.getByLabel('Username').fill('nobody');
    await page.getByLabel('Password').fill('wrong-' + attempt);
    await page.getByRole('button', {name: 'Sign in'}).click();
    await page.getByRole('alert').filter({hasText: attempt < 6 ? 'Incorrect username or password.' : 'Too many failed sign-ins'}).waitFor();
  }
  assert.match(await page.locator('#login-error').innerText(), /Try again in 15 minutes\./);
  assert.deepEqual(problems, []);
});
test('empty and error states are shown, and the error state can be retried', async t => {
  const {context, page, problems} = await setup(t, 'riley');
  await page.getByLabel('Search').fill('zzz-no-such-request');
  await page.getByRole('button', {name: 'Apply filters'}).click();
  await page.getByText('No requests match the filters.').waitFor();
  await page.locator('#record').getByText('No request selected').waitFor();
  await page.getByLabel('Search').fill('');
  await context.route('**/api/requests?*', route => route.abort());
  await page.getByRole('button', {name: 'Apply filters'}).click();
  await page.getByText('The server could not be reached').first().waitFor();
  await context.unroute('**/api/requests?*');
  await page.getByRole('button', {name: 'Try again'}).click();
  await page.locator('#requests button.row').first().waitFor();
  assert.deepEqual(problems.filter(p => !/net::ERR_FAILED/.test(p)), []);
});
test('pagination moves through the queue and shows where you are', async t => {
  const {page} = await setup(t, 'riley');
  assert.match(await page.locator('#range').innerText(), /1–8 of 8/);
  assert.equal(await page.getByRole('button', {name: 'Next page'}).isDisabled(), true);
  assert.equal(await page.getByRole('button', {name: 'Previous page'}).isDisabled(), true);
  await page.getByLabel('Sort by').selectOption('priority');
  await page.getByRole('button', {name: 'Apply filters'}).click();
  await page.locator('#requests button.row').first().waitFor();
  assert.equal((await ids(page))[0], '1047', 'Urgent first');
});
test('everything can be done with the keyboard alone, and focus is always visible', async t => {
  const {origin, page} = await setup(t);
  await page.goto(origin + '/');
  await page.getByLabel('Username').waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'username', 'the form is ready to type into');
  await page.keyboard.type('casey');
  await page.keyboard.press('Tab');
  await page.keyboard.type(DEMO_PASSWORD);
  await page.keyboard.press('Enter');
  await page.getByRole('heading', {name: 'Service requests', level: 1}).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'app-title', 'focus moves to the new page heading');
  const opener = page.getByRole('button', {name: '+ New request'});
  await opener.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#create').evaluate(d => (d as HTMLDialogElement).open), true);
  await page.keyboard.type('Keyboard only');
  const outline = await page.evaluate(() => { const style = getComputedStyle(document.activeElement!); return [style.outlineStyle, parseFloat(style.outlineWidth)]; });
  assert.deepEqual([outline[0], (outline[1] as number) >= 2], ['solid', true], 'a visible focus ring');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#create').evaluate(d => (d as HTMLDialogElement).open), false);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '+ New request', 'focus returns to the button that opened it');
});
test('axe-core finds no violations on the sign-in page, the queue with details (agent and requester) or the create dialog', async t => {
  const {origin, page, problems} = await setup(t);
  await page.goto(origin + '/');
  await page.getByLabel('Username').waitFor();
  assert.deepEqual(await violations(page), [], 'sign in');
  await signIn(page, origin, 'riley');
  await page.locator('#record').getByRole('button', {name: 'Save changes'}).waitFor();
  assert.deepEqual(await violations(page), [], 'queue and details, agent');
  await page.getByRole('button', {name: '+ New request'}).click();
  assert.deepEqual(await violations(page), [], 'create dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', {name: 'Sign out'}).click();
  await page.getByRole('heading', {name: 'Sign in', level: 1}).waitFor();
  await signIn(page, origin, 'casey');
  await page.locator('#record').getByLabel('Add a comment').waitFor();
  assert.deepEqual(await violations(page), [], 'queue and details, requester');
  assert.deepEqual(problems, []);
});
test('at 360 px wide nothing scrolls sideways and axe still finds nothing', async t => {
  const {origin, page, problems} = await setup(t, undefined, {width: 360, height: 740});
  await page.goto(origin + '/');
  await page.getByLabel('Username').waitFor();
  assert.equal(await fitsWidth(page), true, 'sign in');
  await signIn(page, origin, 'riley');
  await page.locator('#record').getByRole('button', {name: 'Save changes'}).waitFor();
  assert.equal(await fitsWidth(page), true, 'queue and details');
  assert.deepEqual(await violations(page), []);
  await page.getByRole('button', {name: '+ New request'}).click();
  assert.equal(await fitsWidth(page), true, 'create dialog');
  assert.deepEqual(await violations(page), []);
  assert.deepEqual(problems, []);
});
