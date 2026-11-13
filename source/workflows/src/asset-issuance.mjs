function assert(cond, msg, Err = TypeError) { if (!cond) throw new Err(msg); }
function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

const ALLOWED_CLASSES = new Set(['fiat', 'metal', 'energy', 'equity', 'bond', 'fund', 'crypto', 'custom']);
const STATES = ['draft', 'identity_registered', 'representation_linked', 'validated', 'active', 'rejected'];

export function metadataTemplate(assetClass) {
  assert(ALLOWED_CLASSES.has(assetClass), `unsupported assetClass: ${assetClass}`, RangeError);
  const base = { schemaVersion: 1, assetClass, provenance: { sourceType: 'simulated' } };
  switch (assetClass) {
    case 'bond': return { ...base, currency: 'USD', couponRate: null, maturityDate: null, dayCountConvention: 'ACT/365F' };
    case 'fiat': return { ...base, currency: null, peg: null };
    case 'metal': return { ...base, unit: 'oz', purity: null };
    case 'energy': return { ...base, unit: 'bbl', benchmark: null };
    case 'equity': return { ...base, country: null, venue: null, issuer: null };
    case 'fund': return { ...base, navCurrency: 'USD', strategy: null };
    case 'crypto': return { ...base, network: null };
    default: return { ...base };
  }
}

export class AssetIssuanceWorkflow {
  constructor({ coreApi = null, rbac = null, now = () => Date.now() } = {}) {
    this.coreApi = coreApi;
    this.rbac = rbac;
    this._now = now;
    this._records = new Map(); // issuanceId -> record
  }

  _ts() { return this._now(); }
  _id(prefix = 'iss') { return `${prefix}-${this._ts()}-${Math.random().toString(16).slice(2, 8)}`; }

  _requirePermission(actorId, permission, context) {
    if (!this.rbac) return;
    this.rbac.authorize(actorId, permission, context, { actorId, audit: true });
  }

  createDraft(input, { actorId = 'system' } = {}) {
    assert(isObj(input), 'input must be an object');
    const { issuanceId = this._id('iss'), assetId, symbol, name, assetClass, metadata = {} } = input;
    assert(!this._records.has(issuanceId), 'issuanceId already exists', RangeError);
    assert(typeof assetId === 'string' && assetId.length > 0, 'assetId is required');
    assert(typeof symbol === 'string' && symbol.length > 0, 'symbol is required');
    assert(typeof name === 'string' && name.length > 0, 'name is required');
    assert(ALLOWED_CLASSES.has(assetClass), `unsupported assetClass: ${assetClass}`, RangeError);
    this._requirePermission(actorId, 'assets:write', { action: 'createDraft', issuanceId, assetId });

    const record = {
      issuanceId,
      assetId,
      symbol,
      name,
      assetClass,
      state: 'draft',
      identity: null,
      representation: null,
      metadata: { ...metadataTemplate(assetClass), ...metadata, assetClass },
      validation: null,
      steps: [],
      createdAt: this._ts(),
      updatedAt: this._ts(),
    };
    this._pushStep(record, 'createDraft', 'ok', { actorId });
    this._records.set(issuanceId, record);
    return structuredClone(record);
  }

  registerIdentity(issuanceId, identity = {}, { actorId = 'system' } = {}) {
    const record = this._mustGet(issuanceId);
    assert(record.state === 'draft', `invalid state for registerIdentity: ${record.state}`, RangeError);
    this._requirePermission(actorId, 'assets:write', { action: 'registerIdentity', issuanceId });
    const aid = identity.aid ?? identity.assetId ?? record.assetId;
    assert(typeof aid === 'string' && aid.length > 0, 'identity.aid/assetId is required');
    record.identity = { aid, registryRef: identity.registryRef ?? null, registeredAt: this._ts(), proofRef: identity.proofRef ?? null };
    record.state = 'identity_registered';
    this._pushStep(record, 'registerIdentity', 'ok', { actorId, aid });
    return structuredClone(record);
  }

  linkRepresentation(issuanceId, representation = {}, { actorId = 'system' } = {}) {
    const record = this._mustGet(issuanceId);
    assert(record.state === 'identity_registered', `invalid state for linkRepresentation: ${record.state}`, RangeError);
    this._requirePermission(actorId, 'assets:write', { action: 'linkRepresentation', issuanceId });
    const tokenRef = representation.tokenRef ?? representation.contractAddress ?? representation.symbol ?? record.symbol;
    assert(typeof tokenRef === 'string' && tokenRef.length > 0, 'representation tokenRef/contractAddress/symbol is required');
    record.representation = {
      tokenRef,
      standard: representation.standard ?? 'sim-fungible',
      decimals: representation.decimals ?? 18,
      linkedAt: this._ts(),
      metadataURI: representation.metadataURI ?? null,
    };
    record.state = 'representation_linked';
    this._pushStep(record, 'linkRepresentation', 'ok', { actorId, tokenRef });
    return structuredClone(record);
  }

  validate(issuanceId, { actorId = 'system' } = {}) {
    const record = this._mustGet(issuanceId);
    assert(record.state === 'representation_linked' || record.state === 'validated', `invalid state for validate: ${record.state}`, RangeError);
    this._requirePermission(actorId, 'assets:read', { action: 'validate', issuanceId });
    const checks = [];
    checks.push({ name: 'has_identity', ok: !!record.identity?.aid });
    checks.push({ name: 'has_representation', ok: !!record.representation?.tokenRef });
    checks.push({ name: 'symbol_format', ok: /^[A-Z0-9._-]{2,32}$/i.test(record.symbol) });
    checks.push({ name: 'asset_class_allowed', ok: ALLOWED_CLASSES.has(record.assetClass) });
    checks.push({ name: 'metadata_present', ok: isObj(record.metadata) });
    const ok = checks.every(c => c.ok);
    record.validation = { ok, checks, validatedAt: this._ts() };
    record.state = ok ? 'validated' : 'rejected';
    this._pushStep(record, 'validate', ok ? 'ok' : 'failed', { actorId, checks });
    return structuredClone(record);
  }

  activate(issuanceId, { actorId = 'system' } = {}) {
    const record = this._mustGet(issuanceId);
    assert(record.state === 'validated', `invalid state for activate: ${record.state}`, RangeError);
    this._requirePermission(actorId, 'assets:write', { action: 'activate', issuanceId });
    record.state = 'active';
    record.activatedAt = this._ts();
    record.lifecycleState = 'active';
    this._pushStep(record, 'activate', 'ok', { actorId });

    if (this.coreApi) {
      this.coreApi.registerAsset({
        assetId: record.assetId,
        aid: record.identity?.aid ?? record.assetId,
        symbol: record.symbol,
        name: record.name,
        assetClass: record.assetClass,
        lifecycleState: 'active',
        metadata: record.metadata,
        representation: record.representation,
        eventId: `issuance-active:${record.issuanceId}`,
        updatedAt: record.activatedAt,
      });
    }
    return structuredClone(record);
  }

  issueAsset(input, { actorId = 'system', identity = {}, representation = {} } = {}) {
    const draft = this.createDraft(input, { actorId });
    const id = draft.issuanceId;
    this.registerIdentity(id, identity, { actorId });
    this.linkRepresentation(id, representation, { actorId });
    const validation = this.validate(id, { actorId });
    if (!validation.validation.ok) {
      return { ok: false, issuance: validation };
    }
    const active = this.activate(id, { actorId });
    return { ok: true, issuance: active };
  }

  get(issuanceId) {
    const r = this._records.get(issuanceId);
    return r ? structuredClone(r) : null;
  }

  list() {
    return [...this._records.values()].map(r => structuredClone(r)).sort((a, b) => a.issuanceId.localeCompare(b.issuanceId));
  }

  _mustGet(issuanceId) {
    const r = this._records.get(issuanceId);
    assert(r, `unknown issuanceId: ${issuanceId}`, RangeError);
    return r;
  }

  _pushStep(record, step, status, details = {}) {
    record.steps.push({ step, status, timestamp: this._ts(), ...details });
    record.updatedAt = this._ts();
  }
}

export function createAssetIssuanceWorkflow(options) {
  return new AssetIssuanceWorkflow(options);
}
