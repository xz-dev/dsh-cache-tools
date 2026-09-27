import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  apply,
  aggregateShards,
  buildCsv,
  collectCacheSessionMetrics,
  computeCacheHitPercent,
  computeCumulativeSeries,
  csvEscape,
  formatElapsed,
  formatCompletedAt,
  graphViewLabel,
  readShards,
  renderGraphBody,
  renderStatsBody,
  sanitizeFileName,
  stateDir,
} from '../index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeCtx(overrides = {}) {
  const listeners = new Map();
  const commands = new Map();
  const statusWrites = [];
  const toasts = [];
  const renderers = new Map();
  const services = new Map();
  const cleanups = [];

  if (overrides.tuiStatus !== null) {
    services.set('tuiStatus', {
      set: (key, text) => statusWrites.push({ key, text }),
    });
  }
  if (overrides.tuiToast !== null) {
    services.set('tuiToast', {
      show: (text, options) => { toasts.push({ text, options }); return true; },
    });
  }
  if (overrides.tuiRenderers !== null) {
    services.set('tuiRenderers', {
      register: (type, fn) => { renderers.set(type, fn); return () => {}; },
    });
  }
  for (const [k, v] of Object.entries(overrides.services ?? {})) services.set(k, v);

  const ctx = {
    logger: () => ({ warn: () => {}, info: () => {} }),
    get: (n) => services.get(n),
    on: (event, fn) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
      return () => {};
    },
    // cordis semantics: effect(fn) runs fn now, stores the returned cleanup.
    effect: (fn) => { const d = fn(); if (typeof d === 'function') cleanups.push(d); },
    inject: (names, fn) => {
      const sub = { ...ctx };
      for (const n of names) if (services.has(n) || n === 'commands') sub[n] = n === 'commands' ? commandsApi : services.get(n);
      fn(sub);
    },
  };
  const commandsApi = {
    register: (def) => { commands.set(def.name, def); return () => {}; },
  };
  if (!overrides.noCommands) ctx.commands = commandsApi;

  apply(ctx, overrides.config ?? {});
  const fire = (event, ...args) => (listeners.get(event) ?? []).forEach((fn) => fn(...args));
  const dispose = () => { for (const fn of cleanups.splice(0)) fn(); };
  return { ctx, listeners, commands, statusWrites, toasts, renderers, fire, dispose };
}

function makeSession(events = [], nodes) {
  const appended = [];
  return {
    id: 'sess-test-1',
    header: { id: 'sess-test-1' },
    appended,
    surface: nodes ? { nodes } : { nodes: events.map((_, i) => i) },
    snapshotEvents: () => events,
    append: (type, data) => { appended.push({ type, data }); },
  };
}

function assistantEvent(seq, { provider = 'gateway', model = 'gpt-6-luna', input = 100, output = 10, cacheRead = 0, cacheWrite = 0 } = {}) {
  return {
    seq,
    time: 1790530000000 + seq * 1000,
    type: 'assistant/message',
    data: {
      turn: 1, step: seq,
      message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [{ type: 'text', text: 'x' }] },
      stream: [],
      usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite },
    },
  };
}

function makeAgent(session, { provider = 'gateway', model = 'gpt-6-luna' } = {}) {
  return { session, provider, model, cancel: () => {}, followup: () => {} };
}

function makeInvocation(agent, rawInput = '') {
  return { agent, rawInput, signal: new AbortController().signal, attachments: [], commandId: 't' };
}

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-tools-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  return Promise.resolve().then(() => fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    rmSync(dir, { recursive: true, force: true });
  });
}

// ---------------------------------------------------------------------------
// Pure math / formatting (pi-cache-graph port)
// ---------------------------------------------------------------------------

test('computeCacheHitPercent uses full prompt denominator', () => {
  assert.equal(computeCacheHitPercent(100, 50, 50), 25);
  assert.equal(computeCacheHitPercent(0, 0, 0), 0);
  assert.equal(computeCacheHitPercent(0, 100, 0), 100);
});

test('cumulative series accumulates', () => {
  const s = computeCumulativeSeries([
    { input: 100, cacheRead: 0, cacheWrite: 0 },
    { input: 50, cacheRead: 50, cacheWrite: 0 },
  ]);
  assert.deepEqual(s.cumInput, [100, 150]);
  assert.deepEqual(s.cumCacheRead, [0, 50]);
  assert.equal(s.cumHitPercent[1], 25);
});

test('formatElapsed matches pi-execution-time shapes', () => {
  assert.equal(formatElapsed(500), '0.5s');
  assert.equal(formatElapsed(9500), '9.5s');
  assert.equal(formatElapsed(65_000), '1m 05s');
  assert.equal(formatElapsed(3_725_000), '1h 02m 05s');
});

test('formatCompletedAt pads HH:MM', () => {
  assert.equal(formatCompletedAt(new Date(2026, 0, 1, 9, 5)), '09:05');
});

test('csvEscape quotes commas/quotes/newlines', () => {
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape(42), '42');
  assert.equal(csvEscape(undefined), '');
});

test('sanitizeFileName strips unsafe chars', () => {
  assert.equal(sanitizeFileName('my session/01'), 'my-session-01');
  assert.equal(sanitizeFileName('   '), 'session');
});

// ---------------------------------------------------------------------------
// collectCacheSessionMetrics: DSH event log -> metrics
// ---------------------------------------------------------------------------

test('collectCacheSessionMetrics folds assistant/message usage', () => {
  const events = [
    { seq: 0, type: 'system/message', data: { turn: 1, step: 0, message: {} } },
    { seq: 1, type: 'user/message', data: { content: [] } },
    assistantEvent(2, { input: 200, cacheRead: 800, cacheWrite: 0, output: 50 }),
    { seq: 3, type: 'tool/call', data: {} },
    assistantEvent(4, { input: 100, cacheRead: 900, cacheWrite: 0, output: 60 }),
    { seq: 5, type: 'assistant/attempt', data: { stream: [] } }, // no usage -> skipped
  ];
  const metrics = collectCacheSessionMetrics(events, [0, 1, 2]);
  assert.equal(metrics.allMessages.length, 2);
  assert.equal(metrics.treeTotals.cacheRead, 1700);
  assert.equal(metrics.activeBranchTotals.assistantMessages, 1);
  assert.equal(metrics.activeBranchMessages[0].provider, 'gateway');
  assert.equal(metrics.activeBranchMessages[0].model, 'gpt-6-luna');
  // per-turn hit% of second message: 900/1000 = 90
  assert.equal(metrics.allMessages[1].cacheHitPercent, 90);
});

test('empty session -> empty metrics, no crash', () => {
  const m = collectCacheSessionMetrics([], []);
  assert.equal(m.allMessages.length, 0);
  assert.equal(m.treeTotals.totalTokens, 0);
});

// ---------------------------------------------------------------------------
// Graph/stats/csv renderers
// ---------------------------------------------------------------------------

const fixture = collectCacheSessionMetrics(
  [assistantEvent(0, { input: 100, cacheRead: 0 }), assistantEvent(1, { input: 50, cacheRead: 150 }), assistantEvent(2, { input: 20, cacheRead: 280 })],
  [0, 1, 2],
);

test('renderGraphBody per-turn renders chart + summary', () => {
  const out = renderGraphBody(fixture, 80, 'per-turn').join('\n');
  assert.match(out, /Cache hit trend.*Per-turn/);
  assert.match(out, /Latest: 93\.3%/);
  assert.match(out, /█/);
});

test('renderGraphBody cumulative views', () => {
  assert.match(renderGraphBody(fixture, 80, 'cumulative-percent').join('\n'), /Aggregate hit %/);
  assert.match(renderGraphBody(fixture, 80, 'cumulative-total').join('\n'), /1 row = .* tokens/);
});

test('renderGraphBody empty session', () => {
  const out = renderGraphBody(collectCacheSessionMetrics([], []), 80).join('\n');
  assert.match(out, /No assistant messages/);
});

test('renderStatsBody renders table + totals', () => {
  const out = renderStatsBody(fixture, 120).join('\n');
  assert.match(out, /Active branch:/);
  assert.match(out, /Whole tree:/);
  assert.match(out, /gateway\/gpt-6-luna/);
  assert.match(out, /hit%/);
});

test('buildCsv emits summary + message rows', () => {
  const csv = buildCsv(fixture);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0].split(',')[0], 'row_type');
  assert.equal(lines.filter((l) => l.startsWith('summary')).length, 3);
  assert.equal(lines.filter((l) => l.startsWith('message')).length, 3);
  assert.match(csv, /whole_tree/);
});

// ---------------------------------------------------------------------------
// Shards
// ---------------------------------------------------------------------------

test('shard round-trip + aggregate session/total scopes', () => withTempHome(() => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0, { input: 100, cacheRead: 50 })]);
  const agent = makeAgent(session);
  h.fire('agent/created', { agent });
  h.fire('session/event', session, session.snapshotEvents()[0]);
  h.dispose(); // flush closed

  const dir = join(stateDir(), 'shards');
  const shards = readShards(dir);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].lifecycle.state, 'closed');
  const stats = shards[0].models['gateway/gpt-6-luna'].stats;
  assert.equal(stats.totalRequests, 1);
  assert.equal(stats.cachedInputTokens, 50);
  assert.equal(stats.totalInputTokens, 150);

  const sess = aggregateShards(shards, { mode: 'session', sessionHash: shards[0].sessionHash, day: shards[0].day });
  assert.equal(sess.byModel.get('gateway/gpt-6-luna').hitRequests, 1);
  const other = aggregateShards(shards, { mode: 'session', sessionHash: 'deadbeef', day: shards[0].day });
  assert.equal(other.byModel.size, 0);
}));

test('/cache-optimizer config footer-mode persists', () => withTempHome(async () => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.fire('agent/created', { agent });
  const res = await h.commands.get('cache-optimizer').handler(makeInvocation(agent, 'config footer-mode total'));
  assert.equal(res.kind, 'success');
  const saved = JSON.parse(readFileSync(join(stateDir(), 'config.json'), 'utf8'));
  assert.equal(saved.footerMode, 'total');
  h.dispose();
}));

test('/cache-optimizer stats reports usage', () => withTempHome(async () => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0, { input: 10, cacheRead: 90 })]);
  const agent = makeAgent(session);
  h.fire('agent/created', { agent });
  h.fire('session/event', session, session.snapshotEvents()[0]);
  const res = await h.commands.get('cache-optimizer').handler(makeInvocation(agent, 'stats'));
  assert.equal(res.kind, 'success');
  assert.match(res.text, /gpt-6-luna/);
  assert.match(res.text, /90\.0%/);
  h.dispose();
}));

test('/cache-optimizer doctor reports route + hit rate', () => withTempHome(async () => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0, { input: 10, cacheRead: 90 })]);
  const agent = makeAgent(session);
  h.fire('agent/created', { agent });
  h.fire('session/event', session, session.snapshotEvents()[0]);
  const res = await h.commands.get('cache-optimizer').handler(makeInvocation(agent, 'doctor'));
  assert.equal(res.kind, 'success');
  assert.match(res.text, /Provider: gateway/);
  assert.match(res.text, /Model:    gpt-6-luna/);
  assert.match(res.text, /Hit rate: 90\.0%/);
  h.dispose();
}));

test('/cache-optimizer reset clears counters', () => withTempHome(async () => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0, { input: 10, cacheRead: 90 })]);
  const agent = makeAgent(session);
  h.fire('agent/created', { agent });
  h.fire('session/event', session, session.snapshotEvents()[0]);
  const res = await h.commands.get('cache-optimizer').handler(makeInvocation(agent, 'reset'));
  assert.equal(res.kind, 'success');
  const res2 = await h.commands.get('cache-optimizer').handler(makeInvocation(agent, 'stats'));
  assert.match(res2.text, /No cache stats/);
  h.dispose();
}));

// ---------------------------------------------------------------------------
// /cache command
// ---------------------------------------------------------------------------

test('/cache stats prints table', () => withTempHome(async () => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0), assistantEvent(1, { cacheRead: 80 })]);
  const agent = makeAgent(session);
  const res = await h.commands.get('cache').handler(makeInvocation(agent, 'stats'));
  assert.equal(res.kind, 'success');
  assert.match(res.text, /Cumulative totals/);
  assert.match(res.text, /gpt-6-luna/);
  h.dispose();
}));

test('/cache export writes CSV to cwd', () => withTempHome(async (dir) => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0, { cacheRead: 5 })]);
  session.header = { id: 'sess-test-1', cwd: dir };
  const agent = makeAgent(session);
  const inv = { ...makeInvocation(agent, 'export'), cwd: dir };
  const res = await h.commands.get('cache').handler(inv);
  assert.equal(res.kind, 'success');
  assert.match(res.text, /sess-test-1\.csv/);
  const csv = readFileSync(join(dir, 'sess-test-1.csv'), 'utf8');
  assert.match(csv, /cache_hit_percent/);
  h.dispose();
}));

test('/cache unknown subcommand errors', () => withTempHome(async () => {
  const h = makeCtx();
  const res = await h.commands.get('cache').handler(makeInvocation(makeAgent(makeSession()), 'bogus'));
  assert.equal(res.kind, 'error');
  h.dispose();
}));

// ---------------------------------------------------------------------------
// execution-time
// ---------------------------------------------------------------------------

test('agent/status running sets ⏱ status, idle sets ✓', () => withTempHome(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.fire('agent/status', { agent, status: 'running' });
  assert.ok(h.statusWrites.some((w) => w.key === 'execution-time' && /⏱/.test(w.text)));
  h.fire('agent/status', { agent, status: 'idle' });
  assert.ok(h.statusWrites.some((w) => w.key === 'execution-time' && /✓ task/.test(w.text)));
  h.dispose();
}));

test('step completion appends cache-tools/step-time event', () => withTempHome(() => {
  const h = makeCtx();
  const session = makeSession([assistantEvent(0)]);
  const agent = makeAgent(session);
  h.fire('agent/created', { agent });
  h.fire('session/event', session, { seq: 0, type: 'step/start', data: { turn: 1, step: 0 } });
  h.fire('session/event', session, session.snapshotEvents()[0]);
  assert.ok(session.appended.some((e) => e.type === 'cache-tools/step-time' && typeof e.data.elapsedMs === 'number'));
  h.dispose();
}));

test('renderer registered for step-time events', () => withTempHome(() => {
  const h = makeCtx();
  assert.ok(h.renderers.has('cache-tools/step-time'));
  const out = h.renderers.get('cache-tools/step-time')({ step: 2, elapsedMs: 65000, completedAt: '2026-09-28T10:05:00Z' });
  assert.match(out.lines[0], /step 2/);
  h.dispose();
}));

test('llm/stream listener observes missing sessionId once', () => withTempHome(() => {
  const h = makeCtx();
  const handler = h.listeners.get('llm/stream')?.[0];
  assert.ok(handler);
  handler({ provider: 'x', model: 'y', messages: [] }, () => ({}));
  handler({ provider: 'x', model: 'y', messages: [] }, () => ({}));
  assert.equal(h.toasts.length, 1);
  assert.match(h.toasts[0].text, /sessionId/);
  h.dispose();
}));

test('no warn when sessionId present or purpose set', () => withTempHome(() => {
  const h = makeCtx();
  const handler = h.listeners.get('llm/stream')?.[0];
  handler({ sessionId: 's1', messages: [] }, () => ({}));
  handler({ purpose: 'compaction', messages: [] }, () => ({}));
  assert.equal(h.toasts.length, 0);
  h.dispose();
}));

test('dispose clears status keys and closes shard', () => withTempHome(() => {
  const h = makeCtx();
  const agent = makeAgent(makeSession());
  h.fire('agent/created', { agent });
  h.fire('agent/status', { agent, status: 'running' });
  h.dispose();
  const keys = h.statusWrites.filter((w) => w.text === undefined).map((w) => w.key);
  assert.ok(keys.includes('execution-time'));
  assert.ok(keys.includes('zz-execution-time-total'));
  assert.ok(keys.includes('cache-optimizer'));
}));
