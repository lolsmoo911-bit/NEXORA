// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AidFactory} from "../src/AidFactory.sol";
import {Aid} from "../src/Aid.sol";
import {Harness} from "./Harness.sol";

/// @dev Stand-in init code. The factory is agnostic about what it deploys; a one-field
///      contract is enough to prove address derivation, and has no behaviour to get wrong.
contract Marker {
    address public immutable tag;
    constructor(address t) {
        tag = t;
    }
}

/// @dev A second init code, to prove that two different contracts can never share an address.
contract OtherMarker {
    uint256 public value;
    constructor(uint256 v) {
        value = v;
    }
}

/**
 * Factory tests.
 *
 * The three failure modes named in AidFactory's header are each tested directly:
 * collision, constructor-argument drift, and a different deployer producing a different
 * address. CREATE2 is easy to get subtly wrong and looks correct while doing it.
 */
contract AidFactoryTest is Harness {
    AidFactory internal factory;

    event Deployed(address indexed contractAddress, bytes32 indexed salt, bytes32 initCodeHash);

    function setUp() public {
        factory = new AidFactory();
    }

    // ---------------------------------------------------------------- derivation

    function test_predictMatchesTheDeployedAddress() public {
        bytes memory code = abi.encodePacked(type(Marker).creationCode, abi.encode(address(0xCAFE)));
        bytes32 hash = keccak256(code);
        bytes32 salt = keccak256("salt-one");

        address predicted = factory.predict(salt, hash);
        address actual = factory.deploy(salt, code);

        assertEq(actual, predicted, "prediction must hold, not merely resemble the result");
        assertEq(Marker(actual).tag(), address(0xCAFE), "the deployed code is the code we sent");
    }

    /// The prediction must be callable before anything exists. If it were not, an address
    /// could not be known in advance and the whole point of CREATE2 would be lost.
    function test_predictIsUsableBeforeDeployment() public view {
        bytes32 hash = keccak256(abi.encodePacked(type(Marker).creationCode, abi.encode(address(1))));
        address predicted = factory.predict(keccak256("future"), hash);
        assertTrue(predicted != address(0), "a prediction exists");
        assertFalse(predicted.code.length != 0, "nothing is deployed yet");
    }

    function test_isDeployedFlipsAfterDeployment() public {
        bytes memory code = type(OtherMarker).creationCode;
        bytes32 hash = keccak256(abi.encodePacked(code, abi.encode(uint256(7))));
        bytes32 salt = keccak256("flip");

        assertFalse(factory.isDeployed(salt, hash), "before");
        factory.deploy(salt, abi.encodePacked(code, abi.encode(uint256(7))));
        assertTrue(factory.isDeployed(salt, hash), "after");
    }

    // ---------------------------------------------------------------- collisions

    /// Without this guard CREATE2 is not idempotent, it is deceptive: a second deployment
    /// with the same salt returns the address of the first contract and deploys nothing.
    function test_secondDeploymentWithTheSameSaltReverts() public {
        bytes memory code = abi.encodePacked(type(Marker).creationCode, abi.encode(address(1)));
        bytes32 salt = keccak256("collision");
        factory.deploy(salt, code);

        address predicted = factory.predict(salt, keccak256(code));
        vm.expectRevert(
            abi.encodeWithSelector(AidFactory.AidAddressAlreadyInUse.selector, predicted, salt)
        );
        factory.deploy(salt, code);
    }

    /// Same salt, different constructor argument. The addresses must differ, because the
    /// constructor arguments are part of the init code, not the salt.
    function test_constructorArgumentsChangeTheAddress() public {
        bytes32 salt = keccak256("args");
        address a = factory.deploy(salt, abi.encodePacked(type(Marker).creationCode, abi.encode(address(1))));
        address b = factory.deploy(salt, abi.encodePacked(type(Marker).creationCode, abi.encode(address(2))));

        assertTrue(a != b, "different init code must mean a different address");
        assertEq(Marker(a).tag(), address(1), "first");
        assertEq(Marker(b).tag(), address(2), "second");
    }

    function test_twoDifferentContractsCannotShareASalt() public {
        bytes32 salt = keccak256("mixed");
        address a = factory.deploy(salt, abi.encodePacked(type(Marker).creationCode, abi.encode(address(1))));
        address b = factory.deploy(salt, abi.encodePacked(type(OtherMarker).creationCode, abi.encode(uint256(1))));
        assertTrue(a != b, "different contracts must not collide");
    }

    /// The salt commits to the init code. Two assets with the same init code must still get
    /// different addresses, and the same asset must always get the same one.
    function test_saltForCommitsToBothAssetAndInitCode() public view {
        bytes32 hashA = keccak256("code-a");
        bytes32 hashB = keccak256("code-b");
        bytes32 asset1 = Aid.erc20Id(CHAIN, TOKEN);
        bytes32 asset2 = Aid.erc20Id(CHAIN, address(0x2222222222222222222222222222222222222222));

        assertTrue(factory.saltFor(asset1, hashA) != factory.saltFor(asset2, hashA), "asset must matter");
        assertTrue(factory.saltFor(asset1, hashA) != factory.saltFor(asset1, hashB), "init code must matter");
        assertEq(factory.saltFor(asset1, hashA), factory.saltFor(asset1, hashA), "must be deterministic");
    }

    function test_deployForAssetIsPredictable() public {
        bytes memory code = abi.encodePacked(type(Marker).creationCode, abi.encode(address(9)));
        bytes32 asset = Aid.erc20Id(CHAIN, TOKEN);

        address predicted = factory.predictForAsset(asset, keccak256(code));
        address actual = factory.deployForAsset(asset, code);

        assertEq(actual, predicted, "per-asset deployment must be predictable in advance");
    }

    function test_deployForAssetGivesDifferentAssetsDifferentAddresses() public {
        bytes memory code = type(OtherMarker).creationCode;
        bytes32 asset1 = Aid.erc20Id(CHAIN, TOKEN);
        bytes32 asset2 = Aid.erc20Id(CHAIN, address(0x3333333333333333333333333333333333333333));

        address a = factory.deployForAsset(asset1, abi.encodePacked(code, abi.encode(uint256(1))));
        address b = factory.deployForAsset(asset2, abi.encodePacked(code, abi.encode(uint256(1))));
        assertTrue(a != b, "two assets must not share one address");
    }

    /// The deployer is part of the address, so the same salt from another factory lands
    /// elsewhere. A vanity address found for one deployment path is not valid for another.
    function test_theDeployerIsPartOfTheAddress() public {
        AidFactory other = new AidFactory();
        bytes32 salt = keccak256("deployer");
        bytes32 hash = keccak256(type(OtherMarker).creationCode);

        assertTrue(factory.predict(salt, hash) != other.predict(salt, hash), "deployer must matter");
    }

    // ---------------------------------------------------------------- rejections

    function test_rejectsEmptyInitCode() public {
        vm.expectRevert(AidFactory.AidEmptyInitCode.selector);
        factory.deploy(keccak256("empty"), "");
    }

    /// Init code that reverts in its constructor (`fd` with no data). CREATE2 returns
    /// address(0), which must become a revert — returning 0 would hand the caller an
    /// address that was never deployed.
    function test_rejectsRevertingConstructorCode() public {
        bytes memory code = hex"60006000fd";
        bytes32 salt = keccak256("boom");
        // The full error data, not just the selector: this error carries the predicted
        // address, and a selector-only expectation would pass even if the factory reported
        // the wrong predicted address.
        vm.expectRevert(
            abi.encodeWithSelector(
                AidFactory.AidDeploymentMismatch.selector,
                factory.predict(salt, keccak256(code)),
                address(0)
            )
        );
        factory.deploy(salt, code);
    }

    // ---------------------------------------------------------------- events

    function test_emitsDeployed() public {
        bytes memory code = abi.encodePacked(type(Marker).creationCode, abi.encode(address(5)));
        bytes32 salt = keccak256("event");
        vm.expectEmit(true, true, true, true);
        emit Deployed(factory.predict(salt, keccak256(code)), salt, keccak256(code));
        factory.deploy(salt, code);
    }
}
