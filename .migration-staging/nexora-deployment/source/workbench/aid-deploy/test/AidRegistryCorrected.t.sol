// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidRegistry} from "../src/AidRegistry.sol";
import {Aid} from "../src/Aid.sol";
import {Harness} from "./Harness.sol";

/**
 * Tests for the workbench-corrected AidRegistry.
 *
 * Canonical `aid/src/AidRegistry.sol` accepts a caller-supplied chainId (SPEC §4.1
 * violation). This corrected registry reads `block.chainid`, requires it equals the
 * configured NEXORA EVM chain id (902024), and removes caller-supplied chainId from
 * register/verify. These tests prove the corrected semantics and the security fix.
 *
 * NOT a test of canonical tracked source. TESTNET-only artifact.
 */
contract AidRegistryCorrectedTest is Harness {
    AidRegistry internal registry;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal mallory = address(0xBAD);

    event Registered(bytes32 indexed assetId, uint8 indexed assetType, address indexed registrant);
    event Retracted(bytes32 indexed assetId, address indexed registrant);

    function setUp() public {
        vm.chainId(CHAIN);
        registry = new AidRegistry();
    }

    function _key(address token) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(token)));
    }

    function _other() internal pure returns (address) {
        return address(0x2222222222222222222222222222222222222222);
    }

    // ---------------------------------------------------------------- spec/security

    function test_configuredChainIdIs902024() public view {
        assertEq(registry.configuredChainId(), CHAIN, "configured chain id");
    }

    /// SPEC §4.1: contract must not trust caller-supplied chainId. Corrected API has no
    /// chainId parameter, so a caller cannot spoof a foreign-chain domain.
    function test_callerCannotSpoofForeignChainIdentifier() public {
        // ID computed for Ethereum mainnet (chain 1) — not valid on chain 902024.
        bytes32 foreignId = Aid.erc20Id(1, TOKEN);
        vm.expectRevert(
            abi.encodeWithSelector(
                AidRegistry.AidMetadataDoesNotMatchIdentifier.selector, foreignId, Aid.erc20Id(CHAIN, TOKEN)
            )
        );
        vm.prank(alice);
        registry.register(foreignId, T_ERC20, _key(TOKEN));

        assertFalse(registry.isRegistered(foreignId), "foreign-chain id must not register");
        assertEq(registry.totalRegistrations(), 0, "no trace");
    }

    function test_registerRevertsOnWrongBlockChainId() public {
        vm.chainId(1);
        bytes32 id = Aid.erc20Id(1, TOKEN);
        vm.expectRevert(abi.encodeWithSelector(Aid.AidChainMismatch.selector, CHAIN, uint256(1)));
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
    }

    function test_registerRevertsOnForkChainId() public {
        vm.chainId(902025);
        bytes32 id = Aid.erc20Id(902025, TOKEN);
        vm.expectRevert(abi.encodeWithSelector(Aid.AidChainMismatch.selector, CHAIN, uint256(902025)));
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
    }

    function test_retractRevertsOnWrongBlockChainId() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Aid.AidChainMismatch.selector, CHAIN, uint256(1)));
        vm.prank(alice);
        registry.retract(id);
    }

    function test_verifyRevertsOnWrongBlockChainId() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        vm.chainId(1);
        vm.expectRevert(abi.encodeWithSelector(Aid.AidChainMismatch.selector, CHAIN, uint256(1)));
        registry.verify(id, _key(TOKEN));
    }

    // ---------------------------------------------------------------- registration

    function test_registersAndReadsBack() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        assertTrue(registry.isRegistered(id), "should be registered");
        assertEq(registry.registrantOf(id), alice, "registrant");
        assertEq(uint256(registry.statusOf(id)), 1, "status");
        assertEq(registry.totalRegistrations(), 1, "count");
        assertEq(registry.assetIdAt(0), id, "ordering");

        AidRegistry.Entry memory e = registry.get(id);
        assertEq(uint256(e.assetType), uint256(T_ERC20), "stored type");
        assertEq(e.registrant, alice, "stored registrant");
    }

    function test_emitsRegistered() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.expectEmit(true, true, true, true);
        emit Registered(id, T_ERC20, alice);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
    }

    function test_rejectsMetadataThatDoesNotHashToTheIdentifier() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.expectRevert(
            abi.encodeWithSelector(
                AidRegistry.AidMetadataDoesNotMatchIdentifier.selector, id, Aid.erc20Id(CHAIN, _other())
            )
        );
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(_other()));

        assertFalse(registry.isRegistered(id), "must not be registered after a rejected call");
        assertEq(registry.totalRegistrations(), 0, "a rejected call leaves no trace");
    }

    function test_rejectsTheWrongAssetType() public {
        bytes32 nft = Aid.nftKey(TOKEN, 1);
        bytes32 id = Aid.erc721Id(CHAIN, TOKEN, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                AidRegistry.AidMetadataDoesNotMatchIdentifier.selector, id, Aid.erc1155Id(CHAIN, TOKEN, 1)
            )
        );
        vm.prank(alice);
        registry.register(id, T_ERC1155, nft);
    }

    function test_rejectsAnUnknownAssetType() public {
        vm.expectRevert(abi.encodeWithSelector(Aid.AidUnknownType.selector, uint8(4)));
        vm.prank(alice);
        registry.register(bytes32(uint256(7)), uint8(4), bytes32(0));
    }

    // ---------------------------------------------------------------- first claim wins

    function test_firstClaimWins() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        vm.expectRevert(abi.encodeWithSelector(AidRegistry.AidAlreadyRegistered.selector, id));
        vm.prank(mallory);
        registry.register(id, T_ERC20, _key(TOKEN));

        assertEq(registry.registrantOf(id), alice, "registrant must not change");
    }

    function test_aRetractedIdentifierCannotBeClaimedAgain() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
        vm.prank(alice);
        registry.retract(id);

        vm.expectRevert(abi.encodeWithSelector(AidRegistry.AidAlreadyRegistered.selector, id));
        vm.prank(mallory);
        registry.register(id, T_ERC20, _key(TOKEN));

        assertEq(registry.registrantOf(id), alice, "still alice's");
        assertFalse(registry.isRegistered(id), "still retracted");
    }

    // ---------------------------------------------------------------- retraction

    function test_onlyTheRegistrantCanRetract() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        vm.expectRevert(abi.encodeWithSelector(AidRegistry.AidNotTheRegistrant.selector, id, bob));
        vm.prank(bob);
        registry.retract(id);

        assertTrue(registry.isRegistered(id), "must survive a failed retraction");
    }

    function test_cannotRetractWhatWasNeverRegistered() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.expectRevert(abi.encodeWithSelector(AidRegistry.AidNotRegistered.selector, id));
        vm.prank(alice);
        registry.retract(id);
    }

    function test_cannotRetractTwice() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
        vm.prank(alice);
        registry.retract(id);

        vm.expectRevert(abi.encodeWithSelector(AidRegistry.AidNotRegistered.selector, id));
        vm.prank(alice);
        registry.retract(id);
    }

    // ---------------------------------------------------------------- verify

    function test_verifyConfirmsAGenuineEntry() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));

        assertTrue(registry.verify(id, _key(TOKEN)), "genuine entry must verify");
        assertFalse(registry.verify(id, _key(_other())), "wrong key must not verify");
    }

    function test_verifyIsFalseForRetractedAndUnknown() public {
        bytes32 id = Aid.erc20Id(CHAIN, TOKEN);
        assertFalse(registry.verify(id, _key(TOKEN)), "unknown");

        vm.prank(alice);
        registry.register(id, T_ERC20, _key(TOKEN));
        vm.prank(alice);
        registry.retract(id);

        assertFalse(registry.verify(id, _key(TOKEN)), "retracted is not a live claim");
    }

    // ---------------------------------------------------------------- pagination

    function test_paginateWalksEveryEntryExactlyOnce() public {
        uint256 n = 7;
        bytes32[] memory expected = new bytes32[](n);
        for (uint256 i = 0; i < n; i++) {
            address token = address(uint160(0x1000 + i));
            expected[i] = Aid.erc20Id(CHAIN, token);
            vm.prank(alice);
            registry.register(expected[i], T_ERC20, _key(token));
        }

        bool[] memory seen = new bool[](n);
        uint256 visits;
        uint256 cursor;

        while (cursor < n) {
            (AidRegistry.Entry[] memory entries, bytes32[] memory ids, uint256 next) = registry.paginate(cursor, 3);
            assertEq(ids.length, entries.length, "pages are parallel arrays");
            assertEq(next, cursor + ids.length, "cursor advances by page size");

            for (uint256 i = 0; i < ids.length; i++) {
                for (uint256 j = 0; j < n; j++) {
                    if (ids[i] == expected[j]) {
                        assertFalse(seen[j], "an entry must not appear on two pages");
                        seen[j] = true;
                        break;
                    }
                }
            }
            visits += ids.length;
            cursor = next;
        }

        assertEq(visits, n, "every entry visited once");
        for (uint256 j = 0; j < n; j++) {
            assertTrue(seen[j], "entry missing from the walk");
        }
    }
}
