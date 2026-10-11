/**
 * NEXORA bridge — OpenCode API contract test.
 *
 * This is a CONTRACT test, not an integration test against a running agent. It pins the
 * exact request shapes the bridge sends to the paths documented in
 *   https://docs.opencode.ai/docs/server/
 * so that a future change to the client that breaks the documented contract fails here
 * instead of silently failing against a real agent later.
 *
 * It starts a fake OpenCode server that records what it received and answers with the
 * documented response shapes, then asserts the bridge's requests match the documentation:
 *   - GET  /global/health            -> { healthy, version }
 *   - GET  /session                  -> Session[]
 *   - GET  /session/:id/message      -> { info, parts }[]
 *   - POST /session/:id/message      body { noReply, parts:[{type:'text',text}] } -> { info, parts }
 *   - POST /session/:id/abort        -> boolean
 *
 * WHAT THIS DOES NOT PROVE: that a real, currently-installed OpenCode binary accepts these
 * requests. That requires a running opencode server, which the agent sandbox cannot host.
 * The remaining step is listed in docs/bridge-runbook.md.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config } from '../src/config.mjs';
import {
  opencodeHealth, opencodeListSessions, opencodeResolveSession,
  opencodeSubmitTask, opencodeGetMessages, opencodeCancelTask
} from '../src/opencode-client.mjs';

function startFakeOpencode() {
  const seen = [];
  const store = new Map();
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
    seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null });

    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (req.method === 'GET' && req.url === '/global/health') return send(200, { healthy: true, version: 'test-fake' });
    if (req.method === 'GET' && req.url === '/session') {
      return send(200, [
        { id: 'ses_a', title: 'older', updated: '2026-01-01T00:00:00Z' },
        { id: 'ses_b', title: 'newest', updated: '2026-02-01T00:00:00Z' }
      ]);
    }
    if (req.method === 'GET' && req.url === '/session/ses_b/message') {
      return send(200, store.get('ses_b') || []);
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/message$/.test(req.url)) {
      // Documented behaviour: without noReply the server runs the model and returns the
      // assistant message. A fake that echoed the user message would hide a real defect.
      const sid = req.url.split('/')[2];
      const list = store.get(sid) || [];
      const userId = body?.messageID || ('msg_user_' + (list.length + 1));
      list.push({
        info: { id: userId, role: 'user', time: { created: '2026-02-01T00:00:00Z' } },
        parts: body?.parts ?? []
      });
      store.set(sid, list);
      if (body?.noReply === true) {
        return send(200, { info: list[list.length - 1].info, parts: list[list.length - 1].parts });
      }
      const assistantId = 'msg_a' + (list.length);
      const parts = [{ type: 'text', text: 'The model ran and answered.' }];
      list.push({
        info: { id: assistantId, role: 'assistant', parentID: userId, time: { created: '2026-02-01T00:00:02Z' } },
        parts
      });
      store.set(sid, list);
      return send(200, { info: list[list.length - 1].info, parts });
    }
    if (req.method === 'POST' && /^\/session\/[^/]+\/abort$/.test(req.url)) return send(200, true);
    return send(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

async function withFake(fn) {
  const fake = await startFakeOpencode();
  const saved = {
    baseUrl: config.opencode.baseUrl,
    password: config.opencode.password,
    sessionId: config.opencode.sessionId,
    allowCancel: config.allowCancel
  };
  config.opencode.baseUrl = `http://127.0.0.1:${fake.port}`;
  config.opencode.password = '';
  config.opencode.sessionId = '';
  config.allowCancel = true;
  try {
    return await fn(fake);
  } finally {
    Object.assign(config.opencode, { baseUrl: saved.baseUrl, password: saved.password, sessionId: saved.sessionId });
    config.allowCancel = saved.allowCancel;
    fake.server.close();
  }
}

test('contract: health reads the documented { healthy, version } shape', async () => {
  await withFake(async () => {
    const h = await opencodeHealth();
    assert.equal(h.reachable, true);
    assert.equal(h.healthy, true);
    assert.equal(h.version, 'test-fake');
  });
});

test('contract: session listing maps the documented Session[] shape', async () => {
  await withFake(async (fake) => {
    const sessions = await opencodeListSessions();
    assert.deepEqual(sessions.map((s) => s.id).sort(), ['ses_a', 'ses_b']);
    assert.equal(fake.seen.some((r) => r.url === '/session' && r.method === 'GET'), true);
  });
});

test('contract: the newest session is chosen when none is configured', async () => {
  await withFake(async () => {
    const id = await opencodeResolveSession();
    assert.equal(id, 'ses_b');
  });
});

test('contract: submit posts { messageID, parts:[{type:text}] } to /session/:id/message', async () => {
  await withFake(async (fake) => {
    const out = await opencodeSubmitTask('Please inspect the repo.');
    assert.equal(out.sessionId, 'ses_b');
    assert.equal(out.modelRan, true);
    const call = fake.seen.find((r) => r.method === 'POST' && r.url === '/session/ses_b/message');
    assert.ok(call, 'expected a POST to /session/ses_b/message');
    assert.ok(call.body.messageID, 'the bridge must supply its own task message id to correlate the reply');
    assert.deepEqual(call.body.parts, [{ type: 'text', text: 'Please inspect the repo.' }]);
  });
});

test('contract: submit does NOT send noReply, which would suppress the model run', async () => {
  await withFake(async (fake) => {
    await opencodeSubmitTask('Please inspect the repo.');
    const call = fake.seen.find((r) => r.method === 'POST' && r.url === '/session/ses_b/message');
    assert.equal('noReply' in call.body, false);
  });
});

test('contract: messages read the documented { info, parts }[] shape', async () => {
  await withFake(async () => {
    const out = await opencodeGetMessages('ses_b');
    assert.equal(out.sessionId, 'ses_b');
    assert.ok(Array.isArray(out.messages));
    assert.ok(out.messages.every((m) => 'role' in m && 'id' in m && 'text' in m));
  });
});

test('contract: cancel posts to /session/:id/abort', async () => {
  await withFake(async (fake) => {
    const out = await opencodeCancelTask('ses_b');
    assert.equal(out.sessionId, 'ses_b');
    assert.equal(fake.seen.some((r) => r.method === 'POST' && r.url === '/session/ses_b/abort'), true);
  });
});

test('contract: basic auth is attached when a password is configured', async () => {
  await withFake(async (fake) => {
    config.opencode.password = 'contract-test-password';
    try {
      await opencodeListSessions();
      const call = fake.seen[fake.seen.length - 1];
      assert.ok(call.auth && call.auth.startsWith('Basic '), 'expected an HTTP Basic Authorization header');
    } finally {
      config.opencode.password = '';
    }
  });
});

test('contract: a 401 from OpenCode is reported as auth-required, not as a crash', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = config.opencode.baseUrl;
  config.opencode.baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const h = await opencodeHealth();
    assert.equal(h.reachable, true);
    assert.equal(h.authRequired, true);
  } finally {
    config.opencode.baseUrl = saved;
    server.close();
  }
});

test('contract: an unknown OpenCode path surfaces a structured upstream error', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const saved = config.opencode.baseUrl;
  config.opencode.baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    // Assert the structured error, not the prose: the message is user-facing and may be reworded.
    await assert.rejects(() => opencodeListSessions(), (err) => {
      assert.equal(err.code, 'upstream_status');
      assert.equal(err.details.status, 404);
      assert.match(err.message, /404/);
      return true;
    });
  } finally {
    config.opencode.baseUrl = saved;
    server.close();
  }
});
