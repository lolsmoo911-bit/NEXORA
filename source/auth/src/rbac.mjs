function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }

export const DEFAULT_ROLE_PERMISSIONS = {
  admin: new Set(['*']),
  operator: new Set(['assets:read','assets:write','prices:read','prices:write','trading:read','trading:write','portfolio:read','portfolio:write','markets:control','audit:read']),
  trader: new Set(['assets:read','prices:read','trading:read','trading:write','portfolio:read','portfolio:write']),
  viewer: new Set(['assets:read','prices:read','trading:read','portfolio:read']),
  auditor: new Set(['assets:read','prices:read','trading:read','portfolio:read','audit:read']),
};

function cloneSetLike(v) {
  if (v instanceof Set) return [...v];
  if (Array.isArray(v)) return [...v];
  return [];
}

export class RbacService {
  constructor({ rolePermissions = DEFAULT_ROLE_PERMISSIONS, now = () => Date.now() } = {}) {
    this._now = now;
    this._users = new Map(); // userId -> { id, roles: Set, active }
    this._rolePermissions = new Map();
    for (const [role, perms] of Object.entries(rolePermissions)) {
      this._rolePermissions.set(role, new Set(cloneSetLike(perms)));
    }
    this._auditLog = [];
  }

  _ts() { return this._now(); }

  upsertUser(userId, { active = true } = {}) {
    assert(typeof userId === 'string' && userId.length > 0, 'userId must be a non-empty string');
    if (!this._users.has(userId)) {
      this._users.set(userId, { id: userId, roles: new Set(), active: Boolean(active) });
    } else {
      this._users.get(userId).active = Boolean(active);
    }
    return this.getUser(userId);
  }

  getUser(userId) {
    const u = this._users.get(userId);
    if (!u) return null;
    return { id: u.id, active: u.active, roles: [...u.roles].sort() };
  }

  setUserActive(userId, active) {
    const u = this._users.get(userId);
    assert(u, 'unknown user', RangeError);
    u.active = Boolean(active);
    return this.getUser(userId);
  }

  assignRole(userId, role, actorId = 'system') {
    assert(typeof role === 'string' && role.length > 0, 'role must be a non-empty string');
    assert(this._rolePermissions.has(role), `unknown role: ${role}`, RangeError);
    const u = this._users.get(userId) || this.upsertUser(userId);
    this._users.get(userId).roles.add(role);
    this._audit(actorId, 'assign_role', 'roles:manage', true, { userId, role });
    return this.getUser(userId);
  }

  revokeRole(userId, role, actorId = 'system') {
    const u = this._users.get(userId);
    assert(u, 'unknown user', RangeError);
    assert(u.roles.has(role), `user does not have role: ${role}`, RangeError);
    u.roles.delete(role);
    this._audit(actorId, 'revoke_role', 'roles:manage', true, { userId, role });
    return this.getUser(userId);
  }

  listRoles() {
    return [...this._rolePermissions.entries()].map(([role, perms]) => ({ role, permissions: [...perms].sort() })).sort((a,b)=>a.role.localeCompare(b.role));
  }

  permissionsForUser(userId) {
    const u = this._users.get(userId);
    if (!u || !u.active) return new Set();
    const perms = new Set();
    for (const role of u.roles) {
      const rp = this._rolePermissions.get(role);
      if (!rp) continue;
      for (const p of rp) perms.add(p);
    }
    return perms;
  }

  can(userId, permission) {
    assert(typeof permission === 'string' && permission.length > 0, 'permission must be a non-empty string');
    const perms = this.permissionsForUser(userId);
    return perms.has('*') || perms.has(permission);
  }

  authorize(userId, permission, context = {}, { actorId = userId, audit = true } = {}) {
    const allowed = this.can(userId, permission);
    if (audit) this._audit(actorId ?? userId ?? 'unknown', 'authorize', permission, allowed, { userId, ...context });
    if (!allowed) {
      const err = new Error(`permission denied: ${permission}`);
      err.code = 'PERMISSION_DENIED';
      throw err;
    }
    return true;
  }

  _audit(actorId, action, permission, allowed, context = {}) {
    this._auditLog.push({
      timestamp: this._ts(),
      actorId: actorId ?? null,
      action,
      permission,
      allowed: Boolean(allowed),
      context,
    });
  }

  getAuditLog({ actorId, action, allowed } = {}) {
    return this._auditLog.filter(e =>
      (actorId == null || e.actorId === actorId) &&
      (action == null || e.action === action) &&
      (allowed == null || e.allowed === allowed)
    ).map(e => ({ ...e, context: { ...e.context } }));
  }
}

export function createRbacService(options) {
  return new RbacService(options);
}
