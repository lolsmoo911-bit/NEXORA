// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {MockOracle} from "../src/MockOracle.sol";

contract MockOracleTest is Test {
    MockOracle oracle;

    address admin = makeAddr("admin");
    address feeder = makeAddr("feeder");
    address alice = makeAddr("alice");

    bytes32 constant GOLD = keccak256("XAUUSD");
    bytes32 constant EURUSD = keccak256("EURUSD");

    function setUp() public {
        vm.prank(admin);
        oracle = new MockOracle(admin, 300); // 5 min freshness
    }

    function test_InitialState() public view {
        assertEq(oracle.admin(), admin);
        assertTrue(oracle.feeders(admin));
        assertEq(oracle.maxStaleness(), 300);
    }

    function test_ConstructorZeroAdminReverts() public {
        vm.expectRevert(MockOracle.ZeroAddress.selector);
        new MockOracle(address(0), 60);
    }

    function test_AdminCanSetFeederAndFeederCanPush() public {
        vm.prank(admin);
        oracle.setFeeder(feeder, true);
        assertTrue(oracle.feeders(feeder));

        vm.warp(1_000);
        vm.prank(feeder);
        oracle.pushPrice(GOLD, 2350_00000000, 8, keccak256("mock-feed"));

        (uint256 price, uint8 decimals, uint64 updatedAt, bool isFresh) = oracle.getPrice(GOLD);
        assertEq(price, 2350_00000000);
        assertEq(decimals, 8);
        assertEq(updatedAt, 1_000);
        assertTrue(isFresh);
    }

    function test_NonFeederCannotPush() public {
        vm.prank(alice);
        vm.expectRevert(MockOracle.Unauthorized.selector);
        oracle.pushPrice(GOLD, 1, 8, bytes32(0));
    }

    function test_PushInvalidPriceReverts() public {
        vm.prank(admin);
        vm.expectRevert(MockOracle.InvalidPrice.selector);
        oracle.pushPrice(GOLD, 0, 8, bytes32(0));
    }

    function test_GetUnknownFeedAndPrice() public {
        (uint256 price, uint8 decimals, uint64 updatedAt, bytes32 sourceRef, bool isFresh, bool exists) = oracle.getFeed(GOLD);
        assertEq(price, 0);
        assertEq(decimals, 0);
        assertEq(updatedAt, 0);
        assertEq(sourceRef, bytes32(0));
        assertFalse(isFresh);
        assertFalse(exists);
        assertFalse(oracle.hasFeed(GOLD));

        vm.expectRevert(MockOracle.FeedNotFound.selector);
        oracle.getPrice(GOLD);
    }

    function test_FreshnessBecomesStaleAfterMaxStaleness() public {
        vm.warp(10_000);
        vm.prank(admin);
        oracle.pushPrice(EURUSD, 1_08000000, 8, keccak256("fx"));

        (, , , bool isFreshBefore) = oracle.getPrice(EURUSD);
        assertTrue(isFreshBefore);

        vm.warp(10_000 + 300);
        (, , , bool isFreshAtBoundary) = oracle.getPrice(EURUSD);
        assertTrue(isFreshAtBoundary);

        vm.warp(10_000 + 301);
        (, , , bool isFreshAfter) = oracle.getPrice(EURUSD);
        assertFalse(isFreshAfter);
    }

    function test_SetMaxStalenessAffectsFreshness() public {
        vm.warp(5_000);
        vm.prank(admin);
        oracle.pushPrice(GOLD, 2000_00000000, 8, bytes32("s1"));
        vm.warp(5_000 + 100);

        vm.prank(admin);
        oracle.setMaxStaleness(60);
        (, , , bool isFresh) = oracle.getPrice(GOLD);
        assertFalse(isFresh);

        vm.prank(admin);
        oracle.setMaxStaleness(200);
        (, , , isFresh) = oracle.getPrice(GOLD);
        assertTrue(isFresh);
    }

    function test_UpdateOverwritesFeed() public {
        vm.warp(1_000);
        vm.prank(admin);
        oracle.pushPrice(GOLD, 2000_00000000, 8, bytes32("a"));
        vm.warp(1_100);
        vm.prank(admin);
        oracle.pushPrice(GOLD, 2100_00000000, 8, bytes32("b"));

        (uint256 price, uint8 decimals, uint64 updatedAt, bytes32 sourceRef, bool isFresh, bool exists) = oracle.getFeed(GOLD);
        assertEq(price, 2100_00000000);
        assertEq(decimals, 8);
        assertEq(updatedAt, 1_100);
        assertEq(sourceRef, bytes32("b"));
        assertTrue(isFresh);
        assertTrue(exists);
    }

    function test_AdminTransferGrantsFeederAndRevokesOldPrivileges() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        oracle.transferAdmin(newAdmin);
        assertEq(oracle.admin(), newAdmin);
        assertTrue(oracle.feeders(newAdmin));

        vm.prank(newAdmin);
        oracle.pushPrice(GOLD, 123, 2, bytes32(0));

        vm.prank(admin);
        vm.expectRevert(MockOracle.Unauthorized.selector);
        oracle.setMaxStaleness(10);
    }
}
