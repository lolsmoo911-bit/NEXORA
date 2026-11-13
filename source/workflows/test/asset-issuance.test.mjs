import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetIssuanceWorkflow, metadataTemplate } from '../src/asset-issuance.mjs';
import { createCoreApi } from '../../api/src/core-api.mjs';

test('metadata templates exist for supported classes', () => {
  const bond = metadataTemplate('bond');
  assert.equal(bond.assetClass, 'bond');
  assert.equal(bond.dayCountConvention, 'ACT/365F');
  assert.throws(() => metadataTemplate('unknown'), /unsupported assetClass/);
});

test('issues asset from draft to active and registers in core API', () => {
  let t = 1000;
  const api = createCoreApi();
  const wf = new AssetIssuanceWorkflow({ coreApi: api, now: () => ++t });
  const res = wf.issueAsset({
    issuanceId: 'iss-1',
    assetId: 'aid:xau',
    symbol: 'XAU',
    name: 'Simulated Gold',
    assetClass: 'metal',
    metadata: { unit: 'oz', purity: '9999' },
  }, { identity: { aid: 'aid:xau', registryRef: 'local-registry' }, representation: { tokenRef: 'token-xau', decimals: 18 } });

  assert.equal(res.ok, true);
  assert.equal(res.issuance.state, 'active');
  assert.equal(res.issuance.validation.ok, true);
  assert.equal(res.issuance.steps.length, 5);
  const asset = api.getAsset('aid:xau');
  assert.ok(asset);
  assert.equal(asset.symbol, 'XAU');
  assert.equal(asset.lifecycleState, 'active');
});

test('validation failure rejects issuance and prevents activation', () => {
  let t = 1;
  const wf = new AssetIssuanceWorkflow({ now: () => ++t });
  const draft = wf.createDraft({ issuanceId: 'iss-bad', assetId: 'aid:bad', symbol: '***', name: 'Bad Asset', assetClass: 'custom' });
  wf.registerIdentity(draft.issuanceId, { aid: 'aid:bad' });
  wf.linkRepresentation(draft.issuanceId, { tokenRef: 'tok-bad' });
  const v = wf.validate(draft.issuanceId);
  assert.equal(v.validation.ok, false);
  assert.equal(v.state, 'rejected');
  assert.throws(() => wf.activate(draft.issuanceId), /invalid state for activate/);
});
