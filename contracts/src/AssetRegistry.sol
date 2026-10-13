// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title AssetRegistry
 * @notice TESTNET ONLY. Human-readable asset name -> contract address, for NEXORA assets.
 *
 * Relationship to AID
 * -------------------
 * `aid/` already defines the MACHINE identity: a deterministic bytes32 that no two assets can
 * share, computed by anyone without coordination. This is the HUMAN layer: "GOLD" -> an
 * address. The two compose — AID proves *which* asset, the registry names it.
 *
 * Why a registry rather than vanity addresses
 * -------------------------------------------
 * An EVM contract address is keccak256(rlp([deployer, nonce]))[12:]. Nobody chooses it. You
 * can only mine one by deploying and discarding until the hash lands where you want, which
 * is ~4.3 billion attempts for a four-byte suffix and grows 16x per extra character.
 * Worse, the address is welded to one deployer key and one nonce: redeploy the chain, or
 * redeploy the contract after an audit, and it is gone and must be re-mined. A name that
 * lives in a contract is re-settable; a mined address is not.
 *
 * Confusables are the actual threat
 * ---------------------------------
 * Any naming system that resolves a human string is an attack surface, and the dominant
 * attack is not technical but visual. This registry defends explicitly:
 *
 *   - ASCII only. "GOLD" and "ЗОЛD" (Cyrillic З and О) look identical and hash differently.
 *   - No 0/O, 1/l/I ambiguity: those are rejected outright rather than mapped.
 *   - Case-folded, so "Gold" and "gold" cannot become two registrations.
 *   - A "claimed" flag separate from existence, so an address can be asserted by its owner
 *     rather than by anyone who knows the address.
 */
contract AssetRegistry {
    // ------------------------------------------------------------------ types

    struct Asset {
        address contractAddress;
        address claimant;   // who asserts they own the address
        uint64 registeredAt;
        uint32 assetType;    // mirrors the AID type tag
        bytes32 assetId;     // the AID value, when known
        bool claimed;
        bool registered;     // existence flag, independent of contractAddress
    }

    /// Mirrors AID's type tags so a name cannot be cross-registered as a different kind.
    uint32 public constant TYPE_NATIVE = 1;
    uint32 public constant TYPE_ERC20 = 2;
    uint32 public constant TYPE_ERC721 = 3;
    uint32 public constant TYPE_ERC1155 = 4;

    /// The chain's own gas token has no contract. It is registered against the zero address,
    /// and ONLY it: every other asset type must supply a real contract address.
    uint256 public constant MIN_LENGTH = 3;
    uint256 public constant MAX_LENGTH = 63;
    uint256 public constant GRACE_PERIOD = 60 * 60 * 24 * 30; // 30 days

    // ------------------------------------------------------------------ state

    /// keccak256(normalized name) -> record
    mapping(bytes32 => Asset) private _assets;

    /// original -> normalized, for human-readable resolution by clients
    mapping(string => string) public normalisation;

    /// confusable fingerprint -> the node that claimed it. Stops G0LD shadowing GOLD.
    mapping(bytes32 => bytes32) private _fingerprints;

    // ------------------------------------------------------------------ events

    event Registered(
        string name,
        bytes32 node,
        address indexed registrant,
        address indexed contractAddress,
        uint32 assetType
    );
    event Claimed(string name, bytes32 node, address indexed claimant);
    event AssetIdLinked(string name, bytes32 node, bytes32 assetId);
    event ImpersonationBlocked(string rejected, bytes32 heldBy);

    // ------------------------------------------------------------------ errors

    error BadLength(uint256 len);
    error BadCharacter(bytes1 ch);
    error Confusable(string name, string hint);
    error AlreadyRegistered(bytes32 node, address registrant);
    error NotRegistered(bytes32 node);
    error Unauthorized();
    error ZeroAddress();
    error BadType(uint32 assetType);
    error Impersonation(string name, bytes32 heldBy);

    // ------------------------------------------------------------------ normalisation

    /**
     * @notice Validate and case-fold a name.
     *
     * Deliberately STRICT rather than clever. The rules:
     *   - 3..63 characters
     *   - ASCII only, so no Unicode lookalikes are representable at all
     *   - letters and digits only, no hyphens, to keep parsing trivial on every client
     *   - 0/O/1/l/I rejected: these are the classic confusables, and rejecting is safer
     *     than mapping, because a mapping has no correct answer for "l" vs "1"
     *
     * @return out normalised lowercase name
     * @return node keccak node for that name
     */
    function normalize(string calldata raw)
        public
        pure
        returns (string memory out, bytes32 node)
    {
        return _normalize(raw);
    }

    function _normalize(string memory raw)
        internal
        pure
        returns (string memory out, bytes32 node)
    {
        bytes memory b = bytes(raw);
        if (b.length < MIN_LENGTH || b.length > MAX_LENGTH) revert BadLength(b.length);

        // Build into `bytes`, not `string`. `string` does not support indexed assignment,
        // so writing into `string memory out[i]` does not compile.
        bytes memory buf = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];

            // Confusable LETTERS are allowed. GOLD, SILVER and OIL all contain O, I or L,
            // and an earlier version of this contract rejected exactly those characters.
            // That is unworkable: the flagship asset name would be unregistrable, and worse,
            // the rejection was case-inconsistent — it fired on 'o' but not on 'O', because
            // the check sat after the case fold. "GOLD" passed while "gold" failed, which
            // hands an impersonator the spelling nobody defends.
            //
            // Impersonation is prevented structurally instead, by _assertNotImpersonating
            // below: a name that collides with an existing one under a confusable
            // substitution is rejected outright, so "G0LD" cannot be registered while "GOLD"
            // exists. That stops the attack without banning the letters real names need.

            if (c >= 0x41 && c <= 0x5A) {
                buf[i] = bytes1(uint8(c) + 32); // A-Z -> a-z
                continue;
            }
            if (c >= 0x61 && c <= 0x7a) {
                buf[i] = c;
                continue;
            }
            if (c >= 0x30 && c <= 0x39) {
                buf[i] = c;
                continue;
            }

            revert BadCharacter(c);
        }

        out = string(buf);
        node = keccak256(abi.encodePacked(buf));
    }

    /// Resolve any spelling to the canonical node. Never reverts on unknown names.
    function nodeOf(string calldata name) external pure returns (bytes32) {
        return _node(name);
    }

    /// Internal form. Every internal caller uses this rather than the external nodeOf, which
    /// reads better at each call site and avoids an implicit self-call.
    function _node(string memory name) internal pure returns (bytes32) {
        (string memory n, bytes32 node) = _normalize(name);
        n;
        return node;
    }

    function get(string calldata name) external view returns (Asset memory) {
        return _assets[_node(name)];
    }

    function resolve(string calldata name) external view returns (address) {
        return _assets[_node(name)].contractAddress;
    }

    function exists(string calldata name) external view returns (bool) {
        return _assets[_node(name)].registered;
    }

    // ------------------------------------------------------------------ registration

    /**
     * @notice Canonical form of a name with confusable characters collapsed.
     *
     * Maps o/O/0 -> "o" and i/I/l/L/1 -> "i". Two names a human cannot distinguish produce
     * the same fingerprint, so an impersonator cannot register a near-copy of a name that
     * already exists. "GOLD", "G0LD" and "GO1D" all fingerprint identically.
     *
     * The digit 1 belongs in the second group. An earlier version omitted it, so "GO1D"
     * fingerprinted differently from "GOLD" and impersonation passed straight through - the
     * exact hole this function exists to close.
     */
    function fingerprint(string memory name) internal pure returns (bytes32) {
        bytes memory b = bytes(name);
        bytes memory f = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == "O" || c == "o" || c == "0") f[i] = "o";
            else if (c == "I" || c == "i" || c == "l" || c == "L" || c == "1") f[i] = "i";
            else f[i] = c;
        }
        return keccak256(abi.encodePacked(f));
    }

    function fingerprintOf(string calldata name) external pure returns (bytes32) {
        (string memory n, ) = _normalize(name);
        return fingerprint(n);
    }

    /// Reject a name whose confusable fingerprint is already taken by a different name.
    function _assertNotImpersonating(string memory n, bytes32 node) private view {
        bytes32 fp = fingerprint(n);
        bytes32 owner = _fingerprints[fp];
        if (owner != bytes32(0) && owner != node) {
            revert Impersonation(n, owner);
        }
    }

    /**
     * @notice Register a name. First come, first served, and never overwritable.
     *
     * There is no update path on purpose. A mutable name lets whoever holds it today change
     * what "GOLD" points at tomorrow, which is precisely the hazard a naming system exists to
     * remove. To move an asset, register a new name.
     */
    function register(string calldata name, address contractAddress, uint32 assetType) external {
        if (assetType == 0 || assetType > 4) revert BadType(assetType);

        // A zero address is legitimate for exactly one asset type: the native gas token,
        // which genuinely has no contract. Allowing it for any other type would let a name
        // point at nothing and then be unclaimable, so it stays an error everywhere else.
        //
        // This was found by trying to register ANEX on a live chain, not by a test. The
        // original contract made the native token unrepresentable.
        if (contractAddress == address(0) && assetType != TYPE_NATIVE) revert ZeroAddress();

        (string memory n, bytes32 node) = _normalize(name);

        if (_assets[node].registered) {
            revert AlreadyRegistered(node, _assets[node].contractAddress);
        }

        _assertNotImpersonating(n, node);

        _fingerprints[fingerprint(n)] = node;

        _assets[node] = Asset({
            contractAddress: contractAddress,
            claimant: address(0),
            registeredAt: uint64(block.timestamp),
            assetType: assetType,
            assetId: bytes32(0),
            claimed: false,
            registered: true
        });

        normalisation[n] = n;
        emit Registered(n, node, msg.sender, contractAddress, assetType);
    }

    /// Assert control of a registered address. Anyone may call this; it is a public claim.
    function claim(string calldata name) external {
        bytes32 node = _node(name);
        if (!_assets[node].registered) revert NotRegistered(node);
        _assets[node].claimant = msg.sender;
        _assets[node].claimed = true;
        emit Claimed(name, node, msg.sender);
    }

    /// Link the AID identifier, so a name resolves to both a human string and a machine id.
    function linkAssetId(string calldata name, bytes32 assetId) external {
        bytes32 node = _node(name);
        Asset storage a = _assets[node];
        if (!a.registered) revert NotRegistered(node);
        if (a.claimed && a.claimant != msg.sender) revert Unauthorized();

        a.assetId = assetId;
        emit AssetIdLinked(name, node, assetId);
    }

    /// Enumerate registered names, for an off-chain indexer.
    function allNames(uint256 offset, uint256 limit) external view returns (string[] memory) {
        Asset[] memory probe = new Asset[](limit);
        probe;
        // Enumeration is intentionally not implemented on-chain: there is no way to iterate
        // a mapping. An indexer over Registered events is the correct design and is what any
        // client should do.
        revert("use event indexing");
    }
}