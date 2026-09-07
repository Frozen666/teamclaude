import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { SessionTracker } from '../src/session-tracker.js';

// `starved` counts CONSECUTIVE client requests that ended without a usable
// answer. The point of it is everything the token counters cannot see:
// `reports` is zero on three healthy shapes (count_tokens, a 4xx, a
// third-party upstream that returns no usage object) and non-zero on the worst
// failing one (a stream that emits message_start and then dies), while `count`
// counts forward attempts rather than client requests — and is not incremented
// at all when no account was available, which is the case that starves a
// session hardest.
//
// Most of these drive the real proxy rather than the tracker, because every
// defect in the first attempt at this signal lived at the call site.

const SID = 'sess-starved';
const listen = (s) => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
// A stub that deliberately never ends its response leaves a live connection,
// and `close()` waits for it — which hangs the file on Node 20/22 where the
// runtime does not tear it down for us. Close the sockets explicitly rather
// than relying on version-specific behaviour.
function shutdown(...servers) {
  for (const srv of servers) { srv.closeAllConnections?.(); srv.close(); }
}
const fleet = (n = 1) => new AccountManager(
  Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'api_key', apiKey: `sk-${i}` })), 0.98);

function item(am, id = SID) {
  return (am.sessionTracker.stats(undefined, { detail: true }).items || []).find(r => r.id === id);
}
async function post(port, body = { model: 'claude-opus-5', messages: [] }, path = '/v1/messages') {
  // A stream the proxy tears down breaks the client's fetch — that is the
  // symptom under test, not a harness failure, so it is caught rather than
  // thrown. Callers assert on the session record, never on this return.
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
      body: JSON.stringify(body),
    });
    await res.text().catch(() => {});
    return res.status;
  } catch { return null; }
}
/** Drive the proxy against `handler`, N client requests, and return the session row. */
async function run(handler, n, { accounts = 1, before } = {}) {
  const upstream = http.createServer(handler);
  const upstreamPort = await listen(upstream);
  const am = fleet(accounts);
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    before?.(am);
    for (let i = 0; i < n; i++) await post(port);
    return { row: item(am), am };
  } finally { shutdown(proxy, upstream); }
}

const json = (status, body) => (req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ── the counter itself ──────────────────────────────────────

test('the streak advances on failure and is reset by one usable answer', () => {
  const st = new SessionTracker();
  st.beginRequest(SID);
  for (let i = 0; i < 5; i++) st.recordOutcome(SID, false);
  assert.equal(item({ sessionTracker: st }).starved, 5);
  assert.equal(st.recordOutcome(SID, true), 0, 'one answer clears the streak');
  for (let i = 0; i < 5; i++) st.recordOutcome(SID, false);
  assert.equal(item({ sessionTracker: st }).starved, 5, 'and it climbs again');
});

test('an outcome for a session the tracker has forgotten creates nothing', () => {
  const st = new SessionTracker();
  assert.equal(st.recordOutcome('never-seen', false), null);
  assert.equal(st.sessions.has('never-seen'), false, 'a client-supplied id cannot resurrect a record');
});

// ── the healthy shapes the first attempt accused ────────────

test('count_tokens answers correctly while reporting no usage, and does not starve', async () => {
  const upstream = http.createServer(json(200, { input_tokens: 42 }));
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (let i = 0; i < 6; i++) await post(port, { model: 'claude-opus-5' }, '/v1/messages/count_tokens');
    const row = item(am);
    assert.equal(row.starved, 0, 'six good answers are not starvation');
    assert.equal(Object.keys(row.tokens).length, 0, 'and they report no usage — the old false positive');
  } finally { shutdown(proxy, upstream); }
});

test('a repeated 4xx is an answer about the request, not starvation', async () => {
  const { row } = await run(json(400, { type: 'error', error: { type: 'invalid_request_error' } }), 6);
  assert.equal(row.starved, 0);
});

test('a 200 carrying no usage object — a third-party upstream — does not starve', async () => {
  const { row } = await run(json(200, { ok: true }), 6);
  assert.equal(row.starved, 0, 'answered');
  assert.equal(Object.keys(row.tokens).length, 0, 'reported nothing: the two are different questions');
});

// ── the failing shapes ──────────────────────────────────────

test('a stream that dies after message_start starves, though it reported usage', async () => {
  const { row } = await run((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
    // Let the event actually reach the proxy's SSE parser before the socket
    // dies — the real shape is a stream that reports and THEN fails, which is
    // precisely what makes the usage counter blind to it.
    setTimeout(() => res.destroy(), 60);
  }, 3);
  assert.equal(row.starved, 3, 'the client got nothing usable');
  const reports = Object.values(row.tokens).reduce((n, t) => n + t.reports, 0);
  assert.equal(reports, 3, 'while the usage counter says it heard from upstream — the old false negative');
});

test('a persistent 5xx starves once per client request, not once per attempt', async () => {
  const { row } = await run(json(500, { error: 'boom' }), 3, { accounts: 2 });
  assert.equal(row.starved, 3, 'three client requests');
  assert.ok(row.requests > 3, `attempts (${row.requests}) exceed client requests — why the count cannot be used`);
});

test('a fleet with nothing available starves a session that never reaches an account', async () => {
  const { row } = await run(json(200, { ok: true }), 3, {
    accounts: 2,
    before: (am) => am.accounts.forEach((_, i) => am.setDisabled(i, true)),
  });
  assert.equal(row.starved, 3);
  assert.equal(row.requests, 0, 'recordSession is never reached — invisible to any count-based signal');
});

// ── the third state ─────────────────────────────────────────

test('a client that walks away mid-stream is not counted as starved', async () => {
  const open = [];
  const upstream = http.createServer((req, res) => {
    open.push(res);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n');
    // Deliberately never ended: the client aborts below. Held so teardown can
    // destroy it — an unended response keeps close() waiting forever.
  });
  const upstreamPort = await listen(upstream);
  const am = fleet();
  const proxy = createProxyServer(am, { proxy: {}, upstream: `http://127.0.0.1:${upstreamPort}` });
  const port = await listen(proxy);
  try {
    for (let i = 0; i < 3; i++) {
      const ac = new AbortController();
      const p = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-claude-code-session-id': SID },
        body: JSON.stringify({ model: 'claude-opus-5', messages: [] }),
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 60));
      ac.abort();
      await p;
    }
    await new Promise(r => setTimeout(r, 120));
    assert.equal(item(am).starved, 0, 'leaving is not the same as getting nothing');
  } finally {
    for (const res of open) res.destroy();
    shutdown(proxy, upstream);
  }
});

test('the fleet-level maximum is reported, and clears when the session goes quiet', () => {
  let t = 1_000_000;
  const st = new SessionTracker({ now: () => t });
  for (let i = 0; i < 4; i++) {
    st.beginRequest(SID);
    st.recordOutcome(SID, false);
    st.endRequest(SID);
  }
  assert.equal(st.stats().starvedMax, 4, 'visible without proxy.sessionDetail');
  t += 5 * 60 * 1000; // past the active window
  assert.equal(st.stats().starvedMax, 0, 'a session that stopped trying is not still starving');
});
