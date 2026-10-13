# Getting a real HTTPS URL — publish the app

**You were right, I was wrong.** The endpoint I have been testing is not the one that can
work on a phone. Replit serves two different TLS regimes, and they are not interchangeable.

| | dev domain | published domain |
|---|---|---|
| Hostname | `*.replit.dev` (what we have) | `*.replit.app` |
| Certificate | **Private CA**, `Replit internal proxy Root CA - <repl-id>` | **Publicly trusted**, issued by Replit |
| Valid for a phone? | **No** — Android does not trust it | **Yes** |
| Cost | free | **free** |
| Needs | nothing | a successful **Deployment** |

The dev domain terminates TLS with an interception proxy scoped to one Replit. It validates
only inside the environment that issued it. That is why every server-side test passed and
both wallets refused it — I was validating from inside the trust boundary.

The `*.replit.app` subdomain is **free** and carries a real public certificate.

---

## What has to happen

Replit's own documentation, quoted:

> While Replit provides a free subdomain in the format `<your-live-app-subdomain-name>.replit.app`…
>
> | Feature | Replit Subdomain | Custom Domain |
> |---|---|---|
> | Security Certificates (TLS/SSL) | Provided by Replit | Provided by Replit |
> | Price | **Free** | Pay your domain provider |
>
> **Publish your app before connecting a domain.** The Domains tab becomes available once your
> app has a successful Deployment.

So: **publish → deployment → `*.replit.app` with real HTTPS.** No domain purchase needed.

---

## Why I cannot do this step for you

Publishing is triggered from the Replit interface, not from a shell:

- `replit` CLI exposes only `identity`, `ai`, `shutdown`, `secrets`, `gitsafe` — there is
  **no `deploy` or `publish` verb** (verified).
- No Replit API credential exists in this environment to call the publishing endpoint.
- Replit's docs describe two routes, both of which need you:
  1. the **Publish** button in the editor, or
  2. typing `Publish this app.` in the Agent prompt, which prepares a release and then asks
     you to confirm.

There is no third route. I am not going to claim otherwise.

---

## Steps for you

1. Open the project in the Replit editor.
2. **Publish** (upper right in the editor, or `Publish this app.` in the prompt box).
3. Choose the subdomain Replit offers, e.g. `nexora-testnet.replit.app`.
4. Access level: **Public** — otherwise the phone cannot reach it.
5. Wait for the Deployment to succeed. Note the URL.
6. Run the checker from this repository against it:

```bash
node scripts/rpc-check.mjs "https://<subdomain>.replit.app/api/nexora/evm" \
  --expected-chain-id 902024
```

The TLS section must say `PASS  issuer is a publicly trusted CA`.

---

## The part that may not work, stated plainly

A **Deployment is a separate container** from this dev workspace. It is built from the
repository, not from this machine's live processes.

For the chain to answer on the published URL, the Deployment has to do all of this itself:

- build `evmd` from `cosmos/evm v0.7.3` — roughly 10–15 minutes from cold
- generate the four-validator genesis
- run **four** long-lived validator processes
- start the gateway

That is a heavy workload for an Autoscale Deployment, which is designed for short-lived
request handlers rather than four persistent peers. Free Autoscale also has CPU and memory
limits that four validators may exceed.

I have **not** verified that a Deployment can host this. I cannot test it without you
publishing. If the Deployment cannot keep the validators alive, the published URL will
return 502 or time out — and the honest answer then is that a free Replit Deployment is not
sized for a four-validator chain.

---

## If publishing does not work

Ranked by how quickly you get a usable phone wallet:

| | Cost | Result |
|---|---|---|
| **Run it on your own machine** | **$0** | Wallet works on your Wi-Fi. Zero Replit involvement. |
| Reserved VM Deployment + custom domain | ~$20/mo | Always-on, real HTTPS, but paid |
| Any small VPS + your own domain | ~$4–5/mo | Always-on, real HTTPS, full control |
| Cloudflare Tunnel in front of this Replit | $0 | **Real HTTPS without publishing** — see below |

### The free tunnel option

Cloudflare Tunnel issues a **real, publicly trusted certificate** for a `trycloudflare.com`
hostname and forwards to `http://127.0.0.1:8080`. It needs no Replit plan and no domain:

```bash
# in this Replit
cloudflared tunnel --url http://127.0.0.1:8080
# -> https://<random>.trycloudflare.com
```

That URL is reachable from a phone with a normal certificate. It is ephemeral — it changes
each time the tunnel starts, and it dies when the Repl sleeps.

I have not set this up because it needs a `cloudflared` binary and your go-ahead to run a
third-party service in front of the chain. Say the word and I will install it and test.

---

## What is not changing

Free. Testnet only. No Mainnet, no domain purchase, no paid plan without your approval.
Validator and wallet keys remain the upstream public test mnemonics and hold no value.