function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }

export function createLogger({ service = 'nexora-local', sink = null, now = () => Date.now() } = {}) {
  const entries = [];
  const counters = { debug: 0, info: 0, warn: 0, error: 0 };
  const write = (level, event, fields = {}) => {
    assert(typeof event === 'string' && event.length > 0, 'event must be a non-empty string');
    const entry = {
      ts: now(),
      level,
      service,
      event,
      ...fields,
    };
    counters[level] = (counters[level] || 0) + 1;
    entries.push(entry);
    if (typeof sink === 'function') sink(entry);
    return entry;
  };
  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    getEntries: () => entries.map(e => ({ ...e })),
    getCounters: () => ({ ...counters }),
  };
}

export function createHealthRegistry({ now = () => Date.now() } = {}) {
  const checks = new Map();
  const register = (name, fn, { critical = true } = {}) => {
    assert(typeof name === 'string' && name.length > 0, 'check name must be a non-empty string');
    assert(typeof fn === 'function', 'check fn must be a function');
    checks.set(name, { name, fn, critical: Boolean(critical) });
    return { name, critical: Boolean(critical) };
  };

  const run = async () => {
    const results = [];
    for (const [name, check] of checks.entries()) {
      const started = now();
      try {
        const out = await check.fn();
        const ok = out === true || (out && typeof out === 'object' && out.ok === true);
        results.push({
          name,
          status: ok ? 'ok' : 'degraded',
          critical: check.critical,
          durationMs: Math.max(0, now() - started),
          details: out && typeof out === 'object' ? out : { value: out },
        });
      } catch (err) {
        results.push({
          name,
          status: 'down',
          critical: check.critical,
          durationMs: Math.max(0, now() - started),
          error: err?.message || String(err),
        });
      }
    }
    const hasCriticalDown = results.some(r => r.critical && r.status === 'down');
    const hasAnyIssue = results.some(r => r.status !== 'ok');
    const status = hasCriticalDown ? 'down' : hasAnyIssue ? 'degraded' : 'ok';
    return { status, timestamp: now(), checks: results };
  };

  return { register, run, list: () => [...checks.keys()].sort() };
}

export function summarizeRuntime({ startedAt, logger = null, health = null }) {
  const now = Date.now();
  return {
    status: health?.status ?? 'unknown',
    uptimeMs: startedAt != null ? Math.max(0, now - startedAt) : null,
    logCounters: logger?.getCounters ? logger.getCounters() : null,
    checks: health?.checks ?? null,
    timestamp: now,
  };
}
