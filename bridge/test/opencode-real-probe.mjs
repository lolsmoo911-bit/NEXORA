/**
 * NEXORA bridge — LEVEL 4: does a REAL OpenCode model actually run?
 *
 * This is the only test in the repository that can support the claim "a real OpenCode
 * model executed the task and produced an assistant reply". It is therefore also the only
 * one that can REFUTE that claim, which is why it fails loudly rather than skipping.
 *
 * WHAT IT DOES (non-destructive by construction)
 *   1. GET  /global/health                    — is a real server there at all?
 *   2. POST /session                          — creates a THROWAWAY session, never the
 *                                               reviewer's real session
 *   3. POST /session/:tmp/message             — no `noReply`, so the documented server
 *                                               behaviour is "send and wait for response"
 *   4. asserts the reply is role=assistant and contains the exact sentinel
 *   5. DELETE /session/:tmp                   — removes the session and all its data
 *
 * WHAT IT DOES NOT DO
 *   - touch any pre-existing session, so a developer's real work is never at risk;
 *   - write, edit or delete any file (the prompt asks the model not to, and the probe
 *     only inspects the message endpoint, never the filesystem);
 *   - claim anything when no real server is configured: it exits 2 and says NOT RUN.
 *
 * REPRODUCE (on a host with a real OpenCode; the bridge is never pointed at a real
 * session by this script):
 *
 *   opencode serve --port 4096 &
 *   PROBE_BASE_URL=http://127.0.0.1:4096 \
 *   PROBE_PASSWORD="$OPENCODE_SERVER_PASSWORD" \
 *     node bridge/test/opencode-real-probe.mjs
 *
 * Exit codes: 0 = a real model ran and answered; 1 = a real server exists but the model
 * did not answer as required (that is a real failure); 2 = NOT RUN, no real server.
 */

import { config } from '../src/config.mjs';
import {
  opencodeHealth, opencodeCreateSession, opencodeDeleteSession,
  opencodeSubmitTask, opencodeTaskOutcome
} from '../src/opencode-client.mjs';

const SENTINEL = 'NEXORA_BRIDGE_PROBE_OK';

const checks = [];
function record(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

// ---- configure the client from the probe environment -------------------------------
const baseUrl = (process.env.PROBE_BASE_URL || '').replace(/\/+$/, '');
const password = process.env.PROBE_PASSWORD || '';
if (!baseUrl) {
  console.log('NOT RUN: PROBE_BASE_URL is not set, so there is no real OpenCode server to test.');
  console.log('Reproduce with:');
  console.log('  opencode serve --port 4096 &');
  console.log('  PROBE_BASE_URL=http://127.0.0.1:4096 node bridge/test/opencode-real-probe.mjs');
  process.exit(2);
}
config.opencode.baseUrl = baseUrl;
config.opencode.password = password;
config.opencode.sessionId = '';          // never target a caller's real session
config.limits.maxModelWaitMs = Number(process.env.PROBE_WAIT_MS || 300000);

function label() {
  try { const u = new URL(baseUrl); return u.protocol + '//' + u.host; } catch { return 'invalid-url'; }
}

// ---- 1. is there a real server? ----------------------------------------------------
const health = await opencodeHealth();
if (!health.reachable || !health.healthy) {
  console.log(`NOT RUN: ${label()} did not answer as a healthy OpenCode server.`);
  console.log('  ' + JSON.stringify(health).slice(0, 200));
  console.log('Reproduce with:');
  console.log('  opencode serve --port 4096 &');
  console.log(`  PROBE_BASE_URL=${baseUrl} node bridge/test/opencode-real-probe.mjs`);
  process.exit(2);
}
console.log(`Level 4: probing the REAL OpenCode model at ${label()} (version ${health.version})\n`);
record('a real OpenCode server is reachable and healthy', true, 'version=' + health.version);

// ---- 2. a throwaway session --------------------------------------------------------
let tmp = null;
try {
  tmp = await opencodeCreateSession('nexora-bridge-level4-probe-' + SENTINEL);
  record('a throwaway probe session was created', Boolean(tmp.id), 'sessionId=' + tmp.id);

  // ---- 3+4. run the model and require a real assistant reply ------------------------
  const prompt =
    `Reply with exactly this text and nothing else: ${SENTINEL}. ` +
    'Do not read, create, edit or delete any file. Do not run any tool.';

  let outcome = null;
  try {
    // Target the throwaway session explicitly. Never let session auto-resolution pick a
    // real one: the probe must be incapable of writing into a developer's work.
    outcome = await opencodeSubmitTask(prompt, { sessionId: tmp.id });
    record('POST /session/:id/message returned an assistant message (model ran)',
      outcome.modelRan === true && Boolean(outcome.assistantMessageId),
      'assistantMessageId=' + outcome.assistantMessageId + ' in ' + outcome.elapsedMs + 'ms');

    record('the assistant reply contains the exact sentinel ' + SENTINEL,
      String(outcome.assistantText || '').includes(SENTINEL),
      'reply=' + JSON.stringify(String(outcome.assistantText || '').slice(0, 120)));

    const status = await opencodeTaskOutcome(tmp.id);
    record('task state is reported as completed', status.state === 'completed', 'state=' + status.state);
  } catch (err) {
    // A real server that stores the task but never answers is a REAL failure, not a skip.
    record('the model produced an assistant reply', false, err.code + ': ' + err.message.slice(0, 200));
  }
} finally {
  // ---- 5. clean up -----------------------------------------------------------------
  if (tmp?.id) {
    try {
      const d = await opencodeDeleteSession(tmp.id);
      record('the throwaway probe session was deleted', d.deleted === true, 'sessionId=' + tmp.id);
    } catch (err) {
      record('the throwaway probe session was deleted', false, err.message.slice(0, 160));
    }
  }
}

const failed = checks.filter((c) => !c.ok);
console.log(`\nLevel 4: ${failed.length === 0 ? 'A REAL MODEL RAN' : 'FAILED'} ` +
  `(${checks.length - failed.length}/${checks.length} checks passed)`);
if (failed.length === 0) {
  console.log('This is evidence for level (c): a real OpenCode model executed the task and replied.');
  console.log('It is still NOT evidence for level (d): no ChatGPT call has been made.');
}
process.exit(failed.length === 0 ? 0 : 1);