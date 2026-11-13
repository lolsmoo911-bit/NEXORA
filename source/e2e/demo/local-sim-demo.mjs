import { createCoreApi } from '../../api/src/core-api.mjs';
import { createAssetIssuanceWorkflow } from '../../workflows/src/asset-issuance.mjs';
import { createLifecycleController } from '../../controls/src/lifecycle-controls.mjs';
import { createRbacService } from '../../auth/src/rbac.mjs';

function line(title) {
  console.log('\n=== ' + title + ' ===');
}

const now = (() => { let t = 1700000000000; return () => ++t; })();
const api = createCoreApi();
const issuance = createAssetIssuanceWorkflow({ coreApi: api, now });
const lifecycle = createLifecycleController({ now });
const rbac = createRbacService({ now });

rbac.upsertUser('admin'); rbac.assignRole('admin', 'admin', 'system');
rbac.upsertUser('trader1'); rbac.assignRole('trader1', 'trader', 'admin');
rbac.authorize('trader1', 'trading:write', { demo: true });

line('1) Asset issuance (simulated)');
const gold = issuance.issueAsset({
  issuanceId: 'iss-xau',
  assetId: 'aid:xau',
  symbol: 'XAUUSD',
  name: 'Simulated Gold',
  assetClass: 'metal',
  metadata: { unit: 'oz', purity: '9999' },
}, { identity: { aid: 'aid:xau', registryRef: 'local' }, representation: { tokenRef: 'tok-xau', decimals: 18 } });
console.log('issued:', gold.ok, gold.issuance.state, gold.issuance.symbol);
lifecycle.registerEntity('asset:aid:xau', { kind: 'asset', state: 'draft' });
lifecycle.transition('asset:aid:xau', 'active', { actorId: 'admin', reason: 'demo activation' });
console.log('lifecycle active/canTrade:', lifecycle.getEntity('asset:aid:xau').state, lifecycle.canTrade('asset:aid:xau'));

line('2) Pricing feeds (simulated)');
console.log(api.upsertPrice({ assetKey: 'XAUUSD', feed: { price: 235000000000, decimals: 8, isFresh: true, exists: true }, sourceRef: 'mock-oracle', timestamp: now() }));
console.log(api.upsertPrice({ assetKey: 'EURUSD', price: 1.08, sourceRef: 'mock-fx', timestamp: now() }));

line('3) Accounts and deposits');
api.createAccount('alice');
api.createAccount('bob');
api.deposit('alice', 100000, { eventId: 'dep-a', timestamp: now() });
api.deposit('bob', 100000, { eventId: 'dep-b', timestamp: now() });
console.log('alice cash:', api.getPortfolio('alice').cash, 'bob cash:', api.getPortfolio('bob').cash);

line('4) Orders, matching, fills');
api.placeOrder({ id: 's1', instrument: 'XAUUSD', side: 'sell', type: 'limit', price: 2350, quantity: 10, timestamp: now(), accountId: 'bob' });
api.placeOrder({ id: 's2', instrument: 'XAUUSD', side: 'sell', type: 'limit', price: 2360, quantity: 10, timestamp: now(), accountId: 'bob' });
const buy = api.placeOrder({ id: 'b1', instrument: 'XAUUSD', side: 'buy', type: 'limit', price: 2360, quantity: 15, timestamp: now(), accountId: 'alice' });
console.log('buy status:', buy.order.status, 'trades:', buy.trades.map(t => ({ price: t.price, qty: t.quantity })));
for (const tr of buy.trades) {
  api.applyTradeFill({ accountId: 'alice', instrument: 'XAUUSD', side: 'buy', quantity: tr.quantity, price: tr.price, ref: tr.id, eventId: `fa-${tr.id}` });
  api.applyTradeFill({ accountId: 'bob', instrument: 'XAUUSD', side: 'sell', quantity: tr.quantity, price: tr.price, ref: tr.id, eventId: `fb-${tr.id}` });
}

line('5) Mark-to-market and valuation');
api.upsertPrice({ assetKey: 'XAUUSD', price: 2368, timestamp: now() });
const pa = api.getPortfolio('alice');
const pb = api.getPortfolio('bob');
console.log('alice:', { cash: pa.cash, equity: pa.equity, pos: pa.positions[0] });
console.log('bob:', { cash: pb.cash, equity: pb.equity, pos: pb.positions[0] });
const fx = api.value({ assetType: 'fx', spot: 1.08, baseRate: 0.03, quoteRate: 0.05, yearFraction: 1 });
console.log('fx forward:', fx.forward);

line('6) Snapshot summary');
const snap = api.snapshot();
console.log(JSON.stringify({
  assets: Object.keys(snap.indexer.state.assets).length,
  trades: Object.keys(snap.indexer.state.trades).length,
  portfolios: snap.portfolios.accounts.length,
  prices: snap.prices.length,
  indexerProcessed: snap.indexer.processedCount,
}, null, 2));

line('Demo complete (local simulation, zero-cost)');
