# @zhengjunyao/dsh-restart

[English](README.md) | 中文

给 DeepSeek Harness 装一个「重启」按钮：装完/更新插件后不用再回终端敲命令，
在 Web GUI 里点一下就把 DSH 重启了——页面自己重连、自己刷新；**如果新进程起不来，
它会把报错直接显示出来**（页内遮罩 + 一个独立端口的恢复控制台）。

## 为什么需要它

宿主侧的插件代码（`lib/index.js`、bundle 清单、`dsh.client` 清单）只有换一个
`dsh web` 进程才会生效，所以每次装插件都得手动重启一次。而这个「手动重启」本身
是最容易出事的环节：

- 重启后进程起不来 → 浏览器一片空白，看不到任何原因；
- 新进程崩溃/端口占用 → 只有终端能看见报错；
- 重启期间页面直接失联 → 只能靠人手刷新。

`dsh-restart` 把这三件事都接住了。

## 能力

- **一键重启**：设置页「重启」卡片、左侧边栏「重启」入口（与其它插件入口并排），
  点一下即完成交接。
- **两种重启策略，自动识别**：
  - **launchd 托管（本机默认）**：宿主是 launchd 任务（`com.dsh.web`、`KeepAlive`）时，
    自己 spawn 一个宿主会和 launchd 抢端口，所以改为助手 `launchctl kickstart -k` 让
    launchd 自己重启，助手退居**观察者**（只等端口回来 + 跟随 plist 的 stdout/stderr 日志），
    绝不重复拉起。
  - **自拉起**：非托管宿主则由助手用**完全相同的 argv/cwd/env** 重新拉起，
    先等端口真正释放（不是赌固定延时）再 spawn，不会撞 `EADDRINUSE`。
  - 助手本身是 detached 的零依赖纯 Node ESM（`helper/restart-helper.mjs`），
    两种策略共用同一套日志/状态/控制台。
- **自动重连**：页面按配置的间隔探测 `/api/dsh-restart/probe`，新宿主一应答就自动
  刷新（`autoReload`，默认开），载入新代码。
- **报错直显**：新进程的 stdout+stderr 实时流入 `~/.dsh/dsh-restart/logs/*.log`；
  助手把疑似报错的行（Error / EADDRINUSE / MODULE_NOT_FOUND / 调用栈 …）单独挑出来，
  在页内遮罩里显示；DSH 已经完全挂掉时，助手自己的恢复控制台
  （默认 `http://127.0.0.1:3099`，CORS 开放）仍然可用，能看到阶段、启动日志、
  报错行、退出码，并可一键「重试启动」。
- **失败自动重试**：`maxAttempts`（默认 2）次内自动重试；都失败就停在那里等人工处理，
  不会把端口/日志丢掉。
- **就绪不等于端口通了**：`dsh web` 会先绑端口、后加载插件树，所以「端口应答」远早于
  「宿主真的起来了」。助手判定就绪要同时满足三条——端口应答、进程存活、启动输出里没有
  boot 致命行——并先守住 `readyConfirmMs`（默认 4s）；此后还会继续观察
  `bootWatchMs`（默认 30s），把「已经报了就绪、几秒后却自己死掉」的启动（例如凭证写锁
  等 30 秒才超时）重新判为失败，而不是留下一个假的成功。
  **launchd 托管的 observe 模式同规**：先守 `readyConfirmMs`，并跟随托管方日志判断有没有
  boot 致命行（宿主进程不在助手手里，日志就是存活性信号）；托管路径刻意不做长观察——
  守住端口是托管方的职责。
- **Agent 工具**：`dsh_restart_status`（只读：宿主 pid/端口/版本/启动时长/启动命令、
  助手阶段与失败原因、最近重启记录、上次启动日志里的疑似报错行）、
  `dsh_restart`（真正重启；**必须已获得用户同意**并传 `confirm: true`，
  否则只返回提示不执行）。
- **旧标签页自愈**：重启失败态只存在于页面（内存 + sessionStorage），所以宿主恢复后
  （自己起来的、或 launchd 救回来的）残留的「启动失败」文案必须自己消失——页面在失败态
  持续探测、标签页重新获得焦点时立刻复查、宿主一应答就丢掉持久化的失败记录，不需要用户刷新。
- **401 原地换回登录**：每次 `dsh web` 启动都换一个 launch token，旧标签页 URL 里的旧
  token 在 cookie 失效时会被 401 拒。页面会 `HEAD /` 检出 401，并从**免 cookie 的插件路由**
  取回本进程当前的 token，然后**在原地**（同一 authority、不跳转）发一次交换请求把 cookie
  换回来，重新校验确认已认证后才让页面自己刷新回应用——一次重启结束时页面是**自己回来的**，
  不用复制地址开新标签页。交换失败时才回落到可点击的**「用新 token 地址打开」**链接，所以
  cookie 存不下也不会把页面带进宿主的纯文本 401 页。
- **重启历史**：`~/.dsh/dsh-restart/history.json` 记录每次重启的时间、来源、原因、
  新旧 pid 与日志路径。

## 安装

```sh
# 本地开发
dsh plugin --profile web add @zhengjunyao/dsh-restart   # npm
dsh plugin --profile web add link:/path/to/dsh-restart
# 从 GitHub（仓库打 dsh-plugin topic）
dsh plugin --profile web add github:zhengjy01/dsh-restart
```

装完需要重启一次 `dsh web` 才会加载——**这一次是最后一次手动重启**。

## 使用

1. 打开「设置 → 插件配置 → Web 插件 → 重启」（或点左侧边栏的重启图标）。
2. 点「立即重启」：
   - 出现重启遮罩，显示阶段（下发指令 → 旧进程退出 → 新宿主启动 → 已就绪）与已等待时间；
   - 宿主退出（launchd 托管时由 `launchctl kickstart -k` 触发）、助手接管、新宿主起来后页面自动刷新；
   - 若新宿主起不来，遮罩里直接出现 `Error: …` 与日志尾部，可「复制报错」「让助手重试启动」
     「打开恢复控制台」。
3. 面板里还能看到：宿主信息、上次启动日志（含疑似报错行）、重启记录、插件设置。

## 配置

`~/.dsh/dsh-restart.json`（0600，首次加载时按插件行种子生成；面板可改）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关闭后不挂载路由与工具） |
| `announceToAgent` | `true` | 在系统提示里公告插件能力 |
| `entry` | `sidebar` | 入口位置：`sidebar` / `ball` / `both` / `off` |
| `restartMode` | `auto` | `auto`（识别到 launchd 就交给它）/ `launchd`（强制，找不到任务则报错）/ `helper`（强制自拉起） |
| `fallbackPort` | `3099` | 恢复控制台端口（被占用时自动 +1…+9） |
| `bootTimeoutMs` | `120000` | 新宿主多久没应答算这次尝试失败 |
| `maxAttempts` | `2` | 单次重启请求的启动尝试次数 |
| `killGraceMs` | `6000` | 端口迟迟不释放时，助手 SIGKILL 旧进程前的宽限 |
| `portFreeTimeoutMs` | `25000` | 等旧进程释放端口的上限 |
| `lingerMs` | `4000` | 就绪后助手退出前保留控制台的时间 |
| `readyConfirmMs` | `4000` | 端口应答后、判定「已就绪」前必须守住的稳定时长（0 = 不守） |
| `bootWatchMs` | `30000` | 已报就绪后继续观察新宿主、把「起来又死」改判为失败的时间窗（0 = 不守） |
| `logLines` | `200` | 面板/接口返回的日志行数 |
| `autoReload` | `true` | 新宿主应答后自动刷新页面 |
| `showOverlay` | `true` | 重启时显示全屏遮罩 |
| `probeIntervalMs` | `1200` | 重连探测间隔 |
| `historyLimit` | `30` | 重启历史保留条数 |

## HTTP 接口

全部 loopback-only（127.0.0.1 / ::1，同源），沿用其它 dsh-* 面板的守卫：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-restart/status` | 宿主 + 助手 + 配置 + 历史 |
| GET | `/api/dsh-restart/probe` | 极小存活探针（重连时高频轮询） |
| GET | `/api/dsh-restart/auth` | 本进程当前 launch token 地址（**故意不要求 cookie**，仍是 loopback-only） |
| POST | `/api/dsh-restart/restart` | 交接重启，先回 202 再退出本进程 |
| GET | `/api/dsh-restart/logs` | 启动日志尾部 + 疑似报错行 |
| GET | `/api/dsh-restart/history` | 重启记录 |
| POST | `/api/dsh-restart/config` | 改配置 / `reset: true` 恢复默认 |
| GET | `/api/dsh-restart/helper` | 经宿主读取助手实时状态 |
| POST | `/api/dsh-restart/helper/retry` | 让失败的助手再试一次 |

## 工作方式

```
面板 / dsh_restart
      │ POST /api/dsh-restart/restart
      ▼
  宿主（旧进程）──写 pending-spec.json──▶ 分离的助手进程（detached，零依赖）
      │ 回 202，延迟 ~0.7s 后 SIGTERM 自己                    │
      ▼                                                      │ 等端口释放
   进程退出 ─────────────────────────────────────────────────┤
                                                             ▼
                                        用完全相同的命令 spawn 新宿主
                                        （stdout/stderr → logs/<时间>-<pid>.log）
                                                             │
                     status.json ◀── 阶段/进度/报错 ──────────┤
                     http://127.0.0.1:3099 ◀── 恢复控制台 ───┘
                                                             │
   页面轮询 /probe ──▶ 新宿主应答 ──▶ location.reload() ◀─────┘
```

## 兼容性

- **要求**：DeepSeek Harness **≥ 0.1.5-rc.1**（即 `package.json` 的 `dsh.engines.dsh`）。
- **实测通过**：**0.1.5-rc.1**（macOS + Node 25.8.1；宿主半、客户端半、真实重启全流程）。
- **平台**：只在 **macOS** 上实测过。macOS 且宿主由 launchd 托管时走 `launchctl kickstart -k`；其它平台自动落到「分离助手自拉起」路径（代码里对 launchd 有平台守卫，Linux / Windows 未实测）。
- 兼容性判定也来自 `peerDependencies` 的 `@deepseek-ai/dsh-*` 范围并集（插件市场展示的是这一项）。

## 测试

```sh
pnpm test        # 208 项断言，六个套件
```

- `tests/smoke.mjs` — 配置读写与钳制、历史、日志尾部与报错识别、启动签名、宿主信息；
- `tests/helper.mjs` — **真的**跑助手：崩溃路径（捕获退出码、stderr 报错行、控制台页面、
  手动重试）、成功路径（等端口 → 拉起 → 就绪计时），以及就绪判定的三种边界：
  宿主应答端口后才在插件上崩掉（不得报就绪，且要撤回已报的就绪状态、写入失败报告）、
  应答端口后静默退出（没有任何报错行也要靠存活性判失败）、健康宿主打印错误形状的噪音
  （不得误判为失败）；
- `tests/routes.mjs` — 合成的 req/res 打全部路由，含 loopback/跨站/方法守卫，以及
  「`connection` 服务 → `/auth` 新 token 地址」的装配（无该服务时回落纯 origin）；
- `tests/handoff.mjs` — 端到端：假宿主进程 → POST 重启 → 旧进程真的退出 →
  助手用相同命令拉起第二代 → 端口重新应答（新 pid）、`restarted: true`、历史落盘；
- `tests/launchd.mjs` — launchd 识别（**按 pid 匹配 `launchctl list`**，因为 Node 会把
  `XPC_SERVICE_NAME` 改写成 `0`）+ observe 模式（助手执行 kickCommand、跟随托管方日志、
  **绝不自己 spawn**），以及托管宿主日志出现 boot 致命行时不得报就绪；
- `tests/selfheal.mjs` — 用桩替换 sessionStorage/location/fetch，驱动**真实的浏览器 bundle**：
  「构造失败态 → 宿主恢复 → 页面自愈」（挂载即清掉宿主已恢复的失败记录；失败的重启请求在
  宿主应答后自动离开失败态并刷新）与「命中 401 → 取回当前 token 地址、且不刷新进 401 页」。

## 边界

- 只负责「重启」这一件事：不做插件安装、不做配置修复（那是 `dsh-doctor` 的领域）。
- 重启一定会中断当前回合与连接——这是宿主进程被替换的必然结果；本插件保证的是
  **中断可见、可恢复、报错可读**，而不是「不中断」。
- 助手不会注册任何 OS 级后台服务；它就活一次重启，成功后就绪 + 保留控制台数秒即退出，
  失败时留在原地等你处理（可随时 `kill`）。
- `dsh_restart` 工具强制 `confirm: true`：本机规则是未经用户同意不得重启 DSH。

## License

MIT
