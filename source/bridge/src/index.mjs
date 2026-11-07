#!/usr/bin/env node
/**
 * NEXORA — OpenCode bridge entry point.
 *
 * Usage:
 *   node src/index.mjs --stdio          speak MCP over stdin/stdout (local client)
 *   node src/index.mjs --http           expose the same JSON-RPC on loopback for a tunnel
 *   node src/index.mjs --check          validate configuration and print it (no secrets)
 *
 * This process never exposes the OpenCode API to the internet. In --http mode it binds
 * 127.0.0.1 only, requires BRIDGE_TOKEN, and is meant to sit behind a private tunnel.
 */

import { config, validateConfig, safeEndpointLabel } from './config.mjs';
import { createAudit, createServer, callTool, TOOLS } from './server.mjs';
import { createHttpHandler } from './http.mjs';
import { opencodeHealth } from './opencode-client.mjs';
import { nexoraGitStatus, nexoraHeadInfo } from './repo.mjs';
import http from 'node:http';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);

async function doCheck() {
  const check = validateConfig();
  const api = await opencodeHealth();
  let repo = { error: 'not checked' };
  try {
    const st = await nexoraGitStatus();
    const head = await nexoraHeadInfo();
    repo = { branch: st.branch, clean: st.clean, changed: st.changedCount, sha: head.sha };
  } catch (err) { repo = { error: err.message }; }
  const out = {
    bridge: 'nexora-opencode-bridge',
    configValid: check.ok,
    problems: check.problems,
    transport: config.transport,
    workspaceRoot: config.workspaceRoot,
    opencodeEndpoint: safeEndpointLabel(),     // never a URL containing userinfo
    opencodeAuthConfigured: Boolean(config.opencode.password),
    mcp: {
      endpointPath: config.mcp.endpointPath,
      supportedProtocolVersions: config.mcp.supportedProtocolVersions,
      requireProtocolHeader: config.mcp.requireProtocolHeader,
      allowedOrigins: config.mcp.allowedOrigins
    },
    limits: config.limits,
    opencodeApi: api,
    repo,
    tools: TOOLS.map((t) => ({ name: t.name, write: !t.annotations?.readOnlyHint }))
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  process.exit(check.ok ? 0 : 1);
}

function startHttp() {
  const check = validateConfig();
  if (!check.ok) {
    process.stderr.write('refusing to start http transport: ' + JSON.stringify(check.problems) + '\n');
    process.exit(1);
  }
  const audit = createAudit();
  const handler = createHttpHandler({ audit });
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }));
      }
    });
  });
  const requested = Number(process.env.BRIDGE_PORT || 8787);
  const host = config.mcp.allowNonLoopbackBind ? '0.0.0.0' : '127.0.0.1';
  if (host !== '127.0.0.1') {
    process.stderr.write('WARNING: BRIDGE_ALLOW_NON_LOOPBACK_BIND is set; do NOT publish this endpoint without a private tunnel.\n');
  }
  server.listen(requested, host, () => {
    const actual = server.address()?.port ?? requested;
    process.stderr.write(`nexora bridge listening on ${host}:${actual} (MCP endpoint ${config.mcp.endpointPath})\n`);
  });
}

if (flag('--check')) {
  await doCheck();
} else if (flag('--http')) {
  startHttp();
} else {
  // default: stdio
  const auditSink = config.auditLogPath
    ? (rec) => { try { fs.appendFileSync(config.auditLogPath, JSON.stringify(rec) + '\n'); } catch { /* best effort */ } }
    : null;
  const audit = createAudit(auditSink);
  const { startStdio } = await import('./server.mjs');
  startStdio({ audit });
}
