import test from 'node:test';
import assert from 'node:assert/strict';
import { AssetIssuanceWorkflow } from '../src/asset-issuance.mjs';

test('rejects invalid issuance inputs and state skipping', () => {
  const wf = new AssetIssuanceWorkflow({ now: () => 1 });
  assert.throws(() => wf.createDraft({ issuanceId: 'i1', assetId: 'a1', symbol: 'A', name: 'A', assetClass: 'nope' }), /unsupported assetClass/);
  const d = wf.createDraft({ issuanceId: 'i2', assetId: 'a2', symbol: 'AA', name: 'Asset', assetClass: 'custom' });
  assert.throws(() => wf.linkRepresentation(d.issuanceId, { tokenRef: 't' }), /invalid state for linkRepresentation/);
});

test('cannot activate without passing validation', () => {
  const wf = new AssetIssuanceWorkflow({ now: () => 1 });
  const d = wf.createDraft({ issuanceId: 'i3', assetId: 'a3', symbol: '***', name: 'Bad', assetClass: 'custom' });
  wf.registerIdentity(d.issuanceId, { aid: 'a3' });
  wf.linkRepresentation(d.issuanceId, { tokenRef: 't3' });
  const v = wf.validate(d.issuanceId);
  assert.equal(v.validation.ok, false);
  assert.throws(() => wf.activate(d.issuanceId), /invalid state for activate/);
});
