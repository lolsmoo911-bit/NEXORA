/**
 * Mount point for the NEXORA faucet. Separate from nexoraProxy because it must run AFTER
 * express.json() (it reads a body) while the read proxy must run BEFORE it (so it can
 * forward the raw body for EVM JSON-RPC POSTs). That ordering conflict is the only reason
 * these are two modules.
 */
import type { Request, Response, NextFunction } from "express";
import { handleFaucet } from "./nexoraFaucet";

export function nexoraFaucet(req: Request, res: Response, next: NextFunction): void {
  const url = req.url ?? "";
  if (!url.startsWith("/api/nexora/faucet")) {
    next();
    return;
  }
  return handleFaucet(req, res, {
    opencode: { baseUrl: process.env["OPENCODE_BASE_URL"] ?? "http://127.0.0.1:4096" },
    faucetHome: process.env["NEXORA_FAUCET_HOME"],
    faucetAccount: process.env["NEXORA_FAUCET_ACCOUNT"] ?? "dev3",
    faucetNode: process.env["NEXORA_FAUCET_NODE"] ?? "http://127.0.0.1:26657",
    faucetChainId: process.env["NEXORA_FAUCET_CHAIN_ID"] ?? "eip155:902024",
    faucetGasPrice: process.env["NEXORA_FAUCET_GAS_PRICE"],
    evmdPath: process.env["NEXORA_EVMD"] ?? "evmd",
  });
}