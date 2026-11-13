function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

function clone(x) {
  return structuredClone(x);
}

export class EventIndexer {
  constructor() {
    this.reset();
  }

  reset() {
    this._processed = new Set();
    this._stats = { applied: 0, duplicates: 0, ignored: 0 };
    this._state = {
      assets: {},        // assetId -> asset record
      prices: {},        // assetKey -> latest price record
      orders: {},        // orderId -> order record
      trades: {},        // tradeId -> trade record
      portfolios: {},    // accountId -> { cash, positions: {instrument: qty}, historyCount }
      events: [],        // applied event ids in order
    };
  }

  _ensurePortfolio(accountId) {
    if (!this._state.portfolios[accountId]) {
      this._state.portfolios[accountId] = { accountId, cash: 0, positions: {}, historyCount: 0 };
    }
    return this._state.portfolios[accountId];
  }

  applyEvent(event) {
    assert(isObj(event), 'event must be an object');
    assert(typeof event.id === 'string' && event.id.length > 0, 'event.id must be a non-empty string');
    assert(typeof event.type === 'string' && event.type.length > 0, 'event.type must be a non-empty string');
    const payload = isObj(event.payload) ? event.payload : {};

    if (this._processed.has(event.id)) {
      this._stats.duplicates += 1;
      return { applied: false, duplicate: true, type: event.type };
    }

    let handled = true;
    switch (event.type) {
      case 'AssetRegistered':
      case 'AssetUpserted': {
        const assetId = payload.assetId ?? payload.aid ?? payload.id;
        assert(typeof assetId === 'string' && assetId.length > 0, 'asset event requires payload.assetId/aid/id');
        this._state.assets[assetId] = {
          ...(this._state.assets[assetId] || {}),
          ...clone(payload),
          assetId,
          updatedAt: event.timestamp ?? payload.updatedAt ?? null,
          lifecycleState: payload.lifecycleState ?? this._state.assets[assetId]?.lifecycleState ?? 'draft',
        };
        break;
      }
      case 'AssetStateChanged': {
        const assetId = payload.assetId ?? payload.aid ?? payload.id;
        assert(typeof assetId === 'string' && assetId.length > 0, 'AssetStateChanged requires payload.assetId/aid/id');
        const prev = this._state.assets[assetId] || { assetId };
        this._state.assets[assetId] = {
          ...prev,
          ...clone(payload),
          assetId,
          lifecycleState: payload.lifecycleState ?? prev.lifecycleState ?? null,
          updatedAt: event.timestamp ?? payload.updatedAt ?? null,
        };
        break;
      }
      case 'PriceUpdated': {
        const assetKey = payload.assetKey ?? payload.instrument ?? payload.assetId;
        assert(typeof assetKey === 'string' && assetKey.length > 0, 'PriceUpdated requires payload.assetKey/instrument/assetId');
        this._state.prices[assetKey] = {
          assetKey,
          price: payload.price,
          decimals: payload.decimals ?? null,
          sourceRef: payload.sourceRef ?? null,
          isFresh: payload.isFresh ?? null,
          updatedAt: event.timestamp ?? payload.updatedAt ?? null,
        };
        break;
      }
      case 'OrderPlaced':
      case 'OrderUpdated': {
        const orderId = payload.orderId ?? payload.id;
        assert(typeof orderId === 'string' && orderId.length > 0, 'order event requires payload.orderId/id');
        this._state.orders[orderId] = {
          ...(this._state.orders[orderId] || {}),
          ...clone(payload),
          orderId,
          updatedAt: event.timestamp ?? payload.updatedAt ?? null,
        };
        break;
      }
      case 'OrderCancelled': {
        const orderId = payload.orderId ?? payload.id;
        assert(typeof orderId === 'string' && orderId.length > 0, 'OrderCancelled requires payload.orderId/id');
        const prev = this._state.orders[orderId] || { orderId };
        this._state.orders[orderId] = { ...prev, ...clone(payload), orderId, status: 'cancelled', updatedAt: event.timestamp ?? payload.updatedAt ?? null };
        break;
      }
      case 'TradeExecuted': {
        const tradeId = payload.tradeId ?? payload.id;
        assert(typeof tradeId === 'string' && tradeId.length > 0, 'TradeExecuted requires payload.tradeId/id');
        this._state.trades[tradeId] = { ...clone(payload), tradeId, executedAt: event.timestamp ?? payload.timestamp ?? null };
        break;
      }
      case 'PortfolioDeposit': {
        const accountId = payload.accountId;
        assert(typeof accountId === 'string' && accountId.length > 0, 'PortfolioDeposit requires payload.accountId');
        assert(typeof payload.amount === 'number' && Number.isFinite(payload.amount), 'PortfolioDeposit requires numeric payload.amount');
        const p = this._ensurePortfolio(accountId);
        p.cash = Math.round((p.cash + payload.amount + Number.EPSILON) * 1e12) / 1e12;
        p.historyCount += 1;
        break;
      }
      case 'PortfolioWithdraw': {
        const accountId = payload.accountId;
        assert(typeof accountId === 'string' && accountId.length > 0, 'PortfolioWithdraw requires payload.accountId');
        assert(typeof payload.amount === 'number' && Number.isFinite(payload.amount), 'PortfolioWithdraw requires numeric payload.amount');
        const p = this._ensurePortfolio(accountId);
        p.cash = Math.round((p.cash - payload.amount + Number.EPSILON) * 1e12) / 1e12;
        p.historyCount += 1;
        break;
      }
      case 'PortfolioPositionDelta': {
        const accountId = payload.accountId;
        const instrument = payload.instrument;
        assert(typeof accountId === 'string' && accountId.length > 0, 'PortfolioPositionDelta requires payload.accountId');
        assert(typeof instrument === 'string' && instrument.length > 0, 'PortfolioPositionDelta requires payload.instrument');
        assert(typeof payload.delta === 'number' && Number.isFinite(payload.delta), 'PortfolioPositionDelta requires numeric payload.delta');
        const p = this._ensurePortfolio(accountId);
        p.positions[instrument] = Math.round((((p.positions[instrument] || 0) + payload.delta) + Number.EPSILON) * 1e12) / 1e12;
        if (p.positions[instrument] === 0) delete p.positions[instrument];
        p.historyCount += 1;
        break;
      }
      default:
        handled = false;
        this._stats.ignored += 1;
        break;
    }

    this._processed.add(event.id);
    this._state.events.push(event.id);
    if (handled) this._stats.applied += 1;
    return { applied: handled, duplicate: false, type: event.type };
  }

  applyEvents(events) {
    assert(Array.isArray(events), 'events must be an array');
    return events.map((e) => this.applyEvent(e));
  }

  rebuildFrom(events) {
    this.reset();
    return this.applyEvents(events);
  }

  getState() {
    return {
      stats: { ...this._stats },
      processedCount: this._processed.size,
      state: clone(this._state),
    };
  }

  getSnapshot() {
    return this.getState();
  }
}

export function createEventIndexer() {
  return new EventIndexer();
}
