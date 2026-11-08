// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Aid} from "./Aid.sol";

/**
 * NEXORA Asset Identifier Registry — minimal, TESTNET workbench correction.
 *
 * PROVENANCE / CORRECTION (2026-11-07, workbench only)
 * ----------------------------------------------------
 * Derived from `source/aid/src/AidRegistry.sol` (canonical, tracked). The canonical
 * implementation takes a caller-supplied `uint256 chainId` in `register`/`verify` and
 * passes it to `Aid.assetId(...)`. `aid/SPEC.md` §4.1 states: "A contract must not trust
 * a caller-supplied chain id. It reads `block.chainid`, and must verify that value against
 * its own configured constant, failing loudly on mismatch rather than minting identifiers
 * into the wrong domain."
 *
 * This workbench copy corrects that semantic issue for an explicitly TESTNET-only
 * deployment on NEXORA devnet (EVM chain id 902024):
 *   - removes caller-supplied `chainId` from state-changing/verification entrypoints;
 *   - reads `block.chainid`;
 *   - requires `block.chainid == CONFIGURED_CHAIN_ID` (902024), reverting with
 *     `Aid.AidChainMismatch` on mismatch/fork/foreign deployment;
 *   - computes identifiers only for the actual chain.
 *
 * NOT a canonical source edit. NOT audited. `aid/SPEC.md` remains DRAFT (Solidity
 * cross-check of all vectors and §10 decisions open). Deploy/test on isolated loopback
 * local testnet only.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Registering here does NOT attest that an asset exists, that the registrar controls it, or
 * that its code matches its declared type. `aid/SPEC.md` §3 is explicit that an `assetId` is
 * an identifier and not a claim about the world; this contract stores a *claim* and says so.
 *
 * WHAT IT DOES GUARANTEE
 * ----------------------
 * 1. **The metadata hashes to the identifier it is filed under, for the actual chain.**
 *    Every registration recomputes `assetId(block.chainid, assetType, assetKey)` after
 *    verifying `block.chainid` equals the configured NEXORA EVM chain id, and reverts if
 *    it does not equal the id being registered.
 *
 * 2. **First claim wins, permanently.** A registered identifier cannot be overwritten.
 *
 * 3. **Only the original registrant can retract.** Deregistration is a statement by the
 *    party that made the claim, not by a third party.
 *
 * 4. **Wrong-chain/fork deployment fails loudly.** Operations revert if `block.chainid`
 *    is not the configured constant.
 *
 * There is no owner, no upgrade path, and no pause.
 */
contract AidRegistry {
    /// @notice NEXORA EVM chain id (devnet). Configured constant per SPEC §4.1.
    uint256 internal constant CONFIGURED_CHAIN_ID = 902024;

    enum Status {
        None,
        Registered,
        Retracted
    }

    struct Entry {
        uint8 assetType; // Aid asset type (0x00 native, 0x01 erc20, 0x02 erc721, 0x03 erc1155)
        Status status;
        address registrant;
        uint64 registeredAt; // unix seconds; a hint about ordering, never a proof of anything
        uint64 retractedAt;
    }

    error AidAlreadyRegistered(bytes32 assetId);
    error AidNotRegistered(bytes32 assetId);
    error AidNotTheRegistrant(bytes32 assetId, address caller);
    error AidMetadataDoesNotMatchIdentifier(bytes32 claimed, bytes32 computed);
    error AidZeroRegistrant();

    /// @notice assetId => entry. The mapping key IS the identifier; nothing else names an asset.
    mapping(bytes32 => Entry) private _entries;

    /// @notice Registration order. Retracted entries stay, so the list is an append-only record.
    bytes32[] private _order;

    // ------------------------------------------------------------------ events

    event Registered(bytes32 indexed assetId, uint8 indexed assetType, address indexed registrant);
    event Retracted(bytes32 indexed assetId, address indexed registrant);

    // ------------------------------------------------------------------ internal

    function _requireConfiguredChain() internal view returns (uint256) {
        uint256 chainId = block.chainid;
        if (chainId != CONFIGURED_CHAIN_ID) revert Aid.AidChainMismatch(CONFIGURED_CHAIN_ID, chainId);
        return chainId;
    }

    // ------------------------------------------------------------------ registration

    /**
     * @notice Files a claim for `assetId` on the actual chain.
     * @param assetId   the identifier, as produced by Aid.assetId for block.chainid
     * @param assetType the asset type, which is re-derived and checked
     * @param assetKey  the 32-byte key, which is re-hashed and checked
     *
     * Reverts if block.chainid is not the configured NEXORA chain id, if the id is already
     * registered, or if the supplied type and key do not reproduce `assetId` on this chain.
     */
    function register(bytes32 assetId, uint8 assetType, bytes32 assetKey) external {
        if (msg.sender == address(0)) revert AidZeroRegistrant();
        uint256 chainId = _requireConfiguredChain();
        Entry storage e = _entries[assetId];
        if (e.status != Status.None) revert AidAlreadyRegistered(assetId);

        bytes32 computed = Aid.assetId(chainId, assetType, assetKey);
        if (computed != assetId) revert AidMetadataDoesNotMatchIdentifier(assetId, computed);

        e.assetType = assetType;
        e.status = Status.Registered;
        e.registrant = msg.sender;
        e.registeredAt = uint64(block.timestamp);
        _order.push(assetId);

        emit Registered(assetId, assetType, msg.sender);
    }

    /**
     * @notice Retracts a claim. Only the original registrant may do this, and a retraction
     *         is final: the identifier cannot be claimed again.
     */
    function retract(bytes32 assetId) external {
        _requireConfiguredChain();
        Entry storage e = _entries[assetId];
        if (e.status != Status.Registered) revert AidNotRegistered(assetId);
        if (e.registrant != msg.sender) revert AidNotTheRegistrant(assetId, msg.sender);

        e.status = Status.Retracted;
        e.retractedAt = uint64(block.timestamp);

        emit Retracted(assetId, msg.sender);
    }

    // ------------------------------------------------------------------ reads

    function get(bytes32 assetId) external view returns (Entry memory) {
        return _entries[assetId];
    }

    function statusOf(bytes32 assetId) external view returns (Status) {
        return _entries[assetId].status;
    }

    function isRegistered(bytes32 assetId) external view returns (bool) {
        return _entries[assetId].status == Status.Registered;
    }

    function registrantOf(bytes32 assetId) external view returns (address) {
        return _entries[assetId].registrant;
    }

    function totalRegistrations() external view returns (uint256) {
        return _order.length;
    }

    /// @notice The nth identifier ever registered, including retracted ones.
    function assetIdAt(uint256 index) external view returns (bytes32) {
        if (index >= _order.length) revert AidNotRegistered(bytes32(0));
        return _order[index];
    }

    /// @notice Every registered entry at `from`, up to `max` entries. Cursor pagination.
    function paginate(uint256 from, uint256 max)
        external
        view
        returns (Entry[] memory entries, bytes32[] memory ids, uint256 next)
    {
        uint256 total = _order.length;
        if (from >= total) return (entries, ids, total);
        uint256 end = from + max;
        if (end > total) end = total;
        uint256 n = end - from;

        entries = new Entry[](n);
        ids = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = _order[from + i];
            ids[i] = id;
            entries[i] = _entries[id];
        }
        return (entries, ids, end);
    }

    /**
     * @notice Verifies a stored entry against the identifier scheme on the actual chain.
     *
     * Returns false for non-registered/retracted entries, wrong asset key, or wrong chain
     * context. Reverts if block.chainid is not the configured NEXORA chain id.
     */
    function verify(bytes32 assetId, bytes32 assetKey) external view returns (bool) {
        uint256 chainId = _requireConfiguredChain();
        Entry storage e = _entries[assetId];
        if (e.status != Status.Registered) return false;
        return Aid.assetId(chainId, e.assetType, assetKey) == assetId;
    }

    /// @notice Exposes the configured chain id for off-chain checks/tests.
    function configuredChainId() external pure returns (uint256) {
        return CONFIGURED_CHAIN_ID;
    }
}
