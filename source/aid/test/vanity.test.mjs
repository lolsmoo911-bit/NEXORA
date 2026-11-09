/**
 * Tests for the vanity search tool.
 *
 * The CREATE2 vector below was produced by `cast compute-address`, which is Foundry's
 * implementation, not this project's. Pinning it here means the derivation in
 * scripts/vanity.mjs is checked against something outside this repository, in every run,
 * rather than only in the CI step that happens to call cast.
 *
 * The difficulty tests exist because of a real bug: the regex `^0x?` treats the `0` as
 * mandatory and the `x` as optional, so "0000" was parsed as three zeros and quoted 16^3
 * expected attempts instead of 16^4 — an eight-fold understatement, from the one piece of
 * the tool that exists to state the cost honestly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { create2Address, difficulty, search } from '../scripts/vanity.mjs';

const DEPLOYER = '0x00000000000000000000000000000000c0ffee12';
const SALT = '0x000000000000000000000000000000000000000000000000000000000000c358';
const INIT_HASH = '0x5e8fd614cff0859e6e3314715a1e0d4bcb9dc7230a66c5dbde916d8417c2e522';
// The address `cast compute-address` produced for the two inputs above.
const FROM_CAST = '0x00005b6a978cae0c47315439b2ac779c4634a55f';

// ---------------------------------------------------------------- CREATE2 derivation

test('create2Address matches the value Foundry derived independently', () => {
  assert.equal(create2Address(DEPLOYER, SALT, INIT_HASH), FROM_CAST);
});

test('create2Address is insensitive to the 0x prefix and to hex case', () => {
  assert.equal(
    create2Address(DEPLOYER.slice(2).toUpperCase().replace('X', 'x'), SALT.slice(2), INIT_HASH.slice(2)),
    FROM_CAST
  );
});

test('create2Address rejects inputs of the wrong width', () => {
  assert.throws(() => create2Address('0x1234', SALT, INIT_HASH), /deployer must be 20 bytes/);
  assert.throws(() => create2Address(DEPLOYER, '0x1234', INIT_HASH), /salt must be 32 bytes/);
  assert.throws(() => create2Address(DEPLOYER, SALT, '0x1234'), /initCodeHash must be 32 bytes/);
  assert.throws(() => create2Address(DEPLOYER, SALT, '0x' + 'z'.repeat(64)), /not hex/);
});

test('create2Address depends on every input', () => {
  const base = create2Address(DEPLOYER, SALT, INIT_HASH);
  assert.notEqual(base, create2Address('0x00000000000000000000000000000000c0ffee13', SALT, INIT_HASH), 'deployer');
  assert.notEqual(base, create2Address(DEPLOYER, '0x' + '00'.repeat(31) + '01', INIT_HASH), 'salt');
  assert.notEqual(base, create2Address(DEPLOYER, SALT, '0x' + '00'.repeat(31) + '01'), 'init code');
});

test('create2Address returns a 20-byte lowercase address', () => {
  assert.match(create2Address(DEPLOYER, SALT, INIT_HASH), /^0x[0-9a-f]{40}$/);
});

// ---------------------------------------------------------------- difficulty

test('a run of k leading zeros costs 16^k expected attempts', () => {
  for (let k = 1; k <= 8; k++) {
    const d = difficulty('0'.repeat(k));
    assert.equal(d.digits, k, `pattern of ${k} zeros must be read as ${k} digits`);
    assert.equal(d.expectedAttempts, Math.pow(16, k), `16^${k}`);
    assert.ok(d.exact, 'a zero run is exactly modellable');
  }
});

test('a 0x prefix does not consume a zero digit', () => {
  assert.equal(difficulty('0x0000').digits, 4, '0x0000 is four zeros');
  assert.equal(difficulty('0000').digits, 4, '0000 is four zeros');
  assert.equal(difficulty('0x0000').expectedAttempts, 65536);
});

test('a trailing zero run is priced the same way', () => {
  const d = difficulty('abc0000');
  assert.ok(d.exact, 'a trailing zero run is exactly modellable');
  assert.equal(d.digits, 4);
  assert.equal(d.expectedAttempts, 65536);
});

test('an arbitrary pattern refuses to be priced', () => {
  // Independence is an assumption here, not a fact. A confident number would be a guess
  // wearing arithmetic's clothes.
  const d = difficulty('dead.*');
  assert.equal(d.exact, false);
  assert.equal(d.expectedAttempts, null);
  assert.equal(d.p, null);
});

test('the reported probability is the inverse of the expected attempts', () => {
  for (let k = 1; k <= 6; k++) {
    const d = difficulty('0'.repeat(k));
    assert.ok(Math.abs(d.p * d.expectedAttempts - 1) < 1e-9, `k=${k}`);
  }
});

// ---------------------------------------------------------------- search

test('the search returns an address that actually matches the pattern', () => {
  const r = search({ deployer: DEPLOYER, initCodeHash: INIT_HASH, pattern: '0000', maxAttempts: 500000 });
  assert.ok(r.found, 'a four-zero address is reachable in a fraction of a million attempts');
  assert.ok(r.address.startsWith('0x0000'), r.address);
  // and the salt it reports really does produce that address
  assert.equal(create2Address(DEPLOYER, r.salt, INIT_HASH), r.address);
});

test('the search reproduces the salt CI found, given the same starting nonce', () => {
  // The CI run recorded salt ...c358 as the first hit from nonce 0. Pinning it means a
  // change to the derivation cannot silently produce a different but equally plausible salt.
  const r = search({ deployer: DEPLOYER, initCodeHash: INIT_HASH, pattern: '0000', maxAttempts: 50009 });
  assert.equal(r.found, true);
  assert.equal(r.salt, SALT);
  assert.equal(r.address, FROM_CAST);
});

test('the search reports a real negative result rather than throwing', () => {
  const r = search({ deployer: DEPLOYER, initCodeHash: INIT_HASH, pattern: '00000000', maxAttempts: 2000 });
  assert.equal(r.found, false);
  assert.equal(r.attempts, 2000);
  assert.ok(r.ratePerSec > 0, 'a rate is still measured, so the projection stays meaningful');
});

test('the search never runs unbounded', () => {
  const started = Date.now();
  search({ deployer: DEPLOYER, initCodeHash: INIT_HASH, pattern: '000000000', maxAttempts: 1000 });
  assert.ok(Date.now() - started < 10000, 'the ceiling is honoured');
});
