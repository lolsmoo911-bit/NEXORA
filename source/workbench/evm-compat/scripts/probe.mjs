#!/usr/bin/env node
// Live probe against a loopback node (default http://127.0.0.1:8545).
// Usage: node scripts/probe.mjs [rpcUrl]
import { probeNode, assertNEXORAvIdentity } from '../src/probe.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8545';
const probe = await probeNode(url);
console.log(JSON.stringify(probe, null, 2));
if (!probe.connected) {
  console.log('RESULT: disconnected (no loopback node answering)');
  process.exitCode = 2;
} else {
  assertNEXORAvIdentity(probe);
  console.log(`RESULT: connected chainId=${probe.chainIdDec} (${probe.chainIdHex}) block=${probe.blockNumber} gasPrice=${probe.gasPriceWei}`);
}
