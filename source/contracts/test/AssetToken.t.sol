// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {AssetToken} from "../src/AssetToken.sol";

contract AssetTokenTest is Test {
    AssetToken token;

    address admin = makeAddr("admin");
    address minter = makeAddr("minter");
    address pauser = makeAddr("pauser");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    bytes32 constant AID = bytes32(uint256(0xA11D));
    bytes32 constant ASSET_CLASS = keccak256("fiat");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event MinterSet(address indexed account, bool enabled);
    event PauserSet(address indexed account, bool enabled);
    event MetadataURIUpdated(string previousURI, string newURI);

    function setUp() public {
        vm.prank(admin);
        token = new AssetToken("NEXORA USD", "nUSD", 18, AID, ASSET_CLASS, "ipfs://asset-usd", admin);
    }

    function test_MetadataAndInitialState() public view {
        assertEq(token.name(), "NEXORA USD");
        assertEq(token.symbol(), "nUSD");
        assertEq(token.decimals(), 18);
        assertEq(token.totalSupply(), 0);
        assertEq(token.aid(), AID);
        assertEq(token.assetClass(), ASSET_CLASS);
        assertEq(token.metadataURI(), "ipfs://asset-usd");
        assertEq(token.admin(), admin);
        assertTrue(token.minters(admin));
        assertTrue(token.pausers(admin));
        assertFalse(token.paused());
    }

    function test_ConstructorZeroAdminReverts() public {
        vm.expectRevert(AssetToken.ZeroAddress.selector);
        new AssetToken("X", "X", 18, AID, ASSET_CLASS, "", address(0));
    }

    function test_AdminCanMint() public {
        vm.prank(admin);
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(0), alice, 100e18);
        token.mint(alice, 100e18);
        assertEq(token.balanceOf(alice), 100e18);
        assertEq(token.totalSupply(), 100e18);
    }

    function test_MinterRoleCanMint() public {
        vm.prank(admin);
        token.setMinter(minter, true);
        vm.prank(minter);
        token.mint(alice, 50e18);
        assertEq(token.balanceOf(alice), 50e18);
    }

    function test_NonMinterCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(AssetToken.Unauthorized.selector);
        token.mint(alice, 1);
    }

    function test_MintToZeroReverts() public {
        vm.prank(admin);
        vm.expectRevert(AssetToken.ZeroAddress.selector);
        token.mint(address(0), 1);
    }

    function test_Transfer() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.transfer(bob, 40e18);
        assertEq(token.balanceOf(alice), 60e18);
        assertEq(token.balanceOf(bob), 40e18);
    }

    function test_TransferInsufficientBalanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(AssetToken.InsufficientBalance.selector);
        token.transfer(bob, 1);
    }

    function test_TransferToZeroReverts() public {
        vm.prank(admin);
        token.mint(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(AssetToken.ZeroAddress.selector);
        token.transfer(address(0), 1);
    }

    function test_ApproveAndTransferFrom() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, 30e18);
        vm.prank(bob);
        token.transferFrom(alice, bob, 20e18);
        assertEq(token.balanceOf(bob), 20e18);
        assertEq(token.allowance(alice, bob), 10e18);
    }

    function test_TransferFromInsufficientAllowanceReverts() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, 10e18);
        vm.prank(bob);
        vm.expectRevert(AssetToken.InsufficientAllowance.selector);
        token.transferFrom(alice, bob, 11e18);
    }

    function test_InfiniteAllowanceNotDecremented() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, type(uint256).max);
        vm.prank(bob);
        token.transferFrom(alice, bob, 10e18);
        assertEq(token.allowance(alice, bob), type(uint256).max);
    }

    function test_BurnByOwner() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.burn(alice, 25e18);
        assertEq(token.balanceOf(alice), 75e18);
        assertEq(token.totalSupply(), 75e18);
    }

    function test_BurnBySpenderWithAllowance() public {
        vm.prank(admin);
        token.mint(alice, 100e18);
        vm.prank(alice);
        token.approve(bob, 40e18);
        vm.prank(bob);
        token.burn(alice, 30e18);
        assertEq(token.balanceOf(alice), 70e18);
        assertEq(token.allowance(alice, bob), 10e18);
    }

    function test_BurnInsufficientBalanceReverts() public {
        vm.prank(admin);
        token.mint(alice, 10e18);
        vm.prank(alice);
        vm.expectRevert(AssetToken.InsufficientBalance.selector);
        token.burn(alice, 11e18);
    }

    function test_PauseBlocksMintTransferBurnAndUnpauseRestores() public {
        vm.prank(admin);
        token.mint(alice, 100e18);

        vm.prank(admin);
        token.pause();
        assertTrue(token.paused());

        vm.prank(admin);
        vm.expectRevert(AssetToken.PausedError.selector);
        token.mint(alice, 1);

        vm.prank(alice);
        vm.expectRevert(AssetToken.PausedError.selector);
        token.transfer(bob, 1);

        vm.prank(alice);
        vm.expectRevert(AssetToken.PausedError.selector);
        token.burn(alice, 1);

        vm.prank(admin);
        token.unpause();
        assertFalse(token.paused());

        vm.prank(alice);
        token.transfer(bob, 5e18);
        assertEq(token.balanceOf(bob), 5e18);
    }

    function test_OnlyPauserCanPause() public {
        vm.prank(alice);
        vm.expectRevert(AssetToken.Unauthorized.selector);
        token.pause();
    }

    function test_PauserRoleCanPause() public {
        vm.prank(admin);
        token.setPauser(pauser, true);
        vm.prank(pauser);
        token.pause();
        assertTrue(token.paused());
    }

    function test_DoublePauseAndUnpauseRevert() public {
        vm.startPrank(admin);
        token.pause();
        vm.expectRevert(AssetToken.PausedError.selector);
        token.pause();
        token.unpause();
        vm.expectRevert(AssetToken.PausedError.selector);
        token.unpause();
        vm.stopPrank();
    }

    function test_RoleManagementAndAdminTransfer() public {
        vm.startPrank(admin);
        token.setMinter(minter, true);
        token.setPauser(pauser, true);
        assertTrue(token.minters(minter));
        assertTrue(token.pausers(pauser));

        address newAdmin = makeAddr("newAdmin");
        token.transferAdmin(newAdmin);
        vm.stopPrank();

        assertEq(token.admin(), newAdmin);
        assertTrue(token.minters(newAdmin));
        assertTrue(token.pausers(newAdmin));

        vm.prank(newAdmin);
        token.mint(alice, 1e18);
        assertEq(token.balanceOf(alice), 1e18);
    }

    function test_OldAdminLosesAdminPrivilegesAfterTransfer() public {
        address newAdmin = makeAddr("newAdmin");
        vm.prank(admin);
        token.transferAdmin(newAdmin);

        vm.prank(admin);
        vm.expectRevert(AssetToken.Unauthorized.selector);
        token.setMinter(bob, true);
    }

    function test_UpdateMetadataURI() public {
        vm.prank(admin);
        vm.expectEmit(false, false, false, true);
        emit MetadataURIUpdated("ipfs://asset-usd", "ipfs://asset-usd-v2");
        token.setMetadataURI("ipfs://asset-usd-v2");
        assertEq(token.metadataURI(), "ipfs://asset-usd-v2");
    }

    function test_ApproveZeroSpenderReverts() public {
        vm.prank(alice);
        vm.expectRevert(AssetToken.ZeroAddress.selector);
        token.approve(address(0), 1);
    }
}
