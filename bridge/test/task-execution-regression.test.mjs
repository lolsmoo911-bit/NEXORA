/**
 * NEXORA bridge — REGRESSION: a task must not be reported as done unless the model ran.
 *
 * The defect this file exists to prevent
 * ---------------------------------------
 * An earlier version submitted tasks with `noReply: true`. The OpenCode server documents
 * that endpoint as "Send a message and wait for response", so `noReply: true` persists the
 * user message and returns WITHOUT running the model. The bridge then reported success,
 * so a caller could not tell "the model answered" from "the text was saved". Green CI
 * against a fake server did not catch it, because the fake was written to agree with the
 * bridge instead of with the server.
 *
 * Every test below therefore uses a fake that behaves the way a REAL server would:
 *   - faithful mode: stores the user message, runs the model, returns an assistant message;
 *   - noReply-echo mode: stores the user message and returns the USER message back, which
 *     is what a server told "do not reply" does;
 *   - persist-only mode: stores the user message, never replies, session goes idle.
 * A success must be reported for the first and denied for the other two.
 *
 * These tests use a FAKE OpenCode server. They prove the bridge's decision logic. They do
 * NOT prove that a real model ran; that is `test/opencode-real-probe.mjs` (Level 4), which
 * has never been executed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config } from '../src/config.mjs';
import { opencodeSubmitTask, opencodeTaskOutcome, BridgeError } from '../src/opencode-client.mjs';

/**
 * A fake OpenCode server whose behaviour is chosen explicitly.
 * mode: 'faithful' | 'noReply-echo' | 'persist-only'
 */
function startFake(mode) {
  const seen = [];
  const store = new Map();          // sessionId -> message[]
  let counter = 0;

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    seen.push({ method: req.method, url: req.url, body });

    const send = (code, obj) => {
      if (obj === null) { res.writeHead(code); res.end(); return; }
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/session/s1/status') return send(200, { s1: { state: 'idle' } });

    if (req.method === 'GET' && req.url === '/session/s1/message') {
      return send(200, store.get('s1') || []);
    }

    if (req.method === 'POST' && req.url === '/session/s1/message') {
      counter++;
      const id = body?.messageID || ('msg_auto_' + counter);
      const userMsg = {
        info: { id, role: 'user', time: { created: '2026-10-11T00:00:0' + (counter % 10) + 'Z' } },
        parts: body?.parts || []
      };
      const list = store.get('s1') || [];
      list.push(userMsg);
      store.set('s1', list);

      // What a real server does when told not to reply: keep the message, run nothing.
      if (body?.noReply === true) {
        return send(200, { info: userMsg.info, parts: userMsg.parts });
      }
      if (mode === 'persist-only') {
        return send(200, { info: userMsg.info, parts: userMsg.parts });
      }
      if (mode === 'noReply-echo') {
        // A server that echoes the stored user message instead of an assistant reply.
        return send(200, { info: userMsg.info, parts: userMsg.parts });
      }

      // faithful: the model ran and produced an answer, parented to the task message.
      const assistantId = 'msg_assistant_' + counter;
      list.push({
        info: { id: assistantId, role: 'assistant', parentID: id, time: { created: '2026-10-11T00:00:1' + (counter % 10) + 'Z' } },
        parts: [{ type: 'text', text: 'The model ran and answered: branch is main.' }]
      });
      store.set('s1', list);
      return send(200, {
        info: { id: assistantId, role: 'assistant', parentID: id },
        parts: [{ type: 'text', text: 'The model ran and answered: branch is main.' }]
      });
    }

    return send(404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen, store }));
  });
}

async function withFake(mode, fn) {
  const fake = await startFake(mode);
  const saved = { baseUrl: config.opencode.baseUrl, sessionId: config.opencode.sessionId };
  config.opencode.baseUrl = 'http://127.0.0.1:' + fake.port;
  config.opencode.sessionId = 's1';
  try {
    return await fn(fake);
  } finally {
    config.opencode.baseUrl = saved.baseUrl;
    config.opencode.sessionId = saved.sessionId;
    fake.server.close();
  }
}

// ---------------------------------------------------------------- the regression

test('REGRESSION: noReply:true is never sent, because it suppresses the model run', async () => {
  await withFake('faithful', async (fake) => {
    const out = await opencodeSubmitTask('Report the branch name.');
    assert.equal(out.modelRan, true);
    const call = fake.seen.find((r) => r.method === 'POST' && r.url === '/session/s1/message');
    assert.ok(call, 'expected a POST to /session/s1/message');
    assert.equal(
      'noReply' in call.body, false,
      'noReply must not be present: the OpenCode server documents POST /session/:id/message as ' +
      '"send a message and wait for response", so noReply:true would persist the user message ' +
      'and return without ever running the model'
    );
  });
});

test('REGRESSION: a server that only persists the user message is reported as a FAILURE', async () => {
  await withFake('persist-only', async () => {
    await assert.rejects(
      () => opencodeSubmitTask('Report the branch name.'),
      (err) => {
        assert.ok(err instanceof BridgeError);
        assert.equal(err.code, 'no_assistant_reply');
        // The message must say plainly that this is a failure, not a slow success.
        assert.match(err.message, /did not run/i);
        return true;
      }
    );
  });
});

test('REGRESSION: an echoed user message is NOT accepted as the model answering', async () => {
  await withFake('noReply-echo', async () => {
    await assert.rejects(
      () => opencodeSubmitTask('Report the branch name.'),
      (err) => {
        assert.equal(err.code, 'no_assistant_reply');
        assert.match(err.message, /role=user/);
        return true;
      }
    );
  });
});

test('REGRESSION: success is only reported when an assistant reply exists', async () => {
  await withFake('faithful', async () => {
    const out = await opencodeSubmitTask('Report the branch name.');
    assert.equal(out.modelRan, true);
    assert.ok(out.taskMessageId, 'the bridge must supply its own task message id');
    assert.ok(out.assistantMessageId, 'success requires an assistant message id');
    assert.match(out.assistantText, /model ran and answered/);
  });
});

// ---------------------------------------------------------------- state reporting

test('a persisted-but-unanswered task is reported as persisted_not_run, not as done', async () => {
  await withFake('persist-only', async () => {
    await assert.rejects(() => opencodeSubmitTask('Report the branch name.'));
    const outcome = await opencodeTaskOutcome('s1');
    assert.equal(outcome.state, 'persisted_not_run');
    assert.equal(outcome.assistantMessageId, null);
    assert.match(outcome.note, /not treat this as a completed task/i);
  });
});

test('a task whose model answered is reported as completed, with the reply', async () => {
  await withFake('faithful', async () => {
    await opencodeSubmitTask('Report the branch name.');
    const outcome = await opencodeTaskOutcome('s1');
    assert.equal(outcome.state, 'completed');
    assert.ok(outcome.assistantMessageId);
    assert.match(outcome.assistantText, /model ran and answered/);
  });
});

test('task state correlates to the task message id, not to the last message in the room', async () => {
  await withFake('faithful', async () => {
    const first = await opencodeSubmitTask('First task.');
    // A later, unrelated user message with no reply must not be read as the first task done.
    const later = await opencodeTaskOutcome('s1');
    assert.equal(later.taskMessageId, first.taskMessageId);
    assert.equal(later.state, 'completed');
  });
});