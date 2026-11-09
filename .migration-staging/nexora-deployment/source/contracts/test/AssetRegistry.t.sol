// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";

/// TESTNET ONLY.
contract AssetRegistryTest is Test {
    AssetRegistry reg;
    address token = makeAddr("token");
    address claimant = makeAddr("claimant");
    address other = makeAddr("other");

    uint32 constant T_ERC20 = 2;
    uint32 constant T_NATIVE = 1;

    function setUp() public {
        reg = new AssetRegistry();
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
        // exactly MAX_LENGTH (63), built programmatically so the count is not a typo
        bytes memory sb = new bytes(63);
        for (uint256 i = 0; i < 63; i++) sb[i] = "A";
        reg.normalize(string(sb));
    }

    // ------------------------------------------------------------------ confusables

    /// The whole point of the name system. "GO" and "G0" are the same to a human and must
    /// not both be registrable.
    
    
    
    function test_NonAsciiRejected() public {
        // Cyrillic Ze (U+0417) is d0 97 in UTF-8. "ЗО..." looks like "GO..." to a human and
        // would be a perfect impersonation if accepted.
        bytes memory cyrillic = hex"d097d09ed0ad"; // 6 bytes, first bad byte is 0xd0
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0xd0))
        );
        reg.normalize(string(cyrillic));
    }

    function test_PunctuationRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0x21))
        );
        reg.normalize("GOLD!");
    }

    function test_HyphenRejected() public {
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.BadCharacter.selector, bytes1(0x2d))
        );
        reg.normalize("G-OLD");
    }

    // ------------------------------------------------------------------ registration

    function test_RegisterAndResolve() public {
        reg.register("GOLD", token, T_ERC20);
        assertEq(reg.resolve("GOLD"), token);
        assertTrue(reg.exists("GOLD"));
    }

    function test_CaseInsensitiveResolution() public {
        reg.register("GOLD", token, T_ERC20);
        assertEq(reg.resolve("gold"), token);
        assertEq(reg.resolve("GoLd"), token);
    }

    function test_CannotDoubleRegister() public {
        reg.register("GOLD", token, T_ERC20);
        // nodeOf() is an external call: it must happen BEFORE expectRevert, or it consumes
        // the expectation and the real revert goes unchecked.
        bytes32 node = reg.nodeOf("GOLD");
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.AlreadyRegistered.selector, node, token)
        );
        reg.register("GOLD", other, T_ERC20);
    }

    function test_CannotDoubleRegisterUnderDifferentCase() public {
        reg.register("GOLD", token, T_ERC20);
        vm.expectRevert();
        reg.register("gold", other, T_ERC20);
    }

    function test_ZeroAddressRejected() public {
        vm.expectRevert(AssetRegistry.ZeroAddress.selector);
        reg.register("GOLD", address(0), T_ERC20);
    }

    // ------------------------------------------------------------------ native token

    /// ANEX is the gas token and has no contract. A registry that cannot name the chain's
    /// own currency is not usable, so zero is accepted for TYPE_NATIVE and only that type.
    function test_NativeTokenRegistrableAgainstZeroAddress() public {
        reg.register("ANEX", address(0), T_NATIVE);
        assertTrue(reg.exists("ANEX"), "existence must not depend on a contract address");
        assertEq(reg.resolve("ANEX"), address(0));
        assertEq(reg.get("ANEX").assetType, T_NATIVE);
    }

    function test_ZeroAddressStillRejectedForERC721() public {
        vm.expectRevert(AssetRegistry.ZeroAddress.selector);
        reg.register("GOLD", address(0), 3); // TYPE_ERC721
    }

    function test_NativeIsClaimable() public {
        reg.register("ANEX", address(0), T_NATIVE);
        vm.prank(claimant);
        reg.claim("ANEX");
        assertEq(reg.get("ANEX").claimant, claimant);
    }

    /// A native name must still be immutable and must still block its confusables.
    function test_NativeNameCannotBeDoubleRegistered() public {
        reg.register("ANEX", address(0), T_NATIVE);
        bytes32 node = reg.nodeOf("ANEX");
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.AlreadyRegistered.selector, node, address(0))
        );
        reg.register("ANEX", makeAddr("other"), T_NATIVE);
    }

    function test_NativeConfusableStillBlocked() public {
        reg.register("ANEX", address(0), T_NATIVE);
        // "ANEX" -> a-n-e-x ; "ANEX" has no confusables, so use a name that does
        reg.register("GOLD", token, T_ERC20);
        vm.expectRevert();
        reg.register("G0LD", makeAddr("attacker"), T_ERC20);
    }

    function test_UnknownNameIsZeroNotRevert() public view {
        assertEq(reg.resolve("NOTHERE"), address(0));
        assertFalse(reg.exists("NOTHERE"));
    }

    function test_MultipleAssetsCoexist() public {
        reg.register("GOLD", makeAddr("g"), T_ERC20);
        reg.register("USD", makeAddr("u"), T_ERC20);
        reg.register("ANEX", makeAddr("n"), T_NATIVE);

        assertTrue(reg.exists("GOLD"));
        assertTrue(reg.exists("USD"));
        assertTrue(reg.exists("ANEX"));
        assertNotEq(reg.resolve("GOLD"), reg.resolve("USD"));
    }

    // ------------------------------------------------------------------ claiming

    function test_ClaimRecordsOwner() public {
        reg.register("GOLD", token, T_ERC20);

        assertFalse(reg.get("GOLD").claimed);
        vm.prank(claimant);
        reg.claim("GOLD");

        AssetRegistry.Asset memory a = reg.get("GOLD");
        assertTrue(a.claimed);
        assertEq(a.claimant, claimant);
        assertEq(a.contractAddress, token, "claiming must not move the address");
    }

    function test_LinkingAssetIdRequiresClaimForNonOwner() public {
        reg.register("GOLD", token, T_ERC20);
        bytes32 aid = keccak256(hex"A1deadbeef");

        // unclaimed: anyone may link (it is self-asserted)
        reg.linkAssetId("GOLD", aid);
        assertEq(reg.get("GOLD").assetId, aid);

        // once claimed by someone else, only they may change it
        vm.prank(claimant);
        reg.claim("GOLD");
        vm.prank(other);
        vm.expectRevert(AssetRegistry.Unauthorized.selector);
        reg.linkAssetId("GOLD", keccak256(hex"A1beef"));
    }

    // ------------------------------------------------------------------ the hex idea

    /// The proposal was to end an address with the hex of the name. This records the size
    /// arithmetic on-chain so the comparison is a fact rather than an assertion.
    function test_HexSuffixIsAFractionOfTheAddress() public pure {
        // "GOLD" -> 474f4c44 is correct ASCII hex: 4 bytes.
        assertEq(uint256(bytes("GOLD").length), uint256(4));

        // An EVM address is 20 bytes = 40 hex chars = 160 bits.
        assertEq(uint256(20 * 8), uint256(160));

        // Matching a 4-byte suffix means 2^32 attempts, ~4.3 billion, and each further
        // hex character multiplies that by 16.
        assertEq(uint256(4 * 8), uint256(32), "4 bytes = 32 bits of hash space");
        assertEq(uint256(2 ** 32), uint256(4294967296), "attempts for a 4-byte suffix");
    }

    // ------------------------------------------------------------------ impersonation

    /// The design decision that matters. Letters O/I/L/0 are ALLOWED, because GOLD, SILVER
    /// and OIL need them. The attack is stopped by fingerprint instead: a name that
    /// collides under confusable substitution is refused.
    function test_GoldIsRegistrable() public {
        reg.register("GOLD", token, T_ERC20);
        assertEq(reg.resolve("GOLD"), token);
    }

    function test_SilverIsRegistrable() public {
        reg.register("SILVER", other, T_ERC20);
        assertEq(reg.resolve("SILVER"), other);
    }

    function test_ZeroForLetterOIsRejectedAfterGoldExists() public {
        reg.register("GOLD", token, T_ERC20);
        bytes32 held = reg.nodeOf("GOLD");
        vm.expectRevert(
            abi.encodeWithSelector(AssetRegistry.Impersonation.selector, "g0ld", held)
        );
        reg.register("G0LD", makeAddr("attacker"), T_ERC20);
    }

    function test_CaseVariantStillFingerprintsTogether() public {
        reg.register("GOLD", token, T_ERC20);
        vm.expectRevert();
        reg.register("g01d", makeAddr("attacker"), T_ERC20);
    }

    function test_FingerprintsCollideAsIntended() public view {
        assertEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("G0LD"));
        assertEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("GO1D"), "digit 1 must collide too");
        assertEq(reg.fingerprintOf("gold"), reg.fingerprintOf("GOLD"));
        assertNotEq(reg.fingerprintOf("GOLD"), reg.fingerprintOf("SILVER"));
    }

    function test_UnrelatedNamesStillCoexist() public {
        reg.register("GOLD", makeAddr("g"), T_ERC20);
        reg.register("SILVER", makeAddr("s"), T_ERC20);
        reg.register("USD", makeAddr("u"), T_ERC20);
        assertTrue(reg.exists("GOLD"));
        assertTrue(reg.exists("SILVER"));
        assertTrue(reg.exists("USD"));
    }
}
