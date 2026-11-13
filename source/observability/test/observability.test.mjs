import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthRegistry, createLogger, summarizeRuntime } from '../src/observability.mjs';

test('structured logger records leveled events', () => {
  let t = 100;
  const logs = [];
  const logger = createLogger({ service: 'svc', now: () => ++t, sink: (e) => logs.push(e) });
  logger.info('started', { port: 3000 });
  logger.error('failed', { reason: 'x' });
  const entries = logger.getEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].service, 'svc');
  assert.equal(entries[0].event, 'started');
  assert.deepEqual(logger.getCounters(), { debug: 0, info: 1, warn: 0, error: 1 });
  assert.equal(logs.length, 2);
});

test('health registry aggregates check statuses', async () => {
  let t = 0;
  const health = createHealthRegistry({ now: () => (t += 5) });
  health.register('db', () => ({ ok: true }));
  health.register('cache', () => ({ ok: false }), { critical: false });
  health.register('rpc', () => { throw new Error('down'); }, { critical: true });
  const res = await health.run();
  assert.equal(res.status, 'down');
  assert.equal(res.checks.length, 3);
  assert.equal(res.checks.find(c => c.name === 'cache').status, 'degraded');
  assert.equal(res.checks.find(c => c.name === 'rpc').status, 'down');
});

test('summarizeRuntime builds local runtime snapshot', () => {
  const logger = createLogger({ now: () => 1 });
  logger.info('x');
  const summary = summarizeRuntime({ startedAt: Date.now() - 1000, logger, health: { status: 'ok', checks: [] } });
  assert.equal(summary.status, 'ok');
  assert.equal(summary.logCounters.info, 1);
  assert.ok(summary.uptimeMs >= 0);
});
