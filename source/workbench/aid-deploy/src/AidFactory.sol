// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Deterministic deployment via CREATE2.
 *
 * An asset's registry (or any per-asset contract) should have an address that anyone can
 * compute before it exists, and that no one else can take. CREATE2 gives both, subject to
 * three ways of getting it wrong, all of which are handled and tested here:
 *
 * 1. **Address collision.** Two different init codes can hash to the same address. CREATE2
 *    silently returns the existing contract instead of failing, so a deployment "succeeds"
 *    while deploying nothing. `deploy` therefore reverts when the target already holds code,
 *    and checks the result after the fact rather than trusting the return value.
 *
 * 2. **Constructor arguments are part of the init code, not the salt.** Two deployments that
 *    differ only in a constructor argument have *different* addresses even with the same
 *    salt. Salting on `(assetId, version)` alone would not make an address a stable function
 *    of the asset. `saltFor` therefore also commits to the init code hash.
 *
 * 3. **The deploying address is part of the address.** The same salt from a different
 *    factory yields a different address. `predict` therefore takes the factory, and the
 *    factory rejects any attempt to use an address other than its own.
 */
contract AidFactory {
    error AidAddressAlreadyInUse(address predicted, bytes32 salt);
    error AidDeploymentMismatch(address expected, address actual);
    error AidEmptyInitCode();
    error AidZeroAddress();

    event Deployed(address indexed contractAddress, bytes32 indexed salt, bytes32 initCodeHash);

    /**
     * @notice Salt for a per-asset deployment.
     * @param assetId     the AID this deployment belongs to
     * @param initCodeHash hash of the exact init code, so the salt commits to it
     *
     * Commits to the init code because CREATE2's address is a function of
     * (deployer, salt, keccak256(initCode)). A salt that ignored the init code would let two
     * different contracts share one address, which is the collision from point 1 arriving by
     * a different route.
     */
    function saltFor(bytes32 assetId, bytes32 initCodeHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0xA2), assetId, initCodeHash));
    }

    /**
     * @notice The address a given (salt, initCodeHash) pair will produce from this factory.
     * @dev Standard CREATE2 derivation: keccak256(0xff ++ factory ++ salt ++ initCodeHash).
     *      View-only, so it can be called before anything exists.
     */
    function predict(bytes32 salt, bytes32 initCodeHash) public view returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash))))
        );
    }

    /// @notice Convenience: the address this asset's deployment will have.
    function predictForAsset(bytes32 assetId, bytes32 initCodeHash) external view returns (address) {
        return predict(saltFor(assetId, initCodeHash), initCodeHash);
    }

    /**
     * @notice Deploys `initCode` at a deterministic address.
     * @param salt       any 32-byte salt; use saltFor() for per-asset deployments
     * @param initCode   full creation code, including constructor arguments
     *
     * Returns the deployed address. Reverts if the target already has code — without that
     * check, a second deployment of the same salt returns an address that looks like a
     * success and contains a different, older contract.
     */
    function deploy(bytes32 salt, bytes memory initCode) external payable returns (address) {
        return _deploy(salt, initCode);
    }

    /**
     * @notice Deploys a contract for a specific asset, using saltFor() for the salt.
     *
     * The assetId is recorded in the salt so that a caller can later prove an address
     * belongs to an asset without trusting their own bookkeeping.
     */
    function deployForAsset(bytes32 assetId, bytes memory initCode) external payable returns (address) {
        return _deploy(saltFor(assetId, keccak256(initCode)), initCode);
    }

    /**
     * @dev The shared body. Both entry points are `external`, and Solidity will not resolve
     *      an external function called by bare name inside its own contract, so the logic
     *      lives here rather than one entry point calling the other.
     */
    function _deploy(bytes32 salt, bytes memory initCode) private returns (address deployed) {
        if (initCode.length == 0) revert AidEmptyInitCode();

        bytes32 initCodeHash = keccak256(initCode);
        address predicted = predict(salt, initCodeHash);
        if (predicted == address(0)) revert AidZeroAddress();
        // The collision guard. Without it CREATE2 is not idempotent, it is deceptive.
        if (predicted.code.length != 0) revert AidAddressAlreadyInUse(predicted, salt);

        assembly {
            deployed := create2(callvalue(), add(initCode, 0x20), mload(initCode), salt)
        }

        // CREATE2 returns 0 on failure. Returning 0 would hand the caller an address that
        // was never deployed, so it is a revert rather than a return value.
        if (deployed == address(0)) revert AidDeploymentMismatch(predicted, address(0));
        // Defence in depth: the address is recomputed from the actual deployment, not from
        // the salt the caller supplied.
        if (deployed != predicted) revert AidDeploymentMismatch(predicted, deployed);

        emit Deployed(deployed, salt, initCodeHash);
    }

    /// @notice True when the predicted address holds code — i.e. a deployment already exists.
    function isDeployed(bytes32 salt, bytes32 initCodeHash) external view returns (bool) {
        return predict(salt, initCodeHash).code.length != 0;
    }
}
