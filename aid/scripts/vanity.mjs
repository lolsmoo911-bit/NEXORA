/**
 * Local vanity address search for per-asset CREATE2 deployments.
 *
 * WHAT A VANITY ADDRESS IS AND IS NOT
 * ----------------------------------
 * It is an address with a chosen visual property. That is all it is. It buys nothing
 * cryptographically: the search is over public inputs, so anyone can reproduce it, and
 * grinding a salt to produce `0x0000…` does not make the contract at that address
 * anything other than whatever was deployed. NEXORA uses it only so that addresses in
 * documentation and test fixtures are visually distinguishable.
 *
 * HONEST COMPLEXITY
 * -----------------
 * For a pattern of `n` leading (or trailing) zero hex digits, each attempt succeeds with
 * probability 16^-n, so the expected number of attempts is 16^n — not n, and not a
 * logarithm of anything. This script reports the expectation, the rate it actually
 * measured, and the wall-clock projection those two imply, and it prints the same
 * projection for sizes it did not attempt. A tool that reports only "found in 4 seconds"
 * is hiding the part that matters: what happens at one more digit.
 *
 * The projection is a *projection*. CI hardware is not the developer's laptop.
 *
 * INDEPENDENT VERIFICATION
 * ------------------------
 * This script computes CREATE2 addresses itself. Nothing here proves it computes them
 * correctly. The check that does is in CI, where `cast compute-address --create2` — a
 * separate implementation — must produce the same address for the same inputs. See
 * .github/workflows/aid-tests.yml, step "Verify the search against an independent
 * implementation".
 */

import { keccak256 } from '../src/keccak.mjs';

// ------------------------------------------------------------------ CREATE2 derivation

/** 0xff ++ deployer(20) ++ salt(32) ++ initCodeHash(32) — EIP-1014. */
export function create2Address(deployer, saltHex, initCodeHashHex) {
  const deployerBytes = hexToBytes(deployer);
  if (deployerBytes.length !== 20) throw new Error(`deployer must be 20 bytes, got ${deployerBytes.length}`);

  const salt = hexToBytes(saltHex);
  if (salt.length !== 32) throw new Error(`salt must be 32 bytes, got ${salt.length}`);

  const hash = hexToBytes(initCodeHashHex);
  if (hash.length !== 32) throw new Error(`initCodeHash must be 32 bytes, got ${hash.length}`);

  const preimage = new Uint8Array(85);
  preimage[0] = 0xff;
  preimage.set(deployerBytes, 1);
  preimage.set(salt, 21);
  preimage.set(hash, 53);

  const digest = Buffer.from(keccak256(preimage));
  // The address is the low 20 bytes of the digest.
  return '0x' + digest.subarray(12).toString('hex');
}

function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error(`not hex: ${String(hex).slice(0, 40)}`);
  }
  return Uint8Array.from(Buffer.from(clean, 'hex'));
}

// ------------------------------------------------------------------ difficulty

const HEX = 16;

/**
 * Expected attempts for a pattern, and the reasoning.
 *
 * For a run of `k` leading or trailing zero hex digits the expectation is exactly 16^k:
 * each digit is independent and uniform. The estimate below deliberately does NOT pretend
 * to model an arbitrary regex, where independence is an assumption and not a fact — it
 * returns null and says so, rather than printing a confident wrong number.
 */
export function difficulty(pattern) {
  // `(?:0x)?` rather than `0x?`: in `0x?` the `x` is optional but the `0` is not, so the
  // regex silently consumed one leading zero. A pattern of "0000" was therefore reported as
  // three digits and quoted 16^3 expected attempts instead of 16^4 — an eight-fold
  // understatement of the work, produced by a tool whose entire purpose is not to
  // understate it.
  const m = /^(?:0x)?(0{1,8})$/.exec(pattern);
  if (m) {
    const k = m[1].length;
    return {
      kind: `leading zero hex digits (${k})`,
      digits: k,
      p: Math.pow(HEX, -k),
      expectedAttempts: Math.pow(HEX, k),
      exact: true,
      note: 'Each digit is independent and uniform over 16 values, so 16^k is exact.',
    };
  }
  // The `[1-9a-f]` before the zero run is not decoration. A plain `([0-9a-f]{1,8})(0{1,8})`
  // backtracks greedily and lets the first group swallow zeros from the run — "abc0000"
  // would be priced as one trailing zero. Anchoring on the last non-zero character puts the
  // split where the pattern actually is.
  const body = String(pattern).replace(/^0x/i, '');
  const m2 = new RegExp(`^([0-9a-f]{1,8}[1-9a-f][0-9a-f]*)(0{1,8})$`).exec(body);
  if (m2) {
    const k = m2[2].length;
    return {
      kind: `trailing zero hex digits (${k})`,
      digits: k,
      p: Math.pow(HEX, -k),
      expectedAttempts: Math.pow(HEX, k),
      exact: true,
      note: 'Same argument as the leading case.',
    };
  }
  return {
    kind: 'arbitrary pattern',
    digits: null,
    p: null,
    expectedAttempts: null,
    exact: false,
    note:
      'No closed-form expectation. Independence is an assumption here, not a fact, ' +
      'so any number this tool could print would be a guess dressed as arithmetic.',
  };
}

// ------------------------------------------------------------------ search

/**
 * @param {object} opts
 * @param {string} opts.deployer        20-byte deployer address
 * @param {string} opts.initCodeHash    32-byte keccak of the creation code
 * @param {string} opts.pattern         leading zero hex digits, e.g. "0000"
 * @param {number} opts.maxAttempts     hard ceiling; the search never runs unbounded
 * @param {number} opts.startNonce      where to begin
 */
export function search({ deployer, initCodeHash, pattern, maxAttempts, startNonce = 0 }) {
  const started = process.hrtime.bigint();
  const want = pattern.replace(/^0x/i, '').toLowerCase();

  for (let i = 0; i < maxAttempts; i++) {
    // The salt is a counter. Counter-derived salts are honest: they commit to the search,
    // they are reproducible, and they carry no secret. A random salt would be equally valid
    // and equally reproducible, because the inputs are all public.
    const nonce = BigInt(startNonce) + BigInt(i);
    const saltHex = nonce.toString(16).padStart(64, '0');
    const address = create2Address(deployer, saltHex, initCodeHashHex(initCodeHash));
    if (address.startsWith('0x' + want)) {
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      return {
        found: true,
        salt: '0x' + saltHex,
        address,
        attempts: i + 1,
        elapsedMs,
        ratePerSec: (i + 1) / (elapsedMs / 1000 || 1),
      };
    }
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    found: false,
    attempts: maxAttempts,
    elapsedMs,
    ratePerSec: maxAttempts / (elapsedMs / 1000 || 1),
  };
}

function initCodeHashHex(x) {
  const clean = String(x).replace(/^0x/i, '');
  if (clean.length !== 64) throw new Error(`initCodeHash must be 32 bytes, got ${clean.length / 2}`);
  return clean;
}

// ------------------------------------------------------------------ projection

/**
 * What the measured rate implies for other sizes.
 *
 * Reported for every size from 1 to 8 digits regardless of what was actually searched,
 * because the size that matters is usually one digit harder than the one you tried.
 */
function project(ratePerSec, fromDigits, toDigits = 8) {
  const rows = [];
  for (let k = fromDigits; k <= toDigits; k++) {
    const expected = Math.pow(HEX, k);
    const seconds = expected / ratePerSec;
    rows.push({
      zeroHexDigits: k,
      expectedAttempts: expected.toLocaleString('en-US'),
      projectedSeconds: seconds < 90 ? Math.round(seconds)
        : seconds < 5400 ? Math.round(seconds / 60) + ' min'
        : seconds < 172800 ? (seconds / 3600).toFixed(1) + ' h'
        : (seconds / 86400).toFixed(1) + ' days',
    });
  }
  return rows;
}

// ------------------------------------------------------------------ cli

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

const isMain = process.argv[1] && process.argv[1].endsWith('vanity.mjs');
if (isMain) {
  const a = parseArgs(process.argv);
  const pattern = a.pattern || '0000';
  const maxAttempts = Number(a['max-attempts'] || 1_000_000);

  const d = difficulty(pattern);
  console.log('=== difficulty ===');
  console.log(`pattern            : ${pattern}`);
  console.log(`kind               : ${d.kind}`);
  if (d.exact) {
    console.log(`success probability: 16^-k = ${d.p}`);
    console.log(`expected attempts  : 16^k = ${d.expectedAttempts.toLocaleString('en-US')}`);
  } else {
    console.log('success probability: not modelled');
    console.log('expected attempts  : not modelled');
  }
  console.log(`note               : ${d.note}`);
  console.log(`search ceiling     : ${maxAttempts.toLocaleString('en-US')} attempts`);
  console.log('');

  const result = search({
    deployer: a.deployer,
    initCodeHash: a['init-code-hash'],
    pattern,
    maxAttempts,
    startNonce: Number(a.nonce || 0),
  });

  console.log('=== result ===');
  if (!result.found) {
    console.log(`NOT FOUND within ${result.attempts.toLocaleString('en-US')} attempts`);
    console.log(`elapsed            : ${(result.elapsedMs / 1000).toFixed(2)} s`);
    console.log(`measured rate      : ${Math.round(result.ratePerSec).toLocaleString('en-US')} attempts/s`);
    console.log('');
    console.log('This is a real negative result, not an error. Either raise --max-attempts,');
    console.log('or accept that this pattern is out of reach at this rate.');
  } else {
    console.log(`salt               : ${result.salt}`);
    console.log(`address            : ${result.address}`);
    console.log(`attempts           : ${result.attempts.toLocaleString('en-US')}`);
    console.log(`elapsed            : ${(result.elapsedMs / 1000).toFixed(2)} s`);
    console.log(`measured rate      : ${Math.round(result.ratePerSec).toLocaleString('en-US')} attempts/s`);
  }
  console.log('');

  // Start the projection at the size actually searched, so the reader is not asked to
  // interpret rows below the one they ran.
  const k = d.exact ? d.digits : 1;
  console.log(`=== projection at the measured rate (${Math.round(result.ratePerSec).toLocaleString('en-US')} attempts/s) ===`);
  console.log('zeroHexDigits | expected attempts | projected time');
  for (const r of project(result.ratePerSec, k)) {
    console.log(`${String(r.zeroHexDigits).padStart(13)} | ${r.expectedAttempts.padStart(18)} | ${r.projectedSeconds}`);
  }
  console.log('');
  console.log('The projection uses this machine\'s rate. CI hardware and a laptop differ,');
  console.log('often by more than the difference between these rows.');

  // Machine-readable, for the independent-verification step in CI.
  console.log('');
  console.log('--- json ---');
  console.log(JSON.stringify(result));

  process.exit(result.found ? 0 : 1);
}
