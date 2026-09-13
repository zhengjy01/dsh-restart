# Changelog

本文件记录 `@zhengjunyao/dsh-restart` 的所有可见变更。版本纪律：破坏性变更不得走 patch（0.x 走 minor、1.x+ 走 major）。

## [Unreleased]

## [0.1.2] - 2026-09-13

### 修复 (Fixed)

- fix(home): 配置/日志路径说明与发布凭据解析认 DSH_HOME（补 v0.1.2）

### 其它 (Changed)

- chore: 对齐可移植性验证脚本到 release-kit 模板
- test(gate): 可移植性门禁新增就绪后稳定性观察（迟到崩溃 = 假成功）

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

## [0.1.1] - 2026-09-12

就绪判定从「端口应答」改为「端口应答 + 进程存活 + 启动输出无 boot 致命行」。

### 修复 (Fixed)

- **就绪判定不再只看端口**：`dsh web` 先绑端口、后加载插件树，所以「端口应答」不等于
  「宿主起来了」——2026-09-12 本机真实踩到：一次重启被报成 `ready after 4.0s`，新宿主其实
  几秒后死于 `plugin tree failed to load … timed out waiting for the writer lock`，页面跳过去
  才发现是死的。现在判定就绪需同时满足三条：端口应答、进程存活、启动输出里没有 boot 致命行
  （`plugin tree failed to load`）。
- **就绪后继续守一段**：新增 `bootWatchMs`（默认 30s）——报了就绪之后助手继续观察新宿主，
  把它「起来又死」判为启动失败，并撤回 `readyAt`（状态文件不再保留一个已经不存在的就绪声明）；
  凭证写锁超时这类慢失败（宿主自己的锁等待是 30s）现在是可见的失败，而不是静默的成功。
- **失败检测保持窄**：致命行只认 boot 阶段必死的输出，不用宽泛的报错正则——健康宿主启动时
  本来就会打印 `session/list failed` 之类的报错形状噪音，不能因此把好启动判成失败。
- **observe 模式（launchd 托管）同规**：托管路径原先也是「端口一应答就报就绪」。现在同样要
  先守住 `readyConfirmMs`，并跟随托管方的日志判断有没有 boot 致命行（宿主进程不在助手手里，
  日志就是存活性信号）；这里刻意不做长观察——把端口守住是托管方的职责，反过来给托管方
  自己的重启潮记账只会产生假失败。

### 新增 (Added)

- 新配置项 `readyConfirmMs`（默认 `4000`）与 `bootWatchMs`（默认 `30000`），均为 0 时关闭对应窗口。
- `tests/helper.mjs` 新增三个用例：宿主应答端口后才在插件上崩掉、应答端口后静默退出、
  健康宿主打印错误形状噪音（回归保护）。
- `tests/launchd.mjs` 新增一个用例：observe 模式下托管宿主的日志出现 boot 致命行时不得报就绪。

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1
- 无破坏性变更：新增配置项都有默认值，未改动路由、工具名与既有配置语义。

## [0.1.0] - 2026-09-12

首个版本。

### Added

- **一键重启**：设置页「重启」卡片 + 左侧边栏入口（与其它插件入口并排）+ 全屏重启遮罩；点一下即把重启交给分离的重启助手。
- **两种重启策略，自动识别**：
  - launchd 托管（本机默认场景）→ 助手执行 `launchctl kickstart -k`，让 launchd 自己拉起，助手退居观察者并跟随 plist 日志；
  - 非托管 → 助手用**完全相同的 argv/cwd/env** 重新拉起，等端口真正释放而不是赌固定延时。
- **自动重连**：页面探测 `/api/dsh-restart/probe`，新宿主一应答就自动刷新载入新代码；状态写 `sessionStorage`，重启中途刷新页面也能续跑（`autoReload` 可关）。
- **失败可读**：新进程 stdout/stderr 实时进日志，疑似报错行被单独挑出显示；DSH 已完全挂掉时，助手自带的恢复控制台（默认 `http://127.0.0.1:3099`，CORS 开放）仍可用（阶段/日志/报错行/退出码 + 一键重试）。
- **失败报告**：失败时写一份自包含单文件 `~/.dsh/dsh-restart/last-failure.md`，控制台 `GET /report` 与页面「复制完整报告」一键取用。
- **agent 工具**：`dsh_restart_status`（只读）、`dsh_restart`（需 `confirm: true`，重启前必须先获得用户同意）。
- 配置 `~/.dsh/dsh-restart.json`（0600）；日志 `~/.dsh/dsh-restart/logs/`；重启历史 `history.json`。

### Notes

- 插件目录按 DSH 约定解析：`DSH_RESTART_HOME` → `DSH_HOME` → `~/.dsh`。
- 同机多实例共享插件目录时，助手状态按 `oldPid`/`childPid` 判归属，不会把兄弟实例的失败算到本机头上。
- 已知限制：UI 目前为中文单语；headless / cron profile 因 `inject` 要求 `webServer` 而不会加载。
