// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {NexoraTestToken} from "./NexoraTestToken.sol";

/**
 * @title LinearVesting
 * @notice TESTNET ONLY. Cliff + linear vesting for tokens bought in the sale.
 *
 * Shape
 * -----
 *   cliff      nothing is withdrawable until `start + cliff`
 *   duration   after the cliff, the balance unlocks linearly over `duration`
 *   remainder  whatever is left when time runs out
 *
 * Why a separate contract rather than a flag on the token
 * -------------------------------------------------------
 * Because locking logic that lives in the token has to be trusted by every holder of every
 * token forever. Here it lives in one auditable place, tokens stay a plain ERC-20, and a
 * token that is ever minted to a team or treasury can be vested by a different contract
 * without touching the token's code.
 *
 * Pull, not push
 * --------------
 * Beneficiaries withdraw. A push model would let one expensive claim grief every other
 * beneficiary by forcing the contract to iterate all of them.
 *
 * Rounding
 * --------
 * `vested()` is cumulative and computed from elapsed time, never accumulated per claim, so
 * claiming in many small pieces and claiming in one piece are indistinguishable — a class of
 * rounding bug this shape avoids by construction.
 */
contract LinearVesting {
    struct Schedule {
        uint256 start;
        uint256 cliff;
        uint256 duration;
        uint256 total;
        uint256 released;
    }

    NexoraTestToken public immutable token;
    address public immutable beneficiary;

    uint256 public immutable start;
    uint256 public immutable cliff;
    uint256 public immutable duration;

    uint256 public immutable total;
    uint256 public released;

    event Created(address indexed beneficiary, uint256 total, uint256 start, uint256 cliff, uint256 duration);
    event Released(address indexed to, uint256 amount, uint256 totalReleased);

    error NotBeneficiary();
    error NothingToRelease();
    error BadSchedule();
    error AlreadyFunded();
    error Underfunded(uint256 have, uint256 want);

    constructor(
        address token_,
        address beneficiary_,
        uint256 start_,
        uint256 cliff_,
        uint256 duration_,
        uint256 total_
    ) {
        if (token_ == address(0) || beneficiary_ == address(0)) revert BadSchedule();
        // A cliff longer than the duration locks everything forever; catch it at construction
        // rather than discovering it after the sale has sold.
        if (cliff_ > duration_) revert BadSchedule();

        token = NexoraTestToken(token_);
        beneficiary = beneficiary_;
        start = start_;
        cliff = cliff_;
        duration = duration_;
        total = total_;

        emit Created(beneficiary_, total_, start_, cliff_, duration_);
    }

    /**
     * @notice Deposit the tokens this schedule will vest.
     *
     * Deliberately NOT in the constructor. A constructor that pulls tokens needs an allowance
     * granted to an address that does not exist yet, which is impossible: the deployer must
     * know the contract's address before deploying it. Splitting the deposit out removes that
     * circularity and makes the funded amount observable as state rather than implied.
     */
    function fund(uint256 amount) external {
        if (token.balanceOf(address(this)) > 0) revert AlreadyFunded();
        if (amount < total) revert Underfunded(token.balanceOf(address(this)), total);
        token.transferFrom(msg.sender, address(this), amount);
    }

    /// Cumulative amount unlocked as of `block.timestamp`.
    function vested() public view returns (uint256) {
        return vestedAt(block.timestamp);
    }

    function vestedAt(uint256 time) public view returns (uint256) {
        if (time < start + cliff) return 0;

        uint256 elapsed = time - (start + cliff);
        if (elapsed >= duration) return total;

        // total * elapsed / duration, truncated. The final branch returns `total` exactly so
        // the last claimer receives the rounding dust that integer division would otherwise
        // strand in the contract forever.
        return (total * elapsed) / duration;
    }

    function releasable() public view returns (uint256) {
        uint256 v = vested();
        return v > released ? v - released : 0;
    }

    function claim() external {
        if (msg.sender != beneficiary) revert NotBeneficiary();
        uint256 amount = releasable();
        if (amount == 0) revert NothingToRelease();

        released += amount;
        token.transfer(beneficiary, amount);
        emit Released(beneficiary, amount, released);
    }

    /// Read-only: what fraction is unlocked, in basis points.
    function vestedBps() external view returns (uint256) {
        if (total == 0) return 0;
        return (vested() * 10_000) / total;
    }
}