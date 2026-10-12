/**
 * keccak-256 — the hash Ethereum uses.
 *
 * This is NOT SHA3-256. They differ only in the domain-separation byte appended before
 * padding (0x01 vs 0x06), and they produce completely different digests. `node:crypto`
 * exposes SHA3, so it cannot be used here.
 *
 * WHY A PINNED DEPENDENCY INSTEAD OF A LOCAL IMPLEMENTATION
 * --------------------------------------------------------
 * This file previously contained a hand-written Keccak-f[1600]. It was wrong: the pi lane
 * destination was transposed. The failure was invisible to every other test in the project,
 * because a deterministic hash that returns 32 bytes is exactly what the AID library
 * expects from it — it produced stable, plausible, meaningless digests.
 *
 * A cryptographic permutation is not something to improvise. It is now delegated to
 * js-sha3 at a pinned version, and `test/keccak.test.mjs` keeps the known-answer vectors
 * as the guard that would catch a bad upgrade.
 *
 * Two interop details this file exists to record:
 *   - js-sha3 is CommonJS, so a named import fails on Node 22 with
 *     "Named export 'keccak256' not found"; it must be imported as a default.
 *   - `new Uint8Array(arrayBuffer)`, NOT `Uint8Array.from(arrayBuffer)`; the latter treats
 *     an ArrayBuffer as an array-like and silently yields a zero-length result.
 */

import sha3 from 'js-sha3';

const keccak = sha3.keccak256;

/**
 * @param {Uint8Array|Buffer} input
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256(input) {
  const bytes = input instanceof Uint8Array ? input : Uint8Array.from(input);
  return new Uint8Array(keccak.arrayBuffer(bytes));
}

/** keccak256 of a hex string, with or without the 0x prefix. */
export function keccak256Hex(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  if (clean.length % 2 !== 0) throw new Error('hex input must have an even length');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error('hex input contains a non-hex character');
    bytes[i] = b;
  }
  return Buffer.from(keccak256(bytes)).toString('hex');
}