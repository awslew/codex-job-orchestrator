<div align="center">

# codex-job-orchestrator

**A local async MCP job orchestrator. Turn "one 10-second MCP call" into "a job that runs for three hours in the background."**

[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![Tests](https://img.shields.io/badge/tests-fixture--based%2C%20zero%20model%20spend-informational)](#self-verification-no-model-spend)
![Platform](https://img.shields.io/badge/platform-Windows%20verified-lightgrey)

**Platform support: Windows verified only.** Process identity, window visibility, PATH/shim
resolution and service management are exercised on Windows. The POSIX branches exist and are covered
by the test suite, but **nobody has run this end-to-end on macOS or Linux** — treat those platforms
as untested rather than supported. See [`SECURITY.md`](./SECURITY.md) for the threat model and how to
report a vulnerability.

</div>

---

## English

### Security boundaries (read this before your first job)

This tool runs AI coding agents **on your machine, as you, unattended**. There is no container, no
VM, and no privilege drop: a worker inherits your user account, your filesystem permissions and your
network access, and it keeps running after you close the editor.

**The default profile (`auto`) has no sandbox.** It launches the worker with
`--permission-mode bypassPermissions`, which by design produces no approval prompts — the whole point
of an async job is that nobody is watching the terminal. In practice there are exactly three things
bounding what a worker can do:

1. **The `allow` / `deny` list.** `deny` wins over `allow`, and it is the *only* rule type that
   actually blocks a call in this profile. It is literal command/path *prefix* matching, so
   `npx`-mediated commands, a shell script, or a differently spelled command are not caught.
   `deny` is **never empty**, and the built-in default deny list (`DEFAULT_WORKER_DENY` in
   `src/config.ts` — bulk deletes, format/shutdown, `git push`, `npm publish`,
   `curl`/`wget`/`ssh`/`scp` egress, credential stores such as `~/.ssh` and `~/.aws`,
   system-directory writes) is **a floor, not a default you can override**: the rules in force are the
   **union** of that baseline and whatever your whitelist file adds. Editing your config can
   **tighten** the policy, never lower it. So the shipped `templates/worker-whitelist.json` is a
   **starting point, not the whole policy** — copying it gives you its rules *plus* the rest of the
   baseline. When your file carries fewer rules than the baseline, the scheduler unions the remainder
   in and says so in `warnings[]`; that notice is informational (it begins
   `worker whitelist incomplete … Nothing is broken`), not a failure.
2. **`workFolder`**, the job's working directory. It is validated only as "an absolute path that
   exists and is a directory" — there is no root allowlist, so it can point at your home directory
   or a drive root if the caller asks for it.
3. **The prompt you give the worker** — instructions are advisory to a model, not an enforced rule.

That leads to one operational rule worth internalising: **do not feed untrusted content to the
leader session.** A main session that can dispatch jobs is a main session whose instructions can be
supplied by whatever it just read. Pasting a stranger's repository, an unvetted issue, or an
untrusted web page into the leader conversation is equivalent to letting that stranger run commands
on your machine. A deny list reduces the blast radius — it does not remove the risk: a prompt
injection can still edit the files inside `workFolder`, run the build and test tooling that is
allowed, and reach whatever the allowed commands can reach.

Practical habits:

- Give workers a **dedicated working directory**, not your home directory, and not a directory whose
  siblings hold things you cannot lose.
- **Never set a directory containing credentials as `workFolder`** (SSH keys, cloud CLI config,
  `.env` files, token stores).
- **Install the whitelist and read the `warnings[]` in every start/reply response.** `unusable` means
  your file was not read at all (the built-in policy is in force); `incomplete … Nothing is broken`
  means the baseline was union-ed in on top of your rules. Either way it is also recorded in
  `runtime/logs/<jobId>.stderr.log` and surfaced in `claude_code_health` notes.
- **Read job logs periodically** — they are the only record of what a worker actually did.
- Treat `deny` as blast-radius reduction, useful and worth composing carefully, but not as a sandbox.

> Consider running this on a machine or VM you would be comfortable giving full shell access to.

### What this is

`codex-job-orchestrator` is a **local, asynchronous, MCP-native scheduler**. Your Codex main
session acts as the *leader* and dispatches long-running work to *workers*. Instead of blocking a
single tool call for 30–180 minutes, `claude_code_start` returns a `jobId` in under 10 seconds, the
work continues in a detached process, and you wait **event-driven** with `claude_code_watch` — one
MCP call that stays suspended until the job actually reaches a terminal state or needs your
attention. While the job runs, that call costs **zero model turns**.

### The problem it solves

A chat-style agent loop and a long-running task are a bad match, and MCP makes the mismatch worse:

| Constraint | Consequence without a job model |
|---|---|
| An MCP tool call is a **synchronous request/response** | The host kills the call on timeout; a 30-minute task simply cannot be a tool call |
| The main session's context is the **most expensive** context you own | Streaming a 90-minute build log into it permanently pins thousands of tokens into every later turn |
| Waiting must be **event-driven, not poll-driven** | Every poll is another model turn; polling burns budget for zero information |
| A long task must survive **disconnects** | Closing the client, restarting the host, or dropping the transport should not lose the job |
| Work has to be **queryable and resumable** | You need to ask "what is it doing?", "is it stuck?", "can you keep going?" |

The job model answers all five: a **detached supervisor process** owns execution, a **job JSON on
disk** is the source of truth, a **cross-process event broker** wakes waiters, and the MCP layer
only ever returns compact summaries.

### Three-tier architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 1 · LEADER — your Codex main session                                    │
│                                                                              │
│   Plans, architecture, trade-offs, priorities, acceptance criteria.          │
│   Owns the final accept/reject decision. Never delegates the thinking.        │
│                                                                              │
│   Tools available: claude_code_start / status / wait / watch / reply /        │
│                    cancel / list / health / retention_preview                 │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  dispatch (≤10s, returns jobId)
                │  wait     (event-driven, zero turns while running)
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 2 · WORKERS — three routes, chosen by backend, never by model name      │
│                                                                              │
│  ① claude             Claude Code CLI        workerBackend=claude   (default) │
│     └─ managed by this orchestrator · real session resume · attention ·      │
│        live event stream · full job lifecycle (start/watch/reply/cancel)     │
│                                                                              │
│  ② luna_worker        Codex native subagent  agent_type=luna_worker          │
│     └─ NOT routed through this orchestrator (Codex collaboration, not MCP)   │
│        continue with followup_task, not claude_code_reply                    │
│                                                                              │
│  ③ deepseek-harness   local headless runner  workerBackend=deepseek-harness  │
│     └─ managed by this orchestrator · one-shot, bounded turns ·             │
│        no attention · no live events · no session resume                    │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  detached supervisor process (survives MCP/host restart)
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 3 · PERSISTENCE & EVENTS (shared, backend-neutral)                      │
│                                                                              │
│   runtime/jobs/<jobId>.json    atomic job record (source of truth)           │
│   runtime/logs/<jobId>.log     stdout stream · .stderr.log human log         │
│   runtime/settings/<jobId>.settings.json   per-job permission + env injection│
│   runtime/claims/              single-writer CAS locks (no double supervisor)│
│   runtime/registry/instances/  one record per MCP process + heartbeat        │
│   JobEventBroker               fs.watch over the jobs dir → wakes watch      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Positioning: enforced delegation by default

This repository's opinionated stance is **enforced delegation**: install it, and your main session
**dispatches implementation work by default** and keeps only planning, trade-offs, prioritisation
and acceptance for itself. That is the whole point of the design — not a side effect.

The reasoning is written up in [docs/METHODOLOGY.md](docs/METHODOLOGY.md); the ready-to-paste rule
template is [templates/AGENTS.strict-delegation.md](templates/AGENTS.strict-delegation.md).

**Be honest with yourself about whether you want this.** Enforced delegation has a real cost: handoff
overhead per task, deliberately narrow worker receipts, and added latency. It pays off when (a) the
leader model is much more expensive per token than the workers, (b) tasks are blocky enough that the
dispatch overhead amortises, and (c) several heterogeneous backends give you genuinely different
capability surfaces. If you prefer the main model to just do the work itself and delegate only when
you explicitly ask, **skip to [Tier 1 · Luna-only](#quick-start-tier-1--luna-only-codex-native-subagent-zero-dependencies-recommended-entry-point)**
— the scheduler is optional, and the three tiers are deliberately ordered from least to most
commitment. See [docs/METHODOLOGY.md §8–9](docs/METHODOLOGY.md) ("scope and controversy") for the
arguments against this approach, written by the author himself.

### What it is *not*

- It is **not** a hosted service, a proxy, or a model router. Everything runs locally.
- It does **not** install `claude`, does **not** touch your credentials, and does **not** read your
  tokens. See [Prerequisites](#prerequisites).
- It is **not** a replacement for Codex's native subagents. Tier 1 below is the native path.
- It does **not** ask you to approve anything per call, and it does **not** sandbox the worker.
  The default `auto` profile runs the worker with `--permission-mode bypassPermissions`: it is built
  for unattended execution, so no call waits for a human. What actually bounds the worker is only
  (a) the `deny` list in force, (b) the `workFolder` you pass to `claude_code_start`, and (c) the
  instructions in the prompt you give the worker. Read
  [Security boundaries](#security-boundaries-read-this-before-your-first-job) before your first job.

---

### Quick start (three tiers, ordered by cost)

> Every tier is useful on its own. Start at Tier 1.

#### Quick start Tier 1 · Luna-only (Codex native subagent, zero dependencies) — **recommended entry point**

**Requires:** Codex CLI. Nothing else. **Time:** ~5 minutes. **External dependencies:** none.
**This tier does not use this orchestrator at all.**

This is the cheapest possible way to get the "leader + worker" split, because it uses the delegation
mechanism Codex already ships. You define a worker agent and tell Codex to use it.

**1. Create the worker definition** at `<CODEX_HOME>/agents/luna_worker.toml` (`<CODEX_HOME>` is
usually `~/.codex`):

```toml
name = "luna_worker"
description = "Cost-efficient native Codex worker for clear, bounded, repeatable subtasks."
model = "<YOUR_WORKER_MODEL>"          # a model you have access to, cheaper than your leader model
model_reasoning_effort = "high"

developer_instructions = """
You are a worker: execute only the bounded implementation, test, or fact-gathering task
specified by the parent agent. Preserve the parent session's sandbox, approval, tool and
MCP boundaries. Write only files inside your assigned ownership set.
Do not make architecture, product or trade-off decisions, do not prioritise, do not set
acceptance criteria, and do not give final conclusions — those belong to the parent.
Report: status, backend/agent type, changed files or evidence locations, acceptance items,
self-test results, remaining risks/unknowns. Never claim success without command evidence.
"""
```

**2. Enable the agents section** in `<CODEX_HOME>/config.toml`:

```toml
[agents]
enabled = true
default_subagent_model = "<YOUR_WORKER_MODEL>"
default_subagent_reasoning_effort = "high"
max_concurrent_threads_per_session = 4   # keep it modest; each thread is a real OS process
```

**3. Restart Codex, then dispatch one bounded task** and see whether the worker comes back with a
usable receipt. If it does, you have the whole methodology's core benefit with zero installation.

**Continuation semantics:** same task → `followup_task` on that subagent. Do **not** call
`claude_code_reply` — a native subagent is not one of this orchestrator's backends.

**Cost profile:** zero infrastructure. You pay only for the worker model's tokens.

---

#### Quick start Tier 2 · + Claude Code worker

**Requires:** Codex CLI + `claude` CLI (you install it, see [Prerequisites](#prerequisites)) + this
repository. **Time:** ~15 minutes. **Adds:** real session resume, attention/permission events, a
live console window, cancel, job listing, health diagnostics.

| Step | Command / action | Expected result |
|---|---|---|
| 1 | `git clone <this repo>` then `npm install` | Dependencies installed; no `npm` script named `prepare` runs anything external |
| 2 | `npm run build` | `dist/index.js` exists; `dist/orchestrator-launcher.cjs` may also exist |
| 3 | `node tools/init.mjs` | Read-only environment probe; writes suggested config into `./generated/`. **It never modifies your existing files.** |
| 4 | Merge `generated/codex-config.snippet.toml` into `<CODEX_HOME>/config.toml` | See step-by-step in [docs/SETUP.md](docs/SETUP.md) — and read the two ⚠️ traps below |
| 5 | Install the worker whitelist (see [Worker permissions](#worker-permissions-and-attention)) | If the file is missing the job still runs under the built-in policy; if it is narrower than the baseline the rest is union-ed in. Both are reported in `warnings[]`. In non-`auto` profiles a missing file shows up as per-step approval; in `auto` it is silent |
| 6 | Restart Codex / reload the MCP server | New MCP tools are only discovered on reload |
| 7 | Call `claude_code_health` (no arguments, read-only) | `diagnostic = healthy/current`, `reloadRequired = false`, capability list includes `watch` |

**Continuation semantics:** `claude_code_reply <jobId>` resumes the **same** Claude session
(`--resume <sessionId>`), so the long context stays on the worker side rather than being dragged
into your leader context.

**Cost profile:** one extra CLI process tree per job, plus whatever your Claude endpoint charges.

---

#### Quick start Tier 3 · + deepseek-harness

**Requires:** Tier 2 + the published npm package `@deepseek-ai/dsh`. **Time:** ~5 minutes on top.
**Adds:** a second worker backend with its own provider routing and caching behaviour.

```bash
npm i -g @deepseek-ai/dsh
```

Then point the orchestrator at it (only if auto-discovery fails — usually it does not):

```toml
[mcp_servers.claude_orchestrator.env]
DEEPSEEK_HARNESS_ROOT = "<path to the installed @deepseek-ai/dsh directory>"
# DEEPSEEK_HARNESS_RUNNER = "<path to the runner entry point>"   # optional explicit override
```

Dispatch with `workerBackend=deepseek-harness`. Verify availability with `claude_code_health`, whose
capabilities section reports `unavailableReason` (`root_missing` / `runner_missing`) when the probe
cannot find an installation.

> **Capability contract — read before you dispatch.** The local headless harness is a **one-shot,
> final-text** protocol. This backend therefore declares `supportsAttention = false`,
> `supportsLiveEvents = false`, `supportsSessionResume = false`. A `claude_code_reply` to it is
> **rejected by default** with the fixed error prefix `fresh_turn_authorization_required`; passing
> `allowFreshTurn=true` runs a **new independent bounded turn** — it is **not** a resume, and the
> reply carries `replyMode=fresh_turn`. Never describe it as "continuation". Full detail:
> [docs/BACKENDS.md](docs/BACKENDS.md).

**Cost profile:** one extra headless process per job; no persistent runtime.

---

### ⚠️ The two traps that cost the most time

> #### ⚠️ Trap 1 — `enabled = false` makes the tools not exist at all
>
> If your `[mcp_servers.claude_orchestrator]` section is disabled, **Codex does not report an
> error**. It behaves as if the server was never configured: `/mcp` shows no `claude_orchestrator`
> entry, and none of the `claude_code_*` tools exist. People then spend an hour debugging the
> scheduler, the build, and Node — when the actual one-line fix is:
>
> ```toml
> [mcp_servers.claude_orchestrator]
> enabled = true        # ← this line. Nothing on the server side can compensate for it.
> ```
>
> Common way to get bitten: a previous experiment left the section behind with
> `enabled = false`; you append a *second* section; TOML keeps the last one but your editor shows
> the first. **Delete the old section instead of stacking a new one.**

> #### ⚠️ Trap 2 — `tool_timeout_sec` must be ≥ 14400, or `watch` gets guillotined
>
> `claude_code_watch` is designed to stay suspended for up to **4 hours (14400 s)** in a single MCP
> call. That is the whole reason the job model is cheap. If your host's tool timeout is smaller, the
> host kills the call mid-flight and a perfectly healthy long job looks like a mysterious failure.
>
> ```toml
> [mcp_servers.claude_orchestrator]
> startup_timeout_sec = 120
> tool_timeout_sec = 14400      # ← must be ≥ 14400 (4 h); smaller values truncate long waits
> ```
>
> Note the asymmetry: `claude_code_wait` self-caps at 240 s (a deliberate single-call boundary), so
> **`watch` is the only tool that needs the large host timeout**.

---

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 20** | Declared in `package.json` `engines`. Node 20/22/24 are all fine. |
| **Codex CLI** | You install it yourself and accept its own terms. This repository does not bundle or ship it. |
| **Claude Code CLI** (Tier 2+) | The `claude` command must be on `PATH`, or set `CLAUDE_CLI_NAME` to its absolute path. Install it yourself. |
| **`@deepseek-ai/dsh`** (Tier 3) | Optional. Published separately on npm. |
| **An IP/legal check** | `@anthropic-ai/claude-code` is **proprietary software**. This repository does **not** distribute it, does not download it, and does not reimplement it — it only launches the binary you already installed. Review Anthropic's own terms before using it programmatically. |

The orchestrator never reads, stores, or logs your credentials. When it injects an endpoint it
injects only what you configure; when you configure nothing, it injects nothing.

---

### Configuration reference

All configuration is via environment variables in the MCP server's `env` block. Defaults are taken
directly from `src/config.ts`.

#### Endpoint, credentials, models — the authentication contract

| Variable | Default | Effect |
|---|---|---|
| `ORCHESTRATOR_ANTHROPIC_BASE_URL` | *(unset)* | **Unset = inject no endpoint at all.** Workers inherit whatever the Claude CLI is already configured with (official login, your own key, a wrapper, ...). Set to `local` (or `auto`) → inject `http://127.0.0.1:<port>` plus the fixed placeholder token the scheduler uses for local-proxy mode, i.e. use a **local proxy on this machine**. Set to an absolute URL → inject that endpoint. |
| `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN` | *(unset)* | Only used together with an absolute `ORCHESTRATOR_ANTHROPIC_BASE_URL`. Unset = the token key is **omitted entirely** (an empty string would override the CLI's own default — do not write `""`). Ignored in `local` mode, which uses the fixed placeholder token. |
| `ORCHESTRATOR_MODEL_HAIKU` / `ORCHESTRATOR_MODEL_SONNET` / `ORCHESTRATOR_MODEL_OPUS` | *(unset)* | Visible model id injected as `ANTHROPIC_DEFAULT_<KIND>_MODEL`. Unset = not injected, so the CLI keeps its own model defaults instead of being forced onto ids that may not exist for you. |
| `ORCHESTRATOR_MODEL_HAIKU_NAME` / `..._SONNET_NAME` / `..._OPUS_NAME` | *(unset)* | Optional provider-side alias injected as `ANTHROPIC_DEFAULT_<KIND>_MODEL_NAME`. |

> **The zero-config path is the intended one.** An empty `ORCHESTRATOR_ANTHROPIC_BASE_URL` means the
> scheduler injects *nothing* about endpoints or models: workers run on your existing Claude CLI
> login. Only set these variables if you deliberately route workers through a local proxy or a
> custom Anthropic-compatible endpoint.

#### Worker permissions and files

| Variable | Default | Effect |
|---|---|---|
| `ORCHESTRATOR_WHITELIST_PATH` | `<HOME>/.claude/worker-whitelist.json` | Path to the worker permission whitelist. The file's `permissions.allow` is used as written (never widened); its `permissions.deny` is **union-ed** with the built-in default deny list, which is a floor that configuration cannot lower. If the file is missing or malformed, the scheduler falls back to the built-in policy — a conservative allow list plus the full built-in deny list (`deny` is never empty) — and reports what it substituted or added through `warnings[]` on `claude_code_start` / `claude_code_reply`, the job's `runtime/logs/<jobId>.stderr.log`, and `claude_code_health` notes. A file that is merely *narrower* than the baseline (e.g. the shipped template) gets closed up by the union and is reported as `worker whitelist incomplete … Nothing is broken`, which is informational. Details: [docs/TROUBLESHOOTING.md §4](docs/TROUBLESHOOTING.md). |
| `ORCHESTRATOR_READ_GUARD_HOOK` | `<HOME>/.claude/cache-sentinel/read-guard.cjs` if that file exists | Optional `PostToolUse` hook on `Read`, used to warn when a worker pulls in a huge file. Set to `off` / `0` / `false` to disable explicitly. A path that does not exist is silently not injected — a fresh install never produces a failing hook. |
| `CLAUDE_CLI_NAME` | `claude` | The Claude CLI binary to spawn. Set an absolute path if `claude` is not on `PATH`. |
| `CLAUDE_CLI_PREFIX` | *(unset)* | An executable inserted *before* the claude command (e.g. a `node` wrapper). Treated as a single token, so a path with spaces is fine. Used by the test suite to run the fake CLI. |
| `ORCHESTRATOR_HERMETIC_MCP` | `config/hermetic-mcp.json` if present | Worker-side MCP config. Combined with `--strict-mcp-config` it gives each worker an empty MCP surface, so a worker cannot recursively invoke the orchestrator. |

#### Runtime, recovery, retention

| Variable | Default | Effect |
|---|---|---|
| `ORCHESTRATOR_RUNTIME` | `<repo>/runtime` | Runtime root (`jobs/`, `logs/`, `settings/`, `reports/`, `claims/`, `registry/`). Point it elsewhere to isolate sessions or tests. |
| `ORCHESTRATOR_HOST_PID` | *(unset)* | Host session key. When set, instance-registry records are scoped so multiple sessions of one host are not mistaken for duplicate instances. |
| `ORCHESTRATOR_REGISTRY_HEARTBEAT_MS` | `10000` | Instance heartbeat interval (minimum 250). |
| `ORCHESTRATOR_REGISTRY_STALE_AFTER_MS` | `30000` | Stale threshold for registry records (minimum 250). |
| `ORCHESTRATOR_BOOTSTRAP_GRACE_MS` | `15000` | How long a `queued` job that never spawned a supervisor may sit before recovery treats it as never-started and safely re-attempts. |
| `ORCHESTRATOR_RECOVERY_CLAIM_LEASE_MS` | `60000` | Lease for the short-lived single-recoverer claim. |
| `ORCHESTRATOR_ATTENTION_CONFIRM_MS` | `5000` | Confirmation window before a transient permission signal is promoted to `needs_attention`. |
| `ORCHESTRATOR_START_JITTER_MAX_MS` | *(internal default)* | Upper bound for randomised start jitter; `0` disables. |
| `ORCHESTRATOR_RETENTION_V2` | off | Enables the read-only retention dry-run (`claude_code_retention_preview`) and the job index. Off = the preview does no runtime scan at all and the legacy file layout is preserved exactly. |
| `ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES` | `2097152` (2 MiB) | Claude resume threshold. Above it, a reply is refused with `new_start_required` unless `allowLargeResume=true`. |
| `ORCHESTRATOR_REPLY_PREFLIGHT` | off | Feature flag gating the Claude transcript-size preflight. The harness `fresh_turn_authorization_required` gate is **unconditional** and does not depend on any flag. |

#### Admission control and v2 contract (advanced, all off by default)

| Variable | Default | Effect |
|---|---|---|
| `ORCHESTRATOR_ADMISSION_CONTROL` | off | Enables structured admission control for concurrency. |
| `ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY` | `4` | Default leader-level worker concurrency target (1–64). |
| `ORCHESTRATOR_ADMISSION_HARD_CEILING` | `8` | Hard safety ceiling on concurrent workers (1–64). |
| `ORCHESTRATOR_ADMISSION_MAX_HEAVY_WORKERS` | `2` | Max concurrent `resourceClass=heavy` workers (1–64). |
| `ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB` | `2048` | Free-memory floor below which new heavy jobs queue. |
| `ORCHESTRATOR_METRICS_V2` | off | Enables compact per-job metrics in public views. |
| `ORCHESTRATOR_CONTRACT_V2` | off | Enables the strictly-validated v2 task contract. |
| `ORCHESTRATOR_BUDGET_ENFORCEMENT` | off | Enforces v2 contract budgets through a `PreToolUse` hook. |

#### Live view

| Variable | Default | Effect |
|---|---|---|
| `OPEN_LIVE_VIEW` | off | `1` pops up a separate, visible console window that tails the job's output live. Off by default so nothing flashes on Windows. |
| `ORCHESTRATOR_VIEWER_TERMINAL_POLICY` | `persist_static` | `close` prints the final state and exits; `persist_static` freezes a static terminal page and waits for a new job in the same session. Anything unset/empty/invalid → `persist_static`. |

#### deepseek-harness backend

| Variable | Default | Effect |
|---|---|---|
| `DEEPSEEK_HARNESS_ROOT` | *(auto-probe)* | Explicit install root; otherwise the usual global-npm locations of `@deepseek-ai/dsh` are probed. |
| `DEEPSEEK_HARNESS_RUNNER` | *(auto-probe)* | Explicit runner entry point; authoritative when the path exists on disk. |
| `DEEPSEEK_HARNESS_BRIDGE_PATCH` | *(unset)* | **Explicit opt-in.** A non-empty value is the only thing that makes the bridge patch get passed. Simply having a bridge file on disk is *not* enough. |
| `DEEPSEEK_HARNESS_DISABLE_BRIDGE` | *(unset)* | `1` always wins: the bridge is fully disabled and the harness runs independently. |
| `ORCHESTRATOR_DEFAULT_WORKER_BACKEND` | `claude` | Default `workerBackend` for `claude_code_start` when the argument is omitted. |

---

### Tool contract

Nine tools are registered. All return JSON text; all are compact by construction and never return
prompts, tokens, full logs, diffs, or environment values.

| Tool | Input | Returns |
|---|---|---|
| `claude_code_start` | `prompt`, `workFolder` (absolute), `profile` (auto default / review / normal), `workerBackend` (claude default / deepseek-harness), `internalAgentParallelism` (auto/1–4; legacy alias `parallelism`), `desiredWorkerConcurrency` (1–64, optional), `maxRuntimeMinutes` (30–180, default 120), `taskType` (execution/research/analysis, default execution), `deliverablePath` (absolute `.md`, required for research/analysis), optional v2 `contract` | Within 10 s: `jobId` + `sessionId` + resolved routing, and warnings. Launches a detached background job. |
| `claude_code_status` | `jobId`, `progressLines` (1–20, default 3), `raw?` | `queued \| running \| needs_attention \| succeeded \| failed \| cancelled`, elapsed time, last activity, `idleSeconds` (seconds since the worker's last **real** output — the signal for stall detection), a short **rendered** readable tail (assistant text / tool calls / results / terminal banner; `raw:true` returns the raw log tail instead), the report path. research/analysis also carry `taskType` / `deliverablePath` / `deliverableHash` / `missingDeliverable`. Never the full log or the stored prompt. On `needs_attention` it carries the structured, sanitised `attentionDetail`. |
| `claude_code_wait` | `jobId`, `waitSeconds` (default 240, max 240) | **Fallback only.** Long-polls until terminal/`needs_attention` or expiry. One call never exceeds the 300 s caller boundary. |
| `claude_code_watch` | `jobId`, `timeoutSeconds?` (default and max 14400) | **The default way to wait.** Event-driven: stays suspended until `succeeded/failed/cancelled/needs_attention`, or a watch-level outcome (timeout / client abort / not-found / internal error). It **never** returns `running` while the job runs, so it costs zero model turns. Abort/disconnect clears only the watcher — it does **not** cancel the job or change its state; re-attach later with another `watch` on the same `jobId`. Carries `attentionDetail` directly on wake. |
| `claude_code_reply` | `jobId`, `prompt` (narrow instruction), `allowLargeResume?`, `allowFreshTurn?` | Claude backend: resumes the saved session (same `sessionId`, `--resume`), refused with `new_start_required` when the transcript exceeds the threshold unless `allowLargeResume=true`. Harness backend: **refused by default** with `fresh_turn_authorization_required`; `allowFreshTurn=true` runs a new independent bounded turn (`replyMode=fresh_turn`) that never touches the parent session and never claims continuity. Rejected while the referenced job is still running — the reply always produces a **new** job. |
| `claude_code_cancel` | `jobId`, `reason?` | Terminates **only** the target job's process tree; records `cancelled` with the reason; leaves logs and report auditable. Other jobs untouched. |
| `claude_code_list` | `limit?` (1–50, default 20) | Compact metadata for recent jobs, newest first — the recovery surface after an MCP/host restart. Never prompts, tokens, or full logs. |
| `claude_code_health` | *(no arguments)* | Read-only health: `version`, `loaded` vs `disk` build fingerprint, instance identity (`pid` / `startedAt` / `uptimeSec` / entry basename), the capabilities **actually registered by this process** (including `watch`, structured attention, response audit, worker backends), job counts, `reloadRequired`, `diagnostic`, instance registry (duplicate instance / stale records) and a structured `diagnostics[]`. Never prompts, tokens, raw logs, env values, keys, or the full command line. |
| `claude_code_retention_preview` | `limit?` (1–500), `cursor?`, `includeKeep?`, TTL overrides in days | Read-only retention **dry run**. Makes zero filesystem changes. With `ORCHESTRATOR_RETENTION_V2` off it does not scan the runtime at all and returns `{ enabled: false, dryRun: true, items: [], ... }` with all-zero totals. There is deliberately **no apply/delete tool**. |

#### Job lifecycle states

```
queued ──► running ──┬──► succeeded          (terminal)
                     ├──► failed             (terminal; see substatus / failureDetail)
                     ├──► cancelled          (terminal)
                     └──► needs_attention ──┬──► (reply) running ──► ...
                                            └──► (cancel / maxRuntime) ──► cancelled
```

Terminal states are **monotonic**: `updateJobIf` guards every transition, so a terminal state is
never rolled back and a concurrent cancel never loses to a late writer.

#### `taskType` and the Markdown deliverable contract

`taskType` is optional and defaults to `execution`, which behaves exactly as before:

- **`execution`** (default) — an implementation task. Supplying `deliverablePath` here is
  **rejected**, so the contract stays unambiguous.
- **`research` / `analysis`** — the single primary artifact is one Markdown report, which must be
  written to the **absolute `deliverablePath` you supply** (inside `workFolder`, ending in `.md`,
  not equal to `workFolder`; the scheduler never guesses a path). `buildPrompt` injects the
  deliverable contract into the worker prompt, requiring sections: goal & scope / evidence & method
  / findings (facts) / open questions & risks. The scheduler never rewrites or synthesises the
  report.
- **Deliverable verification, before the terminal state is published** — the supervisor checks the
  artifact (regular file, non-empty, SHA-256-hashable). Valid → `deliverableHash` +
  `missingDeliverable=false`. Missing / not a file / empty / unhashable → `missingDeliverable=true`,
  and if the worker would have `succeeded`, the state **flips to `failed`** with a sanitised
  `substatus` (e.g. `deliverable_missing`). A missing report is never silently accepted.
- **`reply` inherits both** the `taskType` and the same `deliverablePath`, so a follow-up continues
  the same artifact rather than resetting it; the hash is recomputed at the reply's terminal state.

#### What `needs_attention` actually contains

`claude_code_watch` and `claude_code_status` both carry `attentionDetail` so the leader knows *what*
needs approval without a second call:

```jsonc
{
  "requestId": "fake-prompt-1",        // upstream id, or a locally generated `local-<uuid>`
  "requestIdSource": "upstream",        // upstream | local
  "tool": "Bash",                       // whitelisted tool name, else "unknown"
  "action": "delete",                   // whitelisted action, else "unknown"
  "path": "probe.txt",                  // workFolder-relative; outside it, basename only
  "risk": "high",                       // low | medium | high | unknown (conservative)
  "at": "2026-08-12T00:00:00.000Z",     // when it was recorded
  "message": "Approval required: Bash delete probe.txt"
}
```

Safety boundaries — this is **observability only**; it does not change any approval decision:

- It **never** contains the full prompt, raw log, token, diff, key, cookie, or env value.
- `tool` / `action` come from a whitelist; anything unparseable becomes `unknown` with a generic
  message — it never falls back to echoing the raw payload.
- `path` is minimised: relative inside the work folder, basename-only outside it. Home-directory
  paths are never exposed.
- `risk` is only a conservative classification and never downgrades the upstream risk.
- `requestId` is stable, credential-free and length-bounded, and is identical across `watch`,
  `status`, and restarts.
- The record lives in the job JSON's `attentionLog[]` (read-only observation, most recent 5 entries).
  It does **not** alter the state machine, and **no** auto-approval, authorisation inheritance, or
  deduplicated auto-reply exists. A locally generated `requestId` is **not** an authorisation
  credential, and replying never authorises an action: reply audit entries always carry
  `authorization: false`.

**Transient-signal handling.** An `auto`-profile worker may emit a momentary permission/control
signal and then proceed by itself. The supervisor therefore applies a confirmation window
(default 5 s, `ORCHESTRATOR_ATTENTION_CONFIRM_MS`); only if no further stdout arrives is the job
promoted to `needs_attention`. If output continues, the candidate is cancelled and the job stays
`running`. `needs_attention` is driven **only** by structured control/permission events
(`userPrompt` / `control_request` / `permission_request`) — ordinary text banners, stderr noise and
slow tools do not produce it.

#### `status` vs `watch` vs `wait`

| | `watch` (default) | `wait` (fallback) | `status` (manual) |
|---|---|---|---|
| Mechanism | event-driven, cross-process broker | long poll | instant read |
| Max duration | 14400 s | 240 s | — |
| Returns `running`? | never | possible on expiry | yes |
| Model turns while running | **zero** | one per call | one per call |
| Disconnect behaviour | clears the watcher only | — | — |
| Use for | normal waiting | recovery, debugging, hosts that break long calls | spot checks, `idleSeconds`, audit |

### Profiles and permission routing

Routing is keyed on the **profile**, never on a model name. All three profiles reach a single
endpoint; the difference is the CLI permission mode:

| profile | permission mode | Intended use |
|---|---|---|
| `auto` (**default for implementation**) | `bypassPermissions` | Normal implementation / modification / testing. **No sandbox.** No per-call approval prompt, and **no model-backed permission classifier at all** — file edits, Bash and tool calls all proceed, with the worker running as your OS user. `deny` is the only rule type that blocks anything, and it is **never empty**: the built-in default deny list is a floor (bulk deletes, `git push`, `npm publish`, network egress, credential stores, system-directory writes), and your whitelist's `deny` rules are **union-ed** with it — your file can tighten the policy, never lower it. Matching is literal prefix matching, so a differently spelled command, a script, or an `npx`-mediated call is not caught — blast-radius reduction, not an enforced boundary. |
| `review` | `plan` | Read-only analysis, audits, risk review. With `taskType=research\|analysis` + `deliverablePath` the scheduler automatically switches to a derived mode that permits writing **only that one report file**; every other write still escalates. Pure read tools are allowed. |
| `normal` | `acceptEdits` | Manual control / failure fallback only — no longer the default. |

**Why the classifier was removed.** An earlier design inserted a model classifier before every tool
call. In practice it issued one extra model request per call, timed out repeatedly through shared
routes, blocked already-approved work, and burned quota — the safety mechanism became the throughput
bottleneck. The trade-off taken instead: **deterministic over probabilistic.** The `auto` profile
runs fully approved, and the only policy layer is the per-job, scheduler-injected `deny` list
(string matching — it cannot time out, cannot misclassify, and costs nothing). Be precise about what
that buys you: `deny` is a **partially bypassable prefix blacklist**, not a sandbox — a differently
spelled command, a script, or an `npx`-mediated call gets through — and the built-in baseline is
union-ed with whatever your file adds, so a config file can tighten the policy but can never lower it
(see [Security boundaries](#security-boundaries-read-this-before-your-first-job)). Permission
injection is **per job**, so an external tool rewriting your global settings cannot erase it.

> Persistently retrying a write inside a read-only session is a bug indicator, not a strategy. If a
> worker keeps hitting `needs_attention` on "write the report", **cancel and re-dispatch** rather
> than replying N times.

Each job gets its own `runtime/settings/<jobId>.settings.json`, injected via `--settings`. This is
what makes routing real: a `--settings` env block was measured to override the CLI's own
`~/.claude/settings.json` env block, while a process environment variable does **not**. Worker
launch shape:

```
claude -p --session-id <uuid> --permission-mode <mode> --effort <level> \
  --output-format stream-json --verbose --autocompact=128000 \
  --settings <per-job settings> --add-dir=<workFolder> \
  [--disallowedTools=Edit,Write,NotebookEdit] \
  [--mcp-config <hermetic> --strict-mcp-config] \
  [--allowedTools=<rule> ...] <wrapped prompt>
```

- `--resume <sessionId>` replaces `--session-id` for a Claude reply (a real session continuation);
  a harness reply uses a **new** `--session-id` because it never resumes.
- `effort` is derived per job: `analysis` → `max`, everything else → `high`. Effort is fixed in the
  per-job settings rather than retuned per task.
- `review` adds `--disallowedTools=Edit,Write,NotebookEdit`.
- The hermetic MCP config is optional: when `config/hermetic-mcp.json` is absent, no `--mcp-config`
  is injected and the worker keeps its own MCP configuration.
- `--allowedTools=<rule>` is passed for each whitelist rule as a second layer of defence, so a
  damaged job settings file still cannot drop the worker into per-call approval.
- `--autocompact=128000` keeps long-running workers compacting at the same threshold as the
  interactive window, instead of pinning a >128k context where every turn is a full cache miss.
- Note the `=` form on `--add-dir`, `--disallowedTools` and `--allowedTools`: the space-separated
  form greedily consumes the trailing prompt positional.

The harness backend does not launch `claude` at all — the supervisor runs
`node dist/deepseek-worker.js --job <jobId>`, and that adapter invokes the local headless runner.

### How waiting works internally

- The supervisor and the MCP server are **different processes**. The watch state source is a shared
  `JobEventBroker` (`src/job-events.ts`) that watches the **jobs directory** rather than a single
  file handle — necessary because job files are replaced by atomic rename.
- Both `<jobId>.json` and `<jobId>.done.json` are observed; `needs_attention` can be written before
  the done marker.
- Subscription uses a double-check ("read state → register → read state again") to close the
  check/subscribe race.
- `fs.watch` is the primary event source, with a 15 s internal fallback that runs **only** while
  subscriptions exist and only inspects subscribed jobs. The fallback never surfaces `running`.
- Multiple watchers share one directory watcher, dispatched by `jobId`; every resolve/error/timeout/
  abort exit path cleans up listeners, timers and handles idempotently; the directory watcher closes
  when the last subscriber leaves.
- The MCP SDK callback's `extra.signal` only tears down the **current watcher**. Client abort or
  disconnect does **not** cancel the job, kill the worker, or change job state.
- `watch` never reads `runtime/logs/*.log` and never returns raw stream-json.

### Self-verification (no model spend)

The test suite runs against `test/fake-claude.mjs`, a scripted fixture that plays the Claude CLI's
stream-json protocol. **You can verify the entire chain — spawn, parse, attention, deliverable
verification, recovery, watch — without a real model and without spending any quota.**

```bash
npm test                          # build + full node:test suite using the fake CLI
npm run test:unit                 # unit tier only
npm run test:integration:serial   # serial integration tier
npm run test:windows              # Windows process-identity tier
npm run test:gate                 # unit → integration → windows → smoke gate, in order
npm run test:smoke:gate           # offline smoke gate
npm run test:smoke:offline-all    # offline smoke, extended set
npm run test:smoke:all            # includes the live category (see below)
```

The `live` smoke category runs **only** when `ORCHESTRATOR_ALLOW_LIVE_SMOKE=1`; otherwise it skips
with a reason fixed in source. `CLAUDE_CLI_NAME` / `CLAUDE_CLI_PREFIX` select the claude command or
a test double.

A failing tier prints a bounded `[layer] FAILURE_DIAGNOSTICS_BEGIN/END` block (default max 16000
characters); passing tiers print nothing extra.

### Job persistence, recovery and rollback

- One JSON per job: `runtime/jobs/<jobId>.json`, written atomically (temp file, then rename).
- The **full prompt** is persisted locally in that job JSON only. No tool ever returns it. To delete
  job history, clear `runtime/jobs/` and `runtime/logs/`.
- On MCP startup, `recoverJobs()` reconstructs state from job files + `.done` markers + PID
  liveness: a done marker wins; a still-live process stays `running` (marked `timeout` only if it
  actually exceeded its cap); otherwise the job becomes `failed` (`interrupted`) — and the session
  is still resumable via `reply`.
- **CAS state locks.** `claims/<jobId>.state.json` (O_EXCL + owner identity + lease) is the only
  write entry point, so concurrent writers serialise in the filesystem and never
  read-modify-write across processes. A verified-live lock is never stolen; verified-dead or
  identity-mismatched locks are atomically renamed away. Corrupt or partial writes recover after an
  mtime grace period with a single winner.
- **Single-writer claims.** Supervisor and recovery each take an O_EXCL claim; only the claim winner
  may acknowledge, spawn, or recover. Two supervisors or two recoverers can never own one job.
- **PID-reuse protection.** Each PID is stored with its OS creation time
  (`supervisorPidStartedAt` / `pidStartedAt`). A PID with no identity, or a mismatched identity, is
  **never** killed or attached to.
- **Strict validation at the trust boundary.** `isValidJobRecord` freezes the public contract; later
  optional fields follow "missing is fine, wrong is rejected". `.done` markers go through
  `parseDoneMarker` (jobId match, terminal states or `needs_attention` only — `queued`/`running` are
  refused). An invalid marker is treated as absent and never advances or rolls back a job.

**Rollback in one minute:**

1. Delete the `[mcp_servers.claude_orchestrator]` section from `<CODEX_HOME>/config.toml`
   (keep your own backup).
2. Restore your global instruction file (`AGENTS.md` or equivalent) from your own backup.
3. Optionally delete `runtime/` to wipe job history.

> `runtime/` can contain local copies of prompts. Check before deleting if you might want them.

### Health, reload and instance diagnostics

`claude_code_health` answers: *is the build this process loaded stale? are all capabilities
present? am I duplicated? is there crash residue? do I need a reload?* It is strictly read-only — it
never kills, restarts, repairs, or cleans anything, and writes no runtime state (beyond its own
heartbeat).

- **Build fingerprint.** `loaded.buildFingerprint` is a deterministic root hash over the **entire
  production `dist` module set** captured at process start; `disk.buildFingerprint` is recomputed on
  every call. Adding, deleting or modifying **any** dependency module — even when `index.js` is
  byte-identical — changes the fingerprint and sets `reloadRequired=true` with
  `diagnostic=reload_required`. (The older entry-only `buildHash` fields are kept as informational
  compatibility, and are no longer the basis of the decision.)
- **Conservative on doubt.** If any module is unreadable or either fingerprint is empty:
  `diagnostic=hash_unavailable`, `reloadRequired=true`. If health cannot be proven, it is not
  reported as healthy.
- **Proven capabilities.** `capabilities.tools` comes from the tools **this process actually
  registered**, not from reading source on disk. `structuredAttentionDetail` (watch + status
  registered) and `responseAudit` (reply registered) prove the running process really exposes them.
- **Instance registry.** Every MCP process writes a record that belongs **only to itself** under
  `runtime/registry/instances/<instanceId>.json` — `instanceId`, `pid`, `processStartedAt`,
  `serverStartedAt`, entry basename, `buildFingerprint`, `lastHeartbeatAt`, `version`. Concurrent
  processes never overwrite each other. Records never contain env, prompts, tokens, raw logs, full
  command lines, or keys. The heartbeat is `unref`'d and never holds the process open; a normal exit
  unregisters best-effort, and crash residue is caught by stale/identity detection.
- **Real duplicate and stale diagnostics.** `duplicate_instance_suspected` requires **at least two
  identity-verified live instances** spanning different host PIDs — crash residue and dead PIDs never
  count. `registry_stale` covers heartbeat timeout, missing PID, PID-identity mismatch, or an
  unreadable record, with sanitised `staleReasons` counts. Both can coexist with build
  `reload_required` / `hash_unavailable`, surfaced through the booleans and the structured
  `diagnostics[]` array so nothing is lost.
- **Never auto-cleans.** Manual runbook: once you have confirmed a duplicate or residue is genuinely
  removable, stop the surplus MCP process; a stale record may be deleted manually from
  `runtime/registry/instances/` **after** confirming its PID is gone or its identity mismatches.
- **Reload runbook.** After `npm run build`, reload or restart the `claude_orchestrator` MCP server
  (or restart Codex) so the on-disk build is loaded. Then re-run `tools/list` and
  `claude_code_health` and verify `loaded.buildFingerprint == disk.buildFingerprint`,
  `reloadRequired=false`, `diagnostic=healthy/current`.

### Live view (optional, human-facing)

Off by default — `claude_code_start` does **not** pop a window on Windows unless you set
`OPEN_LIVE_VIEW=1`. When enabled, it opens a separate visible console running `dist/viewer.js`,
which polls the job's stdout+stderr logs by byte offset (~500 ms; an append-only tail is more
reliable than `fs.watch` here) and renders assistant text, tool calls, results, permission requests
and meta banners. A reply that continues the same session follows into the same window.

Open one manually for any job at any time (independent of `OPEN_LIVE_VIEW`):

```bash
node dist/viewer.js <jobId>
```

### Repository layout

```
src/
  index.ts        MCP entry: registers the nine tools, startup recovery, health fingerprint, registry lifecycle
  scheduler.ts    start/status/wait/watch/reply/cancel/list + recovery + deliverable view fields
  job-events.ts   shared cross-process JobEventBroker (directory fs.watch + internal fallback)
  supervisor.ts   detached job executor (claim, ack-before-spawn, attention window, deliverable check, done marker)
  parser.ts       shared incremental line-buffered stream parser (chunk splitting, event classification, attention sanitisation)
  render.ts       shared readable rendering (status tail + viewer)
  health.ts       read-only health/version/reload/instance diagnostics
  registry.ts     instance registry + heartbeat + process identity / PID reuse + stale/duplicate snapshot
  recovery.ts     three-phase bootstrap checkpoint/claim + single-recoverer recovery
  viewer.ts       live console window (byte-offset polling tail, follows the session chain)
  router.ts       profile → port/permission truth table + taskType/deliverablePath validation
  backend-policy.ts  worker backend capability matrix + reply preflight (pure, no side effects)
  worker-adapter.ts  backend selection + read-only harness probe
  leader.ts       optional delegation prompt wrapper (never rewrites your requirements)
  job-store.ts    atomic job persistence, public views (no prompt), CAS state locks, strict validation
  proc.ts         isAlive / killTree / PID identity / Windows window visibility
  config.ts       paths and constants
config/           hermetic-mcp.json — empty MCP config used with --strict-mcp-config
templates/        AGENTS.strict-delegation.md — ready-to-paste global rule template
tools/            init.mjs — environment probe + config generator (read-only w.r.t. your files)
test/             node:test unit + integration suites, fake CLI fixtures (zero real model calls)
smoke/            offline and live smoke scripts
runtime/          jobs / logs / settings / reports / claims / registry (generated at runtime)
```

### Documentation

| Document | What it is for |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Step-by-step installation for all three tiers, with expected output and recovery steps |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | *Why* the three-tier discipline is designed this way, and when it is a net loss |
| [docs/BACKENDS.md](docs/BACKENDS.md) | Worker backend details, capability matrix, and the routing decision tree |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix, including the traps above |
| [templates/AGENTS.strict-delegation.md](templates/AGENTS.strict-delegation.md) | Paste-into-your-global-instructions rule template |

### License

MIT. See [LICENSE](./LICENSE).

This repository does not distribute `@anthropic-ai/claude-code`, `@deepseek-ai/dsh`, or Codex. It
launches the CLIs you installed yourself, under their own licenses and terms.

---
---

## 中文

### 安全边界速览（派第一个任务之前请先读这节）

这个工具会**在你的机器上、以你的身份、无人值守地**运行 AI 编码 agent。没有容器，没有虚拟机，
也没有降权：worker 继承你的用户账号、你的文件系统权限和你的网络出口，而且你关掉编辑器之后它
照旧在跑。

**默认档 `auto` 没有沙箱。** 它用 `--permission-mode bypassPermissions` 启动 worker——这一档
的设计目标就是**不产生任何审批提示**（异步任务本来就没人盯着终端）。实际能约束 worker 的只有
三样东西：

1. **`allow` / `deny` 清单。** `deny` 优先于 `allow`，而且是这一档里**唯一真正能拦住调用**的规则
   类型。它是**命令/路径前缀**的字面匹配：经 `npx` 间接调用、写进脚本再执行、换个写法都能绕过去。
   `deny` **永不为空**，而且内置默认拒绝清单（`src/config.ts` 的 `DEFAULT_WORKER_DENY`：批量删除、
   format/shutdown、`git push`、`npm publish`、`curl`/`wget`/`ssh`/`scp` 出口、`~/.ssh` `~/.aws`
   等凭据位置、系统目录写入）是一道**地板，不是你可以覆盖的默认值**：真正生效的是**内置基线 ∪
   你文件里的规则**。改配置只能**收紧**策略，**不可能放松它**。所以随仓库发的
   `templates/worker-whitelist.json` 是**起点，不是策略的全部**——拷过去拿到的是它的规则**加上**
   基线的其余部分。当你文件里的规则少于基线时，调度器会把缺的那些并进来，并在 `warnings[]` 里
   说明；那条提示是**告知**（文字以 `worker whitelist incomplete … Nothing is broken` 开头），
   不是故障。
2. **`workFolder`**，即任务的工作目录。它的校验只有"是一个存在且为目录的绝对路径"这一条，
   **没有根目录白名单**：调用方要求的话，它可以指向你的用户主目录或盘根。
3. **你给 worker 的 prompt 约束**——那是给模型的建议，不是被强制执行的规则。

由此推出一条值得记住的运行纪律：**不要把不可信内容喂给会派单的主会话。** 一个能派任务的
主会话，它的指令来源就是它刚刚读过的东西。把陌生人给的仓库、没审过的 issue、来路不明的网页
粘进主会话，等价于让那个陌生人在你机器上执行命令。deny 清单能**缩小爆炸半径**，但消不掉风险：
一次提示注入仍然可以改 `workFolder` 里的文件、跑放行的构建与测试工具、以及触达那些被放行的
命令所能触达的地方。

几条实际建议：

- 给 worker 用**专用的工作目录**，不要用主目录，也不要用"旁边放着丢不起的东西"的目录。
- **不要把含凭据的目录设为 `workFolder`**（SSH 私钥、云 CLI 配置、`.env`、各类 token 存放处）。
- **装上白名单，并且每次 start/reply 的响应里都看一眼 `warnings[]`**：`unusable` 说明你的文件根本
  没被读上（生效的是内置策略）；`incomplete … Nothing is broken` 说明基线已并到你的规则之上。
  两种情况都会写进 `runtime/logs/<jobId>.stderr.log`，并在 `claude_code_health` 的 notes 里提示。
- **定期看 job 日志**——那是"worker 到底做了什么"的唯一记录。
- 把 `deny` 当成缩小爆炸半径的手段：值得认真组，但它**不是**沙箱。

> 建议把它跑在一台"就算给了完整 shell 权限你也能接受"的机器或虚拟机里。

### 这是什么

`codex-job-orchestrator` 是一个**本地异步 MCP 调度器**。Codex 主会话当**领导**，把长任务派给
**worker**；`claude_code_start` 在 10 秒内返回 `jobId`，任务在独立进程里跑 30–180 分钟，等待走
**事件驱动**的 `claude_code_watch`——一次 MCP 调用挂起，直到任务真的进入终态或需要审批才返回。
任务运行期间，这次调用消耗 **0 个模型回合**。

### 它解决什么问题

对话式 Agent 循环和长任务本来就合不来，MCP 把这个矛盾放大：

| 约束 | 没有 job 模型的后果 |
|---|---|
| MCP 工具调用是**同步请求/响应** | 宿主会在超时后掐断；30 分钟的任务根本没法做成一次工具调用 |
| 主会话的上下文是你手上**最贵**的上下文 | 把 90 分钟的构建日志流进去，等于把它永久钉进之后每一轮 |
| 等待必须**事件驱动，而不是轮询驱动** | 每次轮询都是一次模型回合；轮询花掉额度却买不到信息 |
| 长任务必须能扛**断线** | 关客户端、重启宿主、传输断了，任务都不该丢 |
| 工作必须**可查询、可续跑** | 你需要能问："它在干什么""它卡住了吗""能不能接着做" |

job 模型对五条各给一个答案：**detached supervisor 进程**持有执行权，磁盘上的**job JSON** 是唯一
事实来源，**跨进程事件 broker** 负责唤醒等待者，MCP 层只返回紧凑摘要。

### 三层架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 1 · 领导 —— 你的 Codex 主会话                                            │
│                                                                              │
│   方案、架构、trade-off、优先级、验收标准。最终验收与拍板权归它。              │
│   "想清楚"这件事永不外包。                                                    │
│                                                                              │
│   可用工具：claude_code_start / status / wait / watch / reply / cancel /      │
│              list / health / retention_preview                                │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  派单（≤10s，返回 jobId）
                │  等待（事件驱动，运行中 0 回合）
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 2 · 员工 —— 三条路径，按 backend 路由，绝不按模型名                       │
│                                                                              │
│  ① claude             Claude Code CLI        workerBackend=claude（默认）     │
│     └─ 由本调度器管理 · 真·会话续做 · 权限 attention · 实时事件流 ·           │
│        完整 job 生命周期（start / watch / reply / cancel）                    │
│                                                                              │
│  ② luna_worker        Codex 原生子代理       agent_type=luna_worker           │
│     └─ 不经本调度器（走 Codex collaboration，不是 MCP）；                     │
│        同任务续做用 followup_task，不是 claude_code_reply                     │
│                                                                              │
│  ③ deepseek-harness   本地 headless runner   workerBackend=deepseek-harness   │
│     └─ 由本调度器管理 · 单次有界任务 · 无 attention · 无实时事件 · 无会话续做  │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │  detached supervisor 进程（MCP / 宿主重启也不中断）
                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ Tier 3 · 持久化与事件（共享层，与 backend 无关）                              │
│                                                                              │
│   runtime/jobs/<jobId>.json    原子写入的 job 记录（唯一事实来源）            │
│   runtime/logs/<jobId>.log     stdout 流 · .stderr.log 人类日志              │
│   runtime/settings/<jobId>.settings.json   每 job 独立的权限 + env 注入       │
│   runtime/claims/              单写者 CAS 锁（双 supervisor 不可能）          │
│   runtime/registry/instances/  每个 MCP 进程一条记录 + 心跳                   │
│   JobEventBroker               对 jobs 目录 fs.watch → 唤醒 watch             │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 定位：默认强制委派

本仓库的主张是**强制委派**：装上它，意味着主会话**默认把实现类工作派给 worker**，自己只做方案、
架构、trade-off、优先级与最终验收。这是设计的目的，不是副作用。

设计动机见 [docs/METHODOLOGY.md](docs/METHODOLOGY.md)；可直接粘贴的规则模板见
[templates/AGENTS.strict-delegation.md](templates/AGENTS.strict-delegation.md)。

**请诚实评估你是否真的需要它。** 强制委派有实打实的代价：每个任务都有交接开销，员工的回执是
**故意压窄**的，链路还更长。它在三个条件同时成立时才划算：① 领导模型的单位 token 成本远高于
worker；② 任务粒度够大，能摊平派单的固定开销；③ 多个异构 backend 提供**真正不同的能力面**。

如果你偏好主模型自己干、只在明确要求时才委派，**直接看
[档 1 · 仅 Luna](#快速开始三档按成本从低到高)**——调度器是可选的；三档的排序就是"承诺从轻到重"。
反向论据（由作者本人写下）见 [docs/METHODOLOGY.md §8–9](docs/METHODOLOGY.md)「与可选委派模式的关系 /
适用范围与争议」。

### 它不做什么

- **不是**托管服务、不是代理、不是模型路由器。全部本地运行。
- **不会**替你安装 `claude`，**不碰**你的凭据，**不读**你的 token（见[前置条件](#前置条件)）。
- **不是** Codex 原生子代理的替代品——档 1 就是原生路径。
- **不逐项征求你的同意，也不给 worker 加沙箱。** 默认 `auto` 档用
  `--permission-mode bypassPermissions` 启动 worker：它是为无人值守场景设计的，所以不会有任何一步
  停下来等人。真正约束 worker 的只有三样——生效的 `deny` 清单、你传给 `claude_code_start` 的
  `workFolder`、以及你给 worker 的 prompt 约束。派第一个任务之前请先读
  [安全边界速览](#安全边界速览派第一个任务之前请先读这节)。

---

### 快速开始（三档，按成本从低到高）

> 每一档单独都有用。从档 1 开始。

#### 档 1 · 仅 Luna（Codex 原生子代理，零外部依赖）——**推荐的新手入口**

**需要：** 只要 Codex CLI。**耗时：** 约 5 分钟。**外部依赖：** 无。**这一档完全不用本调度器。**

这是拿到"领导 + 员工"分工最便宜的方式，因为它用的是 Codex 自己就有的委派机制：你定义一个员工
代理，让 Codex 用它。

**1. 写员工定义** `<CODEX_HOME>/agents/luna_worker.toml`（`<CODEX_HOME>` 通常是 `~/.codex`）：

```toml
name = "luna_worker"
description = "Cost-efficient native Codex worker for clear, bounded, repeatable subtasks."
model = "<你的员工模型>"                # 你有权限访问、且比领导模型便宜的一个
model_reasoning_effort = "high"

developer_instructions = """
你是员工：只执行父代理指定的、有界的实现 / 测试 / 取证任务。保留父会话的沙箱、审批、
工具、MCP 与 Skill 边界。只在被分配的文件所有权范围内写入。
不做架构、产品、trade-off 决策，不排优先级，不定验收标准，不给最终结论——那些属于父代理。
回执格式：status、backend/agent type、变更文件或取证位置、验收逐项、自测结果、剩余风险/未知项。
没有命令证据不得声称成功。
"""
```

**2. 打开 Codex 的 agents 段**，在 `<CODEX_HOME>/config.toml` 里加：

```toml
[agents]
enabled = true
default_subagent_model = "<你的员工模型>"
default_subagent_reasoning_effort = "high"
max_concurrent_threads_per_session = 4   # 别拉太高；每个线程都是真实 OS 进程
```

**3. 重启 Codex，派一个有界任务**，看员工能不能回一份可用的回执。能，你就已经拿到了整套方法论
的核心收益，且什么都没装。

**续做语义：** 同一任务 → 对该子代理用 `followup_task`。**不要**调 `claude_code_reply`——原生子
代理不是本调度器的 backend。

**成本画像：** 零基础设施。只为员工模型的 token 付费。

---

#### 档 2 · + Claude Code worker

**需要：** Codex CLI + `claude` CLI（你自己装，见[前置条件](#前置条件)）+ 本仓库。
**耗时：** 约 15 分钟。**新增能力：** 真·会话续做、attention / 权限事件、实时可见窗口、取消、
job 列表、健康诊断。

| 步骤 | 命令 / 动作 | 预期结果 |
|---|---|---|
| 1 | `git clone <本仓库>`，然后 `npm install` | 依赖装好；不执行任何外部 download 脚本 |
| 2 | `npm run build` | 生成 `dist/index.js`；可能还有 `dist/orchestrator-launcher.cjs` |
| 3 | `node tools/init.mjs` | 只读探测环境，把建议配置写进 `./generated/`。**它不改你任何现有文件。** |
| 4 | 把 `generated/codex-config.snippet.toml` 合并进 `<CODEX_HOME>/config.toml` | 逐步操作见 [docs/SETUP.md](docs/SETUP.md)——先读下面两个 ⚠️ 坑 |
| 5 | 安装 worker 白名单（见[worker 权限与 attention](#worker-权限与-attention)） | 文件缺失时 job 照常跑（用内置策略）；文件比基线窄时差额会被**并集补齐**。两种情况都会在 `warnings[]` 里报告。非 `auto` 档下缺文件表现为每步卡审批，`auto` 档则完全静默 |
| 6 | 重启 Codex / 重载 MCP server | 新增的 MCP 工具只有重载后才被发现 |
| 7 | 调用 `claude_code_health`（无参数，只读） | `diagnostic = healthy/current`、`reloadRequired = false`，能力列表里有 `watch` |

**续做语义：** `claude_code_reply <jobId>` **恢复同一个** Claude 会话（`--resume <sessionId>`），
长上下文留在员工侧，不会被拖进领导的上下文。

**成本画像：** 每个 job 多一棵 CLI 进程树，加上你的 Claude 端点按量计费。

---

#### 档 3 · + deepseek-harness

**需要：** 档 2 + npm 包 `@deepseek-ai/dsh`。**耗时：** 再加约 5 分钟。
**新增能力：** 第二个 worker backend，走它自己的供应商链路与缓存行为。

```bash
npm i -g @deepseek-ai/dsh
```

然后指路（只在自动探测失败时才需要——通常不需要）：

```toml
[mcp_servers.claude_orchestrator.env]
DEEPSEEK_HARNESS_ROOT = "<@deepseek-ai/dsh 安装目录>"
# DEEPSEEK_HARNESS_RUNNER = "<runner 入口文件路径>"   # 可选，显式覆盖
```

派单时传 `workerBackend=deepseek-harness`。可用性用 `claude_code_health` 验证：capabilities 段会报
`unavailableReason`（`root_missing` / `runner_missing`）。

> **能力契约——派单前必读。** 本地 headless harness 是**单次、只回最终文本**的协议。因此这个
> backend 声明 `supportsAttention = false`、`supportsLiveEvents = false`、
> `supportsSessionResume = false`。对它 `claude_code_reply` **默认被拒**，固定错误前缀
> `fresh_turn_authorization_required`；传 `allowFreshTurn=true` 会执行一个**新的独立有界轮次**——
> 那**不是** resume，返回里带 `replyMode=fresh_turn`。**永远不要把它描述成"续做"。**
> 完整细节见 [docs/BACKENDS.md](docs/BACKENDS.md)。

**成本画像：** 每个 job 多一个 headless 进程；无常驻 runtime。

---

### ⚠️ 最费时间的两个坑

> #### ⚠️ 坑 1 —— `enabled = false` 会让工具**根本不存在**
>
> 如果你的 `[mcp_servers.claude_orchestrator]` 段被禁用，**Codex 不会报错**。它的表现就像这个
> server 从没配过：`/mcp` 里看不到 `claude_orchestrator`，所有 `claude_code_*` 工具都不存在。
> 于是人去查调度器、查构建、查 Node——而真正要改的只有一行：
>
> ```toml
> [mcp_servers.claude_orchestrator]
> enabled = true        # ← 就是这行。server 侧写多少代码都补不回来。
> ```
>
> 最常见的踩法：之前某次实验留下一个 `enabled = false` 的旧段，你又**追加**了第二个同名段；
> TOML 以最后一个为准，但你的编辑器/shift+grep 先看到的是第一个。
> **正确做法是删掉旧段，而不是叠一个新段。**

> #### ⚠️ 坑 2 —— `tool_timeout_sec` 必须 ≥ 14400，否则 `watch` 会被提前掐断
>
> `claude_code_watch` 的设计就是在**一次 MCP 调用里挂起最长 4 小时（14400 秒）**。这正是 job 模型
> 便宜的原因。如果宿主的工具超时更小，宿主会中途杀掉这次调用，一个完全健康的长任务就表现得像
> "莫名失败"。
>
> ```toml
> [mcp_servers.claude_orchestrator]
> startup_timeout_sec = 120
> tool_timeout_sec = 14400      # ← 必须 ≥ 14400（4 小时）；配小了会截断长等待
> ```
>
> 注意这组不对称：`claude_code_wait` 自己封顶 240 秒（刻意的单次调用边界），所以
> **只有 `watch` 需要那个大宿主超时**。

---

### 前置条件

| 要求 | 说明 |
|---|---|
| **Node.js ≥ 20** | 写在 `package.json` 的 `engines` 里。Node 20 / 22 / 24 都可以。 |
| **Codex CLI** | 你自己安装并接受它自己的条款。本仓库不打包、不分发它。 |
| **Claude Code CLI**（档 2+） | `claude` 命令需在 `PATH` 上，或用 `CLAUDE_CLI_NAME` 指定绝对路径。请自行安装。 |
| **`@deepseek-ai/dsh`**（档 3） | 可选，在 npm 上单独发布。 |
| **许可与合规自查** | `@anthropic-ai/claude-code` 是**专有软件**。本仓库**不分发**它、不下载它、也不重新实现它——只是启动你已经装好的那个可执行文件。以程序化方式使用前请自行核对 Anthropic 的条款。 |

调度器不读取、不存储、不记录你的任何凭据。你配了端点它才注入端点；你什么都不配，它就什么都不注入。

---

### 配置项参考

所有配置都通过 MCP server 的 `env` 段环境变量完成。默认值直接取自 `src/config.ts`。

#### 端点、凭据、模型——认证契约

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `ORCHESTRATOR_ANTHROPIC_BASE_URL` | *(未设置)* | **留空 = 不注入任何端点。** worker 继承 Claude CLI 自己的配置（官方登录态、你自己的 key、包装脚本……）。设为 `local`（或 `auto`）→ 注入 `http://127.0.0.1:<port>` 加该模式固定的占位 token，即**用本机代理**。设为具体 URL → 注入该端点。 |
| `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN` | *(未设置)* | 仅与"具体 URL"形态的 `ORCHESTRATOR_ANTHROPIC_BASE_URL` 搭配。未设置 = token 键**整个不写**（写空串会覆盖 CLI 自己的默认值——**不要**写 `""`）。`local` 模式下忽略该项，用固定占位 token。 |
| `ORCHESTRATOR_MODEL_HAIKU` / `_SONNET` / `_OPUS` | *(未设置)* | 可见模型 id，注入为 `ANTHROPIC_DEFAULT_<KIND>_MODEL`。未设置 = 不注入，CLI 保留自己的默认模型，不会被强推到你可能根本没有的 id 上。 |
| `ORCHESTRATOR_MODEL_HAIKU_NAME` / `_SONNET_NAME` / `_OPUS_NAME` | *(未设置)* | 可选的供应商侧别名，注入为 `ANTHROPIC_DEFAULT_<KIND>_MODEL_NAME`。 |

> **零配置路径才是设计意图。** `ORCHESTRATOR_ANTHROPIC_BASE_URL` 留空意味着调度器**完全不注入**
> 端点与模型信息：worker 跑在你已有的 Claude CLI 登录态上。只有当你**故意**要把 worker 接到本机
> 代理或自定义的 Anthropic 兼容端点时，才设置这些变量。

#### worker 权限与文件

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `ORCHESTRATOR_WHITELIST_PATH` | `<HOME>/.claude/worker-whitelist.json` | worker 权限白名单路径。文件的 `permissions.allow` **按原样使用**（绝不替你放大授权）；`permissions.deny` 会与**内置默认拒绝清单取并集**，而内置清单是一道配置无法降低的地板。文件缺失或格式错误时，调度器回退到内置策略——一份保守的 allow 列表加上完整的内置 deny 清单（`deny` 永不为空）——并通过 `claude_code_start` / `claude_code_reply` 响应的 `warnings[]`、该 job 的 `runtime/logs/<jobId>.stderr.log`、以及 `claude_code_health` 的 notes 报告它替换或补齐了什么。仅仅是**比基线窄**的文件（例如随仓库发的模板）会被并集补齐，报告为 `worker whitelist incomplete … Nothing is broken`，属告知性质。详见 [docs/TROUBLESHOOTING.md §4](docs/TROUBLESHOOTING.md)。 |
| `ORCHESTRATOR_READ_GUARD_HOOK` | 该文件存在时用 `<HOME>/.claude/cache-sentinel/read-guard.cjs` | 可选的 `Read` 的 `PostToolUse` hook，用于在 worker 读入超大文件时告警。设为 `off` / `0` / `false` 显式禁用。路径不存在时静默不注入——全新安装不会产生一个必然失败的 hook。 |
| `CLAUDE_CLI_NAME` | `claude` | 要启动的 Claude CLI 可执行文件。`claude` 不在 `PATH` 上时请给绝对路径。 |
| `CLAUDE_CLI_PREFIX` | *(未设置)* | 插在 claude 命令**之前**的一个可执行文件（例如 node 包装器）。按单个 token 处理，因此路径含空格也可以。测试套件用它来驱动假 CLI。 |
| `ORCHESTRATOR_HERMETIC_MCP` | 存在时用 `config/hermetic-mcp.json` | worker 侧的 MCP 配置。配合 `--strict-mcp-config` 给每个 worker 一个空 MCP 面，使 worker 无法递归调用调度器。 |

#### 运行时、恢复、留存

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `ORCHESTRATOR_RUNTIME` | `<repo>/runtime` | 运行时根目录（`jobs/`、`logs/`、`settings/`、`reports/`、`claims/`、`registry/`）。改它可以隔离会话或测试。 |
| `ORCHESTRATOR_HOST_PID` | *(未设置)* | 宿主会话标识。设置后实例 registry 记录会被归组，同一宿主的多个会话不会被误判为重复实例。 |
| `ORCHESTRATOR_REGISTRY_HEARTBEAT_MS` | `10000` | 实例心跳间隔（最小 250）。 |
| `ORCHESTRATOR_REGISTRY_STALE_AFTER_MS` | `30000` | registry 记录判定为 stale 的阈值（最小 250）。 |
| `ORCHESTRATOR_BOOTSTRAP_GRACE_MS` | `15000` | 一个从未 spawn 过 supervisor 的 `queued` job 允许静置多久后，恢复逻辑才判定它"从未启动"并安全重试。 |
| `ORCHESTRATOR_RECOVERY_CLAIM_LEASE_MS` | `60000` | 单次恢复 pass 的短租约。 |
| `ORCHESTRATOR_ATTENTION_CONFIRM_MS` | `5000` | 暂态权限信号被提升为 `needs_attention` 前的确认窗口。 |
| `ORCHESTRATOR_START_JITTER_MAX_MS` | *(内部默认)* | 启动随机抖动的上限；`0` 关闭。 |
| `ORCHESTRATOR_RETENTION_V2` | 关闭 | 开启只读留存 dry-run（`claude_code_retention_preview`）与 job 索引。关闭时 preview 完全不扫描 runtime，且保持旧的 runtime 文件布局。 |
| `ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES` | `2097152`（2 MiB） | Claude resume 阈值。超过则需要 `allowLargeResume=true`，否则以 `new_start_required` 拒绝。 |
| `ORCHESTRATOR_REPLY_PREFLIGHT` | 关闭 | 控制 Claude 转写体积 preflight 的功能开关。harness 的 `fresh_turn_authorization_required` 门**无条件生效**，不依赖任何开关。 |

#### 准入控制与 v2 契约（进阶，默认全关）

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `ORCHESTRATOR_ADMISSION_CONTROL` | 关闭 | 启用结构化准入控制。 |
| `ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY` | `4` | 领导层默认的目标 worker 并发（1–64）。 |
| `ORCHESTRATOR_ADMISSION_HARD_CEILING` | `8` | 并发 worker 的硬安全上限（1–64）。 |
| `ORCHESTRATOR_ADMISSION_MAX_HEAVY_WORKERS` | `2` | `resourceClass=heavy` 的最大并发（1–64）。 |
| `ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB` | `2048` | 空闲内存下限，低于它新的重型 job 排队。 |
| `ORCHESTRATOR_METRICS_V2` | 关闭 | 在公开视图里附带紧凑的 per-job metrics。 |
| `ORCHESTRATOR_CONTRACT_V2` | 关闭 | 启用严格校验的 v2 任务契约。 |
| `ORCHESTRATOR_BUDGET_ENFORCEMENT` | 关闭 | 通过 `PreToolUse` hook 强制执行 v2 契约预算。 |

#### 实时可见窗口

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `OPEN_LIVE_VIEW` | 关闭 | `1` 时弹出一个独立的可见控制台窗口，实时跟随 job 输出。默认关闭，Windows 上不会闪窗。 |
| `ORCHESTRATOR_VIEWER_TERMINAL_POLICY` | `persist_static` | `close` 打印一次终态后退出；`persist_static` 保留静态终态页并等待同会话新 job。未设置/空/非法值一律按 `persist_static`。 |

#### deepseek-harness backend

| 变量名 | 默认值 | 作用 |
|---|---|---|
| `DEEPSEEK_HARNESS_ROOT` | *(自动探测)* | 显式安装根目录；否则探测全局 npm 下常见的 `@deepseek-ai/dsh` 位置。 |
| `DEEPSEEK_HARNESS_RUNNER` | *(自动探测)* | 显式 runner 入口；路径存在时它说了算。 |
| `DEEPSEEK_HARNESS_BRIDGE_PATCH` | *(未设置)* | **显式 opt-in。** 只有它是非空值，bridge patch 才会被传下去。光有 bridge 文件在磁盘上**不算**。 |
| `DEEPSEEK_HARNESS_DISABLE_BRIDGE` | *(未设置)* | `1` 永远优先：bridge 完全禁用，harness 独立运行。 |
| `ORCHESTRATOR_DEFAULT_WORKER_BACKEND` | `claude` | `claude_code_start` 省略 `workerBackend` 时的默认后端。 |

---

### 工具契约

共注册 9 个工具。全部返回 JSON 文本；全部按"紧凑"设计，绝不返回 prompt、token、完整日志、diff
或环境变量值。

| 工具 | 输入 | 返回 |
|---|---|---|
| `claude_code_start` | `prompt`、`workFolder`（绝对路径）、`profile`（默认 auto / review / normal）、`workerBackend`（默认 claude / deepseek-harness）、`internalAgentParallelism`（auto/1–4，旧别名 `parallelism`）、`desiredWorkerConcurrency`（1–64，可选）、`maxRuntimeMinutes`（30–180，默认 120）、`taskType`（execution/research/analysis，默认 execution）、`deliverablePath`（research/analysis 必填的绝对 `.md` 路径）、可选 v2 `contract` | 10 秒内返回 `jobId` + `sessionId` + 解析后的路由 + warnings，并启动 detached 后台 job。 |
| `claude_code_status` | `jobId`、`progressLines`（1–20，默认 3）、`raw?` | `queued \| running \| needs_attention \| succeeded \| failed \| cancelled`、运行时长、最后活动、`idleSeconds`（距 worker 最后一次**真实**输出的秒数，判卡死用）、**渲染后的**可读尾部（assistant 文本 / 工具调用 / 结果 / 终态横幅；`raw:true` 才回原始日志尾部）、报告路径。research/analysis 额外带 `taskType` / `deliverablePath` / `deliverableHash` / `missingDeliverable`。不含完整日志与存储的 prompt。`needs_attention` 时附带结构化净化摘要 `attentionDetail`。 |
| `claude_code_wait` | `jobId`、`waitSeconds`（默认 240，最大 240） | **仅作故障回退**：长轮询到终态 / `needs_attention` / 到期。单次调用不超过 300 秒调用方边界。 |
| `claude_code_watch` | `jobId`、`timeoutSeconds?`（默认与最大均为 14400） | **默认等待方式**：事件驱动挂起，直到 `succeeded/failed/cancelled/needs_attention`，或 watch 自身 timeout / abort / not-found / internal-error。运行中**绝不**返回 `running`，因此 0 模型回合。断开或取消只清 watcher——**不**取消 job、不改变其状态；之后可用同一 `jobId` 重新 `watch` 附着。唤醒时直接携带 `attentionDetail`。 |
| `claude_code_reply` | `jobId`、`prompt`（窄指令）、`allowLargeResume?`、`allowFreshTurn?` | Claude 后端：用已保存 session 续跑（同 `sessionId`，`--resume`）；转写超过阈值时以 `new_start_required` 拒绝，除非 `allowLargeResume=true`。harness 后端：**默认拒绝**，固定前缀 `fresh_turn_authorization_required`；`allowFreshTurn=true` 才执行新的独立有界轮次（`replyMode=fresh_turn`），**绝不**碰父会话、**绝不**伪称连续性。被引用 job 仍在运行时拒绝——reply 总是产生**新** job。 |
| `claude_code_cancel` | `jobId`、`reason?` | **只**终止目标 job 的进程树；带 reason 记录 `cancelled`；日志与报告保持可审计。其他 job 不受影响。 |
| `claude_code_list` | `limit?`（1–50，默认 20） | 最近 job 的紧凑元数据（最新在前）——MCP / 宿主重启后的恢复入口。绝不含 prompt、token、完整日志。 |
| `claude_code_health` | *（无参数）* | 只读健康检查：`version`、`loaded` vs `disk` 构建指纹、实例身份（`pid` / `startedAt` / `uptimeSec` / entry basename）、**本进程实际注册**的能力（含 `watch`、结构化 attention、响应审计、worker backends）、job 计数、`reloadRequired`、`diagnostic`、实例 registry（重复实例 / stale 记录）以及结构化 `diagnostics[]`。绝不含 prompt、token、raw log、env 值、密钥或完整命令行。 |
| `claude_code_retention_preview` | `limit?`（1–500）、`cursor?`、`includeKeep?`、若干天的 TTL 覆盖 | 只读留存 **dry-run**。零文件系统改动。`ORCHESTRATOR_RETENTION_V2` 关闭时不扫描 runtime，直接返回 `{ enabled: false, dryRun: true, items: [], ... }` 且 totals 全零。刻意**没有** apply/delete 工具。 |

#### job 生命周期状态

```
queued ──► running ──┬──► succeeded          （终态）
                     ├──► failed             （终态；看 substatus / failureDetail）
                     ├──► cancelled          （终态）
                     └──► needs_attention ──┬──► （reply）running ──► ...
                                            └──► （cancel / maxRuntime）──► cancelled
```

终态是**单调**的：`updateJobIf` 守卫每一次迁移，终态不会被回退，并发取消也不会输给一个迟到的写入者。

#### `taskType` 与 Markdown 交付物契约

`taskType` 可选，默认 `execution`，行为与以往完全一致：

- **`execution`**（默认）——实现任务。此时传 `deliverablePath` 会被**拒绝**，保证契约无歧义。
- **`research` / `analysis`**——唯一主工件是一份 Markdown 报告，必须写入**你提供的绝对
  `deliverablePath`**（在 `workFolder` 内、以 `.md` 结尾、不等于 `workFolder`；调度器绝不猜路径）。
  `buildPrompt` 会向 worker 注入交付物契约，必需章节：目标与范围 / 证据与方法 / 发现（事实）/
  未决问题与风险。调度器不篡改、不合成报告。
- **交付物校验发生在发布终态之前**——supervisor 检查工件（常规文件、非空、SHA-256 可哈希）。
  有效 → `deliverableHash` + `missingDeliverable=false`；缺失 / 非文件 / 空 / 不可哈希 →
  `missingDeliverable=true`；若 worker 本应 `succeeded` 但工件无效，状态**翻转为 `failed`** 并带
  净化后的 `substatus`（如 `deliverable_missing`）。**报告缺失绝不静默通过验收。**
- **`reply` 同时继承** `taskType` 与同一个 `deliverablePath`，续写同一工件而不是重置；hash 在
  reply 终态重新计算。

#### `needs_attention` 里到底有什么

`claude_code_watch` 与 `claude_code_status` 都携带 `attentionDetail`，让领导不用第二次调用就知道
**需要审批的是什么**：

```jsonc
{
  "requestId": "fake-prompt-1",        // 上游 id；无则本地生成 `local-<uuid>`
  "requestIdSource": "upstream",        // upstream | local
  "tool": "Bash",                       // 白名单工具名，否则 unknown
  "action": "delete",                   // 白名单动作，否则 unknown
  "path": "probe.txt",                  // workFolder 相对路径；目录外仅 basename
  "risk": "high",                       // low | medium | high | unknown（保守）
  "at": "2026-08-12T00:00:00.000Z",     // 记录时间
  "message": "需要审批：Bash delete probe.txt"
}
```

安全边界——这是**纯可观测性**，不改变任何审批决策：

- **绝不**包含完整 prompt、raw 日志、token、diff、密钥、cookie 或 env 值。
- `tool` / `action` 走白名单；无法解析 → `unknown` + 通用安全 message，**不**回退到原始 payload。
- `path` 只回最小路径：工作目录内回相对路径，目录外只回 basename。绝不泄漏 home 全路径。
- `risk` 只是保守分类，绝不降低上游风险。
- `requestId` 稳定、无凭据、长度有界，且在 `watch` / `status` / 重启之间保持一致。
- 该记录位于 job JSON 的 `attentionLog[]`（只读观测，最多保留最近 5 条）。它**不改变**状态机，
  且**不存在**自动审批、授权继承或去重自动 reply。本地生成的 `requestId` **不是**授权凭据；reply
  也绝不授权任何动作——响应审计恒为 `authorization: false`。

**暂态信号的处置。** `auto` 档 worker 可能发出一个瞬时的权限/控制信号后自行放行。因此 supervisor
设了一个确认窗口（默认 5 秒，`ORCHESTRATOR_ATTENTION_CONFIRM_MS`）；只有在没有后续 stdout 时才提升
为 `needs_attention`。若输出继续，候选被取消，job 保持 `running`。`needs_attention` **只**由结构化
控制/权限事件（`userPrompt` / `control_request` / `permission_request`）驱动——普通文本 banner、
stderr 噪声、慢工具都不会产生它。

#### `status` / `watch` / `wait` 三者分工

| | `watch`（默认） | `wait`（回退） | `status`（手动） |
|---|---|---|---|
| 机制 | 事件驱动，跨进程 broker | 长轮询 | 即时读取 |
| 最长时长 | 14400 秒 | 240 秒 | — |
| 会返回 `running` 吗 | 绝不 | 到期时可能 | 会 |
| 运行中的模型回合数 | **0** | 每次调用 1 个 | 每次调用 1 个 |
| 断线行为 | 只清 watcher | — | — |
| 适用 | 常规等待 | 恢复、排障、宿主不支持长调用时 | 抽查、看 `idleSeconds`、审计 |

### profile 与权限路由

路由按 **profile** 决定，绝不按模型名决定。三档都指向同一个端点，区别只在 CLI 的权限模式：

| profile | 权限模式 | 用途 |
|---|---|---|
| `auto`（**实现任务默认**） | `bypassPermissions` | 常规实现 / 修改 / 测试。**没有沙箱。** 不逐项弹审批，且**完全没有基于模型的权限分类器**——文件编辑、Bash、工具调用全部放行，worker 以你的操作系统用户身份运行。`deny` 是这一档唯一能拦住东西的规则类型，而且它**永不为空**：内置默认拒绝清单是一道地板（批量删除、`git push`、`npm publish`、网络出口、凭据位置、系统目录写入），你白名单里的 `deny` 规则与它**取并集**——你的文件只能收紧策略，不可能放松它。匹配是字面前缀匹配，换个写法、写进脚本、经 `npx` 间接调用都拦不住——它是缩小爆炸半径的手段，不是被强制执行的边界。 |
| `review` | `plan` | 只读分析、审计、风险排查。配合 `taskType=research\|analysis` + `deliverablePath` 时，调度器自动切换到派生模式，**只**放行该报告文件本身的写入；其他任何写入仍升级审批。纯读工具已放行。 |
| `normal` | `acceptEdits` | 仅人工控制 / 故障回退，不再是默认。 |

**分类器为什么被拆掉。** 早期设计在每次工具调用前插一个模型分类器。实际表现是：每次调用多发一次
模型请求，经共享链路时持续超时、阻塞已经批准的操作、反复烧额度——安全机制变成了吞吐瓶颈。
取而代之的取舍是**确定性优于概率性**：`auto` 档全通过，唯一的策略层是**每 job 独立注入的 `deny`
清单**（字符串匹配，不会超时、不会误判、不消耗额度）。但请看清它买到了什么：`deny` 是一份
**部分可绕过的前缀黑名单**，不是沙箱——换个写法、写进脚本、经 `npx` 间接调用都能过去；而内置基线
与你文件里的规则是**取并集**的，配置只能收紧、不可能降低（见
[安全边界速览](#安全边界速览派第一个任务之前请先读这节)）。权限注入是**每 job 独立**的，外部工具
重写你的全局 settings 也抹不掉它。

> 在只读会话里反复重试同一次写入是 bug 的信号，不是策略。如果 worker 一直卡在"写报告"的
> `needs_attention` 上，**取消后重派**，而不是对它 reply N 次。

每个 job 拥有自己的 `runtime/settings/<jobId>.settings.json`，通过 `--settings` 注入。这是路由
能生效的原因：实测 `--settings` 的 env 块会覆盖 CLI 自己的 `~/.claude/settings.json` env 块，而
进程环境变量**不**覆盖它。worker 启动形状：

```
claude -p --session-id <uuid> --permission-mode <mode> --effort <level> \
  --output-format stream-json --verbose --autocompact=128000 \
  --settings <per-job settings> --add-dir=<workFolder> \
  [--disallowedTools=Edit,Write,NotebookEdit] \
  [--mcp-config <hermetic> --strict-mcp-config] \
  [--allowedTools=<rule> ...] <wrapped prompt>
```

- Claude 的 reply 用 `--resume <sessionId>` 取代 `--session-id`（真·会话续跑）；harness 的 reply
  用**新** `--session-id`，因为它从不 resume。
- `effort` 按 job 派生：`analysis` → `max`，其余 → `high`。它固定在每 job 的 settings 里，而不是
  按任务现调。
- `review` 额外加 `--disallowedTools=Edit,Write,NotebookEdit`。
- hermetic MCP 配置是可选的：`config/hermetic-mcp.json` 不存在时不注入 `--mcp-config`，worker 保留
  自己的 MCP 配置。
- 每条白名单规则都会以 `--allowedTools=<rule>` 传一遍，作为第二层防线——即使 job settings 文件损坏，
  worker 也不会掉进逐项审批。
- `--autocompact=128000` 让长链路 worker 与交互窗在同一阈值自动压缩，而不是常驻一个 >128k 的上下文
  让每一轮都是全量缓存 miss。
- 注意 `--add-dir`、`--disallowedTools`、`--allowedTools` 都用**等号形式**：空格形式会贪婪吃掉
  末尾的 prompt 位置参数。

harness backend 完全不启动 `claude`——supervisor 跑的是
`node dist/deepseek-worker.js --job <jobId>`，由该适配器去调用本地 headless runner。

### 等待机制内部如何实现

- supervisor 与 MCP server 是**两个进程**。watch 的状态源是共享的 `JobEventBroker`
  （`src/job-events.ts`），它监听的是 **jobs 目录**而不是单个文件句柄——必须如此，因为 job 文件
  会被原子 rename 替换。
- 同时观察 `<jobId>.json` 与 `<jobId>.done.json`；`needs_attention` 可能早于 done marker 写入。
- 订阅采用"读状态 → 注册 → 再读状态"的双检，消除检查/订阅竞态。
- `fs.watch` 是主事件源；另有一个 15 秒的内部 fallback，**仅在存在订阅者时**运行，且只检查有订阅
  的 job。fallback 绝不向调用方暴露 `running`。
- 多个 watcher 共用一个目录 watcher，按 `jobId` 分发；所有 resolve / error / timeout / abort 出口
  都幂等清理 listener、timer 与句柄；最后一个订阅者离开后目录 watcher 关闭。
- MCP SDK 回调的 `extra.signal` 只用于清理**当前 watcher**。客户端 abort / 断线**不**取消 job、
  不杀 worker、不改变 job 状态。
- `watch` 不读 `runtime/logs/*.log`，也绝不返回原始 stream-json。

### 自验证（不花额度）

测试套件跑在 `test/fake-claude.mjs` 上——一个按脚本播放 Claude CLI stream-json 协议的夹具。
**你可以在没有真实模型、不消耗任何额度的情况下验证整条链路**：spawn、解析、attention、交付物
校验、恢复、watch。

```bash
npm test                          # 构建 + 全量 node:test（使用假 CLI）
npm run test:unit                 # 仅 unit 层
npm run test:integration:serial   # 串行 integration 层
npm run test:windows              # Windows 进程身份层
npm run test:gate                 # unit → integration → windows → smoke gate，顺序执行
npm run test:smoke:gate           # 离线 smoke 门禁
npm run test:smoke:offline-all    # 离线 smoke 扩展集
npm run test:smoke:all            # 含 live 类别（见下）
```

`live` smoke 类别**只有**在 `ORCHESTRATOR_ALLOW_LIVE_SMOKE=1` 时才运行；否则按源码里固定的理由跳过。
`CLAUDE_CLI_NAME` / `CLAUDE_CLI_PREFIX` 用于指定 claude 命令或测试替身。

失败的层只会输出一段有界的 `[layer] FAILURE_DIAGNOSTICS_BEGIN/END` 区块（默认最多 16000 字符）；
通过的层不会多输出任何东西。

### job 持久化、恢复与回滚

- 每个 job 一个 JSON：`runtime/jobs/<jobId>.json`，原子写入（临时文件后改名）。
- **完整 prompt** 只本地持久化在那个 job JSON 里。任何工具都不会回传它。要删除历史 job，清空
  `runtime/jobs/` 与 `runtime/logs/` 即可。
- MCP 启动时 `recoverJobs()` 依据 job 文件 + `.done` 标记 + PID 存活恢复状态：有 done 标记以它
  为准；进程仍存活则保持 `running`（只有确实超时才标 `timeout`）；否则标为 `failed`
  （`interrupted`）——session 仍可通过 `reply` 续跑。
- **CAS 状态锁。** `claims/<jobId>.state.json`（O_EXCL + owner 身份 + lease）是唯一写入入口，因此
  并发写在文件系统层串行化，绝无跨进程 read-modify-write。verified-live 锁永不被夺；verified-dead
  或身份不匹配的锁被原子 rename 夺走。损坏或未完成写在 mtime 宽限期后由单胜者恢复。
- **单写者 claim。** supervisor 与 recovery 各持 O_EXCL claim，只有胜者能 ack、spawn 或恢复。
  双 supervisor / 双 recoverer 不可能同时拥有一个 job。
- **PID 复用防护。** 每个 PID 都连带其 OS 创建时间一起存储（`supervisorPidStartedAt` /
  `pidStartedAt`）。无身份或身份不匹配的 PID **绝不**被 kill 或 attach。
- **信任边界的严格校验。** `isValidJobRecord` 冻结公开契约；后加的可选字段遵循"缺失可、错误拒"。
  `.done` 标记经 `parseDoneMarker`（jobId 匹配、只接受终态或 `needs_attention`，拒绝
  `queued`/`running`）。无效标记按缺失处理，绝不推进或回退 Job。

**一分钟回滚：**

1. 从 `<CODEX_HOME>/config.toml` 删掉 `[mcp_servers.claude_orchestrator]` 段（自己的备份自己留）。
2. 从你自己的备份恢复全局指令文件（`AGENTS.md` 或等价物）。
3. 可选：删除 `runtime/` 清空 job 历史。

> `runtime/` 里可能有 prompt 的本地副本。若可能还要保留，删除前先确认。

### 健康检查、重载与实例诊断

`claude_code_health` 回答的是：*当前进程加载的构建过期了吗？能力齐不齐？我重复了吗？有崩溃残留
吗？需要重载吗？* 它严格只读——绝不杀进程、重启、修复或清理任何东西，也不写任何 runtime 状态
（自身心跳除外）。

- **构建指纹。** `loaded.buildFingerprint` 是进程启动时对整个**生产 dist 模块集**算出的确定性根
  哈希；`disk.buildFingerprint` 每次调用现算。新增、删除或修改**任一**依赖模块——即使 `index.js`
  字节不变——指纹就会变，`reloadRequired=true`、`diagnostic=reload_required`。（旧的"仅入口"
  `buildHash` 字段作为兼容信息保留，不再是判定依据。）
- **有疑即保守。** 任一模块不可读、或任一侧指纹为空：`diagnostic=hash_unavailable`、
  `reloadRequired=true`。无法证明健康就不报健康。
- **能力是证明出来的。** `capabilities.tools` 来自**本进程实际注册**的工具，不是读磁盘源码。
  `structuredAttentionDetail`（watch + status 已注册）与 `responseAudit`（reply 已注册）为真，即证明
  当前进程确实暴露这些能力。
- **实例 registry。** 每个 MCP 进程在 `runtime/registry/instances/<instanceId>.json` 写一条**只属于
  自己**的记录——`instanceId`、`pid`、`processStartedAt`、`serverStartedAt`、entry basename、
  `buildFingerprint`、`lastHeartbeatAt`、`version`。并发进程互不覆盖。记录**不含** env、prompt、
  token、raw log、完整命令行或密钥。心跳定时器 `unref`，不阻止进程退出；正常退出尽力注销，崩溃
  残留靠 stale / identity 检测发现。
- **真实的重复与 stale 诊断。** `duplicate_instance_suspected` 要求**至少两个通过身份校验的存活
  实例**且跨越不同宿主 PID——崩溃残留与已死 PID 绝不计入。`registry_stale` 覆盖心跳超时、PID 不
  存在、PID 身份不匹配、记录不可读，并给出净化后的 `staleReasons` 计数。两者可以与构建的
  `reload_required` / `hash_unavailable` **同时存在**，通过布尔量加结构化 `diagnostics[]` 呈现，不丢
  信息。
- **绝不自动清理。** 手工 runbook：确认某重复实例或残留确实可清理后，停止多余的 MCP 进程；确认某
  记录的 PID 已死或身份不匹配后，可手工删除 `runtime/registry/instances/` 下对应 JSON。
- **重载 runbook。** `npm run build` 之后必须重载或重启 `claude_orchestrator` MCP server（或重启
  Codex）才能加载磁盘新构建。然后重跑 `tools/list` 与 `claude_code_health`，验证
  `loaded.buildFingerprint == disk.buildFingerprint`、`reloadRequired=false`、
  `diagnostic=healthy/current`。

### 实时可见窗口（可选，给人看）

默认关闭——在 Windows 上 `claude_code_start` **不会**弹窗，除非你设 `OPEN_LIVE_VIEW=1`。开启后它
打开一个独立的可见控制台跑 `dist/viewer.js`，按字节偏移轮询该 job 的 stdout + stderr 日志
（约 500ms；append-only 的 tail 用轮询比 `fs.watch` 可靠），实时渲染 assistant 文本、工具调用、
结果、权限请求与 meta 横幅。`reply` 续同一会话时会跟进同一个窗口。

任何 job 都可以随时手工补开（不受 `OPEN_LIVE_VIEW` 影响）：

```bash
node dist/viewer.js <jobId>
```

### 目录结构

```
src/
  index.ts        MCP 入口：注册 9 个工具、启动恢复、health 指纹、registry 生命周期
  scheduler.ts    start/status/wait/watch/reply/cancel/list + 恢复 + deliverable 视图字段
  job-events.ts   共享跨进程 JobEventBroker（目录 fs.watch + 内部 fallback）
  supervisor.ts   detached job 执行器（claim、先 ack 后 spawn、attention 窗口、交付物校验、done 标记）
  parser.ts       共享增量行缓冲流解析器（拆 chunk 复原、事件归类、attention 净化）
  render.ts       共享可读渲染（status 渲染尾 + viewer）
  health.ts       只读 health / version / 重载 / 实例诊断
  registry.ts     实例 registry + 心跳 + 进程身份 / PID 复用 + stale / duplicate 快照
  recovery.ts     三阶段 bootstrap checkpoint / claim + 单 recoverer 恢复
  viewer.ts       实时可见窗口（字节偏移轮询 tail，跟随会话链）
  router.ts       profile → 端口/权限 真值表 + taskType/deliverablePath 参数校验
  backend-policy.ts  worker backend 能力矩阵 + reply preflight（纯函数，无副作用）
  worker-adapter.ts  backend 选择 + 只读 harness 探测
  leader.ts       可选委派任务的 prompt 包裹（绝不篡改你的需求）
  job-store.ts    原子 job 持久化、公开视图（不含 prompt）、CAS 状态锁、严格校验
  proc.ts         isAlive / killTree / PID 身份 / Windows 窗口可见性
  config.ts       路径与常量
config/           hermetic-mcp.json —— 与 --strict-mcp-config 配合的空 MCP 配置
templates/        AGENTS.strict-delegation.md —— 可直接粘贴的全局规则模板
tools/            init.mjs —— 环境探测 + 配置生成器（对你的文件只读）
test/             node:test unit + integration 套件、假 CLI 夹具（零真实模型调用）
smoke/            离线与 live 冒烟脚本
runtime/          jobs / logs / settings / reports / claims / registry（运行时生成）
```

### 文档索引

| 文档 | 用途 |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | 三档安装的逐步操作，含预期输出与失败处置 |
| [docs/METHODOLOGY.md](docs/METHODOLOGY.md) | 三层纪律**为什么**这样设计，以及什么时候它是净损失 |
| [docs/BACKENDS.md](docs/BACKENDS.md) | 三类 worker 的接入细节、能力矩阵与路由决策树 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 症状 → 原因 → 处置，含上面两个坑 |
| [templates/AGENTS.strict-delegation.md](templates/AGENTS.strict-delegation.md) | 可粘贴进全局指令的规则模板 |

### 许可

MIT，见 [LICENSE](./LICENSE)。

本仓库不分发 `@anthropic-ai/claude-code`、`@deepseek-ai/dsh` 或 Codex。它启动的是你自己安装的
CLI，各自遵循各自的许可与条款。
