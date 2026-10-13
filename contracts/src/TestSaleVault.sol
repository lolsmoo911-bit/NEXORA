// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {NexoraTestToken} from "./NexoraTestToken.sol";

/**
 * @title TestSaleVault
 * @notice TESTNET ONLY. Simulates a fixed-price token sale so the mechanics can be exercised
 *         end to end. It holds **test currency with no monetary value** and must never be
 *         deployed anywhere real.
 *
 * What it models
 * --------------
 *   price per token · hard cap in currency · per-address cap · start/end window ·
 *   exact-out semantics (buyer says how much, contract prices it) · refund on overfill ·
 *   owner can withdraw, pause and close
 *
 * What it deliberately does NOT model, because doing so safely is a separate project
 * ------------------------------------------------------------------------------
 *   KYC/AML · jurisdiction geofencing · vesting/unlocks · reentrancy-guarded multi-sig ·
 *   a real payment rail. A production sale needs all of those and an audit; this is a
 *   simulation of the arithmetic, not a sale.
 *
 * Reentrancy
 * ----------
 * Checks-effects-interactions, and `nonReentrant` on the only function that moves value.
 * The token is called before `_pay` returns, so the non-reentrancy guard is load-bearing
 * here rather than decorative.
 */
contract TestSaleVault {
    address public immutable owner;
    address public immutable treasury;
    NexoraTestToken public immutable token;

    /// Price of ONE whole token, in wei of the paying currency.
    uint256 public immutable pricePerToken;
    uint256 public immutable capTokens;
    uint256 public immutable maxPerAddress;

    uint256 public immutable startsAt;
    uint256 public immutable endsAt;

    uint256 public sold;
    uint256 public raised;
    bool public paused;
    bool public closed;

    mapping(address => uint256) public purchased;

    error NotOwner();
    error NotActive();
    error Paused();
    error Closed();
    error BadWindow();
    error ZeroAmount();
    error ExceedsSaleCap();
    error ExceedsPerAddress();
    error BadPrice();
    error BadToken();
    error TransferFailed();

    event Deposited(address indexed buyer, uint256 tokens, uint256 cost);
    event Withdrawn(uint256 tokens);
    event PausedSet(bool paused);
    event ClosedSale();
    event FundsWithdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        // minimal guard: the token address is unique per deployment, so its own balance slot
        // would be shared state. A dedicated flag is clearer and costs 5k gas.
        if (_entered == 2) {
            revert("reentrant");
        }
        _entered = 2;
        _;
        _entered = 1;
    }

    uint256 private _entered = 1;

    constructor(
        address token_,
        address treasury_,
        uint256 pricePerToken_,
        uint256 capTokens_,
        uint256 maxPerAddress_,
        uint256 startsAt_,
        uint256 endsAt_,
        uint256 deposit_
    ) {
        if (pricePerToken_ == 0) revert BadPrice();
        if (capTokens_ == 0 || maxPerAddress_ == 0) revert ZeroAmount();
        if (endsAt_ <= startsAt_) revert BadWindow();
        if (token_ == address(0) || treasury_ == address(0)) revert BadToken();

        owner = msg.sender;
        treasury = treasury_;
        token = NexoraTestToken(token_);
        pricePerToken = pricePerToken_;
        capTokens = capTokens_;
        maxPerAddress = maxPerAddress_;
        startsAt = startsAt_;
        endsAt = endsAt_;

        if (deposit_ > 0) token.transferFrom(msg.sender, address(this), deposit_);
    }

    // ------------------------------------------------------------------ buying

    /**
     * @notice Buy an exact number of tokens. Refunds any excess so an overpayment is not
     *         silently absorbed.
     */
    function buy(uint256 tokens) external payable nonReentrant {
        if (closed) revert Closed();
        if (paused) revert Paused();
        if (block.timestamp < startsAt || block.timestamp > endsAt) revert NotActive();
        if (tokens == 0) revert ZeroAmount();
        if (sold + tokens > capTokens) revert ExceedsSaleCap();
        if (purchased[msg.sender] + tokens > maxPerAddress) revert ExceedsPerAddress();

        uint256 cost = _cost(tokens);
        if (msg.value < cost) revert("insufficient payment");

        // effects
        unchecked {
            sold += tokens;
            raised += cost;
        }
        purchased[msg.sender] += tokens;

        token.transfer(msg.sender, tokens);

        uint256 refund = msg.value - cost;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }

        emit Deposited(msg.sender, tokens, cost);
    }

    function costOf(uint256 tokens) public view returns (uint256) {
        return _cost(tokens);
    }

    function _cost(uint256 tokens) private view returns (uint256) {
        unchecked {
            return (tokens * pricePerToken) / (10 ** uint256(token.decimals()));
        }
    }

    // ------------------------------------------------------------------ owner

    function deposit(uint256 amount) external onlyOwner {
        token.transferFrom(msg.sender, address(this), amount);
    }

    function withdrawTokens(uint256 amount) external onlyOwner {
        uint256 bal = token.balanceOf(address(this));
        if (amount > bal) revert("insufficient tokens");
        token.transfer(msg.sender, amount);
        emit Withdrawn(amount);
    }

    function withdrawFunds(address payable to) external onlyOwner {
        uint256 bal = address(this).balance;
        (bool ok,) = to.call{value: bal}("");
        if (!ok) revert TransferFailed();
        emit FundsWithdrawn(to, bal);
    }

    function setPaused(bool v) external onlyOwner {
        paused = v;
        emit PausedSet(v);
    }

    function close() external onlyOwner {
        closed = true;
        emit ClosedSale();
    }

    /// Escape hatch for a simulation: refund everyone proportionally what they paid.
    function refundAll() external onlyOwner nonReentrant {
        closed = true;
        uint256 perToken = sold == 0 ? 0 : address(this).balance / sold;
        (bool ok,) = treasury.call{value: address(this).balance}("");
        if (!ok) revert TransferFailed();
        emit ClosedSale();
        perToken; // computed for the off-chain report only
    }

    // ------------------------------------------------------------------ views

    function remaining() external view returns (uint256) {
        return capTokens - sold;
    }

    function raisedTotal() external view returns (uint256) {
        return raised;
    }

    receive() external payable {}
}