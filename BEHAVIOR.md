# BEHAVIOR.md — parity checklist

Sources: pi-cache-optimizer 2.8.11 (npm, freescheme, MIT), pi-cache-graph 1.0.2
(git, Arnav Gupta, MIT), pi-execution-time 0.2.0 (git, Lukas Panni, MIT), all
enabled in the user's `~/.pi/agent/settings.json` (lines 33-35) with **no custom
plugin config** (no `pi-cache-optimizer.json`; only the stats shards exist).

DSH evidence paths are relative to `~/.local/share/dsh/npm/node_modules/` or,
for the TUI, `~/.dsh/profiles/tui/node_modules/`.

## pi-cache-optimizer

| # | Behaviour (trigger → effect, knob, edge cases) | Pi evidence | DSH mapping | Status | Test |
|---|---|---|---|---|---|
| O1 | Every OpenAI-compatible request carries a session-stable `prompt_cache_key` so provider prompt caching hits | README "What it does"; `src` openai adapters | Built-in: `@earendil-works/pi-ai` sends `prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId)` (`dist/api/openai-responses.js:230`, `dist/api/openai-completions.js:588`); the loop stamps `sessionId: this.session.id` (`@deepseek-ai/dsh-agent-loop/lib/index.js:1259`) and dsh-llm-pi-ai forwards it (`lib/index.js:1881`) | built-in | inspection (cited lines) |
| O2 | Request long cache retention when supported | README "What it does" | Built-in knob: per-provider `cacheRetention: none\|short\|long` in dsh-llm-pi-ai (`lib/types/config.d.ts:120`, schema `lib/index.js:1027`, applied `:1676`). Set in the profile, not by a plugin | built-in | inspection |
| O3 | Warn once when an OpenAI-compatible proxy lacks cache/session-affinity compat; `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY=1` silences | README commands + env table | Ported: `llm/stream` waterfall listener (dsh-llm `lib/index.js:2371`); one `tuiToast` warning when a main-loop request carries no `sessionId`; env var honored | ported (partial: Pi keys off compat flags; DSH request options are frozen, so we observe the outcome — missing sessionId — instead) | `llm/stream listener observes missing sessionId once`, `no warn when sessionId present or purpose set` |
| O4 | Durable per-process shard counters (atomic rename, no cross-process overwrite); `/cache-optimizer stats`, `stats all`, `reset` | README "Footer cache stats mode", commands table | Ported: shards under `$DSH_HOME/storages/dsh-cache-tools/shards/`, temp+rename flush on usage (5 s debounce) and dispose; commands via dsh-commands `register` (`lib/index.js:266`); live in-memory shard is merged into reads so fresh stats are visible before flush | ported | `shard round-trip + aggregate session/total scopes`, `/cache-optimizer stats reports usage`, `reset clears counters` |
| O5 | Footer stats line, scope `session` (default) / `total` / `process`; persisted via `/cache-optimizer config footer-mode`; `PI_CACHE_OPTIMIZER_FOOTER_MODE` env; precedence persisted > env > default | README "Footer cache stats mode" | Ported: `tuiStatus.set('cache-optimizer', …)` on agent idle (`dsh-tui/lib/types/dsh-adapter/status.d.ts`); precedence chain identical, persisted to `storages/dsh-cache-tools/config.json` | ported | `/cache-optimizer config footer-mode persists` |
| O6 | `/cache-optimizer doctor` — active provider/model/API + low-hit diagnosis | README commands table | Ported (subset): provider/model/context window via `llm.resolveModelInfo` (dsh-llm `lib/index.js:2098`), persisted counters, hit-rate, low-hit hint. No compat/fix advice (see O8) | ported (subset) | `/cache-optimizer doctor reports route + hit rate` |
| O7 | `enable` / `disable` runtime switches, interactive `/cache-optimizer` menu, Tab completion, `stats contributors` | README commands table | gap: enable/disable gate prompt-rewrite features that have no DSH seam (O8); the counters themselves are always on. No interactive-menu or Tab-completion seam in dsh-commands (hint-only `input.hint`). `contributors` omitted (session-hash listing had no user-configured use) | gap | — |
| O8 | Prompt reorder, skill-listing compression, session-overview strip, deterministic tool ordering, adaptive-thinking compat, `models.json` `fix`/`rollback` | README "What it does", `fix`/`rollback` rows | gap: DSH assembles prompts declaratively (dsh-system-prompt) and `llm/stream` request options are deep-frozen before listeners run — no seam to rewrite message content or tools, and no `models.json` runtime store to fix/rollback | gap | — |
| O9 | Router-extension integration via `Symbol.for('pi.routing.registry.v1')` / `pi.cache.hints.v1` | README "What it does" | gap (not applicable): no router extensions exist in this DSH setup | gap | — |

## pi-cache-graph

| # | Behaviour | Pi evidence | DSH mapping | Status | Test |
|---|---|---|---|---|---|
| G1 | `/cache graph` — per-turn cache-hit % over the session timeline, latest/min/max, recent-turn list with active-branch markers | README `/cache graph`; `src/graph-view.ts` | Ported: `collectCacheSessionMetrics` over `session.snapshotEvents()` (dsh-session `lib/index.js:1336`), active branch = `session.surface.nodes` seqs (`:558`, "Surface event sequences in model-visible order"); text bar chart as command result | ported (presentation differs: Pi used a scrollable themed overlay; DSH command results are sanitized text) | `renderGraphBody per-turn renders chart + summary` |
| G2 | Cumulative views (aggregate %, aggregate totals) | `src/cumulative.ts` | Ported: `/cache cumulative`, `/cache total` | ported | `renderGraphBody cumulative views` |
| G3 | `/cache stats` — per-message table + tree/branch cumulative totals + delta row; hit % = cacheRead / (input + cacheRead + cacheWrite) | `src/stats-view.ts`, `src/cache-math.ts` | Ported; usage fields `inputTokens/cacheReadTokens/cacheWriteTokens` match the DSH harness shape (dsh-llm-pi-ai `mapUsage`, `lib/index.js:1368-1376`) | ported | `collectCacheSessionMetrics folds assistant/message usage`, `renderStatsBody renders table + totals`, `/cache stats prints table` |
| G4 | `/cache export` — CSV with 3 summary rows + per-message rows, `session-name.csv` at project root | `src/export.ts`, README | Ported; filename uses `session.header.id` (DSH sessions carry no display name), directory is `session.header.cwd` (validated absolute, dsh-session `lib/index.js:1004-1006`) — CommandInvocation has no cwd | ported | `buildCsv emits summary + message rows`, `/cache export writes CSV to cwd` |

## pi-execution-time

| # | Behaviour | Pi evidence | DSH mapping | Status | Test |
|---|---|---|---|---|---|
| T1 | Live `⏱ 4.2s` task timer in the footer while the agent runs | README Usage | Ported: `agent/status` running/idle (`@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:90` `'idle'\|'running'`), 250 ms tick, `tuiStatus` key `execution-time` | ported | `agent/status running sets ⏱ status, idle sets ✓` |
| T2 | `✓ task 18s · 17:42` kept after completion (local HH:mm) | README Usage | Ported, same key | ported | same test |
| T3 | `Σ session 12m 04s` total timer, 1 s tick | README Usage | Ported, `tuiStatus` key `zz-execution-time-total` | ported | dispose test clears key |
| T4 | `✓ step 1 18s · 17:42` rows rendered in the transcript; survive reload/replay | README Usage; pi message renderers | Ported: plugin appends `cache-tools/step-time` session events and registers a text renderer via `ctx.tuiRenderers.register` (`dsh-tui/lib/types/dsh-adapter/renderers.d.ts:30`, result `{lines}`). The event type is added to `KNOWN_SESSION_EVENT_TYPES` (dsh-session `lib/index.js:79`, exported `:1893`) because the JSONL persistence reader admits only known types (`dsh-session-persistence-jsonl/lib/index.js:1093`) | ported | `step completion appends cache-tools/step-time event`, `renderer registered for step-time events` |
| T5 | Steering messages ignored for step history; durations `1m 05s` / `1h 02m 03s` | README Usage | Ported (partial): step timer runs `step/start` → `assistant/message`/`turn/end` settle, so mid-turn steering never emits a row. Formatting identical | ported (partial: trigger is step settle, not "completed standard user prompt") | `formatElapsed matches pi-execution-time shapes` |

## DSH built-ins that already cover adjacent Pi behaviour

- Live cache-hit % in the status line: `formatCacheHitRate` in
  `@deepseek-harness-tui/dsh-tui/lib/types/screens/StatusLine.js:428` (used
  `:150`, `:371`). Our footer shard line complements it with per-day
  cross-process counters, same as the Pi setup had both.

## Gap summary

1. **O8** prompt rewrites / tool ordering / models.json fix+rollback — no seam:
   `llm/stream` options are deep-frozen before listeners; no runtime model-catalog store.
2. **O7** enable/disable switches, interactive menu, Tab completion, `stats contributors`.
3. **O9** router-extension `Symbol.for` protocols — not applicable to this setup.
4. Presentation deltas (not functional gaps): graphs render as command-result
   text instead of a scrollable overlay; step-time rows trigger on step settle
   instead of completed user prompts.
