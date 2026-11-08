/**
 * Thin integration adapter (workbench only, NOT canonical market/).
 *
 * Public contract: this module exposes the SAME legacy market API as
 * canonical market/src/bond.mjs + market/src/daycount.mjs (identical function
 * names and signatures), plus two explicit additions:
 *   1. ACT/ACT ICMA day-count fraction via dayCountFraction(..., 'ACT/ACT ICMA',
 *      { referencePeriods, frequency }) — which requires explicit regular
 *      reference periods and is NOT an alias for bare ACT/ACT / ACT/ACT ISDA.
 *   2. bootstrapParCurve(parQuotes) — annual par-yield curve bootstrap.
 *
 * Nothing here claims it has been merged into canonical market/src. The
 * canonical files are untouched; this adapter exists so import compatibility
 * can be tested end-to-end before any deliberate merge proposal.
 */
export * from './bond.mjs';
export * from './daycount.mjs';
export * from './curve.mjs';
