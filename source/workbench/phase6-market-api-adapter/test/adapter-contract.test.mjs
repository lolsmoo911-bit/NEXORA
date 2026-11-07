import test from 'node:test';
import assert from 'node:assert/strict';
import * as adapter from '../src/adapter.mjs';
import { dispatchMarketRequest, MARKET_REQUEST_TYPES } from '../src/dispatch.mjs';
import * as canonicalBond from '../../../market/src/bond.mjs';
import * as canonicalDayCount from '../../../market/src/daycount.mjs';

const bond = { face: 100, couponRate: 0.05, frequency: 2, maturity: '2030-01-01', dayCount: '30/360 US' };
const bondAnnual = { face: 100, couponRate: 0.05, frequency: 1, maturity: '2029-01-01', dayCount: '30/360 US' };
const refPeriods = [{ start: '2025-01-15', end: '2025-07-15', pay: '2025-07-15' }];
const curveNodes = adapter.bootstrapParCurve([{ tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.055 }, { tenorYears: 3, parYield: 0.06 }]);
const creditBase = { bond: bondAnnual, settlement: '2028-01-01', curveNodes };
const validSimulationInput = {
  parQuotes: [{ tenorYears: 1, parYield: 0.05 }, { tenorYears: 2, parYield: 0.06 }],
  bond: { instrument: { face: 100, couponRate: 0.05, frequency: 2, maturity: '2030-01-01', dayCount: '30/360 US' }, settlement: '2028-01-01' },
  fx: { spot: 1.1, baseRate: 0.01, quoteRate: 0.03, yearFraction: 1 },
  crypto: { spot: 50000, annualVolatility: 0.8, years: 1 },
};
const validMigrationState = JSON.stringify({ version: 1, scenarioId: 's1', inputs: { x: 1 } });

test('preserves canonical market bond/daycount exports (legacy API)', () => {
  for (const name of ['couponPerPeriod','schedule','dirtyPrice','accruedInterest','cleanPrice','yieldFromDirtyPrice','sensitivities','dv01']) {
    assert.equal(typeof adapter[name], 'function', name);
    assert.equal(adapter[name], canonicalBond[name], name + ' must be same reference as canonical');
  }
  for (const name of ['parseDate','addMonths','dayCountFraction','daysBetween','daysInMonth','isLastDayOfMonth','addDays','assertSupportedConvention','ymd']) {
    assert.equal(typeof adapter[name], 'function', name);
    assert.equal(adapter[name], canonicalDayCount[name], name + ' must be same reference as canonical');
  }
});

test('exposes ICMA/curve and credit/FX/crypto/simulation/migration paths', () => {
  for (const name of ['bootstrapParCurve','icmaDayCountFraction','solveZSpread','dirtyPriceAtZSpread','spreadDuration','fixedBondCashflows','fxForwardRate','fxCrossRate','fxTriangleDiagnostic','fxConvert','cryptoScenarioQuantiles','cryptoShockScenarios','runMarketSimulation','migrateModelState','stableStringify']) {
    assert.equal(typeof adapter[name], 'function', name);
  }
  assert.equal(typeof adapter.phase6Integration.bootstrapParCurve, 'function');
  assert.equal(typeof adapter.phase6MarketModels.runMarketSimulation, 'function');
});

test('legacy bond pricing behavior preserved via adapter exports', () => {
  const p = adapter.dirtyPrice(bond, 0.05, '2028-01-01');
  assert.ok(Number.isFinite(p) && p > 0);
  const y = adapter.yieldFromDirtyPrice(bond, p, '2028-01-01');
  assert.ok(Math.abs(y - 0.05) < 1e-10);
});

test('ACT/ACT ICMA: raw export (referencePeriods,frequency,start,end) and ICMA-aware wrapper', () => {
  // raw icmaDayCountFraction(referencePeriods, frequency, start, end)
  const f = adapter.icmaDayCountFraction(refPeriods, 2, '2025-01-15', '2025-07-15');
  assert.ok(Number.isFinite(f) && f > 0 && f < 1.1);
  // dispatch uses ICMA-aware dayCountFraction(from,to,'ACT/ACT ICMA',{referencePeriods,frequency})
  const r = dispatchMarketRequest({ type: 'market.actActIcma.dayCountFraction', payload: { from: '2025-01-15', to: '2025-07-15', convention: 'ACT/ACT ICMA', opts: { referencePeriods: refPeriods, frequency: 2 } } });
  assert.equal(r.ok, true); assert.ok(Number.isFinite(r.result));
});

function expectOk(type, payload, check) {
  const r = dispatchMarketRequest({ type, payload });
  assert.equal(r.ok, true, `${type} should ok: ${r.error?.message || ''}`);
  assert.equal(r.type, type);
  if (check) check(r.result);
  return r;
}
function expectErr(type, payload) {
  const r = dispatchMarketRequest({ type, payload });
  assert.equal(r.ok, false, `${type} should fail`);
  assert.ok(r.error && typeof r.error.message === 'string' && r.error.name, 'error object');
  return r;
}

test('discriminated dispatch: valid fixture + malformed payload per request type', () => {
  expectOk('market.legacy.dayCountFraction', { from: '2025-01-01', to: '2025-07-01', convention: '30/360 US' }, v => assert.ok(Number.isFinite(v)));
  expectErr('market.legacy.dayCountFraction', { from: 'bad', to: '2025-07-01', convention: '30/360 US' });

  expectOk('market.legacy.bond.dirtyPrice', { bond, y: 0.05, settlement: '2028-01-01' }, v => assert.ok(v > 0));
  expectErr('market.legacy.bond.dirtyPrice', { bond, y: 0.05, settlement: '2099-01-01' }); // after maturity

  expectOk('market.legacy.bond.cleanPrice', { bond, y: 0.05, settlement: '2028-01-01' }, v => assert.ok(Number.isFinite(v)));
  expectErr('market.legacy.bond.cleanPrice', { bond: null, y: 0.05, settlement: '2028-01-01' });

  const p = adapter.dirtyPrice(bond, 0.05, '2028-01-01');
  expectOk('market.legacy.bond.yieldFromDirtyPrice', { bond, price: p, settlement: '2028-01-01' }, v => assert.ok(Math.abs(v - 0.05) < 1e-9));
  expectErr('market.legacy.bond.yieldFromDirtyPrice', { bond, price: -1, settlement: '2028-01-01' });

  expectOk('market.legacy.bond.accruedInterest', { bond, settlement: '2028-01-01' }, v => assert.ok(Number.isFinite(v)));
  expectErr('market.legacy.bond.accruedInterest', { bond, settlement: '2099-01-01' }); // after maturity

  expectOk('market.legacy.bond.sensitivities', { bond, y: 0.05, settlement: '2028-01-01' }, v => assert.equal(typeof v, 'object'));
  expectErr('market.legacy.bond.sensitivities', { bond: {}, y: 0.05, settlement: '2028-01-01' });

  expectOk('market.actActIcma.dayCountFraction', { from: '2025-01-15', to: '2025-07-15', convention: 'ACT/ACT ICMA', opts: { referencePeriods: refPeriods, frequency: 2 } }, v => assert.ok(v > 0));
  expectErr('market.actActIcma.dayCountFraction', { from: '2025-01-15', to: '2025-07-15', convention: 'ACT/ACT ICMA', opts: {} });

  expectOk('market.curve.bootstrapPar', { parQuotes: [{ tenorYears: 1, parYield: 0.05 }] }, v => assert.equal(v.length, 1));
  expectErr('market.curve.bootstrapPar', { parQuotes: [] });

  // credit: uses {bond, settlement, curveNodes, dirtyPrice?, zSpread?, bracket?}
  const dp = adapter.dirtyPriceAtZSpread({ ...creditBase, zSpread: 0 });
  expectOk('market.credit.dirtyPriceAtZSpread', { ...creditBase, zSpread: 0 }, v => assert.ok(Math.abs(v - dp) < 1e-9));
  expectErr('market.credit.dirtyPriceAtZSpread', { bond: bondAnnual, settlement: '2028-01-01', curveNodes: [], zSpread: 0 });

  expectOk('market.credit.solveZSpread', { ...creditBase, dirtyPrice: dp }, v => assert.ok(Math.abs(v) < 1e-6));
  expectErr('market.credit.solveZSpread', { ...creditBase, dirtyPrice: -1 });

  expectOk('market.credit.spreadDuration', { ...creditBase, zSpread: 0.01 }, v => assert.ok(Number.isFinite(v)));
  expectErr('market.credit.spreadDuration', { bond: bondAnnual, settlement: '2028-01-01', curveNodes: 'bad', zSpread: 0 });

  expectOk('market.credit.fixedBondCashflows', { bond, settlement: '2028-01-01' }, v => assert.ok(Array.isArray(v)));
  expectErr('market.credit.fixedBondCashflows', { bond: null, settlement: '2028-01-01' });

  expectOk('market.fx.forwardRate', { spot: 1.1, baseRate: 0.01, quoteRate: 0.03, yearFraction: 1 }, v => assert.ok(Number.isFinite(v)));
  expectErr('market.fx.forwardRate', { spot: 1.1, baseRate: 'x', quoteRate: 0.03, yearFraction: 1 });

  expectOk('market.fx.crossRate', { base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.1, quotePerCross: 150 }, v => assert.ok(Math.abs((v.quotePerBase ?? v) - 165) < 1e-9));
  expectErr('market.fx.crossRate', { base: 'EUR' });

  expectOk('market.fx.triangleDiagnostic', { base: 'EUR', cross: 'USD', quote: 'JPY', crossPerBase: 1.1, quotePerCross: 150, quotePerBase: 165, tolerance: 0.01 }, v => assert.equal(typeof v, 'object'));
  expectErr('market.fx.triangleDiagnostic', {}); // missing required fields

  expectOk('market.fx.convert', { amount: 100, rate: 1.1 }, v => assert.ok(Math.abs((typeof v === 'number' ? v : (v.converted ?? v.amount)) - 110) < 1e-9));
  expectErr('market.fx.convert', { amount: 100, rate: -1 });

  expectOk('market.crypto.scenarioQuantiles', { spot: 100, annualVolatility: 0.5, years: 1 }, v => assert.ok(Array.isArray(v)));
  expectErr('market.crypto.scenarioQuantiles', { spot: -1, annualVolatility: 0.5, years: 1 });

  expectOk('market.crypto.shockScenarios', { spot: 100 }, v => assert.ok(Array.isArray(v) || typeof v === 'object'));
  expectErr('market.crypto.shockScenarios', {});

  expectOk('market.simulation.run', { input: validSimulationInput }, v => assert.ok(v && v.outputs));
  expectErr('market.simulation.run', { input: { asOf: '2026-01-01' } });

  expectOk('market.state.migrate', { serialized: validMigrationState }, v => {
    const obj = typeof v === 'string' ? JSON.parse(v) : v;
    assert.ok((obj.version ?? obj.schemaVersion) >= 1);
  });
  expectErr('market.state.migrate', { state: { version: 1 } }); // requires serialized string

  expectErr('market.unknown', {});
});

test('dispatch exposes known request types including simulation and migration', () => {
  for (const t of ['market.legacy.bond.dirtyPrice','market.actActIcma.dayCountFraction','market.curve.bootstrapPar','market.credit.solveZSpread','market.fx.forwardRate','market.crypto.scenarioQuantiles','market.simulation.run','market.state.migrate']) {
    assert.ok(MARKET_REQUEST_TYPES.includes(t), t);
  }
});
