/**
 * Known-answer tests for the dependency-free keccak-256.
 *
 * These are the vectors that matter. A wrong hash function would still produce stable
 * 32-byte output, so the AID library built on it would look fine while disagreeing with
 * every contract on the chain. Every other AID test would pass. Only these catch it.
 *
 * Sources: the original Keccak submission test vectors (empty string, "abc", "testing")
 * and the well-known Ethereum value for the empty string.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, keccak256Hex } from '../src/keccak.mjs';

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const hex = (s) => Buffer.from(keccak256(enc(s))).toString('hex');

test('keccak256 matches the official KAT for the empty string', () => {
  assert.equal(
    hex(''),
    'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
  );
});

test('keccak256 matches the official KAT for "abc"', () => {
  assert.equal(
    hex('abc'),
    '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
  );
});

test('keccak256 matches the official KAT for "testing"', () => {
  assert.equal(
    hex('testing'),
    '5f16f4c7f149ac4f9510d9cf8cf384038ad348b3bcdc01915f95de12df9d1b02'
  );
});

test('keccak256 is NOT SHA3-256 (the domain byte differs)', async () => {
  // If this ever becomes equal, the implementation is using the wrong padding and every
  // assetId would disagree with the EVM.
  const { createHash } = await import('node:crypto');
  const sha3 = createHash('sha3-256').update('').digest('hex');
  assert.notEqual(sha3, hex(''));
});

test('keccak256 handles inputs that straddle the 136-byte rate boundary', () => {
  // Absorbing across a block boundary is where padding bugs hide.
  for (const len of [135, 136, 137, 271, 272, 273]) {
    const input = new Uint8Array(len).fill(0x61);
    const d = keccak256(input);
    assert.equal(d.length, 32, `length ${len}`);
    // determinism
    assert.deepEqual(Array.from(keccak256(input)), Array.from(d), `length ${len} not deterministic`);
  }
});

test('keccak256Hex accepts input with and without the 0x prefix', () => {
  assert.equal(keccak256Hex(''), hex(''));
  assert.equal(keccak256Hex('0x'), hex(''));
  assert.equal(keccak256Hex('0x616263'), hex('abc'));
  assert.equal(keccak256Hex('616263'), hex('abc'));
});

test('keccak256 is deterministic and collision-free on simple inputs', () => {
  const seen = new Map();
  for (let i = 0; i < 2000; i++) {
    // padded, because keccak256Hex takes HEX and '7' is not a whole byte
    const h = keccak256Hex(i.toString(16).padStart(8, '0'));
    if (seen.has(h)) assert.fail(`collision between ${seen.get(h)} and ${i}`);
    seen.set(h, i);
  }
});