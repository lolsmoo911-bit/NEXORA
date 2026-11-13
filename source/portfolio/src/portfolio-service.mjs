function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }
function finite(n, name) {
  assert(typeof n === 'number' && Number.isFinite(n), `${name} must be a finite number`);
  return n;
}
function positive(n, name) {
  finite(n, name);
  assert(n > 0, `${name} must be > 0`, RangeError);
  return n;
}
function nonNegative(n, name) {
  finite(n, name);
  assert(n >= 0, `${name} must be >= 0`, RangeError);
  return n;
}

function round(n) {
  // keep deterministic decimal-ish behavior for tests; avoid floating drift accumulation where possible
  return Math.round((n + Number.EPSILON) * 1e12) / 1e12;
}

export class PortfolioService {
  constructor() {
    this._accounts = new Map(); // id -> { id, cash, realizedPnl, positions: Map(instrument -> pos), history: [] }
    this._marks = new Map(); // instrument -> price
  }

  _ensureAccount(accountId) {
    assert(typeof accountId === 'string' && accountId.length > 0, 'accountId must be a non-empty string');
    if (!this._accounts.has(accountId)) {
      this._accounts.set(accountId, {
        id: accountId,
        cash: 0,
        realizedPnl: 0,
        positions: new Map(),
        history: [],
      });
    }
    return this._accounts.get(accountId);
  }

  _pos(account, instrument) {
    if (!account.positions.has(instrument)) {
      account.positions.set(instrument, { instrument, quantity: 0, avgPrice: 0, realizedPnl: 0 });
    }
    return account.positions.get(instrument);
  }

  createAccount(accountId) {
    const acc = this._ensureAccount(accountId);
    return this.getAccountSnapshot(accountId);
  }

  deposit(accountId, amount, meta = {}) {
    const acc = this._ensureAccount(accountId);
    positive(amount, 'amount');
    acc.cash = round(acc.cash + amount);
    acc.history.push({ type: 'deposit', amount, timestamp: meta.timestamp ?? null, ref: meta.ref ?? null });
    return this.getAccountSnapshot(accountId);
  }

  withdraw(accountId, amount, meta = {}) {
    const acc = this._ensureAccount(accountId);
    positive(amount, 'amount');
    assert(acc.cash >= amount, 'insufficient cash', RangeError);
    acc.cash = round(acc.cash - amount);
    acc.history.push({ type: 'withdraw', amount, timestamp: meta.timestamp ?? null, ref: meta.ref ?? null });
    return this.getAccountSnapshot(accountId);
  }

  setMark(instrument, price) {
    assert(typeof instrument === 'string' && instrument.length > 0, 'instrument must be a non-empty string');
    positive(price, 'price');
    this._marks.set(instrument, price);
    return { instrument, price };
  }

  applyFill({ accountId, instrument, side, quantity, price, fee = 0, timestamp = null, ref = null }) {
    const acc = this._ensureAccount(accountId);
    assert(typeof instrument === 'string' && instrument.length > 0, 'instrument must be a non-empty string');
    assert(side === 'buy' || side === 'sell', 'side must be buy or sell', RangeError);
    positive(quantity, 'quantity');
    positive(price, 'price');
    nonNegative(fee, 'fee');

    const pos = this._pos(acc, instrument);
    const notional = quantity * price;

    if (side === 'buy') {
      const cost = notional + fee;
      assert(acc.cash + 1e-12 >= cost, 'insufficient cash for buy', RangeError); // allow tiny float tolerance
      acc.cash = round(acc.cash - cost);

      if (pos.quantity >= 0) {
        const newQty = pos.quantity + quantity;
        const totalCost = pos.avgPrice * pos.quantity + notional;
        pos.quantity = round(newQty);
        pos.avgPrice = newQty === 0 ? 0 : round(totalCost / newQty);
      } else {
        // covering short
        const shortQty = -pos.quantity;
        const coverQty = Math.min(shortQty, quantity);
        const realized = round((pos.avgPrice - price) * coverQty - fee * (coverQty / quantity));
        acc.realizedPnl = round(acc.realizedPnl + realized);
        pos.realizedPnl = round(pos.realizedPnl + realized);
        const remaining = round(quantity - coverQty);
        if (remaining === 0) {
          pos.quantity = round(pos.quantity + quantity); // towards zero
          if (pos.quantity === 0) pos.avgPrice = 0;
        } else if (pos.quantity + quantity > 0) {
          // flipped to long
          pos.quantity = round(pos.quantity + quantity);
          pos.avgPrice = price;
        } else {
          pos.quantity = round(pos.quantity + quantity);
          // avgPrice remains short avg for remaining short
        }
        if (pos.quantity === 0) pos.avgPrice = 0;
      }
    } else { // sell
      const proceeds = notional - fee;
      if (pos.quantity <= 0) {
        // increasing/opening short
        const newShortQty = Math.abs(pos.quantity) + quantity;
        const totalProceedsBasis = pos.avgPrice * Math.abs(pos.quantity) + notional;
        pos.quantity = round(pos.quantity - quantity);
        pos.avgPrice = newShortQty === 0 ? 0 : round(totalProceedsBasis / newShortQty);
      } else {
        // reducing long
        const closeQty = Math.min(pos.quantity, quantity);
        const realized = round((price - pos.avgPrice) * closeQty - fee * (closeQty / quantity));
        acc.realizedPnl = round(acc.realizedPnl + realized);
        pos.realizedPnl = round(pos.realizedPnl + realized);
        if (quantity > pos.quantity) {
          // flipped to short
          const openShortQty = round(quantity - pos.quantity);
          pos.quantity = -openShortQty;
          pos.avgPrice = price;
        } else {
          pos.quantity = round(pos.quantity - quantity);
          if (pos.quantity === 0) pos.avgPrice = 0;
        }
      }
      acc.cash = round(acc.cash + proceeds);
    }

    if (pos.quantity === 0) pos.avgPrice = 0;
    acc.history.push({ type: 'fill', instrument, side, quantity, price, fee, timestamp, ref });
    return this.getAccountSnapshot(accountId);
  }

  getAccountSnapshot(accountId) {
    const acc = this._ensureAccount(accountId);
    let unrealizedPnl = 0;
    let grossExposure = 0;
    let netMarketValue = 0;
    let hasAllMarks = true;
    const positions = [];
    for (const pos of acc.positions.values()) {
      if (pos.quantity === 0) continue;
      const mark = this._marks.get(pos.instrument) ?? null;
      let upnl = null;
      let marketValue = null;
      if (mark != null) {
        upnl = round((mark - pos.avgPrice) * pos.quantity);
        marketValue = round(mark * pos.quantity);
        grossExposure = round(grossExposure + Math.abs(marketValue));
        netMarketValue = round(netMarketValue + marketValue);
        unrealizedPnl = round(unrealizedPnl + upnl);
      } else {
        hasAllMarks = false;
      }
      positions.push({
        instrument: pos.instrument,
        quantity: pos.quantity,
        avgPrice: pos.avgPrice,
        markPrice: mark,
        marketValue,
        unrealizedPnl: upnl,
        realizedPnl: pos.realizedPnl,
      });
    }
    positions.sort((a, b) => a.instrument.localeCompare(b.instrument));
    const equity = round(acc.cash + netMarketValue);
    return {
      accountId: acc.id,
      cash: acc.cash,
      realizedPnl: acc.realizedPnl,
      unrealizedPnl,
      equity,
      equityIsFullyMarked: hasAllMarks,
      grossExposure,
      positions,
      historyCount: acc.history.length,
    };
  }

  getStateSnapshot() {
    const accounts = [...this._accounts.keys()].sort().map(id => {
      const s = this.getAccountSnapshot(id);
      const acc = this._accounts.get(id);
      return { ...s, history: acc.history.map(e => ({ ...e })) };
    });
    const marks = [...this._marks.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([instrument, price]) => ({ instrument, price }));
    return { accounts, marks };
  }
}

export function createPortfolioService() {
  return new PortfolioService();
}
