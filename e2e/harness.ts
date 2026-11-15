import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import type {TestContext} from 'node:test';
import axe from 'axe-core';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright-core';
import {openDatabase} from '../src/db.ts';
import {hashPassword} from '../src/passwords.ts';
import {DEMO_PASSWORD, seedDemo} from '../src/seed.ts';
import {createApp} from '../src/server.ts';

export {DEMO_PASSWORD};
export async function launch(): Promise<Browser> {
  const executablePath = process.env['CHROME_PATH'];
  if (!executablePath) throw new Error('Set CHROME_PATH to a Chromium or Chrome executable.');
  return chromium.launch({executablePath, args: ['--no-sandbox']});
}
let demoHash: Promise<string> | undefined;
/** A fresh in-memory server with the demo accounts and sample requests, on an ephemeral port. */
export async function serve(t: TestContext): Promise<{origin: string}> {
  const db = openDatabase(':memory:');
  seedDemo(db, await (demoHash ??= hashPassword(DEMO_PASSWORD)));
  const app = createApp({db});
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => { await app.close(200); db.close(); });
  return {origin: 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port};
}
/**
 * A page that records everything that should never happen: uncaught exceptions, CSP violations and console errors.
 * (The browser also logs every 4xx answer; those are expected where a test provokes them, so they are not counted.)
 */
export async function openPage(context: BrowserContext): Promise<{page: Page; problems: string[]}> {
  const page = await context.newPage(), problems: string[] = [];
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (/Failed to load resource: the server responded with a status of 4\d\d/.test(message.text()) && message.location().url.includes('/api/')) return;
    problems.push('console: ' + message.text());
  });
  page.on('pageerror', error => problems.push('pageerror: ' + error.message));
  return {page, problems};
}
export async function signIn(page: Page, origin: string, username: string, password: string = DEMO_PASSWORD): Promise<void> {
  await page.goto(origin + '/');
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.getByRole('heading', {name: 'Service requests', level: 1}).waitFor();
  await page.locator('#requests button.row').first().waitFor();
}
/** Runs axe-core in the page. It is injected through the DevTools protocol, so the page's CSP stays fully in force. */
export async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axe.source);
  const result = await page.evaluate(() => (window as unknown as {axe: {run(): Promise<{violations: {id: string; help: string; nodes: {target: unknown[]}[]}[]}>}}).axe.run());
  return result.violations.map(v => `${v.id}: ${v.help} [${v.nodes.map(n => n.target.join(' ')).join(' | ')}]`);
}
export const fitsWidth = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
