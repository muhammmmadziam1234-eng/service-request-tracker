import test from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword, needsRehash, verifyPassword, SCRYPT} from '../src/passwords.ts';

test('a hash records its own cost, a 16-byte salt and a 64-byte key', async () => {
  const [scheme, n, r, p, salt, key] = (await hashPassword('correct horse battery')).split('$');
  assert.equal(scheme, 'scrypt');
  assert.ok(Number(n) >= 16384, 'N is at least 16384');
  assert.equal(r, '8');
  assert.equal(p, '1');
  assert.equal(Buffer.from(salt!, 'base64').length, 16);
  assert.equal(Buffer.from(key!, 'base64').length, 64);
});
test('the same password gets a different salt each time, and only the right one verifies', async () => {
  const [a, b] = await Promise.all([hashPassword('s3cret passphrase'), hashPassword('s3cret passphrase')]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('s3cret passphrase', a), true);
  assert.equal(await verifyPassword('s3cret passphrase ', a), false);
  assert.equal(await verifyPassword('', a), false);
});
test('a malformed stored value is a failed login, never an exception', async () => {
  for (const stored of ['', 'plain', 'scrypt$1$2$3', 'scrypt$16384$8$1$!!$!!', 'bcrypt$16384$8$1$AAAA$AAAA', 'scrypt$3$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'])
    assert.equal(await verifyPassword('anything', stored), false, stored);
});
test('hashes made with another cost still verify and are flagged for an upgrade', async () => {
  const cheap = await hashPassword('old hash', {N: 2048, r: 8, p: 1});
  assert.equal(await verifyPassword('old hash', cheap), true);
  assert.equal(needsRehash(cheap), true);
  assert.equal(needsRehash(await hashPassword('new hash')), false);
  assert.equal(SCRYPT.N, 16384);
});
