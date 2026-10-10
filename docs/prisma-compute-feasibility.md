# Prisma Compute — NEXORA Feasibility Test (documentation + prepared, NOT deployed)

- Date: 2026-10-10
- Status: **feasibility study completed. The smallest experiment was PREPARED
  but NOT deployed** — no Prisma account access and no shell in the executing
  environment. **No cloud resource was created. No payment was made or
  committed.** Recorded per the owner's 7-step instructions (limited test
  approval only).
- Legend: `V` verified, `A` assumption, `U` unverified.

---

## 1. Is this environment "Prisma Compute"? — **No.** (step 1)

Verified findings:

| Probe | Result | Conclusion |
|---|---|---|
| Outbound IP (`ipinfo.io`, `ifconfig.co`, `ipapi.co`) | `208.167.245.95`, hostname `208.167.245.95.vultrusercontent.com`, ASN **AS20473 The Constant Company, LLC (Choopa/Vultr)** | Hosted on **Vultr** — not Prisma |
| Cloud metadata endpoints (AWS/GCP/Azure/DO/Hetzner) | all `timeout` or `ENOTFOUND` | no cloud-provider metadata visible |
| `/proc/self/status` | UID/GID 65532, 1 CPU allowed, capabilities empty | minimal distroless sandbox |
| Mounts | `virtiofs /mnt/app`, `ukp-fuse /uk/libukp` | sandboxed VM filesystem |
| Search for Prisma files/tokens (/, tmp, home, opt, etc.), Prisma CLI, `.env` | **none found** | no Prisma credentials present |
| `api.prisma.io/v1/projects` (no token) | HTTP **401** `Invalid authorization token` | platform reachable; **authentication required** |
| `console.prisma.io` | HTTP 200 | Console reachable |

**Conclusions (V):**
1. This executing environment is the agent/open-code sandbox (Vultr), **not**
   Prisma infrastructure, and it contains **no Prisma credentials**.
2. Prisma's platform is reachable over the network, but every management
   action requires authentication (account session or service token) that is
   **not available here**.
3. Therefore the plan/workspace status and plan costs of any existing Prisma
   account **could not be inspected** (`U`). It was **not assumed** that any
   account or plan is free (`U`).

## 2. Official constraints of Prisma Compute (step 2) — verified from official docs

Sources: https://www.prisma.io/pricing • https://www.prisma.io/compute •
https://www.prisma.io/docs/compute • /docs/compute/limitations •
/docs/compute/object-storage • /docs/composer • /docs/prisma-compute/deploy

| Constraint | Official statement |
|---|---|
| What it hosts | **TypeScript apps only — Node.js, Bun or Next.js**; the deployed runtime is **Bun**. Not arbitrary binaries (no Go/`evmd`) |
| App model | HTTP services, request-driven; **"An idle app scales to zero and costs nothing"** |
| Long-running processes | "This release focuses on HTTP services. Background work between requests is supported through the `@prisma/compute` keep-awake primitives"; keep-away **does not** guarantee continuity through restarts/deployments; **no built-in cron scheduler** (cron exists only via Composer's `cron` block, "a scheduler service that never scales to zero") |
| Persistent filesystem | **"no persistent filesystem"** — persistence only via Prisma Postgres (managed DB) and S3-compatible Object Store buckets |
| WebSockets | **"WebSocket servers are not currently supported"** |
| Request timeout | 60 s to first byte of a response; a response that already streams is not cut off |
| Regions | one region per service, chosen at creation from six (us-east-1, us-west-1, eu-west-3, eu-central-1, ap-northeast-1, ap-southeast-1) |
| Deploys / previews / idle | "deploys, preview branches, idle time, and the number of people on your team never add to the bill" |
| Free plan (Compute) | **$0/month, free forever, no credit card**: 1M requests/mo, 360 GB-hours memory/mo, **4 active vCPU-hours/mo**, 10 GB outbound bandwidth/mo |
| Free plan (Postgres) | 200k ops/mo, 1.01 GB storage, 50 databases |
| Overage on Free | "no usage billing" (free tier); enforcement above included quotas **unverified** (`U`) — keep usage tiny |
| Object Store | S3-compatible buckets; **"pricing and plan limits are not published yet"** → do not provision buckets |
| Custom domains | production-only, up to 3 per service (not needed for the test) |
| CLI | `npx prisma …` with Node.js **22.18+**; `auth login` is the one interactive step; sessions inherited by agents |

**Direct consequence for a blockchain node (step 5):** CometBFT/Cosmos EVM
(`evmd`) needs a continuously running Go process, persistent state on disk, an
inbound P2P TCP listener and WebSocket RPC, and time-driven block production.
Prisma Compute provides **none** of these (Bun-only runtime, scale-to-zero,
no persistent filesystem, no raw-socket/WebSocket inbound, no always-on CPU).
**Prisma Compute cannot host the NEXORA chain engine.** Doing so is blocked by
documented platform policy; no workaround was attempted.

## 3. Smallest experiment (step 4) — prepared, NOT deployed

Prepared locally (files only, no platform call): `experiments/prisma-status/`
— a minimal Bun HTTP service exposing `GET /health` and `GET /` with runtime
status (status, app id, version, Bun + Node runtime versions, timestamp).
It mirrors the official Composer code layout verbatim (`server.ts`,
`service.ts`, `module.ts`, `prisma.config.ts`, `package.json`, `tsconfig.json`).

**Why not deployed:** the experiment requires (a) a Prisma account session or
service token and (b) Node.js 22.18+/shell — neither exists in this
environment. Per step 3/4, the plan and its zero-cost guarantee for a new
deployment could **not** be proven from here, so the instruction "if you
cannot prove it, **stop before deploying**" applies. **No deploy was
attempted; no project/database/service was created.**

### Cost-proof gate (must pass before anyone deploys)

1. `npx prisma auth login` then `npx prisma auth whoami` — signed in.
2. Open Console → Billing/Plan: confirm plan = **Free**, **no credit card**,
   **no spend limit configured**, account shows no metered billing.
3. Confirm the experiment creates **exactly one Compute service** and **no**
   Postgres database, **no** bucket, **no** cron/keep-awake, **no** custom
   domain (each of those would add usage or unpublished pricing).
4. Deploy, then check Console usage: idle time must cost nothing (scale to
   zero). If any of 1–3 fails or any charge appears → **stop immediately**.

## 4. Evaluation: which NEXORA components could run free on Prisma Compute (steps 5–6)

| Component | Feasible on Prisma Free? | Reason (official constraint) |
|---|---|---|
| Chain engine (`evmd`, CometBFT node, JSON-RPC) | **No** | not TypeScript; needs persistent FS, P2P/WS inbound, continuous CPU (4 vCPU-h/mo budget; a 24/7 process needs ~730 vCPU-h/mo) |
| Status/health **HTTP** UI or API | **Yes** | HTTP service; idle = 0 cost; ~0 requests in a test |
| Read-only JSON-RPC proxy front (HTTP in → outbound to a chain node elsewhere) | **Yes** | fits request/response model; outbound bandwidth within 10 GB/mo |
| Explorer-like/registry API on Prisma Postgres | Later (gated) | Postgres free tier 200k ops / 1.01 GB; AID/registry phases are gated by SPEC |
| Object storage | Avoid for now | pricing unpublished (`U`) |

**Free options to actually test the chain engine without buying a server**
(owner step 6):
1. **Owner's own Linux machine / WSL** — best: Debian/Ubuntu + Go 1.25.9 etc.
   already satisfies `docs/phase1-environment.md`; zero external cost. Phase 1
   scope unchanged.
2. A local VM (VirtualBox/KVM) on the owner's machine (money-free).
3. GitHub-hosted runners **for CI verification** (build `evmd`, run upstream
   tests) on a public repo — free, but **not** a persistent node.
4. Free-tier VPS vendors that advertise $0 (e.g., Oracle Always Free) usually
   still **require a credit card** at signup — flagged, not recommended
   blindly; verify zero-fee and recurring-charge terms yourself before use.

## 5. What was actually tested — results

| Test | Status | Result |
|---|---|---|
| Cloud metadata probes | executed | all unreachable (`V`) |
| Provider identification via outbound IP ×3 | executed | Vultr/AS20473 (`V`) |
| Filesystem search for Prisma credentials/CLI/config | executed | none found (`V`) |
| Prisma API reachability (no auth) | executed | 401 = reachable, auth required (`V`) |
| Official docs review (pricing, landing, limitations, object storage, composer, deploy) | executed | constraints table above (`V`) |
| Deploying the status HTTP service on Prisma | **not executed** | blocked (no creds/shell); correctly stopped (`V` that it was not run) |
| Running any NEXORA chain component | **not executed** | out of scope / blocked |

**No test produced a false success.** No build/test success is claimed.

## 6. Costs — confirmed vs unconfirmed

- **Confirmed incurred:** **$0.** Nothing was created, deployed, or purchased;
  no account was touched.
- **Confirmed (official docs):** Free plan is `$0/month, no credit card`,
  includes Compute (1M requests, 360 GB-hours, 4 vCPU-hours, 10 GB egress)
  and Postgres (200k ops, 1.01 GB); idle apps cost nothing.
- **Unconfirmed (`U`):** the plan/status of any existing Prisma account
  (no access); enforcement behavior above Free quotas; Object Store pricing
  (unpublished). No future charge can be ruled out without reading the
  account's own Billing page first.

## 7. Recommendation & stopping point

- Keep **Prisma Compute only as an optional free host for a TypeScript HTTP
  support surface** (status UI, read-only proxy/API) — never as a chain host.
- Test the chain engine **on the owner's Linux machine** per
  `docs/phase1-environment.md`; Phase 1 scope and gates are unchanged.
- **Stopping point:** per instructions I stop here — no deployment, no
  resource creation, no payment, no bypassing of platform limits. Next step
  requires either (a) the owner providing Prisma account access/session so the
  status-service experiment can pass its cost gate, then be deployed and
  verified, and/or (b) a Linux host for Phase 1.