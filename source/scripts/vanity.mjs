#!/usr/bin/env node
/**
 * vanity.mjs — turn an asset NAME into a deployed contract address that visibly ends
 * with the hex encoding of that name.
 *
 *   GOLD    -> 474f4c44   -> 0x.....474f4c44
 *   SILVER  -> 53494c564552
 *   USD     -> 555344
 *
 * WHAT THIS DOES, IN ORDER
 *   1. hex-encode the name (ASCII, the encoding the proposal specified)
 *   2. hash the contract's creation bytecode to get the initcode hash
 *   3. search for a CREATE2 salt that puts that hex on the end of the address
 *   4. deploy exactly ONE transaction that lands on the address we already know
 *   5. verify the address on-chain and prove it ends with the target
 *
 * WHY CREATE2
 *   A plain deployment address is keccak256(rlp([deployer, nonce]))[12:]. You cannot
 *   choose the nonce's effect, so the only way to steer it is to deploy, look, and
 *   discard. CREATE2 instead mixes a salt WE choose before the hash:
 *
 *       address = keccak256(0xff ++ deployer ++ salt ++ keccak256(initcode))[12:]
 *
 *   So the entire search happens off-chain in a tight C loop and costs exactly one
 *   transaction in total. Nothing is deployed and thrown away.
 *
 * THE CAVEAT THAT ACTUALLY MATTERS
 *   The salt is only valid for one EXACT creation bytecode. Change a line of Solidity,
 *   rename a variable, or change compiler version, and the initcode hash changes and the
 *   mined address is dead. Search again from zero. Treat a mined salt as bound to a
 *   byte-for-byte artifact, and record the compiler version with it.
 *
 * USAGE
 *   node scripts/vanity.mjs GOLD                 # dry run: mine, print salt + address
 *   node scripts/vanity.mjs GOLD --deploy        # mine, deploy, verify on-chain
 *   node scripts/vanity.mjs GOLD --bytes 2       # mine fewer bytes if you want it fast
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const RPC = process.env.NEXORA_RPC ?? "http://127.0.0.1:8545";
const BIN = resolve(__dirname, "vanity");
const CACHE_DIR = resolve(ROOT, ".vanity");

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const name = argv[0];
if (!name) {
  console.error("usage: node scripts/vanity.mjs <NAME> [--deploy] [--bytes N] [--symbol S]");
  process.exit(2);
}
const flag = (f) => argv.includes(f);
const opt = (f, dflt) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const deploy = flag("--deploy");
const maxBytes = Number(opt("--bytes", "8"));
const symbol = opt("--symbol", name.slice(0, 5).toUpperCase());

if (!/^[A-Za-z0-9]+$/.test(name)) {
  console.error(`"${name}" is not ASCII alphanumeric. The proposal encodes names as ASCII hex,`);
  console.error("so a name containing anything else cannot appear in the address at all.");
  process.exit(2);
}

// ---------------------------------------------------------------- 1. hex encode

const targetHex = Buffer.from(name, "ascii").toString("hex");
const targetBytes = targetHex.length / 2;

console.log(`name       ${name}`);
console.log(`ascii hex  ${targetHex.toUpperCase()}  (${targetBytes} bytes)`);

let bytes = Math.min(targetBytes, maxBytes);
let suffix = targetHex.slice(0, bytes * 2);
if (bytes < targetBytes) {
  console.log(`note       mining only the first ${bytes} of ${targetBytes} bytes (--bytes ${bytes})`);
} else {
  console.log(`note       mining the FULL name`);
}
console.log(`suffix     ...${suffix}`);
console.log(`work       ~${(2n ** BigInt(bytes * 8)).toLocaleString()} keccak attempts\n`);

// ---------------------------------------------------------------- 2. initcode

if (!existsSync(BIN)) {
  console.error(`miner binary missing at ${BIN}`);
  console.error("build it:  gcc -O3 -march=native -fopenmp -o scripts/vanity scripts/vanity.c");
  process.exit(2);
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", ...opts }).trim();
}

let initCode;
let initHash;

if (!deploy) {
  // Dry run still needs a realistic initcode hash. Use the compiled artifact if present.
  const cached = resolve(CACHE_DIR, `${name}.initcode`);
  if (existsSync(cached)) {
    initCode = readFileSync(cached, "utf8").trim();
    initHash = sh("cast", ["keccak", initCode]);
    console.log(`initcode   cached artifact, ${(initCode.length - 2) / 2} bytes`);
  } else {
    console.error("no cached initcode for this name. Run once with --deploy to compile it,");
    console.error("or compile manually and pass --initcode <hex>.");
    process.exit(2);
  }
} else {
  const artifact = resolve(ROOT, "contracts/out/VanityAsset.sol/VanityAsset.json");
  if (!existsSync(artifact)) {
    console.error(`artifact missing: ${artifact}\nrun: cd contracts && forge build`);
    process.exit(2);
  }
  const json = JSON.parse(readFileSync(artifact, "utf8"));
  const runtime = json.bytecode.object;

  // Append ABI-encoded constructor args: (string name, string symbol, uint256 supply).
  const args = encodeConstructorArgs(name, symbol, BigInt("100000000") * 10n ** 18n);
  initCode = "0x" + runtime + args.slice(2);
  initHash = sh("cast", ["keccak", initCode]);

  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(resolve(CACHE_DIR, `${name}.initcode`), initCode);
  writeFileSync(
    resolve(CACHE_DIR, `${name}.meta.json`),
    JSON.stringify(
      {
        name,
        symbol,
        targetHex,
        initHash,
        initCodeLength: (initCode.length - 2) / 2,
        solc: readCompilerVersion(),
        note: "This salt is bound to this exact initcode hash. Any contract change invalidates it.",
      },
      null,
      2,
    ),
  );

  console.log(`initcode   ${((initCode.length - 2) / 2).toLocaleString()} bytes`);
  console.log(`keccak     ${initHash}`);
}

/** Minimal ABI encoder for (string,string,uint256) - the VanityAsset constructor. */
function encodeConstructorArgs(n, s, supply) {
  const words = [];
  const push = (hex) => words.push(hex.padStart(64, "0"));

  const encStr = (str) => {
    const b = Buffer.from(str, "utf8");
    const data = b.toString("hex");
    if (b.length % 32 === 0) return "0000000000000000000000000000000000000000000000000000000000000020" + "0000000000000000000000000000000000000000000000000000000000000020" + data + "0".repeat(64);
    return "0000000000000000000000000000000000000000000000000000000000000020" + "0000000000000000000000000000000000000000000000000000000000000020" + data;
  };

  // head: 3 slots
  push("0000000000000000000000000000000000000000000000000000000000000080"); // name offset
  push("00000000000000000000000000000000000000000000000000000000000000e0"); // symbol offset
  push(supply.toString(16));

  // tail: name then symbol, each padded to a 32-byte multiple
  const pad = (str) => {
    const b = Buffer.from(str, "utf8");
    let h = b.toString("hex");
    const r = h.length % 64;
    if (r) h += "0".repeat(64 - r);
    return "0000000000000000000000000000000000000000000000000000000000000020" + h;
  };
  return "0x" + words.join("") + pad(name) + pad(symbol);
}

function readCompilerVersion() {
  try {
    return sh("forge", ["--version"]).split("\n")[0];
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- 3. mine

const deployer = process.env.VANITY_DEPLOYER;
if (!deployer) {
  console.error("\nset VANITY_DEPLOYER=0x... (the address that will send the deployment)");
  process.exit(2);
}

console.log(`deployer   ${deployer}`);
console.log(`mining     this takes a while for ${bytes} byte(s)...\n`);

const started = Date.now();
const r = spawnSync(BIN, [deployer, initHash, suffix, "0"], { encoding: "utf8" });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (r.status !== 0) {
  console.error("mining failed:", r.stderr || r.stdout);
  process.exit(1);
}

const [, salt, address] = r.stdout.trim().split(/\s+/);
const rate = (Number(BigInt(salt.startsWith("0x") ? salt.slice(2) : salt)) / elapsed / 1e6).toFixed(1);

console.log(`\nFOUND in ${elapsed}s`);
console.log(`salt       ${salt}`);
console.log(`address    ${address}`);
console.log(`rate       ~${rate} M attempts/sec`);
console.log(`\nverify the derivation independently:`);
console.log(`  cast keccak 0xff${deployer.slice(2)}${salt}${initHash.slice(2)}`);

// ---------------------------------------------------------------- 4+5. deploy & verify

if (!deploy) {
  console.log(`\nre-run with --deploy to land this on chain.`);
  process.exit(0);
}

const key = process.env.VANITY_KEY;
if (!key) {
  console.error("\nset VANITY_KEY to deploy. Nothing has been deployed.");
  process.exit(2);
}

console.log(`\ndeploying...`);
const sent = sh("cast", [
  "send",
  deployer,
  "--data",
  initCode,
  "--salt",
  salt,
  "--rpc-url",
  RPC,
  "--private-key",
  key,
  "--legacy",
]);

const txHash = (sent.match(/0x[0-9a-fA-F]{64}/g) ?? [])[0];
console.log(`tx         ${txHash}`);

// The address is known before broadcasting; confirm the chain agrees by reading the code.
await new Promise((r) => setTimeout(r, 4000));
const code = sh("cast", ["code", address, "--rpc-url", RPC]).catch(() => "0x");
const hasCode = code.length > 2;

console.log(`\naddress    ${address}`);
console.log(`suffix     ...${suffix.toUpperCase()}`);
console.log(`on-chain   ${hasCode ? "CODE PRESENT" : "NO CODE"}`);
console.log(`ends with  ${address.toLowerCase().endsWith(suffix) ? "YES" : "NO"}`);

if (!hasCode || !address.toLowerCase().endsWith(suffix)) {
  console.error("\nverification FAILED - do not use this address");
  process.exit(1);
}

writeFileSync(
  resolve(CACHE_DIR, `${name}.deployed.json`),
  JSON.stringify({ name, symbol, salt, address, txHash, initHash, targetHex, deployedAt: new Date().toISOString() }, null, 2),
);
console.log(`\nrecorded in .vanity/${name}.deployed.json`);