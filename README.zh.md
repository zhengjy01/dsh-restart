# @zhengjunyao/dsh-restart

[English](README.md) | 中文

> **本仓库是 fork**：[`zhengjy01/dsh-restart`](https://github.com/zhengjy01/dsh-restart) 的内部镜像，
> 仅加一个 `trustedOrigins` 配置，让本面板在**反向代理 + 自有域名**部署下可用
> （上游对 `Host` 的钉死会让这类部署的每个请求回 403，见
> [upstream#1](https://github.com/zhengjy01/dsh-restart/issues/1)）。
> 除该配置外与原项目一致；上游合并后应切回上游。安装用本仓库地址。


给 DeepSeek Harness 装一个「重启」按钮：装完/更新插件后不用再回终端敲命令，
在 Web GUI 里点一下就把 DSH 重启了——页面自己重连、自己刷新；**如果新进程起不来，
它会把报错直接显示出来**（页内遮罩 + 一个独立端口的恢复控制台）。

**Agent 不能自己把 DSH 重启掉。** `dsh_restart` 工具只提交一个「重启请求」，
必须在面板上亲手点「批准并重启」才会真的执行（见下面的「用户批准闸门」）。

## 为什么需要它

宿主侧的插件代码（`lib/index.js`、bundle 清单、`dsh.client` 清单）只有换一个
`dsh web` 进程才会生效，所以每次装插件都得手动重启一次。而这个「手动重启」本身
是最容易出事的环节：

- 重启后进程起不来 → 浏览器一片空白，看不到任何原因；
- 新进程崩溃/端口占用 → 只有终端能看见报错；
- 重启期间页面直接失联 → 只能靠人手刷新。

`dsh-restart` 把这三件事都接住了。而在 agent 也能调工具之后，还多出第四件事：
**agent 顺手就把 DSH 重启了、你事后才知道**——所以重启请求默认要你点确认。

## 能力

- **一键重启**：设置页「重启」卡片、左侧边栏「重启」入口（与其它插件入口并排），
  点一下即完成交接。**本人在面板上点击不需要二次确认——点击本身就是同意。**
- **用户批准闸门（默认开）**：agent 调 `dsh_restart` **不会重启任何东西**，
  只落一个待批准请求（`~/.dsh/dsh-restart/pending-approval.json`，默认 15 分钟有效）。
  请求会同时出现在三处：
  - 设置页「重启」卡片里的**红色确认卡**：原因、发起方、提交时间、剩余有效时间（倒计时），
    以及「批准并重启」/「拒绝，保持运行」两个按钮；
  - 侧边栏重启图标上的**红点**（不打开面板也看得见）；
  - 一条 **macOS 桌面通知**。
  在你点之前宿主不会有任何动作，超时未处理请求自动作废。批准是**一次性消费**：
  请求先被删除再执行，所以重复点击、重放请求都不会重启两次。
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
- **Agent 工具**：
  - `dsh_restart_status`（只读）：宿主 pid/端口/版本/启动时长/启动命令、助手阶段与失败原因、
    最近重启记录、上次启动日志里的疑似报错行，**以及当前有没有待你确认的重启请求**；
  - `dsh_restart`（提交重启请求）：仍需传 `confirm: true`，但那只是**调用方的自我声明**，
    不代表你同意、也不解锁任何东西——闸门开着时它只会提交请求并告诉你「去点确认」。
- **旧标签页自愈**：重启失败态只存在于页面（内存 + sessionStorage），所以宿主恢复后
  （自己起来的、或 launchd 救回来的）残留的「启动失败」文案必须自己消失——页面在失败态
  持续探测、标签页重新获得焦点时立刻复查、宿主一应答就丢掉持久化的失败记录，不需要用户刷新。
- **401 原地换回登录**：每次 `dsh web` 启动都换一个 launch token，旧标签页 URL 里的旧
  token 在 cookie 失效时会被 401 拒。页面会 `HEAD /` 检出 401，并从**免 cookie 的插件路由**
  取回本进程当前的 token，然后**在原地**（同一 authority、不跳转）发一次交换请求把 cookie
  换回来，重新校验确认已认证后才让页面自己刷新回应用——一次重启结束时页面是**自己回来的**，
  不用复制地址开新标签页。交换失败时才回落到可点击的**「用新 token 地址打开」**链接，所以
  cookie 存不下也不会把页面带进宿主的纯文本 401 页。
- **永久入口（可收藏）**：`GET /api/dsh-restart/goto` 永远 303 到本进程当前 token（相对地址）。
  把它收藏起来就是「永远能进站的那条地址」——cookie 没了、停在纯文本 401 页、重启期间手刷过头，
  点一下都能回来；401 卡片的主按钮与复制按钮给的就是它。
- **等待期提示「请勿手动刷新」**：重启窗口里自己按刷新会落进浏览器的 `ERR_CONNECTION_REFUSED`
  （那一刻页面已被浏览器错误页替换，插件救不了），所以提示写明「端口会先空约 3–5 秒，本页会自己回来」。
- **重启历史**：`~/.dsh/dsh-restart/history.json` 记录每次重启的时间、来源、原因、
  新旧 pid 与日志路径。经你批准的重启记为 `source: "user-approved"`。

## 安装

1. 安装插件（本地开发用 `link:`，发布版用 npm，也可以从 GitHub 装）：

   ```sh
   dsh plugin --profile web add @zhengjunyao/dsh-restart   # npm
   dsh plugin --profile web add link:/path/to/dsh-restart  # 本地开发
   dsh plugin --profile web add github:zhengjy01/dsh-restart
   ```

   **预期结果**：命令返回成功，`~/.dsh/profiles/web/package.json` 的依赖里出现
   `@zhengjunyao/dsh-restart`。

2. 重启一次 DSH 让宿主侧代码加载（**这一次是最后一次手动重启**；装完以后再要重启，
   直接点面板按钮即可）。

   **预期结果**：页面自动重连、自动刷新；左侧边栏出现重启图标，设置页出现「重启」卡片。

> **截图位 1｜装完的样子**
> 截：设置页「设置 → 插件配置 → Web 插件 → 重启」展开后的卡片（能看到宿主 pid、版本、
> 启动命令、重启记录、插件设置折叠区）。
> 范围：整个卡片，宽度约 680px；**无需打码**（里面是本机端口与 pid，不含 token）。
> 建议文件名：`docs/images/dsh-restart-01-panel.png`
> 补图后把本引用块替换成：`![重启面板](docs/images/dsh-restart-01-panel.png)`

3. 验证能用：面板里能看到宿主信息与「上次启动日志」，说明宿主半与客户端半都加载成功。

> **截图位 2｜侧边栏入口 + 并排的那一行**
> 截：左侧边栏底部、与其它插件入口同一行的重启图标（悬停时 title 应显示「重启 DSH」）。
> 范围：只截那一行，别带整页；**无需打码**。
> 建议文件名：`docs/images/dsh-restart-02-sidebar.png`
> 补图后：`![侧边栏入口](docs/images/dsh-restart-02-sidebar.png)`

## 使用

### 你自己要重启

1. 打开「设置 → 插件配置 → Web 插件 → 重启」（或点左侧边栏的重启图标）。
2. 点「立即重启」：
   - 出现重启遮罩，显示阶段（下发指令 → 旧进程退出 → 新宿主启动 → 已就绪）与已等待时间；
   - 宿主退出（launchd 托管时由 `launchctl kickstart -k` 触发）、助手接管、新宿主起来后页面自动刷新；
   - 若新宿主起不来，遮罩里直接出现 `Error: …` 与日志尾部，可「复制报错」「让助手重试启动」
     「打开恢复控制台」。
3. 面板里还能看到：宿主信息、上次启动日志（含疑似报错行）、重启记录、插件设置。

### Agent 请求重启时（批准闸门）

1. 某个会话里的 agent 调用了 `dsh_restart` → 它**不会**重启，只提交请求；
   agent 的回复里会写明「已提交，请你去点确认」。
2. 你会同时收到：macOS 桌面通知、侧边栏图标上的红点、面板里的红色确认卡。
3. 打开面板，核对卡片上的**原因**与**发起方**，然后二选一：
   - **批准并重启**：立刻按上面的流程重启，请求被消费掉（不会被重复执行）；
   - **拒绝，保持运行**：请求作废，宿主没有任何动作。
4. 你也可以什么都不做：超过 `approvalTtlMinutes`（默认 15 分钟）请求自动作废。

> **截图位 3｜批准确认卡（本功能的主角）**
> 截：面板里红色边框的「有一个会话请求重启 DSH（尚未执行）」卡片，要能看清
> **原因**、**发起方**、**剩余时间倒计时**、两个按钮。
> 范围：卡片本体，含右上角倒计时徽标。
> 打码：若原因/发起方里出现本机用户名或个人路径，用色块盖掉。
> 建议文件名：`docs/images/dsh-restart-03-approval-card.png`
> 补图后：`![批准确认卡](docs/images/dsh-restart-03-approval-card.png)`

> **截图位 4｜侧边栏红点 + 桌面通知**
> 截（可拼两张）：①侧边栏重启图标右上角的红点；②macOS 通知中心里那条
> 「DSH：有一个重启请求，等你确认」。
> 打码：通知里的原因文本若含路径/home 用户名，请盖掉。
> 建议文件名：`docs/images/dsh-restart-04-badge-and-notification.png`
> 补图后：`![红点与通知](docs/images/dsh-restart-04-badge-and-notification.png)`

> **截图位 5｜重启失败时的恢复控制台**
> 截：新宿主起不来时的页内遮罩（显示 `Error: …` 与日志尾部），或
> `http://127.0.0.1:3099` 的恢复控制台页面。
> 打码：日志里的本机绝对路径与用户名建议盖掉。
> 建议文件名：`docs/images/dsh-restart-05-recovery-console.png`
> 补图后：`![恢复控制台](docs/images/dsh-restart-05-recovery-console.png)`

## 配置

`~/.dsh/dsh-restart.json`（0600，首次加载时按插件行种子生成；面板可改）：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关闭后不挂载路由与工具） |
| `announceToAgent` | `true` | 在系统提示里公告插件能力 |
| `entry` | `sidebar` | 入口位置：`sidebar` / `ball` / `both` / `off` |
| `requireApproval` | `true` | **agent 发起的重启是否必须由你在面板点确认**。关掉 = 恢复「confirm 即执行」的旧行为（不推荐；等于把闸门拆了） |
| `approvalTtlMinutes` | `15` | 待批准请求的有效期（分钟，1–120）。超时自动作废 |
| `notifyOnApproval` | `true` | 收到请求时发一条 macOS 桌面通知（仅 darwin） |
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
| `trustedOrigins` | `[]` | **反向代理部署**：浏览器实际访问的权威（裸 `host[:port]`，如 `dsh.example.com:7080`），列入后这些 `Host` 才被路由接纳 |

### 反向代理部署（`trustedOrigins`）

路由默认只认回环（socket 是回环 + `Host` 是回环名），这适用于浏览器直接打开 `http://127.0.0.1:<port>` 的情形。若你在前面架了反向代理（网关在边缘做 TLS 与登录，宿主仍只绑回环），浏览器发来的 `Host` 是真实域名，面板会对每个请求回 403 `forbidden: loopback-only`（宿主信息永远「读取中…」、点「立即重启」无效）。

把该权威写进 `trustedOrigins` 即可（列表项用**浏览器看到的那个权威**，与宿主 CLI 的 `--trusted-host` 一致）：

```json
{ "trustedOrigins": ["dsh.example.com:7080"] }
```

带端口的条目精确匹配该权威；不带端口的条目匹配该主机名的任意端口；写完整 Origin（`https://dsh.example.com:7080`）亦可，只有权威参与比较。通配符、带路径/查询/凭据的条目会被忽略并在日志中告警——**不会静默不匹配**。

放开一道栅栏就少一道，所以只列你确实在用的那个权威：socket 必须是回环、`sec-fetch-site: cross-site` 仍拒、`Origin` 存在时必须等于 `Host`，这三条不变；因此列入的权威只是把「同源、且来自本机」这一条件从回环 Host 扩展到你声明的 Host。**鉴权仍由你自己的部署承担**（本例是网关上的 oauth2-proxy/OIDC）——本插件不新增也不移除任何认证。

## HTTP 接口

默认 loopback-only（127.0.0.1 / ::1，同源），沿用其它 dsh-* 面板的守卫；反向代理部署经 `trustedOrigins` 追加声明权威：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dsh-restart/status` | 宿主 + 助手 + 配置 + 历史 + 当前待批准请求 |
| GET | `/api/dsh-restart/probe` | 极小存活探针（重连时高频轮询） |
| GET | `/api/dsh-restart/auth` | 本进程当前 launch token 地址（**故意不要求 cookie**，仍是 loopback-only） |
| GET | `/api/dsh-restart/goto` | **永久入口**：303 到本进程当前 token（相对地址 ⇒ cookie 换回本 authority）。可收藏、不会过期 |
| POST | `/api/dsh-restart/restart` | 交接重启，先回 202 再退出本进程（面板按钮走这条） |
| GET | `/api/dsh-restart/approval` | 当前待批准的重启请求 + 有效期 + 闸门开关 |
| POST | `/api/dsh-restart/approval` | 你的决定：`{ id, decision: "approve" \| "deny" }`。approve 会**先消费请求**再交接重启 |
| GET | `/api/dsh-restart/logs` | 启动日志尾部 + 疑似报错行 |
| GET | `/api/dsh-restart/history` | 重启记录 |
| POST | `/api/dsh-restart/config` | 改配置 / `reset: true` 恢复默认 |
| GET | `/api/dsh-restart/helper` | 经宿主读取助手实时状态 |
| POST | `/api/dsh-restart/helper/retry` | 让失败的助手再试一次 |

## 工作方式

```
你自己点「立即重启」（本人点击即同意）
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

agent 调 dsh_restart（闸门开着）
      │ 只写 pending-approval.json（不重启）
      ▼
  面板红点 + 桌面通知 + 确认卡 ──你点「批准并重启」──▶ POST /api/dsh-restart/approval
                                                      │ 先消费请求（一次性）
                                                      ▼
                                              走上图那条重启路径（source=user-approved）
```

## 兼容性

- **要求**：DeepSeek Harness **≥ 0.1.5-rc.1**（即 `package.json` 的 `dsh.engines.dsh`）。
- **实测通过**：**0.1.5-rc.1** 与 **0.1.7-rc.2**（macOS + Node 25.8.1；宿主半、客户端半、
  真实重启全流程）。
- **平台**：只在 **macOS** 上实测过。macOS 且宿主由 launchd 托管时走 `launchctl kickstart -k`；
  其它平台自动落到「分离助手自拉起」路径（代码里对 launchd 有平台守卫，Linux / Windows 未实测）。
  桌面通知也只在 macOS 上发出（其它平台静默跳过，请求本身照样落盘）。
- 兼容性判定也来自 `peerDependencies` 的 `@deepseek-ai/dsh-*` 范围并集（插件市场展示的是这一项）。 **本版起**在 `peerDependencies` 中显式声明兼容 **DSH 0.2.0-rc.2**（官方 DSH 包的版本范围已含 `^0.2.0-rc.2`），在 0.2.0-rc.2 上不会再出现兼容告警；功能与行为无变化。

## 测试

```sh
pnpm test        # 275 项断言，八个套件
```

- `tests/smoke.mjs` — 配置读写与钳制、历史、日志尾部与报错识别、启动签名、宿主信息；
- `tests/approval.mjs` — **批准闸门**：落盘权限 0600、新请求替换旧请求、id 不匹配不得执行、
  批准一次性消费（重放不再触发）、拒绝无残留、**过期请求绝不重启**、空状态是 no-op；
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
  宿主应答后自动离开失败态并刷新）与「命中 401 → 取回当前 token 地址、且不刷新进 401 页」；
- `tests/client.mjs` — 浏览器半的装配与渲染契约（入口、面板、遮罩挂在正确的槽位）。

## 边界

- 只负责「重启」这一件事：不做插件安装、不做配置修复（那是 `dsh-doctor` 的领域）。
- 重启一定会中断当前回合与连接——这是宿主进程被替换的必然结果；本插件保证的是
  **中断可见、可恢复、报错可读**，而不是「不中断」。
- 助手不会注册任何 OS 级后台服务；它就活一次重启，成功后就绪 + 保留控制台数秒即退出，
  失败时留在原地等你处理（可随时 `kill`）。
- **批准闸门挡住什么、不挡什么（诚实说明）**：它保证**正当路径**上 agent 无法自行重启——
  工具只提交请求，请求必须由你在面板点击才生效，且这一点击是唯一入口。
  它**不是**对抗性沙箱：任何能在这台机器上执行 shell 的进程（包括 agent 自己）
  理论上都可以绕开插件直接 `launchctl kickstart -k com.dsh.web`，插件不假装能阻止那种情况。
  它解决的是「某个会话顺手把 DSH 重启掉、你事后才知道」，以及「重启没有留下任何人的许可痕迹」。
- `dsh_restart` 仍需 `confirm: true`：那是**调用方的自我声明**，用来让 agent 先向你说明，
  **不构成你的许可**；真正的许可是你在面板上的那一次点击（`history.json` 会记为
  `source: "user-approved"`）。

## License

MIT
