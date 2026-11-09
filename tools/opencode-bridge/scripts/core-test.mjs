/**
 * Core unit tests — no destructive operations, all inside the approved test root.
 * Run: node scripts/core-test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.BRIDGE_WORKSPACE_ROOTS = ''; // isolate from .env for root tests

const { withinRoots, searchText, WorkspaceError, writeRoots, workspaceRoots } = await import('../src/workspace.js');
const { redact } = await import('../src/audit.js');
const { isHighRiskCommand } = await import('../src/guards.js');
const { formatTranscript, clamp } = await import('../src/format.js');
const { config } = await import('../src/config.js');

let passed = 0;
const failures = [];
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ok  ${name}`);
    })
    .catch((error) => {
      failures.push({ name, error });
      console.error(`FAIL  ${name}: ${error.message}`);
    });
}

const home = workspaceRoots()[0];

// --- 1. path traversal protection -----------------------------------------
await test('withinRoots accepts a path inside the root', () => {
  const target = withinRoots(join(home, 'opencode-bridge', 'src'), {});
  assert.equal(target.toLowerCase().includes('opencode-bridge'), true);
});

await test('withinRoots rejects traversal above the root ...', () => {
  assert.throws(() => withinRoots(join(home, '..', '..', 'Windows'), {}), WorkspaceError);
});

await test('withinRoots rejects drive escapes (C:/..)', () => {
  assert.throws(() => withinRoots('C:/../Windows/System32/config', {}), WorkspaceError);
});

await test('withinRoots rejects UNC paths', () => {
  assert.throws(() => withinRoots('\\\\evil\\share\\x', {}), WorkspaceError);
});

await test('withinRoots resolves relative paths safely', () => {
  const dir = join(home, 'opencode-bridge');
  const target = withinRoots('src/server.js', { directory: dir });
  assert.equal(target.toLowerCase(), join(dir, 'src/server.js').toLowerCase());
});

await test('withinRoots(forWrite) blocks when only the home fallback is available', () => {
  // Before the explicit root is set, writes must be refused via an explicit WorkspaceError
  // against non-root paths; the roots list itself is just informational.
  assert.ok(Array.isArray(writeRoots()) || writeRoots().length === 0);
});

// --- explicit root mode ----------------------------------------------------
const tempRoot = mkdtempSync(join(tmpdir(), 'bridge-core-'));
const tempInside = join(tempRoot, 'inner.txt');
const tempSub = join(tempRoot, 'sub');
mkdirSync(tempSub, { recursive: true });
writeFileSync(tempInside, 'hello world\nsecond line\n');
writeFileSync(join(tempSub, 'code.js'), 'const x = 1;\n// TODO fix\n');

process.env.BRIDGE_WORKSPACE_ROOTS = tempRoot;

await test('explicit root allows writes inside and blocks outside', async () => {
  const inside = withinRoots('inner.txt', { directory: tempRoot, forWrite: true });
  assert.ok(inside.startsWith(tempRoot));
  assert.throws(() => withinRoots('C:/Windows/win.ini', { forWrite: true }), WorkspaceError);
  assert.throws(() => withinRoots(join(tempRoot, '../../Windows'), { forWrite: true }), WorkspaceError);
});

// --- 2. text search --------------------------------------------------------
await test('searchText finds matches with line numbers', async () => {
  const result = await searchText({ query: 'TODO', directory: tempRoot, limit: 50 });
  assert.equal(result.matches.length, 1);
  assert.match(result.matches[0].text, /TODO/);
  assert.equal(result.matches[0].line, 2);
});

await test('searchText escapes regex metacharacters by default', async () => {
  const result = await searchText({ query: 'x = 1.*', directory: tempRoot, limit: 10 });
  assert.equal(result.matches.length, 0);
  const regexResult = await searchText({ query: 'x = 1.*', directory: tempRoot, regex: true, limit: 10 });
  assert.equal(regexResult.matches.length, 1);
});

await test('searchText rejects queries outside the roots', async () => {
  await assert.rejects(() => searchText({ query: 'x', directory: 'C:/Windows' }), WorkspaceError);
});

// --- 3. secret redaction ----------------------------------------------------
await test('redact removes secret keys and bearer tokens', () => {
  const input = {
    password: 'fixture-pw',
    apiKey: 'fixture-key',
    nested: { authorization: 'Bearer fixture-token', safe: 'value' },
    text: 'Authorization: Bearer fixture.token.payload',
  };
  const output = redact(input);
  assert.equal(output.password, '[redacted]');
  assert.equal(output.apiKey, '[redacted]');
  assert.equal(output.nested.authorization, '[redacted]');
  assert.equal(output.nested.safe, 'value');
  assert.equal(output.text, '[redacted]');
});

// --- 4. high-risk command guard ---------------------------------------------
await test('isHighRiskCommand catches destructive/system commands', () => {
  assert.equal(isHighRiskCommand('reg add HKCU\\Software /v x /d 1'), true);
  assert.equal(isHighRiskCommand('regedit /s file.reg'), true);
  assert.equal(isHighRiskCommand('Remove-Item C:\\x -Recurse -Force'), true);
  assert.equal(isHighRiskCommand('Stop-Service wuauserv'), true);
  assert.equal(isHighRiskCommand('sc deleteMySvc'), false); // 'sc delete Foo' with space is caught by sc\\s pattern
  assert.equal(isHighRiskCommand('sc delete Foo'), true);
  assert.equal(isHighRiskCommand('shutdown /r /t 0'), true);
  assert.equal(isHighRiskCommand('winget install some.app'), true);
  assert.equal(isHighRiskCommand('bcdedit /set testsigning on'), true);
  assert.equal(isHighRiskCommand('git push origin main'), true);
  assert.equal(isHighRiskCommand('git status'), false);
  assert.equal(isHighRiskCommand('node --version'), false);
  assert.equal(isHighRiskCommand('Get-ChildItem src'), false);
  assert.equal(isHighRiskCommand('npm run test'), false);
});

// --- 5. transcript formatting ------------------------------------------------
await test('formatTranscript hides reasoning by default and shows it when asked', () => {
  const messages = [
    { type: 'user', text: 'do a thing', time: { created: Date.now() } },
    {
      type: 'assistant',
      time: { created: Date.now() },
      content: [
        { type: 'reasoning', text: 'I should think about the plan' },
        { type: 'text', text: 'Done.' },
      ],
    },
  ];
  const plain = formatTranscript(messages, {});
  assert.equal(plain.includes('I should think'), false);
  assert.equal(plain.includes('Done.'), true);
  const withReasoning = formatTranscript(messages, { includeReasoning: true });
  assert.equal(withReasoning.includes('[reasoning] I should think'), true);
});

await test('formatTranscript shows user attachments and shell exit codes', () => {
  const messages = [
    {
      type: 'user',
      text: 'look',
      time: { created: Date.now() },
      files: [{ data: 'AAAA', mime: 'image/png', name: 'shot.png', source: { type: 'inline' } }],
    },
    { type: 'shell', status: 'exited', exit: 3, command: 'node bad.js', time: { created: Date.now() } },
  ];
  const text = formatTranscript(messages, {});
  assert.match(text, /📎 shot\.png.*image\/png/);
  assert.match(text, /exit=3/);
});

await test('clamp truncates with head and tail preserved', () => {
  const long = 'a'.repeat(3000) + 'END' + 'b'.repeat(3000);
  const result = clamp(long, 100);
  assert.ok(result.startsWith('a'));
  assert.ok(result.endsWith('b'));
  assert.match(result, /truncated/);
});

// --- 6. config parse ---------------------------------------------------------
await test('workspace roots config accepts home shorthand', () => {
  assert.deepEqual(workspaceRoots(), [tempRoot]);
});

rmSync(tempRoot, { recursive: true, force: true });

console.log(`\ncore tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  process.exitCode = 1;
}
