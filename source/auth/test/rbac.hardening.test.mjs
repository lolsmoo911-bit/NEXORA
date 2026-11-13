import test from 'node:test';
import assert from 'node:assert/strict';
import { RbacService } from '../src/rbac.mjs';

test('unknown users and empty permissions are denied', () => {
  const rbac = new RbacService({ now: () => 1 });
  assert.equal(rbac.can('ghost', 'assets:read'), false);
  assert.throws(() => rbac.authorize('ghost', 'assets:read'), /permission denied/);
});

test('inactive users lose all permissions even if roles assigned', () => {
  const rbac = new RbacService({ now: () => 1 });
  rbac.upsertUser('u1');
  rbac.assignRole('u1', 'admin');
  rbac.setUserActive('u1', false);
  assert.equal(rbac.can('u1', 'trading:write'), false);
  assert.throws(() => rbac.authorize('u1', 'trading:write'), /permission denied/);
});
