import test from 'node:test';
import assert from 'node:assert/strict';

import * as canonicalBond from '../../../market/src/bond.mjs';
import * as canonicalDaycount from '../../../market/src/daycount.mjs';
import * as adapter from '../src/adapter.mjs';

test('adapter exposes the same legacy public market API as canonical market/src', () => {
  for (const name of ['couponPerPeriod', 'schedule', 'dirtyPrice', 'cleanPrice', 'accruedInterest', 'yieldFromDirtyPrice', 'sensitivities', 'dv01']) {
    assert.equal(typeof adapter[name], 'function', `missing ${name}`);
    assert.equal(typeof canonicalBond[name], 'function', `canonical missing ${name}`);
  }
  for (const name of ['ymd', 'parseDate', 'daysBetween', 'daysInMonth', 'isLastDayOfMonth', 'addDays', 'addMonths', 'dayCountFraction', 'assertSupportedConvention']) {
    assert.equal(typeof adapter[name], 'function', `missing ${name}`);
    assert.equal(typeof canonicalDaycount[name], 'function', `canonical missing ${name}`);
  }
});

test('adapter legacy pricing and day-count values match canonical byte-for-byte logic', () => {
  const bond = { face: 100, couponRate: 0.06, frequency: 2, maturity: '2030-06-15', dayCount: '30/360 US' };
  assert.equal(adapter.dirtyPrice(bond, 0.06, '2020-06-15'), canonicalBond.dirtyPrice(bond, 0.06, '2020-06-15'));
  assert.equal(
    adapter.dayCountFraction('2020-02-29', '2021-02-28', '30/360 US'),
    canonicalDaycount.dayCountFraction('2020-02-29', '2021-02-28', '30/360 US'),
  );
});

test('adapter and canonical market both expose ICMA and curve bootstrap after integration', () => {
  assert.equal(typeof adapter.bootstrapParCurve, 'function');
  assert.equal(typeof adapter.icmaDayCountFraction, 'function');
  assert.equal(typeof canonicalBond.dirtyPrice, 'function');
  assert.equal(typeof canonicalDaycount.dayCountFraction, 'function');
});

test('adapter ICMA fraction requires explicit reference periods (no Treasury alias)', () => {
  assert.throws(() => adapter.dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT ICMA'), /referencePeriods/);
  const p = [{ start: '2020-01-01', end: '2021-01-01' }];
  assert.ok(Math.abs(adapter.dayCountFraction('2020-01-01', '2021-01-01', 'ACT/ACT ICMA', { referencePeriods: p, frequency: 1 }) - 1) < 1e-12);
});
