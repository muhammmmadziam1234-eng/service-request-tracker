// Regenerates docs/preview.png: the agent's queue with a request open, 1360x880, from the fictional demo data.
// Usage: CHROME_PATH=/path/to/chrome node scripts/capture-preview.ts [output.png] [WIDTHxHEIGHT] [request id]
// Set AS=casey (or another demo user) to sign in as someone else, or AS=none for the sign-in page.
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {openDatabase} from '../src/db.ts';
import {hashPassword} from '../src/passwords.ts';
import {DEMO_PASSWORD, seedDemo} from '../src/seed.ts';
import {createApp} from '../src/server.ts';

const executablePath = process.env['CHROME_PATH'];
if (!executablePath) throw new Error('Set CHROME_PATH to a Chromium or Chrome executable.');
const output = process.argv[2] ?? fileURLToPath(new URL('../docs/preview.png', import.meta.url));
const [width, height] = (process.argv[3] ?? '1360x880').split('x').map(Number) as [number, number];
const request = process.argv[4] ?? '1046', who = process.env['AS'] ?? 'riley';

const db = openDatabase(':memory:');
seedDemo(db, await hashPassword(DEMO_PASSWORD));
const app = createApp({db});
app.server.listen(0, '127.0.0.1');
await once(app.server, 'listening');
const origin = 'http://127.0.0.1:' + (app.server.address() as AddressInfo).port;
const browser = await chromium.launch({executablePath, args: ['--no-sandbox']});
try {
  // A fixed locale and time zone, so the dates in the picture do not depend on the machine that took it.
  const context = await browser.newContext({viewport: {width, height}, locale: 'en-US', timezoneId: 'UTC'});
  const page = await context.newPage();
  await page.goto(origin + '/');
  if (who === 'none') await page.getByLabel('Username').waitFor();
  else {
    await page.getByLabel('Username').fill(who);
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', {name: 'Sign in'}).click();
    await page.locator(`button.row[data-id="${request}"]`).click();
    await page.locator('#record .record-id', {hasText: 'SR-' + request}).waitFor();
    await page.locator('#record .comments').waitFor();
  }
  await page.screenshot({path: output});
  console.log('wrote', output, `${width}x${height}`);
} finally {
  await browser.close();
  await app.close(200);
  db.close();
}
