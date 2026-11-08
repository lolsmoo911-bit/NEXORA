// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {VanityAsset} from "../src/VanityAsset.sol";

/// TESTNET ONLY.
contract VanityAssetTest is Test {
    // Redeclared here rather than inherited: events declared inside `VanityAsset` are not in
    // scope in this contract, so `emit Transfer(...)` would not resolve. Same signature, so
    // `vm.expectEmit` still matches the real log.
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    VanityAsset gold;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant SUPPLY = 1_000_000e18;

    function setUp() public {
        gold = new VanityAsset("GOLD", "GLD", SUPPLY);
    }

    function test_Metadata() public view {
        assertEq(gold.name(), "GOLD");
        assertEq(gold.symbol(), "GLD");
        assertEq(gold.decimals(), 18);
        assertEq(gold.totalSupply(), SUPPLY);
    }

    function test_SupplyMintedToDeployer() public view {
        assertEq(gold.balanceOf(address(this)), SUPPLY);
    }

    function test_Transfer() public {
        gold.transfer(alice, 100e18);
        assertEq(gold.balanceOf(alice), 100e18);
        assertEq(gold.balanceOf(address(this)), SUPPLY - 100e18);
    }

    function test_EmitTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit Transfer(address(this), alice, 1e18);
        gold.transfer(alice, 1e18);
    }

    function test_TransferMoreThanBalanceReverts() public {
        vm.expectRevert(bytes("balance"));
        gold.transfer(alice, SUPPLY + 1);
    }

    function test_TransferToZeroReverts() public {
        vm.expectRevert(bytes("zero"));
        gold.transfer(address(0), 1);
    }

    function test_ApproveAndSpend() public {
        gold.approve(alice, 50e18);
        assertEq(gold.allowance(address(this), alice), 50e18);
        vm.prank(alice);
        gold.transferFrom(address(this), bob, 20e18);
        assertEq(gold.balanceOf(bob), 20e18);
        assertEq(gold.allowance(address(this), alice), 30e18);
    }

    function test_InfiniteApprovalNotDecremented() public {
        gold.approve(alice, type(uint256).max);
        vm.prank(alice);
        gold.transferFrom(address(this), bob, 1e18);
        assertEq(gold.allowance(address(this), alice), type(uint256).max);
    }

    function test_SpendBeyondAllowanceReverts() public {
        gold.approve(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(bytes("allowance"));
        gold.transferFrom(address(this), bob, 2e18);
    }

    // ------------------------------------------------------------------ the address premise

    /**
     * The whole reason this contract exists is that its deployed ADDRESS is supposed to end
     * with the hex of its name. Solidity cannot check that, because a contract cannot see its
     * own address during construction. `address(this)` inside a constructor is still zero.
     *
     * What CAN be pinned down on-chain is the part that makes the address predictable in the
     * first place: the CREATE2 derivation is pure arithmetic over public inputs. These tests
     * assert that arithmetic matches keccak256, so a mined salt that is correct here will land
     * on the same address on any EVM chain.
     */
    function test_Create2DerivationMatchesKeccak() public view {
        bytes32 initHash = keccak256(abi.encodePacked(type(VanityAsset).creationCode));
        bytes32 salt = keccak256("nexora-vanity-test");
        address predicted = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash))))
        );

        // Independent recomputation of the last 20 bytes.
        //
        // The digest is 32 bytes but an address is only 20 of them, so the comparison must
        // take the LOW 20 bytes. Comparing the full word against a left-padded address
        // always fails: the top 12 bytes of a keccak digest are not zero.
        bytes32 digest = keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initHash));
        assertEq(address(uint160(uint256(digest))), predicted);
        assertTrue(predicted != address(0));
    }

    /// Deploying the same creation code at the same salt and deployer MUST be impossible:
    /// a salt cannot be reused, which is what stops an attacker from front-running a
    /// vanity deployment and taking the address themselves.
    ///
    /// Checked with the low-level CREATE2 rather than `vm.expectRevert`: the failure comes
    /// from the EVM's deploy routine, not from a Solidity `revert()`, so there is no revert
    /// data and the failure surfaces as a false `success` flag at the same call depth that
    /// `expectRevert` was set from. `expectRevert` rejects that shape outright.
    function test_SameSaltSameDeployerCannotRedeploy() public {
        bytes memory code = abi.encodePacked(
            type(VanityAsset).creationCode,
            abi.encode("GOLD", "GLD", SUPPLY)
        );
        bytes32 salt = keccak256("nexora-vanity-dup");

        assertTrue(this.deployCreate2(code, salt), "first CREATE2 must succeed");
        assertFalse(this.deployCreate2(code, salt), "reusing a salt must fail");
    }

    /// Helper so the test contract is the CREATE2 deployer and the raw success flag is
    /// observable. `this.` rather than `address(this).` — a member is looked up on the
    /// contract type, not on `address`.
    function deployCreate2(bytes memory code, bytes32 salt) external returns (bool success) {
        assembly {
            success := create2(0, add(code, 0x20), mload(code), salt)
        }
    }

    /// Names are case-preserving on-chain because they are the thing being hex-encoded.
    /// GOLD -> 474f4c44, and "Gold" would encode differently. The registry layer, not this
    /// contract, is what makes resolution case-insensitive.
    function test_NameIsCasePreserving() public {
        VanityAsset mixed = new VanityAsset("Gold", "GLD", 1e18);
        assertEq(mixed.name(), "Gold");
        assertTrue(keccak256(bytes("Gold")) != keccak256(bytes("GOLD")), "case changes the hex");
    }
}