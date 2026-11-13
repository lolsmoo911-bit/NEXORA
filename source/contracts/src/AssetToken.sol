// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/// @title AssetToken
/// @notice Test-only fungible representation token with basic roles, pause, and asset metadata.
/// @dev Minimal ERC-20 compatible implementation for local/testnet development (no external dependencies).
contract AssetToken {
    // --- ERC20 ---
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // --- Roles & control ---
    address public admin;
    mapping(address => bool) public minters;
    mapping(address => bool) public pausers;
    bool public paused;

    // --- Asset metadata (representation linkage) ---
    bytes32 public immutable aid;
    bytes32 public immutable assetClass; // e.g. keccak256("fiat"), "bond", etc.
    string public metadataURI;

    // --- Events ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event MinterSet(address indexed account, bool enabled);
    event PauserSet(address indexed account, bool enabled);
    event MetadataURIUpdated(string previousURI, string newURI);

    // --- Errors ---
    error Unauthorized();
    error PausedError();
    error ZeroAddress();
    error InsufficientBalance();
    error InsufficientAllowance();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyMinter() {
        if (!minters[msg.sender] && msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier onlyPauser() {
        if (!pausers[msg.sender] && msg.sender != admin) revert Unauthorized();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert PausedError();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        bytes32 aid_,
        bytes32 assetClass_,
        string memory metadataURI_,
        address admin_
    ) {
        if (admin_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        aid = aid_;
        assetClass = assetClass_;
        metadataURI = metadataURI_;
        admin = admin_;
        minters[admin_] = true;
        pausers[admin_] = true;
        emit AdminTransferred(address(0), admin_);
        emit MinterSet(admin_, true);
        emit PauserSet(admin_, true);
    }

    // --- Role management ---
    function transferAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        address prev = admin;
        admin = newAdmin;
        // keep new admin operational by default
        minters[newAdmin] = true;
        pausers[newAdmin] = true;
        emit AdminTransferred(prev, newAdmin);
        emit MinterSet(newAdmin, true);
        emit PauserSet(newAdmin, true);
    }

    function setMinter(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        minters[account] = enabled;
        emit MinterSet(account, enabled);
    }

    function setPauser(address account, bool enabled) external onlyAdmin {
        if (account == address(0)) revert ZeroAddress();
        pausers[account] = enabled;
        emit PauserSet(account, enabled);
    }

    function setMetadataURI(string calldata newURI) external onlyAdmin {
        string memory prev = metadataURI;
        metadataURI = newURI;
        emit MetadataURIUpdated(prev, newURI);
    }

    // --- Pause control ---
    function pause() external onlyPauser {
        if (paused) revert PausedError();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyPauser {
        if (!paused) revert PausedError();
        paused = false;
        emit Unpaused(msg.sender);
    }

    // --- ERC20 logic ---
    function transfer(address to, uint256 value) external whenNotPaused returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        if (spender == address(0)) revert ZeroAddress();
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external whenNotPaused returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function mint(address to, uint256 value) external onlyMinter whenNotPaused {
        if (to == address(0)) revert ZeroAddress();
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function burn(address from, uint256 value) external whenNotPaused {
        if (from == address(0)) revert ZeroAddress();
        if (msg.sender != from) {
            uint256 allowed = allowance[from][msg.sender];
            if (allowed != type(uint256).max) {
                if (allowed < value) revert InsufficientAllowance();
                unchecked {
                    allowance[from][msg.sender] = allowed - value;
                }
            }
        }
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            totalSupply -= value;
        }
        emit Transfer(from, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
        }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
