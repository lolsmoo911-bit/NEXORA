import { createMatchingEngine } from '../../exchange/src/matching-engine.mjs';
import { createPortfolioService } from '../../portfolio/src/portfolio-service.mjs';
import { createEventIndexer } from '../../indexer/src/event-indexer.mjs';
import { normalizeOracleFeed, priceAsset } from '../../market/src/pricing-service.mjs';

function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

export function createCoreApi() {
  const exchange = createMatchingEngine();
  const portfolios = createPortfolioService();
  const indexer = createEventIndexer();
  const prices = new Map(); // instrument/assetKey -> { value, feedMeta, updatedAt }

  function emit(event) {
    // best-effort indexing for local API state; callers can also apply custom events
    try { indexer.applyEvent(event); } catch { /* keep API usable even if event shape is unexpected */ }
    return event;
  }

  return {
    // --- Assets (read model via indexer + direct convenience) ---
    registerAsset(asset) {
      assert(isObj(asset), 'asset must be an object');
      const assetId = asset.assetId ?? asset.aid ?? asset.id;
      assert(typeof assetId === 'string' && assetId.length > 0, 'asset.assetId/aid/id is required');
      const event = {
        id: asset.eventId ?? `asset:${assetId}:${asset.updatedAt ?? Date.now()}`,
        type: 'AssetRegistered',
        timestamp: asset.updatedAt ?? Date.now(),
        payload: { ...asset, assetId },
      };
      indexer.applyEvent(event);
      return { asset: indexer.getSnapshot().state.assets[assetId] };
    },
    getAsset(assetId) {
      const s = indexer.getSnapshot().state;
      return s.assets[assetId] ?? null;
    },
    listAssets() {
      const assets = indexer.getSnapshot().state.assets;
      return Object.values(assets).sort((a, b) => String(a.assetId).localeCompare(String(b.assetId)));
    },

    // --- Pricing ---
    upsertPrice({ assetKey, price, decimals = 0, sourceRef = null, isFresh = true, feed = null, timestamp = Date.now() }) {
      assert(typeof assetKey === 'string' && assetKey.length > 0, 'assetKey is required');
      let value = price;
      let feedMeta = null;
      if (feed) {
        feedMeta = normalizeOracleFeed(feed, { requireExists: true, requireFresh: false });
        value = feedMeta.value;
      }
      assert(typeof value === 'number' && Number.isFinite(value) && value > 0, 'price must be a positive finite number', RangeError);
      const rec = { assetKey, value, decimals, sourceRef, isFresh, timestamp, feedMeta };
      prices.set(assetKey, rec);
      portfolios.setMark(assetKey, value);
      indexer.applyEvent({ id: `price:${assetKey}:${timestamp}`, type: 'PriceUpdated', timestamp, payload: { assetKey, price: value, decimals, sourceRef, isFresh } });
      return rec;
    },
    getPrice(assetKey) {
      return prices.get(assetKey) ?? null;
    },
    value(request) {
      // If caller passes oracle spot feeds, pricing-service handles normalization
      return priceAsset(request);
    },

    // --- Portfolio ---
    createAccount(accountId) {
      return portfolios.createAccount(accountId);
    },
    deposit(accountId, amount, meta = {}) {
      const snap = portfolios.deposit(accountId, amount, meta);
      indexer.applyEvent({ id: meta.eventId ?? `dep:${accountId}:${meta.timestamp ?? Date.now()}:${amount}`, type: 'PortfolioDeposit', timestamp: meta.timestamp ?? Date.now(), payload: { accountId, amount } });
      return snap;
    },
    withdraw(accountId, amount, meta = {}) {
      const snap = portfolios.withdraw(accountId, amount, meta);
      indexer.applyEvent({ id: meta.eventId ?? `wd:${accountId}:${meta.timestamp ?? Date.now()}:${amount}`, type: 'PortfolioWithdraw', timestamp: meta.timestamp ?? Date.now(), payload: { accountId, amount } });
      return snap;
    },
    getPortfolio(accountId) {
      return portfolios.getAccountSnapshot(accountId);
    },
    applyTradeFill(fill) {
      const snap = portfolios.applyFill(fill);
      const { accountId, instrument, side, quantity } = fill;
      const delta = side === 'buy' ? quantity : -quantity;
      indexer.applyEvent({ id: fill.eventId ?? `fill:${accountId}:${fill.ref ?? Date.now()}:${side}:${quantity}`, type: 'PortfolioPositionDelta', timestamp: fill.timestamp ?? Date.now(), payload: { accountId, instrument, delta } });
      return snap;
    },

    // --- Trading ---
    placeOrder(order) {
      const result = exchange.placeOrder(order);
      indexer.applyEvent({ id: `order:${result.order.id}:${result.order.status}:${Date.now()}`, type: 'OrderPlaced', timestamp: result.order.timestamp, payload: { ...result.order, orderId: result.order.id } });
      for (const t of result.trades) {
        indexer.applyEvent({ id: `trade:${t.id}`, type: 'TradeExecuted', timestamp: t.timestamp, payload: { ...t, tradeId: t.id } });
      }
      return result;
    },
    cancelOrder(orderId) {
      const order = exchange.cancelOrder(orderId);
      indexer.applyEvent({ id: `cancel:${orderId}:${Date.now()}`, type: 'OrderCancelled', timestamp: Date.now(), payload: { orderId } });
      return order;
    },
    getOrder(orderId) {
      return exchange.getOrder(orderId);
    },
    getOrderBook(instrument, opts) {
      return exchange.getBook(instrument, opts);
    },
    getTrades(instrument) {
      return exchange.getTrades(instrument);
    },

    // --- Indexer / snapshots ---
    snapshot() {
      return {
        indexer: indexer.getSnapshot(),
        portfolios: portfolios.getStateSnapshot(),
        prices: [...prices.values()].sort((a, b) => a.assetKey.localeCompare(b.assetKey)),
      };
    },
    applyEvent(event) {
      return indexer.applyEvent(event);
    },

    // exposed internals for advanced/local testing
    _services: { exchange, portfolios, indexer },
  };
}
