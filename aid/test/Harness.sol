// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Aid} from "../src/Aid.sol";

/**
 * Minimal assertion harness and cheat-code interface.
 *
 * No forge-std. Depending on a network-fetched package would add supply-chain surface to
 * the checks that must be reproducible offline, for about sixty lines of comparison code and
 * six method declarations. The `vm` address below is Foundry's own well-known cheat-code
 * address; declaring the interface here does not reimplement it.
 *
 * Every assertion failure reverts with a message naming what was expected and what was seen.
 * A bare `assert` over a 64-character hash tells you nothing about which of the two differs.
 */

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectRevert(bytes4) external;
    function expectEmit(bool, bool, bool, bool) external;
    function assume(bool) external;
    function addr(uint256) external returns (address);
    function warp(uint256) external;
    function label(address, string calldata) external;
}

abstract contract Harness {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant CHAIN = 902024;
    address internal constant TOKEN = address(0x1111111111111111111111111111111111111111);

    /**
     * Asset type codes, restated here.
     *
     * Solidity forbids a contract from reading a library's `internal` constants, so these
     * cannot be imported from `Aid`. The duplication is intentional and harmless: if the
     * library's codes were ever changed, every vector test would fail immediately, because
     * these values are used to build the identifiers being checked.
     */
    uint8 internal constant T_NATIVE = 0x00;
    uint8 internal constant T_ERC20 = 0x01;
    uint8 internal constant T_ERC721 = 0x02;
    uint8 internal constant T_ERC1155 = 0x03;

    function assertEq(bytes32 a, bytes32 b, string memory what) internal pure {
        if (a != b) {
            revert(
                string(
                    abi.encodePacked(
                        what, ": ", Aid.toCanonicalString(a), " != ", Aid.toCanonicalString(b)
                    )
                )
            );
        }
    }

    function assertEq(bytes32 a, string memory b, string memory what) internal pure {
        assertEq(a, Aid.fromCanonicalString(b), what);
    }

    function assertEq(address a, address b, string memory what) internal pure {
        if (a != b) {
            revert(string(abi.encodePacked(what, ": ", _addr(a), " != ", _addr(b))));
        }
    }

    function assertEq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string(abi.encodePacked(what, ": ", _u(a), " != ", _u(b))));
    }

    function assertTrue(bool condition, string memory what) internal pure {
        if (!condition) revert(what);
    }

    function assertFalse(bool condition, string memory what) internal pure {
        if (condition) revert(what);
    }

    function _u(uint256 n) internal pure returns (string memory) {
        if (n == 0) return "0";
        bytes memory tmp;
        while (n > 0) {
            tmp = bytes(abi.encodePacked(bytes1(uint8(48 + (n % 10))), tmp));
            n /= 10;
        }
        return string(tmp);
    }

    /// @dev Canonical string of an address, for readable failure messages.
    function _addr(address a) internal pure returns (string memory) {
        bytes memory out = new bytes(42);
        out[0] = "0";
        out[1] = "x";
        bytes16 alphabet = "0123456789abcdef";
        uint160 v = uint160(a);
        for (uint256 i = 0; i < 20; i++) {
            uint8 b = uint8(v >> uint8((19 - i) * 8) & 0xff);
            out[2 + i * 2] = alphabet[b >> 4];
            out[3 + i * 2] = alphabet[b & 0x0f];
        }
        return string(out);
    }
}
