# Phase 3 report — multi-validator devnet

**Status: COMPLETE.** All acceptance criteria verified by execution, not by argument.

Date: 2026-10-12.
Evidence run: [#38179431126](https://github.com/lolsmoo911-bit/NEXORA/actions/runs/38179431126) — `conclusion: success`.
Commit: `dc2df78eed51820f24b56d419eec76d66ae06be6`.
Artifact: `phase3-transcripts`.

Scope: a four-validator NEXORA devnet on a single ephemeral CI runner, built from the
**unmodified** upstream `cosmos/evm` v0.7.3 (`evmd`). No upstream source was modified.
No public network, no production keys. Everything below ran inside a GitHub Actions runner
and was destroyed when the job ended.

---

## 1. Acceptance criteria and their status

| Criterion (from `ROADMAP.md`) | Status | Evidence |
|---|---|---|
| 4 nodes reach consensus | **MET** | `4/4 nodes agree at height 3` |
| The set is a real 4-validator set | **MET** | `on-chain validator count = 4`, 4 distinct validator addresses |
| Killing one validator does not halt the chain | **MET** | `height with 3 validators: 16 -> 29` (13 blocks) |
| Restart re-syncs | **MET** | `node3 caught up: height 35 (network 35) after 6s` |
| Recovery procedure documented and tested | **MET** | `ci/phase3/run-4validators.sh`, T5 + T6 |

## 2. Test transcript (verbatim from the run log)

```
[phase3] T2 OK: 4 distinct validators declared in genesis
[phase3] port plan OK: 28 distinct listeners, none already bound
[phase3] peer mesh OK: at least one node sees 3 peers
[phase3] 4/4 nodes agree at height 3 after 0s
[phase3] === T3: block production and agreement ===
[phase3] T3 OK: 4/4 nodes advancing with identical app hashes
[phase3]   on-chain validator count = 4
[phase3] T4 OK: transfer settled on the 4-validator network
[phase3] T5 OK: the chain produced 13 blocks and kept serving queries with 3/4 validators
[phase3] T6 OK: the recovered validator re-synced to the network tip
[phase3] === DONE: Phase 3 multi-validator devnet verified (consensus, 1-fault tolerance, recovery) ===
```

Supporting values:

```
genesis_sha256=33d94dd053106f0666f21a526c4addd8660c833cb2d0465f63cb90beeca4d847
gentxs=4   distinct_validator_addresses=4
monikers=nexora-node-0,nexora-node-1,nexora-node-2,nexora-node-3

node0 final height 12
node1 final height 12
node2 final height 12
node3 final height 12
aligned_height=12 aligned=1

app_hash  all four nodes: B527E17D07353454AC7835918E35C2D58E76336DB647D6C71F26C8444B8D0EFE

tx=D260B00E6DD558769A1DEBE93A291488D6EBEE4FAB72493C9FA1079CA69E7683 code=0
dev3 1000000000000000000000 -> 1005550000000000000000 (+5550000000000000000)

height with 3 validators: 16 -> 29
node3 caught up: height 35 (network 35) after 6s
```

### What each number means

- **Identical `app_hash` at height 12** is the strong claim. Matching heights alone would
  only show that block counters agree; identical application hashes show the four nodes
  executed the same transactions into the same state. They are independent processes
  connected only by p2p.
- **The genesis SHA-256 is identical across two independent generation runs**, so the
  network is reproducible from the fixed upstream mnemonics and a pinned `genesis_time`.
- **T5 is a genuine fault, not a restart.** `kill $PID` is sent to validator 3 while the
  others keep running; 13 further blocks are produced without it.
- **T6 restarts the same home** with its original `node_key.json`, so the recovered node
  rejoins under the identity the network already knows.

## 3. How the 4-validator genesis is built

`evmd genesis gentx` rewrites (shuffles) the genesis file on every call, so calling it four
times in one home collapses back to a single validator. The working method is per-validator
isolation:

1. Build one clean base genesis with no gentxs.
2. For each validator *i*: copy the base into a scratch home, recover that validator's key
   from the upstream test mnemonic, run a single `gentx`, keep only the produced file.
3. Collect all four gentx files and run `collect-gentxs`.

Because every input is derived from fixed upstream mnemonics plus a pinned `genesis_time`,
the result is byte-for-byte reproducible.

Mnemonics are parsed **at runtime** from the unmodified upstream `local_node.sh` and are
never committed.

## 4. Defects found and fixed during this phase

Phase 3 consumed ten CI runs. Every failure below is recorded because each one produced a
misleading result that a weaker test would have accepted.

| Defect | How it presented | Fix |
|---|---|---|
| `--pprof.address` does not exist in `evmd` v0.7.3 | All four nodes exited instantly; the script then sat out an **iteration-counted** wait of ~40 minutes before saying anything | Every wait is bounded by wall clock and aborts the moment a node process dies |
| pprof and geth-metrics default to ports shared by all validators | `bind: address already in use`; the losing node exited | Explicit 28-listener port plan, asserted before any node starts |
| `evmd q` retries forever against an unreachable node | A job that simply never finished | Every CLI call is bounded; every query passes `--node` explicitly |
| **Node id derived from the wrong key material** | `auth failure: conn.ID (…) dialed ID (…) mismatch`; every node dialled peers under identities none of them held | See below |
| All validators shared `127.0.0.1` | The p2p address book, keyed by IP, held one entry instead of four | Each validator gets its own loopback address (`127.0.0.1` … `127.0.0.4`) |
| `external_address` written as `id@host:port` | The node prepends its own id, producing `id@id@host:port`; `address (...) does not contain ID` | `external_address` takes `host:port` only |
| `evmd status` is deprecated and emits non-JSON | `jq: parse error` killed the very check that proves state agreement | App hashes are read from the CometBFT REST endpoint |
| Height equality sampled at one instant | Failed whenever a block landed mid-sample | Heights are aligned (bounded wait) before application state is compared |
| `log` wrote to stdout inside `$( … )` | `DST` became `"[phase3] -> show dev3 address\ncosmos1fx9…"` | `log` writes to stderr; stdout stays data-only |
| `2>&1` on a captured command | Merged the progress line into the transaction JSON; the tx had **succeeded** (`code:0`) but its output would not parse | Removed; stderr and stdout stay separate |

### The node id derivation, in detail

This was the substantive defect. It is recorded because the wrong answers were plausible.

Measured facts about this build, from `phase3-artifacts/node-id-diagnostics.txt`:

```
top-level keys of node_key.json: priv_key          <- there is no pub_key field
priv_key type: tendermint/PrivKeyEd25519
priv_key base64-decoded length: 64 bytes            <- seed (32) || public key (32)
evmd tendermint show-node-id -> Error: unknown command "tendermint" for "evmd"
```

CometBFT's node id is `hex(sha256(public key)[:20])`. Two earlier attempts were wrong:

- hashing all 64 bytes, which includes the seed;
- reading `.pub_key.value`, which does not exist in this layout.

The correct derivation is the **last 32 bytes** of the decoded key. The script now also
cross-checks it against each running node's own `/status` (`node_info.id`) and refuses to
proceed on any mismatch, so this class of error can never again be silently wrong.

## 5. Hardening added alongside the fix

The debugging effort produced checks that are now permanent:

- **CLI flag preflight** — every flag passed to `evmd start` is verified against the
  binary's own `--help` output before any node starts. This turned a 40-minute failure into
  a ten-second one.
- **Port plan assertion** — the 28 listeners are checked for duplicates and for being
  already bound.
- **Peer identity verification** — wired ids are compared against each node's self-report.
- **Peer mesh check** — peers must actually form before consensus is attempted, so a
  peering failure is reported as a peering failure.
- **Bounded everything** — consensus (180 s), recovery (180 s), transaction inclusion
  (90 s), peer mesh (120 s), every CLI call (45 s).

## 6. Limits of this result

Stated plainly, because a green CI run is not a security or production result:

- This ran on **one ephemeral CI runner**. It is not evidence of behaviour across real
  machines, real networks, or real network partitions.
- Validators are **test keys recovered from the upstream `local_node.sh`**. They are
  published in that file and must never hold value.
- No adversarial conditions were tested: no latency injection, no disk pressure, no clock
  skew, no Byzantine validator.
- Nothing here is an audit. The upstream project has its own security history; this phase
  says nothing about it.
- The devnet existed only for the duration of the job.

## 7. Reproduction

```bash
# Everything below runs inside GitHub Actions; nothing persists.
git clone https://github.com/lolsmoo911-bit/NEXORA && cd NEXORA
gh workflow run phase3-multinode-verify.yml
```

The workflow clones upstream `cosmos/evm` at tag `v0.7.3`, asserts its commit hash is
`c3ae9067a7eadcdea55a5192226916deb44c71c4`, builds `evmd` unmodified, generates the genesis
twice, proves determinism, provisions four node homes, and runs T1–T6.