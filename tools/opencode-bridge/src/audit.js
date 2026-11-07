import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from './config.js';

const SECRET_KEY = /(password|passwd|secret|token|authorization|auth|cookie|credential|api[-_]?key|private[-_]?key|bearer)/i;
const SECRET_VALUE = /(bearer\s+[a-z0-9._~+/=-]{12,}|basic\s+[a-z0-9+/=]{12,}|sk-[a-z0-9-]{10,}|basic-auth-password)/i;

export function redact(value, depth = 0) {
  if (depth > 4) return '[depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return SECRET_VALUE.test(value) ? '[redacted]' : value.length > 600 ? `${value.slice(0, 600)}…(${value.length} chars)` : value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  const clean = {};
  for (const [key, entry] of Object.entries(value).slice(0, 40)) {
    clean[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(entry, depth + 1);
  }
  return clean;
}

/**
 * Append one sanitized audit record. Audit failures must never break a tool.
 */
export async function audit({ tool, args, status, error, durationMs, extra = {} }) {
  const record = {
    ts: new Date().toISOString(),
    tool,
    args: redact(args || {}),
    status: status || 'unknown',
    ...extra,
  };
  if (durationMs !== undefined) record.durationMs = Math.round(durationMs);
  if (error) record.error = redact(String(error)).slice(0, 400);
  try {
    await mkdir(dirname(config.auditFile), { recursive: true });
    await appendFile(config.auditFile, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (diskError) {
    console.error('[audit] cannot write:', diskError.message);
  }
}
