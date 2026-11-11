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
    uint256 public totalContributed;
    bool public paused;
    bool public closed;

    bool public refundsEnabled;
    uint256 public refundPool;
    uint256 public totalRefunded;
    mapping(address => bool) public refundClaimed;

    mapping(address => uint256) public purchased;
    mapping(address => uint256) public contributed;

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
    error RefundsNotEnabled();
    error RefundsAlreadyEnabled();
    error InsufficientRefundBalance();
    error NoRefund();
    error AlreadyClaimed();
    error NoWithdrawableSurplus();

    event Deposited(address indexed buyer, uint256 tokens, uint256 cost);
    event Withdrawn(uint256 tokens);
    event PausedSet(bool paused);
    event ClosedSale();
    event FundsWithdrawn(address indexed to, uint256 amount);
    event RefundsEnabled(uint256 pool);
    event Refunded(address indexed buyer, uint256 amount);

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
        sold += tokens;
        raised += cost;
        totalContributed += cost;
        purchased[msg.sender] += tokens;
        contributed[msg.sender] += cost;

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
        uint256 liability = refundsEnabled
            ? refundPool - totalRefunded
            : totalContributed;

        if (address(this).balance < liability) revert InsufficientRefundBalance();
        uint256 amount = address(this).balance - liability;
        if (amount == 0) revert NoWithdrawableSurplus();

        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FundsWithdrawn(to, amount);
    }

    function setPaused(bool v) external onlyOwner {
        paused = v;
        emit PausedSet(v);
    }

    function close() external onlyOwner {
        closed = true;
        emit ClosedSale();
    }

    /// @notice Close the sale and enable buyer pull refunds.
    /// @dev Refunds are based on each buyer's actual retained contribution, not token quantity.
    ///      ETH refunds do not reclaim tokens already delivered to buyers.
    function refundAll() external onlyOwner nonReentrant {
        _enableRefunds();
    }

    /// @notice Alias for refundAll(), retained for callers that use the explicit name.
    function enableRefunds() external onlyOwner nonReentrant {
        _enableRefunds();
    }

    function _enableRefunds() internal {
        if (refundsEnabled) revert RefundsAlreadyEnabled();

        closed = true;
        paused = true;

        if (address(this).balance < totalContributed) revert InsufficientRefundBalance();

        refundsEnabled = true;
        refundPool = totalContributed;
        emit RefundsEnabled(refundPool);
        emit ClosedSale();
    }

    /// @notice Claim the buyer's actual retained contribution.
    function claimRefund() external nonReentrant {
        if (!refundsEnabled) revert RefundsNotEnabled();

        uint256 amount = contributed[msg.sender];
        if (amount == 0) revert NoRefund();
        if (refundClaimed[msg.sender]) revert AlreadyClaimed();

        refundClaimed[msg.sender] = true;
        totalRefunded += amount;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Refunded(msg.sender, amount);
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