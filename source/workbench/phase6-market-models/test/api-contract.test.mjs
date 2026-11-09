import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../src/index.mjs';

test('public API exports the Phase 6 model and migration functions', () => {
  for (const name of ['solveZSpread', 'dirtyPriceAtZSpread', 'spreadDuration', 'fxForwardRate', 'fxCrossRate', 'fxTriangleDiagnostic', 'fxConvert', 'cryptoScenarioQuantiles', 'cryptoShockScenarios', 'runMarketSimulation', 'migrateModelState']) {
    assert.equal(typeof api[name], 'function', name + ' must be exported');
  }
});
