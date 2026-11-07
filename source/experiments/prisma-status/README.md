# nexora-status — minimal Prisma Compute experiment (PREPARED, NOT DEPLOYED)

A minimal Bun HTTP service for the owner-approved **limited feasibility test**
on Prisma Compute. Files are prepared locally; **nothing was deployed** and no
platform resource was created. See `docs/prisma-compute-feasibility.md`.

## What it does

`GET /` and `GET /health` return a tiny JSON status: app id, version, runtime
(Bun version, Node-compat version, platform/arch), and a timestamp.

## Prerequisites (on a real machine with shell — e.g. your own Linux/Windows WSL)

- Node.js **22.18 or newer** (Composer requirement).
- **Bun** installed.
- A Prisma account (Free plan, **no credit card**).

## Cost-proof gate — MUST pass before deploying (do not skip)

1. `npx prisma auth login` → then `npx prisma auth whoami` (confirms session).
2. Open **Console → Billing/Plan**: confirm plan is **Free**, **no credit
   card**, **no spend limits**, no metered billing enabled.
3. Confirm this experiment creates **ONE Compute service only** — it declares
   **no** Postgres database, **no** bucket, **no** cron, **no** custom domain,
   **no** keep-awake. (Each of those would add usage or unpublished pricing.)
4. Deploy only if 1–3 pass. After deploy, check Console usage: an idle app
   must cost nothing (scale to zero).

**If any gate fails, or any charge appears: stop immediately and do not
deploy anything else.**

## Run locally (no account needed)

```bash
bun install
bun run build
bunx prisma dev module.ts     # prints a local URL; curl it
```

## Deploy (only after the gate above passes)

```bash
bun run build
bunx prisma deploy module.ts  # prints the service's public URL
curl <printed-url>/
curl <printed-url>/health
bunx prisma service show nexora-status
```

## After the test (keep it free)

- Leave the service idle → it scales to zero → **no usage**, no cost.
- To clean up, delete the project/branch in the **Console** (destructive, but
  this app has no data).
- **Do not** add Object Store buckets (pricing unpublished), **do not** add a
  `cron` block (it never scales to zero and would consume the free monthly
  4 vCPU-hours in days), **do not** add custom domains (not needed).

## Why NOT the chain engine

Prisma Compute is request-driven **Bun/TypeScript HTTP** hosting with **no
persistent filesystem, no WebSockets, no raw TCP/P2P**, and scale-to-zero.
A Cosmos EVM (`evmd`/CometBFT) node cannot run there — by design. Prisma is
kept only for a support HTTP surface; the chain engine is tested on a
general-purpose Linux host per `docs/phase1-environment.md`.