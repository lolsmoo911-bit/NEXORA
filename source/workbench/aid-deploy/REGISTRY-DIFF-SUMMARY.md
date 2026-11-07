# Canonical vs corrected AidRegistry (workbench, 2026-11-07)

Canonical: `source/aid/src/AidRegistry.sol` (sha256 `e8dbe577c8704927ad429d3cb5d24f15c13fc8026ce195d64c189f4c40755ec4`)
Corrected: `source/workbench/aid-deploy/src/AidRegistry.sol` (sha256 `ab40a031bab22177001567527354c89f209b7c742ca2cedc69d60c68a91800df`)

## Behavioral/security diff (SPEC §4.1)

| Area | Canonical (not deployed) | Corrected workbench artifact |
|---|---|---|
| Chain ID source | Caller-supplied `uint256 chainId` parameter | `block.chainid` read internally |
| Chain validation | None; caller-supplied value passed to `Aid.assetId` | `require(block.chainid == CONFIGURED_CHAIN_ID)` / reverts `Aid.AidChainMismatch(902024, actual)` |
| `register` | `register(bytes32 assetId, uint8 assetType, bytes32 assetKey, uint256 chainId)` | `register(bytes32 assetId, uint8 assetType, bytes32 assetKey)` |
| `verify` | `verify(bytes32 assetId, uint256 chainId, bytes32 assetKey)` | `verify(bytes32 assetId, bytes32 assetKey)` |
| Spoof risk | Caller can submit an ID computed for a foreign chain domain by supplying that chainId | Impossible; no chainId parameter and ID is recomputed for `block.chainid` |
| Configured chain | implicit/none | `CONFIGURED_CHAIN_ID = 902024`, `configuredChainId()` getter |

## Unchanged guarantees

- Metadata must hash to the identifier it is filed under (for the actual chain).
- First claim wins, permanently; retracted cannot be re-registered.
- Only original registrant can retract.
- No owner, no upgrade path, no pause.

## Aid.sol workbench copy

`workbench/aid-deploy/src/Aid.sol` adds `error AidChainMismatch(uint256 expected, uint256 actual);` for the corrected consumer. Canonical `aid/src/Aid.sol` does not declare it. This is a workbench-only declaration addition; library computation functions unchanged.

## AidFactory

`workbench/aid-deploy/src/AidFactory.sol` byte-for-byte identical hash to canonical (`8a9c9d8c...846f`). Unaffected.
