// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/**
 * @title AssetRegistry
 * @notice TESTNET ONLY. Human-readable asset name -> contract address, for NEXORA assets.
 *
 * This version uses proof-backed registration. A name is registered together with a
 * verified controller. There is no separate unclaimed registration state.
 */
contract AssetRegistry {
    // ------------------------------------------------------------------ types

    struct Asset {
        address contractAddress;
        address controller;
        uint64 registeredAt;
        uint32 assetType;
        bytes32 assetId;
        NameStatus status;
    }

    enum NameStatus {
        None,
        CustomAlias,
        Official
    }

    /// Mirrors AID's type tags so a name cannot be cross-registered as a different kind.
    uint32 public constant TYPE_NATIVE = 1;
    uint32 public constant TYPE_ERC20 = 2;
    uint32 public constant TYPE_ERC721 = 3;
    uint32 public constant TYPE_ERC1155 = 4;

    uint256 public constant MIN_LENGTH = 3;
    uint256 public constant MAX_LENGTH = 63;
    uint256 public constant GRACE_PERIOD = 60 * 60 * 24 * 30; // 30 days
    uint256 public constant CONFIGURED_CHAIN_ID = 902024;

    // ------------------------------------------------------------------ state

    mapping(bytes32 => Asset) private _assets;
    mapping(string => string) public normalisation;
    mapping(bytes32 => bytes32) private _fingerprints;
    mapping(bytes32 => uint256) public nonces;

    address public immutable registrar;
    bytes32 public immutable DOMAIN_SEPARATOR;

    // ------------------------------------------------------------------ authorization

    struct Authorization {
        bytes32 node;
        address asset;
        uint32 assetType;
        address controller;
        address authority;
        address executor;
        bytes32 assetId;
        bytes32 assetKey;
        address newController;
        uint256 nonce;
        uint256 deadline;
        uint256 chainId;
        address registry;
    }

    bytes32 public constant REGISTER_ALIAS_TYPEHASH =
        keccak256("RegisterAlias(bytes32 node,address asset,uint32 assetType,address controller,address authority,address executor,bytes32 assetId,bytes32 assetKey,address newController,uint256 nonce,uint256 deadline,uint256 chainId,address registry)");

    bytes32 public constant REGISTER_OFFICIAL_TYPEHASH =
        keccak256("RegisterOfficial(bytes32 node,address asset,uint32 assetType,address controller,address authority,address executor,bytes32 assetId,bytes32 assetKey,address newController,uint256 nonce,uint256 deadline,uint256 chainId,address registry)");

    bytes32 public constant LINK_ASSET_ID_TYPEHASH =
        keccak256("LinkAssetId(bytes32 node,address asset,uint32 assetType,address controller,address authority,address executor,bytes32 assetId,bytes32 assetKey,address newController,uint256 nonce,uint256 deadline,uint256 chainId,address registry)");

    bytes32 public constant RECOVER_CONTROLLER_TYPEHASH =
        keccak256("RecoverController(bytes32 node,address asset,uint32 assetType,address controller,address authority,address executor,bytes32 assetId,bytes32 assetKey,address newController,uint256 nonce,uint256 deadline,uint256 chainId,address registry)");

    bytes4 internal constant IERC1271_MAGIC = 0x1626ba7e;

    // ------------------------------------------------------------------ events

    event Registered(
        string name,
        bytes32 node,
        address indexed registrant,
        address indexed contractAddress,
        uint32 assetType,
        NameStatus status
    );
    event ControllerUpdated(bytes32 node, address indexed oldController, address indexed newController);
    event Claimed(string name, bytes32 node, address indexed claimant);
    event AssetIdLinked(string name, bytes32 node, bytes32 assetId);
    event ImpersonationBlocked(string rejected, bytes32 heldBy);
    event NameSuperseded(
        bytes32 node,
        address oldController,
        NameStatus oldStatus,
        address newController,
        NameStatus newStatus
    );

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
    error InvalidController();
    error DebugMismatch(address a, address b);
    error DebugSender(address msgSender, address live);
    error StaleController();
    error InvalidAuthorization();
    error ExpiredAuthorization();
    error InvalidRegistrar();
    error AssetKeyRequired();
    error OfficialNameConflict(bytes32 node);
    error UnsupportedAssetType(uint32 assetType);
    error InvalidAssetKey();
    error InvalidChainId(uint256 expected, uint256 actual);

    // ------------------------------------------------------------------ constructor

    constructor() {
        registrar = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("NEXORA AssetRegistry")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ------------------------------------------------------------------ normalisation

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

        bytes memory buf = new bytes(b.length);
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];

            if (c >= 0x41 && c <= 0x5A) {
                buf[i] = bytes1(uint8(c) + 32);
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

    function nodeOf(string calldata name) external pure returns (bytes32) {
        return _node(name);
    }

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
        return _assets[_node(name)].status != NameStatus.None;
    }

    function configuredChainId() external pure returns (uint256) {
        return CONFIGURED_CHAIN_ID;
    }

    // ------------------------------------------------------------------ confusables

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

    function _assertNotImpersonating(string memory n, bytes32 node) private view {
        bytes32 fp = fingerprint(n);
        bytes32 ownerNode = _fingerprints[fp];
        if (ownerNode != bytes32(0) && ownerNode != node) {
            revert Impersonation(n, ownerNode);
        }
    }

    // ------------------------------------------------------------------ controller helpers

    function _liveController(address asset) internal view returns (bool ok, address controller) {
        if (asset == address(0)) {
            return (false, address(0));
        }

        (bool success, bytes memory data) = asset.staticcall(abi.encodeWithSignature("owner()"));
        if (!success || data.length != 32) {
            return (false, address(0));
        }

        controller = abi.decode(data, (address));
        if (controller == address(0)) {
            return (false, address(0));
        }
        return (true, controller);
    }

    function _isValidSignature(address signer, bytes32 hash, bytes calldata signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            return _recover(hash, signature) == signer;
        }

        try IERC1271(signer).isValidSignature(hash, signature) returns (bytes4 magic) {
            return magic == IERC1271_MAGIC;
        } catch {
            return false;
        }
    }

    function _recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) return address(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return address(0);

        return ecrecover(hash, v, r, s);
    }

    function _verifyAuthorization(
        bytes32 typehash,
        Authorization memory auth,
        bytes calldata signature,
        address expectedSigner
    ) internal view returns (bool) {
        if (auth.chainId != block.chainid) return false;
        if (auth.registry != address(this)) return false;
        if (auth.deadline < block.timestamp) return false;
        if (auth.nonce != nonces[auth.node]) return false;

        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                auth.node,
                auth.asset,
                auth.assetType,
                auth.controller,
                auth.authority,
                auth.executor,
                auth.assetId,
                auth.assetKey,
                auth.newController,
                auth.nonce,
                auth.deadline,
                auth.chainId,
                auth.registry
            )
        );

        bytes32 digest = keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR, structHash));
        return _isValidSignature(expectedSigner, digest, signature);
    }

    // ------------------------------------------------------------------ registration helpers

    function _normalizeAndCheck(string memory rawName) internal pure returns (string memory n, bytes32 node) {
        (n, node) = _normalize(rawName);
    }

    function _registerCore(
        string memory name,
        address contractAddress,
        uint32 assetType,
        address controller,
        NameStatus status,
        bool allowSupersede
    ) internal {
        if (assetType == 0 || assetType > 4) revert BadType(assetType);
        if (contractAddress == address(0) && assetType != TYPE_NATIVE) revert ZeroAddress();

        (string memory n, bytes32 node) = _normalize(name);
        _assertNotImpersonating(n, node);

        Asset storage existing = _assets[node];
        if (existing.status != NameStatus.None) {
            if (allowSupersede && status == NameStatus.Official && existing.status == NameStatus.CustomAlias) {
                if (existing.contractAddress != contractAddress || existing.assetType != assetType) {
                    revert OfficialNameConflict(node);
                }
                emit NameSuperseded(node, existing.controller, existing.status, controller, status);
                _fingerprints[fingerprint(n)] = node;
            } else {
                revert AlreadyRegistered(node, existing.contractAddress);
            }
        } else {
            _fingerprints[fingerprint(n)] = node;
        }

        _assets[node] = Asset({
            contractAddress: contractAddress,
            controller: controller,
            registeredAt: uint64(block.timestamp),
            assetType: assetType,
            assetId: bytes32(0),
            status: status
        });

        normalisation[n] = n;
        emit Registered(n, node, msg.sender, contractAddress, assetType, status);
    }

    // ------------------------------------------------------------------ registration

    function register(string calldata name, address contractAddress, uint32 assetType) external {
        if (assetType == 0 || assetType > 4) revert BadType(assetType);
        if (contractAddress == address(0) && assetType != TYPE_NATIVE) revert ZeroAddress();

        (bool ok, address liveController) = _liveController(contractAddress);
        if (!ok || msg.sender != liveController) revert InvalidController();

        _registerCore(name, contractAddress, assetType, msg.sender, NameStatus.CustomAlias, false);
    }

    function registerAlias(string calldata name, address contractAddress, uint32 assetType) external {
        this.register(name, contractAddress, assetType);
    }

    function registerAliasAuthorized(
        string calldata name,
        address contractAddress,
        uint32 assetType,
        Authorization calldata auth,
        bytes calldata signature
    ) external {
        if (auth.node != _node(name)) revert InvalidAuthorization();
        if (auth.asset != contractAddress) revert InvalidAuthorization();
        if (auth.assetType != assetType) revert InvalidAuthorization();
        if (auth.chainId != block.chainid) revert InvalidAuthorization();
        if (auth.registry != address(this)) revert InvalidAuthorization();

        (bool ok, address liveController) = _liveController(contractAddress);
        address controller = auth.controller;

        if (ok) {
            if (controller != liveController) revert InvalidController();
            if (liveController.code.length > 0) {
                if (!_isValidSignature(liveController, _aliasDigest(auth), signature)) revert InvalidAuthorization();
            } else if (msg.sender != liveController) {
                if (!_isValidSignature(liveController, _aliasDigest(auth), signature)) revert InvalidAuthorization();
            }
        } else if (assetType == TYPE_NATIVE) {
            // Native assets have no controller; alias registration requires registrar authorization.
            if (auth.authority != registrar) revert InvalidRegistrar();
            if (!_verifyAuthorization(REGISTER_ALIAS_TYPEHASH, auth, signature, registrar)) revert InvalidAuthorization();
        } else {
            revert InvalidController();
        }

        _registerCore(name, contractAddress, assetType, controller, NameStatus.CustomAlias, false);
        nonces[auth.node]++;
    }

    function registerOfficial(
        string calldata name,
        address contractAddress,
        uint32 assetType,
        Authorization calldata auth,
        bytes calldata registrarSignature,
        bytes calldata controllerSignature
    ) external {
        if (auth.node != _node(name)) revert InvalidAuthorization();
        if (auth.asset != contractAddress) revert InvalidAuthorization();
        if (auth.assetType != assetType) revert InvalidAuthorization();
        if (auth.chainId != block.chainid) revert InvalidAuthorization();
        if (auth.registry != address(this)) revert InvalidAuthorization();
        if (auth.authority != registrar) revert InvalidRegistrar();
        if (!_verifyAuthorization(REGISTER_OFFICIAL_TYPEHASH, auth, registrarSignature, registrar)) {
            revert InvalidAuthorization();
        }

        (bool ok, address liveController) = _liveController(contractAddress);
        address controller = auth.controller;

        if (ok) {
            if (controller != liveController) revert InvalidController();
            if (liveController.code.length > 0) {
                if (!(msg.sender == liveController && controllerSignature.length == 0)) {
                    if (!_isValidSignature(liveController, _aliasDigest(auth), controllerSignature)) {
                        revert InvalidAuthorization();
                    }
                }
            } else if (msg.sender != liveController && controllerSignature.length == 0) {
                // EOA controller may submit directly; otherwise a controller signature is required.
                revert InvalidController();
            }
        } else if (assetType != TYPE_NATIVE) {
            revert InvalidController();
        }

        _registerCore(name, contractAddress, assetType, controller, NameStatus.Official, true);
        nonces[auth.node]++;
    }

    // ------------------------------------------------------------------ claim compatibility

    function claim(string calldata name) external {
        revert("claim requires proof");
    }

    // ------------------------------------------------------------------ controller recovery

    function recoverController(
        string calldata name,
        address newController,
        Authorization calldata auth,
        bytes calldata signature
    ) external {
        bytes32 node = _node(name);
        Asset storage a = _assets[node];
        if (a.status == NameStatus.None) revert NotRegistered(node);
        if (auth.node != node) revert InvalidAuthorization();
        if (auth.asset != a.contractAddress) revert InvalidAuthorization();
        if (auth.assetType != a.assetType) revert InvalidAuthorization();
        if (auth.newController != newController) revert InvalidAuthorization();
        if (auth.chainId != block.chainid) revert InvalidAuthorization();
        if (auth.registry != address(this)) revert InvalidAuthorization();

        (bool ok, address liveController) = _liveController(a.contractAddress);

        if (ok) {
            if (newController != liveController) revert DebugMismatch(newController, liveController);
            if (liveController.code.length > 0) {
                if (!_isValidSignature(liveController, _recoverDigest(auth), signature)) {
                    revert InvalidAuthorization();
                }
            } else if (msg.sender != liveController && signature.length == 0) {
                revert DebugSender(msg.sender, liveController);
            }
        } else {
            if (auth.authority != registrar) revert InvalidRegistrar();
            if (!_verifyAuthorization(RECOVER_CONTROLLER_TYPEHASH, auth, signature, registrar)) {
                revert InvalidAuthorization();
            }
        }

        address oldController = a.controller;
        a.controller = newController;
        nonces[node]++;

        emit ControllerUpdated(node, oldController, newController);
    }

    // ------------------------------------------------------------------ linking

    function linkAssetId(string calldata name, bytes32 assetId) external {
        bytes32 node = _node(name);
        Asset storage a = _assets[node];
        if (a.status == NameStatus.None) revert NotRegistered(node);

        bytes32 assetKey;
        if (a.assetType == TYPE_NATIVE) {
            assetKey = bytes32(0);
        } else if (a.assetType == TYPE_ERC20) {
            assetKey = bytes32(uint256(uint160(a.contractAddress)));
        } else {
            revert AssetKeyRequired();
        }

        _linkAssetId(name, node, a, assetId, assetKey, msg.sender);
    }

    function linkAssetId(
        string calldata name,
        bytes32 assetId,
        bytes32 assetKey
    ) external {
        bytes32 node = _node(name);
        Asset storage a = _assets[node];
        if (a.status == NameStatus.None) revert NotRegistered(node);

        _linkAssetId(name, node, a, assetId, assetKey, msg.sender);
    }

    function linkAssetIdAuthorized(
        string calldata name,
        bytes32 assetId,
        bytes32 assetKey,
        Authorization calldata auth,
        bytes calldata signature
    ) external {
        bytes32 node = _node(name);
        Asset storage a = _assets[node];
        if (a.status == NameStatus.None) revert NotRegistered(node);

        if (auth.node != node) revert InvalidAuthorization();
        if (auth.asset != a.contractAddress) revert InvalidAuthorization();
        if (auth.assetType != a.assetType) revert InvalidAuthorization();
        if (auth.assetId != assetId) revert InvalidAuthorization();
        if (auth.assetKey != assetKey) revert InvalidAuthorization();
        if (auth.chainId != block.chainid) revert InvalidAuthorization();
        if (auth.registry != address(this)) revert InvalidAuthorization();

        (bool ok, address liveController) = _liveController(a.contractAddress);

        if (ok) {
            if (auth.controller != liveController) revert InvalidController();
            if (liveController.code.length > 0) {
                if (!_isValidSignature(liveController, _linkDigest(auth), signature)) {
                    revert InvalidAuthorization();
                }
            } else if (msg.sender != liveController && signature.length == 0) {
                revert InvalidController();
            }
        } else {
            // Native assets have no controller; only registrar may link.
            if (a.assetType != TYPE_NATIVE) revert InvalidController();
            if (auth.authority != registrar) revert InvalidRegistrar();
            if (!_verifyAuthorization(LINK_ASSET_ID_TYPEHASH, auth, signature, registrar)) {
                revert InvalidAuthorization();
            }
        }

        _linkAssetId(name, node, a, assetId, assetKey, auth.controller);
        nonces[node]++;
    }

    function _linkAssetId(
        string memory name,
        bytes32 node,
        Asset storage a,
        bytes32 assetId,
        bytes32 assetKey,
        address claimant
    ) internal {
        if (a.assetType == TYPE_ERC721 || a.assetType == TYPE_ERC1155) {
            revert AssetKeyRequired();
        }

        (bool ok, address liveController) = _liveController(a.contractAddress);
        if (ok) {
            bool authorized = (claimant == liveController) ||
                (claimant == a.controller && liveController == a.controller);
            if (!authorized) revert Unauthorized();
        } else {
            if (claimant != a.controller) revert Unauthorized();
        }

        _validateAssetKey(a.contractAddress, a.assetType, assetKey);
        if (a.assetType == TYPE_NATIVE) {
            if (assetKey != bytes32(0)) revert InvalidAssetKey();
        } else if (a.assetType == TYPE_ERC20) {
            if (assetKey != bytes32(uint256(uint160(a.contractAddress)))) revert InvalidAssetKey();
        }

        if (block.chainid != CONFIGURED_CHAIN_ID) revert InvalidChainId(CONFIGURED_CHAIN_ID, block.chainid);

        a.assetId = assetId;
        nonces[node]++;
        emit AssetIdLinked(name, node, assetId);
    }

    // ------------------------------------------------------------------ views and helpers

    function authorizationDigest(bytes32 typehash, Authorization calldata auth) external view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                typehash,
                auth.node,
                auth.asset,
                auth.assetType,
                auth.controller,
                auth.authority,
                auth.executor,
                auth.assetId,
                auth.assetKey,
                auth.newController,
                auth.nonce,
                auth.deadline,
                auth.chainId,
                auth.registry
            )
        );
        return keccak256(abi.encodePacked(bytes2(0x1901), DOMAIN_SEPARATOR, structHash));
    }

    function _validateAssetKey(address contractAddress, uint32 assetType, bytes32 assetKey) internal pure {
        if (assetType == TYPE_NATIVE) {
            if (assetKey != bytes32(0)) revert InvalidAssetKey();
        } else if (assetType == TYPE_ERC20) {
            if (assetKey != bytes32(uint256(uint160(contractAddress)))) revert InvalidAssetKey();
        } else {
            revert AssetKeyRequired();
        }
    }

    function _aliasDigest(Authorization memory auth) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                bytes2(0x1901),
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        REGISTER_ALIAS_TYPEHASH,
                        auth.node,
                        auth.asset,
                        auth.assetType,
                        auth.controller,
                        auth.authority,
                        auth.executor,
                        auth.assetId,
                        auth.assetKey,
                        auth.newController,
                        auth.nonce,
                        auth.deadline,
                        auth.chainId,
                        auth.registry
                    )
                )
            )
        );
    }

    function _recoverDigest(Authorization memory auth) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                bytes2(0x1901),
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        RECOVER_CONTROLLER_TYPEHASH,
                        auth.node,
                        auth.asset,
                        auth.assetType,
                        auth.controller,
                        auth.authority,
                        auth.executor,
                        auth.assetId,
                        auth.assetKey,
                        auth.newController,
                        auth.nonce,
                        auth.deadline,
                        auth.chainId,
                        auth.registry
                    )
                )
            )
        );
    }

    function _linkDigest(Authorization memory auth) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                bytes2(0x1901),
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        LINK_ASSET_ID_TYPEHASH,
                        auth.node,
                        auth.asset,
                        auth.assetType,
                        auth.controller,
                        auth.authority,
                        auth.executor,
                        auth.assetId,
                        auth.assetKey,
                        auth.newController,
                        auth.nonce,
                        auth.deadline,
                        auth.chainId,
                        auth.registry
                    )
                )
            )
        );
    }

    function _officialDigest(Authorization memory auth) internal view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                bytes2(0x1901),
                DOMAIN_SEPARATOR,
                keccak256(
                    abi.encode(
                        REGISTER_OFFICIAL_TYPEHASH,
                        auth.node,
                        auth.asset,
                        auth.assetType,
                        auth.controller,
                        auth.authority,
                        auth.executor,
                        auth.assetId,
                        auth.assetKey,
                        auth.newController,
                        auth.nonce,
                        auth.deadline,
                        auth.chainId,
                        auth.registry
                    )
                )
            )
        );
    }

    // ------------------------------------------------------------------ views

    function debugLiveController(string calldata name) external view returns (bool ok, address controller) {
        Asset storage a = _assets[_node(name)];
        return _liveController(a.contractAddress);
    }

    function debugAliasDigest(Authorization calldata auth) external view returns (bytes32) {
        return _aliasDigest(auth);
    }

    function allNames(uint256 offset, uint256 limit) external view returns (string[] memory) {
        Asset[] memory probe = new Asset[](limit);
        probe;
        revert("use event indexing");
    }
}
