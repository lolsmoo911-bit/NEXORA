// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {NexoraTestToken} from "../src/NexoraTestToken.sol";
import {TestSaleVault} from "../src/TestSaleVault.sol";

/// TESTNET ONLY. Every figure below is fabricated for simulation.
contract SaleSimulationTest is Test {
    receive() external payable {}
    NexoraTestToken token;
    TestSaleVault vault;

    address treasury = makeAddr("treasury");
    address buyer1 = makeAddr("buyer1");
    address buyer2 = makeAddr("buyer2");
    address buyer3 = makeAddr("buyer3");

    uint256 constant PRICE_PER_TOKEN = 0.05 ether; // 0.05 test currency per whole token
    uint256 constant CAP = 1_000_000e18;
    uint256 constant MAX_PER_ADDRESS = 10_000e18;
    uint256 constant DEPOSIT = 500_000e18;

    function setUp() public {
        token = new NexoraTestToken(1_000_000_000e18);

        uint256 t = block.timestamp + 1 hours;
        vault = new TestSaleVault(
            address(token),
            treasury,
            PRICE_PER_TOKEN,
            CAP,
            MAX_PER_ADDRESS,
            t - 1 hours,
            t + 30 days,
            0
        );
        token.approve(address(vault), type(uint256).max);
        token.transfer(address(vault), DEPOSIT);

        vm.deal(buyer1, 100 ether);
        vm.deal(buyer2, 100 ether);
        vm.deal(buyer3, 100 ether);
    }

    function test_TokenMetadataAndSupply() public view {
        assertEq(token.name(), "Nexora Test Token");
        assertEq(token.symbol(), "NXIT");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 1_000_000_000e18);
    }

    function test_TransfersWork() public {
        uint256 before = token.balanceOf(buyer1);
        token.transfer(buyer1, 100e18);
        assertEq(token.balanceOf(buyer1), before + 100e18);
    }

    function test_CostMath() public view {
        // 1 whole token at 0.05 -> 0.05
        assertEq(vault.costOf(1e18), 0.05 ether);
        // 100 whole tokens -> 5
        assertEq(vault.costOf(100e18), 5 ether);
        // cost = tokens * price / 1e18, truncated. 33.333333333333333333 whole tokens at
        // 0.05 is 1.666666666666666666 — NOT 5. An earlier version asserted 5 here, which
        // asserted the wrong number and would have hidden a real pricing bug.
        assertEq(vault.costOf(33_333_333_333_333_333_333), 1_666_666_666_666_666_666);
    }

    function test_BuySucceedsAndUpdatesState() public {
        uint256 cost = vault.costOf(100e18);
        vm.prank(buyer1);
        vault.buy{value: cost}(100e18);

        assertEq(token.balanceOf(buyer1), 100e18);
        assertEq(vault.sold(), 100e18);
        assertEq(vault.raisedTotal(), cost);
        assertEq(vault.purchased(buyer1), 100e18);
    }

    function test_OverpaymentIsRefunded() public {
        uint256 cost = vault.costOf(10e18);
        uint256 sent = cost + 3 ether;
        vm.prank(buyer1);
        uint256 before = buyer1.balance;
        vault.buy{value: sent}(10e18);
        // balance fell by exactly cost, not sent
        assertEq(before - buyer1.balance, cost);
    }

    function test_UnderpaymentReverts() public {
        vm.prank(buyer1);
        vm.expectRevert("insufficient payment");
        vault.buy{value: 0.01 ether}(100e18);
    }

    function test_PerAddressCapEnforced() public {
        uint256 over = MAX_PER_ADDRESS + 1e18;
        uint256 cost = vault.costOf(over);
        // The call carries `cost`, and the EVM rejects an under-funded account BEFORE the
        // contract body runs. With only 100 ETH dealt, a 500.05 ETH call died with OutOfFunds
        // and the per-address assertion was never reached — the test failed for a reason that
        // had nothing to do with the cap it claims to test.
        vm.deal(buyer1, 10_000 ether);
        vm.expectRevert(TestSaleVault.ExceedsPerAddress.selector);
        vm.prank(buyer1);
        vault.buy{value: cost}(over);
    }

    function test_GlobalCapEnforced() public {
        // A single buyer can never reach a global cap larger than the per-address cap: the
        // per-address check runs first and reverts. Hitting the sale cap honestly needs a
        // vault whose CAP is BELOW its per-address limit, which is what this one is.
        TestSaleVault small = new TestSaleVault(
            address(token), treasury, PRICE_PER_TOKEN,
            100e18,                 // cap:      100 tokens
            MAX_PER_ADDRESS,        // per addr: 10_000 tokens
            block.timestamp - 1,
            block.timestamp + 30 days,
            0
        );
        token.approve(address(small), type(uint256).max);
        token.transfer(address(small), 200e18);

        uint256 over = 101e18;
        uint256 cost = small.costOf(over);
        vm.expectRevert(TestSaleVault.ExceedsSaleCap.selector);
        vm.prank(buyer1);
        small.buy{value: cost}(over);
    }

    function test_SaleWindowRespected() public {
        uint256 cost = vault.costOf(1e18);
        uint256 future = block.timestamp + 40 days;
        vm.warp(future);
        vm.expectRevert(TestSaleVault.NotActive.selector);
        vm.prank(buyer1);
        vault.buy{value: cost}(1e18);
    }

    function test_PauseStopsBuying() public {
        uint256 cost = vault.costOf(1e18);
        vault.setPaused(true);
        vm.expectRevert(TestSaleVault.Paused.selector);
        vm.prank(buyer1);
        vault.buy{value: cost}(1e18);
    }

    function test_NonOwnerCannotWithdraw() public {
        vm.expectRevert(TestSaleVault.NotOwner.selector);
        vm.prank(buyer1);
        vault.withdrawFunds(payable(buyer1));
    }

    function test_MultipleBuyersAccumulate() public {
        uint256 cost = vault.costOf(50e18);
        vm.prank(buyer1); vault.buy{value: cost}(50e18);
        vm.prank(buyer2); vault.buy{value: cost}(50e18);
        vm.prank(buyer3); vault.buy{value: cost}(50e18);

        assertEq(vault.sold(), 150e18);
        assertEq(vault.raisedTotal(), cost * 3);
        assertEq(vault.remaining(), CAP - 150e18);
    }

    function test_TokenShortfallBlocksPurchase() public {
        // drain the vault so the token transfer would fail
        uint256 cost = vault.costOf(1e18);
        vault.withdrawTokens(token.balanceOf(address(vault)));
        vm.expectRevert();
        vm.prank(buyer1);
        vault.buy{value: cost}(1e18);
    }
    // ------------------------------------------------------------------ refund accounting

    function test_ContributionsRecorded() public {
        uint256 cost1 = vault.costOf(50e18);
        uint256 cost2 = vault.costOf(25e18);

        vm.prank(buyer1); vault.buy{value: cost1}(50e18);
        vm.prank(buyer2); vault.buy{value: cost2}(25e18);

        assertEq(vault.contributed(buyer1), cost1, "buyer1 contribution");
        assertEq(vault.contributed(buyer2), cost2, "buyer2 contribution");
        assertEq(vault.totalContributed(), cost1 + cost2, "totalContributed");
        assertEq(vault.raisedTotal(), cost1 + cost2, "raised");
    }

    function test_OverpaymentDoesNotCountAsContribution() public {
        uint256 cost = vault.costOf(10e18);
        uint256 sent = cost + 3 ether;

        vm.prank(buyer1);
        vault.buy{value: sent}(10e18);

        assertEq(vault.contributed(buyer1), cost, "only retained cost counts");
        assertEq(vault.totalContributed(), cost, "totalContributed excludes excess");
    }

    function test_ExactRefundClaim() public {
        uint256 cost1 = vault.costOf(50e18);
        uint256 cost2 = vault.costOf(25e18);

        vm.prank(buyer1); vault.buy{value: cost1}(50e18);
        vm.prank(buyer2); vault.buy{value: cost2}(25e18);

        vault.refundAll();

        uint256 before1 = buyer1.balance;
        uint256 before2 = buyer2.balance;

        vm.prank(buyer1); vault.claimRefund();
        vm.prank(buyer2); vault.claimRefund();

        assertEq(buyer1.balance, before1 + cost1, "buyer1 exact refund");
        assertEq(buyer2.balance, before2 + cost2, "buyer2 exact refund");
        assertEq(vault.totalRefunded(), cost1 + cost2, "totalRefunded");
        assertTrue(vault.refundClaimed(buyer1), "buyer1 claimed");
        assertTrue(vault.refundClaimed(buyer2), "buyer2 claimed");
    }

    function test_DoubleClaimRejected() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vault.refundAll();

        vm.prank(buyer1); vault.claimRefund();
        vm.expectRevert(TestSaleVault.AlreadyClaimed.selector);
        vm.prank(buyer1); vault.claimRefund();
    }

    function test_ZeroContributionBuyerCannotClaim() public {
        vault.refundAll();

        vm.expectRevert(TestSaleVault.NoRefund.selector);
        vm.prank(buyer1); vault.claimRefund();
    }

    function test_EmptySaleRefunds() public {
        vault.refundAll();

        assertEq(vault.refundPool(), 0, "empty sale pool");
        assertEq(vault.totalContributed(), 0, "empty sale contributions");

        vm.expectRevert(TestSaleVault.NoRefund.selector);
        vm.prank(buyer1); vault.claimRefund();

        vm.deal(address(vault), 2 ether);
        vault.withdrawFunds(payable(address(this)));
        assertEq(address(vault).balance, 0, "surplus withdrawable");
    }

    function test_EnableRefundsRequiresFullBalance() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vm.deal(address(vault), 0);
        vm.expectRevert(TestSaleVault.InsufficientRefundBalance.selector);
        vault.refundAll();
    }

    function test_OwnerCanWithdrawSurplusBeforeRefunds() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vm.deal(address(vault), address(vault).balance + 5 ether);

        uint256 before = address(this).balance;
        uint256 surplus = address(vault).balance - vault.totalContributed();
        vault.withdrawFunds(payable(address(this)));

        assertEq(address(this).balance, before + surplus, "surplus withdrawn");
        assertEq(address(vault).balance, vault.totalContributed(), "reserved funds remain");
    }

    function test_OwnerCannotWithdrawReservedFundsBeforeRefunds() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vm.expectRevert(TestSaleVault.NoWithdrawableSurplus.selector);
        vault.withdrawFunds(payable(address(this)));
    }

    function test_OwnerCanWithdrawSurplusAfterRefunds() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vm.deal(address(vault), address(vault).balance + 3 ether);
        vault.refundAll();

        uint256 before = address(this).balance;
        vault.withdrawFunds(payable(address(this)));

        assertEq(address(this).balance, before + 3 ether, "surplus withdrawn after refunds");
        assertEq(address(vault).balance, vault.refundPool(), "refund pool remains");
    }

    function test_OwnerCannotWithdrawReservedFundsAfterRefunds() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vault.refundAll();

        vm.expectRevert(TestSaleVault.NoWithdrawableSurplus.selector);
        vault.withdrawFunds(payable(address(this)));
    }

    function test_ForcedEthSurplusRemainsWithOwner() public {
        uint256 cost = vault.costOf(10e18);
        vm.prank(buyer1); vault.buy{value: cost}(10e18);

        vm.deal(address(vault), address(vault).balance + 4 ether);
        vault.refundAll();

        vm.prank(buyer1); vault.claimRefund();
        assertEq(vault.totalRefunded(), cost, "buyer refunded actual contribution");

        uint256 before = address(this).balance;
        vault.withdrawFunds(payable(address(this)));
        assertEq(address(this).balance, before + 4 ether, "only surplus withdrawn");
    }

    function test_RoundingAccountingInvariants() public {
        uint256 tokens = 33_333_333_333_333_333_333;
        uint256 cost = vault.costOf(tokens);

        vm.prank(buyer1); vault.buy{value: cost}(tokens);

        assertEq(vault.contributed(buyer1), cost, "truncated cost recorded");
        assertEq(vault.totalContributed(), cost, "totalContributed");
        assertEq(vault.raisedTotal(), cost, "raised");

        vault.refundAll();
        vm.prank(buyer1); vault.claimRefund();

        assertEq(vault.totalRefunded(), cost, "refund equals recorded contribution");
        assertLe(vault.totalRefunded(), vault.refundPool(), "refund <= pool");
    }

    function test_PurchasesAfterClosureRevert() public {
        uint256 cost = vault.costOf(1e18);
        vault.close();

        vm.expectRevert(TestSaleVault.Closed.selector);
        vm.prank(buyer1);
        vault.buy{value: cost}(1e18);
    }

    function test_PurchasesAfterRefundEnablementRevert() public {
        uint256 cost = vault.costOf(1e18);
        vault.refundAll();

        vm.expectRevert(TestSaleVault.Closed.selector);
        vm.prank(buyer1);
        vault.buy{value: cost}(1e18);
    }

    function test_ReentrancyClaimRejected() public {
        uint256 cost = vault.costOf(10e18);

        ReentrantClaimer claimer = new ReentrantClaimer(vault);
        vm.deal(address(claimer), 10 ether);
        claimer.buy{value: cost}(10e18);

        vault.refundAll();

        vm.expectRevert(TestSaleVault.TransferFailed.selector);
        claimer.claim();
    }

    function test_FailedTransferCanRetry() public {
        uint256 cost = vault.costOf(10e18);

        RejectingBuyer buyer = new RejectingBuyer(vault);
        vm.deal(address(buyer), 10 ether);
        buyer.buy{value: cost}(10e18);

        vault.refundAll();

        vm.expectRevert(TestSaleVault.TransferFailed.selector);
        buyer.claim();

        assertFalse(vault.refundClaimed(address(buyer)), "claim state resets on failed transfer");

        buyer.setAccept(true);
        uint256 buyerBalanceBeforeClaim = address(buyer).balance;
        buyer.claim();

        assertEq(address(buyer).balance, buyerBalanceBeforeClaim + cost, "retry succeeds");
        assertTrue(vault.refundClaimed(address(buyer)), "claimed after retry");
    }

}

contract ReentrantClaimer {
    TestSaleVault public vault;

    constructor(TestSaleVault v) {
        vault = v;
    }

    function buy(uint256 tokens) external payable {
        vault.buy{value: msg.value}(tokens);
    }

    function claim() external {
        vault.claimRefund();
    }

    receive() external payable {
        vault.claimRefund();
    }
}

contract RejectingBuyer {
    TestSaleVault public vault;
    bool public accept;

    constructor(TestSaleVault v) {
        vault = v;
    }

    function setAccept(bool a) external {
        accept = a;
    }

    function buy(uint256 tokens) external payable {
        vault.buy{value: msg.value}(tokens);
    }

    function claim() external {
        vault.claimRefund();
    }

    receive() external payable {
        if (!accept) revert();
    }
}
