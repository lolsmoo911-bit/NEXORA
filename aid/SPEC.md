# AID — NEXORA Asset Identifier

**Status: specification only. Not implemented, not deployed, not audited.**
Nothing in this document has been executed against a chain.

Version: 0.1.0 (draft). Supersedes nothing.

---

## 1. Purpose

AID gives every asset on NEXORA one short, deterministic, chain-native identifier:

```
assetId = bytes32 = keccak256(0xA1 || domainSeparator || assetType || assetKey)
```

Design goals, in priority order:

1. **Deterministic.** The same asset always yields the same `assetId`, computed
   independently by any party, with no registry lookup and no coordination.
2. **Unambiguous.** Two different assets can never collide by construction.
3. **Chain-native.** The value is exactly 32 bytes, so it is a plain `bytes32` in
   Solidity and a plain hex string everywhere else. No parsing, no prefix, no registry.
4. **Type-safe.** Native coins, ERC-20s, ERC-721s and ERC-1155s cannot be confused,
   because the type is part of the hashed preimage.
5. **Upgradeable.** Changing any rule here produces a new `domainSeparator`, so old and new
   identifiers can coexist on one chain without ambiguity.

## 2. Scope

In scope: the identifier, its canonical encoding, the domain separator, and a reference
implementation with test vectors.

Explicitly **out of scope** here: the registry contract, the CREATE2 deployment factory,
and vanity-address search. Those are Phase 5 and depend on this document being settled.

## 3. Canonical encoding

The preimage is a byte string built from four fields, each with an explicit width. No field
is variable-length, so there is no length-prefix ambiguity and no delimiter to get wrong.

| Field | Type | Width | Notes |
|---|---|---|---|
| `magic` | `bytes1` | 1 | Always `0xA1`. Domain separation from other keccak uses. |
| `domainSeparator` | `bytes32` | 32 | See §4. |
| `assetType` | `uint8` | 1 | See §5. |
| `assetKey` | `bytes32` | 32 | Type-dependent, see §6. |

```
preimage = 0xA1 ‖ domainSeparator ‖ assetType ‖ assetKey        // 66 bytes
assetId  = keccak256(preimage)                                   // 32 bytes
```

The preimage is always exactly 66 bytes. A fixed-width encoding is what makes this safe: an
implementation that concatenates variable-length strings without widths can produce two
different asset tuples that hash to the same bytes.

### 3.1 Canonical text form

For display, `assetId` is lowercase hex with no `0x` prefix, zero-padded to 64 characters:

```
a1d4e9f0c2b7a3658d0f1e2c3b4a5968778899aabbccddeeff00112233445566
```

Rules for implementations:

- Lowercase only. Uppercase is rejected at the boundary, not normalised.
- Always 64 characters. Never emit a shorter form, never emit `0x`.
- The text form is for humans, logs and URLs. Anything hashed uses the 32 raw bytes.

## 4. Domain separator

`domainSeparator` binds an identifier set to a specific chain *and* a specific version of
this specification.

```
domainSeparator = keccak256(abi.encode(chainId, specVersion))
```

| Parameter | Type | Value in this version |
|---|---|---|
| `chainId` | `uint256` | NEXORA EVM chain id, **902024** |
| `specVersion` | `uint32` | **1** |

`chainId` is the **EVM chain id**, not the Cosmos chain id. The Cosmos chain id
(`nexora-devnet-1`) scopes the network operationally; the EVM chain id is what contracts and
wallets actually branch on, so it is what the identifier must bind to.

`specVersion` is bumped when any encoding rule in this document changes. Bumping it changes
every `assetId`, which is intentional: it is impossible to silently reinterpret an old
identifier under new rules.

### 4.1 Deriving the EVM chain id safely

A contract must not trust a caller-supplied chain id. It reads `block.chainid`, and must
verify that value against its own configured constant, failing loudly on mismatch rather
than minting identifiers into the wrong domain.

## 5. Asset types

| `assetType` | Name | Asset |
|---|---|---|
| `0x00` | `NATIVE` | The native coin, `anex` (18 decimals, displayed as `nex`, symbol `NEX`). |
| `0x01` | `ERC20` | A fungible token, identified by its contract address. |
| `0x02` | `ERC721` | A non-fungible token, identified by contract address *and* token id. |
| `0x03` | `ERC1155` | A multi-token, identified by contract address *and* token id. |

Any other value is **invalid**. An implementation MUST reject it rather than hashing it,
because an unknown type hashed into a valid-looking `bytes32` is unrecoverable.

`NATIVE` is encoded as all-zero `assetKey`, so the native coin is not a special case in the
hashing code.

## 6. Asset keys

| Type | `assetKey` |
|---|---|
| `NATIVE` | `bytes32(0)` |
| `ERC20` | `bytes32(uint256(uint160(contractAddress)))` — the address, right-aligned, zero-padded on the left |
| `ERC721` | `keccak256(abi.encodePacked(contractAddress, tokenId))` |
| `ERC1155` | `keccak256(abi.encodePacked(contractAddress, tokenId))` |

Rationale:

- `ERC20` keys directly on the address, because a token id is meaningless there.
- `ERC721`/`ERC1155` hash address and id together so the 32-byte key stays uniform. The
  20-byte address and the id are fixed-width, so the packed encoding is unambiguous.

## 7. Reference implementation (Solidity)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library Aid {
    uint8  internal constant T_NATIVE  = 0x00;
    uint8  internal constant T_ERC20   = 0x01;
    uint8  internal constant T_ERC721  = 0x02;
    uint8  internal constant T_ERC1155 = 0x03;

    error AidUnknownType(uint8 assetType);
    error AidChainMismatch(uint256 expected, uint256 actual);

    /// @dev chainId MUST be this deployment's configured chain id. It is passed in rather
    ///      than read from block.chainid so a caller cannot mint into the wrong domain; the
    ///      caller verifies it once against block.chainid.
    function assetId(
        uint256 chainId,
        uint8   assetType,
        bytes32 assetKey
    ) internal pure returns (bytes32) {
        if (assetType > T_ERC1155) revert AidUnknownType(assetType);
        return keccak256(
            abi.encodePacked(
                bytes1(0xA1),
                keccak256(abi.encode(chainId, uint32(1))),
                assetType,
                assetKey
            )
        );
    }

    function domainSeparator(uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, uint32(1)));
    }

    function nativeId(uint256 chainId) internal pure returns (bytes32) {
        return assetId(chainId, T_NATIVE, bytes32(0));
    }

    function erc20Id(uint256 chainId, address token) internal pure returns (bytes32) {
        return assetId(chainId, T_ERC20, bytes32(uint256(uint160(token))));
    }

    function nftId(uint256 chainId, address token, uint256 tokenId) internal pure returns (bytes32) {
        bytes32 key = keccak256(abi.encodePacked(token, tokenId));
        // ERC721 and ERC1155 differ only in the type byte; the caller supplies it.
        return assetId(chainId, T_ERC20 + 1, key); // caller must use the correct type
    }
}
```

**Known defect in the sketch above, called out rather than hidden:** `nftId` infers the type
byte arithmetically, which silently produces an `ERC20` id when given the wrong branch. In
the real library `nftId` must take `assetType` explicitly, or there must be two separate
functions (`erc721Id`, `erc1155Id`). This is recorded here so it is not mistaken for a
finished implementation.

### 7.1 Reference implementation (JavaScript)

```js
import { keccak_256 } from 'js-sha3';   // NOT Ethereum keccak from node:crypto

export const SPEC_VERSION = 1;
export const CHAIN_ID = 902024;          // NEXORA EVM chain id
export const T = { NATIVE: 0x00, ERC20: 0x01, ERC721: 0x02, ERC1155: 0x03 };

const u256 = (n) => BigInt(n).toString(16).padStart(64, '0');

export function domainSeparator(chainId = CHAIN_ID) {
  // abi.encode(uint256, uint32) is two 32-byte words, each right-aligned.
  return keccak_256(
    u256(chainId) + u256(SPEC_VERSION)
  );
}

export function assetId(type, key, chainId = CHAIN_ID) {
  if (type < 0 || type > 0x03) throw new Error('AID: unknown asset type ' + type);
  return keccak_256(
    'a1' + domainSeparator(chainId) + type.toString(16).padStart(2, '0') + key
  );
}

export const nativeId  = (c) => assetId(T.NATIVE,  '00'.repeat(32), c);
export const erc20Id   = (c, a) => assetId(T.ERC20, a.toLowerCase().replace(/^0x/, '').padStart(64, '0'), c);
export const erc721Id  = (c, a, id) => assetId(T.ERC721,  keccak_256(a.slice(2).padStart(64, '0') + u256(id)), c);
export const erc1155Id = (c, a, id) => assetId(T.ERC1155, keccak_256(a.slice(2).padStart(64, '0') + u256(id)), c);
```

Two implementation notes that are easy to get wrong:

- `keccak-256`, **not** SHA3-256. Node's `crypto` exposes SHA3, which is a different
  standard function. A mismatch here produces identifiers that look valid and match nothing.
- Every input is lowercase hex of exact width. No `Number`, no padding heuristics.

## 8. Test vectors

These pin the encoding. A reference implementation passes this section only if it
reproduces every value exactly. **They have not been executed yet** — generating the
published vectors requires running the implementation, which has not happened.

| # | Type | Input | Expected `assetId` |
|---|---|---|---|
| 1 | `NATIVE` | `anex` on chain 902024 | *to be generated* |
| 2 | `ERC20` | `0x0000000000000000000000000000000000000000` | *to be generated* |
| 3 | `ERC20` | `0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` (native precompile) | *to be generated* |
| 4 | `ERC721` | `0x…01`, tokenId `0` | *to be generated* |
| 5 | `ERC721` | `0x…01`, tokenId `1` | *to be generated* |
| 6 | `ERC1155` | `0x…01`, tokenId `77` | *to be generated* |
| 7 | any | chain id `1` instead of `902024` | *to be generated* |

Vector 3 matters specifically: the ERC-20 precompile address already has a meaning in the
EVM, and a correct implementation must produce a distinct, stable id for it.

Until these are filled in, this specification is **not implementable to a shared standard**,
and that is the definition of done for this document.

## 9. Security properties and their limits

What this design gives:

- **No registry dependency.** The id is a pure function of public chain data.
- **Type confusion is impossible.** The type byte is in the preimage.
- **Replay across chains is impossible.** The chain id is in the domain separator.
- **Silent rule drift is impossible.** A spec change requires bumping `specVersion`.

What it does **not** give, stated plainly:

- **It proves nothing about the asset.** An `assetId` is an identifier, not an attestation.
  Anyone can compute the id of an asset that does not exist. Verification of existence,
  ownership and metadata is a registry concern (Phase 5), not an identifier concern.
- **It does not prevent front-running of CREATE2 deployment.** Deployment determinism has
  its own rules; see Phase 5.
- **Collision resistance is inherited from keccak-256.** That is a cryptographic claim, not
  a proof, and this project has not reviewed the specific parameters.
- **It has not been audited.** No external security review exists for this document.

## 10. Open questions

1. Should `assetType` be wider than `uint8` to leave room for future asset classes, or is
   rejection of unknown types the safer default? This draft chooses strict rejection.
2. Should a spec upgrade be expressed as a new `specVersion`, or as an entirely new
   `magic` byte? The latter is cleaner domain separation; the former is cheaper to detect.
3. Should `NATIVE` be allowed per-denom once more native coins exist, rather than as a
   single fixed value?

## 11. Definition of done for this document

- [ ] Test vectors in §8 generated and independently reproduced by a second implementation
- [ ] Reference library written and unit tested
- [ ] Fuzz test: no two distinct asset tuples produce the same `assetId`
- [ ] Property test: changing any one field changes the `assetId`
- [ ] Cross-check that the Solidity and JavaScript implementations agree on all vectors
- [ ] Explicit decision recorded for each open question in §10

Until every box is ticked, this is a draft and anything built on it is untested.