# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through GitHub Security Advisories on this repository:

> https://github.com/awslew/codex-job-orchestrator/security/advisories/new

If you cannot use that channel, at most open a public issue that says **only** "I have a security
report and need a private channel" — with no details, no reproducer and no affected-path hints.

This is a volunteer project with no bug-bounty program. We aim to acknowledge within 7 days.

## Threat model — read this before reporting

This software is a **local orchestrator that runs AI coding agents unattended, as your user, with
your filesystem and network access**. No container, no VM, no privilege drop. Its default profile
launches workers with `--permission-mode bypassPermissions`, which means **no per-action approval and
no sandbox**.

The safety boundary is therefore deliberately narrow. The behaviours below are **documented design
properties, not vulnerabilities**:

| Behaviour | Why it is not a vulnerability |
|---|---|
| A worker can read or modify anything your user account can reach | It runs as you — by design |
| `deny` rules are literal command/path **prefix** matches, bypassable via indirection (`npx`, writing a script, re-quoting) | Documented; only `Bash`/`Read`/`Edit`/`Write`/`WebFetch`/`WebSearch` rules are consulted at all |
| `workFolder` is validated only as "an existing absolute directory" — there is no root allow-list | Documented; scoping the folder is the caller's decision |
| The built-in `deny` baseline cannot be lowered by configuration | Intentional: it is a floor, not a default |

**In scope:** code execution that does *not* require a worker's normal privileges; escaping the
process-identity checks in `src/proc.ts`; credential leakage into logs or child environments; TOCTOU
in the job store; path traversal in report/deliverable handling; and anything that makes the
orchestrator act on input the user did not direct it to act on.

---

# 安全策略（中文）

## 报告漏洞

**不要用公开 issue 报告安全问题。** 请走本仓库的 GitHub Security Advisories 私下报告：

> https://github.com/awslew/codex-job-orchestrator/security/advisories/new

若无法使用该渠道，最多只能开一个**不含任何细节**的 issue，说明"我有安全报告需要私下联系"。本项目是
无赏金的志愿项目，我们会在 7 天内回应。

## 威胁模型（报告前请先读）

本工具会**以你的身份、无人值守地**在你的机器上运行 AI 编码 agent，没有容器、没有虚拟机、没有降权，
默认档以 `--permission-mode bypassPermissions` 启动 worker，即**没有逐项审批、也没有沙箱**。

因此安全边界是刻意收窄的。下列行为是**已在文档中如实声明的设计属性，不算漏洞**：

| 行为 | 为什么不算漏洞 |
|---|---|
| worker 能读改你的账号能触达的任何文件 | 它就以你的身份运行，这是设计 |
| `deny` 是**字面前缀**匹配，可用间接调用（`npx`、写进脚本、改引号）绕过 | 已声明；且只有 `Bash`/`Read`/`Edit`/`Write`/`WebFetch`/`WebSearch` 这几类规则会被检查 |
| `workFolder` 只校验"是已存在的绝对目录"，没有根目录白名单 | 已声明；目录范围由调用方决定 |
| 内置 deny 基线无法通过配置降低 | 有意为之：它是地板，不是默认值 |

**属于受理范围的**：不需要 worker 正常权限即可达成的代码执行；绕过 `src/proc.ts` 的进程身份校验；
凭据泄漏进日志或子进程环境；作业存储的 TOCTOU；报告/交付物处理的路径穿越；以及任何让调度器去执行
"用户并未指示它执行"的输入。
