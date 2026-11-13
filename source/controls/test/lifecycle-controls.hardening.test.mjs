import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleController } from '../src/lifecycle-controls.mjs';

test('rejects unknown entities and invalid states', () => {
  const lc = new LifecycleController({ now: () => 1 });
  assert.throws(() => lc.transition('missing', 'active'), /unknown entity/);
  lc.registerEntity('e1');
  assert.throws(() => lc.transition('e1', 'bogus'), /invalid state/);
});

test('retired entities cannot trade or resume and circuit breaker reset does not revive retired state', () => {
  const lc = new LifecycleController({ now: () => 1 });
  lc.registerEntity('e1', { state: 'active' });
  lc.tripCircuitBreaker('e1', { autoHalt: true });
  lc.retire('e1');
  lc.resetCircuitBreaker('e1');
  const e = lc.getEntity('e1');
  assert.equal(e.state, 'retired');
  assert.equal(e.circuitBreaker.tripped, false);
  assert.equal(lc.canTrade('e1'), false);
});
