# AGENTS.md

面向在此仓库工作的 coding agent。**只写"看代码不容易知道"的约束**。
通用项目介绍见 [README.md](./README.md)，安全模型见 [SECURITY.md](./SECURITY.md)。

## 这是什么

一个**本地异步 MCP 任务编排器**（TypeScript，Node ≥ 20，ESM）：Codex 主会话当 LEADER，
把长任务派给 worker（`claude` / `deepseek-harness`），job 由**独立 supervisor 进程**执行，
磁盘上的 job JSON 是唯一真相。

**改代码前必须理解的机制**（这些决定了大部分"看起来多余"的代码）：

1. **MCP server 与 supervisor 是两个进程**。`claude_code_start` 只做派发（<10 s 返回 `jobId`），
   真正执行在 detached supervisor 里，客户端断开不影响 job。
2. **`runtime/jobs/<jobId>.json` 是唯一真相**，写法是 `tmp 文件 + rename` 原子替换
   （`atomicWriteJson`，带重试）。**rename 是唯一会改目标的步骤**，所以 rename 失败时目标文件仍是上一份合法 JSON——不要为了"少一次 IO"改成直接写。
3. **终态单调**：所有状态迁移都走 `updateJobIf(jobId, guard, patch)`。终态一旦发布就**不允许回滚**，
   并发的 cancel 也不会输给迟到的写入。绕过 `updateJobIf` 直接写 job 会破坏这条不变量。
4. **单写者靠文件系统 CAS**：`runtime/claims/<jobId>.state.json`（`O_EXCL` + owner 身份 + lease）
   是唯一的写入入口；supervisor 与 recoverer 各自抢 O_EXCL claim，只有赢家能 ack/spawn/recover。
   已验证存活的锁**永不被抢**；已死或身份不匹配的锁通过原子 rename 挪走。
5. **PID 必须带身份使用**：PID 与进程创建时间一起存（`supervisorPidStartedAt` / `pidStartedAt`）。
   无身份或身份不匹配的 PID **绝不 kill、绝不 attach**（`src/proc.ts`）。这是 Windows PID 复用的防线。
6. **等待是事件驱动的**：`JobEventBroker`（`src/job-events.ts`）`fs.watch` 的是 **jobs 目录**而不是
   单个文件句柄——因为 job 文件是被 rename 替换的。同时观察 `<jobId>.json` 与 `<jobId>.done.json`；
   订阅用「读状态 → 注册 → 再读状态」双重检查关掉竞态；15 s 内部兜底只在有订阅时运行，且**从不返回 running**。
7. **权限与路由是 per-job 注入的**：每个 job 写自己的 `runtime/settings/<jobId>.settings.json`，
   用 `--settings` 传入。实测 `--settings` 里的 env 块能覆盖 CLI 自己的 `~/.claude/settings.json`，
   而进程环境变量**不能**——这就是路由能生效的原因。
8. **`deny` 只能收紧不能调低**：生效规则 = 内置 `DEFAULT_WORKER_DENY`（`src/config.ts`）∪ 你的白名单文件。
   白名单缺失/损坏/更窄时，缺失部分由基线补齐并在 `warnings[]` 里如实报告（`worker whitelist incomplete … Nothing is broken` 是提示，不是故障）。

## 常用命令

全部核实自 `package.json` 的 `scripts`（Node ≥ 20）：

```bash
npm run build                 # tsc -p tsconfig.json && node scripts/copy-runtime-assets.mjs
npm test                      # build + build:test + node --test "dist-test/test/*.test.js"
npm run test:unit             # 只跑 unit 层（node scripts/run-test-tier.mjs unit）
npm run test:integration:serial
npm run test:windows          # Windows 进程身份层
npm run test:gate             # unit → integration → windows → smoke 顺序闸门
npm run test:smoke:gate       # node scripts/run-smoke-suite.mjs --mode=gate
npm run test:smoke:offline-all
npm run test:smoke:all        # 含 live 分类，但 live 只在 ORCHESTRATOR_ALLOW_LIVE_SMOKE=1 时执行
npm run start                 # node dist/index.js（MCP server 入口）
npm run supervisor            # node dist/supervisor.js
npm run smoke:watch-long      # node smoke/watch-long-smoke.mjs
node tools/init.mjs           # 只读环境探测；只往 ./generated/ 写建议配置
node dist/viewer.js <jobId>   # 给某个 job 开实时可见窗口
```

**测试不花模型额度**：套件跑 `test/fake-claude.mjs`（假 CLI，回放 stream-json 协议）。
不要为了让测试"更真实"去接真模型。

## 改动纪律

**高风险区（改动前先想清楚，并补对应测试）**

- 状态机与 `updateJobIf` 的 guard 表达式：终态单调、并发 cancel 语义都挂在这里。
- `isValidJobRecord`（`src/job-store.ts`）：它冻结的是**对外契约**。后续可选字段遵循
  "缺了可以，写错就拒"。放宽它 = 让坏数据进入唯一真相。
- `parseDoneMarker`：只接受终态或 `needs_attention`；`queued`/`running` 一律拒。
  **非法 done 标记按不存在处理**，绝不推进也绝不回滚状态。
- `JobEventBroker` 的退出路径：每条 resolve/error/timeout/abort 路径都要幂等地清掉
  listener、timer 和 handle；最后一个订阅者离开时才关目录 watcher。
- 健康检查必须保持**只读**：不 kill、不重启、不修复、不清理（除自身心跳外不写运行时状态）。
  唯一的例外口径是 `reloadRequired`/`diagnostic` 的判断——**存疑即不健康**
  （指纹读不到 → `hash_unavailable` + `reloadRequired=true`）。
- 构建指纹覆盖**整个 production dist 模块集合**（不只是入口）。改任何一个依赖模块都会让
  `reloadRequired=true`——这是有意设计，不要"优化"成只哈希入口。

**已知取舍：不要"修"**

- `auto` profile **没有沙箱**（`bypassPermissions`），且**没有**模型权限分类器——
  旧设计每调用插一次模型请求，超时、阻塞已批准的工作、烧额度，已被移除。别把它加回来。
- `deny` 是**字面前缀黑名单**，换写法 / 脚本 / `npx` 中转都能绕过。它是爆炸半径削减，
  不是强制边界——不要把文档或注释写成"沙箱"。
- `claude_code_watch` **在 job 还在跑时永不返回 `running`**（这是它零 turn 的原因）；
  `claude_code_wait` 自限 240 s（单次调用 <300 s 边界）。别让 watch 退化成轮询。
- 客户端中断 `watch` **不等于**取消 job：abort/断开只清 watcher，不改 job 状态与进程。
- `needs_attention` 只由结构化控制/权限事件驱动（`userPrompt` / `control_request` /
  `permission_request`），并有默认 5 s 确认窗口（`ORCHESTRATOR_ATTENTION_CONFIRM_MS`）。
  普通文本 banner、stderr 噪声、慢工具**不应**产生 `needs_attention`。
- `attentionDetail` 是**纯可观测**：永不含完整 prompt / 原始日志 / token / diff / key / env；
  从不自动批准、不继承授权、不做去重自动回复；`requestId` 不是授权凭据。
  回复审计一律 `authorization: false`——不要让它变成某种"批准"。
- deepseek-harness 是**一次性**后端：`supportsAttention=false`、`supportsLiveEvents=false`、
  `supportsSessionResume=false`。给它 reply 默认拒绝（`fresh_turn_authorization_required`），
  `allowFreshTurn=true` 跑的是**全新独立 turn**（`replyMode=fresh_turn`），**永远不要说成"续跑"**。
- `luna_worker` 是 Codex 原生子代理，**不经过本编排器**；续跑用 `followup_task`，
  不要为它接 `claude_code_reply`。
- retention 只有只读 dry-run（`claude_code_retention_preview`），**故意没有 apply/delete 工具**。
- `ORCHESTRATOR_RETENTION_V2` 关闭时预览**完全不扫 runtime**，并保持旧文件布局；
  别为了"统一"顺手改成总是扫描。
- 无命令行形式：`--add-dir=` / `--disallowedTools=` / `--allowedTools=` 用 `=` 形式，
  空格形式会贪婪吃掉后面的 prompt 位置参数（注释里已写明）。
- 平台现状：**仅 Windows 经过验证**。POSIX 分支有测试覆盖但没人端到端跑过——
  不要在没有实机验证的情况下把文档改成"支持 macOS/Linux"。

## 目录 / 模块速览

| 路径 | 职责 |
|---|---|
| `src/index.ts` | MCP 入口：注册 9 个工具、启动恢复、健康指纹、实例登记 |
| `src/scheduler.ts` | start/status/wait/watch/reply/cancel/list + 恢复 + deliverable 视图字段 |
| `src/supervisor.ts` | detached job 执行器：claim、ack-before-spawn、attention 窗口、deliverable 校验、done 标记 |
| `src/job-store.ts` | 原子持久化、对外视图（不含 prompt）、CAS 状态锁、严格校验 |
| `src/job-events.ts` | 跨进程共享的 `JobEventBroker`（目录级 `fs.watch` + 内部兜底） |
| `src/parser.ts` | 共享的增量行缓冲 stream 解析（分块、事件分类、attention 脱敏） |
| `src/render.ts` | 共享的可读渲染（status 尾部 + viewer） |
| `src/recovery.ts` | 三阶段 bootstrap checkpoint/claim + 单 recoverer 恢复 |
| `src/registry.ts` | 实例登记 + 心跳 + 进程身份 / PID 复用 + stale/duplicate 快照 |
| `src/health.ts` | 只读健康 / 版本 / 重载 / 实例诊断 |
| `src/router.ts` | profile → 端口/权限真值表 + `taskType`/`deliverablePath` 校验 |
| `src/backend-policy.ts` | backend 能力矩阵 + reply preflight（纯函数，无副作用） |
| `src/worker-adapter.ts` | backend 选择 + 只读 harness 探测 |
| `src/config.ts` | 路径与常量（`DEFAULT_WORKER_DENY` 在这里） |
| `src/proc.ts` | `isAlive` / `killTree` / PID 身份 / Windows 窗口可见性 |
| `src/viewer.ts` | 实时控制台窗口（按字节偏移 tail，跟随 session 链） |
| `src/admission*.ts`、`budget*.ts`、`job-metrics.ts`、`contracts-v2.ts`、`retention.ts`、`job-index.ts`、`leader*.ts`、`review-policy.ts`、`acceptance-runner.ts` | 默认关闭的进阶能力（准入控制 / 预算 / 指标 / v2 契约 / 留存 / 索引 / leader 包装） |
| `test/` | `node:test` 单测与集成套件 + 假 CLI 夹具（零真实模型调用） |
| `smoke/` | 离线与 live smoke 脚本 |
| `tools/init.mjs` | 只读环境探测 + 配置生成（对**你已有的文件**只读） |
| `templates/` | 可直接粘贴的规则 / 配置 / 白名单模板 |
| `config/` | worker 侧 hermetic MCP 配置 |
| `scripts/` | 构建辅助（copy-runtime-assets / run-test-tier / run-smoke-suite / task-chain-eval） |
| `runtime/` | 运行时生成：jobs / logs / settings / reports / claims / registry |

## 不要做的事

- **不要按镜像名批量杀进程**（`taskkill /IM node.exe` 之类会一锅端掉宿主机与其它 agent 进程）。
  只按**精确 PID**操作，且先确认 PID 身份（PID 复用是真的）。
- 不要让 `claude_code_health` 变成"自动清理/自动重启"工具——它有明确的手工 runbook。
- 不要把 `runtime/` 里的 job JSON 当缓存删掉：它是唯一真相，也是唯一保存完整 prompt 的地方
  （任何工具都不会返回 prompt，这是有意的）。
- 不要往 `llms.txt` / `AGENTS.md` / README 里写没在代码或 `package.json` 里核实过的命令、路径或工具名。
- 不要提交 `dist/`、`dist-test/`、`runtime/`、`node_modules/`、`generated/`（见 `.gitignore`）。
- 不要本仓库内分发或内嵌 `@anthropic-ai/claude-code`（专有软件）、Codex CLI、`@deepseek-ai/dsh`：
  只通过 `child_process` 调用用户自己装的那一份。许可边界见
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
