# @zhengjunyao/dsh-restart

English | [中文](README.zh.md)

A restart button for DeepSeek Harness. Installing or updating a plugin changes
host-side code, and only a fresh `dsh web` process picks it up — that used to
mean going back to a terminal. Now it is one click in the Web GUI: the page
reconnects on its own, and **if the new process fails to boot, the error is
shown right there** (an in-page overlay, plus a recovery console on its own port
that stays up even when DSH is dead).

## Why

A self-restart is the moment things go wrong invisibly: the tab loses its
server, the new process crashes, and the only trace is in a terminal you already
left. `dsh-restart` handles all three:

- **one click** from the settings card or the sidebar entry;
- **two strategies, auto-detected** — when the host is a launchd job
  (`com.dsh.web`, `KeepAlive`), the helper delegates with
  `launchctl kickstart -k` and only *observes* (spawning our own host would race
  the job for the port); otherwise it relaunches the exact same command
  (argv / cwd / env / Node flags) after waiting for the port to be *actually*
  released, instead of guessing with a fixed delay;
- **the new process's stdout+stderr stream into a log**, the lines that look like
  errors are lifted out, and the helper's recovery console
  (`http://127.0.0.1:3099` by default, CORS-open) keeps answering after DSH is
  gone — showing phase, boot log, error lines and exit code, with a one-click
  retry.

## Features

- Settings card 「重启」, sidebar entry next to your other plugin entries, and a
  full-screen overlay while the handoff happens.
- Auto-reconnect: the page probes `/api/dsh-restart/probe` and reloads itself as
  soon as the new host answers (`autoReload`, on by default).
- Failure handling: error lines are detected (Error / EADDRINUSE /
  MODULE_NOT_FOUND / stack frames), the boot log is shown in the overlay, and
  `maxAttempts` (default 2) automatic retries run before giving up.
- Readiness is not "the port answers": `dsh web` binds its port before the
  plugin tree loads, so the helper only reports ready once the port answers,
  the process is still alive, and the boot output carries no fatal line — held
  over `readyConfirmMs` (4s) first, then watched for `bootWatchMs` (30s) so a
  host that reports ready and dies seconds later is reclassified as a failed
  restart instead of a silent success.
- Agent tools: `dsh_restart_status` (read-only) and `dsh_restart`, which demands
  `confirm: true` because the local standing rule is that DSH is never restarted
  without explicit user consent.
- Stale-tab recovery: a restart's failure state lives in the page, so once the
  host is back (or launchd rescued it) the page clears that leftover "boot
  failed" text by itself — it keeps probing a failed state, re-checks on focus,
  and drops a persisted failure the moment the host answers.
- Fresh-token guidance: every `dsh web` boot mints a new launch token, so an old
  tab's URL is refused with 401 once its cookie is gone. The page detects that
  and offers a clickable **「用新 token 地址打开」** link built from the current
  process's token, instead of reloading into the host's plain-text 401 page.
- History at `~/.dsh/dsh-restart/history.json`; logs under
  `~/.dsh/dsh-restart/logs/`; config at `~/.dsh/dsh-restart.json` (0600).

## Install

```sh
dsh plugin --profile web add @zhengjunyao/dsh-restart   # npm
dsh plugin --profile web add link:/path/to/dsh-restart
# or, from GitHub (repo tagged with the dsh-plugin topic)
dsh plugin --profile web add github:zhengjy01/dsh-restart
```

Restart `dsh web` once to load it — the last manual restart you need.

## HTTP surface

All loopback-only, same-origin, matching the other `dsh-*` panels:
`GET /status`, `GET /probe`, `GET /auth`, `POST /restart`, `GET /logs`,
`GET /history`, `POST /config`, `GET /helper`, `POST /helper/retry` — all under
`/api/dsh-restart/`. `GET /auth` is intentionally cookie-free (still loopback
only): the tab that needs the fresh token URL is the one whose token just went
stale.

## How it works

```
panel / dsh_restart
      │ POST /api/dsh-restart/restart
      ▼
  host (old process) ──writes pending-spec.json──▶ detached helper (zero deps)
      │ replies 202, SIGTERMs itself ~0.7s later              │
      ▼                                                       │ waits for the port
   process exits ─────────────────────────────────────────────┤
                                                              ▼
                                     spawns the new host with the same command
                                     (stdout/stderr → logs/<stamp>-<pid>.log)
                                                              │
                     status.json ◀── phase/progress/errors ───┤
                     http://127.0.0.1:3099 ◀── recovery console┘
                                                              │
   page polls /probe ──▶ new host answers ──▶ location.reload()┘
```

## Compatibility

- **Requires** DeepSeek Harness **≥ 0.1.5-rc.1** (declared as `dsh.engines.dsh`).
- **Verified against**: **0.1.5-rc.1** on macOS with Node 25.8.1 — host half, browser half and a real restart.
- **Platforms**: only **macOS** has actually been exercised. When the host is launchd-managed, the helper delegates with `launchctl kickstart -k`; elsewhere it falls back to relaunching the same command itself (the launchd path is platform-guarded; Linux and Windows are untested).
- Compatibility is also derived from the union of the `@deepseek-ai/dsh-*` `peerDependencies` ranges, which is what the plugin market displays.

## Tests

```sh
pnpm test    # 208 assertions across six suites
```

`smoke` (config/history/log detection/host identity), `helper` (the real helper
against fake hosts: crash capture + console + manual retry, and a successful
relaunch), `routes` (synthetic req/res, including the loopback/cross-site/method
guards and the connection→token-URL wiring), `handoff` (end-to-end on fake ports:
restart → old process really exits → helper relaunches generation 2 → the port
answers with a new pid), `launchd` (pid→job matching and observe mode, which must
never spawn), `selfheal` (the real browser bundle with stubbed globals: a
persisted "boot failed" whose host recovered is cleared on mount, and a 401 page
gets the current token URL instead of a dead reload).

## Limits

- Only restarts: it does not install plugins or repair a profile (that is
  `dsh-doctor`'s job).
- A restart always interrupts the current turn and connection — replacing the
  host process cannot be invisible. What is guaranteed is that the interruption
  is *observable, recoverable, and its errors readable*.
- The helper registers no OS-level service; it lives for one restart and exits
  after readiness (or stays put on failure until you deal with it).

## License

MIT
