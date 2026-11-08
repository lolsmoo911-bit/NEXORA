/**
 * NEXORA bridge — MUTATION PROOF for the task-execution regression suite.
 *
 * A regression test that has never been shown to fail is not evidence of anything. This
 * script re-introduces the exact historical defect (`noReply: true`, which makes the
 * OpenCode server persist the user message and return WITHOUT running the model), re-runs
 * the regression suite, and requires it to FAIL.
 *
 * If the suite passes against the broken client, this script exits non-zero and CI fails.
 * That is the point: it converts "the tests pass" into "the tests would catch this".
 *
 * The source file is always restored, including on error.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'src', 'opencode-client.mjs');
const suitePath = path.join(here, 'task-execution-regression.test.mjs');

const original = fs.readFileSync(clientPath, 'utf8');

// The exact line the submit body builds, and the exact defect that used to sit above it.
const needle = '      messageID: messageId,';
if (!original.includes(needle)) {
  console.error('MUTATION PROOF ERROR: the submit body marker was not found in opencode-client.mjs.');
  console.error('This script must be updated alongside the client, otherwise it proves nothing.');
  process.exit(1);
}

const mutated = original.replace(needle, '      noReply: true,\n' + needle);
fs.writeFileSync(clientPath, mutated);

let exitCode = 1;
try {
  const res = spawnSync(process.execPath, ['--test', suitePath], { encoding: 'utf8', cwd: path.join(here, '..') });
  const output = (res.stdout || '') + (res.stderr || '');
  const summary = output.split('\n').filter((l) => /^not ok|^# (tests|pass|fail)/.test(l));
  console.log('--- regression suite against a deliberately broken client ---');
  console.log(summary.join('\n'));
  console.log('--- end ---');

  if (res.status === 0) {
    console.error('MUTATION PROOF FAILED: the regression suite PASSED against a client that sends noReply:true.');
    console.error('The suite does not actually detect the defect it claims to guard.');
  } else {
    console.log('MUTATION PROOF OK: with noReply:true re-introduced the suite fails, so the regression has teeth.');
    exitCode = 0;
  }
} finally {
  fs.writeFileSync(clientPath, original);
  const restored = fs.readFileSync(clientPath, 'utf8');
  if (restored !== original) console.error('MUTATION PROOF ERROR: the client was not restored.');
}
process.exit(exitCode);