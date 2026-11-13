function assert(condition, message, Err = TypeError) {
  if (!condition) throw new Err(message);
}

function isFinitePositive(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function cloneOrder(o) {
  return { ...o };
}

function cloneTrade(t) {
  return { ...t };
}

export class MatchingEngine {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._seq = 0;
    this._orders = new Map(); // id -> order
    this._books = new Map(); // instrument -> { bids: [orderIds], asks: [orderIds] }
    this._trades = [];
  }

  _nextSeq() {
    this._seq += 1;
    return this._seq;
  }

  _ts(ts) {
    if (ts == null) return this._now();
    assert(Number.isFinite(ts), 'timestamp must be finite');
    return ts;
  }

  _getBook(instrument) {
    if (!this._books.has(instrument)) {
      this._books.set(instrument, { bids: [], asks: [] });
    }
    return this._books.get(instrument);
  }

  _insertResting(order) {
    const book = this._getBook(order.instrument);
    if (order.side === 'buy') {
      book.bids.push(order.id);
      book.bids.sort((aId, bId) => {
        const a = this._orders.get(aId);
        const b = this._orders.get(bId);
        if (b.price !== a.price) return b.price - a.price; // higher price first
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp; // earlier first
        return a.seq - b.seq;
      });
    } else {
      book.asks.push(order.id);
      book.asks.sort((aId, bId) => {
        const a = this._orders.get(aId);
        const b = this._orders.get(bId);
        if (a.price !== b.price) return a.price - b.price; // lower price first
        if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp; // earlier first
        return a.seq - b.seq;
      });
    }
  }

  _removeResting(order) {
    const book = this._books.get(order.instrument);
    if (!book) return;
    const arr = order.side === 'buy' ? book.bids : book.asks;
    const idx = arr.indexOf(order.id);
    if (idx >= 0) arr.splice(idx, 1);
  }

  _canMatch(incoming, resting) {
    if (incoming.side === 'buy') return incoming.price >= resting.price;
    return incoming.price <= resting.price;
  }

  placeOrder(input) {
    assert(input && typeof input === 'object' && !Array.isArray(input), 'order must be an object');
    const { id, side, type = 'limit', price, quantity, instrument, accountId = null, timestamp } = input;
    assert(typeof id === 'string' && id.length > 0, 'id must be a non-empty string');
    assert(!this._orders.has(id), `duplicate order id: ${id}`, RangeError);
    assert(side === 'buy' || side === 'sell', 'side must be buy or sell', RangeError);
    assert(type === 'limit', 'only limit orders are supported in this phase', RangeError);
    assert(typeof instrument === 'string' && instrument.length > 0, 'instrument must be a non-empty string');
    assert(isFinitePositive(price), 'price must be a positive finite number', RangeError);
    assert(isFinitePositive(quantity), 'quantity must be a positive finite number', RangeError);

    const order = {
      id,
      side,
      type,
      price,
      quantity,
      remaining: quantity,
      status: 'open',
      instrument,
      accountId,
      timestamp: this._ts(timestamp),
      seq: this._nextSeq(),
    };
    this._orders.set(id, order);

    const book = this._getBook(instrument);
    const oppositeSide = side === 'buy' ? 'asks' : 'bids';
    const trades = [];

    while (order.remaining > 0) {
      const oppositeIds = book[oppositeSide];
      if (oppositeIds.length === 0) break;
      const restingId = oppositeIds[0];
      const resting = this._orders.get(restingId);
      if (!resting || (resting.status !== 'open' && resting.status !== 'partially_filled') || resting.remaining <= 0) {
        oppositeIds.shift();
        continue;
      }
      if (!this._canMatch(order, resting)) break;

      const fillQty = Math.min(order.remaining, resting.remaining);
      const tradePrice = resting.price; // maker price
      order.remaining -= fillQty;
      resting.remaining -= fillQty;

      const trade = {
        id: `trade-${this._trades.length + 1}`,
        instrument,
        buyOrderId: side === 'buy' ? order.id : resting.id,
        sellOrderId: side === 'sell' ? order.id : resting.id,
        price: tradePrice,
        quantity: fillQty,
        timestamp: this._ts(),
        takerOrderId: order.id,
        makerOrderId: resting.id,
        seq: this._nextSeq(),
      };
      this._trades.push(trade);
      trades.push(cloneTrade(trade));

      if (resting.remaining === 0) {
        resting.status = 'filled';
        this._removeResting(resting);
      } else {
        resting.status = 'partially_filled';
      }
    }

    if (order.remaining === 0) {
      order.status = 'filled';
    } else if (order.remaining < order.quantity) {
      order.status = 'partially_filled';
      this._insertResting(order);
    } else {
      order.status = 'open';
      this._insertResting(order);
    }

    return { order: cloneOrder(order), trades };
  }

  cancelOrder(orderId) {
    assert(typeof orderId === 'string' && orderId.length > 0, 'orderId must be a non-empty string');
    const order = this._orders.get(orderId);
    assert(order, `unknown order id: ${orderId}`, RangeError);
    if (order.status === 'filled' || order.status === 'cancelled' || order.status === 'rejected') {
      throw new RangeError(`cannot cancel order in status: ${order.status}`);
    }
    this._removeResting(order);
    order.status = 'cancelled';
    return cloneOrder(order);
  }

  getOrder(orderId) {
    const o = this._orders.get(orderId);
    return o ? cloneOrder(o) : null;
  }

  getTrades(instrument) {
    const trades = instrument ? this._trades.filter(t => t.instrument === instrument) : this._trades;
    return trades.map(cloneTrade);
  }

  getBook(instrument, { depth = 50 } = {}) {
    assert(typeof instrument === 'string' && instrument.length > 0, 'instrument must be a non-empty string');
    const book = this._getBook(instrument);
    const mapSide = (ids) => ids.slice(0, depth).map(id => {
      const o = this._orders.get(id);
      return { orderId: o.id, price: o.price, remaining: o.remaining, timestamp: o.timestamp, seq: o.seq };
    });
    return {
      instrument,
      bids: mapSide(book.bids),
      asks: mapSide(book.asks),
    };
  }
}

export function createMatchingEngine(options) {
  return new MatchingEngine(options);
}
