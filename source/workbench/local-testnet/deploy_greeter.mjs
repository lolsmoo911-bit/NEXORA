#!/usr/bin/env node
// Deploy NexoraGreeter to the local loopback testnet and call greet().
// Mirrors ci/verify-reference-chain.sh steps, ported to Windows + cast.
// The dev private key is a public upstream test mnemonic (never printed).
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVMD = path.join(ROOT, 'workbench/toolchain/bin/evmd.exe');
const FORGE = path.join(ROOT, 'workbench/toolchain/foundry/bin-content/forge.exe');
const CAST = path.join(ROOT, 'workbench/toolchain/foundry/bin-content/cast.exe');
const HOME = path.join(ROOT, 'workbench/local-testnet/home');
const RPC = 'http://127.0.0.1:8545';

const pkRaw = execFileSync(EVMD, ['keys', 'unsafe-export-eth-key', 'dev0', '--keyring-backend', 'test', '--home', HOME], { encoding: 'utf8' });
const KEY = '0x' + pkRaw.trim().replace(/^0x/, '').toLowerCase();

function forge(args) {
  return execFileSync(FORGE, args, { encoding: 'utf8', cwd: path.join(ROOT, 'contracts') });
}
function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', cwd: path.join(ROOT, 'contracts') });
}

console.log('deploying NexoraGreeter...');
let out;
try {
  out = forge(['create', 'src/NexoraGreeter.sol:NexoraGreeter', '--rpc-url', RPC,
    '--private-key', KEY, '--broadcast', '--constructor-args', 'Hello NEXORA']);
} catch (e) {
  console.log(String(e.stdout || '') + String(e.stderr || ''));
  console.log('first attempt failed, retrying with --legacy');
  out = forge(['create', 'src/NexoraGreeter.sol:NexoraGreeter', '--rpc-url', RPC,
    '--private-key', KEY, '--broadcast', '--legacy', '--constructor-args', 'Hello NEXORA']);
}
console.log(out);
const m = out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/);
if (!m) { console.error('could not parse deployed address'); process.exit(1); }
const addr = m[1];
console.log('contract=' + addr);
const greet = cast(['call', addr, 'greet()(string)', '--rpc-url', RPC]);
console.log('greet=' + greet.trim());
const ok = greet.trim() === 'Hello NEXORA' || greet.trim() === '"Hello NEXORA"';
if (!ok) { console.error('greet mismatch'); process.exit(1); }
console.log('DEPLOY-AND-CALL OK');
