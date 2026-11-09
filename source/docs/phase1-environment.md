# Phase 1 — Linux Execution Environment: Requirements & Verification

- Status: **Draft / reference document** — nothing is installed or changed
  automatically. Any provisioning happens only on a host the owner approves,
  and only with the owner's consent.
- Author: engineering agent (documentation only). Owner: decides and executes,
  or approves the command list before execution.
- Related: `SPEC.md` §4/§11, `ROADMAP.md` Phase 1,
  `docs/architecture-decision-record.md` (owner confirmation §6),
  `chain/upstream.md`.

## 1. Why this document

The current sandbox is a distroless container with **no shell and no
toolchain** — build commands must **not** be started there (owner decision #5).
Phase 1 therefore requires an alternative Linux environment. This document
lists the requirements and the exact verification steps to run **in that
environment** before Phase 1 work begins.

## 2. Recommended environment (verified baseline to target)

Minimal, standard, and free-of-charge choice:

| Item | Requirement | Rationale |
|---|---|---|
| OS | Debian 12/13 (bookworm/trixie) **or** Ubuntu 22.04 LTS / 24.04 LTS x86_64 | mainstream, kept current, easiest Go/gcc support. **Full userland with shell** — not distroless |
| Architecture | amd64 (x86_64) | simplest supported target; arm64 acceptable but extra build variance |
| Privileges | non-root user able to `sudo` for installing packages | installs require consent; root-only accounts not needed |
| Disk free | ≥ 20 GB (Go toolchain ~0.5–1 GB, module cache, two repos, node state/`~/.evmd`) | headroom for `go.sum` cache + `evmd` data dir |
| RAM | ≥ 4 GB (8 GB recommended) | single node build/run; 4-node localnet favors 8 GB |
| CPU | ≥ 2 cores | Go compilation + CometBFT |
| Network | HTTPS access to `github.com`, `proxy.golang.org`, `raw.githubusercontent.com` (and `sum.golang.org` for checksums) | required for clone/module download |
| Time | ~30–60 min typical for full Phase 1 transcript on 4-core/8 GB | estimate only (`A`) |

## 3. Required tools and expected versions (to be confirmed on the host)

| Tool | Expected (must match) | Purpose | Installation (only with owner consent) |
|---|---|---|---|
| `bash`/`sh` | present | run everything | present by default |
| `git` | ≥ 2.40 | clone/pin | `apt-get install git` |
| `go` | **1.25.9 exactly** (build requirement of v0.7.3) | compile `evmd` | official installer or `apt` after verifying version pin; **not any other version** |
| `make` | ≥ 4.3 | `make build` | `apt-get install make` |
| `gcc` + `build-essential` | present | CGO build pieces | `apt-get install build-essential` |
| `jq` | ≥ 1.6 | `local_node.sh` genesis edits | `apt-get install jq` |
| `curl` | present | JSON-RPC checks | `apt-get install curl` |
| Docker + `docker compose` (plugin) | optional | 4-node `make localnet-start` path | `apt-get install docker.io docker-compose-plugin` (only if owner approves; manual fallback exists) |
| Go proxy/reachability | `proxy.golang.org` reachable | module downloads | n/a |

Optional, for upstream Solidity suites (only the mandatory Phase 1 items need
the tools above):

| Tool | Expected | Purpose |
|---|---|---|
| Node.js | ≥ 22 | `make test-solidity` (Hardhat side) — CHANGELOG requires Node ≥ 22 (#1250) |
| Foundry (`forge`, `cast`, `anvil`) | latest stable | upstream Foundry suite + its git submodules |

## 4. Verification steps (run in the target environment, before Phase 1)

Run each command, capture **exact outputs**, and send the transcript back.
No command below installs anything or modifies the target system besides
dropping text into the working directory.

**A. Environment capability check (no installs)**

```bash
set -x
whoami            # expect a normal user, not forced root-only
uname -a          # expect Linux x86_64, Debian/Ubuntu kernel
cat /etc/os-release   # confirm Debian 12/13 or Ubuntu 22.04/24.04
command -v bash sh git go make gcc jq curl docker 2>&1 || true
```

**B. Tool versions (what the pins require)**

```bash
go version        # MUST print go1.25.9 — any other version fails the gate
git --version
make --version | head -1
gcc --version | head -1
jq --version
```

> Gate: if `go version` is **not** exactly `go1.25.9`, stop and report. Do not
> silently substitute another Go version (upstream requires 1.25.9).

**C. Network reachability (idempotent, non-mutating)**

```bash
curl -fsSI https://github.com/cosmos/evm -o /dev/null -w "github:%{http_code}\n"
curl -fsSI https://proxy.golang.org -o /dev/null -w "goproxy:%{http_code}\n"
curl -fsSI https://raw.githubusercontent.com/cosmos/evm/v0.7.3/go.mod -o /dev/null -w "raw:%{http_code}\n"
```

**D. Clone + pin (verified before building; checkout must succeed)**

```bash
git clone https://github.com/cosmos/evm.git
cd evm
git checkout c3ae9067a7eadcdea55a5192226916deb44c71c4
git status --short   # expect empty (clean tree)
git describe --tags --exact-match HEAD   # expect v0.7.3
```

**E. Reproducible build, unmodified (no edits to any upstream file)**

```bash
go env GOTOOLCHAIN GOFLAGS
make build                 # at repo root
./build/evmd version       # record exact output + go/commit metadata
cd evmd && make build && cd ..
```

**F. Single-node run + JSON-RPC smoke (acceptance)**

```bash
./local_node.sh -y         # builds/runs a local node (jq required); record output
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
  http://localhost:8545
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":2}' \
  http://localhost:8545
curl -s -X POST -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","method":"net_version","params":[],"id":3}' \
  http://localhost:8545
```

**G. Simple Solidity deploy (mandatory Phase 1 item)**

A minimal contract (e.g. a storage/`set`+`get` contract) compiled with a
standard compiler and deployed via JSON-RPC; the deploy tx is confirmed on
chain and the getter returns the set value. Full transcript recorded.

**H. Optional (only later, and only if approved):** upstream `make test`,
`make test-rpc-compat`, `make test-solidity`, 4-node
`make localnet-start`.

## 5. What must NOT happen

- No installs, no `apt-get install`, no Go toolchain download in the **current
  sandbox** (owner decisions #5).
- No silent substitution of dependency versions (owner decision #2).
- No run of upstream from an **untagged** revision (owner decision #2).
- No edits to upstream source files during Phase 1 (must stay unmodified).
- No NEXORA branding/config, AID work, token work, or consensus changes
  (owner decision #6).
- No claim of build/test success without the actual transcript (owner
  decision #4).

## 6. Handoff protocol

1. Owner (or an approved operator) runs the Section 4 commands on the target
   host and returns the **raw transcript**.
2. The agent records the transcript in `docs/phase1-report.md`.
3. The agent compares versions/hashes against the pins in `chain/upstream.md`;
   any mismatch is logged as an open issue and blocks Phase 1 acceptance.
4. Phase 1 starts only after: the checklist passes, the transcript is recorded,
   and the owner gives explicit approval.

## 7. Estimate of first-run transcript size

Rough expectation: clone (few MB) → Go module download (~1–2 GB cache) → build
(many minutes on 2 cores) → local node init/start (seconds to a few minutes) →
JSON-RPC checks (seconds). Full transcript typically 100–400 lines before
trimming. (Estimate `A`; hardware-dependent.)