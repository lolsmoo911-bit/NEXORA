// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title VanityAsset
 * @notice TESTNET ONLY. A minimal ERC-20 designed to be deployed at a CREATE2 vanity
 *         address that visibly ends with the hex encoding of its own name.
 *
 * The point of this contract is the ADDRESS, not the token
 * -------------------------------------------------------
 * The NEXORA asset naming idea is that an asset's name should be visible at the end of its
 * contract address: GOLD ends in 474f4c44, SILVER in 53494c564552, USD in 555344.
 *
 * That address cannot be requested from the EVM. It can only be searched for, and the
 * search is the expensive part. This contract exists so that the search has something to
 * aim at: it is deliberately small, because every byte of constructor arguments and every
 * line of logic changes the creation bytecode, which changes the initcode hash, which
 * invalidates a salt mined for a different version.
 *
 * CONSEQUENCE, AND IT IS NOT SMALL: a salt is only valid for one exact creation bytecode.
 * Change ANYTHING about this file - a line of code, a variable name, a compiler version -
 * and the previously mined address is dead and the search must start again.
 *
 * That coupling is the real cost of a vanity address, far more than the mining time. It is
 * the reason `AssetRegistry` remains the durable naming layer and this contract is the
 * cosmetic one: a name in a registry can be re-pointed, a mined address cannot.
 *
 * Everything here is a standard ERC-20. No tax, no reflection, no rebasing, no fees.
 */
contract VanityAsset {
    /// Not `constant`: these are constructor arguments, and a constant must be initialised
    /// at declaration. Keeping them as plain storage slots also keeps the creation bytecode
    /// small, which is what the salt is mined against.
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public immutable totalSupply;

    mapping(address => uint256) private _balances;
    mapping(address => mapping(address => uint256)) private _allowances;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint256 supply_) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        _balances[msg.sender] = supply_;
        emit Transfer(address(0), msg.sender, supply_);
    }

    function balanceOf(address a) external view returns (uint256) {
        return _balances[a];
    }

    function allowance(address o, address s) external view returns (uint256) {
        return _allowances[o][s];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _allowances[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = _allowances[from][msg.sender];
        require(allowed >= value, "allowance");
        if (allowed != type(uint256).max) _allowances[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(to != address(0), "zero");
        uint256 bal = _balances[from];
        require(bal >= value, "balance");
        unchecked {
            _balances[from] = bal - value;
        }
        _balances[to] += value;
        emit Transfer(from, to, value);
    }
}