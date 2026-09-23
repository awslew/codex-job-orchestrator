# 三类 worker 的接入与能力矩阵（BACKENDS）

本文回答一个问题：**一个任务该派给哪条路径，以及这条路径到底能做什么、不能做什么。**

能力真值来源：`src/backend-policy.ts`（纯策略，无副作用）与 `src/worker-adapter.ts`（加只读磁盘探测）。
凡是本文与代码冲突，以代码为准。

---

## 1. 一张表看懂三条路径

| | ① claude | ② luna_worker | ③ deepseek-harness |
|---|---|---|---|
| 是什么 | Claude Code CLI | Codex 原生 collaboration 子代理 | 本地 headless runner |
| 谁管理它 | **本调度器** | Codex 自己 | **本调度器** |
| 派单入口 | `claude_code_start`（`workerBackend=claude`） | `agent_type=luna_worker` | `claude_code_start`（`workerBackend=deepseek-harness`） |
| 在同一套 job 模型里吗 | ✅ | ❌（走 collaboration，不是 MCP） | ✅ |
| 启动命令 | `claude -p --session-id … --settings …` | Codex 原生 | `node dist/deepseek-worker.js --job <jobId>` |
| 续做方式 | `claude_code_reply` → `--resume <sessionId>` | `followup_task` | `claude_code_reply` + `allowFreshTurn=true` → **新独立轮次** |
| 是"真续做"吗 | ✅ 是真续做（同 session、前缀延续） | ✅ 员工侧保留现场 | ❌ **不是**，语义是 new session / fresh turn |
| `supportsSessionResume` | `true` | （由 Codex 提供，不适用本矩阵） | `false` |
| `supportsAttention` | `true` | （Codex 原生审批） | `false` |
| `supportsLiveEvents` | `true` | （Codex 原生） | `false` |
| `supportsCancel` | `true` | （Codex 原生） | `true` |
| `replyMode` | `resume_session` | — | `fresh_turn` |
| 默认 backend | ✅ 是（`ORCHESTRATOR_DEFAULT_WORKER_BACKEND` 未设时） | — | 否 |

**核心纪律：路由单位是 backend，不是模型名。** 见 [§5](#5-路由决策树)。

---

## 2. ① claude —— Claude Code CLI

### 2.1 接入方式

```jsonc
// claude_code_start 的关键参数
{
  "prompt": "<有界任务：目标 / 允许改的范围 / 验收标准 / 验证命令 / 权限边界>",
  "workFolder": "<绝对路径>",
  "workerBackend": "claude",     // 或省略（这就是默认值）
  "profile": "auto",             // auto（实现默认） | review（只读） | normal（人工控制）
  "maxRuntimeMinutes": 120,      // 30-180，默认 120
  "taskType": "execution",       // execution（默认） | research | analysis
  "deliverablePath": "…"         // research/analysis 必填：workFolder 内的绝对 .md 路径
}
```

### 2.2 启动细节

supervisor 为每个 job 生成独立的 settings 文件，然后启动：

```
claude -p --session-id <uuid> --permission-mode <mode> --effort <level> \
  --output-format stream-json --verbose --autocompact=128000 \
  --settings <runtime/settings/<jobId>.settings.json> --add-dir=<workFolder> \
  [--disallowedTools=Edit,Write,NotebookEdit] \
  [--mcp-config <hermetic> --strict-mcp-config] \
  [--allowedTools=<rule> …] <注入后仍逐字保留的 prompt>
```

| 元素 | 来源与理由 |
|---|---|
| `--permission-mode` | 由 profile 决定：`auto`→`bypassPermissions`、`review`→`plan`、`normal`→`acceptEdits`。**绝不按模型名分流。** |
| `--effort` | 按 job 派生：`analysis` → `max`，其余 → `high`。固定在 setting 里，不按任务现调。 |
| `--settings` | per-job 注入端点、模型映射、`permissions`、可选 hook。这是**路由真正生效的地方**：`--settings` 的 env 块覆盖 `~/.claude/settings.json`，而进程环境变量不覆盖它。 |
| `--disallowedTools`（仅 review） | 从 CLI 层再挡一次写工具。 |
| `--mcp-config` + `--strict-mcp-config` | 可选。存在 `config/hermetic-mcp.json` 时注入，给 worker 一个**空 MCP 面**，防止 worker 递归调用调度器。文件不存在则不注入，worker 保留自己的 MCP 配置。 |
| `--allowedTools=<rule>` | 白名单每条规则传一次，作为 job settings 之外的第二层防线。 |
| `--autocompact=128000` | 与交互窗同一压缩阈值，避免长链路 worker 常驻 >128k 每次全量 miss。 |

**prompt 不被改写。** 调度器只把它包进一个有界任务协议（目标 / 范围 / 验收 / 权限边界 / 修复轮次），
需求本身逐字保留；`research`/`analysis` 额外注入 Markdown 交付契约。

### 2.3 续做语义

`claude_code_reply <jobId> "<窄指令>"`：

- 用父 job 保存的 `sessionId` 执行 `--resume <sessionId>` ——**真续做**：长上下文留在 worker 侧，
  不进入领导的上下文。
- 返回一个**新** `jobId`，然后用 `watch` 等它。
- 被引用 job 仍在运行时拒绝（先 `cancel` 或等终态）。
- job 卡在 `needs_attention` 时，旧的等待进程会在 resume 前被终止。

**preflight（可能被拒）：** 当父会话的转写超过阈值（默认 2 MiB，`ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES`，
且 `ORCHESTRATOR_REPLY_PREFLIGHT=1` 时启用），reply 以 `new_start_required` 被拒。两条出路：
开新 `start`，或传 `allowLargeResume=true` 强行 resume。

### 2.4 支持的能力

| 能力 | 支持 | 表现 |
|---|---|---|
| `attention` | ✅ | 权限/控制事件 → `needs_attention`，`watch`/`status` 携带结构化净化摘要 `attentionDetail`。详情见 [README](../README.md#needs_attention-里到底有什么)。 |
| `live events` | ✅ | stdout 是 stream-json；viewer 窗口逐步渲染。`watch` 的状态源是跨进程 broker，不是阻塞读流。 |
| `session resume` | ✅ | `--resume` 续前缀，缓存命中延续。 |
| `cancel` | ✅ | 只终止目标 job 的进程树，状态与日志保持可审计。 |
| 交付物校验 | ✅ | research/analysis 的 `.md` 在发布终态前做常规性 / 非空 / SHA-256 校验；无效则翻转为 `failed`。 |

### 2.5 何时选它

- **通用实现 / 修复 / 测试** —— 成本最低、链路最稳，是默认档。
- **需要同任务反复迭代**（fix → 验收 → 再 fix）—— 只有它有真 resume，长任务拆成 N 个串行 start
  是最贵的写法。
- **需要看到"它到底在干什么"** —— attention + live 窗口。
- **需要落一份可校验的报告** —— research/analysis + `deliverablePath`。

---

## 3. ② luna_worker —— Codex 原生子代理

### 3.1 它是一个独立的东西，不是本调度器的 backend

**它不在 `WORKER_BACKENDS` 里。** 本调度器的 backend 列表只有 `claude` 与 `deepseek-harness`
（`src/backend-policy.ts`）。luna 走 Codex 自己的 collaboration 机制：

| 动作 | 怎么做 |
|---|---|
| 启动 | `agent_type=luna_worker`（Codex 原生调用，不经 MCP） |
| 同任务续做 | **`followup_task`** —— 员工侧保留上下文与改动 |
| **不要**用 | `claude_code_start` / `claude_code_reply`（它不属于这九个工具的作用域） |

配置来源（不在本仓库，在你的 Codex 配置里）：

- `<CODEX_HOME>/config.toml` 的 `[agents]` 段：`enabled`、`default_subagent_model`、
  `default_subagent_reasoning_effort`、`max_concurrent_threads_per_session`。
- `<CODEX_HOME>/agents/luna_worker.toml`：`model`、`model_reasoning_effort`、
  `developer_instructions`。

### 3.2 能力（由 Codex 提供，不经本调度器的矩阵）

| 能力 | 说明 |
|---|---|
| `attention` | Codex 原生审批机制，不是本调度器的 `attentionDetail` 结构。 |
| `live events` | Codex 原生的会话视图。 |
| `session resume` | 通过 `followup_task` 在员工侧保留现场；**不是** CLI 层的 `--resume`。 |
| 交付物 SHA-256 校验 | ❌ 本调度器不参与，因此没有 `deliverableHash` / `missingDeliverable`。 |
| job 持久化 / 恢复 / 注册表 | ❌ 不在本调度器的 job 模型里。 |

### 3.3 何时选它

- **必须用 Codex 原生能力**（浏览器 / 文档 / 可视化 / 该链路独有的工具）。
- **复杂推理、跨文件高质量实现**，且你判断该链路的模型更合适。
- **档 1 用户**（没装调度器）——这是他们唯一的员工路径。

> ⚠️ **它不是失败兜底。** 它有独立的能力面，应该按 [§5](#5-路由决策树) 主动路由。
> 把它当"其它都失败了再试试"的兜底，会让路由退化成随机重试。

---

## 4. ③ deepseek-harness —— 本地 headless runner

### 4.1 接入方式

```jsonc
{
  "prompt": "<单次有界任务；不要写「接着上次继续」这种依赖上文的话>",
  "workFolder": "<绝对路径>",
  "workerBackend": "deepseek-harness",
  "maxRuntimeMinutes": 120,
  "taskType": "execution"
}
```

### 4.2 启动细节

supervisor 不启动 `claude`，而是：

```
node dist/deepseek-worker.js --job <jobId>
```

该适配器调用本机已安装的 headless runner（`@deepseek-ai/dsh`），并把**最终文本**封装成共享 parser
的 `assistant` / `result` 事件。它：

- **只做只读 capability probe**，不安装、不修改、不读取任何凭据；
- 不伪装成 Claude 的端口 / `permission-mode` 路由——它的模型、provider、审批策略由 harness 自己的
  profile 管理；
- 在**没有结构化 permission/control 事件**时不合成 attention（这正是 `supportsAttention=false` 的含义）；
- bridge 默认关闭，且**不做磁盘自动发现**：桥接插件不是本仓库的一部分，本仓库不假定它的任何
  安装位置。只有本进程环境显式设了**非空、且指向真实文件**的 `DEEPSEEK_HARNESS_BRIDGE_PATCH`
  才会传 `--patch`；`DEEPSEEK_HARNESS_DISABLE_BRIDGE=1` 永远优先并完全禁用。

Job 侧仍保留统一的监督、超时、取消与审计语义——**共享的是调度/可靠性骨架，不是 Claude 的
stream-json 等价物。**

### 4.3 续做语义（最容易说错的一条）

`claude_code_reply` 对 harness 后端**默认被拒**：

```
fresh_turn_authorization_required
```

- 这个拒绝**不依赖任何 feature flag**，发生在任何 kill / supersede / 目录创建 / 新 job 写入**之前**。
- 传 `allowFreshTurn=true` 才执行：新的**独立**有界轮次，新 `sessionId`、`replyMode=fresh_turn`；
  **绝不** resume 父会话、**绝不**伪称会话连续性。
- 父 job / session / PID 在该门前完全没有被触碰。

> **表述纪律：没有真实 resume 语义时，不得称之为"续做"。**
> 说错了，领导就会写出"按你上轮说的继续改"这种指令，而员工那边其实什么都没有——这是最难排查
> 的一类失败。

### 4.4 能力矩阵（真值）

```ts
// src/backend-policy.ts
'deepseek-harness': {
  backend: 'deepseek-harness',
  supportsCancel: true,          // ✅
  supportsAttention: false,      // ❌ 无权限/控制事件
  supportsLiveEvents: false,     // ❌ 只有最终文本
  supportsSessionResume: false,  // ❌ 单次有界
  replyMode: 'fresh_turn',       // → 不是 resume
}
```

`workerCapabilities()` 在此基础上**只追加可用性事实**：probe 的 `available` / `version` /
`bridgePatch`，以及 `bridgeConfigured`（严格等于"本进程环境显式 opt-in 且未禁用"）。
**能力布尔值永远来自上面这张固定矩阵。** 如果 `claude_code_health` 报出与它不符的值，
说明加载的构建不对——重载 MCP。

### 4.5 探测失败的两个 reason

| `unavailableReason` | 含义 | 处置 |
|---|---|---|
| `root_missing` | 所有候选安装根都不存在 | 装 `@deepseek-ai/dsh`，或设 `DEEPSEEK_HARNESS_ROOT` |
| `runner_missing` | 根存在，但找不到 runner 入口（`lib/bin.js` / `apps/cli/lib/bin.js` / `apps/cli/src/bin.ts`） | 设 `DEEPSEEK_HARNESS_RUNNER` 指向实际入口 |

见 [TROUBLESHOOTING §7](./TROUBLESHOOTING.md)。

### 4.6 何时选它

- 该供应商链路的**缓存与适配显著占优**，且任务是"一趟干完"型。
- 不需要跨任务续会话、不需要 attention、不需要实时可见性。
- **不适用**：需要反复迭代的疑难排查、需要审批介入的动作、需要看逐步骤进展的长任务。

---

## 5. 路由决策树

```
用户显式指定了 backend / agent_type？
        │
        ├─ 是 ─▶ 用它。用户指定最高优先，不再优化。
        │
        └─ 否
           ▼
   任务本身是"该不该派给别人"的问题吗（方案/架构/trade-off/优先级/验收标准）？
        │
        ├─ 是 ─▶ 不派。这是领导自己的活，派出去就是把"想清楚"外包。
        │        （判据：删掉调度器样板文字后，prompt 里只剩一个开放式问题 → 越界了）
        │
        └─ 否
           ▼
   是否必须用某条路径的原生能力（浏览器 / 文档 / 可视化 / 该链路独有工具）？
        │
        ├─ 是 ─▶ luna_worker（Codex 原生能力面）
        │
        └─ 否
           ▼
   是复杂推理 / 跨文件高质量实现 / claude 与 harness 链路边界外的任务？
        │
        ├─ 是 ─▶ luna_worker（按判据主动选择；它不是失败兜底）
        │
        └─ 否
           ▼
   需要"同任务续做/修复"（同一会话里反复收敛）？
        │
        ├─ 是 ─▶ claude（真 resume）。
        │        绝不选 harness——它只支持新独立轮次，选它等于每次重开。
        │
        └─ 否
           ▼
   需要 attention 审批事件 / 实时可见窗口来及时发现"卡住了"？
        │
        ├─ 是 ─▶ claude
        │
        └─ 否
           ▼
   某条链路缓存/成本显著占优，且任务是一趟干完型？
        │
        ├─ 是 ─▶ deepseek-harness
        │
        └─ 否
           ▼
   默认：通用实现 / 修复 / 成熟工具链 ──▶ claude（成本最低、链路最稳）
```

### 5.1 补充纪律

- **用户显式指定 > 一切自动优化。** 自动路由是默认值，不是特权。
- **同一 wave 只混同 backend。** 缓存保热按 backend 的系统前缀分桶；跨 backend 混波 = 保热失效。
- **长任务拆成 N 个串行 `start` 是最贵的写法。** 每次 `start` 都是新 session，首请求必然全量 miss。
  需要迭代就走 `reply`（claude）或 `followup_task`（luna）。
- **两个并发参数别混淆**：`internalAgentParallelism`（auto/1–4）管**单个 worker 内部**拆子 Agent 的
  并行度；`desiredWorkerConcurrency`（1–64）管**领导层**同时派几个 worker。两者正交。
- **本机资源红线**：主会话与 worker 进程同时驻留内存时，低内存导致真实崩溃是发生过的事，不是理论
  风险。做法是把常驻的重型 GUI 应用当作内存压力信号，按实时 memory / admission 信号降容或串行，
  而不是设一个固定数值。

---

## 6. 能力对照速查（可粘贴给领导看的那种）

| 你要做的事 | claude | luna_worker | deepseek-harness |
|---|---|---|---|
| 后台跑 2 小时 | ✅ | ✅（Codex 侧） | ✅ |
| 事件驱动等 0 回合 | ✅ `watch` | Codex 原生 | ✅ `watch` |
| 中途卡住被温和提醒 | ✅ `attentionDetail` | Codex 原生审批 | ❌ |
| 看它逐步在干什么 | ✅ viewer / stream-json | Codex 原生 | ❌ 只有最终文本 |
| 同一会话里继续改 | ✅ `reply` | ✅ `followup_task` | ❌ 只能 `allowFreshTurn` 开新轮次 |
| 放弃并留下审计痕迹 | ✅ `cancel` | Codex 原生 | ✅ `cancel` |
| 产一份可 SHA-256 校验的报告 | ✅ | ❌ | ✅ |
| 按 profile 控制只读/全通过 | ✅ 三档 | ❌（Codex 侧规则） | ❌（harness 自己的 profile） |

---

**相关文档：** [README](../README.md) · [SETUP](./SETUP.md) · [METHODOLOGY](./METHODOLOGY.md) ·
[TROUBLESHOOTING](./TROUBLESHOOTING.md)
