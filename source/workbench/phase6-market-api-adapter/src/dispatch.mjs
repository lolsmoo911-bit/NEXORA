/**
 * Discriminated domain API surface for the Phase 6 market adapter.
 * No network, no UI, no side effects. Pure dispatch over explicit request objects.
 *
 * @typedef {{ok:true, type:string, result:any}} Ok
 * @typedef {{ok:false, type:string, error:{name:string, message:string}}} Err
 */

import * as canonicalBond from '../../../market/src/bond.mjs';
import * as canonicalDayCount from '../../../market/src/daycount.mjs';
import { bootstrapParCurve } from '../../phase6-integration/src/curve.mjs';
import { dayCountFraction as icmaAwareDayCountFraction } from '../../phase6-integration/src/daycount.mjs';
import {
  solveZSpread, dirtyPriceAtZSpread, spreadDuration, fixedBondCashflows,
} from '../../phase6-market-models/src/credit-spread.mjs';
import { fxForwardRate, fxCrossRate, fxTriangleDiagnostic, fxConvert } from '../../phase6-market-models/src/fx.mjs';
import { cryptoScenarioQuantiles, cryptoShockScenarios } from '../../phase6-market-models/src/crypto-scenarios.mjs';
import { runMarketSimulation } from '../../phase6-market-models/src/simulation.mjs';
import { migrateModelState } from '../../phase6-market-models/src/state-migration.mjs';

export const MARKET_REQUEST_TYPES = Object.freeze([
  'market.legacy.dayCountFraction',
  'market.legacy.bond.dirtyPrice',
  'market.legacy.bond.cleanPrice',
  'market.legacy.bond.yieldFromDirtyPrice',
  'market.legacy.bond.accruedInterest',
  'market.legacy.bond.sensitivities',
  'market.actActIcma.dayCountFraction',
  'market.curve.bootstrapPar',
  'market.credit.solveZSpread',
  'market.credit.dirtyPriceAtZSpread',
  'market.credit.spreadDuration',
  'market.credit.fixedBondCashflows',
  'market.fx.forwardRate',
  'market.fx.crossRate',
  'market.fx.triangleDiagnostic',
  'market.fx.convert',
  'market.crypto.scenarioQuantiles',
  'market.crypto.shockScenarios',
  'market.simulation.run',
  'market.state.migrate',
]);

function ok(type, result) { return { ok: true, type, result }; }
function err(type, e) {
  return { ok: false, type, error: { name: e?.name || 'Error', message: String(e?.message || e) } };
}

/**
 * Dispatch a discriminated market request.
 * @param {{type:string, payload?:any}} req
 * @returns {Ok|Err}
 */
export function dispatchMarketRequest(req) {
  const type = req && req.type;
  const p = (req && req.payload) || {};
  try {
    switch (type) {
      case 'market.legacy.dayCountFraction':
        return ok(type, canonicalDayCount.dayCountFraction(p.from, p.to, p.convention));
      case 'market.legacy.bond.dirtyPrice':
        return ok(type, canonicalBond.dirtyPrice(p.bond, p.y, p.settlement));
      case 'market.legacy.bond.cleanPrice':
        return ok(type, canonicalBond.cleanPrice(p.bond, p.y, p.settlement));
      case 'market.legacy.bond.yieldFromDirtyPrice':
        return ok(type, canonicalBond.yieldFromDirtyPrice(p.bond, p.price, p.settlement, p.bracket));
      case 'market.legacy.bond.accruedInterest':
        return ok(type, canonicalBond.accruedInterest(p.bond, p.settlement));
      case 'market.legacy.bond.sensitivities':
        return ok(type, canonicalBond.sensitivities(p.bond, p.y, p.settlement, p.h));
      case 'market.actActIcma.dayCountFraction':
        return ok(type, icmaAwareDayCountFraction(p.from, p.to, p.convention, p.opts));
      case 'market.curve.bootstrapPar':
        return ok(type, bootstrapParCurve(p.parQuotes));
      case 'market.credit.solveZSpread':
        // solveZSpread({ bond, settlement, curveNodes, dirtyPrice, bracket? })
        return ok(type, solveZSpread(p));
      case 'market.credit.dirtyPriceAtZSpread':
        // dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread })
        return ok(type, dirtyPriceAtZSpread(p));
      case 'market.credit.spreadDuration':
        // spreadDuration({ bond, settlement, curveNodes, zSpread }, bump?)
        return ok(type, spreadDuration(p, p.bump));
      case 'market.credit.fixedBondCashflows':
        return ok(type, fixedBondCashflows(p.bond, p.settlement));
      case 'market.fx.forwardRate':
        // fxForwardRate({ spot, baseRate, quoteRate, yearFraction })
        return ok(type, fxForwardRate(p));
      case 'market.fx.crossRate':
        // fxCrossRate({ base, cross, quote, crossPerBase, quotePerCross })
        return ok(type, fxCrossRate(p));
      case 'market.fx.triangleDiagnostic':
        // fxTriangleDiagnostic({ base, cross, quote, crossPerBase, quotePerCross, quotePerBase, tolerance? })
        return ok(type, fxTriangleDiagnostic(p));
      case 'market.fx.convert': {
        // fxConvert takes { amount, rate } (phase6-market-models contract).
        const args = (p && typeof p.amount === 'number' && typeof p.rate === 'number') ? { amount: p.amount, rate: p.rate } : p;
        return ok(type, fxConvert(args));
      }
      case 'market.crypto.scenarioQuantiles':
        // accepts { spot, annualVolatility, years, annualDrift?, zScores? }
        return ok(type, cryptoScenarioQuantiles(p));
      case 'market.crypto.shockScenarios':
        // accepts { spot, shocks? }
        return ok(type, cryptoShockScenarios(p));
      case 'market.simulation.run':
        // accepts { input } wrapper or direct simulation input object
        return ok(type, runMarketSimulation(p.input !== undefined ? p.input : p));
      case 'market.state.migrate': {
        // migrateModelState(serializedJsonString) expects {version(int), scenarioId, inputs}
        const serialized = typeof p.serialized === 'string' ? p.serialized : (typeof p.state === 'string' ? p.state : null);
        if (serialized === null) throw new TypeError('market.state.migrate requires payload.serialized (JSON string)');
        return ok(type, migrateModelState(serialized));
      }
      default:
        return { ok: false, type: String(type), error: { name: 'UnknownRequestType', message: `Unknown request type: ${type}` } };
    }
  } catch (e) {
    return err(String(type), e);
  }
}
