// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {SimulatedSettlement} from "../src/SimulatedSettlement.sol";

contract SimulatedSettlementTest is Test {
    SimulatedSettlement ss;

    address admin = makeAddr("admin");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant SID1 = keccak256("settlement-1");
    bytes32 constant SID2 = keccak256("settlement-2");
    bytes32 constant REF = keccak256("order-ref");

    function setUp() public {
        vm.prank(admin);
        ss = new SimulatedSettlement(admin);
        vm.prank(admin);
        ss.setOperator(operator, true);
    }

    function test_InitialState() public view {
        assertEq(ss.admin(), admin);
        assertTrue(ss.operators(operator));
    }

    function test_ConstructorZeroAdminReverts() public {
        vm.expectRevert(SimulatedSettlement.ZeroAddress.selector);
        new SimulatedSettlement(address(0));
    }

    function test_AdminCanSetOperatorAndTransferAdmin() public {
        address op2 = makeAddr("op2");
        vm.startPrank(admin);
        ss.setOperator(op2, true);
        assertTrue(ss.operators(op2));
        address newAdmin = makeAddr("newAdmin");
        ss.transferAdmin(newAdmin);
        vm.stopPrank();
        assertEq(ss.admin(), newAdmin);
    }

    function test_NonAdminCannotSetOperator() public {
        vm.prank(alice);
        vm.expectRevert(SimulatedSettlement.Unauthorized.selector);
        ss.setOperator(bob, true);
    }

    function test_DepositAndWithdrawCollateral() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        (uint256 available, uint256 locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);
        assertEq(ss.totalAvailable(), 100 ether);

        vm.prank(operator);
        ss.withdrawCollateral(alice, 40 ether);
        (available, locked) = ss.getAccount(alice);
        assertEq(available, 60 ether);
        assertEq(locked, 0);
        assertEq(ss.totalAvailable(), 60 ether);
    }

    function test_DepositWithdrawValidation() public {
        vm.startPrank(operator);
        vm.expectRevert(SimulatedSettlement.ZeroAddress.selector);
        ss.depositCollateral(address(0), 1);
        vm.expectRevert(SimulatedSettlement.InvalidAmount.selector);
        ss.depositCollateral(alice, 0);
        vm.expectRevert(SimulatedSettlement.InsufficientAvailableCollateral.selector);
        ss.withdrawCollateral(alice, 1);
        vm.stopPrank();
    }

    function test_CreateSettlementLocksCollateral() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);

        vm.prank(operator);
        ss.createSettlement(SID1, alice, bob, 500 ether, 30 ether, REF);

        (uint256 available, uint256 locked) = ss.getAccount(alice);
        assertEq(available, 70 ether);
        assertEq(locked, 30 ether);
        assertEq(ss.totalAvailable(), 70 ether);
        assertEq(ss.totalLocked(), 30 ether);

        (
            address initiator,
            address counterparty,
            uint256 amount,
            uint256 collateral,
            bytes32 referenceId,
            SimulatedSettlement.Status status,
            ,
        ) = ss.getSettlement(SID1);
        assertEq(initiator, alice);
        assertEq(counterparty, bob);
        assertEq(amount, 500 ether);
        assertEq(collateral, 30 ether);
        assertEq(referenceId, REF);
        assertEq(uint256(status), uint256(SimulatedSettlement.Status.Pending));
    }

    function test_CreateSettlementInsufficientCollateralReverts() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 10 ether);
        vm.prank(operator);
        vm.expectRevert(SimulatedSettlement.InsufficientAvailableCollateral.selector);
        ss.createSettlement(SID1, alice, bob, 100 ether, 11 ether, REF);
    }

    function test_CreateSettlementDuplicateOrInvalidReverts() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.startPrank(operator);
        vm.expectRevert(SimulatedSettlement.ZeroAddress.selector);
        ss.createSettlement(SID1, address(0), bob, 1, 0, REF);
        vm.expectRevert(SimulatedSettlement.InvalidAmount.selector);
        ss.createSettlement(SID1, alice, bob, 0, 0, REF);
        ss.createSettlement(SID1, alice, bob, 10 ether, 0, REF);
        vm.expectRevert(SimulatedSettlement.SettlementAlreadyExists.selector);
        ss.createSettlement(SID1, alice, bob, 10 ether, 0, REF);
        vm.stopPrank();
    }

    function test_MatchAndSettleReleasesCollateral() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.prank(operator);
        ss.createSettlement(SID1, alice, bob, 500 ether, 25 ether, REF);

        vm.prank(operator);
        ss.matchSettlement(SID1);
        (, , , , , SimulatedSettlement.Status status, , ) = ss.getSettlement(SID1);
        assertEq(uint256(status), uint256(SimulatedSettlement.Status.Matched));

        vm.prank(operator);
        ss.settleSettlement(SID1);
        (, , , , , status, , ) = ss.getSettlement(SID1);
        assertEq(uint256(status), uint256(SimulatedSettlement.Status.Settled));

        (uint256 available, uint256 locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);
        assertEq(ss.totalLocked(), 0);
    }

    function test_FailFromPendingAndMatchedReleasesCollateral() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.prank(operator);
        ss.createSettlement(SID1, alice, bob, 10 ether, 10 ether, REF);
        vm.prank(operator);
        ss.failSettlement(SID1);
        (uint256 available, uint256 locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);

        vm.prank(operator);
        ss.createSettlement(SID2, alice, bob, 10 ether, 20 ether, REF);
        vm.prank(operator);
        ss.matchSettlement(SID2);
        vm.prank(operator);
        ss.failSettlement(SID2);
        (available, locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);
    }

    function test_CancelFromPendingAndMatchedReleasesCollateral() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.prank(operator);
        ss.createSettlement(SID1, alice, bob, 10 ether, 15 ether, REF);
        vm.prank(operator);
        ss.cancelSettlement(SID1);
        (uint256 available, uint256 locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);

        vm.prank(operator);
        ss.createSettlement(SID2, alice, bob, 10 ether, 5 ether, REF);
        vm.prank(operator);
        ss.matchSettlement(SID2);
        vm.prank(operator);
        ss.cancelSettlement(SID2);
        (available, locked) = ss.getAccount(alice);
        assertEq(available, 100 ether);
        assertEq(locked, 0);
    }

    function test_InvalidStatusTransitionsRevert() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.prank(operator);
        ss.createSettlement(SID1, alice, bob, 10 ether, 10 ether, REF);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SimulatedSettlement.InvalidStatusTransition.selector,
                SimulatedSettlement.Status.Pending,
                SimulatedSettlement.Status.Settled
            )
        );
        ss.settleSettlement(SID1);

        vm.prank(operator);
        ss.matchSettlement(SID1);
        vm.prank(operator);
        ss.settleSettlement(SID1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(
                SimulatedSettlement.InvalidStatusTransition.selector,
                SimulatedSettlement.Status.Settled,
                SimulatedSettlement.Status.Failed
            )
        );
        ss.failSettlement(SID1);
    }

    function test_NonOperatorCannotMutate() public {
        vm.prank(operator);
        ss.depositCollateral(alice, 100 ether);
        vm.prank(alice);
        vm.expectRevert(SimulatedSettlement.Unauthorized.selector);
        ss.createSettlement(SID1, alice, bob, 10 ether, 1 ether, REF);
    }

    function test_UnknownSettlementReverts() public {
        vm.prank(operator);
        vm.expectRevert(SimulatedSettlement.SettlementNotFound.selector);
        ss.matchSettlement(SID1);
    }
}
