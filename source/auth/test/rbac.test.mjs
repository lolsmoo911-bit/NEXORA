import test from 'node:test';
import assert from 'node:assert/strict';
import { RbacService } from '../src/rbac.mjs';

test('assigns roles and checks permissions', () => {
  let t = 100;
  const rbac = new RbacService({ now: () => t++ });
  rbac.upsertUser('u1');
  rbac.assignRole('u1', 'trader', 'admin1');
  assert.equal(rbac.can('u1', 'trading:write'), true);
  assert.equal(rbac.can('u1', 'assets:write'), false);
  assert.deepEqual(rbac.getUser('u1').roles, ['trader']);
});

test('authorize allows/denies and writes audit log', () => {
  let t = 1;
  const rbac = new RbacService({ now: () => t++ });
  rbac.upsertUser('u1');
  rbac.assignRole('u1', 'viewer', 'admin1');
  assert.equal(rbac.authorize('u1', 'prices:read', { resource: 'XAUUSD' }), true);
  assert.throws(() => rbac.authorize('u1', 'trading:write', { orderId: 'o1' }), /permission denied/);
  const log = rbac.getAuditLog();
  assert.ok(log.some(e => e.action === 'authorize' && e.permission === 'prices:read' && e.allowed === true));
  assert.ok(log.some(e => e.action === 'authorize' && e.permission === 'trading:write' && e.allowed === false));
});

test('admin wildcard and inactive users', () => {
  const rbac = new RbacService({ now: () => 1 });
  rbac.upsertUser('admin');
  rbac.assignRole('admin', 'admin');
  assert.equal(rbac.can('admin', 'anything:here'), true);
  rbac.setUserActive('admin', false);
  assert.equal(rbac.can('admin', 'anything:here'), false);
});

test('role management validation and audit records', () => {
  const rbac = new RbacService({ now: () => 1 });
  rbac.upsertUser('u1');
  assert.throws(() => rbac.assignRole('u1', 'nope'), /unknown role/);
  rbac.assignRole('u1', 'operator');
  assert.throws(() => rbac.revokeRole('u1', 'trader'), /does not have role/);
  rbac.revokeRole('u1', 'operator');
  const roleEvents = rbac.getAuditLog({ action: 'assign_role' }).concat(rbac.getAuditLog({ action: 'revoke_role' }));
  assert.equal(roleEvents.length, 2);
});
