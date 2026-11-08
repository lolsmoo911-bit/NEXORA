import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyManagedProxyEnvironment,
  createProxyManager,
  parseProxyEnvironment,
  restoreManagedProxyEnvironment,
  WARP_PROXY_URL,
} from '../src/proxy-manager.js';

const baseXml = [
  '<service>',
  '  <id>OpenCodeAgent</id>',
  '  <env name="USERPROFILE" value="C:\\Users\\Administrator"/>',
  '  <env name="HOME" value="C:\\Users\\Administrator"/>',
  '  <startmode>Automatic</startmode>',
  '</service>',
  '',
].join('\r\n');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok ' + name);
  } catch (error) {
    console.error('FAIL ' + name + ': ' + error.message);
    throw error;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok ' + name);
  } catch (error) {
    console.error('FAIL ' + name + ': ' + error.message);
    throw error;
  }
}

test('apply adds exactly three proxy variables', () => {
  const update = applyManagedProxyEnvironment(baseXml);
  const env = parseProxyEnvironment(update.xml);
  assert.equal(update.changed, true);
  assert.equal(env.get('HTTP_PROXY')[0].value, WARP_PROXY_URL);
  assert.equal(env.get('HTTPS_PROXY')[0].value, WARP_PROXY_URL);
  assert.equal(env.get('NO_PROXY')[0].value, 'localhost,127.0.0.1,::1');
  assert.match(update.xml, /name="USERPROFILE"/);
  assert.match(update.xml, /name="HOME"/);
});

test('apply is idempotent for managed values', () => {
  const first = applyManagedProxyEnvironment(baseXml);
  const second = applyManagedProxyEnvironment(first.xml);
  assert.equal(second.changed, false);
  assert.equal(second.xml, first.xml);
});

test('conflicting values are rejected and never overwritten', () => {
  const conflict = baseXml.replace(
    '</service>',
    '  <env name="HTTP_PROXY" value="http://untrusted.example:8888"/>\r\n</service>',
  );
  assert.throws(() => applyManagedProxyEnvironment(conflict), /refusing to overwrite/i);
  assert.match(conflict, /untrusted\.example/);
});

test('duplicate managed entries are rejected', () => {
  const duplicate = baseXml.replace('</service>',
    '  <env name="NO_PROXY" value="localhost"/>\r\n  <env name="NO_PROXY" value="127.0.0.1"/>\r\n</service>');
  assert.throws(() => applyManagedProxyEnvironment(duplicate), /Duplicate NO_PROXY/);
});

test('restore exactly recovers original XML and unrelated variables', () => {
  const update = applyManagedProxyEnvironment(baseXml);
  const restored = restoreManagedProxyEnvironment(update.xml, update.originalEntries);
  assert.equal(restored, baseXml);
});

test('restore refuses values changed by another actor', () => {
  const update = applyManagedProxyEnvironment(baseXml);
  const changed = update.xml.replace(WARP_PROXY_URL, 'http://other-proxy:8080');
  assert.throws(() => restoreManagedProxyEnvironment(changed, update.originalEntries), /not Bridge-owned/);
});

test('pre-existing identical entries survive enable/disable cycle', () => {
  const preexisting = baseXml.replace('</service>',
    '  <env name="HTTP_PROXY" value="' + WARP_PROXY_URL + '"/>\r\n</service>');
  const update = applyManagedProxyEnvironment(preexisting);
  const restored = restoreManagedProxyEnvironment(update.xml, update.originalEntries);
  const env = parseProxyEnvironment(restored);
  assert.equal(env.get('HTTP_PROXY').length, 1);
  assert.equal(env.get('HTTP_PROXY')[0].value, WARP_PROXY_URL);
  assert.match(restored, /name="USERPROFILE"/);
  assert.match(restored, /name="HOME"/);
});

const root = mkdtempSync(join(tmpdir(), 'warp-bridge-test-'));
try {
  mkdirSync(join(root, 'service'), { recursive: true });
  writeFileSync(join(root, 'service', 'OpenCodeAgent.xml'), baseXml, 'utf8');

  await testAsync('status reports missing WARP endpoint without claiming availability', async () => {
    let probeCalls = 0;
    const manager = createProxyManager({
      root,
      detectWarp: () => false,
      checkPort: async () => false,
      probeHttps: () => { probeCalls += 1; return true; },
    });
    const s = await manager.status();
    assert.equal(s.warpInstalled, false);
    assert.equal(s.portOpen, false);
    assert.equal(s.httpsVerified, false);
    assert.equal(probeCalls, 0);
    assert.equal(s.enabledForOpenCode, false);
  });

  await testAsync('enable refuses when WARP is unavailable and leaves XML untouched', async () => {
    const manager = createProxyManager({
      root, detectWarp: () => false, checkPort: async () => false, probeHttps: () => false,
    });
    await assert.rejects(manager.enable(), /not installed/);
    assert.equal(readFileSync(join(root, 'service', 'OpenCodeAgent.xml'), 'utf8'), baseXml);
    assert.equal(existsSync(join(root, '.service', 'proxy-state.json')), false);
  });

  await testAsync('enable writes only service XML after fully verified endpoint; disable restores it', async () => {
    const manager = createProxyManager({
      root, detectWarp: () => true, checkPort: async () => true, probeHttps: () => true,
    });
    const result = await manager.enable();
    assert.equal(result.enabled, true);
    assert.equal(result.restartRequired, true);
    assert.equal(result.message.includes('restart OpenCodeAgent explicitly'), true);
    const current = readFileSync(join(root, 'service', 'OpenCodeAgent.xml'), 'utf8');
    assert.equal(parseProxyEnvironment(current).size, 3);
    assert.match(current, /name="USERPROFILE"/);
    assert.match(current, /name="HOME"/);
    const state = await manager.status();
    assert.equal(state.managedByBridge, true);
    assert.equal(state.enabledForOpenCode, true);
    const again = await manager.enable();
    assert.equal(again.alreadyEnabled, true);
    const disabled = await manager.disable();
    assert.equal(disabled.disabled, true);
    assert.equal(readFileSync(join(root, 'service', 'OpenCodeAgent.xml'), 'utf8'), baseXml);
    assert.equal((await manager.disable()).alreadyDisabled, true);
  });

  await testAsync('disable refuses to remove settings changed outside the Bridge', async () => {
    const manager = createProxyManager({
      root, detectWarp: () => true, checkPort: async () => true, probeHttps: () => true,
    });
    await manager.enable();
    const file = join(root, 'service', 'OpenCodeAgent.xml');
    const modified = readFileSync(file, 'utf8').replace('localhost,127.0.0.1,::1', 'localhost');
    writeFileSync(file, modified, 'utf8');
    await assert.rejects(manager.disable(), /changed after Bridge enable/);
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('\nproxy manager tests: ' + passed + ' passed');
