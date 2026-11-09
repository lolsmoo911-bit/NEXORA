import { cpus, arch, platform, release, totalmem, version as osVersion } from 'node:os';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { bootstrapParCurve } from '../../phase6-integration/src/curve.mjs';
import { dirtyPriceAtZSpread, solveZSpread } from '../src/credit-spread.mjs';
import { fxForwardRate } from '../src/fx.mjs';
import { runMarketSimulation } from '../src/simulation.mjs';

const curveQuotes = Array.from({ length: 10 }, (_, i) => ({ tenorYears: i + 1, parYield: 0.035 + i * 0.001 }));
const curveNodes = bootstrapParCurve(curveQuotes);
const bond = { face: 100, couponRate: 0.045, frequency: 1, maturity: '2031-01-01', dayCount: 'ACT/365F' };
const settlement = '2026-01-01';
const dirtyPrice = dirtyPriceAtZSpread({ bond, settlement, curveNodes, zSpread: 0.012 });
const scenario = {
  parQuotes: curveQuotes,
  bond: { instrument: { ...bond, maturity: '2031-01-01' }, settlement, dirtyPrice },
  fx: { spot: 1.08, baseRate: 0.03, quoteRate: 0.045, yearFraction: 2 },
  crypto: { spot: 64000, annualVolatility: 0.62, years: 1, zScores: [-2, -1, 0, 1, 2] },
};
const cases = {
  curveBootstrap: () => bootstrapParCurve(curveQuotes),
  creditZSpread: () => solveZSpread({ bond, settlement, curveNodes, dirtyPrice }),
  fxForward: () => fxForwardRate({ spot: 1.08, baseRate: 0.03, quoteRate: 0.045, yearFraction: 2 }),
  wholeSimulation: () => runMarketSimulation(scenario),
};
function percentile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; }
const warmupIterations = 10;
const measuredIterations = 100;
const samples = 25;
const results = {};
for (const [name, fn] of Object.entries(cases)) {
  for (let i = 0; i < warmupIterations; i++) fn();
  const times = [];
  let checksum = 0;
  for (let s = 0; s < samples; s++) {
    const start = performance.now();
    for (let i = 0; i < measuredIterations; i++) {
      const value = fn();
      checksum += typeof value === 'number' ? value : Array.isArray(value) ? value.length : JSON.stringify(value).length;
    }
    times.push((performance.now() - start) / measuredIterations);
  }
  times.sort((a, b) => a - b);
  results[name] = {
    unit: 'ms/op',
    samples,
    operationsPerSample: measuredIterations,
    p50: percentile(times, 0.50),
    p95: percentile(times, 0.95),
    checksum,
  };
}
const report = {
  benchmark: 'NEXORA Phase 6 isolated model workbench',
  capturedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    os: `${platform()} ${release()}`,
    osVersion: osVersion(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    totalMemoryGiB: Number((totalmem() / (1024 ** 3)).toFixed(2)),
  },
  protocol: {
    warmupIterations: warmupIterations,
    samples,
    operationsPerSample: measuredIterations,
    statistic: 'per-operation elapsed time across independent samples; p50/p95 are machine-specific',
  },
  results,
  limitations: [
    'Synthetic deterministic inputs only; no live market data or RPC calls.',
    'Microbenchmark, not a network/production load test.',
    'Wall-clock latency varies with thermal state, virtualization and competing processes.',
  ],
};
const out = new URL('../perf-report.json', import.meta.url);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
