# @zhengjunyao/dsh-restart

English | [中文](README.zh.md)

A restart button for DeepSeek Harness. Installing or updating a plugin changes
host-side code, and only a fresh `dsh web` process picks it up — that used to
mean going back to a terminal. Now it is one click in the Web GUI: the page
reconnects on its own, and **if the new process fails to boot, the error is
shown right there** (an in-page overlay, plus a recovery console on its own port
that stays up even when DSH is dead).

**An agent cannot restart DSH on its own.** The `dsh_restart` tool only files a
request; it takes your click on 「批准并重启」 in the panel to actually run (see
"Human approval gate" below).

## Why

A self-restart is the moment things go wrong invisibly: the tab loses its
server, the new process crashes, and the only trace is in a terminal you already
left. `dsh-restart` handles all of that — and, now that agents can call tools,
one more: **an agent restarting the host and telling you afterwards**, which is
why a restart request waits for your click by default.

## Features

- **One click**: the settings card 「重启」 and a sidebar entry next to your other
  plugin entries. *A human click needs no second confirmation — the click is the
  consent.*
- **Human approval gate (on by default)**: when an agent calls `dsh_restart`,
  **nothing is restarted**. It files a request
  (`~/.dsh/dsh-restart/pending-approval.json`, valid for 15 minutes by default),
  which shows up in three places at once:
  - a **red confirmation card** in the settings panel — reason, requester,
    submission time, a live countdown, and two buttons:
    「批准并重启」 / 「拒绝，保持运行」;
  - a **red dot** on the sidebar restart icon (visible without opening anything);
  - a **macOS desktop notification**.
  Until you click, the host does nothing at all; an unanswered request simply
  expires. Approving is **single-use**: the request is deleted before the restart
  starts, so a repeated click or a replayed request can never restart twice.
- **Two strategies, auto-detected** — when the host is a launchd job
  (`com.dsh.web`, `KeepAlive`), the helper delegates with
  `launchctl kickstart -k` and only *observes* (spawning our own host would race
  the job for the port); otherwise it relaunches the exact same command
  (argv / cwd / env / Node flags) after waiting for the port to be *actually*
  released, instead of guessing with a fixed delay.
- **The new process's stdout+stderr stream into a log**, the lines that look like
  errors are lifted out, and the helper's recovery console
  (`http://127.0.0.1:3099` by default, CORS-open) keeps answering after DSH is
  gone — showing phase, boot log, error lines and exit code, with a one-click
  retry.
- **Auto-reconnect**: the page probes `/api/dsh-restart/probe` and reloads itself
  as soon as the new host answers (`autoReload`, on by default).
- **Failure handling**: error lines are detected (Error / EADDRINUSE /
  MODULE_NOT_FOUND / stack frames), the boot log is shown in the overlay, and
  `maxAttempts` (default 2) automatic retries run before giving up.
- **Readiness is not "the port answers"**: `dsh web` binds its port before the
  plugin tree loads, so the helper only reports ready once the port answers,
  the process is still alive, and the boot output carries no fatal line — held
  over `readyConfirmMs` (4s) first, then watched for `bootWatchMs` (30s) so a
  host that reports ready and dies seconds later is reclassified as a failed
  restart instead of a silent success.
- **Agent tools**:
  - `dsh_restart_status` (read-only): host pid/port/version/uptime/command,
    helper phase and failure, recent restarts, the boot log's error lines, and
    **whether a restart request is currently waiting for you**;
  - `dsh_restart`: still requires `confirm: true`, but that flag is only the
    caller describing itself — it proves nothing and unlocks nothing. With the
    gate on, the tool files a request and tells the agent to send you to the
    panel.
- **Stale-tab recovery**: a restart's failure state lives in the page, so once the
  host is back (or launchd rescued it) the page clears that leftover "boot
  failed" text by itself — it keeps probing a failed state, re-checks on focus,
  and drops a persisted failure the moment the host answers.
- **Fresh-token self-heal**: every `dsh web` boot mints a new launch token, so an
  old tab's URL is refused with 401 once its cookie is gone. The page then swaps
  the current process's token for a cookie **in place** (same authority as the
  tab, no navigation) and reloads only after the tab really authenticates — a
  restart ends with the app back on screen, not with an address to copy. If even
  that fails it falls back to the clickable **「用新 token 地址打开」** link, so a
  dead cookie can never turn a reload into the host's plain-text 401 page.
- **Bookmarkable entry**: `GET /api/dsh-restart/goto` always answers 303 with a
  *relative* Location carrying the current process's token, so the one URL that
  never expires is also the one that works on any authority.
- **The waiting overlay says don't reload manually** (the port is dead for
  ~3–5s, then the page returns by itself): refreshing inside the restart window
  lands on `ERR_CONNECTION_REFUSED`, where the browser has replaced the page and
  no client-side recovery can run.
- **History** at `~/.dsh/dsh-restart/history.json` (a user-approved restart is
  recorded as `source: "user-approved"`), logs under
  `~/.dsh/dsh-restart/logs/`, config at `~/.dsh/dsh-restart.json` (0600).

## Install

1. Install the plugin (npm for releases, `link:` for local development, or from
   GitHub):

   ```sh
   dsh plugin --profile web add @zhengjunyao/dsh-restart   # npm
   dsh plugin --profile web add link:/path/to/dsh-restart  # local development
   dsh plugin --profile web add github:zhengjy01/dsh-restart
   ```

   **Expected**: the command succeeds and `@zhengjunyao/dsh-restart` appears in
   `~/.dsh/profiles/web/package.json` dependencies.

2. Restart DSH once so the host half loads — **the last manual restart you
   need**; from then on, restart from the panel.

   **Expected**: the page reconnects and reloads itself; a restart icon appears
   in the left sidebar and a 「重启」 card in the settings page.

> **Screenshot slot 1 — what it looks like after install**
> Capture: the settings card at 「设置 → 插件配置 → Web 插件 → 重启」, expanded
> (host pid, version, launch command, restart history, collapsed settings).
> Range: the whole card, ~680px wide. **No redaction needed** (it holds a local
> port and pid, no token).
> Suggested file: `docs/images/dsh-restart-01-panel.png`
> After adding it, replace this block with:
> `![Restart panel](docs/images/dsh-restart-01-panel.png)`

3. Verify it works: the panel shows host facts and the last boot log, which means
   both halves loaded.

> **Screenshot slot 2 — sidebar entry in its shared row**
> Capture: the sidebar's bottom row with this restart icon beside the other
> plugin entries (hovering shows the title 「重启 DSH」).
> Range: just that row, not the whole window. **No redaction needed.**
> Suggested file: `docs/images/dsh-restart-02-sidebar.png`
> After adding it: `![Sidebar entry](docs/images/dsh-restart-02-sidebar.png)`

## Usage

### Restarting it yourself

1. Open 「设置 → 插件配置 → Web 插件 → 重启」 (or click the sidebar restart icon).
2. Click 「立即重启」: the overlay appears with the phase (dispatch → old process
   exits → new host boots → ready) and the elapsed time; the new host answers and
   the page reloads itself. If it fails to boot, the overlay shows `Error: …`
   plus the log tail, with buttons to copy the error, ask the helper to retry, or
   open the recovery console.
3. The panel also shows host facts, the last boot log (with error lines),
   restart history and plugin settings.

### When an agent asks for a restart (the approval gate)

1. An agent in some session calls `dsh_restart` → nothing restarts; it only files
   a request, and its reply tells you to go confirm it.
2. You get the macOS notification, the red dot on the sidebar icon, and the red
   card in the panel.
3. Open the panel, check the **reason** and the **requester**, then pick:
   - **批准并重启** — restarts as above; the request is consumed and cannot run twice;
   - **拒绝，保持运行** — the request is dropped and the host is untouched.
4. Doing nothing is also fine: after `approvalTtlMinutes` (15 by default) the
   request expires.

> **Screenshot slot 3 — the approval card (the star of this feature)**
> Capture: the red-bordered card 「有一个会话请求重启 DSH（尚未执行）」 showing the
> **reason**, the **requester**, the **countdown**, and both buttons.
> Range: the card itself, including the countdown badge in its top-right corner.
> Redaction: mask the current user name or personal paths if they appear in the
> reason or requester.
> Suggested file: `docs/images/dsh-restart-03-approval-card.png`
> After adding it: `![Approval card](docs/images/dsh-restart-03-approval-card.png)`

> **Screenshot slot 4 — sidebar badge and desktop notification**
> Capture (a pair is fine): ① the red dot on the sidebar restart icon; ② the
> macOS notification 「DSH：有一个重启请求，等你确认」 in Notification Center.
> Redaction: mask any home path / user name inside the notification text.
> Suggested file: `docs/images/dsh-restart-04-badge-and-notification.png`
> After adding it: `![Badge and notification](docs/images/dsh-restart-04-badge-and-notification.png)`

> **Screenshot slot 5 — recovery console when a boot fails**
> Capture: the in-page overlay with `Error: …` and the log tail, or the
> `http://127.0.0.1:3099` recovery console.
> Redaction: mask absolute paths and the user name in the log.
> Suggested file: `docs/images/dsh-restart-05-recovery-console.png`
> After adding it: `![Recovery console](docs/images/dsh-restart-05-recovery-console.png)`

## Configuration

`~/.dsh/dsh-restart.json` (0600; seeded from the plugin row on first load, and
editable from the panel):

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch (off = no routes, no tools) |
| `announceToAgent` | `true` | Announce the plugin's tools and behaviour in the system prompt |
| `entry` | `sidebar` | Entry point: `sidebar` / `ball` / `both` / `off` |
| `requireApproval` | `true` | **Must an agent-requested restart wait for your click?** Turning it off restores the old "confirm and go" behaviour (not recommended — it removes the gate) |
| `approvalTtlMinutes` | `15` | How long a pending request stays actionable (1–120; it expires after that) |
| `notifyOnApproval` | `true` | Post a macOS desktop notification when a request is filed (darwin only) |
| `restartMode` | `auto` | `auto` (delegate when launchd manages the host) / `launchd` (force; errors when no job) / `helper` (force self-relaunch) |
| `fallbackPort` | `3099` | Recovery-console port (tries +1…+9 when busy) |
| `bootTimeoutMs` | `120000` | How long a boot may take before the attempt fails |
| `maxAttempts` | `2` | Launch attempts per restart request |
| `killGraceMs` | `6000` | Grace period before the helper SIGKILLs the old host |
| `portFreeTimeoutMs` | `25000` | How long to wait for the old host to release its port |
| `lingerMs` | `4000` | How long the helper keeps its console up after readiness |
| `readyConfirmMs` | `4000` | Stability window after the port answers before "ready" (0 = skip) |
| `bootWatchMs` | `30000` | Window to reclassify a reported-ready-then-dead boot as a failure (0 = skip) |
| `logLines` | `200` | Lines of boot log kept for display |
| `autoReload` | `true` | Reload the page once the new host answers |
| `showOverlay` | `true` | Show the full-screen overlay while restarting |
| `probeIntervalMs` | `1200` | Reconnect probe interval |
| `historyLimit` | `30` | Restart records kept |

## HTTP surface

All loopback-only (127.0.0.1 / ::1) and same-origin, matching the other `dsh-*`
panels — everything below lives under `/api/dsh-restart/`:

| Method | Path | Meaning |
| --- | --- | --- |
| GET | `/status` | Host + helper + config + history + the pending request |
| GET | `/probe` | Tiny liveness probe (polled hard while reconnecting) |
| GET | `/auth` | This process's fresh token URL (**deliberately cookie-free**, still loopback-only) |
| GET | `/goto` | **Bookmarkable entry**: 303 to the current token (relative, so cookies stay on this authority) |
| POST | `/restart` | Hand over the restart; replies 202 before this process exits (the panel button uses this) |
| GET | `/approval` | The pending agent request + its deadline + the gate switch |
| POST | `/approval` | Your decision: `{ id, decision: "approve" \| "deny" }`. Approve **consumes the request first**, then hands over |
| GET | `/logs` | Boot-log tail + the lines that look like errors |
| GET | `/history` | Restart records |
| POST | `/config` | Patch the config / `reset: true` |
| GET | `/helper` | Live helper state, read through the host |
| POST | `/helper/retry` | Ask a failed helper to try again |

## How it works

```
you click 「立即重启」 (a human click is the consent)
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

an agent calls dsh_restart (gate on)
      │ files pending-approval.json only (no restart)
      ▼
  sidebar badge + desktop notification + approval card
      │ you click 「批准并重启」
      ▼
  POST /api/dsh-restart/approval ──▶ consume the request (single-use) ──▶ the path above
                                                                          (source=user-approved)
```

## Compatibility

- **Requires** DeepSeek Harness **≥ 0.1.5-rc.1** (declared as `dsh.engines.dsh`).
- **Verified against**: **0.1.5-rc.1** and **0.1.7-rc.2** on macOS with Node
  25.8.1 — host half, browser half and a real restart.
- **Platforms**: only **macOS** has actually been exercised. When the host is
  launchd-managed, the helper delegates with `launchctl kickstart -k`; elsewhere
  it falls back to relaunching the same command itself (the launchd path is
  platform-guarded; Linux and Windows are untested). The desktop notification is
  macOS-only as well (elsewhere it is silently skipped — the request itself is
  still on disk).
- Compatibility is also derived from the union of the `@deepseek-ai/dsh-*`
  `peerDependencies` ranges, which is what the plugin market displays. **Since this version** the `peerDependencies` range explicitly declares compatibility with **DSH 0.2.0-rc.2** (`^0.2.0-rc.2` is now included), so no compatibility warning appears on 0.2.0-rc.2. No functional change.

## Tests

```sh
pnpm test    # 275 assertions across eight suites
```

- `smoke` — config store round-trip and clamping, history, log tailing with error
  detection, launch signature, host identity;
- `approval` — **the gate**: 0600 on disk, a newer request replaces an older one,
  a mismatched id must not execute, approving is single-use (a replay does
  nothing), denying leaves no residue, **an expired request never restarts**,
  empty state is a no-op;
- `helper` — the real helper against fake hosts: crash capture + console + manual
  retry, and a successful relaunch, plus the three readiness edges (crash after
  the port answers, silent exit after the port answers, and an error-shaped
  health-check noise line that must not be mistaken for a failure);
- `routes` — synthetic req/res across every route, including the
  loopback/cross-site/method guards and the connection→token-URL wiring;
- `handoff` — end-to-end on fake ports: restart → old process really exits →
  helper relaunches generation 2 → the port answers with a new pid;
- `launchd` — pid→job matching and observe mode (which must never spawn), plus
  a boot-fatal line in the managed log that must not be reported as ready;
- `selfheal` — the real browser bundle with stubbed globals: a persisted "boot
  failed" whose host recovered is cleared on mount, and a 401 page gets the
  current token URL instead of a dead reload;
- `client` — the browser half's registration and rendering contract.

## Limits

- Only restarts: it does not install plugins or repair a profile (that is
  `dsh-doctor`'s job).
- A restart always interrupts the current turn and connection — replacing the
  host process cannot be invisible. What is guaranteed is that the interruption
  is *observable, recoverable, and its errors readable*.
- The helper registers no OS-level service; it lives for one restart and exits
  after readiness (or stays put on failure until you deal with it).
- **What the approval gate does and does not cover (honest statement)**: it
  guarantees that the *legitimate* path cannot restart on an agent's say-so — the
  tool only files a request, and your click is the only thing that turns it into a
  restart. It is **not** an adversarial sandbox: any process that can run a shell
  on this machine (including an agent) could bypass the plugin and call
  `launchctl kickstart -k com.dsh.web` directly, and this plugin does not pretend
  otherwise. It solves "a session restarted DSH and you only found out later",
  and it makes every restart carry a record of who approved it.
- `dsh_restart` still asks for `confirm: true`: that is the **caller's own
  claim**, meant to make an agent explain itself first. It is not your consent —
  your consent is the click, and `history.json` records it as
  `source: "user-approved"`.

## License

MIT
