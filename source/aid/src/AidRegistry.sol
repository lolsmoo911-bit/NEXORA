// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Aid} from "./Aid.sol";

/**
 * NEXORA Asset Identifier Registry — minimal.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Registering here does NOT attest that an asset exists, that the registrar controls it, or
 * that its code matches its declared type. `aid/SPEC.md` §3 is explicit that an `assetId` is
 * an identifier and not a claim about the world; this contract stores a *claim* and says so.
 * A consumer that treats registry membership as proof of existence is misreading it.
 *
 * WHAT IT DOES GUARANTEE
 * ----------------------
 * 1. **The metadata hashes to the identifier it is filed under.** Every registration
 *    recomputes `assetId(assetType, assetKey)` and reverts if it does not equal the id being
 *    registered. A registry entry therefore cannot disagree with the identifier scheme.
 *
 * 2. **First claim wins, permanently.** A registered identifier cannot be overwritten by a
 *    later registrant. If re-registration were allowed, the directory would be a mutable
 *    pointer that anyone could repoint, and its contents would carry no weight.
 *
 * 3. **Only the original registrant can retract.** Deregistration is a statement by the
 *    party that made the claim, not by a third party.
 *
 * There is no owner, no upgrade path, and no pause. A directory with those features is a
 * governance problem, and Phase 8 governance does not exist yet.
 */
contract AidRegistry {
    enum Status {
        None,
        Registered,
        Retracted
    }

    struct Entry {
        uint8 assetType;      // Aid asset type (0x00 native, 0x01 erc20, 0x02 erc721, 0x03 erc1155)
        Status status;
        address registrant;
        uint64 registeredAt;  // unix seconds; a hint about ordering, never a proof of anything
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

    // ------------------------------------------------------------------ registration

    /**
     * @notice Files a claim for `assetId`.
     * @param assetId   the identifier, as produced by Aid.assetId
     * @param assetType the asset type, which is re-derived and checked
     * @param assetKey  the 32-byte key, which is re-hashed and checked
     *
     * Reverts if the id is already registered, or if the supplied type and key do not
     * reproduce `assetId`. The second check is the whole reason this contract is not just a
     * mapping: it makes a false entry unrepresentable rather than merely unlikely.
     */
    function register(bytes32 assetId, uint8 assetType, bytes32 assetKey, uint256 chainId) external {
        if (msg.sender == address(0)) revert AidZeroRegistrant();
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
     *
     * "Final" is a deliberate cost. If a retracted identifier could be re-registered, then
     * a retraction would be an invitation to squat, and the first-claim-wins property above
     * would hold only until the first bad actor arrived.
     */
    function retract(bytes32 assetId) external {
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

    /// @notice Every registered entry at `from`, up to `max` entries. Cursor pagination,
    ///         because an unbounded loop over all assets would be uncallable at any real size.
    function paginate(uint256 from, uint256 max) external view returns (Entry[] memory entries, bytes32[] memory ids, uint256 next) {
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
     * @notice Verifies a stored entry against the identifier scheme, on demand.
     *
     * Every registration already enforced this, so a conforming registry always returns true.
     * It exists so that a consumer holding an assetId and a key can prove the pair is
     * genuine rather than trusting the caller's word, and so that a future state migration
     * (Phase 6) has something to validate against.
     */
    function verify(bytes32 assetId, uint256 chainId, bytes32 assetKey) external view returns (bool) {
        Entry storage e = _entries[assetId];
        if (e.status != Status.Registered) return false;
        return Aid.assetId(chainId, e.assetType, assetKey) == assetId;
    }
}
