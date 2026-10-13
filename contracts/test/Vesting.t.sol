// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {NexoraTestToken} from "../src/NexoraTestToken.sol";
import {LinearVesting} from "../src/LinearVesting.sol";

/// TESTNET ONLY.
contract VestingTest is Test {
    NexoraTestToken token;
    LinearVesting vest;

    address beneficiary = makeAddr("beneficiary");
    address stranger = makeAddr("stranger");

    uint256 constant TOTAL = 1_000_000e18;
    uint256 constant START = 1_800_000_000;
    uint256 constant CLIFF = 30 days;
    uint256 constant DURATION = 365 days;

    function setUp() public {
        token = new NexoraTestToken(100_000_000e18);

        vest = new LinearVesting(address(token), beneficiary, START, CLIFF, DURATION, TOTAL);
        // fund() AFTER deploy: the address exists now, so the allowance can name it.
        token.approve(address(vest), TOTAL);
        vest.fund(TOTAL);
    }

    // ------------------------------------------------------------------ symbol

    function test_SymbolIsNXIT() public view {
        assertEq(token.symbol(), "NXIT");
    }

    // ------------------------------------------------------------------ schedule

    function test_FundsHeldByContract() public view {
        assertEq(token.balanceOf(address(vest)), TOTAL);
        assertEq(vest.total(), TOTAL);
        assertEq(vest.released(), 0);
    }

    function test_NothingUnlocksBeforeCliff() public {
        vm.warp(START + CLIFF - 1);
        assertEq(vest.vested(), 0);
        assertEq(vest.releasable(), 0);
        assertEq(vest.vestedBps(), 0);
    }

    function test_ExactlyZeroAtCliff() public {
        vm.warp(START + CLIFF);
        assertEq(vest.vested(), 0, "cliff means nothing at the cliff instant");
    }

    function test_HalfwayThroughDurationIsHalf() public {
        vm.warp(START + CLIFF + DURATION / 2);
        assertEq(vest.vested(), TOTAL / 2);
        assertEq(vest.vestedBps(), 5000);
    }

    function test_FullyVestedAfterDuration() public {
        vm.warp(START + CLIFF + DURATION);
        assertEq(vest.vested(), TOTAL);
        assertEq(vest.vestedBps(), 10_000);
    }

    /// Far PAST the end date. Without this, the suite could not tell the saturating branch
    /// (`if elapsed >= duration return total`) from the plain ratio, because at exactly
    /// elapsed == duration both return the same number. Removing the branch entirely still
    /// passed 15/15 until this test existed.
    function test_NeverVestsMoreThanTotal() public {
        vm.warp(START + CLIFF + DURATION + 3650 days);
        assertEq(vest.vested(), TOTAL, "must saturate, not extrapolate");
    }

    function test_ClaimLongAfterEndDrainsEverything() public {
        vm.warp(START + CLIFF + DURATION + 3650 days);
        vm.prank(beneficiary);
        vest.claim();
        assertEq(vest.released(), TOTAL);
        assertEq(token.balanceOf(address(vest)), 0);
    }

    function test_LinearCurveIsMonotonic() public {
        uint256 previous;
        for (uint256 i = 0; i <= 10; i++) {
            vm.warp(START + CLIFF + (DURATION * i) / 10);
            uint256 v = vest.vested();
            assertGe(v, previous, "vested must never decrease");
            previous = v;
        }
    }

    // ------------------------------------------------------------------ claiming

    function test_ClaimBeforeCliffReverts() public {
        vm.warp(START + 10);
        vm.prank(beneficiary);
        vm.expectRevert(LinearVesting.NothingToRelease.selector);
        vest.claim();
    }

    function test_ClaimPaysAccruedAmount() public {
        vm.warp(START + CLIFF + DURATION / 4);
        uint256 expect = TOTAL / 4;

        vm.prank(beneficiary);
        vest.claim();

        assertEq(token.balanceOf(beneficiary), expect);
        assertEq(vest.released(), expect);
        assertEq(vest.releasable(), 0, "nothing accrued again at the same instant");
    }

    function test_ClaimTwiceAtSameTimePaysNothingTwice() public {
        vm.warp(START + CLIFF + DURATION / 4);

        vm.prank(beneficiary);
        vest.claim();

        vm.prank(beneficiary);
        vm.expectRevert(LinearVesting.NothingToRelease.selector);
        vest.claim();
    }

    function test_IncrementalClaimsMatchSingleClaim() public {
        // The property that matters: claiming in pieces must equal claiming once. Cumulative
        // time-based accounting makes this true by construction; a per-claim accumulator
        // would drift.
        uint256 start = START + CLIFF;

        vm.warp(start + DURATION);
        vm.prank(beneficiary);
        vest.claim();
        uint256 single = token.balanceOf(beneficiary);

        LinearVesting piece = new LinearVesting(address(token), beneficiary, START, CLIFF, DURATION, TOTAL);
        token.approve(address(piece), TOTAL);
        piece.fund(TOTAL);

        for (uint256 i = 1; i <= 5; i++) {
            vm.warp(start + (DURATION * i) / 5);
            vm.prank(beneficiary);
            piece.claim();
        }

        assertEq(token.balanceOf(beneficiary) - single, TOTAL, "piecewise total must equal TOTAL");
    }

    function test_FullDrainLeavesNoDust() public {
        vm.warp(START + CLIFF + DURATION);
        vm.prank(beneficiary);
        vest.claim();

        assertEq(vest.released(), TOTAL);
        assertEq(vest.releasable(), 0);
        assertEq(token.balanceOf(address(vest)), 0, "rounding dust must not be stranded");
    }

    function test_StrangerCannotClaim() public {
        vm.warp(START + CLIFF + DURATION / 2);
        vm.prank(stranger);
        vm.expectRevert(LinearVesting.NotBeneficiary.selector);
        vest.claim();
    }

    // ------------------------------------------------------------------ guards

    function test_CliffLongerThanDurationRejected() public {
        vm.expectRevert(LinearVesting.BadSchedule.selector);
        new LinearVesting(address(token), beneficiary, START, DURATION + 1, DURATION, TOTAL);
    }

    function test_ZeroBeneficiaryRejected() public {
        vm.expectRevert(LinearVesting.BadSchedule.selector);
        new LinearVesting(address(token), address(0), START, CLIFF, DURATION, TOTAL);
    }
}