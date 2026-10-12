import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { nexoraProxy } from "./nexoraProxy";
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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
