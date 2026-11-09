// NEXORA status probe — minimal Bun HTTP service for Prisma Compute.
// Layout follows the official Prisma Composer quickstart verbatim.
// NOT DEPLOYED (no account access in the executing environment).
import service from "./service.ts";

const APP_ID = "nexora-status";
const APP_VERSION = "0.0.1-experimental";

const handler = (req: Request): Response => {
  const url = new URL(req.url);
  if (req.method !== "GET") {
    return Response.json(
      { status: "error", message: "method not allowed" },
      { status: 405 },
    );
  }
  if (url.pathname === "/health" || url.pathname === "/") {
    return Response.json(
      {
        status: "ok",
        app: APP_ID,
        version: APP_VERSION,
        runtime: {
          bun: Bun.version,
          nodeCompat: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        time: new Date().toISOString(),
        note: "prepared artifact; deployment gated on a verified Free plan",
      },
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return Response.json({ status: "error", message: "not found" }, { status: 404 });
};

Bun.serve({
  port: service.port(),
  hostname: "0.0.0.0", // Compute routes external HTTP to the VM; loopback-only listeners are unreachable
  fetch: handler,
});