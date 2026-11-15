import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginThrottle} from '../src/throttle.ts';

const MINUTE = 60_000;
function setup(options: {maxKeys?: number} = {}) {
  const clock = {t: 1_000_000};
  return {clock, throttle: createLoginThrottle({now: () => clock.t, ...options})};
}
test('five failures are allowed, the sixth attempt is blocked with a Retry-After', () => {
  const {clock, throttle} = setup();
  for (let i = 0; i < 5; i++) { assert.equal(throttle.check('casey|1.2.3.4').allowed, true); throttle.fail('casey|1.2.3.4'); clock.t += 1000; }
  const blocked = throttle.check('casey|1.2.3.4');
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterSeconds, 15 * 60 - 5, 'counted from the first failure of the window');
});
test('the block lifts exactly when the oldest failure leaves the 15 minute window', () => {
  const {clock, throttle} = setup();
  for (let i = 0; i < 5; i++) throttle.fail('k');
  clock.t += 15 * MINUTE - 1;
  assert.equal(throttle.check('k').allowed, false);
  clock.t += 1;
  assert.equal(throttle.check('k').allowed, true);
});
test('a successful login clears the count, and each username+address pair is counted separately', () => {
  const {throttle} = setup();
  for (let i = 0; i < 4; i++) throttle.fail('casey|a');
  throttle.reset('casey|a');
  for (let i = 0; i < 4; i++) throttle.fail('casey|a');
  assert.equal(throttle.check('casey|a').allowed, true);
  throttle.fail('casey|a');
  assert.equal(throttle.check('casey|a').allowed, false);
  assert.equal(throttle.check('casey|b').allowed, true);
  assert.equal(throttle.check('riley|a').allowed, true);
});
test('the table is bounded, so random usernames cannot grow memory without limit', () => {
  const {throttle} = setup({maxKeys: 50});
  for (let i = 0; i < 500; i++) throttle.fail('user' + i + '|ip');
  assert.ok(throttle.size <= 50, 'size ' + throttle.size);
});
