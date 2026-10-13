// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title NexoraTestToken
 * @notice TESTNET ONLY. A plain ERC-20 used to simulate token mechanics on the NEXORA
 *         testnet. It is not the NEXORA asset and has no monetary value.
 *
 * Why this is separate from ANEX
 * ------------------------------
 * ANEX is the chain's NATIVE currency, held in the Cosmos bank module and denominated in
 * `anex`. It is not an ERC-20 and cannot be governed by a Solidity contract. A token sale
 * therefore needs its OWN contract, which is what this file is.
 *
 * Deliberate omissions
 * --------------------
 * No transfer tax, no reflection, no max-wallet, no anti-bot. Those belong to tokens people
 * hold money in. This one only needs to behave like a standard ERC-20 so that a sale can be
 * simulated honestly.
 *
 * Supply is fixed at construction and the whole supply is minted to the deployer, who then
 * deposits the sale allocation into the sale contract. There is no owner mint afterwards: a
 * fixed supply is easier to model and impossible to silently inflate.
 */
contract NexoraTestToken {
    // --- ERC-20 ---
    string public constant name = "Nexora Test Token";
    string public constant symbol = "NXTT";
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    // A public state variable named `balanceOf` auto-generates `balanceOf(address)`
    // returning uint256, which collides with the ERC-20 function of the same name that
    // returns the CALLER's balance. Declare the ERC-20 interface explicitly and keep the
    // mapping private.
    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    // Moved rather than mapped so Transfer/Approval emit a real indexed topic.
    address public immutable creator;
    uint256 public immutable createdAt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error InvalidRecipient();
    error ZeroSupply();

    // --- ERC-20 surface, declared explicitly (see the note on _balances above) ---

    function balanceOf(address account) public view returns (uint256) {
        return _balances[account];
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        return _allowances[owner][spender];
    }

    constructor(uint256 supply_) {
        if (supply_ == 0) revert ZeroSupply();
        totalSupply = supply_;
        _balances[msg.sender] = supply_;
        creator = msg.sender;
        createdAt = block.timestamp;
        emit Transfer(address(0), msg.sender, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked {
                _allowances[from][msg.sender] = allowed - value;
            }
        }
        _move(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    /// Burn is permissionless: a simulation should not need an owner key to clean up.
    function burn(uint256 value) external {
        if (_balances[msg.sender] < value) revert InsufficientBalance();
        unchecked {
            _balances[msg.sender] -= value;
        }
        emit Transfer(msg.sender, address(0), value);
    }

    function _move(address from, address to, uint256 value) private {
        if (to == address(0)) revert InvalidRecipient();
        if (_balances[from] < value) revert InsufficientBalance();
        unchecked {
            _balances[from] -= value;
            _balances[to] += value;
        }
        emit Transfer(from, to, value);
    }
}