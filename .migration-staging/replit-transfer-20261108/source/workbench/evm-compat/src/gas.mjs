/**
 * Gas accounting models for NEXORA devnet (Phase 6 compatibility).
 *
 * Pure, deterministic, BigInt-only integer math. No network, no clock.
 * Values mirror chain/nexora-devnet.json as of this workbench:
 *   min_gas_price 1 anex-per-gas floor, configured gas price 2 gwei (2e9 wei/gas),
 *   feemarket base fee starts 2 gwei and decays to 1 gwei floor.
 *   Denom: anex with 18 decimals (1 anex = 1e18 wei of "anex-gas-unit").
 *   eth_gasPrice historically observed ~1.13 gwei (docs/STATUS.md, verify.sh).
 *
 * Scope: arithmetic for fee estimation + base-fee floor checks only.
 * This module does NOT measure gas on-chain; live observation lives in probe.mjs.
 */

export const MIN_GAS_PRICE_WEI_PER_GAS = 1000000000n;      // 1 gwei floor
export const CONFIGURED_GAS_PRICE_WEI_PER_GAS = 2000000000n; // 2 gwei
export const WEI_PER_ANEX = 1000000000000000000n;           // 1e18

function asBigInt(x, name) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number' && Number.isInteger(x) && x >= 0) return BigInt(x);
  throw new TypeError(`${name} must be a non-negative integer (bigint preferred), got ${typeof x}`);
}

/**
 * Total transaction fee in wei: gasUsed * effectiveGasPrice.
 * Throws on negative gas, non-integer, or overflow beyond 2^256-1 (EVM uint256).
 */
export function txFeeWei({ gasUsed, gasPriceWeiPerGas }) {
  const g = asBigInt(gasUsed, 'gasUsed');
  const p = asBigInt(gasPriceWeiPerGas, 'gasPriceWeiPerGas');
  if (g < 0n) throw new RangeError('gasUsed must be >= 0');
  const fee = g * p;
  if (fee > (1n << 256n) - 1n) throw new RangeError('tx fee overflows uint256');
  return fee;
}

/**
 * Whether a configured gas price clears a feemarket base fee.
 * Returns { clears, marginWeiPerGas } (margin >= 0 when clears).
 */
export function clearsBaseFee({ configuredWeiPerGas, baseFeeWeiPerGas }) {
  const c = asBigInt(configuredWeiPerGas, 'configuredWeiPerGas');
  const b = asBigInt(baseFeeWeiPerGas, 'baseFeeWeiPerGas');
  const margin = c - b;
  return { clears: margin >= 0n, marginWeiPerGas: margin };
}

/**
 * Conservative fee estimate for a gas budget: gasLimit * gasPrice (wei).
 * gasLimit must be a positive integer (a 0 limit never settles).
 */
export function estimateBudgetWei({ gasLimit, gasPriceWeiPerGas }) {
  const l = asBigInt(gasLimit, 'gasLimit');
  if (l <= 0n) throw new RangeError('gasLimit must be positive');
  return txFeeWei({ gasUsed: l, gasPriceWeiPerGas });
}

/** Format wei as decimal anex string (18 decimals, no float). */
export function formatAnex(wei) {
  const w = asBigInt(wei, 'wei');
  const whole = w / WEI_PER_ANEX;
  const frac = w % WEI_PER_ANEX;
  return `${whole.toString()}.${frac.toString().padStart(18, '0')}`;
}

/** Parse decimal anex string to wei. Strict: digits with optional .digits. */
export function parseAnex(s) {
  if (typeof s !== 'string' || !/^\d+(\.\d{1,18})?$/.test(s)) {
    throw new TypeError(`expected decimal anex string, got ${JSON.stringify(s)}`);
  }
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * WEI_PER_ANEX + BigInt((frac + '0'.repeat(18)).slice(0, 18));
}

/** Hex wei -> BigInt (for eth_gasPrice / eth_chainId results). */
export function hexToBigInt(hex) {
  if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new TypeError(`expected 0x-prefixed hex, got ${JSON.stringify(hex)}`);
  }
  return BigInt(hex);
}
