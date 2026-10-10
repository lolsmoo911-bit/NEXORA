// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title NexoraGreeter
/// @notice Minimal contract used ONLY for Phase 1 deployment verification on the
///         unmodified Cosmos EVM reference chain (cosmos/evm v0.7.3).
/// @dev No access control, no external calls, no NEXORA-specific logic.
contract NexoraGreeter {
    string private greeting;

    event GreetingChanged(string oldGreeting, string newGreeting);

    constructor(string memory initialGreeting) {
        greeting = initialGreeting;
    }

    /// @return the stored greeting.
    function greet() external view returns (string memory) {
        return greeting;
    }

    /// @notice Updates the stored greeting.
    function setGreeting(string calldata newGreeting) external {
        emit GreetingChanged(greeting, newGreeting);
        greeting = newGreeting;
    }
}
