import test from 'node:test';
import assert from 'node:assert/strict';
import { cryptoScenarioQuantiles, cryptoShockScenarios } from '../src/crypto-scenarios.mjs';

test('GBM quantile scenarios are deterministic and positive', () => {
  const input = { spot: 100, annualVolatility: 0.8, years: 1, annualDrift: 0, zScores: [-2, 0, 2] };
  const a = cryptoScenarioQuantiles(input);
  assert.deepEqual(cryptoScenarioQuantiles(input), a);
  assert.ok(a.every(x => x.price > 0));
});
test('shock scenarios reject total loss and preserve deterministic order', () => {
  assert.deepEqual(cryptoShockScenarios({ spot: 50, shocks: [-0.5, 0, 0.5] }).map(x => x.scenarioPrice), [25, 50, 75]);
  assert.throws(() => cryptoShockScenarios({ spot: 10, shocks: [-1] }), /greater than -1/);
});
test('volatility, time and spot domains are validated', () => {
  assert.throws(() => cryptoScenarioQuantiles({ spot: 0, annualVolatility: 1, years: 1 }), /positive/);
  assert.throws(() => cryptoScenarioQuantiles({ spot: 1, annualVolatility: -1, years: 1 }), /cannot be negative/);
});
