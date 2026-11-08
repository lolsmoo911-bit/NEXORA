import test from 'node:test';
import assert from 'node:assert/strict';
import { fxForwardRate, fxCrossRate, fxTriangleDiagnostic, fxConvert } from '../src/fx.mjs';

test('covered-interest-parity forward reconciles spot and carry', () => {
  const f = fxForwardRate({ spot: 1.1, baseRate: 0.03, quoteRate: 0.05, yearFraction: 1 });
  assert.ok(Math.abs(f - 1.1 * 1.05 / 1.03) < 1e-12);
});
test('cross rate composes base/cross times cross/quote', () => {
  assert.equal(fxCrossRate({ base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.08, quotePerCross: 150 }).quotePerBase, 162);
});
test('triangle diagnostic detects inconsistent cross rates', () => {
  const d = fxTriangleDiagnostic({ base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.08, quotePerCross: 150, quotePerBase: 160 });
  assert.equal(d.consistent, false);
  assert.ok(d.relativeDeviation > 0);
});
test('conversion and domains are validated', () => {
  assert.equal(fxConvert({ amount: 100, rate: 1.2 }), 120);
  assert.throws(() => fxForwardRate({ spot: 1, baseRate: -2, quoteRate: 0, yearFraction: 1 }), /accumulation/);
  assert.throws(() => fxCrossRate({ base: 'EUR', cross: 'USD', quote: 'USD', basePerCross: 1, crossPerQuote: 1 }), /differ/);
});
