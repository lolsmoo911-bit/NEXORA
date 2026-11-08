# EVM local verification — 2026-11-07



## Addendum — 2026-11-07: local EVM/RPC gate subsequently completed

This section supersedes the earlier "no local evmd / ports refused" status above.
OpenCode completed the pinned build and local runtime exercise in a separate workbench.
See `workbench/PHASE6-IMPLEMENTATION-REPORT.md` and
`workbench/evm-compat/observations-2026-11-07.json`.

- Portable Go 1.25.9 and Zig 0.17.1 were extracted only under `workbench/toolchain`;
  official archive SHA256 values matched. A pinned `cosmos/evm v0.7.3` source archive
  was staged at commit `c3ae9067a7eadcdea55a5192226916deb44c71c4`.
- `evmd.exe` built successfully with CGO enabled and the Zig/Clang wrapper:
  SHA256 `90c2244aaed95e0fde8fae0abfeeb93ff2bcb7e5fa288f4fa7bbcb641a94226e`.
- A separate, deterministic single-validator testnet home was created under
  `workbench/local-testnet/home`. The genesis generator was run twice and produced
  byte-identical output. Its pprof/API/gRPC binds were changed from hostname
  `localhost` to `127.0.0.1` because this Windows host's DNS could not resolve
  `localhost`; all services remain loopback-only.
- Live RPC returned `eth_chainId=0xdc388`, `net_version=902024`, advancing blocks,
  a 1000 anex test balance, and `eth_estimateGas=0x5dc0`. A test-only
  `NexoraGreeter` contract was deployed and `greet()` returned `Hello NEXORA`.
- Local `aid/` tests now pass after installing the exact pinned `js-sha3@0.9.3`
  dependency; see counts below.
- This supersedes prior statements that the local EVM/RPC gate is entirely blocked.
  The gate is **partially completed**: single-validator live RPC and Greeter are verified;
  AIdRegistry/AidFactory have not yet been deployed on this node, and four-validator
  consensus remains CI-verified only.
- Testnet listeners were stopped at the end. Last local probe confirmed no process
  and no listener on `8545`, `8546`, `26657`, `26656`, `1317`, `9090`, or `3100`.
- No public RPC, DNS, Cloudflare, tunnel, commit, push, or merge was performed.
