// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * NEXORA Asset Identifier — Solidity implementation.
 *
 * This is the SECOND independent implementation of aid/SPEC.md. The reference
 * implementation is JavaScript. They are written against the same specification and are
 * checked against the same vectors, because a specification enforced by one codebase
 * asserting its own correctness is not a specification.
 *
 * Fixed-width encoding throughout. That is the entire safety argument: a variable-length
 * concatenation lets two different assets produce the same preimage.
 */
library Aid {
    uint8 internal constant T_NATIVE = 0x00;
    uint8 internal constant T_ERC20 = 0x01;
    uint8 internal constant T_ERC721 = 0x02;
    uint8 internal constant T_ERC1155 = 0x03;

    uint256 internal constant SPEC_VERSION = 1;

    error AidUnknownType(uint8 assetType);
    error AidUnknownSpecVersion();

    /// @notice Domain separator binding an identifier set to one chain and one spec version.
    function domainSeparator(uint256 chainId, uint256 specVersion) internal pure returns (bytes32) {
        if (specVersion != SPEC_VERSION) revert AidUnknownSpecVersion();
        return keccak256(abi.encode(chainId, uint32(SPEC_VERSION)));
    }

    function domainSeparator(uint256 chainId) internal pure returns (bytes32) {
        return domainSeparator(chainId, SPEC_VERSION);
    }

    /// @notice assetId = keccak256(0xA1 || domainSeparator || assetType || assetKey)
    function assetId(uint256 chainId, uint8 assetType, bytes32 assetKey) internal pure returns (bytes32) {
        if (assetType > T_ERC1155) revert AidUnknownType(assetType);
        return keccak256(abi.encodePacked(bytes1(0xA1), domainSeparator(chainId), assetType, assetKey));
    }

    function nativeId(uint256 chainId) internal pure returns (bytes32) {
        return assetId(chainId, T_NATIVE, bytes32(0));
    }

    function erc20Id(uint256 chainId, address token) internal pure returns (bytes32) {
        return assetId(chainId, T_ERC20, bytes32(uint256(uint160(token))));
    }

    /// @notice keccak256(abi.encodePacked(address, tokenId)). The 20-byte address and the
    ///         32-byte id are fixed width, so the packed encoding is unambiguous.
    function nftKey(address token, uint256 tokenId) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, tokenId));
    }

    /// @dev `assetType` is explicit. An earlier sketch inferred it arithmetically from the
    ///      asset shape, which silently produced an ERC20 id on the wrong branch.
    function nftId(uint256 chainId, uint8 assetType, address token, uint256 tokenId)
        internal
        pure
        returns (bytes32)
    {
        if (assetType != T_ERC721 && assetType != T_ERC1155) revert AidUnknownType(assetType);
        return assetId(chainId, assetType, nftKey(token, tokenId));
    }

    function erc721Id(uint256 chainId, address token, uint256 tokenId) internal pure returns (bytes32) {
        return nftId(chainId, T_ERC721, token, tokenId);
    }

    function erc1155Id(uint256 chainId, address token, uint256 tokenId) internal pure returns (bytes32) {
        return nftId(chainId, T_ERC1155, token, tokenId);
    }

    /// @notice Canonical text form: 64 lowercase hex characters, no 0x prefix (SPEC 3.1).
    function toCanonicalString(bytes32 id) internal pure returns (string memory) {
        bytes16 alphabet = "0123456789abcdef";
        bytes memory out = new bytes(64);
        for (uint256 i = 0; i < 32; i++) {
            uint256 b = uint8(id[i]);
            out[i * 2] = alphabet[b >> 4];
            out[i * 2 + 1] = alphabet[b & 0x0f];
        }
        return string(out);
    }

    /// @dev Parses exactly 64 lowercase hex characters. Uppercase is REJECTED at the
    ///      boundary, not normalised: two spellings of one identifier would defeat the
    ///      purpose of a canonical form.
    function fromCanonicalString(string calldata text) internal pure returns (bytes32) {
        if (bytes(text).length != 64) revert AidUnknownType(type(uint8).max);
        bytes memory out = new bytes(32);
        for (uint256 i = 0; i < 32; i++) {
            out[i] = (hexChar(text[i * 2]) << 4) | hexChar(text[i * 2 + 1]);
        }
        return bytes32(out);
    }

    function hexChar(bytes1 c) private pure returns (uint8) {
        if (c >= "0" && c <= "9") return uint8(c) - uint8("0");
        if (c >= "a" && c <= "f") return uint8(c) - uint8("a") + 10;
        // Uppercase and everything else is invalid, deliberately.
        revert AidUnknownType(type(uint8).max);
    }
}