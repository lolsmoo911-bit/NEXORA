#!/usr/bin/env bash
# WHY THIS FILE IS A NO-OP
#
# An EVM account address is keccak256(rlp([deployer, nonce]))[12:] and depends on nothing
# about the code. That is why the CREATE2 deployer was made immutable from the start: an
# address that can change would silently invalidate every salt mined against it.
#
# The same property makes it impossible to UPDATE. EIP-684 forbids sstore that would place
# code on an account that already has code, and the factory exposes no SELFDESTRUCT, so
# there is no path to replacing its runtime in place. Writing a helper that selfdestructs
# and recreates also does not work: the account is already occupied.
#
# Consequence: adding a function to the factory means a NEW factory address, which means
# every salt mined against the old one is dead and must be searched again. That is the cost
# of treating the deployer as immutable, and it is paid deliberately.
set -euo pipefail
echo "The CREATE2 deployer is immutable by design; it cannot be refreshed in place."
echo "Deploy a new Create2Deployer and re-mine against the new address."
exit 1
