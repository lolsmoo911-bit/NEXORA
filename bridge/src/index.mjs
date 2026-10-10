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

import { config, validateConfig } from './config.mjs';
import { createAudit, createServer, callTool, TOOLS } from './server.mjs';
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
    opencodeBaseUrl: config.opencode.baseUrl,
    opencodeAuthConfigured: Boolean(config.opencode.password),
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
  const handle = createServer({ audit });
  const server = http.createServer(async (req, res) => {
    // Auth first: this endpoint is the one a tunnel will publish.
    const auth = req.headers.authorization || '';
    const expected = 'Bearer ' + config.bridgeToken;
    const okAuth = auth.length === expected.length &&
      (await import('node:crypto')).timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
    if (!okAuth) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      audit.write({ tool: 'http', ok: false, code: 'unauthorized' });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 256 * 1024) { req.destroy(); }
    });
    req.on('end', async () => {
      let message;
      try { message = JSON.parse(body || '{}'); } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad json' }));
        return;
      }
      const result = await handle(message);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result || { ok: true }));
    });
  });
  const port = Number(process.env.BRIDGE_PORT || 8787);
  // Loopback only, always. A tunnel in front of this is the supported remote path.
  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`nexora bridge listening on 127.0.0.1:${port} (loopback only)\n`);
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
