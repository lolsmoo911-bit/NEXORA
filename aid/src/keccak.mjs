/**
 * keccak-256 — the hash Ethereum uses.
 *
 * This is NOT SHA3-256. They differ only in the domain-separation byte appended before
 * padding (0x01 here, 0x06 for SHA3), and they produce completely different digests.
 * `node:crypto` exposes SHA3, so it cannot be used here. Using the wrong hash function would
 * produce identifiers that look perfectly valid and match nothing at all, which is the worst
 * failure mode this project could have.
 *
 * Keccak-f[1600] over 32-bit lane pairs. No dependencies. Checked against the official
 * known-answer vectors in `../test/keccak.test.mjs`, which fail loudly if this drifts.
 */

// Round constants as (low, high) halves of the 64-bit lanes. There must be exactly 24;
// the iota step indexes this by round, so a missing entry reads `undefined` and throws
// rather than producing a wrong digest.
const RC = [
  [0x00000001, 0x00000000], // 0x0000000000000001
  [0x00008082, 0x00000000], // 0x0000000000008082
  [0x0000808a, 0x80000000], // 0x800000000000808A
  [0x80008000, 0x80000000], // 0x8000000080008000
  [0x0000808b, 0x00000000], // 0x000000000000808B
  [0x80000001, 0x00000000], // 0x0000000080000001
  [0x80008081, 0x80000000], // 0x8000000080008081
  [0x00008009, 0x80000000], // 0x8000000000008009
  [0x0000008a, 0x00000000], // 0x000000000000008A
  [0x00000088, 0x00000000], // 0x0000000000000088
  [0x80008009, 0x00000000], // 0x0000000080008009
  [0x8000000a, 0x00000000], // 0x000000008000000A
  [0x8000808b, 0x00000000], // 0x000000008000808B
  [0x0000008b, 0x80000000], // 0x800000000000008B
  [0x00008089, 0x80000000], // 0x8000000000008089
  [0x00008003, 0x80000000], // 0x8000000000008003
  [0x00008002, 0x80000000], // 0x8000000000008002
  [0x00000080, 0x80000000], // 0x8000000000000080
  [0x0000800a, 0x00000000], // 0x000000000000800A
  [0x8000000a, 0x80000000], // 0x800000008000000A
  [0x80008081, 0x80000000], // 0x8000000080008081
  [0x80008080, 0x80000000], // 0x8000000000008080
  [0x80000001, 0x00000000], // 0x0000000080000001
  [0x80008008, 0x80000000], // 0x8000000080008008
];

// Rho rotation offsets, indexed by [x + 5*y].
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

// Pi destination for the lane at [x + 5*y]: B[y*5 + ((2x+3y) % 5)].
const PI_DEST = new Int32Array(25);
for (let x = 0; x < 5; x++) {
  for (let y = 0; y < 5; y++) {
    PI_DEST[x + 5 * y] = y * 5 + ((2 * x + 3 * y) % 5);
  }
}

/** Keccak-f[1600] permutation over 50 signed 32-bit halves (lane i at s[2i], s[2i+1]). */
function keccakF(s) {
  const C = new Int32Array(10);
  const B = new Int32Array(50);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      const i = 2 * x;
      C[i] = s[i] ^ s[i + 10] ^ s[i + 20] ^ s[i + 30] ^ s[i + 40];
      C[i + 1] = s[i + 1] ^ s[i + 11] ^ s[i + 21] ^ s[i + 31] ^ s[i + 41];
    }
    for (let x = 0; x < 5; x++) {
      const p = 2 * ((x + 4) % 5);
      const n = 2 * ((x + 1) % 5);
      const dlo = (C[n] ^ (((C[p] << 1) | (C[p] >>> 31)) | 0)) | 0;
      const dhi = (C[n + 1] ^ (((C[p + 1] << 1) | (C[p + 1] >>> 31)) | 0)) | 0;
      for (let y = 0; y < 5; y++) {
        const i = 2 * (x + 5 * y);
        s[i] = (s[i] ^ dlo) | 0;
        s[i + 1] = (s[i + 1] ^ dhi) | 0;
      }
    }

    // rho + pi
    for (let src = 0; src < 25; src++) {
      const dst = PI_DEST[src];
      const n = ROT[src];
      const lo = s[2 * src];
      const hi = s[2 * src + 1];
      if (n === 0) {
        B[2 * dst] = lo;
        B[2 * dst + 1] = hi;
      } else if (n < 32) {
        B[2 * dst] = ((lo << n) | (hi >>> (32 - n))) | 0;
        B[2 * dst + 1] = ((hi << n) | (lo >>> (32 - n))) | 0;
      } else if (n < 64) {
        const m = n - 32;
        B[2 * dst] = ((hi << m) | (lo >>> (32 - m))) | 0;
        B[2 * dst + 1] = ((lo << m) | (hi >>> (32 - m))) | 0;
      } else {
        B[2 * dst] = lo;
        B[2 * dst + 1] = hi;
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = 2 * (x + 5 * y);
        const i1 = 2 * (((x + 1) % 5) + 5 * y);
        const i2 = 2 * (((x + 2) % 5) + 5 * y);
        s[i] = (B[i] ^ (~B[i1] & B[i2])) | 0;
        s[i + 1] = (B[i + 1] ^ (~B[i1 + 1] & B[i2 + 1])) | 0;
      }
    }

    // iota
    s[0] = (s[0] ^ RC[round][0]) | 0;
    s[1] = (s[1] ^ RC[round][1]) | 0;
  }
}

/**
 * keccak-256 digest.
 * @param {Uint8Array} input
 * @returns {Uint8Array} 32 bytes
 */
export function keccak256(input) {
  const RATE = 136;                       // 1088-bit rate for keccak-256
  const msg = input instanceof Uint8Array ? input : new Uint8Array(input);

  // pad10*1 with the keccak (not SHA3) domain byte
  const padLen = RATE - (msg.length % RATE);
  const padded = new Uint8Array(msg.length + padLen);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const s = new Int32Array(50);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE; i += 8) {
      const lane = (off + i) / 8;
      const b = off + i;
      s[lane * 2] ^= padded[b] | (padded[b + 1] << 8) | (padded[b + 2] << 16) | (padded[b + 3] << 24);
      s[lane * 2 + 1] ^= padded[b + 4] | (padded[b + 5] << 8) | (padded[b + 6] << 16) | (padded[b + 7] << 24);
    }
    keccakF(s);
  }

  // First 32 bytes of the state: lanes 0..3, each little-endian (low half then high half).
  const digest = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const lo = s[i * 2];
    const hi = s[i * 2 + 1];
    digest[i * 4] = lo & 0xff;
    digest[i * 4 + 1] = (lo >>> 8) & 0xff;
    digest[i * 4 + 2] = (lo >>> 16) & 0xff;
    digest[i * 4 + 3] = (lo >>> 24) & 0xff;
    digest[16 + i * 4] = hi & 0xff;
    digest[16 + i * 4 + 1] = (hi >>> 8) & 0xff;
    digest[16 + i * 4 + 2] = (hi >>> 16) & 0xff;
    digest[16 + i * 4 + 3] = (hi >>> 24) & 0xff;
  }
  return digest;
}

/** keccak256 of a hex string (with or without 0x). */
export function keccak256Hex(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return Buffer.from(keccak256(bytes)).toString('hex');
}