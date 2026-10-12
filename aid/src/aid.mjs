/**
 * AID — reference implementation.
 *
 * Implements `aid/SPEC.md` §3 exactly:
 *
 *   assetId = keccak256(0xA1 || domainSeparator || assetType || assetKey)
 *   domainSeparator = keccak256(abi.encode(chainId, specVersion))
 *
 * Every field is fixed width. That is the whole safety argument: a variable-length
 * concatenation lets two different assets produce the same preimage bytes, so widths are
 * not a style choice here.
 */

import { keccak256 } from './keccak.mjs';

export const SPEC_VERSION = 1;
export const DEFAULT_CHAIN_ID = 902024;          // NEXORA EVM chain id (0xdc388)
export const MAGIC = 0xa1;

export const AssetType = Object.freeze({
  NATIVE: 0x00,
  ERC20: 0x01,
  ERC721: 0x02,
  ERC1155: 0x03,
});

const MAX_TYPE = AssetType.ERC1155;

export class AidError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AidError';
    this.code = code;
  }
}

const asBytes = (x) => (x instanceof Uint8Array ? x : Uint8Array.from(x));

/** uint256 as a 32-byte big-endian word. */
export function word256(value) {
  let n;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new AidError(`not a uint256: ${value}`, 'bad_uint');
    n = BigInt(value);
  } else if (typeof value === 'string' && /^(0x)?[0-9a-fA-F]{1,64}$/.test(value)) {
    n = BigInt(value);
  } else throw new AidError(`not a uint256: ${String(value)}`, 'bad_uint');

  if (n < 0n || n >= 1n << 256n) throw new AidError(`uint256 out of range: ${value}`, 'bad_uint');

  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** A 20-byte address as a 32-byte right-aligned word (SPEC §6, ERC20 key). */
export function addressToWord(address) {
  const clean = String(address).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new AidError(`bad address: ${address}`, 'bad_address');
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** keccak256(abi.encodePacked(address, tokenId)) — SPEC §6, NFT key. */
export function nftKey(address, tokenId) {
  const clean = String(address).replace(/^0x/i, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(clean)) throw new AidError(`bad address: ${address}`, 'bad_address');
  const addr = new Uint8Array(20);
  for (let i = 0; i < 20; i++) addr[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  const id = word256(tokenId);
  const packed = new Uint8Array(52);
  packed.set(addr, 0);
  packed.set(id, 20);
  return keccak256(packed);
}

export function domainSeparator(chainId = DEFAULT_CHAIN_ID, specVersion = SPEC_VERSION) {
  // abi.encode(uint256, uint32) is two right-aligned 32-byte words.
  const a = word256(chainId);
  const b = word256(specVersion);
  const preimage = new Uint8Array(64);
  preimage.set(a, 0);
  preimage.set(b, 32);
  return keccak256(preimage);
}

/**
 * assetId = keccak256(0xA1 || domainSeparator || assetType || assetKey)
 *
 * @param {number} assetType one of AssetType
 * @param {Uint8Array} assetKey exactly 32 bytes
 * @param {number|bigint} chainId EVM chain id
 */
export function assetId(assetType, assetKey, chainId = DEFAULT_CHAIN_ID) {
  if (!Number.isInteger(assetType) || assetType < 0 || assetType > MAX_TYPE) {
    throw new AidError(`unknown asset type: ${assetType}`, 'bad_type');
  }
  const key = asBytes(assetKey);
  if (key.length !== 32) throw new AidError(`assetKey must be 32 bytes, got ${key.length}`, 'bad_key');

  const preimage = new Uint8Array(66);
  preimage[0] = MAGIC;
  preimage.set(domainSeparator(chainId), 1);
  preimage[33] = assetType;
  preimage.set(key, 34);
  return keccak256(preimage);
}

export function nativeId(chainId = DEFAULT_CHAIN_ID) {
  return assetId(AssetType.NATIVE, new Uint8Array(32), chainId);
}

export function erc20Id(address, chainId = DEFAULT_CHAIN_ID) {
  return assetId(AssetType.ERC20, addressToWord(address), chainId);
}

export function erc721Id(address, tokenId, chainId = DEFAULT_CHAIN_ID) {
  return assetId(AssetType.ERC721, nftKey(address, tokenId), chainId);
}

export function erc1155Id(address, tokenId, chainId = DEFAULT_CHAIN_ID) {
  return assetId(AssetType.ERC1155, nftKey(address, tokenId), chainId);
}

/** Canonical text form: lowercase hex, no 0x, exactly 64 characters (SPEC §3.1). */
export function toCanonicalString(bytes32) {
  return Buffer.from(asBytes(bytes32)).toString('hex').toLowerCase();
}

/**
 * Reverse of toCanonicalString.
 *
 * SPEC §3.1: uppercase is REJECTED at the boundary, not normalised. Accepting it would mean
 * two different texts denote one assetId, and the whole point of a canonical form is that
 * there is exactly one.
 */
export function fromCanonicalString(text) {
  const raw = String(text);
  // No trim, no lowercase: anything but the exact canonical text is invalid.
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    throw new AidError(`not a canonical assetId: ${raw.slice(0, 72)}`, 'bad_text');
  }
  return Uint8Array.from(Buffer.from(raw, 'hex'));
}