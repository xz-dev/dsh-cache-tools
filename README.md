# dsh-cache-tools

Cache observability and execution timers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) — one cordis plugin porting three Pi extensions:

- **pi-cache-optimizer** v2.8.11 by freescheme (MIT) — durable per-instance cache counters, `/cache-optimizer` stats/doctor/reset, footer hit-rate line.
- **pi-cache-graph** v1.0.2 by Arnav Gupta (MIT) — `/cache graph`, `/cache stats`, `/cache export`.
- **pi-execution-time** v0.2.0 by Lukas Panni (MIT) — `⏱` task timer, `Σ session` timer, per-step completion rows.

See [BEHAVIOR.md](BEHAVIOR.md) for the full per-feature parity checklist, including what DSH already provides built-in (prompt_cache_key, cacheRetention, status-line cache hit %) and what could not be ported.

## Install

```sh
node ~/.local/share/dsh/npm/node_modules/@deepseek-ai/dsh/lib/bin.js \
  plugin --profile tui add file:/path/to/dsh-cache-tools-<version>.tgz --ignore-scripts
```

The package carries `dsh.bundle.patch`, so installing it inserts the plugin row
into the profile automatically.

## Commands

| Command | Effect |
|---|---|
| `/cache graph` | Cache-hit % bar chart over the session timeline (per-turn) |
| `/cache cumulative` | Aggregate (running) hit % chart |
| `/cache total` | Cumulative token-volume chart (input / cache write / cache read) |
| `/cache stats` | Per-assistant-message token/cache table, tree vs active-branch totals, delta row |
| `/cache export` | Write the stats table as `<session-id>.csv` to the session's working directory |
| `/cache-optimizer stats [all]` | Per-model cache counters for this session (or all local shards today) |
| `/cache-optimizer doctor` | Active route, persisted counters, low-hit-rate hint |
| `/cache-optimizer reset` | Clear this session's local counters (provider caches untouched) |
| `/cache-optimizer config footer-mode session\|total\|process` | Persist footer scope |

## Status line

While the agent runs: `⏱ 4.2s`; after it settles: `✓ task 18s · 17:42`; always:
`Σ session 12m 04s`; on idle: cache counters like
`· gateway/gpt-6-luna 3/3·1.2k/1.4k 85.1%`.

## Config

All keys optional (defaults shown, matching the Pi defaults):

```yaml
- id: dsh-cache-tools
  config:
    footerMode: session        # session | total | process
    footerStatus: true         # shard counters in the status line
    executionTime: true        # task/session timers in the status line
    silenceRequestKeyWarning: false
```

`PI_CACHE_OPTIMIZER_FOOTER_MODE` and `PI_CACHE_OPTIMIZER_NO_OPENAI_CACHE_KEY`
environment variables are honored for parity with pi-cache-optimizer.

State lives under `$DSH_HOME/storages/dsh-cache-tools/` (one atomic JSON shard
per plugin instance, plus the persisted footer-mode config).

## Attribution and license

MIT © Xiangzhe. This is a port; original works:

- pi-cache-optimizer — MIT © freescheme — https://www.npmjs.com/package/pi-cache-optimizer
- pi-cache-graph — MIT © Arnav Gupta — https://github.com/championswimmer/pi-cache-graph
- pi-execution-time — MIT © Lukas Panni — https://github.com/lukaspanni/pi-execution-time
