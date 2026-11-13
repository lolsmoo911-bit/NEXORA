// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title MockOracle
/// @notice Test-only local price feed oracle for simulated assets and environments.
contract MockOracle {
    struct Feed {
        uint256 price;
        uint8 decimals;
        uint64 updatedAt;
        bytes32 sourceRef;
        bool exists;
    }

    address public admin;
    mapping(address => bool) public feeders;
    uint256 public maxStaleness; // seconds

    mapping(bytes32 => Feed) private feeds;

    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event FeederSet(address indexed account, bool enabled);
    event MaxStalenessUpdated(uint256 previousValue, uint256 newValue);
    event PricePushed(bytes32 indexed assetKey, uint256 price, uint8 decimals, uint64 updatedAt, bytes32 sourceRef, address indexed feeder);

    error Unauthorized();
    error ZeroAddress();
    error InvalidPrice();
    error FeedNotFound();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyFeeder() {
        if (msg.sender != admin && !feeders[msg.sender]) revert Unauthorized();
        _;
    }

    constructor(address admin_, uint256 maxStaleness_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        maxStaleness = maxStaleness_;
        feeders[admin_] = true;
        emit AdminTransferred(address(0), admin_);
        emit FeederSet(admin_, true);
        emit MaxStalenessUpdated(0, maxStaleness_);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = admin;
        admin = newAdmin;
        feeders[newAdmin] = true;
        emit AdminTransferred(prev, newAdmin);
        emit FeederSet(newAdmin, true);
    }

    function setFeeder(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        feeders[account] = enabled;
        emit FeederSet(account, enabled);
    }

    function setMaxStaleness(uint256 newMaxStaleness) external onlyAdmin {
        uint256 prev = maxStaleness;
        maxStaleness = newMaxStaleness;
        emit MaxStalenessUpdated(prev, newMaxStaleness);
    }

    function pushPrice(bytes32 assetKey, uint256 price, uint8 decimals, bytes32 sourceRef) external onlyFeeder {
        if (price == 0) revert InvalidPrice();
        uint64 ts = uint64(block.timestamp);
        feeds[assetKey] = Feed({
            price: price,
            decimals: decimals,
            updatedAt: ts,
            sourceRef: sourceRef,
            exists: true
        });
        emit PricePushed(assetKey, price, decimals, ts, sourceRef, msg.sender);
    }

    function getFeed(bytes32 assetKey)
        external
        view
        returns (uint256 price, uint8 decimals, uint64 updatedAt, bytes32 sourceRef, bool isFresh, bool exists)
    {
        Feed storage f = feeds[assetKey];
        if (!f.exists) {
            return (0, 0, 0, bytes32(0), false, false);
        }
        bool fresh = (block.timestamp - uint256(f.updatedAt)) <= maxStaleness;
        return (f.price, f.decimals, f.updatedAt, f.sourceRef, fresh, true);
    }

    function getPrice(bytes32 assetKey) external view returns (uint256 price, uint8 decimals, uint64 updatedAt, bool isFresh) {
        Feed storage f = feeds[assetKey];
        if (!f.exists) revert FeedNotFound();
        bool fresh = (block.timestamp - uint256(f.updatedAt)) <= maxStaleness;
        return (f.price, f.decimals, f.updatedAt, fresh);
    }

    function hasFeed(bytes32 assetKey) external view returns (bool) {
        return feeds[assetKey].exists;
    }
}
