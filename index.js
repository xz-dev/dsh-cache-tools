// dsh-cache-tools — DSH port of pi-cache-optimizer (freescheme, MIT),
// pi-cache-graph (Arnav Gupta / championswimmer, MIT), and pi-execution-time
// (Lukas Panni, MIT). One cordis plugin; three feature groups.
//
// What is intentionally NOT here (see BEHAVIOR.md for the full checklist):
//  - prompt_cache_key / session-affinity headers: the pi-ai adapters DSH
//    streams through already send `prompt_cache_key` from the loop-stamped
//    `options.sessionId` (@earendil-works/pi-ai dist/api/openai-responses.js:230,
//    dist/api/openai-completions.js:588; loop stamps session.id at
//    dsh-agent-loop/lib/index.js:1259; dsh-llm-pi-ai forwards it at lib/index.js:1881).
//  - long cache retention: a per-provider `cacheRetention` profile knob in
//    dsh-llm-pi-ai (lib/types/config.d.ts:120, lib/index.js:1027) — set it in
//    the profile, not here.
//  - prompt reorder/skill compression, tool ordering, adaptive-thinking compat:
//    DSH assembles prompts declaratively (dsh-system-prompt) and request
//    options are deep-frozen at `llm/stream` — no seam to rewrite content.
//  - models.json auto-fix/rollback, footer cache stats: DSH's model catalog is
//    profile-config; the status line already shows live cache-hit% (StatusLine
//    formatCacheHitRate). There is no public per-route runtime config seam to
//    mutate safely.
//
// Kept: the durable shard counters (/cache-optimizer stats|doctor|reset),
// /cache graph|stats|export (text rendering of the pi-cache-graph views), and
// the pi-execution-time footer timers.

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'dsh-cache-tools';
// This cordis fork's Inject.resolve maps array entries verbatim — no
// {name, required} object form — so optional services stay out of inject
// and are reached via ctx.get?.() / ctx.inject?.() with fallbacks below.
export const inject = ['agents', 'sessions'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FOOTER_MODES = ['session', 'total', 'process'];

export const Config = z.object({
  /** Footer stats scope: current session | all today | this process only. */
  footerMode: z.union(FOOTER_MODES.map((m) => z.const(m))).default('session'),
  /** Show the shard counter in the TUI status line (dsh-tui only). */
  footerStatus: z.boolean().default(true),
  /** Show the pi-execution-time task/session timers in the status line. */
  executionTime: z.boolean().default(true),
  /** Disable request-key warnings (PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY analog). */
  silenceRequestKeyWarning: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const LOG = (ctx) => (msg) => { try { ctx.logger('dsh-cache-tools').info(msg); } catch { /* no logger */ } };

function envTruthy(value) {
  if (value === undefined) return undefined;
  const v = String(value).trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'no';
}

/** Where the shard store lives. Mirrors Pi's agent-dir placement, under DSH home. */
export function stateDir(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.trim().length > 0 ? env.DSH_HOME : join(homedir(), '.dsh');
  return join(resolve(home), 'storages', 'dsh-cache-tools');
}

function shardDir(env = process.env) { return join(stateDir(env), 'shards'); }
function configPath(env = process.env) { return join(stateDir(env), 'config.json'); }

function readJsonSafe(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch { return undefined; }
}

/** Persisted footer mode (written by `/cache-optimizer config footer-mode`). */
function persistedFooterMode(env = process.env) {
  const record = readJsonSafe(configPath(env));
  const mode = record?.footerMode;
  return typeof mode === 'string' && FOOTER_MODES.includes(mode) ? mode : undefined;
}

function writePersistedFooterMode(mode, env = process.env) {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true });
  const path = configPath(env);
  const existing = readJsonSafe(path) ?? {};
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...existing, version: 1, footerMode: mode }, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
}

function resolveFooterMode(config, env = process.env) {
  const persisted = persistedFooterMode(env);
  if (persisted) return { mode: persisted, source: 'config' };
  const raw = env.PI_CACHE_OPTIMIZER_FOOTER_MODE;
  if (raw !== undefined) {
    const mode = String(raw).trim().toLowerCase();
    if (FOOTER_MODES.includes(mode)) return { mode, source: 'env' };
  }
  const configured = config.footerMode;
  return { mode: FOOTER_MODES.includes(configured) ? configured : 'session', source: 'default' };
}

// ---------------------------------------------------------------------------
// Usage math (pi-cache-graph src/cache-math.ts + cumulative.ts, verbatim port)
// ---------------------------------------------------------------------------

/** Canonical cache-hit %: cacheRead / (input + cacheRead + cacheWrite). */
export function computeCacheHitPercent(input, cacheRead, cacheWrite) {
  const denominator = input + cacheRead + cacheWrite;
  if (denominator <= 0) return 0;
  return (cacheRead / denominator) * 100;
}

export function emptyTotals() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, assistantMessages: 0 };
}

export function addToTotals(totals, m) {
  totals.input += m.input;
  totals.output += m.output;
  totals.cacheRead += m.cacheRead;
  totals.cacheWrite += m.cacheWrite;
  totals.totalTokens += m.totalTokens;
  totals.assistantMessages += 1;
}

export function computeCumulativeSeries(messages) {
  const cumInput = [], cumCacheRead = [], cumCacheWrite = [], cumHitPercent = [];
  let sumInput = 0, sumCacheRead = 0, sumCacheWrite = 0;
  for (const msg of messages) {
    sumInput += msg.input;
    sumCacheRead += msg.cacheRead;
    sumCacheWrite += msg.cacheWrite;
    cumInput.push(sumInput);
    cumCacheRead.push(sumCacheRead);
    cumCacheWrite.push(sumCacheWrite);
    cumHitPercent.push(computeCacheHitPercent(sumInput, sumCacheRead, sumCacheWrite));
  }
  return { cumInput, cumCacheRead, cumCacheWrite, cumHitPercent };
}

export function formatInt(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(value));
}
export function formatPercent(value) { return `${value.toFixed(1)}%`; }
export function formatCompact(value) {
  if (!Number.isFinite(value) || value < 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}
export function summarizeHitPercent(totals) {
  return computeCacheHitPercent(totals.input, totals.cacheRead, totals.cacheWrite);
}
export function formatTotalsLine(label, totals) {
  return [
    `${label}:`,
    `${formatInt(totals.assistantMessages)} turns`,
    `prompt ${formatInt(totals.input + totals.cacheRead + totals.cacheWrite)}`,
    `received ${formatInt(totals.output)}`,
    `cache hit ${formatInt(totals.cacheRead)}`,
    `cache write ${formatInt(totals.cacheWrite)}`,
    `hit rate ${formatPercent(summarizeHitPercent(totals))}`,
  ].join(' • ');
}

// ---------------------------------------------------------------------------
// Session metrics collection (pi-cache-graph src/session-data.ts port).
// DSH equivalent of SessionManager.getEntries()/getBranch(): the session event
// log — `assistant/message` events carry { message, usage } — and the surface
// node list, which is the model-visible "active branch".
// ---------------------------------------------------------------------------

function eventSeq(event, idx) {
  return typeof event?.seq === 'number' ? event.seq : idx;
}

/** Collect per-assistant-message cache metrics from a DSH session's events. */
export function collectCacheSessionMetrics(events, activeSeqs) {
  const treeTotals = emptyTotals();
  const activeBranchTotals = emptyTotals();
  const allMessages = [];
  const activeBranchMessages = [];
  const active = activeSeqs ? new Set(activeSeqs) : undefined;

  let sequence = 0;
  let activeBranchSequence = 0;

  events.forEach((event, idx) => {
    if (!event || event.type !== 'assistant/message') return;
    const data = event.data ?? {};
    const usage = data.usage;
    if (!usage) return;
    const source = data.message?.source ?? {};
    sequence += 1;
    const seq = eventSeq(event, idx);
    const isOnActiveBranch = active === undefined ? true : active.has(seq);
    const metric = {
      sequence,
      activeBranchSequence: undefined,
      entryId: String(seq),
      timestamp: new Date(event.time ?? Date.now()).toISOString(),
      provider: source.provider ?? 'unknown',
      model: source.model ?? 'unknown',
      input: usage.inputTokens ?? 0,
      output: usage.outputTokens ?? 0,
      cacheRead: usage.cacheReadTokens ?? 0,
      cacheWrite: usage.cacheWriteTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      cacheHitPercent: computeCacheHitPercent(usage.inputTokens ?? 0, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0),
      isOnActiveBranch,
    };
    addToTotals(treeTotals, metric);
    allMessages.push(metric);
    if (metric.isOnActiveBranch) {
      activeBranchSequence += 1;
      metric.activeBranchSequence = activeBranchSequence;
      addToTotals(activeBranchTotals, metric);
      activeBranchMessages.push(metric);
    }
  });

  return { allMessages, activeBranchMessages, treeTotals, activeBranchTotals };
}

function sessionEvents(session) {
  try {
    if (typeof session.snapshotEvents === 'function') return [...session.snapshotEvents()];
  } catch { /* closed */ }
  return [];
}

function activeSeqs(session) {
  try {
    const nodes = session.surface?.nodes;
    if (Array.isArray(nodes)) return [...nodes];
  } catch { /* no surface */ }
  return undefined;
}

// ---------------------------------------------------------------------------
// Graph view renderers (pi-cache-graph src/graph-view.ts port, theme-free).
// Pi colors via theme.fg are dropped: command results render as plain text.
// ---------------------------------------------------------------------------

export const GRAPH_VIEWS = ['per-turn', 'cumulative-percent', 'cumulative-total'];

export function graphViewLabel(view) {
  switch (view) {
    case 'per-turn': return 'Per-turn (%)';
    case 'cumulative-percent': return 'Cumulative (aggregate) %';
    case 'cumulative-total': return 'Cumulative (aggregate) total';
    default: return String(view);
  }
}

export function bucketMessages(messages, bucketCount) {
  if (messages.length <= bucketCount) return messages.map((m) => [m]);
  const buckets = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * messages.length) / bucketCount);
    const end = Math.floor(((i + 1) * messages.length) / bucketCount);
    buckets.push(messages.slice(start, Math.max(start + 1, end)));
  }
  return buckets;
}

function bucketMax(values, bucketCount) {
  if (values.length <= bucketCount) return [...values];
  const result = [];
  for (let i = 0; i < bucketCount; i += 1) {
    const start = Math.floor((i * values.length) / bucketCount);
    const end = Math.floor(((i + 1) * values.length) / bucketCount);
    const slice = values.slice(start, Math.max(start + 1, end));
    result.push(Math.max(...slice));
  }
  return result;
}

const averageHitPercent = (messages) =>
  messages.length === 0 ? 0 : messages.reduce((s, m) => s + m.cacheHitPercent, 0) / messages.length;
const minHitPercent = (messages) => (messages.length === 0 ? 0 : Math.min(...messages.map((m) => m.cacheHitPercent)));
const maxHitPercent = (messages) => (messages.length === 0 ? 0 : Math.max(...messages.map((m) => m.cacheHitPercent)));

function renderBarChart(values, chartHeight) {
  const lines = [];
  for (let row = chartHeight; row >= 1; row -= 1) {
    const threshold = (row / chartHeight) * 100;
    const label = `${String(Math.round(threshold)).padStart(3, ' ')}│`;
    const body = values.map((v) => (v >= threshold ? '█' : '·')).join('');
    lines.push(label + body);
  }
  lines.push(`  0│${'─'.repeat(values.length)}`);
  return lines;
}

function renderStackedSeriesChart(seriesInput, seriesCacheRead, seriesCacheWrite, chartHeight) {
  const maxVal = Math.max(...seriesInput, ...seriesCacheRead, ...seriesCacheWrite, 1);
  let unitTokens = 5000;
  if (maxVal > chartHeight * unitTokens) unitTokens = Math.ceil(maxVal / chartHeight / 5000) * 5000;
  const lines = [];
  for (let row = chartHeight; row >= 1; row -= 1) {
    const threshold = row * unitTokens;
    const kVal = Math.round(threshold / 1000);
    const label = `${String(kVal).padStart(3)}k│`;
    const body = seriesInput.map((_, i) => {
      const inp = seriesInput[i], read = seriesCacheRead[i], write = seriesCacheWrite[i];
      if (read >= threshold) return '▒';
      if (write >= threshold) return '░';
      if (inp >= threshold) return '▇';
      return '·';
    }).join('');
    lines.push(label + body);
  }
  lines.push(`    0│${'─'.repeat(seriesInput.length)}`);
  return { lines, unitTokens };
}

function xAxisFooter(bucketCount, totalMessages, indent) {
  const countStr = String(totalMessages);
  const spacer = bucketCount > 2 ? ' '.repeat(Math.max(1, bucketCount - countStr.length - 1)) : '';
  return [
    `${indent}1` + (bucketCount > 2 ? `${spacer}${countStr}` : ''),
    `${indent}assistant-message sequence in session append order`,
  ];
}

function renderPerTurnPercent(messages, chartWidth) {
  const lines = [];
  const chartHeight = 10;
  const buckets = bucketMessages(messages, chartWidth);
  const values = buckets.map((b) => averageHitPercent(b));
  lines.push(...renderBarChart(values, chartHeight));
  lines.push(...xAxisFooter(values.length, messages.length, '   '));
  lines.push('');
  const recent = messages.slice(-8);
  lines.push(`Recent ${recent.length} turns`);
  lines.push('* = on current active branch');
  for (const m of recent) {
    const label = `#${String(m.sequence).padStart(2, ' ')}${m.isOnActiveBranch ? '*' : ' '}`;
    lines.push(`${label} ${formatPercent(m.cacheHitPercent).padStart(6, ' ')}  in ${formatInt(m.input).padStart(6, ' ')}  cache ${formatInt(m.cacheRead).padStart(6, ' ')}  ${m.provider}/${m.model}`);
  }
  return lines;
}

function renderCumulativePercent(messages, chartWidth, cumSeries) {
  const lines = [];
  const chartHeight = 10;
  const bucketed = bucketMax(cumSeries.cumHitPercent, chartWidth);
  lines.push(...renderBarChart(bucketed, chartHeight));
  lines.push(...xAxisFooter(bucketed.length, messages.length, '   '));
  lines.push('');
  const recentCount = Math.min(8, messages.length);
  const startIdx = messages.length - recentCount;
  const recent = messages.slice(-recentCount);
  lines.push(`Recent ${recent.length} turns`);
  lines.push('* = on current active branch  |  values are aggregate (running) totals');
  for (let i = 0; i < recent.length; i += 1) {
    const m = recent[i];
    const label = `#${String(m.sequence).padStart(2, ' ')}${m.isOnActiveBranch ? '*' : ' '}`;
    lines.push(`${label} ${formatPercent(cumSeries.cumHitPercent[startIdx + i]).padStart(6, ' ')}  aggIn ${formatInt(cumSeries.cumInput[startIdx + i]).padStart(7, ' ')}  aggHit ${formatInt(cumSeries.cumCacheRead[startIdx + i]).padStart(7, ' ')}  ${m.provider}/${m.model}`);
  }
  return lines;
}

function renderCumulativeTotal(messages, chartWidth, cumSeries) {
  const lines = [];
  const chartHeight = 10;
  const { lines: chartLines, unitTokens } = renderStackedSeriesChart(
    bucketMax(cumSeries.cumInput, chartWidth),
    bucketMax(cumSeries.cumCacheRead, chartWidth),
    bucketMax(cumSeries.cumCacheWrite, chartWidth),
    chartHeight,
  );
  lines.push(...chartLines);
  lines.push(...xAxisFooter(cumSeries.cumInput.length > chartWidth ? chartWidth : cumSeries.cumInput.length, messages.length, '     '));
  lines.push('');
  lines.push(`▇ input (uncached)   ░ cache write   ▒ cache read (hit)   1 row = ${formatInt(unitTokens)} tokens`);
  lines.push('');
  const recentCount = Math.min(8, messages.length);
  const startIdx = messages.length - recentCount;
  const recent = messages.slice(-recentCount);
  lines.push(`Recent ${recent.length} turns`);
  lines.push('* = on current active branch  |  values are aggregate (running) totals');
  for (let i = 0; i < recent.length; i += 1) {
    const m = recent[i];
    const label = `#${String(m.sequence).padStart(2, ' ')}${m.isOnActiveBranch ? '*' : ' '}`;
    lines.push(`${label} aggIn ${formatInt(cumSeries.cumInput[startIdx + i]).padStart(7, ' ')}  aggWrite ${formatInt(cumSeries.cumCacheWrite[startIdx + i]).padStart(7, ' ')}  aggHit ${formatInt(cumSeries.cumCacheRead[startIdx + i]).padStart(7, ' ')}  ${m.provider}/${m.model}`);
  }
  return lines;
}

export function renderGraphBody(metrics, width, view = 'per-turn') {
  const messages = metrics.allMessages;
  const lines = [];
  lines.push(`Cache hit trend (whole session timeline) — ${graphViewLabel(view)}`);
  switch (view) {
    case 'per-turn':
      lines.push('Per-turn cache hit % = cacheRead / (input + cacheRead + cacheWrite)');
      break;
    case 'cumulative-percent':
      lines.push('Aggregate hit % = aggCacheRead / (aggInput + aggCacheRead + aggCacheWrite)');
      break;
    case 'cumulative-total':
      lines.push('Aggregate (cumulative) token volumes: ▇ input  ░ cacheWrite  ▒ cacheRead');
      break;
  }
  lines.push('');
  lines.push(formatTotalsLine('Active branch', metrics.activeBranchTotals));
  lines.push(formatTotalsLine('Whole tree', metrics.treeTotals));
  lines.push('');
  if (messages.length === 0) {
    lines.push('No assistant messages with usage data are available yet in this session.');
    return lines;
  }
  if (view === 'per-turn') {
    const latest = messages[messages.length - 1];
    lines.push([
      `Latest: ${formatPercent(latest.cacheHitPercent)}`,
      `Min: ${formatPercent(minHitPercent(messages))}`,
      `Max: ${formatPercent(maxHitPercent(messages))}`,
      `Turns: ${formatInt(messages.length)}`,
    ].join(' • '));
  } else {
    lines.push(`Turns: ${formatInt(messages.length)}`);
  }
  lines.push('');
  const chartWidth = Math.max(10, width - 8);
  const cumSeries = view !== 'per-turn' ? computeCumulativeSeries(messages) : null;
  switch (view) {
    case 'per-turn': lines.push(...renderPerTurnPercent(messages, chartWidth)); break;
    case 'cumulative-percent': lines.push(...renderCumulativePercent(messages, chartWidth, cumSeries)); break;
    case 'cumulative-total': lines.push(...renderCumulativeTotal(messages, chartWidth, cumSeries)); break;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Stats table (pi-cache-graph src/stats-view.ts port)
// ---------------------------------------------------------------------------

function pad(value, width, direction = 'right') {
  if (value.length >= width) return value;
  const padding = ' '.repeat(width - value.length);
  return direction === 'left' ? padding + value : value + padding;
}
function truncate(value, width) {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, Math.max(0, width - 1))}…`;
}

export function renderStatsBody(metrics, width = 120) {
  const lines = [];
  lines.push('Token/cache stats by assistant message');
  lines.push('B = message is on the current active branch');
  lines.push('');
  lines.push('Cumulative totals');
  lines.push(formatTotalsLine('Active branch', metrics.activeBranchTotals));
  lines.push(formatTotalsLine('Whole tree', metrics.treeTotals));
  const treeHit = summarizeHitPercent(metrics.treeTotals);
  const branchHit = summarizeHitPercent(metrics.activeBranchTotals);
  lines.push(
    `Delta (tree - branch): prompt ${formatInt((metrics.treeTotals.input + metrics.treeTotals.cacheRead + metrics.treeTotals.cacheWrite) - (metrics.activeBranchTotals.input + metrics.activeBranchTotals.cacheRead + metrics.activeBranchTotals.cacheWrite))} • ` +
    `received ${formatInt(metrics.treeTotals.output - metrics.activeBranchTotals.output)} • ` +
    `cache hit ${formatInt(metrics.treeTotals.cacheRead - metrics.activeBranchTotals.cacheRead)} • ` +
    `cache write ${formatInt(metrics.treeTotals.cacheWrite - metrics.activeBranchTotals.cacheWrite)} • ` +
    `hit-rate spread ${formatPercent(treeHit - branchHit)}`,
  );
  lines.push('');
  if (metrics.allMessages.length === 0) {
    lines.push('No assistant messages with usage data are available yet in this session.');
    return lines;
  }
  const includeEntryId = width >= 92;
  const includeTimestamp = width >= 104;
  const headerCols = [pad('#', 4, 'left'), pad('B', 1), pad('model', 24), pad('prompt', 9, 'left'), pad('recv', 9, 'left'), pad('hit', 9, 'left'), pad('write', 9, 'left'), pad('hit%', 7, 'left')];
  if (includeEntryId) headerCols.splice(2, 0, pad('entry', 8));
  if (includeTimestamp) headerCols.splice(includeEntryId ? 3 : 2, 0, pad('time', 8));
  const header = headerCols.join(' ');
  lines.push('Per-message breakdown');
  lines.push(header);
  lines.push('-'.repeat(Math.min(header.length, Math.max(20, width - 2))));
  for (const m of metrics.allMessages) {
    const cols = [
      pad(String(m.sequence), 4, 'left'),
      pad(m.isOnActiveBranch ? '*' : ' ', 1),
      pad(truncate(`${m.provider}/${m.model}`, 24), 24),
      pad(formatInt(m.input + m.cacheRead + m.cacheWrite), 9, 'left'),
      pad(formatInt(m.output), 9, 'left'),
      pad(formatInt(m.cacheRead), 9, 'left'),
      pad(formatInt(m.cacheWrite), 9, 'left'),
      pad(formatPercent(m.cacheHitPercent), 7, 'left'),
    ];
    if (includeEntryId) cols.splice(2, 0, pad(m.entryId, 8));
    if (includeTimestamp) cols.splice(includeEntryId ? 3 : 2, 0, pad(m.timestamp.slice(11, 19), 8));
    lines.push(cols.join(' '));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// CSV export (pi-cache-graph src/export.ts port)
// ---------------------------------------------------------------------------

export function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function sanitizeFileName(name) {
  const sanitized = String(name).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return sanitized.length > 0 ? sanitized : 'session';
}

const CSV_HEADERS = [
  'row_type', 'scope', 'assistant_messages', 'sequence', 'active_branch_sequence',
  'is_on_active_branch', 'entry_id', 'timestamp', 'time', 'provider', 'model',
  'model_key', 'prompt_tokens', 'received_tokens', 'cache_hit_tokens',
  'cache_write_tokens', 'total_tokens', 'cache_hit_percent', 'delta_sent_tokens',
  'delta_received_tokens', 'delta_cache_hit_tokens', 'delta_cache_write_tokens',
  'delta_hit_rate_percent', 'notes',
];

export function buildCsv(metrics) {
  const treeHit = summarizeHitPercent(metrics.treeTotals);
  const branchHit = summarizeHitPercent(metrics.activeBranchTotals);
  const rows = [
    {
      row_type: 'summary', scope: 'active_branch',
      assistant_messages: metrics.activeBranchTotals.assistantMessages,
      prompt_tokens: metrics.activeBranchTotals.input + metrics.activeBranchTotals.cacheRead + metrics.activeBranchTotals.cacheWrite,
      received_tokens: metrics.activeBranchTotals.output,
      cache_hit_tokens: metrics.activeBranchTotals.cacheRead,
      cache_write_tokens: metrics.activeBranchTotals.cacheWrite,
      total_tokens: metrics.activeBranchTotals.totalTokens,
      cache_hit_percent: branchHit.toFixed(4),
      notes: 'Matches the active-branch cumulative totals shown in /cache stats',
    },
    {
      row_type: 'summary', scope: 'whole_tree',
      assistant_messages: metrics.treeTotals.assistantMessages,
      prompt_tokens: metrics.treeTotals.input + metrics.treeTotals.cacheRead + metrics.treeTotals.cacheWrite,
      received_tokens: metrics.treeTotals.output,
      cache_hit_tokens: metrics.treeTotals.cacheRead,
      cache_write_tokens: metrics.treeTotals.cacheWrite,
      total_tokens: metrics.treeTotals.totalTokens,
      cache_hit_percent: treeHit.toFixed(4),
      notes: 'Matches the whole-tree cumulative totals shown in /cache stats',
    },
    {
      row_type: 'summary', scope: 'delta_tree_minus_branch',
      assistant_messages: metrics.treeTotals.assistantMessages - metrics.activeBranchTotals.assistantMessages,
      delta_sent_tokens: metrics.treeTotals.input - metrics.activeBranchTotals.input,
      delta_received_tokens: metrics.treeTotals.output - metrics.activeBranchTotals.output,
      delta_cache_hit_tokens: metrics.treeTotals.cacheRead - metrics.activeBranchTotals.cacheRead,
      delta_cache_write_tokens: metrics.treeTotals.cacheWrite - metrics.activeBranchTotals.cacheWrite,
      delta_hit_rate_percent: (treeHit - branchHit).toFixed(4),
      notes: 'Matches the delta row shown in /cache stats',
    },
    ...metrics.allMessages.map((m) => ({
      row_type: 'message',
      scope: m.isOnActiveBranch ? 'active_branch' : 'other_branch',
      sequence: m.sequence,
      active_branch_sequence: m.activeBranchSequence ?? '',
      is_on_active_branch: m.isOnActiveBranch,
      entry_id: m.entryId,
      timestamp: m.timestamp,
      time: m.timestamp.slice(11, 19),
      provider: m.provider,
      model: m.model,
      model_key: `${m.provider}/${m.model}`,
      prompt_tokens: m.input + m.cacheRead + m.cacheWrite,
      received_tokens: m.output,
      cache_hit_tokens: m.cacheRead,
      cache_write_tokens: m.cacheWrite,
      total_tokens: m.totalTokens,
      cache_hit_percent: m.cacheHitPercent.toFixed(4),
      notes: 'Matches a per-message row in /cache stats',
    })),
  ];
  const csvRows = [CSV_HEADERS.join(',')];
  for (const row of rows) csvRows.push(CSV_HEADERS.map((h) => csvEscape(row[h])).join(','));
  return csvRows.join('\n') + '\n';
}

function sessionBaseName(session) {
  // pi-cache-graph prefers the session name, then the session file basename.
  // DSH sessions carry neither on the object; the id is the durable identity.
  const id = session?.header?.id ?? session?.id;
  return sanitizeFileName(id ?? 'session');
}

// ---------------------------------------------------------------------------
// Shard store (pi-cache-optimizer stats persistence, simplified).
// One JSON shard per plugin instance, atomic rename, same record shape.
// ---------------------------------------------------------------------------

function todayKey(now = Date.now()) { return new Date(now).toISOString().slice(0, 10); }

function sessionHashOf(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
}

function emptyModelStats() {
  return { totalRequests: 0, hitRequests: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, totalInputTokens: 0 };
}

function newShard(instanceId, sessionId, env = process.env) {
  return {
    version: 1,
    kind: 'dsh-cache-tools-shard',
    instanceId,
    sessionHash: sessionId ? sessionHashOf(sessionId) : 'nosession',
    process: { pid: process.pid, ppid: process.ppid, instanceStartedAt: Date.now() },
    lifecycle: { state: 'active', createdAt: Date.now(), updatedAt: Date.now() },
    day: todayKey(),
    models: {},
  };
}

function readShard(path) {
  const record = readJsonSafe(path);
  if (!record || record.kind !== 'dsh-cache-tools-shard' || typeof record.models !== 'object' || record.models === null) return undefined;
  return record;
}

/** Read every valid shard for today from dir. */
export function readShards(dir = shardDir()) {
  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const shard = readShard(join(dir, name));
    if (shard) out.push(shard);
  }
  return out;
}

function modelKeyOf(provider, model) { return `${provider}/${model}`; }

/**
 * Fold shards into an aggregate. `mode` selects the scope:
 *  - 'process': only the passed instance shard
 *  - 'session': today's shards whose sessionHash matches
 *  - 'total': all valid shards for today
 */
export function aggregateShards(shards, { mode, sessionHash, instanceId, day }) {
  const byModel = new Map();
  const contributors = new Set();
  for (const shard of shards) {
    if (day && shard.day !== day) continue;
    if (mode === 'process' && shard.instanceId !== instanceId) continue;
    if (mode === 'session' && shard.sessionHash !== sessionHash) continue;
    for (const [key, entry] of Object.entries(shard.models ?? {})) {
      const stats = entry?.stats;
      if (!stats) continue;
      let agg = byModel.get(key);
      if (!agg) {
        agg = { provider: entry.provider ?? key.split('/')[0], modelId: entry.modelId ?? key.slice(key.indexOf('/') + 1), api: entry.api, ...emptyModelStats() };
        byModel.set(key, agg);
      }
      agg.totalRequests += stats.totalRequests ?? 0;
      agg.hitRequests += stats.hitRequests ?? 0;
      agg.cachedInputTokens += stats.cachedInputTokens ?? 0;
      agg.cacheWriteInputTokens += stats.cacheWriteInputTokens ?? 0;
      agg.totalInputTokens += stats.totalInputTokens ?? 0;
      contributors.add(shard.sessionHash);
    }
  }
  return { byModel, contributors };
}

function statsLine(label, stats) {
  const hitRate = stats.totalInputTokens > 0 ? (stats.cachedInputTokens / stats.totalInputTokens) * 100 : 0;
  return `${label} ${stats.hitRequests}/${stats.totalRequests}·${formatCompact(stats.cachedInputTokens)}/${formatCompact(stats.totalInputTokens)} ${hitRate.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Execution-time helpers (pi-execution-time port)
// ---------------------------------------------------------------------------

const pad2 = (v) => String(v).padStart(2, '0');

export function formatElapsed(ms) {
  const totalSeconds = Math.max(0, ms / 1000);
  if (totalSeconds < 10) return `${totalSeconds.toFixed(1)}s`;
  const rounded = Math.floor(totalSeconds);
  const seconds = rounded % 60;
  const totalMinutes = Math.floor(rounded / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  if (hours > 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
  if (minutes > 0) return `${minutes}m ${pad2(seconds)}s`;
  return `${rounded}s`;
}

export function formatCompletedAt(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

const TASK_STATUS_KEY = 'execution-time';
const TOTAL_STATUS_KEY = 'zz-execution-time-total';
const OPT_STATUS_KEY = 'cache-optimizer';
const STEP_EVENT_TYPE = 'cache-tools/step-time';
const TASK_TICK_MS = 250;
const TOTAL_TICK_MS = 1000;

/** Register our session-event type in every reachable dsh-session copy.
 *  Same trick as dsh-working-activity's registration.js: strict readers refuse
 *  unknown non-ignorable types, and session.append() cannot set `ignorable`. */
function registerEventType() {
  const anchors = [import.meta.url, process.argv[1]].filter((a) => typeof a === 'string' && a.length > 0);
  const registered = new Set();
  const add = (req, pkg) => {
    try {
      const resolved = req.resolve(pkg);
      let key = resolved;
      try { key = realpathSync(resolved); } catch { /* keep resolved */ }
      if (registered.has(key)) return;
      registered.add(key);
      req(resolved).KNOWN_SESSION_EVENT_TYPES?.add(STEP_EVENT_TYPE);
    } catch { /* not reachable */ }
  };
  for (const anchor of anchors) {
    let req;
    try { req = createRequire(anchor); } catch { continue; }
    add(req, '@deepseek-ai/dsh-session');
    try {
      add(createRequire(req.resolve('@deepseek-ai/dsh-session-persistence')), '@deepseek-ai/dsh-session');
    } catch { /* no persistence pkg */ }
  }
}

export function apply(ctx, config = {}) {
  registerEventType();
  const log = LOG(ctx);
  const tuiStatus = () => { try { return ctx.get?.('tuiStatus'); } catch { return undefined; } };
  const tuiToast = (text, opts) => { try { return ctx.get?.('tuiToast')?.show(text, opts); } catch { return undefined; } };

  // Resolve the config object: schemastery instance (volatile refs) or plain.
  const cfg = {
    footerMode: config.footerMode?.get?.() ?? config.footerMode ?? 'session',
    footerStatus: config.footerStatus?.get?.() ?? config.footerStatus ?? true,
    executionTime: config.executionTime?.get?.() ?? config.executionTime ?? true,
    silenceRequestKeyWarning: config.silenceRequestKeyWarning?.get?.() ?? config.silenceRequestKeyWarning ?? false,
  };
  let footerMode = resolveFooterMode({ footerMode: cfg.footerMode });

  // ---- Shard writer -------------------------------------------------------
  const instanceId = randomUUID();
  const shard = newShard(instanceId, undefined);
  let sessionId;
  let shardDirty = false;
  let flushTimer;

  mkdirSync(shardDir(), { recursive: true });
  const shardPath = join(shardDir(), `${instanceId}.json`);

  function flushShard(state = shard.lifecycle.state) {
    if (state) shard.lifecycle.state = state;
    shard.lifecycle.updatedAt = Date.now();
    const tmp = `${shardPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(shard, null, 2) + '\n', 'utf8');
      renameSync(tmp, shardPath);
      shardDirty = false;
    } catch (err) {
      log(`shard flush failed: ${err?.message ?? err}`);
    }
  }
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = undefined; if (shardDirty) flushShard(); }, 5000);
    flushTimer.unref?.();
  }

  function recordUsage(provider, model, usage) {
    if (!usage) return;
    const input = usage.inputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const cacheWrite = usage.cacheWriteTokens ?? 0;
    if (input + cacheRead + cacheWrite <= 0) return;
    const key = modelKeyOf(provider, model);
    const entry = shard.models[key] ?? (shard.models[key] = {
      modelEpoch: 'initial', provider, modelId: model, modelName: model, api: undefined, stats: emptyModelStats(),
    });
    entry.stats.totalRequests += 1;
    if (cacheRead > 0) entry.stats.hitRequests += 1;
    entry.stats.cachedInputTokens += cacheRead;
    entry.stats.cacheWriteInputTokens += cacheWrite;
    entry.stats.totalInputTokens += input + cacheRead + cacheWrite;
    shardDirty = true;
    scheduleFlush();
  }

  // One provider→api lookup for /cache-optimizer doctor (llm service optional).
  async function describeRoute(provider, model) {
    const llm = ctx.get?.('llm');
    if (!llm?.resolveModelInfo) return { provider, model };
    try {
      const info = await llm.resolveModelInfo(provider, model);
      return {
        provider, model,
        name: info?.name,
        contextWindow: info?.context?.contextWindow,
      };
    } catch { return { provider, model }; }
  }

  // ---- execution-time timers ----------------------------------------------
  const sessionStartedAt = Date.now();
  let taskStartedAt;
  let taskTimer, totalTimer;
  let lastStepNo = 0;
  let stepStartAt;

  function renderTask(status) {
    const s = tuiStatus();
    if (!s || !cfg.executionTime) return;
    if (taskStartedAt === undefined) { s.set(TASK_STATUS_KEY, undefined); return; }
    const elapsed = Date.now() - taskStartedAt;
    s.set(TASK_STATUS_KEY, status === 'running' ? `⏱ ${formatElapsed(elapsed)}` : `✓ task ${formatElapsed(elapsed)} · ${formatCompletedAt(new Date())}`);
  }
  function renderTotal() {
    const s = tuiStatus();
    if (!s || !cfg.executionTime) return;
    s.set(TOTAL_STATUS_KEY, `Σ session ${formatElapsed(Date.now() - sessionStartedAt)}`);
  }
  function stopTaskTimer() { if (taskTimer) { clearInterval(taskTimer); taskTimer = undefined; } }

  function appendStepTime(agent, step, elapsedMs, completedAt) {
    try {
      agent.session.append(STEP_EVENT_TYPE, { step, elapsedMs, completedAt: completedAt.toISOString() });
    } catch { /* session closed or type unknown — drop */ }
  }

  // ---- request-key + cache diagnostics -------------------------------------
  let warnedRequestKey = false;
  const removeStreamHook = ctx.on?.('llm/stream', (options, next) => {
    // Deep-frozen loop-built request: observe only.
    if (!warnedRequestKey && options && options.sessionId === undefined && options.purpose === undefined) {
      warnedRequestKey = true;
      if (!cfg.silenceRequestKeyWarning && !envTruthy(process.env.PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY)) {
        tuiToast('cache: request carried no sessionId — provider prompt_cache_key/session-affinity may be off', { color: 'warning' });
      }
      log('llm/stream request without sessionId (prompt_cache_key affinity off for this call)');
    }
    return next();
  });

  const disposers = [];
  const on = (event, fn) => {
    const d = ctx.on?.(event, fn);
    if (typeof d === 'function') disposers.push(d);
    return d;
  };

  on('agent/created', ({ agent }) => {
    if (sessionId === undefined) {
      sessionId = agent.session?.id;
      shard.sessionHash = sessionHashOf(sessionId ?? 'unknown');
      shardDirty = true;
      scheduleFlush();
    }
    stepStartAt = Date.now();
    lastStepNo += 1;
  });

  on('session/event', (session, event) => {
    if (!event) return;
    if (event.type === 'assistant/message') {
      const src = event.data?.message?.source ?? {};
      recordUsage(src.provider ?? 'unknown', src.model ?? 'unknown', event.data?.usage);
      // A settled assistant step: complete the running step marker.
      if (cfg.executionTime && stepStartAt !== undefined) {
        appendStepTime({ session }, lastStepNo, Date.now() - stepStartAt, new Date());
        stepStartAt = undefined;
      }
      return;
    }
    if (event.type === 'step/start') {
      if (cfg.executionTime) stepStartAt = Date.now();
      return;
    }
    if (event.type === 'turn/end') {
      if (cfg.executionTime && stepStartAt !== undefined) {
        appendStepTime({ session }, lastStepNo, Date.now() - stepStartAt, new Date());
        stepStartAt = undefined;
      }
    }
  });

  // ---- footer status (agent status + tick) ---------------------------------
  on('agent/status', ({ agent, status }) => {
    if (sessionId === undefined) sessionId = agent.session?.id;
    if (!cfg.executionTime) return;
    if (status === 'running') {
      taskStartedAt = Date.now();
      stopTaskTimer();
      taskTimer = setInterval(renderTask.bind(null, 'running'), TASK_TICK_MS);
      taskTimer.unref?.();
      renderTask('running');
    } else {
      stopTaskTimer();
      renderTask('done');
      taskStartedAt = undefined;
    }
  });
  totalTimer = setInterval(renderTotal, TOTAL_TICK_MS);
  totalTimer.unref?.();
  renderTotal();

  /** Disk shards plus the live in-memory one (flushes lag up to 5s). */
  function allShards() {
    return [...readShards().filter((s) => s.instanceId !== instanceId), shard];
  }

  function publishOptimizerStatus() {
    const s = tuiStatus();
    if (!s || !cfg.footerStatus) return;
    if (footerMode.mode === 'process') {
      const agg = aggregateShards([shard], { mode: 'process', instanceId });
      const parts = [];
      for (const [key, st] of agg.byModel) parts.push(statsLine(key, st));
      s.set(OPT_STATUS_KEY, parts.length ? `· ${parts.join(' | ')}` : undefined);
      return;
    }
    const shards = allShards();
    const agg = aggregateShards(shards, { mode: footerMode.mode, sessionHash: shard.sessionHash, day: todayKey() });
    const parts = [];
    for (const [key, st] of agg.byModel) parts.push(statsLine(key, st));
    s.set(OPT_STATUS_KEY, parts.length ? `· ${parts.join(' | ')}` : undefined);
  }

  on('agent/status', ({ status }) => { if (status === 'idle') publishOptimizerStatus(); });

  // ---- /cache (pi-cache-graph port) ----------------------------------------
  // Commands mount via ctx.inject so a host that composes `commands` after us
  // still gets both registrations (cordis-optional peer pattern).
  ctx.inject?.(['commands'], (cmdCtx) => {
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'cache',
      description: 'Show cache hit graph, token/cache statistics, or export CSV',
      input: { hint: 'graph | stats | export' },
      handler: async (invocation) => {
        const sub = (invocation.rawInput || '').trim().toLowerCase() || 'graph';
        const session = invocation.agent?.session;
        if (!session) return { kind: 'error', text: 'No session.' };
        const metrics = collectCacheSessionMetrics(sessionEvents(session), activeSeqs(session));
        if (sub === 'export') {
          // CommandInvocation carries no cwd; the session header's absolute
          // cwd (dsh-session header meta) is the durable project directory.
          const dir = session.header?.cwd ?? invocation.cwd ?? process.cwd();
          const file = join(dir, `${sessionBaseName(session)}.csv`);
          try {
            writeFileSync(file, buildCsv(metrics), 'utf8');
            return { kind: 'success', text: `Exported cache stats CSV to ${file}` };
          } catch (err) {
            return { kind: 'error', text: `Export failed: ${err?.message ?? err}` };
          }
        }
        if (sub === 'stats') return { kind: 'success', text: renderStatsBody(metrics).join('\n') };
        if (sub === 'graph') return { kind: 'success', text: renderGraphBody(metrics, 100, 'per-turn').join('\n') };
        if (sub === 'graph2' || sub === 'cumulative') return { kind: 'success', text: renderGraphBody(metrics, 100, 'cumulative-percent').join('\n') };
        if (sub === 'total') return { kind: 'success', text: renderGraphBody(metrics, 100, 'cumulative-total').join('\n') };
        return { kind: 'error', text: 'Usage: /cache graph | stats | export | cumulative | total' };
      },
    }));

    // ---- /cache-optimizer (subset: stats, doctor, config footer-mode, reset) --
    cmdCtx.effect(() => cmdCtx.commands.register({
      name: 'cache-optimizer',
      description: 'Cache stats, diagnostics, and footer mode',
      input: { hint: 'stats [all] | doctor | reset | config footer-mode <mode>' },
      handler: async (invocation) => {
        const parts = (invocation.rawInput || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
        const sub = parts[0] || 'help';
        const agent = invocation.agent;

        if (sub === 'stats') {
          const scope = parts[1];
          const shards = allShards();
          const aggAll = aggregateShards(shards, { mode: 'total', day: todayKey() });
          if (scope === 'all') {
            if (aggAll.byModel.size === 0) return { kind: 'success', text: 'No local cache stats for today yet.' };
            const lines = ['All local models (today):'];
            for (const [key, st] of aggAll.byModel) lines.push(`  ${statsLine(key, st)}`);
            return { kind: 'success', text: lines.join('\n') };
          }
          const agg = aggregateShards(shards, { mode: 'session', sessionHash: shard.sessionHash, day: todayKey() });
          if (agg.byModel.size === 0) {
            return { kind: 'success', text: 'No cache stats recorded for this session yet. Counters appear after the first assistant response carries usage.' };
          }
          const lines = [`Session cache stats (footer mode: ${footerMode.mode}/${footerMode.source}):`];
          for (const [key, st] of agg.byModel) lines.push(`  ${statsLine(key, st)}`);
          return { kind: 'success', text: lines.join('\n') };
        }

        if (sub === 'doctor') {
          const route = agent ? await describeRoute(agent.provider ?? agent.session?.agentPreset ?? 'unknown', agent.model ?? 'unknown') : { provider: 'unknown', model: 'unknown' };
          const lines = [
            `Provider: ${route.provider}`,
            `Model:    ${route.model}`,
          ];
          if (route.name && route.name !== route.model) lines.push(`Name:     ${route.name}`);
          if (route.contextWindow) lines.push(`Context:  ${route.contextWindow}`);
          lines.push(`Footer:   ${footerMode.mode} (${footerMode.source})`);
          lines.push(`Shard:    ${shardPath}`);
          const agg = aggregateShards(allShards(), { mode: footerMode.mode, sessionHash: shard.sessionHash, day: todayKey() });
          const own = [...agg.byModel.entries()].find(([k]) => k.endsWith(`/${route.model}`)) ?? [...agg.byModel.entries()][0];
          if (own) {
            const st = own[1];
            const hit = st.totalInputTokens > 0 ? (st.cachedInputTokens / st.totalInputTokens) * 100 : 0;
            lines.push(`Hit rate: ${hit.toFixed(1)}% over ${st.totalRequests} requests`);
            if (hit < 30 && st.totalRequests >= 3) {
              lines.push('⚠️ Low hit rate. Check the provider accepts prompt_cache_key/session affinity (pi-ai sends both when options.sessionId is set) and that prompts are stable.');
            }
          } else {
            lines.push('No usage recorded yet for this session.');
          }
          return { kind: 'success', text: lines.join('\n') };
        }

        if (sub === 'reset') {
          for (const key of Object.keys(shard.models)) delete shard.models[key];
          shardDirty = true;
          flushShard();
          publishOptimizerStatus();
          return { kind: 'success', text: 'Local footer cache stats reset for this session. Provider-side caches are untouched.' };
        }

        if (sub === 'config' && parts[1] === 'footer-mode' && FOOTER_MODES.includes(parts[2])) {
          try {
            writePersistedFooterMode(parts[2]);
            footerMode = resolveFooterMode({ footerMode: cfg.footerMode });
            publishOptimizerStatus();
            return { kind: 'success', text: `Footer mode set to ${footerMode.mode} (persisted).` };
          } catch (err) {
            return { kind: 'error', text: `Could not save footer mode: ${err?.message ?? err}` };
          }
        }

        if (sub === 'help' || sub === 'config') {
          return {
            kind: 'success',
            text: [
              'Usage: /cache-optimizer <subcommand>',
              '  stats [all]                 — per-model cache counters (session scope, or all today)',
              '  doctor                      — active route, persisted counters, low-hit hint',
              '  reset                       — clear local counters for this session',
              '  config footer-mode MODE     — session | total | process (persisted)',
              '',
              'DSH built-ins cover the rest: pi-ai adapters send prompt_cache_key/session-affinity from the loop session id; cacheRetention is a per-provider profile knob; the TUI status line already shows live cache hit %.',
            ].join('\n'),
          };
        }
        return { kind: 'error', text: 'Usage: /cache-optimizer stats [all] | doctor | reset | config footer-mode session|total|process' };
      },
    }));
  });

  // Custom renderer for our step-time log events (transcript rows on replay).
  try {
    ctx.get('tuiRenderers')?.register(STEP_EVENT_TYPE, (payload) => {
      const d = payload ?? {};
      return { lines: [`✓ step ${d.step ?? '?'} ${formatElapsed(d.elapsedMs ?? 0)} · ${d.completedAt ? formatCompletedAt(new Date(d.completedAt)) : '?'}`] };
    });
  } catch { /* renderers seam absent */ }

  ctx.effect?.(() => () => {
    stopTaskTimer();
    if (totalTimer) clearInterval(totalTimer);
    if (flushTimer) clearTimeout(flushTimer);
    for (const d of disposers) { try { d(); } catch { /* already gone */ } }
    try { removeStreamHook?.(); } catch { /* ok */ }
    const s = tuiStatus();
    s?.set(TASK_STATUS_KEY, undefined);
    s?.set(TOTAL_STATUS_KEY, undefined);
    s?.set(OPT_STATUS_KEY, undefined);
    flushShard('closed');
  }, 'dsh-cache-tools teardown');

  log(`loaded (footer=${footerMode.mode}, execTime=${cfg.executionTime})`);
}
