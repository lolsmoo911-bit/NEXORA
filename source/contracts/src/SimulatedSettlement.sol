// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title SimulatedSettlement
/// @notice Test-only simulated collateral and settlement state machine for local development.
/// @dev No real assets are transferred; balances and settlements are virtual accounting entries.
contract SimulatedSettlement {
    enum Status {
        None,
        Pending,
        Matched,
        Settled,
        Failed,
        Cancelled
    }

    struct Account {
        uint256 available;
        uint256 locked;
    }

    struct Settlement {
        address initiator;
        address counterparty;
        uint256 amount;         // simulated settlement amount
        uint256 collateral;     // simulated collateral locked from initiator
        bytes32 referenceId;    // external/reference id (order id, asset id, etc.)
        Status status;
        uint64 createdAt;
        uint64 updatedAt;
    }

    address public admin;
    mapping(address => bool) public operators;

    mapping(address => Account) private accounts;
    mapping(bytes32 => Settlement) private settlements;
    mapping(bytes32 => bool) public settlementExists;

    uint256 public totalAvailable;
    uint256 public totalLocked;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event OperatorSet(address indexed account, bool enabled);
    event CollateralDeposited(address indexed account, uint256 amount, uint256 availableBalance);
    event CollateralWithdrawn(address indexed account, uint256 amount, uint256 availableBalance);
    event SettlementCreated(bytes32 indexed settlementId, address indexed initiator, address indexed counterparty, uint256 amount, uint256 collateral, bytes32 referenceId);
    event SettlementStatusChanged(bytes32 indexed settlementId, Status previousStatus, Status newStatus);

    error Unauthorized();
    error ZeroAddress();
    error InvalidAmount();
    error SettlementAlreadyExists();
    error SettlementNotFound();
    error InvalidStatusTransition(Status current, Status next);
    error InsufficientAvailableCollateral();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyOperatorOrAdmin() {
        if (msg.sender != admin && !operators[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address admin_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminTransferred(address(0), admin_);
    }

    // --- Admin / operators ---
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = admin;
        admin = newAdmin;
        emit AdminTransferred(prev, newAdmin);
    }

    function setOperator(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        operators[account] = enabled;
        emit OperatorSet(account, enabled);
    }

    // --- Collateral (simulated) ---
    function depositCollateral(address account, uint256 amount) external onlyOperatorOrAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        accounts[account].available += amount;
        totalAvailable += amount;
        emit CollateralDeposited(account, amount, accounts[account].available);
    }

    function withdrawCollateral(address account, uint256 amount) external onlyOperatorOrAdmin {
        if (account == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        Account storage a = accounts[account];
        if (a.available < amount) revert InsufficientAvailableCollateral();
        a.available -= amount;
        totalAvailable -= amount;
        emit CollateralWithdrawn(account, amount, a.available);
    }

    // --- Settlement lifecycle ---
    function createSettlement(
        bytes32 settlementId,
        address initiator,
        address counterparty,
        uint256 amount,
        uint256 collateral,
        bytes32 referenceId
    ) external onlyOperatorOrAdmin {
        if (initiator == address(0) || counterparty == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (settlementExists[settlementId]) revert SettlementAlreadyExists();

        if (collateral > 0) {
            Account storage a = accounts[initiator];
            if (a.available < collateral) revert InsufficientAvailableCollateral();
            a.available -= collateral;
            a.locked += collateral;
            totalAvailable -= collateral;
            totalLocked += collateral;
        }

        settlements[settlementId] = Settlement({
            initiator: initiator,
            counterparty: counterparty,
            amount: amount,
            collateral: collateral,
            referenceId: referenceId,
            status: Status.Pending,
            createdAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp)
        });
        settlementExists[settlementId] = true;

        emit SettlementCreated(settlementId, initiator, counterparty, amount, collateral, referenceId);
        emit SettlementStatusChanged(settlementId, Status.None, Status.Pending);
    }

    function matchSettlement(bytes32 settlementId) external onlyOperatorOrAdmin {
        Settlement storage s = _getSettlement(settlementId);
        if (s.status != Status.Pending) revert InvalidStatusTransition(s.status, Status.Matched);
        _setStatus(settlementId, s, Status.Matched);
    }

    function settleSettlement(bytes32 settlementId) external onlyOperatorOrAdmin {
        Settlement storage s = _getSettlement(settlementId);
        if (s.status != Status.Matched) revert InvalidStatusTransition(s.status, Status.Settled);
        _unlockToAvailable(s.initiator, s.collateral);
        _setStatus(settlementId, s, Status.Settled);
    }

    function failSettlement(bytes32 settlementId) external onlyOperatorOrAdmin {
        Settlement storage s = _getSettlement(settlementId);
        if (s.status != Status.Pending && s.status != Status.Matched) {
            revert InvalidStatusTransition(s.status, Status.Failed);
        }
        _unlockToAvailable(s.initiator, s.collateral);
        _setStatus(settlementId, s, Status.Failed);
    }

    function cancelSettlement(bytes32 settlementId) external onlyOperatorOrAdmin {
        Settlement storage s = _getSettlement(settlementId);
        if (s.status != Status.Pending && s.status != Status.Matched) {
            revert InvalidStatusTransition(s.status, Status.Cancelled);
        }
        _unlockToAvailable(s.initiator, s.collateral);
        _setStatus(settlementId, s, Status.Cancelled);
    }

    // --- Views ---
    function getAccount(address account) external view returns (uint256 available, uint256 locked) {
        Account storage a = accounts[account];
        return (a.available, a.locked);
    }

    function getSettlement(bytes32 settlementId)
        external
        view
        returns (
            address initiator,
            address counterparty,
            uint256 amount,
            uint256 collateral,
            bytes32 referenceId,
            Status status,
            uint64 createdAt,
            uint64 updatedAt
        )
    {
        Settlement storage s = _getSettlement(settlementId);
        return (s.initiator, s.counterparty, s.amount, s.collateral, s.referenceId, s.status, s.createdAt, s.updatedAt);
    }

    // --- Internal ---
    function _getSettlement(bytes32 settlementId) internal view returns (Settlement storage s) {
        if (!settlementExists[settlementId]) revert SettlementNotFound();
        s = settlements[settlementId];
    }

    function _setStatus(bytes32 settlementId, Settlement storage s, Status next) internal {
        Status prev = s.status;
        s.status = next;
        s.updatedAt = uint64(block.timestamp);
        emit SettlementStatusChanged(settlementId, prev, next);
    }

    function _unlockToAvailable(address account, uint256 amount) internal {
        if (amount == 0) return;
        Account storage a = accounts[account];
        // Invariant: locked >= amount for tracked settlements; guarded by state machine usage.
        a.locked -= amount;
        a.available += amount;
        totalLocked -= amount;
        totalAvailable += amount;
    }
}
