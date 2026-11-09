// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

/**
 * @title Create2Deployer
 * @notice TESTNET ONLY. The canonical CREATE2 forwarder, so that a NEXORA contract can be
 *         deployed at an address that was searched for in advance.
 *
 * WHY THIS EXISTS
 * ---------------
 * CREATE2 is an OPCODE, not a transaction type. It can only be executed by contract code,
 * never directly by an externally-owned account. So a transaction sent from a wallet cannot
 * say "deploy at 0x...474f4c44" — some contract has to run the opcode on its behalf.
 *
 * That is this contract. It is the "deployer" in the address formula:
 *
 *     address = keccak256(0xff ++ DEPLOYER ++ salt ++ keccak256(initcode))[12:]
 *
 * DEPLOYER is THIS contract's address, which is itself fixed the moment it is deployed from
 * a given EOA and nonce.
 *
 * THE CONSEQUENCE, AND IT IS THE WHOLE POINT
 * -----------------------------------------
 * A vanity salt is bound to one deployer address AND one exact initcode hash. This contract
 * is deliberately, permanently immutable and has no owner, no upgrade path and no state, so
 * its address is stable forever. That stability is the only reason a mined salt stays valid
 * across future deployments - if the deployer could be replaced, every mined address would
 * be dead on arrival.
 *
 * This is the same design as Arachnid's original deterministic-deployment-proxy.
 */
contract Create2Deployer {
    /**
     * @notice Deploy `initcode` to the CREATE2 address derived from `salt`.
     * @return deployed the resulting contract address
     *
     * Deliberately permissionless. If this required an owner, an owner could deploy the
     * same contract at a different address, and any vanity address mined against it would
     * be ambiguous. Allowing anyone to reuse the deployer costs nothing here because the
     * salt and the initcode decide the outcome, and `deployFailed` reverts the whole call
     * if the constructor throws.
     */
    function deploy(bytes32 salt, bytes memory initcode) public returns (address deployed) {
        assembly {
            deployed := create2(0, add(initcode, 0x20), mload(initcode), salt)
        }
        if (deployed == address(0)) revert DeployFailed();
    }

    /// Convenience overload so a raw initcode string can be passed through unchanged.
    function deployWithCode(bytes32 salt, bytes memory initcode)
        public
        returns (address deployed)
    {
        deployed = deploy(salt, initcode);
    }

    /**
     * @notice Deploy, then immediately make ONE call to the freshly created contract.
     *
     * WHY THIS EXISTS
     * ---------------
     * A contract created by CREATE2 sees the DEPLOYER as its `msg.sender` in the
     * constructor, not the externally-owned account that sent the transaction. A standard
     * ERC-20 mints its supply to `msg.sender`, so with `deploy()` alone the whole supply
     * lands on this contract, which holds nothing and can call nothing: the tokens are
     * stranded. Observed live - the supply read correctly at the factory while a transfer
     * from it reverted, because this contract has no ERC-20 interface.
     *
     * The alternative, a permissionless `sweep()`, is worse: it leaves a standing authority
     * that anyone could use to move anything this contract ever holds. One forward call,
     * consumed in the same transaction as the deployment, leaves no such authority behind.
     *
     * Adding this function does NOT change this contract's address. An address is
     * keccak256(rlp([deployer, nonce]))[12:] - it depends on WHO deployed and at WHICH
     * nonce, never on the code. Every salt already mined against this address stays valid.
     * That is precisely why the deployer had to be immutable and ownerless from the start.
     */
    function deployAndCall(bytes32 salt, bytes memory initcode, bytes memory callData)
        public
        returns (address deployed)
    {
        deployed = deploy(salt, initcode);
        if (callData.length > 0) {
            (bool ok, bytes memory ret) = deployed.call(callData);
            // Bubble the callee's revert reason so a failure here is diagnosable rather
            // than a bare failure with no explanation.
            if (!ok) {
                if (ret.length > 0) {
                    assembly {
                        revert(add(ret, 0x20), mload(ret))
                    }
                }
                revert CallFailed();
            }
        }
    }

    /// Pure helper so callers can predict an address without deploying anything.
    function computeAddress(bytes32 salt, bytes32 initcodeHash)
        public
        view
        returns (address predicted)
    {
        predicted = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initcodeHash))))
        );
    }

    error DeployFailed();
    error CallFailed();
}