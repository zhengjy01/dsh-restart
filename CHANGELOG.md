# Changelog

本文件记录 `@zhengjunyao/dsh-restart` 的所有可见变更。版本纪律：破坏性变更不得走 patch（0.x 走 minor、1.x+ 走 major）。

## [Unreleased]

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
