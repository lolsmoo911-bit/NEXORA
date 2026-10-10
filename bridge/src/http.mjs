/**
 * NEXORA — Streamable HTTP MCP endpoint.
 *
 * Implemented against the current MCP Streamable HTTP transport specification:
 *   https://modelcontextprotocol.io/specification/draft/basic/transports/streamable-http
 *
 * Compliance points that are implemented and tested here:
 *   - ONE endpoint path (default /mcp); anything else is 404.
 *   - POST only. GET and DELETE are 405 (this revision defines no GET stream and no
 *     protocol-level sessions).
 *   - Origin is validated on every request; a present-but-invalid Origin is 403.
 *   - MCP-Protocol-Version is required and must match the body's
 *     io.modelcontextprotocol/protocolVersion field, otherwise 400 HeaderMismatch.
 *     An unsupported version is 400 UnsupportedProtocolVersionError.
 *   - A JSON-RPC *notification* is answered with 202 Accepted and NO body.
 *   - A JSON-RPC *request* is answered with 200 application/json.
 *   - Unknown method is 404 with JSON-RPC -32601 (per this revision).
 *   - Bodies over the configured limit are rejected (413) before parsing.
 *   - Bearer auth is enforced before anything else, with a timing-safe comparison.
 */

import { config, validateConfig, redact, isLoopbackUrl } from './config.mjs';
import { createServer as createRpcServer } from './server.mjs';
import { timingSafeEqual as cryptoTimingSafeEqual } from 'node:crypto';

// JSON-RPC error codes used by MCP.
const HEADER_MISMATCH = -32020;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

// JSON-RPC error code for an unsupported protocol revision (name from the schema:
// UnsupportedProtocolVersionError). The spec reserves this sub-range for protocol errors.
const UNSUPPORTED_PROTOCOL_VERSION = -32001;

export function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // Length is not a secret; comparing contents must still take constant time.
  if (ba.length !== bb.length) return false;
  return cryptoTimingSafeEqual(ba, bb);
}

/** Validate the Origin header per the spec. Returns null when acceptable. */
export function checkOrigin(origin, cfg = config) {
  if (!origin) return null;                 // absent: fine (tunnel / server-to-server)
  const allowed = cfg.mcp.allowedOrigins;
  if (allowed.length === 0) {
    // No allowlist configured. A browser-driven origin would be a DNS-rebinding vector,
    // so we refuse any Origin at all unless the owner explicitly allows it.
    return 'origin not allowed (no BRIDGE_ALLOWED_ORIGINS configured)';
  }
  if (allowed.includes(origin)) return null;
  return `origin not allowed: ${redact(origin)}`;
}

/** Negotiate the protocol version from the headers + body. Returns {ok, version, problem}. */
export function negotiateProtocolVersion(headerValue, body, cfg = config) {
  const bodyVersion = body?._meta?.['io.modelcontextprotocol/protocolVersion'] || null;

  if (!headerValue) {
    if (cfg.mcp.requireProtocolHeader) {
      return { ok: false, problem: { status: 400, code: HEADER_MISMATCH, message: 'missing MCP-Protocol-Version header' } };
    }
    // Legacy era: treat a missing header as 2025-03-26.
    return { ok: true, version: '2025-03-26' };
  }
  if (!cfg.mcp.supportedProtocolVersions.includes(headerValue)) {
    return {
      ok: false,
      problem: {
        status: 400,
        code: UNSUPPORTED_PROTOCOL_VERSION,
        message: `unsupported protocol version ${headerValue}`,
        data: { supported: cfg.mcp.supportedProtocolVersions }
      }
    };
  }
  if (bodyVersion && bodyVersion !== headerValue) {
    return {
      ok: false,
      problem: { status: 400, code: HEADER_MISMATCH, message: `HeaderMismatch: header ${headerValue} != body ${bodyVersion}` }
    };
  }
  return { ok: true, version: headerValue };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let aborted = false;
    const chunks = [];
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > limit) {
        // Stop accumulating but keep draining so the response can still be delivered;
        // destroying the socket here would race the 413 and surface as a hang-up.
        aborted = true;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) resolve({ tooLarge: true });
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/**
 * Build the HTTP request handler for the MCP endpoint.
 * `audit` is optional and receives structured, secret-free records.
 */
export function createHttpHandler({ audit } = {}) {
  const rpc = createRpcServer({ audit });

  return async function handler(req, res) {
    const send = (status, payload, headers = {}) => {
      const h = { 'content-type': 'application/json', ...headers };
      if (payload === undefined || payload === null) {
        res.writeHead(status, h);
        res.end();
      } else {
        const body = JSON.stringify(payload);
        res.writeHead(status, h);
        res.end(body);
      }
    };

    // ---- 1. auth first (nothing else is processed for an unauthenticated caller) ----
    const auth = req.headers.authorization || '';
    const expected = `Bearer ${config.bridgeToken}`;
    if (!config.bridgeToken || !timingSafeEqual(auth, expected)) {
      audit?.write({ tool: 'http', ok: false, code: 'unauthorized' });
      return send(401, { error: 'unauthorized' });
    }

    // ---- 2. single endpoint path ----
    if (req.url !== config.mcp.endpointPath) {
      return send(404, { jsonrpc: '2.0', id: null, error: { code: METHOD_NOT_FOUND, message: 'unknown endpoint' } });
    }

    // ---- 3. method: POST only (this revision has no GET stream and no sessions) ----
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(405, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'only POST is supported' } });
    }

    // ---- 4. Origin validation (DNS-rebinding defence) ----
    const originProblem = checkOrigin(req.headers.origin);
    if (originProblem) {
      audit?.write({ tool: 'http', ok: false, code: 'origin_rejected' });
      return send(403, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: redact(originProblem) } });
    }

    // ---- 5. content type must be JSON ----
    const ctype = String(req.headers['content-type'] || '');
    if (!ctype.toLowerCase().includes('application/json')) {
      return send(415, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'content-type must be application/json' } });
    }

    // ---- 6. body with a hard size limit ----
    let raw;
    try {
      raw = await readBody(req, config.limits.maxHttpBodyBytes);
    } catch (err) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'could not read request body' } });
    }
    if (raw && typeof raw === 'object' && raw.tooLarge) {
      return send(413, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'payload too large' } });
    }

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'invalid JSON' } });
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'body must be a single JSON-RPC message' } });
    }
    // Batched arrays are not part of this revision's "one message per POST" rule.
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return send(400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: INVALID_REQUEST, message: 'not a JSON-RPC request or notification' } });
    }

    // ---- 7. protocol version negotiation ----
    const negotiation = negotiateProtocolVersion(req.headers['mcp-protocol-version'], message, config);
    if (!negotiation.ok) {
      return send(negotiation.problem.status, {
        jsonrpc: '2.0', id: message.id ?? null,
        error: { code: negotiation.problem.code, message: negotiation.problem.message, ...(negotiation.problem.data ? { data: negotiation.problem.data } : {}) }
      });
    }

    // ---- 8. notifications: 202 Accepted with NO body ----
    const isNotification = message.id === undefined || message.id === null;
    if (isNotification) {
      await rpc(message);            // process side effects; the result is intentionally dropped
      audit?.write({ tool: 'http', ok: true, code: 'notification_accepted' });
      return send(202, null);        // no body, per spec
    }

    // ---- 9. requests: 200 application/json ----
    const result = await rpc(message);
    if (!result) {
      return send(500, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: 'internal error' } });
    }
    // Per this Streamable HTTP revision, an unknown RPC method is answered with HTTP 404 and a
    // JSON-RPC -32601 error body, which is what distinguishes a modern server from a legacy
    // HTTP+SSE server that simply 404s the endpoint.
    if (result.error && result.error.code === METHOD_NOT_FOUND) {
      return send(404, result);
    }
    return send(200, result);
  };
}

export { timingSafeEqual as _timingSafeEqual };
