# 故障排查（TROUBLESHOOTING）

组织方式是 **症状 → 原因 → 处置**。每条先给"怎么确认"，再给"怎么修"，避免凭印象归因。

> **通用原则：看原文，不要看印象。**
> 失败信息含糊时，人会往自己最近改过的地方归因，这是最贵的错诊模式。判 job 的死因请按三个来源：
> `claude_code_status`/`watch` 的 `substatus`、job 的 `failureDetail` **原文**、以及
> `claude_code_health` 的 `diagnostics[]`。

---

## 目录

1. [MCP 不出现：`/mcp` 里没有 claude_orchestrator](#1-mcp-不出现mcp-里没有-claude_orchestrator)
2. [工具不存在：`/mcp` 里有 server，但没有 claude_code_* 工具](#2-工具不存在mcp-里有-server但没有-claude_code_-工具)
3. [工具超时：watch 中途莫名返回失败](#3-工具超时watch-中途莫名返回失败)
4. [白名单缺失：worker 在用内置基线策略](#4-白名单缺失worker-在用内置基线策略)
5. [`claude` CLI 找不到 / 启动即失败](#5-claude-cli-找不到--启动即失败)
6. [端点不对：认证/模型相关失败](#6-端点不对认证模型相关失败)
7. [DSH：`root_missing` / `runner_missing`](#7-dshroot_missing--runner_missing)
8. [实例 registry 重复 / stale](#8-实例-registry-重复--stale)
9. [`needs_attention` 与"卡死"的区分（用 idleSeconds）](#9-needs_attention-与卡死的区分用-idleseconds)
10. [上游限流：`upstream_rate_limited` 的判别](#10-上游限流upstream_rate_limited-的判别)
11. [read-guard hook 缺失或报错](#11-read-guard-hook-缺失或报错)
12. [端口被占用](#12-端口被占用)
13. [构建过期：改了代码没生效](#13-构建过期改了代码没生效)
14. [deliverable 相关失败](#14-deliverable-相关失败)
15. [watch 挂很久 / 断线了怎么办](#15-watch-挂很久--断线了怎么办)

---

## 1. MCP 不出现：`/mcp` 里没有 `claude_orchestrator`

### 症状

Codex 的 `/mcp` 列表里**完全没有** `claude_orchestrator` 这一项。没有任何报错，看起来就像你从没配过。

### 原因（按概率排序）

1. **`enabled = false`**（最高频）。Codex 对禁用段不报错，直接当作不存在。
2. **同名段有两份**：先出现的那份是 `enabled = false`，你改的是另一份；TOML 以最后一份为准。
3. `command` / `args` 指向的路径不存在（node 路径写错、`dist/index.js` 没构建）。
4. 改完配置**没有重启 Codex**（新增 MCP server 只在重启/重载后被发现）。

### 确认

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "claude_orchestrator" -Context 0,3
```

看输出里：
- `claude_orchestrator` 出现了几次？**多于一次就是重复段。**
- 每段里 `enabled` 是什么值？

```powershell
Test-Path <ORCHESTRATOR_HOME>\dist\index.js
& "<你的 node 路径>" --version
```

### 处置

1. **删掉所有** `[mcp_servers.claude_orchestrator]` 段（含 `.env` 与 `.tools.*` 子段），只留一份。
2. 那一份里写 **`enabled = true`**。
3. 确认 `command` 是真实存在的 node 绝对路径、`args[0]` 是真实存在的 `dist/index.js`
   （或优先用 `dist/orchestrator-launcher.cjs`，若构建产物里有它）。
4. **完全重启 Codex**（不是开新会话）。

> 自检命令：把 `args` 指向的脚本手工跑一次。它应该**不报错地挂住**（MCP 走 stdio，正常表现就是等输入）：
> ```powershell
> node <ORCHESTRATOR_HOME>\dist\index.js
> # 期望：不打印错误，光标停住等你输入。Ctrl+C 退出。
> # 若这里就报错 → 问题不在 Codex 配置，而在构建或 Node 环境。
> ```

---

## 2. 工具不存在：`/mcp` 里有 server，但没有 `claude_code_*` 工具

### 症状

`claude_orchestrator` 出现在 `/mcp` 里（甚至显示已连接），但 `claude_code_start` 之类的工具就是不可调用。

### 原因

1. **工具列表是宿主侧缓存的**，MCP server 重载了但宿主没重载。
2. 上下文/工具预算把工具挤掉了（工具太多时宿主可能不全部暴露）。
3. 加载的是**旧构建**：新增了工具但没重新构建/重载。

### 确认

调用 `claude_code_health`（如果连它也不存在，见 [§1](#1-mcp-不出现mcp-里没有-claude_orchestrator)），看：

```jsonc
{
  "capabilities": { "tools": [ /* 应包含全部 9 个 */ ] },
  "reloadRequired": false,
  "diagnostic": "healthy/current"
}
```

`capabilities.tools` 来自**本进程实际注册**的工具（不是读磁盘源码），所以它是最可靠的判据：
**它里面有，就是宿主没刷新；它里面没有，就是进程没加载到新构建。**

### 处置

- `capabilities.tools` 齐全但宿主看不到 → 完全重启宿主/客户端。
- `capabilities.tools` 缺工具 → `npm run build` 后**重载 MCP**（或重启 Codex），再调 `claude_code_health` 确认
  `reloadRequired=false`。

---

## 3. 工具超时：`watch` 中途莫名返回失败

### 症状

长任务跑到一半（比如 20 分钟），`claude_code_watch` 突然返回失败/中断；但 `claude_code_status` 显示 job
其实还在正常跑。

### 原因

**`tool_timeout_sec` 小于 14400。** `claude_code_watch` 的设计就是在**一次 MCP 调用里挂起最长 4 小时
（14400 秒）**；宿主超时更小时会中途掐掉这次调用。

注意这**不是** job 失败——watch 被掐断只清 watcher，不取消 job、不改变状态。

### 确认

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "tool_timeout_sec"
```

小于 `14400` 即是原因。

### 处置

```toml
[mcp_servers.claude_orchestrator]
tool_timeout_sec = 14400
```

改完重载 MCP。异步链路的判据是**看 job 状态**，不是看那次 watch 调用有没有返回。

> 补充：`claude_code_wait` 自己封顶 240 秒（刻意的单次调用边界），所以它不需要大宿主超时。
> **只有 `watch` 需要。**

---

## 4. 白名单缺失：worker 在用内置基线策略

### 症状

**默认 `auto` 档下没有失败症状**——这是本节最重要的一句话。缺少白名单不会让 job 报错、不会让 job
停下、也不会弹审批：worker 照常跑完。区别在于你**以为**生效的那份策略并没有完全生效，实际生效的是
**你的规则 ∪ 内置基线**。所以要从**回退/补齐提示**与**策略内容**两侧去发现它，而不是等报错。

在非 `auto` 档（`review` / `normal`，或你自己把 `defaultMode` 改成了 `default`/`plan`）才表现为：
job 反复进入 `needs_attention`，`attentionDetail.tool` 是 `Read` / `Write` / `Glob` 这类**最普通**的
工具；或者 job 一直 `running` 但 `idleSeconds` 持续增长、进度不动。

### 原因

worker 的权限白名单文件缺失/不可读/JSON 损坏/`permissions.allow` 不是数组；或者文件能读、`allow`
也正常，只是 `deny` 比内置基线**窄**（例如刚把模板拷过去）。

**关键背景（三条）：** 每个 job 的 `runtime/settings/<jobId>.settings.json` 会带上权限对象。

1. **可用性：** 如果那份 settings 里没有 `permissions`，worker 的每一次工具调用都会去过一遍审批
   分类器——在 `auto` 档之外这表现为"每步都要人"，且会持续消耗额度。
2. **`allow`：** 你的授权**按原样使用，绝不替你放大**；只有文件不可用（读不到 / JSON 坏 /
   `allow` 不是数组）时才回退到一份保守的内置清单（`Read` / `Write` / `Edit` / `MultiEdit` /
   `Glob` / `Grep` / `TodoWrite`），绝不退化成空 allow 列表。
3. **`deny`：** **`deny` 永不为空，且基线只能加、不能减。** 真正生效的是
   **内置基线 ∪ 你文件里的规则**（去重；你的规则保序在前，基线补齐的按基线顺序追加）。
   - 文件里**没写** `deny`：用完整的内置默认拒绝清单（`src/config.ts` 的 `DEFAULT_WORKER_DENY`：
     批量删除 / 格式化 / 关机、按镜像名批量杀进程、`git push` / `git -C … push` / `npm publish`、
     `curl`/`wget`/`powershell`/`ssh`/`scp` 等出口、`~/.ssh` `~/.aws` `~/.npmrc` 等凭据位置、
     系统目录写入……）。
   - 文件里**写了** `deny`：你的规则**一律生效**，基线里你漏掉的会被**自动并进来**。
   - 所以随仓库发的 `templates/worker-whitelist.json`（比基线窄）被拷过去后，拿到的是**它的规则
     加上基线补齐的部分**——**只会更严，不会更松**。它触发的是 `deny_floor_added` 这条**告知性**
     提示，文字以 `worker whitelist incomplete … Nothing is broken` 开头。

### 确认

有三个可见渠道（任一条命中，就说明这一次的生效策略与"你文件里写的"不完全一致）：

1. **`claude_code_start` / `claude_code_reply` 的响应里有 `warnings[]`** —— 最直接的一条。两条形态：
   - 文件不可用：`worker whitelist unusable: <原因>…`，并写明 `allow` / `deny` 各自回退成了什么；
   - 文件可用但 `deny` 比基线窄：`worker whitelist incomplete — … misses N built-in baseline rule(s)
     (抽样 4 条…)`，结尾是 `Nothing is broken — the baseline only tightens the policy`。
   这是首选渠道。
2. **该 job 的 `runtime/logs/<jobId>.stderr.log`** 里有一行 `worker policy fallback`，写明
   `deny = your K rule(s) + M built-in baseline rule(s) the file did not carry`（K + M = 实际生效总数）。
   只在确实发生了补齐/替换时才写，每个 job 至多一行。
3. **`claude_code_health` 的 `notes`** —— 形如 `worker policy: <detail>; the built-in baseline added
   N rule(s) on top of the whitelist deny list (X total)`，给"既没看响应、也没看日志"的人兜底。

另外可以直接查文件本身：

```powershell
Test-Path "$env:USERPROFILE\.claude\worker-whitelist.json"
Get-Content "$env:USERPROFILE\.claude\worker-whitelist.json" | ConvertFrom-Json | Select-Object -ExpandProperty permissions | Select-Object allow, deny
```

> **不要依赖 supervisor 自己的 stderr。** 它由调度器以 detached + `stdio:'ignore'` 拉起，那段
> `[orchestrator] worker whitelist unusable …` 横幅在生产路径上**没有承接方**（只在手工运行
> supervisor 时可见）。回退信息请从上面三个渠道读。

### 处置

1. 装上白名单：`node tools/init.mjs` 会生成 `generated/worker-whitelist.json`，拷到默认位置
   `<HOME>/.claude/worker-whitelist.json`。**照装即可**——你写进文件的规则与内置基线取并集，
   只会得到更多保护。
2. 想放别处：设 `ORCHESTRATOR_WHITELIST_PATH`。
3. **看到 `deny_floor_added` 提示时怎么确认自己没漏东西**：它**不是故障**，含义是"你文件里的
   `deny` 少于内置基线，差额已自动补齐"。要做的是**核对**而不是补救——
   - 看 `warnings[]` 里列出的抽样规则，确认那些**你确实不想放开**（它们正是基线在替你兜的部分）；
   - 想看完整生效清单，比对 `src/config.ts` 的 `DEFAULT_WORKER_DENY` 与你的文件：**并集**就是实际
     生效的规则；
   - 想让提示消失（纯粹为了清爽），把缺的规则抄进你的文件即可——但**不抄也不影响防护**，因为并集
     照样生效。**基线只能加、不能减**，所以你不可能因为漏写而放松策略。
4. **不要为了"顺手"把 `deny` 删掉换成逐项审批。** `deny` 是 `auto` 档唯一生效的策略层；审批
   分类器会在每次调用前多发一次模型请求，经共享链路时持续超时并阻塞已批准的工作。但请一并看清
   它的定位：`deny` 是**可绕过的前缀黑名单**（换个写法、写进脚本、经 `npx` 间接调用都拦不住），
   不是沙箱。另外注意 `allow` 与 `deny` 的语义差别：**`allow` 是你的授权，按原样使用；`deny` 是
   禁令，取并集**——所以"删掉一条 `deny`"会被基线补回来（除非删的是你自己独有的那条）。

> **别把"job 状态是成功"当作"权限被约束过"的证据。** `auto` 档是 `bypassPermissions`：未命中
> `deny` 的一切操作都会照常执行，天生就没有任何一步会停下来问你。

---

## 5. `claude` CLI 找不到 / 启动即失败

### 症状

`claude_code_start` 返回 `jobId`，但 job 几乎立刻 `failed`。`failureDetail` 里有 `ENOENT`、`spawn` 之类字样。

### 原因

1. `claude` 不在 `PATH` 上（尤其是从桌面应用启动的宿主，`PATH` 与你的终端不同）。
2. `CLAUDE_CLI_NAME` 指向的路径不存在或写错。
3. **`CLAUDE_CLI_NAME` 指向的是 `.cmd` / `.bat`**（Windows 上 npm 全局安装的 `claude.cmd`）——
   详见下面「Windows 上的 `.cmd` 陷阱」。
4. **`CLAUDE_CLI_PREFIX` 里塞了多个 token**（例如把整个命令行写进去了）。
5. 路径含空格但被当成多个参数。

### 确认

```powershell
# 1. 在宿主能看到的环境里确认
Get-Command claude -ErrorAction SilentlyContinue
where.exe claude

# 2. 看 job 的死因原文
#    claude_code_status(jobId) → failureDetail / substatus
```

### 处置

- 给**绝对路径**，且该路径必须是**原生可执行文件（`.exe`）**或一个 node 脚本（见下）：

  ```toml
  [mcp_servers.claude_orchestrator.env]
  CLAUDE_CLI_NAME = "<claude 可执行文件的绝对路径>"
  ```

- `CLAUDE_CLI_PREFIX` **只放单个可执行文件路径**（允许含空格，会被当作一个 token）。它是"插在
  claude 命令之前的包装器"，不是"前置参数列表"。
- 典型报错 `spawn C:\Program ENOENT` = 路径被空格切开了 → 检查是不是把路径写进了错误的变量。

### 自检

```powershell
& "<CLAUDE_CLI_NAME 的值>" --version
```

这条命令能打印版本，**才是** worker 可能起来的必要条件——但**不是充分条件**：PowerShell 能跑
`.cmd`，调度器不一定能（见下）。

### Windows 上的 `.cmd` 陷阱（务必读完再改配置）

**实测结论：把 `.cmd` 路径写进 `CLAUDE_CLI_NAME` 一定不会工作。** 本机 Node v24.16.0 上：

```
spawnSync('C:\Users\<你>\AppData\Roaming\npm\npm.cmd', ['--version'], { shell: false })
→ error = EINVAL, status = null
```

原因是调度器**硬编码**用 `shell: false` 启动 worker（`src/supervisor.ts` 的
`spawnBackground(cmd, args, { shell: false })`）。`shell: false` 下 Node **不会**替你把 `.cmd` / `.bat`
交给 `cmd.exe` 解释，于是直接失败——而你手工在 PowerShell 里 `& "…\claude.cmd" --version` 是成功的，
这就形成了"命令行能跑、调度器不能跑"的迷惑现象（`docs/TROUBLESHOOTING.md` 这一节存在的意义）。

> ### ⛔ 永远不要为了让 `.cmd` 跑起来而启用 `shell: true`
>
> 这是本仓库里**最不能碰**的一行。worker 的 prompt 是**任意文本**（来自 leader，可能包含不可信
> 内容），并且是**尾部 argv**（`src/supervisor.ts` 里 `args.push(job.prompt)`，紧跟在
> `--add-dir=<workFolder>` 之后）。`shell: false` 是唯一让它保持"纯数据"的东西；
> 一旦改成 `shell: true`（或在 `shell: true` 下把 `.cmd` 交给 `cmd.exe` 解释），prompt 里的 `&`、
> `|`、`"`、`%VAR%` 就会**被当成命令分隔符执行**——这等于把提权路径交给任何能影响 prompt 的内容。
> 同理**不要**自己写一个转发 `%*` 的 `.cmd` / `.bat` 包装器：那等于手工把 prompt 送进 shell。
> 仓库里没有任何 `shell: true` 的生产调用点，这是审计过的有意设计。

**正确做法（三选一，按推荐顺序）：**

1. **直接用原生 `.exe`。** Windows 上 npm 全局安装的 `claude` 包已经在
   `<npm 全局目录>\node_modules\@anthropic-ai\claude-code\bin\claude.exe` 放了原生二进制（`bin` 字段
   就指向它）；`claude.cmd` 只是 160 字节的垫片，最后一行也正是去调这个 `.exe`。所以请把
   `CLAUDE_CLI_NAME` 指向那个 `.exe` 的绝对路径，而不是 `.cmd`。
2. **node 脚本形式**：把 `CLAUDE_CLI_PREFIX` 设为 `node.exe` 的绝对路径、`CLAUDE_CLI_NAME` 设为
   CLI 的 `.js` 入口绝对路径。两者都会被当成单个 token（路径可含空格），拼出的 argv 是
   `[node.exe, <cli.js>, ...]`，`shell: false` 下完全成立——测试套件就是用这个形态跑假 CLI 的。
   取 node 路径可用 `where.exe node`；`tools/init.mjs` 探测出的 `CLAUDE_CLI_PREFIX` 也是按这个语义
   设计的。
3. **走包管理器转发**：确保 `CLAUDE_CLI_NAME` 指向的是**原生可执行文件**，而不是 npm 生成的
   `.cmd` 垫片（例如用 `npm exec` 的等价物时，同样要落到 `.exe` 上）。

判定口诀：**`CLAUDE_CLI_NAME` 只接受 `.exe`（或 `.js` 入口 + `CLAUDE_CLI_PREFIX=node.exe`）。
`.cmd` / `.ps1` 一律不能直接 spawn。**

---

## 6. 端点不对：认证/模型相关失败

### 症状

job `failed`，`failureDetail` 出现认证失败、模型不存在、连接被拒之类字样。

### 原因

三种形态混淆：

| `ORCHESTRATOR_ANTHROPIC_BASE_URL` | 含义 | 常见错配 |
|---|---|---|
| **未设置（留空）** | **不注入任何端点**，worker 用 Claude CLI 自己的登录态 | —— 这是零配置的正确形态 |
| `local` 或 `auto` | 注入 `http://127.0.0.1:<port>` + 固定占位 token | 本机**没有**在跑那个代理 → 连接被拒 |
| 一个具体 URL | 注入该端点，并在 `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN` 非空时带上 token | token 没设或设成了**空串** |
| 写了 `""`（空串） | 覆盖 CLI 自己的默认值 | 官方登录态被顶掉，这是安装期第二大坑 |

另外：`ORCHESTRATOR_MODEL_*` 若指向一个你**没有权限**的模型 id，worker 会立刻失败。

### 确认

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "ORCHESTRATOR_ANTHROPIC|ORCHESTRATOR_MODEL"
```

看那份 `env` 里到底写了什么。**尤其确认有没有 `= ""` 这种写法。**

### 处置

1. **要零配置**：把 `ORCHESTRATOR_ANTHROPIC_BASE_URL` / `_AUTH_TOKEN` / `ORCHESTRATOR_MODEL_*`
   **整行删掉**，不要留空串。
2. **要用本机代理**：设 `ORCHESTRATOR_ANTHROPIC_BASE_URL = "local"`，并确认那个代理确实在监听。
3. **要用自定义端点**：设完整 URL，并设 `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN`（非空）。
4. **模型 id 不确定**：把 `ORCHESTRATOR_MODEL_*` 删掉，让 CLI 用它自己的默认模型。

> **关键事实：这些值通过 per-job 的 `--settings` 注入，且 `--settings` 的 env 块会覆盖 CLI 自己的
> `~/.claude/settings.json`，而进程环境变量不会。** 所以"我在别处设了环境变量啊"解释不了这里的
> 行为——真相在 job 的 settings 文件和那份 `env` 段里。

---

## 7. DSH：`root_missing` / `runner_missing`

### 症状

派单报 `workerBackend=deepseek-harness` 不可用；`claude_code_health` 的 capabilities 里该 backend 带
`unavailableReason`。

### 原因

`unavailableReason` 是二选一的固定值：

| 值 | 精确含义 |
|---|---|
| `root_missing` | **所有**候选安装根都不存在 |
| `runner_missing` | 至少一个根存在，但在该根下找不到 runner 入口 |

探测顺序（只读，不启动 harness、不读凭据）：

1. `DEEPSEEK_HARNESS_ROOT`（显式指定，最高优先）
2. 全局 npm 常见位置：`<APPDATA>/npm/node_modules/@deepseek-ai/dsh`、
   `<PREFIX>/lib/node_modules/@deepseek-ai/dsh`、`<HOME>/.npm-global/lib/node_modules/...`、
   `<HOME>/.local/share/npm/lib/node_modules/...`
3. `DEEPSEEK_HARNESS_RUNNER`（显式 runner 入口；**路径存在时它说了算**，并回退推导根目录）

每个候选根下的 runner 入口依次尝试：`lib/bin.js` → `apps/cli/lib/bin.js` → `apps/cli/src/bin.ts`。

### 处置

```powershell
npm i -g @deepseek-ai/dsh
```

仍报 `root_missing` → 手工指定：

```toml
[mcp_servers.claude_orchestrator.env]
DEEPSEEK_HARNESS_ROOT = "<@deepseek-ai/dsh 安装目录>"
```

报 `runner_missing` → 直接指 runner：

```toml
DEEPSEEK_HARNESS_RUNNER = "<runner 入口文件的绝对路径>"
```

### 别忘了能力边界

它修好之后仍然 `supportsAttention=false` / `supportsLiveEvents=false` / `supportsSessionResume=false`。
**它不会因为环境修好了就获得这些能力** —— 那是协议层面的限制。见 [BACKENDS §4](./BACKENDS.md)。

---

## 8. 实例 registry 重复 / stale

### 症状

`claude_code_health` 报 `registry.duplicateInstanceSuspected = true` 或 `registryStale = true`，
或 `diagnostics[]` 里有 `duplicate_instance_suspected` / `registry_stale`。

### 原因

| 诊断 | 精确判据 |
|---|---|
| `duplicate_instance_suspected` | 同 runtime scope 中**至少两个通过身份校验的存活实例**，且跨越**不同的宿主 PID**。崩溃残留、PID 已死、身份不匹配的记录**绝不计入**。 |
| `registry_stale` | 任一记录 stale：心跳超阈值（默认 30s）/ PID 不存在 / PID 身份不匹配（PID 复用）/ 记录损坏不可读。`staleReasons` 给净化后的计数。 |

**多窗口是正常的。** 同一宿主的多个会话窗口各自有一个 MCP 实例，属于正常的多窗口形态，
**不**计入重复。只有跨不同宿主 PID 的存活实例才算。

### 确认

看 `claude_code_health` 的：

```jsonc
{
  "registry": {
    "recorded": 3,
    "liveCount": 2,
    "duplicateInstanceSuspected": false,
    "registryStale": true,
    "staleReasons": "heartbeat_timeout:1"
  },
  "diagnostics": [ /* code + severity + 净化 detail */ ]
}
```

**关键区分：** `registry stale` 而 `duplicate=false` 通常**只是残留告警**，
**不应当作门禁失败**，也不应升级为阻塞。

### 处置（手工 runbook —— health 绝不自动清理）

1. 先确认那条记录对应的 PID **确实已经不存活**，或它的身份不匹配：

   ```powershell
   Get-Process -Id <记录里的 pid> -ErrorAction SilentlyContinue
   ```

   > ⚠️ **绝不要**用 `taskkill /IM node.exe` 之类按镜像名批量清杀——会一锅端误杀宿主、调度器、
   > 路由器、编辑器等关键进程。只能按**精确 PID** 操作。

2. 若确认是**重复存活实例**：找到多余的 MCP 进程，按精确 PID 停止它。
3. 若确认是**残留记录**：手工删除 `runtime/registry/instances/` 下对应 JSON（或整个目录；实例会在
   下次启动重新登记）。
4. 重载 MCP 后再看一次 `claude_code_health`。

> `stale` 与构建问题可以**同时存在**：`reload_required` / `hash_unavailable` 由 `diagnostic` 单枚举
> 反映构建状态，实例问题走 `duplicateInstanceSuspected` / `registryStale` 布尔与结构化 `diagnostics[]`。
> 两者不互相遮蔽，**别因为看到了 stale 就忽略 reload**。

---

## 9. `needs_attention` 与"卡死"的区分（用 idleSeconds）

### 症状

job 长时间不结束。你不确定它是**在等人**、**在真干活**、还是**彻底卡死**。

### 判据：两个字段一起看

| 字段 | 含义 |
|---|---|
| `status` | `running` / `needs_attention` / … |
| `idleSeconds` | 距 worker **最后一次真实输出**的秒数（advisory，只供判断，不会自动取消） |

| 组合 | 含义 | 处置 |
|---|---|---|
| `status = needs_attention`，`idleSeconds` 在涨 | **在等人审批，不是卡死** | 用 `claude_code_reply` 注入**最小化**答复 |
| `status = running`，`idleSeconds` 小或波动 | **正常在干活** | 等。不要动手 |
| `status = running`，`idleSeconds` 持续增长 ≥ 5–10 分钟 | 可能真卡了 | 先看 viewer / stderr 日志确认，再 `claude_code_cancel` |
| 上游算力紧张导致的合法静默期 | 也是 `running` + `idleSeconds` 增长 | **不要误杀**。只有 `maxRuntimeMinutes` 超时才由 supervisor 自动强杀 |

### 补充事实

- `needs_attention` **只**由结构化 control/permission 事件驱动（`userPrompt` / `control_request` /
  `permission_request`）。普通文本 banner、stderr 噪声、慢工具**都不会**产生它。
- 暂态信号有一个**确认窗口**（默认 5 秒，`ORCHESTRATOR_ATTENTION_CONFIRM_MS`）：worker 发出瞬时权限
  信号后自行放行并继续输出时，候选被取消，job 保持 `running`。这是为了避免"暂态事件误唤醒领导"。
- 旧 job 缺该字段时 `idleSeconds: null`。

### 常见误判

> **把上游限流当成审批去 reply，只会白烧额度。** 见 [§10](#10-上游限流upstream_rate_limited-的判别)。

---

## 10. 上游限流：`upstream_rate_limited` 的判别

### 症状

job `failed`，信息含糊（"需要审批""失败"之类字样），人想归因为权限问题。

### 判据（只有这一条成立）

**job `failed` 且 `substatus = upstream_rate_limited`** 才可称"供应商额度触顶"。

| `substatus` | 含义 | 处置 |
|---|---|---|
| `upstream_rate_limited` | 供应商额度触顶（判定基于 `failureDetail` 原文里出现额度/限流特征） | 等 reset 或换端点。**重试无意义。** |
| `upstream_unavailable` | 上游 5xx 风暴 | 稍后重派即可 |
| 真正的审批卡点 | 状态是 `needs_attention`（不是 `failed`） | 用 `claude_code_reply` 注入最小化答复 |
| 其它 | 未知失败 | **先看 `failureDetail` 原文**，别猜 |

**本地用量提示、普通 429、其它未知失败都不能替代这个判别。**

### 处置

```jsonc
// claude_code_status / watch 返回里先找这两个字段
{ "status": "failed", "substatus": "upstream_rate_limited", "failureDetail": "<上游错误原文>" }
```

- `upstream_rate_limited` → 停派、降容或串行，等 reset。
- `upstream_unavailable` → 稍后重派。
- 都不是 → 读 `failureDetail` 原文，按这条信息的字面意思处理。

> 这条陷阱的通用形态是：失败信息很含糊时，人会往自己最近改过的地方归因。所以纪律是**看原文**，
> 不是看印象。

---

## 11. read-guard hook 缺失或报错

### 症状

worker 的 `Read` 工具返回 hook 报错；或反过来——大文件被全量读进 worker 上下文，缓存前缀被静默撑爆。

### 原因

read-guard 是一个**可选**的 `PostToolUse` hook（matcher `Read`），用于在读完大文件后给 worker 一个
告警。它的默认路径是 `<HOME>/.claude/cache-sentinel/read-guard.cjs`。

| 情况 | 行为 |
|---|---|
| 文件存在 | 注入 `node "<path>"`，timeout 5s |
| 文件不存在 | **静默不注入**（不会产生一个必然失败的 hook） |
| `ORCHESTRATOR_READ_GUARD_HOOK` 设为 `off` / `0` / `false` | 显式不注入 |
| 指向的路径不存在 | 静默不注入 |

### 确认

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "READ_GUARD"
Test-Path "$env:USERPROFILE\.claude\cache-sentinel\read-guard.cjs"
Get-Content "<ORCHESTRATOR_HOME>\runtime\settings\<jobId>.settings.json" | Select-String "hooks"
```

### 处置

- **想要它**：把 hook 脚本放到默认位置，或设 `ORCHESTRATOR_READ_GUARD_HOOK="<绝对路径>"`。
- **不想要它**：设 `ORCHESTRATOR_READ_GUARD_HOOK = "off"`。这比删掉一个本来就不存在的文件更明确。
- **它报错**：说明路径存在但脚本本身跑不起来。手工跑一次 `node "<path>"` 看真实错误。

> read-guard 缺失**不会**让 job 失败——它只是一个可选的可观测性改善。真正的风险是"大文件全量读"
> 带来的缓存前缀膨胀，那要靠任务侧约束（让 worker 读片段而不是整文件），hook 只是告警。
> （注：开启 budget 强制执行时，`PreToolUse` 的 budget hook 与 read-guard 是两回事，前者不会被它替换。）

---

## 12. 端口被占用

### 症状

worker 启动即失败，`failureDetail` 里是连接被拒 / `EADDRINUSE` / 代理不可用；或反过来，你的**代理进程**
起不来，报端口已被占用。

### 原因

1. 你配置的 Anthropic 兼容端点端口上**没有**服务在跑（用了 `local` 模式但代理没启动）。
2. 端口上跑着**别的**服务，或存在多个代理实例争抢同一端口。
3. 上一次的进程没有干净退出，占着端口。

### 确认

```powershell
# 换 <port> 为你配置里实际用的端口
netstat -ano | Select-String ":<port>\s"
```

拿到 PID 后**逐个确认身份**，再决定动谁：

```powershell
Get-Process -Id <pid> | Select-Object Id,ProcessName,Path,StartTime
```

> ⚠️ **只按精确 PID 操作。** 严禁 `taskkill /IM <name>` 按镜像名批量清杀——那会一并杀掉宿主、调度器、
> 编辑器等关键进程。
> ```powershell
> taskkill /PID <pid> /F     # ✅ 精确
> # taskkill /IM node.exe /F # ❌ 绝对不要
> ```

### 处置

- **代理没起**：启动你的代理，或把 `ORCHESTRATOR_ANTHROPIC_BASE_URL` 改回留空（用 CLI 自己的登录态）。
- **端口被别的服务占**：换端口，或换端点。
- **残留进程占端口**：确认身份后按精确 PID 停止。

> 调度器**自己不需要监听端口**（MCP 走 stdio）。所以"端口被占用"几乎总是**你的端点侧**的问题，
> 而不是调度器的问题——别在这里查错方向。

---

## 13. 构建过期：改了代码没生效

### 症状

你在源码里改了东西（或 `git pull` 了新版），但行为没变；`claude_code_health` 可能已经在提示。

### 判据

```jsonc
{
  "loaded": { "buildFingerprint": "aaa…" },   // 进程启动时算的
  "disk":   { "buildFingerprint": "bbb…" },   // 每次调用现算的
  "reloadRequired": true,
  "diagnostic": "reload_required",
  "notes": [ /* … */ ]
}
```

指纹是对**整个生产 dist 模块集**的确定性根哈希。**任一**依赖模块被新增/删除/修改——即使
`index.js` 字节不变——指纹就会变。所以它比"只比入口文件"更严格，不会漏报。

`hash_unavailable` 表示某模块不可读或指纹为空：**无法证明健康即不报健康**，同样要求重载。

### 处置

```powershell
npm run build
# 然后重载/重启 claude_orchestrator MCP（或重启 Codex）
# 最后重新验证：
#   tools/list  → 工具齐全
#   claude_code_health → loaded.buildFingerprint == disk.buildFingerprint
#                        reloadRequired = false
#                        diagnostic = healthy/current
```

> **门禁习惯：** build 完成后、做任何维护/重载动作之前，先确认
> `loaded == disk`、`reloadRequired=false`、`diagnostic` healthy/current。
> 而 `registry stale` 且 `duplicate=false` 只是残留告警，**不得当作门禁失败或升级为阻塞**。

---

## 14. deliverable 相关失败

### 症状 A：`start` 直接报错，任务没起来

| 报错方向 | 原因 |
|---|---|
| `workFolder must be an absolute path` | 传了相对路径 |
| research/analysis 缺 `deliverablePath` | 这两种 taskType 必须给报告路径 |
| execution 传了 `deliverablePath` | execution **拒绝**该参数，保证契约无歧义 |
| 路径不合法 | 必须是 `workFolder` **内**的绝对路径、以 `.md` 结尾（大小写不敏感）、且不等于 `workFolder` |

### 症状 B：`failed` + `substatus = deliverable_missing`（或 `missingDeliverable=true`）

**原因：** worker 本应 `succeeded`，但 supervisor 在发布终态前校验工件失败——缺失 / 不是常规文件 /
内容为空 / 不可哈希。

**这是刻意的设计：报告缺失绝不静默通过验收。** 工件有效时会返回
`deliverableHash`（SHA-256）+ `missingDeliverable=false`，领导可以直接读那个文件核验。

**处置：**

1. 先看 worker 是否真的写了文件（`status` 的进度尾部 / viewer / `reportPath`）。
2. 若是 `review` 档 + research/analysis：调度器会自动派生一个模式，**只**放行该报告文件本身的
   `Write`/`Edit`，其余写入仍升级审批。若 worker 仍卡在"写报告"的 `needs_attention`，说明调度器
   行为异常 → **取消后重派**，**绝不对同一只读会话反复 reply 重试**。
3. 补写用 `claude_code_reply`——它**继承同一个 `taskType` 与同一个 `deliverablePath`**，续写同一工件，
   不会重置；hash 在 reply 终态重新计算。

---

## 15. watch 挂很久 / 断线了怎么办

### 症状

`claude_code_watch` 很久不返回；或客户端断线、你关了会话，担心任务没了。

### 这是**正常行为**，不是故障

- `watch` 的设计就是挂起直到终态/需审批，**运行中绝不返回 `running`**。它挂得越久，说明**越省钱**
  （0 模型回合）。
- 断开或取消 watch **只清 watcher**：不取消 job、不杀 worker/supervisor、不改变 job 状态。
- supervisor 是 **detached 进程**，即使 MCP 进程重启，它也会在 worker 退出时写入终态、报告和 `.done`
  标记。

### 处置

| 情况 | 做法 |
|---|---|
| 想确认还活着 | 一次 `claude_code_status`（看 `idleSeconds`），然后继续 `watch` 同一 `jobId` |
| 断线了 | 恢复后用 `claude_code_list` 找回 jobId，再 `claude_code_watch` 附着 |
| watch 自身超时（14400s） | 直接重新 `watch` 同一 `jobId`，不要重新 `start` |
| 想中途看一眼 | `claude_code_status` 的渲染尾部（`raw:true` 才是原始日志，仅调试用）。**别直接读 `runtime/logs/*.log`** —— 那是给人工排查的，原始 stream-json 灌进上下文是纯浪费 |
| `watch` 被宿主掐断 | 见 [§3](#3-工具超时watch-中途莫名返回失败)：把 `tool_timeout_sec` 调到 14400 |

### 千万不要

- 因为 watch 不返回就**重新 `start`** —— 你会得到第二个 job 同时改同一批文件。
- 因为 `idleSeconds` 在涨就**立刻 cancel** —— 先区分"在等人"和"在干活"，见
  [§9](#9-needs_attention-与卡死的区分用-idleseconds)。

---

## 附录：一次性自查清单

怀疑链路有问题时，按顺序跑一遍，不要跳步：

```powershell
# ① 环境
node --version                       # ≥ 20
Get-Command claude                   # claude 可用（档 2+）

# ② 配置段唯一且启用
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "claude_orchestrator"
#   → 只应有一处；enabled = true；tool_timeout_sec = 14400

# ③ env 段没有空串
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern 'ORCHESTRATOR_\w+\s*=\s*""'
#   → 期望：无命中

# ④ 白名单
Test-Path "$env:USERPROFILE\.claude\worker-whitelist.json"    # 期望 True

# ⑤ 构建产物
Test-Path <ORCHESTRATOR_HOME>\dist\index.js                   # 期望 True

# ⑥ MCP 自检（期望：不报错地挂住，Ctrl+C 退出）
node <ORCHESTRATOR_HOME>\dist\index.js
```

然后在 Codex 里：

```
claude_code_health          → reloadRequired=false, diagnostic=healthy/current,
                              capabilities.tools 含 watch, diagnostics=[]
claude_code_start(小任务)   → 10 秒内返回 jobId
claude_code_watch(jobId)    → 直接到终态，中途不返回 running
```

六步全过链就没问题。任何一步不过，回到本文对应小节。

---

## 已知的不稳定测试（跑 `npm test` 前请先读这一节）

本机（Windows / 16GB 内存）实测 **3 次全量运行**（750 tests），通过数 745–746，**失败集合每次都不同**：

| 全量运行 | 失败项 |
|---|---|
| 第 1 次 | `10k-file runtime plans in under 1 second` + `cancel kills the worker only when its recorded identity verifies…` |
| 第 2 次 | `10k-file runtime plans in under 1 second` + `flag on: supervisor waits for the transferred lease…` |
| 第 3 次 | `10k-file runtime plans in under 1 second` + `maxRuntime × needs_attention…` + `flag on: supervisor waits for the transferred lease…` |

由此可得两个结论：

1. **`10k-file runtime plans in under 1 second` 是唯一每次都失败的** —— 纯环境性阈值：低配机器扫描 1 万个文件必然超 1 秒（本机实测 1.3–2.2 秒，阈值 1000ms）。换更快的机器大概率通过。
2. **其余失败项每次都不一样** —— 这是**负载敏感 flaky** 的典型特征，而不是确定性 bug。高负载下会有一批**时序/超时敏感**的测试随机超时，涉及监督超时、准入租约交接、注意力状态确认、取消清理等路径。它们在任何一次运行中都可能全绿。

判定依据：把同样的测试拿到**未改动的原始副本**上运行，失败点与数值完全一致，且相关 `src/`、`test/` 文件 **SHA256 相同** → 与仓库本身无关。写在这里是为了让你第一次跑测试时不至于困惑。

**请不要**为了让它们变绿而放宽断言（例如改成 `assert.ok(true)`）或调大超时阈值。它们记录的是真实存在的时序与性能问题，放宽只会掩盖。在更空闲的机器上运行、或用 `node --test --test-name-pattern="<测试名>"` 单独隔离执行，这些 flaky 项通常就过了。欢迎带 profile 数据提 PR。

---

**相关文档：** [README](../README.md) · [SETUP](./SETUP.md) · [BACKENDS](./BACKENDS.md) ·
[METHODOLOGY](./METHODOLOGY.md)
