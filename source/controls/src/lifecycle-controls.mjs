function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }

const STATES = new Set(['draft', 'active', 'halted', 'suspended', 'retired']);
const ALLOWED = {
  draft: new Set(['active', 'retired']),
  active: new Set(['halted', 'suspended', 'retired']),
  halted: new Set(['active', 'suspended', 'retired']),
  suspended: new Set(['active', 'retired']),
  retired: new Set([]),
};

export class LifecycleController {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    this._entities = new Map(); // id -> entity
  }

  _ts() { return this._now(); }

  registerEntity(entityId, { kind = 'asset', state = 'draft', metadata = {} } = {}) {
    assert(typeof entityId === 'string' && entityId.length > 0, 'entityId must be a non-empty string');
    assert(!this._entities.has(entityId), 'entity already exists', RangeError);
    assert(STATES.has(state), `invalid state: ${state}`, RangeError);
    const entity = {
      entityId,
      kind,
      state,
      metadata: { ...metadata },
      circuitBreaker: { tripped: false, reason: null, trippedAt: null, threshold: null },
      history: [{ action: 'register', from: null, to: state, actorId: 'system', reason: 'initial', timestamp: this._ts() }],
      createdAt: this._ts(),
      updatedAt: this._ts(),
    };
    this._entities.set(entityId, entity);
    return this.getEntity(entityId);
  }

  getEntity(entityId) {
    const e = this._entities.get(entityId);
    if (!e) return null;
    return structuredClone(e);
  }

  canTransition(entityId, toState) {
    const e = this._entities.get(entityId);
    if (!e) return false;
    if (!STATES.has(toState)) return false;
    if (e.state === toState) return true;
    return ALLOWED[e.state].has(toState);
  }

  transition(entityId, toState, { actorId = 'system', reason = null } = {}) {
    const e = this._entities.get(entityId);
    assert(e, `unknown entity: ${entityId}`, RangeError);
    assert(STATES.has(toState), `invalid state: ${toState}`, RangeError);
    if (e.state === toState) return this.getEntity(entityId);
    assert(ALLOWED[e.state].has(toState), `invalid transition: ${e.state} -> ${toState}`, RangeError);
    const from = e.state;
    e.state = toState;
    e.updatedAt = this._ts();
    e.history.push({ action: 'transition', from, to: toState, actorId, reason, timestamp: e.updatedAt });
    return this.getEntity(entityId);
  }

  halt(entityId, opts = {}) { return this.transition(entityId, 'halted', opts); }
  suspend(entityId, opts = {}) { return this.transition(entityId, 'suspended', opts); }
  resume(entityId, opts = {}) { return this.transition(entityId, 'active', opts); }
  retire(entityId, opts = {}) { return this.transition(entityId, 'retired', opts); }

  tripCircuitBreaker(entityId, { actorId = 'system', reason = 'threshold breached', threshold = null, autoHalt = true } = {}) {
    const e = this._entities.get(entityId);
    assert(e, `unknown entity: ${entityId}`, RangeError);
    e.circuitBreaker = { tripped: true, reason, trippedAt: this._ts(), threshold };
    e.updatedAt = this._ts();
    e.history.push({ action: 'circuit_breaker_trip', from: e.state, to: e.state, actorId, reason, threshold, timestamp: e.updatedAt });
    if (autoHalt && e.state === 'active') {
      this.halt(entityId, { actorId, reason: `auto-halt: ${reason}` });
    }
    return this.getEntity(entityId);
  }

  resetCircuitBreaker(entityId, { actorId = 'system', reason = 'manual reset' } = {}) {
    const e = this._entities.get(entityId);
    assert(e, `unknown entity: ${entityId}`, RangeError);
    e.circuitBreaker = { tripped: false, reason: null, trippedAt: null, threshold: null };
    e.updatedAt = this._ts();
    e.history.push({ action: 'circuit_breaker_reset', from: e.state, to: e.state, actorId, reason, timestamp: e.updatedAt });
    return this.getEntity(entityId);
  }

  canTrade(entityId) {
    const e = this._entities.get(entityId);
    if (!e) return false;
    return e.state === 'active' && !e.circuitBreaker.tripped;
  }

  canMutate(entityId) {
    const e = this._entities.get(entityId);
    if (!e) return false;
    return e.state !== 'retired';
  }

  listEntities() {
    return [...this._entities.values()].map(e => structuredClone(e)).sort((a,b)=>a.entityId.localeCompare(b.entityId));
  }
}

export function createLifecycleController(options) {
  return new LifecycleController(options);
}
