# 安装向导（SETUP）

本文是 [README](../README.md) 的逐步操作版：三档安装路径、每一处要改的配置文件、每一步的预期输出，
以及失败时怎么办。

> ### ⚠️ 开始之前：安全边界
>
> 从**档 2** 起，这套东西会**在你的机器上、以你的身份、无人值守地**运行 AI 编码 agent。默认 `auto`
> 档**没有沙箱**（`--permission-mode bypassPermissions`），实际约束只有三样：生效的 `deny` 清单、
> 你指定的 `workFolder`、以及你给 worker 的 prompt 约束。`deny` 永不为空，而且内置默认拒绝清单是
> 一道**只能加、不能减**的地板——你写进白名单的规则会与它**取并集**，所以配置只会更严、不可能更松。
> 但**它终究是一份可绕过的前缀黑名单，不是沙箱**。第 2.5 节"装白名单"照做即可。
> 另外不要把不可信内容（外部网页、陌生人给的仓库、未审阅的 issue）喂给会派单的主会话。
> 完整说明见 [README 的「安全边界速览」](../README.md#安全边界速览派第一个任务之前请先读这节)。

**约定：**

- `<CODEX_HOME>` = 你的 Codex 配置目录，通常是 `~/.codex`。
- `<ORCHESTRATOR_HOME>` = 本仓库的绝对路径（例如 `D:\codex-job-orchestrator`）。
- 命令示例给的是 Windows（`pwsh` / `cmd`）；POSIX 等价命令会在旁边注明。
- 三档是**累进**的：档 2 包含档 1，档 3 包含档 2。**按顺序装，不要跳。**

> 全套操作不会修改你现有的任何配置文件——除了你自己手动合并那一段。`tools/init.mjs` 只读探测，
> 产物全部落在仓库的 `./generated/` 里。

---

## 0. 通用前置检查（三档都要）

```powershell
node --version          # 期望 v20.x / v22.x / v24.x 或更高
codex --version         # 期望打印一个版本号
```

| 结果 | 含义 | 处置 |
|---|---|---|
| `v18.x` 或更低 | 不满足 `engines.node >= 20` | 升级 Node（nvm / 官方安装器皆可） |
| `node: command not found` | Node 没装或不在 `PATH` | 装 Node ≥ 20，重开终端 |
| `codex: command not found` | Codex CLI 没装或不在 `PATH` | 先装好 Codex 并确认能启动，再回来 |

**为什么先查这个：** 后面所有"工具不出现""job 立刻失败"都可能是这两条的后果，先排掉能省一半时间。

---

## 档 1 · 仅 Luna（零外部依赖，推荐入口）

**目标：** 拿到"领导 + 员工"的分工，但不安装任何调度器。
**需要：** Codex CLI。
**耗时：** 约 5 分钟。
**这一档不使用本仓库的任何代码。**

### 1.1 写员工定义

在 `<CODEX_HOME>/agents/` 下新建 `luna_worker.toml`（目录不存在就建）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\agents" | Out-Null
notepad "$env:USERPROFILE\.codex\agents\luna_worker.toml"
```

内容（把 `<你的员工模型>` 换成你确实有权限访问、且比领导模型便宜的一个模型 id）：

```toml
name = "luna_worker"
description = "Cost-efficient native Codex worker for clear, bounded, repeatable subtasks."
model = "<你的员工模型>"
model_reasoning_effort = "high"

developer_instructions = """
你是员工：只执行父代理指定的、有界的实现 / 测试 / 取证任务。
保留父会话的沙箱、审批、工具、MCP 与 Skill 边界。
只在被分配的文件所有权范围内写入；绝不覆盖或回滚另一个 worker、或用户未提交的改动。
不做架构、产品、trade-off 决策，不排优先级，不定验收标准，不给最终结论——那些属于父代理。
取证报告只描述观察到的现象、约束、位置与未知项；不要给建议。
不为被分配的工作再spawn 或委派嵌套子代理。
同任务续做用 followup_task，不用 claude_code_reply（本子代理是 Codex 原生的，
不属于 claude_orchestrator 的 worker backend）。
回执格式：status、backend/agent type、变更文件或取证位置、验收逐项、自测结果、剩余风险/未知项。
没有命令或工件证据不得声称成功。
"""
```

**为什么这么写 `developer_instructions`：** 员工的价值在于"执行无自由度"。如果它开始给建议、拍板、
或自行扩大范围，你就把"想清楚"外包出去了，而它缺的正是完整决策上下文。

### 1.2 打开 Codex 的 agents 段

编辑 `<CODEX_HOME>/config.toml`，加入（若已存在 `[agents]` 段，只补齐缺的键）：

```toml
[agents]
enabled = true
default_subagent_model = "<你的员工模型>"
default_subagent_reasoning_effort = "high"
max_concurrent_threads_per_session = 4
```

| 键 | 作用 | 常见错误 |
|---|---|---|
| `enabled` | 打开子代理机制 | 漏掉或写成 `false` → 派单直接不可用 |
| `default_subagent_model` | 未显式指定模型时的默认 | 指向一个你没有权限的 id → 派单立刻报错 |
| `default_subagent_reasoning_effort` | 默认推理强度 | 直接拉满 → 延迟与输出 token 显著放大，收益边际递减 |
| `max_concurrent_threads_per_session` | 单会话并发线程上限 | 拉太高 → 每个线程是真实 OS 进程，内存压力与崩溃风险真实存在 |

### 1.3 预期输出与验证

1. **完全重启 Codex**（不是重开一个会话）。
2. 派一个**有界**的小任务，例如"读 `<某个文件>`，报告它的公开导出符号列表，不要修改任何东西"。
3. 期望：员工回一份窄回执（status / 位置 / 验收项 / 自测 / 未知项），**没有**长篇思考、**没有**完整 diff。

### 1.4 失败怎么办

| 症状 | 原因 | 处置 |
|---|---|---|
| 派单报"未知 agent type" | `luna_worker.toml` 不存在、文件名与 `agent_type` 不一致，或 `[agents] enabled` 为 false | 检查文件名、检查 `enabled = true`、完全重启 Codex |
| 员工立刻报模型无权限 | `model` 指向你没有权限的 id | 改成你有权限的模型，或删掉该键走 `default_subagent_model` |
| 员工回了长篇分析 + 建议 | `developer_instructions` 太松，或根本没生效 | 确认文件被读取（重启后再试）；把"不给结论、不给建议"写死在指令里 |

### 1.5 继续往档 2 走

档 1 已经能省主模型额度。**档 2 增加的是"长任务"能力**：真正的后台 job、事件驱动等待、会话续做、
权限 attention、实时窗口、取消与审计。如果你不需要这些，**停在这里是完全合理的选择**——见
[../docs/METHODOLOGY.md §9](../docs/METHODOLOGY.md)。

---

## 档 2 · + Claude Code worker

**目标：** 长任务从"一次同步调用"升级为 job 模型。
**需要：** 档 1 + `claude` CLI + 本仓库。
**耗时：** 约 15 分钟。

### 2.1 先确认 `claude` CLI 可用

```powershell
claude --version
```

| 结果 | 处置 |
|---|---|
| 打印版本号 | 继续。记下 `claude` 在 `PATH` 上的名字（Windows 上通常是 `claude.CMD`）。**注意：`.cmd` 不能直接写进 `CLAUDE_CLI_NAME`**——调度器用 `shell: false` 启动 worker，`.cmd` 会以 `EINVAL` 失败；请指向 npm 全局目录里 `@anthropic-ai/claude-code/bin/claude.exe` 那个原生 `.exe`，或走 `CLAUDE_CLI_PREFIX=node.exe` + `CLAUDE_CLI_NAME=<cli.js>` 的形式。**永远不要为此启用 `shell: true`**（会引入命令注入），详见 [TROUBLESHOOTING §5](./TROUBLESHOOTING.md) |
| 找不到命令 | 装 Claude Code CLI（`npm i -g @anthropic-ai/claude-code`，或按官方文档的安装方式），重开终端 |
| 装了但不在 `PATH` | 直接给绝对路径，稍后写进 `CLAUDE_CLI_NAME` |

> **许可提醒。** `@anthropic-ai/claude-code` 是专有软件。本仓库不分发、不下载、不重新实现它，
> 只是启动你已经装好的那个可执行文件。以程序化方式使用前请自行核对 Anthropic 的条款。

### 2.2 构建调度器

```powershell
cd <ORCHESTRATOR_HOME>
npm install
npm run build
```

**预期输出：** 若干 tsc 无错输出（本项目 `tsc` 配置为无噪音时可能什么都不打印），随后
`scripts/copy-runtime-assets.mjs` 复制运行时资源。

**验证构建产物：**

```powershell
Test-Path .\dist\index.js                     # 期望 True
Test-Path .\dist\orchestrator-launcher.cjs    # 可选：存在则优先用它（多会话 runtime 隔离）
```

| 症状 | 原因 | 处置 |
|---|---|---|
| `npm install` 报网络错误 | 代理/registry 问题 | 配好 npm registry 或代理后重试 |
| `npm run build` 报 TS 错误 | Node 版本过低，或 `node_modules` 不完整 | 先 `node --version`，再删 `node_modules` 重装 |
| `dist/index.js` 不存在 | 构建没真正跑完 | 单独跑 `npm run build`，看完整输出 |

### 2.3 用 `tools/init.mjs` 探测环境并生成配置

```powershell
node tools/init.mjs
```

**它做什么：**

- **只读探测**你的环境：Node 版本、`claude` / `codex` / `dsh` 是否可用、本仓库是否已构建、
  `<CODEX_HOME>/config.toml` 里是否已存在 `[mcp_servers.claude_orchestrator]` 段（以及它是否被禁用）、
  权限白名单与可选 hook 是否存在、凭据文件是否**存在**（只报告存在性）。
- **把建议配置生成到 `./generated/`**：

  | 产物 | 内容 |
  |---|---|
  | `generated/codex-config.snippet.toml` | 可整体合并进 `<CODEX_HOME>/config.toml` 的 MCP 片段（含 `enabled = true` 与 14400s 工具超时） |
  | `generated/worker-whitelist.json` | 一份通用 worker 权限白名单（无私有服务名） |
  | `generated/README-下一步.md` | 探测结果表 + 你这一档的后续 3 步 |
  | `generated/.gitignore` | 内容为 `*` —— 因为片段里可能含你输入的 token |

- **不改你的任何现有文件**，不移动、不删除。合并配置始终由你手工完成。
- **不读凭据内容**，终端输出里不会出现任何 token。

**其他用法：**

```powershell
node tools/init.mjs --help      # 用法说明
node tools/init.mjs --yes       # 非交互，全部取默认值（CI 友好）
node tools/init.mjs --json      # 额外把探测结果以 JSON 打到 stdout
```

> ⚠️ `generated/` 里可能有你输入的 token，**务必确认它已被 git 忽略**（脚本自己写了 `.gitignore`，
> 但如果你把它挪走或提交过，请自查）。

### 2.4 合并 MCP 配置到 `<CODEX_HOME>/config.toml`

**先备份：**

```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:USERPROFILE\.codex\config.toml.bak"
```

**然后处理旧段（这一步最容易出错）：**

```powershell
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "claude_orchestrator"
```

- **如果已经存在** `[mcp_servers.claude_orchestrator]` 段：**把旧段整段删掉**，再贴新的。
  **不要留两份同名段**——TOML 以最后一个为准，而你的编辑器可能先显示第一个，于是你改的那段根本没生效。
- **如果不存在**：把 `generated/codex-config.snippet.toml` 的**全部内容**追加到 `config.toml` 末尾。

**合并后的关键内容应是（照抄结构，路径换成你自己的）：**

```toml
[mcp_servers.claude_orchestrator]
# ⚠️ 必须是 true：false = 工具在 Codex 里完全不存在（静默失败，不报错）
enabled = true
command = "<node 的绝对路径>"
args = ["<ORCHESTRATOR_HOME>/dist/index.js"]
# 提示：构建产物里有 dist/orchestrator-launcher.cjs 时优先用它（多会话 runtime 隔离）
startup_timeout_sec = 120
# ⚠️ 必须 ≥ 14400（4 小时）：claude_code_watch 最长挂起 4 小时，配小会被宿主提前掐断
tool_timeout_sec = 14400

[mcp_servers.claude_orchestrator.env]
# 只写你确实要设的键。留空的键一律不要写！
# 写空串会覆盖 CLI 自己的默认值，等于把官方登录态顶掉——安装期第二大坑。
# 必须是原生 .exe（或 .js 入口 + CLAUDE_CLI_PREFIX=node.exe）；.cmd 会被 shell:false 拒绝（EINVAL）。
CLAUDE_CLI_NAME = "<claude 可执行文件绝对路径>"

# 只读工具免审（无副作用，不该每轮弹审批）。
# claude_code_start / reply / cancel 是写操作，刻意不在这里放行。
[mcp_servers.claude_orchestrator.tools.claude_code_status]
approval_mode = "auto"
[mcp_servers.claude_orchestrator.tools.claude_code_list]
approval_mode = "auto"
[mcp_servers.claude_orchestrator.tools.claude_code_health]
approval_mode = "auto"
[mcp_servers.claude_orchestrator.tools.claude_code_watch]
approval_mode = "auto"
[mcp_servers.claude_orchestrator.tools.claude_code_wait]
approval_mode = "auto"
```

**逐行说明：**

| 行 | 为什么这么写 |
|---|---|
| `enabled = true` | 见 [坑 1](../README.md#-坑-1--enabled--false-会让工具根本不存在)。禁用时 Codex 不报错，只是让工具不存在。 |
| `command` + `args` | 指向 node 与本仓库的构建产物。用 `dist/orchestrator-launcher.cjs`（若存在）可按宿主 PID 分配独立 runtime 目录，避免多会话互相覆盖实例身份。 |
| `startup_timeout_sec = 120` | 首次启动要加载 SDK 并恢复历史 job，给足时间免得被过早判定失败。 |
| `tool_timeout_sec = 14400` | 见 [坑 2](../README.md#-坑-2--tool_timeout_sec-必须--14400否则-watch-会被提前掐断)。 |
| `env` 段 | **只写有值的键。** 空串会覆盖 CLI 默认值。 |
| `approval_mode = "auto"`（5 个只读工具） | 状态/列表/健康/watch/wait 都是只读，没有副作用；不设的话每轮都弹审批，长等待会被审批流程打断。**有副作用的 start / reply / cancel 保持默认审查**，不给它们免审。 |

### 2.5 安装 worker 权限白名单

**默认位置：** `<HOME>/.claude/worker-whitelist.json`（Windows 上是 `%USERPROFILE%\.claude\`）。

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude" | Out-Null
Copy-Item .\generated\worker-whitelist.json "$env:USERPROFILE\.claude\worker-whitelist.json"
```

**这个文件为什么重要：** 调度器的权限解析是"授权按原样、禁令取并集"——`allow` 用你写的（绝不替你
放大），`deny` 则是**你的规则 ∪ 内置基线**，通过 `--settings` 注入每个 job 的独立 settings。

| 情况 | 行为 |
|---|---|
| 文件存在且合法 | `allow` 按你的原样用；`deny` = 你的规则 **+** 内置基线里你漏掉的（**只能加，不能减**） |
| `deny` 比基线窄（例如刚拷了模板） | 调度器把缺的基线规则**并进来**，报告 `worker whitelist incomplete … Nothing is broken`——**这是正常语义，不是故障**，你的策略只会更严 |
| 文件缺失 / JSON 坏 / `permissions.allow` 不是数组 | `allow` 回退到一份保守的内置清单（Read / Write / Edit / MultiEdit / Glob / Grep / TodoWrite，绝不退化成空列表）；`deny` 用完整的内置默认拒绝清单（`src/config.ts` 的 `DEFAULT_WORKER_DENY`：批量删除 / 格式化 / 关机、批量按镜像名杀进程、`git push` / `git -C … push` / `npm publish`、`curl`/`wget`/`powershell`/`ssh`/`scp` 出口、`~/.ssh` `~/.aws` `~/.npmrc` 等凭据位置、系统目录写入）。**`deny` 永不为空**；只有 `allow` 不是数组、文件本身仍可读时，文件里的 `deny` 照常按并集参与 |

上面这些替换/补齐都会通过三条渠道报告：`claude_code_start` / `claude_code_reply` 响应的
`warnings[]`、该 job 的 `runtime/logs/<jobId>.stderr.log`（一行 `worker policy fallback`）、以及
`claude_code_health` 的 `notes`。

> ✅ **照装即可，这一步是纯粹的叠加。** 第 2.5 节让你拷的 `generated/worker-whitelist.json`
> 只是一份**起点**，不是策略的全部：你写进文件的规则与内置基线**取并集**，所以拷完你拿到的是
> **"你的规则 + 基线补齐的部分"**，只会比基线更多、不会更少。**基线只能加、不能减**，写配置的人
> （你、一份拷来的模板、甚至一个被注入改写的文件）都只能把策略**收紧**，无法把产品从"拦截不可逆
> 操作"这件事上劝退。拷完若在 `warnings[]` 里看到 `worker whitelist incomplete … Nothing is broken`，
> 那只是在告诉你**"已替你补齐基线"**，属正常提示；想让提示消失，把缺的规则抄进你的文件即可。

**换位置的方式：** 设 `ORCHESTRATOR_WHITELIST_PATH` 指向你自己的文件。

**`deny` 列表的定位：** 它是 `auto` 档**唯一能拦住调用的策略层**——`git push` 一律人工执行、
`shutdown`/`format`、系统目录写保护等。但请看清两点：

1. **基线不可降低。** 真正生效的是**内置基线 ∪ 你文件里的规则**：你的规则一律生效，基线里你漏掉的
   会被自动补齐。随仓库发的 `templates/worker-whitelist.json` 比基线窄，并集会把差额补齐——这是
   **预期语义**，不是配置错误。
2. **它是字面前缀匹配，可绕过**（换个写法、写进脚本、经 `npx` 间接调用都命中不了），**不是沙箱**。

**不要把 `deny` 项删掉换成逐项审批**——审批分类器会在每次调用前多发一次模型请求，经共享链路时
持续超时并阻塞已批准的工作。

> **为什么这一步不能跳过：** `auto` 档用 `--permission-mode bypassPermissions` 启动 worker，
> 在这个档位下"没写进 `allow`"**不等于**被拦——只有 `deny` 拦得住。而内置基线**只认识通用危险
> 操作**：它不认识你这个项目的目录、也不认识你自己的工具链，更不会替你放行你的构建命令。
> 文件缺失时你只有那份通用基线；配了自己的白名单，你拿到的是**基线 ∪ 你的规则**——既补上了
> 项目相关的禁令，`allow` 也按你的实际情况生效。所以**能配就配**。详见
> [TROUBLESHOOTING §4](./TROUBLESHOOTING.md) 与 README 的「安全边界速览」。

### 2.6 重启并首次验证

1. **完全重启 Codex**（新增的 MCP 工具只有重载/重启后才被发现）。
2. 运行 `/mcp`，确认能看到 `claude_orchestrator`，且它报告已连接。
3. 调用 `claude_code_health`（无参数，只读）。

### 2.7 安装后的验证清单

```jsonc
// claude_code_health 的期望（节选）
{
  "version": "...",                       // 来自 package.json，单一来源
  "loaded": { "buildFingerprint": "..." },
  "disk":   { "buildFingerprint": "..." },  // 必须与 loaded 相等
  "reloadRequired": false,
  "diagnostic": "healthy/current",
  "capabilities": {
    "tools": [ /* 应包含全部 9 个，特别是 claude_code_watch */ ],
    "structuredAttentionDetail": true,
    "responseAudit": true,
    "workerBackends": ["claude"]            // 档 3 后应多一个
  },
  "instance": { "pid": 1234, "startedAt": "...", "uptimeSec": 12, "entry": "index.js" },
  "registry": { "recorded": 1, /* duplicateInstanceSuspected: false, registryStale: false */ },
  "diagnostics": []
}
```

**逐项判读：**

| 检查项 | 期望 | 不符时的含义 |
|---|---|---|
| tools 列表含 `claude_code_watch` | ✅ | 缺它说明加载的是旧构建 → 重载 |
| `loaded.buildFingerprint == disk.buildFingerprint` | ✅ | 不等 = 磁盘构建比内存里新 → 重载 |
| `reloadRequired` | `false` | `true` → 重载 MCP；`hash_unavailable` 时说明无法证明健康，保守要求重载 |
| `diagnostic` | `healthy/current` | 见 [TROUBLESHOOTING](./TROUBLESHOOTING.md) |
| `structuredAttentionDetail` | `true` | `false` → watch/status 未按预期注册，加载的是旧构建 |
| `workerBackends` | 至少 `["claude"]` | 档 3 装了 DSH 后应多出 `deepseek-harness` |
| `duplicateInstanceSuspected` | `false` | `true` = 同 runtime 下有两个通过身份校验的存活实例 → 见 [TROUBLESHOOTING §8](./TROUBLESHOOTING.md) |
| `registryStale` | `false` | `true` 通常只是崩溃残留告警，**不是**门禁失败 |

### 2.8 跑一次真实的端到端验证

派一个**小、有界、可验证**的任务（不要一上来就派 90 分钟的大活）：

```
claude_code_start(
  prompt: "在当前目录创建一个 hello.txt，内容为 hi，然后读取并回显它。只做这些，不要做别的。",
  workFolder: "<一个你愿意让它写的绝对路径>",
  profile: "auto"
)
```

期望：**10 秒内**返回 `jobId`。然后用 `claude_code_watch(jobId)` 等它。

| 观察到的现象 | 含义 | 处置 |
|---|---|---|
| 10 秒内返回 `jobId`，`watch` 很快 `succeeded` | 链路正常 | 可以开始派真活了 |
| `start` 超过 10 秒才返回 | 参数校验或恢复扫描卡住 | 看 `claude_code_status`，见 [TROUBLESHOOTING](./TROUBLESHOOTING.md) |
| `watch` 立刻以 `failed` 返回 | worker 一起就死了 | 看 `substatus` / `failureDetail` 原文，见 [TROUBLESHOOTING §5](./TROUBLESHOOTING.md) |
| job 变 `needs_attention` | worker 要审批 | 用 `claude_code_reply` 注入**最小化**答复 |
| job 一直 `running` 但 `idleSeconds` 持续增长 | 可能是真卡了 | 先确认是不是"在等审批"——见 [TROUBLESHOOTING §6](./TROUBLESHOOTING.md) |

### 2.9 档 2 常见失败（速查）

完整版见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。这里给最高频的 4 条：

| 症状 | 最常见原因 | 一行处置 |
|---|---|---|
| `/mcp` 里没有 `claude_orchestrator` | `enabled = false`，或有两份同名段 | 删旧段，只留一份 `enabled = true` |
| 工具列表里没有 `claude_code_*` | 没重启 / 没重载 MCP | 完全重启 Codex |
| `watch` 中途莫名返回失败 | `tool_timeout_sec` 小于 14400 | 改成 14400 并重载 |
| job 每步都卡审批 | 白名单缺失或路径不对（只在非 `auto` 档可见；`auto` 档下缺白名单是静默的） | 装白名单，或设 `ORCHESTRATOR_WHITELIST_PATH`；`auto` 档请改看 start/reply 响应的 `warnings[]` |

---

## 档 3 · + deepseek-harness

**目标：** 增加第二个 worker backend。
**需要：** 档 2 + npm 包 `@deepseek-ai/dsh`。
**耗时：** 再加约 5 分钟。

### 3.1 安装

```powershell
npm i -g @deepseek-ai/dsh
dsh --version          # 确认它可用；这只是给你自己看的，调度器走的是包目录而非 PATH
```

### 3.2 让调度器找到它（通常不需要手动配）

调度器的探测顺序（只读，不启动 harness、不读任何凭据）：

1. `DEEPSEEK_HARNESS_ROOT`（显式指定，最高优先）
2. 全局 npm 的常见位置：`<APPDATA>/npm/node_modules/@deepseek-ai/dsh`、
   `<PREFIX>/lib/node_modules/...`、`<HOME>/.npm-global/lib/node_modules/...`、
   `<HOME>/.local/share/npm/lib/node_modules/...`
3. `DEEPSEEK_HARNESS_RUNNER`（显式指定 runner 入口；路径存在时它说了算）

在每个候选根下，它依次找 `lib/bin.js` → `apps/cli/lib/bin.js` → `apps/cli/src/bin.ts`。

**只有探测失败时**才需要手工指路：

```toml
[mcp_servers.claude_orchestrator.env]
DEEPSEEK_HARNESS_ROOT = "<@deepseek-ai/dsh 的安装目录>"
# DEEPSEEK_HARNESS_RUNNER = "<runner 入口文件的绝对路径>"   # 可选，更精确
```

### 3.3 验证

重载 MCP 后调用 `claude_code_health`，`capabilities.workerBackends` 应包含
`"deepseek-harness"`。

| 现象 | 原因 | 处置 |
|---|---|---|
| `workerBackends` 只有 `claude` | 加载的还是旧构建，或 MCP 没重载 | 重载 MCP 再看 |
| 派单报 `root_missing` | 所有候选根都不存在 | 装包，或设 `DEEPSEEK_HARNESS_ROOT` |
| 派单报 `runner_missing` | 根存在但找不到 runner 入口 | 设 `DEEPSEEK_HARNESS_RUNNER` 指向实际入口 |

详见 [TROUBLESHOOTING §7](./TROUBLESHOOTING.md)。

### 3.4 ⚠️ 派单前必须知道的能力契约

本地 headless harness 是**单次、只回最终文本**的协议。这个 backend 因此声明：

| capability | 值 | 后果 |
|---|---|---|
| `supportsAttention` | `false` | **不会**产生 `needs_attention`，也不会携带 `attentionDetail`。任务撞到需要审批的动作时，你只会看到它结束，而不是被温和地问一句。 |
| `supportsLiveEvents` | `false` | **没有**实时事件流，viewer 窗口没有可渲染的逐步进展。 |
| `supportsSessionResume` | `false` | **没有**会话续做。`claude_code_reply` **默认被拒**，固定错误前缀 `fresh_turn_authorization_required`。 |

**续做怎么办：** 传 `allowFreshTurn=true`，它会执行一个**新的独立有界轮次**（新 `sessionId`、
`replyMode=fresh_turn`），**绝不** resume 父会话、**绝不**伪称会话连续性。**永远不要把它描述成
"续做""接着上次改"**——那会让领导写出依赖已丢失上下文的指令，这是最难排查的一类失败。

**bridge 的开关语义：** 磁盘上存在 bridge 文件**不等于**启用。只有进程环境里显式设了非空的
`DEEPSEEK_HARNESS_BRIDGE_PATCH` 才会传 `--patch`；而 `DEEPSEEK_HARNESS_DISABLE_BRIDGE=1`
永远优先并完全禁用（harness 独立运行）。

---

## 三档能力对照

| | 档 1 仅 Luna | 档 2 + Claude | 档 3 + DSH |
|---|---|---|---|
| 外部依赖 | 无 | `claude` CLI + 本仓库 | + `@deepseek-ai/dsh` |
| 后台 job 模型 | Codex 原生 collaboration | ✅ | ✅ |
| 事件驱动等待（0 回合） | Codex 原生 | ✅ `watch` | ✅ `watch` |
| 真·会话续做 | `followup_task` | ✅ `reply`（`--resume`） | ❌（新独立轮次） |
| 权限 attention | Codex 原生审批 | ✅ `attentionDetail` | ❌ |
| 实时可见窗口 | Codex 原生 | ✅ `OPEN_LIVE_VIEW=1` | ❌ |
| 取消 / 列表 / 健康诊断 | Codex 原生 | ✅ | ✅ |
| 交付物 SHA-256 校验 | ❌ | ✅ research/analysis | ✅ research/analysis |
| 装完要改的文件 | 2 个 | 2 个 + 白名单 | 同档 2（可能 + 1 行 env） |

---

## 附录 A：一次安装的完整命令序列（档 2）

```powershell
# 0. 前置检查
node --version
codex --version
claude --version

# 1. 构建
cd <ORCHESTRATOR_HOME>
npm install
npm run build
Test-Path .\dist\index.js

# 2. 探测 + 生成建议配置（不改你的文件）
node tools/init.mjs
Get-Content .\generated\README-下一步.md

# 3. 备份 + 合并 MCP 段（手工）
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:USERPROFILE\.codex\config.toml.bak"
Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern "claude_orchestrator"
#   → 有旧段就删掉，没有就把 generated\codex-config.snippet.toml 追加到末尾

# 4. 白名单
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude" | Out-Null
Copy-Item .\generated\worker-whitelist.json "$env:USERPROFILE\.claude\worker-whitelist.json"

# 5. 完全重启 Codex，然后：
#    /mcp                       → 看到 claude_orchestrator
#    claude_code_health         → reloadRequired=false, diagnostic=healthy/current
#    claude_code_start + watch  → 10 秒内拿到 jobId，任务跑完
```

## 附录 B：回滚

```powershell
# 1. 从 <CODEX_HOME>/config.toml 删掉 [mcp_servers.claude_orchestrator] 段
#    （含它的 .env 与 .tools.* 子段）
# 2. 恢复全局指令文件（AGENTS.md 或等价物）——用你自己的备份
# 3. 可选：清空运行数据
Remove-Item -Recurse -Force <ORCHESTRATOR_HOME>\runtime
```

> `runtime/` 里可能含本地 prompt 副本。删除前先确认不需要保留。
>
> 档 1 完全不受影响：它不依赖本仓库的任何东西，回滚调度器不会动到它。

## 附录 C：卸载

1. 完成上面的回滚步骤。
2. 删除 `<CODEX_HOME>/agents/luna_worker.toml`（若你不想要档 1）。
3. 删除 `<HOME>/.claude/worker-whitelist.json`（可选；这是你自己的工作文件）。
4. 删除本仓库目录。

---

**下一步：** 装完就该看 [BACKENDS.md](./BACKENDS.md)（怎么给任务选 backend）和
[METHODOLOGY.md](./METHODOLOGY.md)（为什么这样分工、什么时候不划算）。
遇到问题看 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。
