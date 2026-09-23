# `worker-whitelist.json` —— worker 权限白名单说明

> **为什么有这份 README**：JSON 标准不支持注释，而白名单里的每一项都需要解释「为什么放行 /
> 为什么拒绝」。所以 JSON 里只保留一份压缩版说明（`description` 字段），细节全部写在这里。
> 改白名单前请先读本文对应小节。

## 1. 这个文件是什么、放在哪

`worker-whitelist.json` 是 **worker 的权限白名单**，结构分三层：

```
permissions.defaultMode   —— 默认档位：不匹配任何规则时怎么办
permissions.allow         —— 显式放行清单
permissions.deny          —— 硬性拒绝清单（优先级最高）
```

- **谁读它**：调度器在拉起 **Claude Code 档 worker** 时，把它作为 per-job settings 注入。
- **默认位置**：`~/.claude/worker-whitelist.json`（Windows 上是 `%USERPROFILE%\.claude\worker-whitelist.json`）。
- **改位置**：设置环境变量 `ORCHESTRATOR_WHITELIST_PATH` 指向你的文件即可。本仓库里的
  `templates/worker-whitelist.json` 只是**模板**，用不用随你；要直接用就把它复制到上面的默认位置，
  或让 `ORCHESTRATOR_WHITELIST_PATH` 指向模板所在路径。
- **内置基线会与你的 `deny` 取并集（最重要的一条陷阱）**：生效的 `deny` 永远是
  **「代码内置基线（`src/config.ts` 的 `DEFAULT_WORKER_DENY`）∪ 你这个文件里的 `deny`」**，
  不是"二者取一个"。所以：
  - **`deny` 不可能被配置降低**：你可以往里**加**禁令，但删不掉基线里的任何一条（凭据目录读取、
    批量删除、网络出口、push/publish、`env`/`printenv`……）。这是刻意的——白名单文件可能是从别处
    拷来的模板、也可能被人（或某次提示注入）改过，安全底线不能由它决定。
  - **本模板自带的 `deny` 只是其中一部分**，不要以为"拷了模板就只剩这些规则"：基线里本模板没写的
    条目（如 `curl`/`wget`/`ssh`/`scp`、`~/.ssh`、`~/.npmrc`、`npm publish`、`git -C * push *`、
    `taskkill //IM *`、`WebFetch`/`WebSearch`）**同样生效**。想知道某一刻到底注入了几条，看
    `claude_code_start` 返回的 `warnings`（基线补了几条会写出来）或该 job 的
    `runtime/logs/<jobId>.stderr.log` 里那行 `worker policy fallback`。
  - 反过来，`allow` **不会**被我们擅自放大：文件里写什么就是什么（只有文件不可用时才退回内置的窄
    清单）。「不擅自放大使用者授予的权限」这条原则只针对 `allow`；`deny` 取并集是**收紧**方向。
- **文件不存在时会发生什么**：
  - `allow` 退回一份保守的内置清单（只有 `Read` / `Write` / `Edit` / `MultiEdit` / `Glob` /
    `Grep` / `TodoWrite`）；
  - `deny` 就是那份内置基线本身（同上，`DEFAULT_WORKER_DENY`：批量删除 / 格式化 / 关机、批量按
    镜像名杀进程、`git push` 与 `npm publish`、`curl`/`wget`/`powershell` 等网络出口、`~/.ssh`
    `~/.aws` `~/.npmrc` 等凭据位置、`env`/`printenv` 环境变量导出、系统目录写入……）。
  **`deny` 在任何情况下都不会是空数组**——这是 `auto` 档唯一真正生效的规则（见第 2 节）。
  所以缺文件的语义是「用内置基线策略跑」，不是「无策略裸奔」，也**不是**「逐条审批」：在
  `bypassPermissions` 下"没写进 `allow`"**不等于**被拒，未命中 `deny` 的命令照样执行。
  内置基线仍然明显弱于一份按你本机情况写的白名单，所以**认真配一份白名单是安装期的必要步骤**。
- **你怎么知道自己在用回退 / 叠加策略**：`claude_code_start` / `claude_code_reply` 的返回里会出现
  `warnings`（写明白名单不可用的原因、`deny` 回退或被基线补齐了几条、`allow` 是否退回内置清单），
  该 job 的 `runtime/logs/<jobId>.stderr.log` 里也会有一行 `worker policy fallback`；
  `claude_code_health` 的 `notes` 同样会提示。看到任何一条就说明**你的策略没有完全生效**。
- **适用面**：只有 Claude Code 档 worker 消费这份白名单。Codex 原生 Luna 档、deepseek-harness 档
  各自走自己的沙箱与审批机制，与本文件无关。

## 2. `defaultMode`: `bypassPermissions` —— 为什么这么设

含义：**worker 不逐项审批**。文件编辑、Bash 命令、工具调用一律直接放行，也不会向任何模型发起
「这个操作安全吗」的分类请求。

为什么不逐项审批：

- 曾经使用过的 Auto 权限分类器会持续超时，既阻塞已经获批的操作，又反复消耗额度，
  于是「自动审批」实际效果是「随机卡住」。**本模板不使用该机制。**
- 调度器是异步的：worker 跑在后台、无人盯着终端，弹出来的审批请求没人点，job 就停在
  `needs_attention` 上。异步编排里，逐项审批本身就是反模式。

那么安全性靠什么？**靠 `deny` 清单，但它只是"防手滑"级别的兜底**（见第 4 节及该节末尾的
「已知的绕过面」）。请准确理解这个取舍：`bypassPermissions` **不是**「没有安全策略」，但也
**不是**沙箱——它是「策略前移成一份静态的、可绕过的前缀黑名单」。真正不可逆的操作（推送、
发布、删除、动外部系统）请留在人工手里。

**如果这个档位对你不合适**：把 `defaultMode` 改成 `default` 或 `plan`，然后把 `allow` 数组当作
真正的白名单用（此时 `allow` 之外的每个操作都要审批）。代价是异步 job 会频繁停在审批上。

## 3. `allow` —— 常规开发命令

分组说明：

| 分组 | 内容 | 为什么放行 |
| --- | --- | --- |
| 文件类工具 | `Read` `Write` `Edit` `MultiEdit` `Glob` `Grep` `NotebookEdit` | worker 的本职工作就是改代码、查代码 |
| 编排类工具 | `TodoWrite` `Task` `Skill` | 标准 Claude Code 工具，用于规划与调用技能，不直接触碰系统 |
| 版本控制 | `Bash(git *)` | 只给 `git *` 整体放行，push 由 `deny` 单独拦住。这样 `commit` / `add` / `checkout -b` / `stash` 等日常操作不必逐条列举 |
| 运行时与包管理 | `node` `npm` `npx` `pnpm` `yarn` `bun` `tsc` `tsx` `ts-node` `python` `python3` `pip` `pip3` | 构建、跑测试、装依赖 |
| 只读查看 | `pwd` `ls` `dir` `cat` `head` `tail` `wc` `grep` `rg` `find` `tree` `file` `stat` `diff` `sort` `uniq` `where` `which` `type` `echo` `date` `hostname` `du` `df` `tasklist` | 纯读取，无副作用 |
| 文件操作与归档 | `mkdir` `touch` `cp` `mv` `tee` `tar` `unzip` `zip` `7z` | 常规文件搬运；本来 `Write`/`Edit` 也已放行，限制它们没有实际收益 |
| 校验 | `sha256sum` `md5sum` `sha1sum` `certutil` | 算哈希做校验，`certutil` 是 Windows 上的等价物 |

**如果你想把 git 收窄成"只读"**：模板给的是 `Bash(git *)`，即除 push 外的 git 写法都放行
（`add` / `commit` / `checkout -b` / `stash` 都在内），这对「要改代码的 worker」是必要的。
若你的场景只允许 worker 查看历史、不许它写版本库，就把 `Bash(git *)` 换成下面这组只读命令：

```json
"Bash(git status)", "Bash(git status *)",
"Bash(git diff *)", "Bash(git log *)", "Bash(git show *)",
"Bash(git branch *)", "Bash(git rev-parse *)", "Bash(git ls-files *)",
"Bash(git blame *)", "Bash(git stash list *)"
```

注意这种收窄会漏掉复合写法（如 `git -c foo.bar=1 status`），漏掉的命令会退回 `defaultMode`；
在 `bypassPermissions` 下这意味着它们**照样放行** —— 所以要和 `default: <更严的档位>` 搭配才有意义。

**故意没放的东西**（要加请自己评估）：

> ⚠️ **先把这一节读对：放进 `allow` 是"免审批"，不放进去不等于被拦。** 在
> `defaultMode: bypassPermissions` 下，只有 `deny` 里的条目会真正被拒；下面这些命令只是
> "不会被本模板显式放行"，它们**照样能跑**。所以下面每一行都是**建议**，不是约束——想真正拦住
> 它们，请自己加一条对应的 `deny`（同样受前缀匹配的绕过限制，见第 4 节末尾）。

- `WebFetch` / `WebSearch`：网络出口。默认不放，避免 worker 静默把仓库内容发到外部。
  需要联网检索就自行加进 `allow`；想真正限制外发，请加 `deny`。
- `env` / `printenv`：会整段打印环境变量，容易把 token 带进 job 日志（日志会落盘）。本模板
  **已把它们写进 `deny`**（即真正拦住），见第 4 节。
- `curl` / `wget` / `ssh` / `scp`：网络出口与远程写操作。
- `rm`：删除是少数不可逆操作，刻意不放行 —— 需要删文件时用 `Write`/`Edit` 工具，或你自己加
  `Bash(rm *)` 并接受风险。**注意：`rm` 不在 `allow` 里并不阻止 worker 执行 `rm`**；本模板的
  `deny` 只覆盖 `rm -rf /`、`rm -rf /c/` 这类从根目录递归强删的写法。
- 任何 `mcp__<server>__*` 形式的条目：本模板**不放**任何 MCP server 通配符。每个 MCP server 都是
  一个额外的权限面，请按你本机实际安装的 server 逐个添加。

## 4. `deny` —— 兜底，不是沙箱

**优先级**：`deny` 高于 `allow`，也高于 `defaultMode`。命中即拒绝，与 `allow` 里写了什么无关。
这也是 `defaultMode: bypassPermissions` 唯一能讲得通的理由——但请记住它同时是**唯一生效的
策略层**：在 `bypassPermissions` 下，`allow` 不构成限制。

**生效的是并集**：实际注入 worker 的 `deny` = **代码内置基线 ∪ 本文件的 `deny`**（见第 1 节）。
下表解释的是**本模板自己写的那部分**；基线补进来的部分（`curl`/`wget`/`ssh`/`scp`、`~/.ssh`
`~/.aws` `~/.npmrc` 等凭据位置、`npm publish`、`git -C * push *`、`taskkill //IM *`、
`WebFetch`/`WebSearch`……）请对照 `src/config.ts` 的 `DEFAULT_WORKER_DENY`。

| 条目 | 拦的是什么 |
| --- | --- |
| `Bash(git push)` / `Bash(git push *)` | **推送一律由人工执行**。worker 可以 commit、可以建分支，但不许把东西推到远端 —— 推错分支、推了带私有内容的 commit，都是不可逆的 |
| `Bash(shutdown *)` | 关机 / 重启，直接掐掉正在跑的所有 job |
| `Bash(reg delete *)` | 删注册表项，影响范围超出本仓库，且难以回滚 |
| `Bash(format *)` | 格式化磁盘，破坏性最强的一类命令 |
| `Bash(rm -rf /*)` / `Bash(rm -fr /*)` | 从根目录递归强删 |
| `Bash(rm -rf /c/)` / `Bash(rm -rf /d/)` | 同上，覆盖 Git-Bash/MSYS 下 Windows 盘符的写法 |
| `Bash(env)` / `Bash(env *)` / `Bash(printenv)` / `Bash(printenv *)` | 环境变量整体导出。会话的 token（`ANTHROPIC_AUTH_TOKEN` 等）会因此进入 job 日志，日志落盘且常被贴进 issue |
| `Write(C:/Windows/**)` `Edit(...)` `MultiEdit(...)` | 操作系统目录**只读保护**：不许写入或改动系统盘目录下的文件 |
| `Write(C:/Program Files/**)` `Edit(...)` `MultiEdit(...)` | 已安装程序目录只读保护，避免改坏别的软件 |

**别高估这张表：** 它（连同基线）**只**拦住那些**写法**，不代表对应的动作整体被禁。例如
`git -C … push` 不在**本表**里（基线已补上 `Bash(git -C * push *)`，但仍受前缀匹配的绕过限制）；
`rm` 整体不在 `deny` 里，只有"从根目录递归强删"这类写法被拦。这就是下一节存在的理由。

### 已知的绕过面（务必知道）

`deny` 是基于**命令前缀**的模式匹配，不是语义分析。因此：

- `git -C <某个目录> push` 这类**把全局参数插在子命令前面**的写法不会命中 `Bash(git push *)`。
  在意的话请自己补：`Bash(git -C * push *)`。
- `bash -c "git push"`、把命令写进脚本再执行、或用别名/包装脚本，同样绕得过去。
  `deny` 是**防手滑**，不是防恶意；真正不可挽回的操作请留在人工手里。

### 建议你自己补的两条（本模板刻意不默认加）

- `Bash(taskkill //IM *)` / `Bash(taskkill /IM *)`：按**镜像名**批量清杀进程。
  它会连带杀掉同名的其他关键进程（编辑器、路由器、调度器本体），误伤范围不可控 ——
  如要清理，建议只按精确 PID 操作。
- `Write(C:/ProgramData/**)` 等：如果你在 Windows 上还有别的系统级目录需要保护，按同样格式补齐。

## 5. 怎么按需增删

1. **加一条放行**：往 `allow` 里追加字符串。命令类写 `Bash(<命令前缀> *)`，
   文件类写 `Write(<绝对路径或通配>/**)`。注意 JSON 里反斜杠要写成 `\\`。
2. **加一条拒绝**：往 `deny` 里追加。改完记得确认它没有和 `allow` 里更宽的规则冲突 ——
   冲突时 `deny` 赢，这正是你要的。注意**只能加、不能减**：你写进 `deny` 的条目会与内置基线取并集，
   删掉基线里的条目不会让它失效（见第 1 节）。
3. **收窄权限面**：把 `defaultMode` 从 `bypassPermissions` 改成 `default`，此时 `allow` 才真正变成
   白名单（`allow` 之外的每个操作都要审批）；代价见第 2 节——异步 job 会频繁停在审批上。
4. **改完必须重启**：白名单是 worker 启动时读取并注入的，改完对**已经在跑**的 job 无效，
   要等新 job 才生效。
5. **不要提交你的私有版本**：本仓库只提供这份中性模板。你按本机情况改出来的实际白名单
   （尤其是含私有 MCP server 名的版本）请放在默认位置 `~/.claude/worker-whitelist.json`，
   不要写回仓库。
