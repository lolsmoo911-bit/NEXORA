import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { nexoraProxy } from "./nexoraProxy";
import { nexoraFaucet } from "./nexoraFaucetMount";
import { opencodeProxy } from "./opencodeProxy";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());

// NEXORA testnet read-only proxy (/api/nexora/*).
//
// It must sit ABOVE express.json(): that parser consumes the request stream, so a proxy
// mounted below it would find the body already gone. GETs survive that (no body), which is
// why /cosmos/status appeared to work while every EVM POST silently returned nothing.
app.use(nexoraProxy);

// OpenCode's own /api/* and UI assets are forwarded to the local OpenCode web
// server only when OPENCODE_PROXY_ENABLED is explicitly true AND the client
// presents a strong bearer token. The proxy is disabled by default and fails
// closed if it is enabled without OPENCODE_PROXY_TOKEN. Mounted BEFORE body
// parsers so the request stream is forwarded untouched. NEXORA owns
// /api/nexora/* (handled above) and NEXORA faucet falls through because this
// skips that prefix and calls next().
app.use(opencodeProxy);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// NEXORA faucet (/api/nexora/faucet). Mounted AFTER the body parser because it reads a
// JSON body, and BEFORE the /api router so it is never swallowed by it. This is the only
// route in this server that moves funds; it is testnet-only, POST-only, capped and
// rate limited, and it never accepts or returns a signing key.
app.use(nexoraFaucet);

app.use("/api", router);

export default app;
