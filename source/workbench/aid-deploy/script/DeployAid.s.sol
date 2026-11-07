// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Aid} from "../src/Aid.sol";
import {AidRegistry} from "../src/AidRegistry.sol";
import {AidFactory} from "../src/AidFactory.sol";

interface Vm {
    function envUint(string calldata name) external returns (uint256);
    function startBroadcast(uint256 privateKey) external;
    function stopBroadcast() external;
}

/// @notice TESTNET ONLY workbench deployment. No key CLI args.
///         Reads DEPLOYER_PRIVATE_KEY via vm.envUint (supports 0x-prefixed hex string).
///         Deploys corrected AidRegistry + unchanged AidFactory, registers/verifies native AID,
///         and performs a deterministic CREATE2 sample deployment.
contract DeployAid {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant EXPECTED_CHAIN_ID = 902024;

    function run() external {
        require(block.chainid == EXPECTED_CHAIN_ID, "chain id mismatch");
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        AidRegistry registry = new AidRegistry();
        AidFactory factory = new AidFactory();

        bytes32 nativeId = Aid.nativeId(block.chainid);
        registry.register(nativeId, Aid.T_NATIVE, bytes32(0));
        require(registry.verify(nativeId, bytes32(0)), "native verify failed");

        bytes memory initCode = hex"600a600c600039600a6000f3602a60005260206000f3";
        bytes32 assetId = bytes32(uint256(0x1111));
        bytes32 initHash = keccak256(initCode);
        bytes32 salt = factory.saltFor(assetId, initHash);
        address predicted = factory.predict(salt, initHash);
        address deployed = factory.deploy(salt, initCode);
        require(deployed == predicted, "CREATE2 mismatch");
        require(factory.isDeployed(salt, initHash), "not deployed");

        vm.stopBroadcast();
    }
}
