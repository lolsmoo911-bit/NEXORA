import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleController } from '../src/lifecycle-controls.mjs';

test('registers entity and allows valid transitions', () => {
  let t = 1;
  const lc = new LifecycleController({ now: () => t++ });
  lc.registerEntity('asset:xau', { kind: 'asset', state: 'draft' });
  lc.transition('asset:xau', 'active', { actorId: 'admin', reason: 'validated' });
  lc.halt('asset:xau', { actorId: 'ops', reason: 'volatility' });
  const e = lc.resume('asset:xau', { actorId: 'ops', reason: 'stabilized' });
  assert.equal(e.state, 'active');
  assert.ok(e.history.length >= 4);
  assert.equal(lc.canTrade('asset:xau'), true);
});

test('rejects invalid transitions and retired is terminal', () => {
  const lc = new LifecycleController({ now: () => 1 });
  lc.registerEntity('a1');
  assert.equal(lc.canTransition('a1', 'halted'), false);
  assert.throws(() => lc.halt('a1'), /invalid transition/);
  lc.transition('a1', 'active');
  lc.retire('a1');
  assert.throws(() => lc.resume('a1'), /invalid transition/);
  assert.equal(lc.canMutate('a1'), false);
  assert.equal(lc.canTrade('a1'), false);
});

test('circuit breaker trips and can auto-halt active entity', () => {
  const lc = new LifecycleController({ now: () => 1 });
  lc.registerEntity('m1', { kind: 'market', state: 'active' });
  const e = lc.tripCircuitBreaker('m1', { actorId: 'risk', reason: 'price move', threshold: 0.1 });
  assert.equal(e.circuitBreaker.tripped, true);
  assert.equal(e.state, 'halted');
  assert.equal(lc.canTrade('m1'), false);
  lc.resetCircuitBreaker('m1', { actorId: 'risk' });
  assert.equal(lc.getEntity('m1').circuitBreaker.tripped, false);
});
