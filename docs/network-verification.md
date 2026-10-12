# Network verification — measured evidence

Every number below was produced by running the chain in this repository on a single host.
Nothing here is inferred from the code or from a CI badge. Where something is **not**
proven, it says so.

Scope: local four-validator network, loopback only. There is no public endpoint, and no
public network is claimed.

---

## 1. What was fixed, and why nothing worked

The four validators never reached consensus because every peer was named by the wrong key.

`node_id_of()` derived the CometBFT p2p id from `config/priv_validator_key.json` — the
**consensus** key, the one a validator signs blocks and votes with. The p2p id comes from
`config/node_key.json`. Both are 64-byte ed25519 values, so the hash function was correct
and the error was invisible: it produced a well-formed id, just the wrong one.

Measured against a running node's own `/status`:

| Node | Its real `node_info.id` | Derived from `priv_validator_key.json` |
|---|---|---|
| node0 | `12370658a989edb94edefbc5b87d75d5b4c7e47b` | `2e1ca93285d58942ba2e22fd893ccac7c924c3a1` |
| node1 | `701cd144dd997ab5c079d725839ba11c97291e20` | `53a13d8b9a7606a3795184331a39cfca8be961c9` |
| node2 | `9df4fecece7c6292f4ec6c566d597d1e48dc4f1c` | `467db78d03cf38973c19cb521fa1466007701cd9` |
| node3 | `08ae401419bbf8edd39752847cbfe48b80d7b4ac` | `d43f40ee074e210d4adb0afa8c6f38d6679f396b` |

The failure surfaced in `node0.log` as, verbatim:

```
auth failure: conn.ID (701cd144dd997ab5c079d725839ba11c97291e20)
              dialed ID (53a13d8b9a7606a3795184331a39cfca8be961c9) mismatch
```

Four validators that cannot authenticate each other are four single-validator chains. Each
proposes alone, never sees agreeing votes, and no block is ever committed — which is why the
run reported "the nodes are up, consensus isn't".

`ci/phase3/run-4validators.sh` already read `node_key.json` and carried a comment warning
about this exact defect. The correct code existed; the testnet scripts had regressed.

### Other defects fixed

| Defect | Consequence |
|---|---|
| `--address` used for p2p | It sets the **ABCI** listener. Every node then fell back to `p2p.laddr` = `0.0.0.0:26656` and the second node died with `address already in use`. Correct flag is `--p2p.laddr`. |
| `--pprof_laddr` | Not a flag in v0.7.3; appears nowhere in the source. |
| `gen4-genesis.sh` called with one argument | Requires two (`home`, `out_dir`). Failed immediately on a fresh host. |
| `$WORK/template-home` | Never created. `run-epoch.sh` correctly uses `$GEN_HOME`. |
| No mesh wiring in `start-local-node.sh` | Zero `persistent_peers`. Four isolated islands. |
| `keys show dev0` / `dev1` | A provisioned node home holds only `val0..val3` and `dev3`. |
| `--keyring-dir` with `--home` | Redirects to `keyring/keyring-test`; the `test` backend stores at `$HOME/keyring-test`. Keyring appears empty. |
| `--fees … --gas 200000` | `--fees` is a **total**, `--gas-prices` is a **per-unit price**. 2e9/200000 = 10000anex per gas against a 1e9 base fee ⇒ `code: 13`, rejected in CheckTx. |
| `$(( BEFORE + 123456789 ))` | A genesis balance is ~1e21, past the signed 64-bit ceiling. Bash wraps; 1e21 wraps to `3875820019807669525`. |
| `export["height"]` | `evmd export` emits `initial_height`, and its `app_hash` is **always null**. |
| `app_hash` read per-node in sequence | Raced the block clock; a healthy chain reported a mismatch. |
| `stop.sh` `[ … ] && sleep 5` | Under `set -e` a false condition ends the script before the SIGKILL sweep. |

---

## 2. Consensus and block production

Four validators, fully connected, equal voting power:

```
node0 (12370658) -> 701cd144, 9df4fece, 08ae4014
node1 (701cd144) -> 12370658, 9df4fece, 08ae4014
node2 (9df4fece) -> 12370658, 08ae4014, 701cd144
node3 (08ae4014) -> 701cd144, 12370658, 9df4fece
```

```
total voting power: 4000   (1000 per validator)
```

Agreement at a common height — all four read at the **same** height, because reading each
node's latest in sequence races block production:

```
4/4 agree at height 168:
  node0  4C64D99AC454F8BF1C12BF110B28A474219E12B2BE48B3820206F6A70C637681
  node1  4C64D99AC454F8BF1C12BF110B28A474219E12B2BE48B3820206F6A70C637681
  node2  4C64D99AC454F8BF1C12BF110B28A474219E12B2BE48B3820206F6A70C637681
  node3  4C64D99AC454F8BF1C12BF110B28A474219E12B2BE48B3820206F6A70C637681
```

Observed rate: ~1.3 s/block with `timeout_commit = 500ms`.

---

## 3. Persistence across a restart

This is the check that distinguishes a running process from a chain that survives one.

```
PRE-STOP   height=4067  app_hash=019BD855ECA7E1F05A0C86035FE1BE0B1FA6716208A82D6A339BA981041670BF
           bash ci/testnet/stop.sh   -> 4 validators stopped, 60M of state on disk
POST-RESTART  height=4099  catching_up=false
```

Block 4067 re-read **after** the stop and restart:

```
app_hash : 019BD855ECA7E1F05A0C86035FE1BE0B1FA6716208A82D6A339BA981041670BF
MATCHES PRE-STOP: True
```

The chain resumed from its persisted state and continued to 4104 rather than returning to
genesis. This is the behaviour `docs/testnet.md` has always claimed and which nothing had
previously exercised.

---

## 4. Transfers, balances and fees

A settled bank transfer:

```
code 0, included at height 4119
balance 1000000000000123456789 -> 1000500000000123456789
```

### The fee model, measured

`evmd export` and `run-epoch.sh` had never verified what a transaction actually costs. Two
transactions at two different `gas_wanted` values determine it:

| Tx | `gas_wanted` | `gas_used` | Balance delta | = `gas_wanted × 2e9` + value |
|---|---|---|---|---|
| 1 | 200000 | 87977 | `400001000000000` | `400000000000000` + `1000000000` |
| 2 | 100000 | 87887 | `200000000000001` | `200000000000000` + `1` |

Both match exactly. **`cost = gas_wanted × gas_price + value`.**

The unused-gas refund does **not** happen: tx 1 left `200000 − 87977 = 112023` gas unused,
worth `224046000000000anex`, and the balance never recovered it — re-queried after several
further blocks, unchanged. `cost = gas_used × gas_price` is falsified by both rows.

This matters to anyone holding `anex`: setting `gas_wanted` generously burns the difference
permanently. It is a property of this build, recorded here rather than assumed.

---

## 5. EVM JSON-RPC

```
node0  eth_chainId        0xdc388   (902024)
       net_version        902024
       eth_blockNumber    0x100d    (4109 — tracks the Cosmos height)
       web3_clientVersion Version dev
```

---

## 6. The CI path

`ci/testnet/run-epoch.sh`, two consecutive epochs from an empty working directory:

```
epoch 1 committed | height 35 | cumulative 35 blocks   EXIT=0
epoch 2 committed | height 36 | cumulative 71 blocks   EXIT=0
  epoch 1  height 35  appHash 431EB99AD649C093430B  tx C1144A32D06B5CC3
  epoch 2  height 36  appHash 796E11CEC8C22E75B3A  tx 8734575F3B0A187C
```

Each epoch restores the previous state, runs four validators to consensus, settles a transfer,
exports, and appends to the ledger with a real `app_hash`.

Other suites, unchanged by this work:

```
market core   41/41
AID           40/40
```

---

## 7. What is NOT claimed

- **No public network exists.** Every endpoint is `127.0.0.1`. Nothing is hosted, reachable
  from the internet, or registered anywhere.
- **GitHub Actions still fails.** 21 of 21 historical `testnet-epoch` runs failed at
  `Run one epoch`, because the `node_key.json` defect was live in the repository. These
  fixes are committed **locally** and are not pushed; run 22 will fail exactly like runs
 1–21 until they are.
- **No mainnet, no public testnet, no spend, no production keys.**
- The keys in these node homes are the upstream public test mnemonics and must never hold
  value.