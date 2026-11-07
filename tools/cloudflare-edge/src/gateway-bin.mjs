import { createRpcGateway } from './rpc-gateway.mjs';

const port = process.env.NEXORA_GATEWAY_PORT === undefined
  ? 3100 : Number(process.env.NEXORA_GATEWAY_PORT);
const corsOrigins = (process.env.NEXORA_CORS_ORIGINS ?? '')
  .split(',').map(value => value.trim()).filter(Boolean);
const gateway = createRpcGateway({
  port,
  upstreamUrl: process.env.NEXORA_EVM_RPC_URL ?? 'http://127.0.0.1:8545',
  corsOrigins,
});
await gateway.start();
console.log('[nexora-rpc-edge] listening only on 127.0.0.1:' + gateway.port);
console.log('[nexora-rpc-edge] POST /evm; GET /health; read-only JSON-RPC');
console.log('[nexora-rpc-edge] origin health not asserted; no persistent service installed');

async function shutdown() {
  await gateway.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
