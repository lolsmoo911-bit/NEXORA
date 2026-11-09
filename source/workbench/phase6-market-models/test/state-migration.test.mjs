import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateModelState, stableStringify } from '../src/state-migration.mjs';

test('v1 state migrates deterministically to v2', () => {
  const v1 = JSON.stringify({ version: 1, scenarioId: 'demo', inputs: { b: 2, a: 1 } });
  const migrated = migrateModelState(v1);
  assert.equal(migrated, migrateModelState(v1));
  assert.deepEqual(JSON.parse(migrated), { version: 2, scenarioId: 'demo', inputs: { a: 1, b: 2 }, assumptions: {}, outputs: null });
});
test('v2 state round-trips idempotently with stable keys', () => {
  const v2 = stableStringify({ version: 2, scenarioId: 's', inputs: {}, assumptions: {}, outputs: null });
  assert.equal(migrateModelState(v2), v2);
});
test('corrupt, unknown future, and invalid state are rejected', () => {
  assert.throws(() => migrateModelState('{'), /valid JSON/);
  assert.throws(() => migrateModelState('{"version":3}'), /future/);
  assert.throws(() => migrateModelState('{"version":1,"scenarioId":"","inputs":{}}'), /scenarioId/);
});
