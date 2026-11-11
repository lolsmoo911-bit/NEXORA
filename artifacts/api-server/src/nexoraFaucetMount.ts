/**
 * Mount point for the NEXORA faucet. Separate from nexoraProxy because it must
 * run AFTER express.json() (it reads a body) while the read proxy must run
 * BEFORE it (so it can forward the raw body for EVM JSON-RPC POSTs). That
 * ordering conflict is the only reason these are two modules.
 *
 * The durable store is created lazily: a non-faucet request, a malformed
 * request, or a misconfigured faucet never opens a database connection.
 */
import type { Request, Response, NextFunction } from "express";
import {
  buildTrustedProxyList,
  parseTrustedProxyEntries,
  handleFaucet,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_DAILY_CAP,
  DEFAULT_MAX_PER_REQUEST,
  DEFAULT_PAYOUT,
  DEFAULT_RECIPIENT_DAILY_CAP,
} from "./nexoraFaucet.ts";
import type { FaucetStore } from "./nexoraFaucetStore.ts";

export interface NexoraFaucetMountOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: inject a fake store instead of opening PostgreSQL. */
  storeFactory?: () => Promise<FaucetStore> | FaucetStore;
}

interface ParsedBigInt {
  value: bigint;
  error?: string;
}

function parsePositiveBigInt(
  name: string,
  raw: string | undefined,
  fallback: bigint,
): ParsedBigInt {
  if (raw === undefined || raw.trim() === "") return { value: fallback };
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return { value: fallback, error: `${name} must be a positive integer` };
  }
  const value = BigInt(text);
  if (value <= 0n) {
    return { value: fallback, error: `${name} must be greater than zero` };
  }
  return { value };
}

function parseCooldown(raw: string | undefined): {
  value: number;
  error?: string;
} {
  if (raw === undefined || raw.trim() === "") {
    return { value: DEFAULT_COOLDOWN_MS };
  }
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < 0) {
    return {
      value: DEFAULT_COOLDOWN_MS,
      error: "NEXORA_FAUCET_COOLDOWN_MS must be a non-negative integer",
    };
  }
  return { value };
}

export function createNexoraFaucetMount(
  options: NexoraFaucetMountOptions = {},
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const env = options.env ?? process.env;

  let storePromise: Promise<FaucetStore> | undefined;
  function getStore(): Promise<FaucetStore> {
    if (storePromise) return storePromise;
    try {
      storePromise = options.storeFactory
        ? Promise.resolve(options.storeFactory())
        : import("./nexoraFaucetStore.ts").then((module) =>
            module.createPostgresFaucetStore(),
          );
    } catch (error) {
      return Promise.reject(error);
    }
    storePromise = storePromise.catch((error: unknown) => {
      storePromise = undefined;
      throw error;
    });
    return storePromise;
  }

  // The handler only calls reserve/finalize after all cheap validation has
  // passed, so this indirection keeps PostgreSQL out of invalid requests.
  const lazyStore: FaucetStore = {
    reserve: async (input) => (await getStore()).reserve(input),
    finalize: async (id, outcome) => (await getStore()).finalize(id, outcome),
  };

  return async (req: Request, res: Response, next: NextFunction) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/api/nexora/faucet") {
      next();
      return;
    }

    const maxPerRequest = parsePositiveBigInt(
      "NEXORA_FAUCET_MAX_PER_REQUEST_WEI",
      env["NEXORA_FAUCET_MAX_PER_REQUEST_WEI"],
      DEFAULT_MAX_PER_REQUEST,
    );
    const defaultPayout = parsePositiveBigInt(
      "NEXORA_FAUCET_DEFAULT_PAYOUT_WEI",
      env["NEXORA_FAUCET_DEFAULT_PAYOUT_WEI"],
      DEFAULT_PAYOUT,
    );
    const recipientDailyCap = parsePositiveBigInt(
      "NEXORA_FAUCET_RECIPIENT_DAILY_CAP_WEI",
      env["NEXORA_FAUCET_RECIPIENT_DAILY_CAP_WEI"],
      DEFAULT_RECIPIENT_DAILY_CAP,
    );
    const dailyCap = parsePositiveBigInt(
      "NEXORA_FAUCET_DAILY_CAP_WEI",
      env["NEXORA_FAUCET_DAILY_CAP_WEI"],
      DEFAULT_DAILY_CAP,
    );
    const cooldown = parseCooldown(env["NEXORA_FAUCET_COOLDOWN_MS"]);
    const trusted = buildTrustedProxyList(
      parseTrustedProxyEntries(env["NEXORA_FAUCET_TRUSTED_PROXIES"]),
    );

    const errors = [
      maxPerRequest.error,
      defaultPayout.error,
      recipientDailyCap.error,
      dailyCap.error,
      cooldown.error,
      trusted.error,
    ].filter((error): error is string => Boolean(error));

    try {
      await handleFaucet(req, res, {
        opencode: {
          baseUrl:
            env["OPENCODE_BASE_URL"] ?? "http://127.0.0.1:4096",
        },
        faucetHome: env["NEXORA_FAUCET_HOME"],
        faucetAccount: env["NEXORA_FAUCET_ACCOUNT"] ?? "dev3",
        faucetNode:
          env["NEXORA_FAUCET_NODE"] ?? "http://127.0.0.1:26657",
        faucetChainId:
          env["NEXORA_FAUCET_CHAIN_ID"] ?? "eip155:902024",
        faucetGasPrice: env["NEXORA_FAUCET_GAS_PRICE"],
        evmdPath: env["NEXORA_EVMD"] ?? "evmd",
        store: lazyStore,
        trustedProxies: trusted.list,
        cooldownMs: cooldown.value,
        maxPerRequest: maxPerRequest.value,
        defaultPayout: defaultPayout.value,
        recipientDailyCap: recipientDailyCap.value,
        dailyCap: dailyCap.value,
        configError: errors.length > 0 ? errors.join("; ") : undefined,
      });
    } catch (error) {
      next(error);
    }
  };
}

export const nexoraFaucet = createNexoraFaucetMount();
