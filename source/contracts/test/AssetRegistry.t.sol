// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";

contract AssetRegistryTest is Test {
    AssetRegistry reg;

    address registrar;
    uint256 registrarPk;

    address token = makeAddr("token");
    address other = makeAddr("other");
    address buyer = makeAddr("buyer");

    uint256 constant T_ERC20 = 2;
    uint32 constant TYPE_ERC20 = 2;
    uint32 constant TYPE_NATIVE = 1;
    uint32 constant TYPE_ERC721 = 3;
    uint32 constant TYPE_ERC1155 = 4;

    uint256 constant CHAIN = 902024;

    function setUp() public {
        registrarPk = 0xA11CE;
        registrar = vm.addr(registrarPk);
        vm.prank(registrar);
        reg = new AssetRegistry();
    }

    // ------------------------------------------------------------------ helpers

    function _node(string memory name) internal view returns (bytes32) {
        return reg.nodeOf(name);
    }

    function _aliasAuth(
        bytes32 node,
        address asset,
        uint32 assetType,
        address controller,
        address executor
    ) internal view returns (AssetRegistry.Authorization memory auth) {
        auth.node = node;
        auth.asset = asset;
        auth.assetType = assetType;
        auth.controller = controller;
        auth.authority = controller;
        auth.executor = executor;
        auth.assetId = bytes32(0);
        auth.assetKey = bytes32(0);
        auth.newController = address(0);
        auth.nonce = reg.nonces(node);
        auth.deadline = block.timestamp + 1 days;
        auth.chainId = CHAIN;
        auth.registry = address(reg);
    }

    function _officialAuth(
        bytes32 node,
        address asset,
        uint32 assetType,
        address controller,
        address executor
    ) internal view returns (AssetRegistry.Authorization memory auth) {
        auth = _aliasAuth(node, asset, assetType, controller, executor);
        auth.authority = registrar;
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ normalisation

    function test_UppercaseFoldsToLowercase() public view {
        (, bytes32 a) = reg.normalize("GOLD");
        (, bytes32 b) = reg.normalize("gold");
        (, bytes32 c) = reg.normalize("GoLd");
        assertEq(a, b);
        assertEq(b, c, "case must not create a second identity");
    }

    function test_TooShortRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadLength.selector, uint256(2)));
        reg.normalize("AB");
    }

    function test_TooLongRejected() public {
        bytes memory long = new bytes(64);
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadLength.selector, uint256(64)));
        reg.normalize(string(long));
    }

    function test_MinAndMaxLengthAccepted() public view {
        reg.normalize("ABC");
        bytes memory sb = new bytes(63);
        for (uint256 i = 0; i < 63; i++) sb[i] = "A";
        reg.normalize(string(sb));
    }

    function test_NonAsciiRejected() public {
        bytes memory cyrillic = hex"d097d09ed0ad";
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0xd0)));
        reg.normalize(string(cyrillic));
    }

    function test_PunctuationRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0x21)));
        reg.normalize("GOLD!");
    }

    function test_HyphenRejected() public {
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0x2d)));
        reg.normalize("G-OLD");
    }

    // ------------------------------------------------------------------ confusables

    function test_FingerprintsCollideAsIntended() public view {
        assertEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("G0LD"));
        assertEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("GO1D"), "digit 1 must collide too");
        assertEq(reg.fingerprintOf("gold"), reg.fingerprintOf("GOLD"));
        assertNotEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("SILVER"));
    }

    function test_ZeroForLetterOIsRejectedAfterGoldExists() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        bytes32 held = reg.nodeOf("GOLD");
        OwnedAsset asset2 = new OwnedAsset(address(this));
        vm.expectRevert(abi.encodeWithSelector(AssetRegistry.Impersonation.selector, "g0ld", held));
        reg.register("G0LD", address(asset2), TYPE_ERC20);
    }

    // ------------------------------------------------------------------ registration

    function test_RegisterCustomAliasByController() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        AssetRegistry.Asset memory a = reg.get("GOLD");
        assertEq(a.contractAddress, address(asset));
        assertEq(a.controller, address(this));
        assertEq(uint256(a.status), uint256(AssetRegistry.NameStatus.CustomAlias));
        assertTrue(reg.exists("GOLD"));
    }

    function test_NonControllerCannotRegister() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        vm.prank(other);
        vm.expectRevert(AssetRegistry.InvalidController.selector);
        reg.register("GOLD", address(asset), TYPE_ERC20);
    }

    function test_RegisterOfficialByRegistrar() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));

        AssetRegistry.Asset memory a = reg.get("GOLD");
        assertEq(uint256(a.status), uint256(AssetRegistry.NameStatus.Official));
        assertEq(a.controller, address(this));
    }

    function test_UnauthorizedRegistrarOfficialFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(0xB0B, digest);

        vm.expectRevert();
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));
    }

    function test_OfficialSupersedesCustomAlias() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        bytes32 node = reg.nodeOf("GOLD");
        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));

        AssetRegistry.Asset memory a = reg.get("GOLD");
        assertEq(uint256(a.status), uint256(AssetRegistry.NameStatus.Official));
    }

    function test_CustomAliasCannotOverwriteOfficial() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));

        vm.expectRevert();
        reg.register("GOLD", address(asset), TYPE_ERC20);
    }

    function test_NativeRegistrationRequiresRegistrar() public {
        bytes32 node = reg.nodeOf("ANEX");
        AssetRegistry.Authorization memory auth = _officialAuth(node, address(0), TYPE_NATIVE, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        reg.registerOfficial("ANEX", address(0), TYPE_NATIVE, auth, sig, bytes(""));

        assertTrue(reg.exists("ANEX"));
        assertEq(reg.resolve("ANEX"), address(0));
    }

    function test_NativeDirectRegistrationFails() public {
        vm.expectRevert(AssetRegistry.InvalidController.selector);
        reg.register("ANEX", address(0), TYPE_NATIVE);
    }

    // ------------------------------------------------------------------ contract wallet controller

    function test_ContractWalletControllerAlias() public {
        TestWallet wallet = new TestWallet(address(this));
        OwnedAsset asset = new OwnedAsset(address(wallet));

        bytes32 node = reg.nodeOf("GOLD");
        AssetRegistry.Authorization memory auth = _aliasAuth(node, address(asset), TYPE_ERC20, address(wallet), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_ALIAS_TYPEHASH(), auth);
        bytes memory sig = _sign(0xC0FFEE, digest); // invalid signer for wallet owner? wallet owner is this, so use this key? need known key

        // Use a known controller key and wallet owned by that key's address.
        uint256 controllerPk = 0xBEEF;
        address controllerAddr = vm.addr(controllerPk);
        TestWallet wallet2 = new TestWallet(controllerAddr);
        OwnedAsset asset2 = new OwnedAsset(address(wallet2));

        bytes32 node2 = reg.nodeOf("SILVER");
        AssetRegistry.Authorization memory auth2 = _aliasAuth(node2, address(asset2), TYPE_ERC20, address(wallet2), address(this));
        bytes32 digest2 = reg.authorizationDigest(reg.REGISTER_ALIAS_TYPEHASH(), auth2);
        bytes memory sig2 = _sign(controllerPk, digest2);

        reg.registerAliasAuthorized("SILVER", address(asset2), TYPE_ERC20, auth2, sig2);

        AssetRegistry.Asset memory a = reg.get("SILVER");
        assertEq(a.controller, address(wallet2));
        assertEq(uint256(a.status), uint256(AssetRegistry.NameStatus.CustomAlias));
    }

    function test_InvalidContractWalletSignatureFails() public {
        uint256 controllerPk = 0xBEEF;
        address controllerAddr = vm.addr(controllerPk);
        TestWallet wallet = new TestWallet(controllerAddr);
        OwnedAsset asset = new OwnedAsset(address(wallet));

        bytes32 node = reg.nodeOf("GOLD");
        AssetRegistry.Authorization memory auth = _aliasAuth(node, address(asset), TYPE_ERC20, address(wallet), address(this));
        bytes memory badSig = new bytes(65);

        vm.expectRevert();
        reg.registerAliasAuthorized("GOLD", address(asset), TYPE_ERC20, auth, badSig);
    }

    // ------------------------------------------------------------------ controller transfer and stale authority

    function test_StaleControllerLosesLinkAuthority() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        // transfer ownership
        asset.setOwner(other);

        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 assetKey = bytes32(uint256(uint160(address(asset))));

        vm.expectRevert(AssetRegistry.Unauthorized.selector);
        reg.linkAssetId("GOLD", aid, assetKey);
    }

    function test_NewControllerCanRecoverAndLink() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        asset.setOwner(other);

        bytes32 node = reg.nodeOf("GOLD");
        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 assetKey = bytes32(uint256(uint160(address(asset))));

        vm.startPrank(other);
        reg.recoverController("GOLD", other, _emptyAuth(node, address(asset), TYPE_ERC20, other), bytes(""));
        reg.linkAssetId("GOLD", aid, assetKey);
        vm.stopPrank();

        assertEq(reg.get("GOLD").assetId, aid);
        assertEq(reg.get("GOLD").controller, other);
    }

    function _emptyAuth(bytes32 node, address asset, uint32 assetType, address controller) internal view returns (AssetRegistry.Authorization memory auth) {
        auth.node = node;
        auth.asset = asset;
        auth.assetType = assetType;
        auth.controller = controller;
        auth.authority = controller;
        auth.executor = controller;
        auth.assetId = bytes32(0);
        auth.assetKey = bytes32(0);
        auth.newController = controller;
        auth.nonce = reg.nonces(node);
        auth.deadline = block.timestamp + 1 days;
        auth.chainId = CHAIN;
        auth.registry = address(reg);
    }

    // ------------------------------------------------------------------ malformed owner

    function test_MalformedOwnerFailsClosed() public {
        BadOwnerAsset asset = new BadOwnerAsset();
        vm.expectRevert(AssetRegistry.InvalidController.selector);
        reg.register("GOLD", address(asset), TYPE_ERC20);
    }

    function test_ZeroOwnerFailsClosed() public {
        ZeroOwnerAsset asset = new ZeroOwnerAsset();
        vm.expectRevert(AssetRegistry.InvalidController.selector);
        reg.register("GOLD", address(asset), TYPE_ERC20);
    }

    // ------------------------------------------------------------------ AID linking

    function test_ValidErc20AidLink() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 assetKey = bytes32(uint256(uint160(address(asset))));

        reg.linkAssetId("GOLD", aid, assetKey);
        assertEq(reg.get("GOLD").assetId, aid);
    }

    function test_ValidNativeAidLink() public {
        bytes32 node = reg.nodeOf("ANEX");
        AssetRegistry.Authorization memory auth = _officialAuth(node, address(0), TYPE_NATIVE, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);
        reg.registerOfficial("ANEX", address(0), TYPE_NATIVE, auth, sig, bytes(""));

        bytes32 aid = Aid.nativeId(CHAIN);
        reg.linkAssetId("ANEX", aid);
        assertEq(reg.get("ANEX").assetId, aid);
    }

    function test_Erc721AidLinkFailsClosed() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC721);

        bytes32 aid = Aid.erc721Id(CHAIN, address(asset), 1);
        bytes32 assetKey = keccak256(abi.encodePacked(address(asset), uint256(1)));

        vm.expectRevert(AssetRegistry.AssetKeyRequired.selector);
        reg.linkAssetId("GOLD", aid, assetKey);
    }

    function test_Erc1155AidLinkFailsClosed() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC1155);

        bytes32 aid = Aid.erc1155Id(CHAIN, address(asset), 1);
        bytes32 assetKey = keccak256(abi.encodePacked(address(asset), uint256(1)));

        vm.expectRevert(AssetRegistry.AssetKeyRequired.selector);
        reg.linkAssetId("GOLD", aid, assetKey);
    }

    function test_WrongAssetKeyFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 wrongKey = bytes32(uint256(1));

        vm.expectRevert(AssetRegistry.InvalidAssetKey.selector);
        reg.linkAssetId("GOLD", aid, wrongKey);
    }

    function test_UnauthorizedLinkFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 assetKey = bytes32(uint256(uint160(address(asset))));

        vm.prank(other);
        vm.expectRevert(AssetRegistry.Unauthorized.selector);
        reg.linkAssetId("GOLD", aid, assetKey);
    }

    function test_AuthorizedLinkByContractWallet() public {
        uint256 controllerPk = 0xBEEF;
        address controllerAddr = vm.addr(controllerPk);
        TestWallet wallet = new TestWallet(controllerAddr);
        OwnedAsset asset = new OwnedAsset(address(wallet));

        bytes32 node = reg.nodeOf("GOLD");
        AssetRegistry.Authorization memory auth = _aliasAuth(node, address(asset), TYPE_ERC20, address(wallet), address(this));
        bytes32 aid = Aid.erc20Id(CHAIN, address(asset));
        bytes32 assetKey = bytes32(uint256(uint160(address(asset))));
        auth.assetId = aid;
        auth.assetKey = assetKey;

        bytes32 digest = reg.authorizationDigest(reg.REGISTER_ALIAS_TYPEHASH(), auth);
        bytes memory sig = _sign(controllerPk, digest);

        reg.registerAliasAuthorized("GOLD", address(asset), TYPE_ERC20, auth, sig);

        AssetRegistry.Authorization memory linkAuth = _aliasAuth(node, address(asset), TYPE_ERC20, address(wallet), address(this));
        linkAuth.assetId = aid;
        linkAuth.assetKey = assetKey;
        bytes32 linkDigest = reg.authorizationDigest(reg.LINK_ASSET_ID_TYPEHASH(), linkAuth);
        bytes memory linkSig = _sign(controllerPk, linkDigest);

        reg.linkAssetIdAuthorized("GOLD", aid, assetKey, linkAuth, linkSig);
        assertEq(reg.get("GOLD").assetId, aid);
    }

    // ------------------------------------------------------------------ replay and expiry

    function test_ReplayAuthorizationFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));

        // Reuse same authorization/nonce.
        vm.expectRevert();
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));
    }

    function test_ExpiredAuthorizationFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        auth.deadline = block.timestamp - 1;
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        vm.expectRevert();
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));
    }

    function test_WrongChainAuthorizationFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        auth.chainId = 1;
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        vm.expectRevert();
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));
    }

    function test_WrongRegistryAuthorizationFails() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        bytes32 node = reg.nodeOf("GOLD");

        AssetRegistry.Authorization memory auth = _officialAuth(node, address(asset), TYPE_ERC20, address(this), address(this));
        auth.registry = address(0xBEEF);
        bytes32 digest = reg.authorizationDigest(reg.REGISTER_OFFICIAL_TYPEHASH(), auth);
        bytes memory sig = _sign(registrarPk, digest);

        vm.expectRevert();
        reg.registerOfficial("GOLD", address(asset), TYPE_ERC20, auth, sig, bytes(""));
    }

    // ------------------------------------------------------------------ confusable and duplicate

    function test_CannotDoubleRegisterExact() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        vm.expectRevert();
        reg.register("GOLD", address(asset), TYPE_ERC20);
    }

    function test_CaseInsensitiveDuplicate() public {
        OwnedAsset asset = new OwnedAsset(address(this));
        reg.register("GOLD", address(asset), TYPE_ERC20);

        OwnedAsset asset2 = new OwnedAsset(address(this));
        vm.expectRevert();
        reg.register("gold", address(asset2), TYPE_ERC20);
    }
}



library Aid {
    uint8 internal constant T_NATIVE = 0x00;
    uint8 internal constant T_ERC20 = 0x01;
    uint8 internal constant T_ERC721 = 0x02;
    uint8 internal constant T_ERC1155 = 0x03;
    uint256 internal constant SPEC_VERSION = 1;

    function domainSeparator(uint256 chainId) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, uint32(SPEC_VERSION)));
    }

    function assetId(uint256 chainId, uint8 assetType, bytes32 assetKey) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0xA1), domainSeparator(chainId), assetType, assetKey));
    }

    function nativeId(uint256 chainId) internal pure returns (bytes32) {
        return assetId(chainId, T_NATIVE, bytes32(0));
    }

    function erc20Id(uint256 chainId, address token) internal pure returns (bytes32) {
        return assetId(chainId, T_ERC20, bytes32(uint256(uint160(token))));
    }

    function nftKey(address token, uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, tokenId));
    }

    function erc721Id(uint256 chainId, address token, uint256 tokenId) internal pure returns (bytes32) {
        return assetId(chainId, T_ERC721, nftKey(token, tokenId));
    }

    function erc1155Id(uint256 chainId, address token, uint256 tokenId) internal pure returns (bytes32) {
        return assetId(chainId, T_ERC1155, nftKey(token, tokenId));
    }
}

// ------------------------------------------------------------------ helpers

contract OwnedAsset {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function setOwner(address o) external {
        owner = o;
    }
}

contract TestWallet {
    address public owner;

    constructor(address o) {
        owner = o;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        address recovered = recover(hash, signature);
        if (recovered == owner) return 0x1626ba7e;
        return bytes4(0);
    }

    function recover(bytes32 hash, bytes calldata signature) internal pure returns (address) {
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
        return ecrecover(hash, v, r, s);
    }
}

contract BadOwnerAsset {
    fallback() external {
        assembly {
            return(0, 1)
        }
    }
}

contract ZeroOwnerAsset {
    function owner() external pure returns (address) {
        return address(0);
    }
}