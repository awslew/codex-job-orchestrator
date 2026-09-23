// Detached job runner. The scheduler spawns one of these per job
// (`node dist/supervisor.js --job <jobId>`) with stdio ignored; it survives
// MCP server restarts, so job exit codes, reports and .done markers are
// written even while the MCP process is down.
//
// Responsibilities:
//   - write the per-job settings file that forces the correct base URL
//     (verified: --settings env overrides ~/.claude/settings.json env)
//   - spawn the claude CLI (or an injected fake for tests) with the routing
//     flags for the job's profile
//   - stream output to logs/<jobId>.log; detect permission requests while alive
//   - enforce maxRuntimeMinutes hard cap
//   - map the exit code to a final status, write a report, write .done
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import {
  admissionControlEnabled,
  anthropicRoute,
  defaultClaudeCli,
  DEFAULT_WORKER_ALLOW,
  ensureRuntimeDirs,
  hermeticMcpConfig,
  modelOverride,
  readGuardHookPath,
  readWorkerWhitelist,
  resolveWorkerDeny,
  runtimeRoot,
  whitelistPath,
} from './config.js';
import { AdmissionSupervisorLease } from './admission-supervisor-lease.js';
import {
  readJob,
  updateJob,
  updateJobIf,
  acquireJobStateLock,
  releaseJobStateLock,
  jobFilePath,
  logFilePath,
  appendLog,
  appendStderrLog,
  writeReport,
  doneFilePath,
  settingsFilePath,
  reportFilePath,
  atomicWriteJson,
  isTerminal,
  isValidBootstrap,
  inspectDeliverable,
  type Job,
  type JobBootstrap,
  type JobStatus,
  type DeliverableValidityReason,
} from './job-store.js';
import { killTree, spawnBackground, capturePidStartedAt } from './proc.js';
import {
  runAcceptanceCommands,
} from './acceptance-runner.js';
import type { AcceptanceCommandSpec } from './contracts-v2.js';
import type { TaskContractV2 } from './contracts-v2.js';
import type { GateResult } from './acceptance-runner.js';
import type { ManifestDiff } from './review-policy.js';
import {
  LineParser,
  parseLine,
  sanitizePermission,
  genericAttentionSummary,
  type AttentionSummary,
} from './parser.js';
import {
  buildEvidenceReportSkeleton,
  createBudgetState,
  type BudgetState,
} from './budget.js';
import { createJobMetrics, createJobMetricsCollector, type JobMetricsV2, type JobMetricsCollector } from './job-metrics.js';
// Type-only import (erased at runtime): budget-hook.ts exits only when run as
// the main entry, so importing its types here adds no runtime coupling.
import type { BudgetHookState } from './budget-hook.js';
import { renderedTail, readTailBytes } from './render.js';
import { detectDeepSeekHarness } from './worker-adapter.js';
import { captureWorkspaceManifest, diffWorkspaceManifest, type WorkspaceManifest } from './review-policy.js';
import {
  acquireClaim,
  releaseClaim,
  newBootstrap,
  productionInspector,
} from './recovery.js';

// A supervisor owns its job for the whole runtime, so its claim lease is long.
// Stale-supervisor displacement is decided ONLY on verified death, never on
// expiry, so this value is metadata (see recovery.ts claimBlocksAcquisition).
const SUPERVISOR_CLAIM_LEASE_MS = 8 * 60 * 60 * 1000;

// Test-only export: the pure command builder for a job, used by the scheduler
// integration tests to pin the reply-mode -> CLI flag contract (resume_session
// and legacy undefined => --resume; fresh_turn => --session-id).
export { buildCommand };

// Owner identity of the supervisor claim THIS process holds (Stage 6). Tracked
// at module scope so every exit path — close, spawn error, uncaught exception,
// fatal catch — can release exactly our own claim.
let supervisorClaimOwnerId: string | null = null;

// ---------------------------------------------------------------------------
// Wave 4B2b3 supervisor-side admission lease lifecycle.
//
// Active ONLY when the admission flag is on AND the job record was admitted
// (admissionState === 'active' — the scheduler's pump persists that before it
// ever spawns this supervisor). When inactive, the whole block below is inert
// and the legacy flow is byte-for-byte unchanged.
//
// Lifecycle, in run(): after the supervisor claim wins and BEFORE
// prepareBudget / settings write / worker spawn —
//   1. capture our own pid identity (pid + OS creation time);
//   2. waitForOwnership(5000, 50) — the scheduler already transferred the
//      lease to this pid in the same pump that spawned us;
//   3. startHeartbeat(20000) and register ONE process.once('exit') cleanup
//      that stops the heartbeat and hands the lease back (owner-checked
//      release, archived under admission/released/, never deleted).
// A failed identity capture or a failed ownership wait is a HARD failure: the
// job is finalized failed with the fixed substatus, the lease is released
// (best effort), the claim is released, and the supervisor exits WITHOUT
// ever spawning a worker.
//
// SIGKILL / OS-level kill: no JS runs, so the exit cleanup never fires. The
// lease stays under admission/leases/ with this pid's identity and its TTL;
// AdmissionManager's stale sweep archives it (PID-dead or TTL-expired) into
// admission/stale/, and the scheduler's count refresh never resurrects a
// released slot — the job is already terminal at that point, so no double
// spawn is possible.
// ---------------------------------------------------------------------------

// The admission lease lifecycle of the job THIS process owns; null while the
// feature is inactive or before construction.
let admissionLease: AdmissionSupervisorLease | null = null;

/** Wave 4B2b3 gate: the lease lifecycle runs only under the admission flag
 *  and only for a job the scheduler already admitted. */
function admissionLeaseActive(job: Job): boolean {
  return admissionControlEnabled() && job.admissionState === 'active';
}

/** Release our admission lease + drop the admissionState (idempotent). The
 *  lifecycle's release is synchronous before its promise resolves, so this
 *  may be called from a synchronous exit handler. Never touches a lease we
 *  do not own; a failed ownership wait has nothing to release. */
function releaseAdmissionLease(jobId: string): void {
  if (admissionLease === null) return;
  try {
    void admissionLease.stopAndRelease();
  } catch {
    /* best effort — the scheduler count refresh treats a dead slot as free */
  }
  admissionLease = null;
  try {
    updateJobIf(
      jobId,
      // Terminal succeeded/failed are fine — the patch only drops the
      // admission bookkeeping, it never rewrites status/substatus/endedAt.
      // Cancelled is excluded: the scheduler owns the cancel outcome and
      // may still be re-reading the record; we must not touch it.
      (j) => j.status !== 'cancelled',
      { admissionState: 'released', activeWorkers: 0 },
    );
  } catch {
    /* best effort — a concurrent terminal write is never overwritten */
  }
}

// ---------------------------------------------------------------------------
// T2C2b per-job metrics integration (single-file, supervisor-owned).
//
// Active ONLY when ORCHESTRATOR_METRICS_V2==='1'; when the flag is off every
// path below is inert (collector null, no job writes, no behavior change).
// Metrics are accumulated in memory for the job's whole runtime and persisted
// via updateJob({ metrics }) at most once per 5s (force=true on terminal
// paths). The collector produces flat, sanitized aggregates only — the raw
// stream-json lines are passed through observeStreamJsonLine and never
// persisted; no paths/prompts/commands leave this file.
// ---------------------------------------------------------------------------

// Feature gate: hard-coded env switch, decided once per supervisor run.
function metricsV2Enabled(job: Job): boolean {
  return process.env.ORCHESTRATOR_METRICS_V2 === '1';
}

// Initial counters for a flag-on job. The scheduler does not persist metrics
// at start, so the record's own prompt is the source of promptChars; any
// scheduler-reserved metrics (e.g. a reply chained on a resumed job) are kept
// and win over the defaults.
function metricsInitial(job: Job): Partial<JobMetricsV2> | undefined {
  return { ...createJobMetrics(), promptChars: job.prompt.length, ...(job.metrics ?? {}) };
}

// The collector for the job this supervisor owns; null while the flag is off.
let jobMetrics: JobMetricsCollector | null = null;
let metricsLastPersistedMs = 0;
const METRICS_PERSIST_INTERVAL_MS = 5000;

// Atomic save of a safe copy (collector.toCompactMetrics) onto the job record.
// Never throws, so metrics can never change job status.
function persistMetrics(force = false): void {
  if (!jobMetrics) return;
  try {
    const now = Date.now();
    if (!force && now - metricsLastPersistedMs < METRICS_PERSIST_INTERVAL_MS) return;
    metricsLastPersistedMs = now;
    // Wave 4B2b3: the exit handler (admissionState drop) runs after this and
    // is guarded to never touch a cancelled record — safe to land metrics on
    // a terminal job, so the terminal record carries the complete aggregates.
    updateJob(ownedJobId as string, { metrics: jobMetrics.toCompactMetrics() });
  } catch {
    /* best effort: metrics must never affect job status */
  }
}

// Release our supervisor claim, but ONLY once the job is already terminal /
// cancelled. Releasing while the job is still live would let a concurrent
// recoverer steal a fresh claim and spawn a second supervisor (double worker).
// A dead-owner claim left behind is inert (recovery only displaces claims whose
// owner is verified dead), so skipping the release is always safe.
function releaseSupervisorClaim(jobId: string): void {
  if (!supervisorClaimOwnerId) return;
  const cur = readJob(jobId);
  if (cur && !isTerminal(cur.status) && cur.status !== 'cancelled') return;
  const id = supervisorClaimOwnerId;
  supervisorClaimOwnerId = null;
  try {
    releaseClaim(jobId, 'supervisor', id);
  } catch {
    /* best effort; a dead-owner claim is inert */
  }
}

/** Wave 4B2b3: hard admission failure — the job is finalized failed with the
 *  fixed substatus (never a queued-like state), the lease is released
 *  (best-effort owner-checked archive) and the supervisor claim is released.
 *  No worker is ever spawned on this path. */
function writeAdmissionFailed(jobId: string, substatus: string): void {
  try {
    releaseAdmissionLease(jobId);
    updateJobIf(
      jobId,
      (j) => j.status !== 'cancelled',
      {
        status: 'failed',
        substatus,
        endedAt: nowIso(),
        exitCode: null,
        admissionState: 'released',
        activeWorkers: 0,
        queuedWorkers: 0,
        resourceLimit: null,
      },
    );
    const final = readJob(jobId);
    if (final) writeDone(jobId, final.status, final);
    releaseSupervisorClaim(jobId);
  } catch {
    /* best effort — a concurrent terminal write is never overwritten */
  }
}

// ---------------------------------------------------------------------------
// Zombie-supervisor guard (real-world case fe7e49fc): a supervisor that dies
// without finalizing leaves its job stuck in `running` forever. Every exit
// path below (worker close/error, signals, stdin EOF, uncaught exception,
// fatal rejection, process 'exit') funnels through finalizeInterrupted /
// the last-resort exit hook so a .done marker is ALWAYS written once this
// supervisor has taken ownership of the job.
// ---------------------------------------------------------------------------

// Job this supervisor owns, set only AFTER the ack succeeds and we are about to
// spawn the worker. The last-resort hooks never touch a job we do not own.
let ownedJobId: string | null = null;
let activeWorkerChild: ChildProcess | null = null;

// Parent-death signal: with stdio ignored the child's stdin is an empty pipe,
// so it reads EOF immediately; the flag alone therefore proves nothing — it
// only matters combined with a worker that has exited without a finalize.
let parentStdinClosed = false;

/**
 * Finalize the job as failed/interrupted (idempotent): guarded status write,
 * .done marker, claim release. Safe to call from any exit path.
 */
function finalizeInterrupted(jobId: string, reason: string): void {
  try {
    const cur = readJob(jobId);
    if (!cur) return;
    if (!isTerminal(cur.status) && cur.status !== 'cancelled') {
      appendStderrLog(jobId, `\n===== supervisor interrupted (${reason}) =====\n`);
      updateJobIf(
        jobId,
        (j) => !isTerminal(j.status) && j.status !== 'cancelled',
        { status: 'failed', substatus: reason, endedAt: nowIso(), exitCode: null },
      );
      const final = readJob(jobId) ?? cur;
      writeDone(jobId, final.status, final);
    } else if (!fs.existsSync(doneFilePath(jobId))) {
      // Terminal already (another writer won); still guarantee the marker.
      const latest = readJob(jobId) ?? cur;
      writeDone(jobId, latest.status, latest);
    }
    releaseSupervisorClaim(jobId);
  } catch {
    /* nothing else to do on this path */
  }
}

// Signals: kill our worker tree, finalize as interrupted, exit non-zero.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]) {
  process.on(sig, () => {
    if (ownedJobId) {
      try {
        if (activeWorkerChild?.pid) killTree(activeWorkerChild.pid);
      } catch {
        /* best effort */
      }
      finalizeInterrupted(ownedJobId, `interrupted (${sig})`);
    }
    process.exit(1);
  });
}

process.on('exit', () => {
  // Last-resort backstop: runs on EVERY normal/errored exit of this process.
  // Normal paths already wrote .done before exiting, so this usually no-ops;
  // it exists for paths that die between worker spawn and finalize.
  if (!ownedJobId) return;
  try {
    const jobId = ownedJobId;
    const cur = readJob(jobId);
    if (
      cur &&
      cur.status !== 'cancelled' &&
      !fs.existsSync(doneFilePath(jobId))
    ) {
      atomicWriteJson(doneFilePath(jobId), {
        jobId,
        status: 'failed',
        endedAt: nowIso(),
        exitCode: cur.exitCode,
      });
      appendStderrLog(jobId, `\n===== supervisor exited without finalize; wrote last-resort done marker =====\n`);
    }
  } catch {
    /* best effort */
  }
});

// Wave 4B2b3: ONE exit cleanup for the admission lease. Every normal
// process.exit() path runs this, so the lease is handed back (owner-checked
// release -> admission/released/) and the job's admissionState is dropped to
// 'released' exactly once, idempotently, without ever touching a terminal
// status or anyone else's lease. An exit handler cannot await; the lifecycle
// performs its release synchronously before the returned promise resolves,
// so the fire-and-forget call is safe. A hard kill (SIGKILL) runs no JS — the
// stale sweep archives the lease by PID identity / TTL instead (see above).
process.once('exit', () => {
  if (admissionLease === null) return;
  const jobId = ownedJobId ?? '';
  if (jobId === '') return;
  releaseAdmissionLease(jobId);
});

function parseArgs(): { jobId: string } {  const args = process.argv.slice(2);
  const i = args.indexOf('--job');
  if (i < 0 || !args[i + 1]) {
    process.stderr.write('usage: supervisor --job <jobId>\n');
    process.exit(2);
  }
  return { jobId: args[i + 1] };
}

const nowIso = () => new Date().toISOString();

// Worker 白名单唯一来源:读取 ~/.claude/worker-whitelist.json 的 permissions。
// 该文件是"统一白名单"的单一事实来源(手动窗/桌面程序/orchestrator worker 共用)。
// 历史(2026-08-16 受控验证):--settings 的 permissions.allow 对 worker 生效——
// 放行 git 时 0 条 sonnet 安全分类器请求,不放行时 1 条。但分类器已于 2026-08-26
// 用户决策废除(auto 档 = bypassPermissions),那条"不放行就交分类器判定"的兜底
// 链路不复存在:现在 allow 只决定"要不要弹审批"(默认档位无人审批 = 直接放行),
// 唯一真正生效的策略层是 deny(内置基线 ∪ 文件规则,见 resolveWorkerDeny)。
const WORKER_WHITELIST_PATH = () => whitelistPath();

// A missing or malformed whitelist used to degrade silently to an EMPTY allow
// list, so every worker tool call fell through to the approval classifier and
// the job looked hung. The allow fallback is now a conservative list.
//
// This stderr banner is NOT the visibility channel: the supervisor is spawned
// detached with stdio ignored (scheduler.spawnSupervisor), so nobody reads its
// stderr in production. It is kept only for the manual `npm run supervisor`
// path. The real channels are, in order of who sees them:
//   1. the scheduler's startJob()/replyJob() warnings[] -> the MCP tool response;
//   2. a "worker policy fallback" banner in the job's own stderr log
//      (writeJobSettings below) -> runtime/logs/<jobId>.stderr.log;
//   3. claude_code_health's notes when neither is looked at.
let warnedMissingWhitelist = false;
function warnWhitelistFallback(reason: string): void {
  if (warnedMissingWhitelist) return;
  warnedMissingWhitelist = true;
  const target = WORKER_WHITELIST_PATH() || '(no home directory)';
  process.stderr.write(
    `[orchestrator] worker whitelist unusable (${reason}): ${target}\n` +
      `[orchestrator] falling back to the built-in policy — allow: ${DEFAULT_WORKER_ALLOW.join(', ')}\n` +
      `[orchestrator] deny: the built-in default deny list (see config.DEFAULT_WORKER_DENY).\n` +
      `[orchestrator] set ORCHESTRATOR_WHITELIST_PATH to point at your own whitelist file.\n`
  );
}

function readUserPermissionsAllow(): string[] {
  const whitelist = readWorkerWhitelist();
  const fileAllow = whitelist.permissions?.allow;
  if (Array.isArray(fileAllow)) {
    return fileAllow.filter((r): r is string => typeof r === 'string' && !!r);
  }
  warnWhitelistFallback(whitelist.detail);
  return [...DEFAULT_WORKER_ALLOW];
}

// 读取统一白名单文件完整 permissions 对象(allow+deny+additionalDirectories 等),
// 供 worker jobfile 继承。worker 不再读 settings.local.json —— 单一事实来源。
// (The read itself lives in config.readWorkerWhitelist so that the supervisor,
// the scheduler warning and claude_code_health can never disagree about whether
// the file was usable; see writeJobSettings for the deny fallback it feeds.)

// worker 允许列表:统一白名单源文件 + 少量 worker 专属增补,去重保序。
function workerAllowList(): string[] {
  return readUserPermissionsAllow();
}

// 思考强度分层（2026-08-29 健康检查落地）：DeepSeek 链路 effort 档位为
// low/high/max 三档。执行类（实现/修复/测试，含 research 取证）用 high——
// max 在 flash 上思考链过长、延迟与输出 token 显著放大且收益边际递减；
// analysis（诊断/取证报告）保留 max，此类任务轮次少、质量敏感。
function effortForJob(job: Job): string {
  return job.taskType === 'analysis' ? 'max' : 'high';
}

// ---------------------------------------------------------------------------
// T2C2 budget enforcement (single-file integration, supervisor-owned).
//
// Active ONLY when ORCHESTRATOR_BUDGET_ENFORCEMENT==='1' AND the job carries a
// v2 contract. When the flag is off every path below keeps its exact legacy
// behavior: no budget files are created, no hook is injected, the .txt report
// is written as before. The budget hook itself (budget-hook.ts) is NOT edited
// here — the supervisor only wires it via the PreToolUse hook.
// ---------------------------------------------------------------------------

// Feature gate: hard-coded env switch, decided once per supervisor run. The
// scheduler mirrors the same env, so a mismatch (flag off now, on at start)
// simply skips budget wiring for this supervisor.
function budgetEnforcementEnabled(job: Job): boolean {
  return process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT === '1' && job.contract !== undefined;
}

// startedAtMs for the budget config: Date.parse(job.startedAt) when that is a
// valid timestamp, else Date.now(). ISO strings without timezone info parse as
// local time in Node — still a valid number, so this falls back only on
// genuinely unparseable timestamps.
function budgetStartedAtMs(job: Job): number {
  const parsed = Date.parse(job.startedAt);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

// Skeleton file paths, next to the per-job settings file (settingsDir()).
function budgetConfigFilePath(jobId: string): string {
  return path.join(path.dirname(settingsFilePath(jobId)), `${jobId}.budget-config.json`);
}
function budgetStateFilePath(jobId: string): string {
  return path.join(path.dirname(settingsFilePath(jobId)), `${jobId}.budget-state.json`);
}

// Contract report targets: only a strictly-valid absolute deliverablePath
// inside workFolder is a report target. Any other value (relative, outside the
// workspace, empty) yields an EMPTY target list — never a crash. The public
// budget mirror (job-store) already guarantees this invariant, but the check
// is repeated here because the supervisor is the write owner of the config.
function budgetReportTargets(job: Job): string[] {
  const target = job.contract?.reporting?.deliverablePath;
  if (typeof target !== 'string' || target.length === 0) return [];
  const abs = path.isAbsolute(target) ? target : path.resolve(job.workFolder, target);
  if (!abs.startsWith(job.workFolder + path.sep)) return [];
  return [abs];
}

/**
 * Prepare budget enforcement for a job that is about to spawn its worker
 * (claim acquired, settings not yet written):
 *   1. write the evidence-report-v1 skeleton (reportFilePath) and record
 *      reportCompleteness='skeleton', budgetStatus='active';
 *   2. atomically create <jobId>.budget-config.json and
 *      <jobId>.budget-state.json in the settings dir;
 *   3. persist the internal budgetConfigPath/budgetStatePath on the job.
 * Strictly write-once (a retried supervisor must not clobber a live budget
 * that a previous run already started). Never writes prompt/env/raw log
 * content — the skeleton is fixed placeholder text and the state stores only
 * timestamps and counters.
 */
function prepareBudget(job: Job): void {
  const budgetEnabled = budgetEnforcementEnabled(job);
  if (!budgetEnabled) return;
  const budgetConfigPath = budgetConfigFilePath(job.jobId);
  const budgetStatePath = budgetStateFilePath(job.jobId);
  if (fs.existsSync(budgetStatePath)) return; // already prepared by a prior run
  const startedAtMs = budgetStartedAtMs(job);
  const config = {
    jobId: job.jobId,
    workFolder: job.workFolder,
    startedAtMs,
    budget: job.contract!.budget,
    reportTargets: budgetReportTargets(job),
  };
  atomicWriteJson(budgetConfigPath, config);
  const state: BudgetHookState = {
    schemaVersion: 1,
    jobId: job.jobId,
    budgetState: createBudgetState(startedAtMs),
    reportWrites: 0,
  };
  atomicWriteJson(budgetStatePath, state);
  // T2C2b: the report skeleton is written once per job — record the
  // first-report latch (queue-relative via the collector).
  jobMetrics?.markFirstReportWrite(Date.now());
  fs.writeFileSync(reportFilePath(job.jobId), buildEvidenceReportSkeleton(job.jobId, new Date(startedAtMs).toISOString()), 'utf8');
  updateJob(job.jobId, {
    reportCompleteness: 'skeleton',
    budgetStatus: 'active',
    budgetConfigPath,
    budgetStatePath,
  });
}

// Read the budget state file; null on any read/parse/shape failure. The hook
// writes strictly-valid states only, but a torn read or an external edit must
// fail closed, never crash. Falls back to the deterministic path when the
// caller's job snapshot predates prepareBudget (which persists the path).
function readBudgetState(job: Job): BudgetState | null {
  const statePath = job.budgetStatePath ?? budgetStateFilePath(job.jobId);
  if (!statePath || !fs.existsSync(statePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (o.schemaVersion !== 1) return null;
    if (typeof o.jobId !== 'string' || o.jobId !== job.jobId) return null;
    const b = o.budgetState as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') return null;
    if (b.mode !== 'active' && b.mode !== 'report_only' && b.mode !== 'failed') return null;
    if (typeof b.startedAtMs !== 'number' || !Number.isFinite(b.startedAtMs)) return null;
    if (b.violationCode !== undefined && typeof b.violationCode !== 'string') return null;
    return b as unknown as BudgetState;
  } catch {
    return null;
  }
}

// Bounded sanitized tail for the evidence report body (replaces the raw
// finalText when the worker produced none). Never prompt/env/raw log content:
// renderedTail renders stream-json events into short display lines only.
function budgetReportBody(job: Job, finalText: string): string {
  return finalText.length > 0 ? finalText : renderedTail(job.jobId, { lines: 10, maxChars: 2000 });
}

// ---------------------------------------------------------------------------
// Per-job settings file. ANTHROPIC_BASE_URL here is authoritative: we proved
// (2026-08-11) that a --settings env block overrides the user's
// ~/.claude/settings.json env block. This is what makes routing real.
// ---------------------------------------------------------------------------
function writeJobSettings(job: Job): void {
  const env: Record<string, string> = {
    CLAUDE_CODE_EFFORT_LEVEL: effortForJob(job),
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    ENABLE_TOOL_SEARCH: 'true',
    // Auto-mode 分类器 fail-open 兜底（2026-08-24）：上游 429/502 风暴时，
    // 分类器与主链共用同一代理一起不可用。CLI 对 unavailable 的默认处理是
    // fail-closed（deny + retry guidance），worker 会陷入"分类器暂时阻塞，
    // 稍等重试"的空转直到主链也死。显式注入 allow：分类器不可用/解析失败
    // 一律放行（用户 2026-08-23 决定保留该语义），真正的高危动作仍由白名单
    // deny 列表与审批升级兜住。CLI 没有 ON_TIMEOUT 分支——超时归入
    // unavailable，此变量一并覆盖。写在 per-job settings 里，
    // 全局 settings.json 也抹不掉。
    CLAUDE_CODE_AUTO_MODE_ON_UNAVAILABLE: 'allow',
    CLAUDE_CODE_AUTO_MODE_ON_PARSE_FAIL: 'allow',
  };
  // Endpoint and model mapping are environment-driven (see config.ts). Unset
  // means "inject nothing": a fresh install then inherits the Claude CLI's own
  // credentials and model defaults. Setting ORCHESTRATOR_ANTHROPIC_BASE_URL=local
  // restores the historical local-proxy routing.
  const route = anthropicRoute(job.port);
  if (route.baseUrl) env.ANTHROPIC_BASE_URL = route.baseUrl;
  if (route.authToken) env.ANTHROPIC_AUTH_TOKEN = route.authToken;
  for (const kind of ['HAIKU', 'SONNET', 'OPUS'] as const) {
    const m = modelOverride(kind);
    if (m.model) env[`ANTHROPIC_DEFAULT_${kind}_MODEL`] = m.model;
    if (m.alias) env[`ANTHROPIC_DEFAULT_${kind}_MODEL_NAME`] = m.alias;
  }
  // 继承统一白名单文件(worker-whitelist.json)的 permissions(deny 等其它键保留),
  // allow 用该文件的 allow 列表。--settings 会替换权限层,不带 permissions 时
  // worker 每步工具调用都过安全分类器,疯狂消耗上游额度。
  //
  // F1 (security): the file may not exist at all — that is the state of every
  // fresh clone. In the default `auto` profile the worker runs under
  // --permission-mode bypassPermissions, where `allow` only suppresses prompts:
  // the deny list IS the whole policy. A payload with an allow list and no deny
  // list therefore meant "no policy", silently. `deny` is now always non-empty:
  // the built-in default floor (config.DEFAULT_WORKER_DENY) UNIONED with the
  // file's own rules — a whitelist file can add prohibitions but never lower the
  // floor, so a fresh clone, a copy-pasted template and a tampered file all end
  // up at least as strict as the floor. The worker's permission MODE is
  // deliberately untouched — degrading `auto` to `default` would turn every
  // unattended job into a needs_attention hang, which is exactly what the
  // profile exists to avoid.
  const whitelist = readWorkerWhitelist();
  const basePermissions = whitelist.permissions;
  let allow = workerAllowList();
  // review 档(只读分析)增补:显式放行纯读工具,杜绝 plan 模式下逐 Read 卡
  // attention 的死循环(2026-08-23 审计:多个审查任务因此被 cancel)。写操作与
  // 外发不在增补范围,deny 列表与分类器兜底不变。
  if (job.profile === 'review') {
    const readOnlyTools = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'NotebookRead', 'TodoWrite'];
    allow = [...allow];
    for (const tool of readOnlyTools) {
      if (!allow.includes(tool)) allow.push(tool);
    }
    // 单一交付物写入例外（2026-08-23）：review 档 + research/analysis +
    // deliverablePath 的任务由调度器降为 default 模式（plan 会把唯一必需的
    // 报告写盘卡死）。这里只放行报告文件本身的 Write/Edit；其余任何写操作
    // 不在白名单，仍走 needs_attention 升级，绝不静默扩大权限。
    if (job.artifactWriteException && typeof job.deliverablePath === 'string' && job.deliverablePath.length > 0) {
      const norm = job.deliverablePath.replace(/\\/g, '/');
      for (const rule of [`Write(${norm})`, `Edit(${norm})`, `MultiEdit(${norm})`]) {
        if (!allow.includes(rule)) allow.push(rule);
      }
    }
  }
  const denyResolution = resolveWorkerDeny(basePermissions?.deny);
  const payload: Record<string, unknown> = { env };
  // Unconditional: `allow` may legitimately be empty (an explicitly empty allow
  // list in the user's file), but `deny` never may be. The deny list is the
  // built-in floor UNION the file's own rules — a config file may add
  // prohibitions, never drop the floor's.
  payload.permissions = { ...(basePermissions || {}), allow, deny: denyResolution.deny };
  // F1 visibility: the caller cannot read this process's stderr (detached,
  // stdio ignored), so the substitution is recorded in the JOB's own stderr log,
  // which claude_code_status/list point at and retention keeps. One line per
  // job, and only when something was actually substituted or added.
  if (whitelist.problem !== 'ok' || denyResolution.source === 'floor') {
    const fallbacks: string[] = [];
    if (denyResolution.source === 'floor') {
      fallbacks.push(`deny = built-in default list (${denyResolution.deny.length} rules)`);
    } else if (denyResolution.addedByFloor.length > 0) {
      fallbacks.push(
        `deny = your ${denyResolution.addedByFile.length} rule(s) + ${denyResolution.addedByFloor.length} built-in baseline rule(s) the file did not carry ` +
          `(${denyResolution.deny.length} total)`,
      );
    }
    if (!Array.isArray(basePermissions?.allow)) {
      fallbacks.push(`allow = built-in conservative list (${DEFAULT_WORKER_ALLOW.length} rules)`);
    }
    const where = whitelist.path ? ` at ${whitelist.path}` : '';
    appendStderrLog(
      job.jobId,
      `\n===== supervisor: worker policy fallback — ${whitelist.detail}${where}; ` +
        `${fallbacks.length > 0 ? fallbacks.join('; ') : 'permissions inherited from the whitelist file'}. ` +
        `Create the whitelist file (or set ORCHESTRATOR_WHITELIST_PATH) to use your own policy. =====\n`
    );
  }
  // 与交互窗共用 read-guard hook(大文件读入即警告,注入模型上下文)。worker 的
  // claude 不读 settings.local.json, 必须在这里显式带上 hooks,否则 worker 大文件
  // 全量读会静默烧缓存前缀。
  //
  // Portability: this hook used to be injected from a hard-coded personal path
  // with no existence check, so every Read on a fresh machine produced a failing
  // hook. It is optional now — disabled, missing or unset means "not injected".
  const readGuard = readGuardHookPath();
  const hooks: Record<string, unknown> = {};
  if (readGuard) {
    hooks.PostToolUse = [
      {
        matcher: 'Read',
        hooks: [
          {
            type: 'command',
            command: `node "${readGuard}"`,
            timeout: 5,
            statusMessage: 'checking read size',
          },
        ],
      },
    ];
  }
  // T2C2: budget PreToolUse hook. Injected whenever enforcement is on — the
  // file paths are the deterministic ones derived from the jobId (the
  // in-memory job snapshot may predate prepareBudget's persist of the paths,
  // so the old-memory fields are never used as a gate here). The read-guard
  // PostToolUse hook above is never replaced. The command quotes the node
  // path and both budget file paths exactly; the hook itself fails closed on
  // anything it cannot parse (missing/corrupt config/state are safe).
  if (budgetEnforcementEnabled(job)) {
    const budgetHookEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'budget-hook.js');
    // Deterministic fallback: <jobId>.budget-config.json / <jobId>.budget-state.json
    // in the settings dir. Both files always exist together (prepareBudget
    // writes them atomically in order).
    const configPath = job.budgetConfigPath ?? budgetConfigFilePath(job.jobId);
    const statePath = job.budgetStatePath ?? budgetStateFilePath(job.jobId);
    hooks.PreToolUse = [
      {
        matcher: '.*',
        hooks: [
          {
            type: 'command',
            command: `node "${budgetHookEntry}" --config "${configPath}" --state "${statePath}"`,
            timeout: 5,
            statusMessage: 'checking job budget',
          },
        ],
      },
    ];
  }
  if (Object.keys(hooks).length > 0) payload.hooks = hooks;
  atomicWriteJson(settingsFilePath(job.jobId), payload);
}

// Advanced override: an executable inserted before the claude command (e.g.
// CLAUDE_CLI_PREFIX="C:\Program Files\nodejs\node.exe"). Used by tests to run
// the fake claude; also useful when wrapping the CLI. Treated as a single
// token (a path may contain spaces).
function envPrefix(): string[] {
  const p = process.env.CLAUDE_CLI_PREFIX;
  if (!p) return [];
  return [p];
}

function buildCommand(job: Job): { cmd: string; args: string[] } {
  if (job.workerBackend === 'deepseek-harness') {
    const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'deepseek-worker.js');
    return { cmd: process.execPath, args: [entry, '--job', job.jobId] };
  }
  const claude = job.claudeCli || defaultClaudeCli();
  const prefix = [...(job.claudePrefix || []), ...envPrefix()];
  const args: string[] = [];
  args.push('-p');
  // Wave 3B: reply execution semantics are chosen by the persisted replyMode.
  //   replyMode === 'resume_session'  -> --resume <parent session id> (a real
  //     continuation of the parent Claude session; the scheduler only grants
  //     this mode when the flag-on preflight allowed a transcript resume).
  //   replyMode === 'fresh_turn'      -> --session-id <NEW session id>: a fresh
  //     bounded turn in its own session, NEVER a parent-session continuation
  //     (the scheduler already issued a new session id for it).
  //   replyMode === undefined (legacy) -> --resume <sessionId>. The preflight
  //     flag is off (or predates the flag): the flag-off path keeps its exact
  //     legacy behavior byte-for-byte, so the old resume flow must be retained —
  //     a legacy reply without replyMode is still a session continuation.
  //   non-reply jobs -> --session-id <sessionId> (unchanged historical form).
  const resumeSession = job.kind === 'reply' && job.replyMode !== 'fresh_turn';
  if (resumeSession) args.push('--resume', job.sessionId);
  else args.push('--session-id', job.sessionId);
  args.push(
    '--permission-mode',
    job.permissionMode,
    '--effort',
    effortForJob(job),
    '--output-format',
    'stream-json',
    '--verbose',
    // Worker 与交互窗共用 128k 自动压缩。CLI 参数优先级高于 settings 合并,
    // 保证 worker 超阈值必然 auto-compact(而非依赖用户配置继承),防止长链路
    // worker 常驻 >128k 全量 miss 高发区烧额度。数值与交互窗阈值一致。
    '--autocompact=128000',
    '--settings',
    settingsFilePath(job.jobId),
    // NOTE: use the equals form for array-style options. The space-separated
    // form (--add-dir <dir>) greedily consumes the trailing prompt positional
    // and claude then errors "Input must be provided ... as a prompt argument".
    `--add-dir=${job.workFolder}`,
  );
  if (job.profile === 'review') {
    args.push('--disallowedTools=Edit,Write,NotebookEdit');
  }
  // Worker-side MCP config is optional now. It used to be a hard-coded personal
  // file, injected with --strict-mcp-config, so a fresh clone spawned servers
  // that do not exist on the user's machine. Absent -> inject nothing and let
  // the worker keep its own MCP configuration.
  const hermetic = hermeticMcpConfig();
  if (hermetic) {
    args.push('--mcp-config', hermetic, '--strict-mcp-config');
  }
  // --allowedTools 直接传给 CLI(必须用等号形式,空格形式会贪婪吃掉 prompt)。
  // settings 的 permissions 已验证生效(2026-08-16 受控测试),这里是双保险:
  // 即使 jobfile 有损坏,--allowedTools 仍保证放行规则不触发审批弹窗
  // (分类器已于 2026-08-26 废除,这里防的是弹窗而不是分类请求)。
  // 无法识别的规则被 CLI 忽略并只在 stderr 告警,不会崩溃。
  for (const rule of workerAllowList()) {
    args.push('--allowedTools=' + rule);
  }
  args.push(job.prompt);
  // Full argv: [prefix..., claude, standard args...]. For real jobs the prefix
  // is empty, so argv[0] is the claude CLI itself.
  const argv = [...prefix, claude, ...args];
  return { cmd: argv[0], args: argv.slice(1) };
}

// ---------------------------------------------------------------------------
// F3: worker environment / credential hygiene.
//
// The worker used to inherit the orchestrator's ENTIRE environment, and that
// environment is exactly where an operator puts the gateway credential (e.g.
// `ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN` in the MCP server's env block). Nothing
// else had to go wrong for that secret to escape: one `env` invocation by a
// worker whose prompt contained an injected instruction prints it into the job
// log, and job logs are written to disk under runtime/logs — readable by every
// later job, and routinely pasted into issues.
//
// Stripping the inherited copy costs nothing functionally: the resolved routing
// is handed to the CLI through the per-job `--settings` env block (proven
// 2026-08-11: a settings env block overrides the user's settings.json), so
// authentication keeps working while the secret is no longer part of the
// worker's ambient environment.
// ---------------------------------------------------------------------------

/** Secret-shaped environment key names (case-insensitive). */
const SENSITIVE_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)/i;

/**
 * The Claude CLI's own authentication contract. These keys MUST keep reaching
 * the worker: with the endpoint unset (the portability default) the CLI
 * authenticates from its own login or from these variables, and stripping them
 * would break the worker entirely. The worker's own API credential is therefore
 * visible to the worker by design — that part of F3 cannot be closed without
 * breaking auth; everything ELSE secret-shaped is removed.
 */
const WORKER_ENV_KEEP = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/** `scheme://user:password@host` — a credential embedded in a URL value. */
const URL_WITH_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]+:[^/@\s]*@/i;

/**
 * Pure: the exact environment handed to the worker process (claude CLI or the
 * deepseek-harness adapter — the adapter's own child inherits from it).
 *
 * `extra` is merged LAST and verbatim: `job.extraEnv` is an explicit per-job
 * instruction from the caller (the test seam and deliberate overrides), never
 * an inherited secret, so an explicit value always wins.
 */
export function workerEnv(
  base: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (WORKER_ENV_KEEP.has(upper)) {
      out[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_KEY.test(key)) continue;
    // Our own configuration surface: an endpoint that carries embedded
    // credentials is itself a secret, and the worker still receives the
    // resolved value through --settings when it actually needs it.
    if (upper.startsWith('ORCHESTRATOR_') && URL_WITH_CREDENTIALS.test(value)) continue;
    out[key] = value;
  }
  return { ...out, ...(extra || {}) };
}

function writeDone(jobId: string, status: JobStatus, job: Job): void {
  const done = {
    jobId,
    status,
    endedAt: job.endedAt ?? nowIso(),
    exitCode: job.exitCode,
  };
  atomicWriteJson(doneFilePath(jobId), done);
}

// T1E-E2A: run the job's acceptance commands to completion and persist the full
// internal GateResult[] on the job record (the public view sanitizes at read
// time via toGateSummary). Returns the persisted job, or null when a concurrent
// writer (cancel / recovery) reached a terminal/cancelled state before the
// write could land — the caller honors the winner. Fail-closed: a runner
// exception (never expected for individual gate failures — those are structured
// results) yields acceptanceStatus 'blocked' and a safe, sanitized substatus
// naming ONLY the runner failure, with no message content.
async function runAndPersistAcceptance(
  jobId: string,
  acceptance: AcceptanceCommandSpec[],
  workFolder: string,
): Promise<Job | null> {
  try {
    const summary = await runAcceptanceCommands(acceptance, { workFolder });
    return updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
      acceptanceStatus: summary.acceptanceStatus,
      gateResults: Object.values(summary.gates),
    });
  } catch (err) {
    // Fail closed: the gate runner itself threw. The substatus names ONLY the
    // runner failure class, never the error message (which may embed runner
    // internals); the worker-side failureDetail, if any, stays untouched.
    const errName =
      err instanceof Error && err.name && err.name.length > 0 && err.name.length <= 64 ? err.name : 'Error';
    return updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
      acceptanceStatus: 'blocked',
      gateResults: [],
      substatus: 'acceptance_runner_error',
      failureDetail: `acceptance runner error (${errName})`,
    });
  }
}

// ---------------------------------------------------------------------------
// T1E-E2B review-write-policy manifest audit.
//
// A read_only_report contract permits the worker exactly ONE write: the
// contract's own deliverable. Any other added/changed/removed file in the
// workspace is a review violation. The audit runs after the worker terminates
// and before any acceptance command, and folds its outcome into the same
// write order as the acceptance gate (workerStatus -> review gate -> terminal).
// ---------------------------------------------------------------------------

/** Counts and up to 5 relative paths per bucket, total ≤ 1000 chars. */
function reviewViolationSummary(diff: ManifestDiff): string {
  const buckets: Array<[string, string[]]> = [
    ['added', diff.added],
    ['changed', diff.changed],
    ['removed', diff.removed],
  ];
  const parts: string[] = [];
  for (const [label, keys] of buckets) {
    if (keys.length === 0) continue;
    const paths = keys.slice(0, 5).map((k) => k.replace(/\\/g, '/'));
    parts.push(`${label}: ${keys.length}${keys.length > 5 ? ` (first ${paths.length}: ${paths.join(', ')})` : `: ${paths.join(', ')}`}`);
  }
  const text = `review write violation: ${parts.join('; ')}`;
  return text.length > 1000 ? text.slice(0, 1000) : text;
}

/** One synthetic review gate, with the audit duration as its runtime. */
function reviewGateResult(kind: 'violation' | 'manifest_error', durationMs: number, summary: string): GateResult {
  const startedAt = new Date().toISOString();
  const endedAt = new Date().toISOString();
  return {
    id: 'review-write-policy',
    required: true,
    startedAt,
    endedAt,
    durationMs,
    exitCode: null,
    timedOut: false,
    prevented: false,
    error: 1,
    errorCode: kind === 'violation' ? 'ERR_REVIEW_WRITE_VIOLATION' : 'ERR_REVIEW_MANIFEST',
    stdoutSummary: '',
    stderrSummary: summary,
    stdoutPreview: '',
    stderrPreview: '',
  };
}

/**
 * Run the T1E-E2B workspace audit for a read_only_report contract: capture the
 * after-manifest, diff against the before-manifest (with the contract
 * deliverable as the single legitimate write), and return the synthetic gate
 * result plus the decision. Never throws — any capture/diff failure fails
 * closed (acceptanceStatus 'blocked', ERR_REVIEW_MANIFEST, and the safe error
 * name). Returns null when the contract does not trigger the audit.
 */
function runReviewAudit(
  beforeManifest: WorkspaceManifest | undefined,
  contract: TaskContractV2,
  workFolder: string,
): { gate: GateResult; acceptanceStatus: 'fail' | 'blocked' } | null {
  if (contract.writePolicy !== 'read_only_report') return null;
  let afterManifest: WorkspaceManifest | undefined;
  let auditStartedAt = Date.now();
  try {
    afterManifest = captureWorkspaceManifest(workFolder);
  } catch (err) {
    const errName = err instanceof Error && err.name && err.name.length > 0 && err.name.length <= 64 ? err.name : 'Error';
    return {
      gate: reviewGateResult('manifest_error', Date.now() - auditStartedAt, `review manifest capture failed (${errName})`),
      acceptanceStatus: 'blocked',
    };
  }
  if (beforeManifest === undefined || afterManifest === undefined) {
    return {
      gate: reviewGateResult('manifest_error', Date.now() - auditStartedAt, 'review manifest unavailable (capture failed)'),
      acceptanceStatus: 'blocked',
    };
  }
  let diff: ManifestDiff;
  try {
    diff = diffWorkspaceManifest(beforeManifest, afterManifest, {
      workFolder,
      deliverablePath: contract.reporting?.deliverablePath ?? null,
    });
    // T2C2b: a real before/after diff exists — record the total touched count.
    recordReviewFilesTouched(diff);
  } catch (err) {
    const errName = err instanceof Error && err.name && err.name.length > 0 && err.name.length <= 64 ? err.name : 'Error';
    return {
      gate: reviewGateResult('manifest_error', Date.now() - auditStartedAt, `review manifest diff failed (${errName})`),
      acceptanceStatus: 'blocked',
    };
  }
  if (diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0) {
    return {
      gate: reviewGateResult('violation', Date.now() - auditStartedAt, reviewViolationSummary(diff)),
      acceptanceStatus: 'fail',
    };
  }
  return null; // clean review: no synthetic gate, no decision to fold in
}

// T2C2b: total workspace files touched per the before/after manifest diff —
// added + changed + removed. Called only when a diff result exists; with no
// manifest the count stays at its initial value (0).
function recordReviewFilesTouched(diff: ManifestDiff): void {
  jobMetrics?.setFilesTouchedCount(diff.added.length + diff.changed.length + diff.removed.length);
}

// Concise, sanitized substatus for a research/analysis deliverable contract
// failure. Names ONLY the artifact contract failure — never a raw path, payload,
// or the report content itself.
function deliverableFailureSubstatus(reason: DeliverableValidityReason): string {
  switch (reason) {
    case 'missing':
      return 'deliverable_missing';
    case 'not_file':
      return 'deliverable_not_file';
    case 'empty':
      return 'deliverable_empty';
    case 'unhashable':
      return 'deliverable_unhashable';
    default:
      return 'deliverable_invalid';
  }
}

const ATTENTION_LOG_MAX = 5;

// Confirm window for a permission signal before it is promoted to
// needs_attention. Auto mode frequently emits a transient permission/control
// signal and then auto-allows and continues; only a signal followed by genuine
// silence (no stdout) for this long is treated as a real human block.
// Overridable via env so tests can use a short window.
function attentionConfirmMs(): number {
  const v = Number(process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS);
  if (Number.isFinite(v) && v >= 0) return v;
  return 5000;
}

// Record a sanitized attention summary and flip the job to needs_attention.
// Deduplicated by requestId so a re-reported signal replaces (never duplicates)
// while DISTINCT requestIds stay distinct in arrival order, bounded by
// ATTENTION_LOG_MAX. The append/dedupe runs INSIDE the per-job CAS lock against
// the latest locked job record — never a stale outer snapshot passed as a fixed
// patch that could overwrite an entry a concurrent writer published.
function recordAttention(jobId: string, summary: AttentionSummary): void {
  const acq = acquireJobStateLock(jobId);
  if (acq === null) return; // fail closed: never publish without the lock
  try {
    const cur = readJob(jobId);
    if (!cur || isTerminal(cur.status) || cur.status === 'cancelled') return;
    const log = (cur.attentionLog ?? []).filter((e) => e.requestId !== summary.requestId);
    log.push(summary);
    const next: Job = {
      ...cur,
      status: 'needs_attention',
      substatus: 'permission_request',
      attentionLog: log.slice(-ATTENTION_LOG_MAX),
    };
    // Atomic replace under the HELD CAS lock (the same protocol updateJob uses).
    const f = jobFilePath(jobId);
    atomicWriteJson(f, next);
  } finally {
    releaseJobStateLock(acq.handle);
  }
}

// Bounded sanitized failure-reason extraction: when a worker fails with a
// non-zero exit code, scan the stdout stream-json tail (bounded read) backwards
// for the last error event (`is_error:true` or a synthetic-model result) and
// pull out a short human-readable message so the leader sees WHY it failed
// instead of blindly retrying an exit_1.
function extractFailureDetail(jobId: string, maxChars = 200): string | null {
  const tail = readTailBytes(logFilePath(jobId), 200_000);
  if (!tail) return null;
  const lines = tail.split('\n');
  const candidateText = (o: unknown): string | null => {
    if (!o || typeof o !== 'object') return null;
    const obj = o as Record<string, unknown>;
    if (typeof obj.result === 'string' && obj.result.length > 0) return obj.result;
    const err = obj.error;
    if (err && typeof err === 'object' && typeof (err as Record<string, unknown>).message === 'string') {
      return (err as Record<string, unknown>).message as string;
    }
    if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
    // Assistant-shaped events: last text block of message.content[].
    const msg = obj.message;
    if (msg && typeof msg === 'object') {
      const content = (msg as Record<string, unknown>).content;
      if (Array.isArray(content)) {
        const texts = content
          .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
          .map((b) => (b as Record<string, unknown>).text)
          .filter((t): t is string => typeof t === 'string' && t.length > 0);
        if (texts.length > 0) return texts[texts.length - 1];
      }
    }
    return null;
  };
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    const isErrorTrue = (ev as Record<string, unknown>).is_error === true;
    if (!isErrorTrue) continue;
    const text = candidateText(ev);
    if (text && text.trim().length > 0) {
      const trimmed = text.trim().replace(/\s+/g, ' ');
      return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
    }
  }
  return null;
}

async function run(jobId: string): Promise<void> {  ensureRuntimeDirs();
  const job = readJob(jobId);
  if (!job) {
    process.stderr.write(`supervisor: job not found ${jobId}\n`);
    process.exit(2);
  }
  if (isTerminal(job.status) || job.status === 'cancelled') {
    writeDone(jobId, job.status, job);
    process.exit(0);
  }

  // Stage 6 single-writer guard: the FIRST write to this job's runtime state is
  // an O_EXCL supervisor claim. Only the claim winner may ack and spawn; a
  // duplicate supervisor (a race between recovery and a start, or a stray
  // double-spawn) exits without touching the job, so two supervisors can never
  // both own one job.
  supervisorClaimOwnerId = crypto.randomUUID();
  const supAcq = acquireClaim({
    jobId,
    kind: 'supervisor',
    ownerId: supervisorClaimOwnerId,
    now: Date.now,
    leaseMs: SUPERVISOR_CLAIM_LEASE_MS,
    inspector: productionInspector(),
  });
  if (supAcq.status !== 'acquired') {
    appendStderrLog(jobId, `\n===== supervisor: claim held by another supervisor, exiting without spawning =====\n`);
    supervisorClaimOwnerId = null;
    process.exit(0);
  }

  // Wave 4B2b3 admission lease lifecycle (see the module-scope contract above).
  // Runs only for an admitted flag-on job; inactive flag keeps the legacy flow
  // byte-for-byte unchanged. Own identity must be capturable BEFORE the lease
  // can be proven ours (PID-reuse protection); a positive epoch-ms creation
  // time is the transferable identity.
  if (admissionLeaseActive(job)) {
    const ownerStartedIso = capturePidStartedAt(process.pid);
    const ownerPidStartedAt = ownerStartedIso === null ? 0 : Date.parse(ownerStartedIso);
    if (!Number.isInteger(ownerPidStartedAt) || ownerPidStartedAt <= 0) {
      appendStderrLog(jobId, '\n===== supervisor: admission owner identity unavailable, failing job =====\n');
      writeAdmissionFailed(jobId, 'admission_owner_identity_unavailable');
      supervisorClaimOwnerId = null;
      process.exit(0);
    }
    admissionLease = new AdmissionSupervisorLease({
      runtimeRoot: runtimeRoot(),
      jobId,
      owner: { pid: process.pid, pidStartedAt: ownerPidStartedAt },
    });
    const ownership = await admissionLease.waitForOwnership(5000, 50);
    if (!ownership.ok) {
      // A failed ownership wait is a HARD failure (never a queued-like state):
      // the scheduler's lease is not ours, so nothing may spawn. The lifecycle
      // recorded the fixed reason internally; the job is finalized failed and
      // the supervisor exits without a worker.
      appendStderrLog(jobId, `\n===== supervisor: admission lease ownership failed (${ownership.reason ?? 'ownership_timeout'}), failing job =====\n`);
      writeAdmissionFailed(jobId, `admission_${ownership.reason ?? 'ownership_timeout'}`);
      supervisorClaimOwnerId = null;
      process.exit(0);
    }
    admissionLease.startHeartbeat(20000);
  }

  // T2C2b: per-job metrics collector, created right after the claim wins so
  // every subsequent step (skeleton report write, ack, spawn, exit paths) can
  // anchor on it. Active ONLY when the flag is on. The record's own prompt
  // seeds promptChars; any scheduler-reserved metrics win over the defaults;
  // queueMs comes from the job's own startedAt timestamp.
  if (metricsV2Enabled(job)) {
    jobMetrics = createJobMetricsCollector(
      metricsInitial(job),
      { queuedAtMs: Number.isFinite(Date.parse(job.startedAt)) ? Date.parse(job.startedAt) : undefined },
    );
    jobMetrics.markSupervisorStarted(Date.now());
  }

  // T2C2: budget preparation must land BEFORE the settings write so the
  // PreToolUse hook inside writeJobSettings can see the budget files. It also
  // records the skeleton report + budgetStatus on the job before the worker
  // spawns (per the frozen order: claim -> skeleton/state -> settings -> spawn).
  prepareBudget(job);
  writeJobSettings(job);
  const { cmd, args } = buildCommand(job);
  const backend = job.workerBackend ?? 'claude';
  if (backend === 'deepseek-harness' && !detectDeepSeekHarness({ ...process.env, ...(job.extraEnv || {}) }).available) {
    appendStderrLog(jobId, '\n===== supervisor: DeepSeek Harness capability probe unavailable =====\n');
  }
  appendStderrLog(jobId, `\n===== supervisor start ${nowIso()} profile=${job.profile} port=${job.port} mode=${job.permissionMode} kind=${job.kind} backend=${backend} worker=${cmd} =====\n`);

  // Ack-before-worker-spawn: persist supervisor_acknowledged STRICTLY BEFORE
  // spawning the worker. A failed ack write makes the supervisor exit without
  // spawning, so a job still at job_persisted has PROVABLY never reached the
  // worker-spawn boundary (recoverJobs' ordering rule depends on this). The
  // ack is guarded so it only moves the checkpoint FORWARD.
  const bp: JobBootstrap = isValidBootstrap(job.bootstrap)
    ? job.bootstrap
    : newBootstrap('job_persisted', nowIso());
  try {
    const acked = updateJobIf(
      jobId,
      (j) =>
        !isTerminal(j.status) &&
        j.status !== 'cancelled' &&
        (!isValidBootstrap(j.bootstrap) || j.bootstrap!.stage === 'job_persisted'),
      {
        status: 'running',
        substatus: null,
        lastActivityAt: nowIso(),
        pid: null,
        supervisorPid: process.pid,
        supervisorPidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        bootstrap: { stage: 'supervisor_acknowledged', bootstrapId: bp.bootstrapId, updatedAt: nowIso() },
      },
    );
    if (!acked) {
      // The job reached a terminal/cancelled state (or an already-past-ack
      // state) between our read and the guarded write. Never spawn.
      releaseSupervisorClaim(jobId);
      process.exit(0);
    }
  } catch (err) {
    appendStderrLog(jobId, `\n===== supervisor: ack write failed, exiting without spawning: ${(err as Error).message} =====\n`);
    releaseSupervisorClaim(jobId);
    process.exit(0);
  }

  // From here on THIS supervisor owns the job: every exit path must finalize.
  ownedJobId = jobId;

  // Parent-death detection: record when our stdin closes (the MCP parent holds
  // the other end; with stdio ignored this fires immediately, so it is only
  // meaningful combined with the exited-worker check below).
  try {
    process.stdin.on('end', () => { parentStdinClosed = true; });
    process.stdin.on('close', () => { parentStdinClosed = true; });
    process.stdin.resume();
  } catch {
    /* stdin unavailable — flag stays false; other guards still apply */
  }

  // Background worker: on Windows the claude CLI (or test fake) must not pop a
  // console window (spawnBackground sets windowsHide there).
  // T1E-E2B review manifest: snapshot the workspace BEFORE the worker spawns.
  // Held in supervisor process memory only — never written to disk. Only the
  // read_only_report policy audits; all other policies skip (capture is cheap
  // but pointless).
  let beforeManifest: WorkspaceManifest | undefined;
  if (job.contract?.writePolicy === 'read_only_report') {
    try {
      beforeManifest = captureWorkspaceManifest(job.workFolder);
    } catch {
      // Fail-closed is decided at diff time; a capture failure here just leaves
      // the manifest absent so the close handler can mark ERR_REVIEW_MANIFEST.
      beforeManifest = undefined;
    }
  }
  const child = spawnBackground(cmd, args, {
    cwd: job.workFolder,
    // F3: never hand the worker the whole orchestrator environment — see
    // workerEnv() above for what is stripped and why the CLI still authenticates.
    env: workerEnv(process.env, job.extraEnv),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeWorkerChild = child;

  // Zombie watchdog: if the worker has definitively exited but the close
  // handler never finalized (crashed mid-finalize), and the parent's stdin is
  // closed, finalize as interrupted instead of lingering `running`. Bounded,
  // unref'd, cheap check every 10s.
  const zombieWatchdog = setInterval(() => {
    if (!parentStdinClosed) return;
    const exitedDefinitively = child.exitCode !== null || child.signalCode !== null;
    if (!exitedDefinitively) return;
    const cur = readJob(jobId);
    if (!cur || isTerminal(cur.status) || cur.status === 'cancelled') {
      clearInterval(zombieWatchdog);
      return;
    }
    clearInterval(zombieWatchdog);
    finalizeInterrupted(jobId, 'worker_exit_unfinalized');
    process.exit(1);
  }, 10_000);
  zombieWatchdog.unref();
  // Record the worker pid + its OS creation identity BEFORE the worker_spawned
  // checkpoint so recovery can always find a live worker (an orphan between
  // spawn and the pid write is unrecoverable). Both writes are after the ack,
  // so a job that reached supervisor_acknowledged with no live child is never
  // auto-replayed.
  const workerPid = child.pid ?? null;
  updateJob(jobId, { pid: workerPid, pidStartedAt: workerPid ? capturePidStartedAt(workerPid) : null });
  updateJob(jobId, {
    bootstrap: { stage: 'worker_spawned', bootstrapId: bp.bootstrapId, updatedAt: nowIso() },
  });
  // T2C2b: the worker is genuinely spawned (OS child exists, checkpoint
  // persisted) — record the worker-start anchor.
  jobMetrics?.markWorkerStarted(Date.now());

  let finalText = '';
  let timeoutFired = false;
  const stdoutParser = new LineParser();
  let lastOutputMs = Date.now();
  let lastPersistedMs = 0;
  // Pending-attention state (real-world fix): a permission signal only becomes
  // needs_attention after a confirm window with no further stdout — Auto mode
  // often emits a transient permission/control signal and then auto-allows and
  // continues, which must NOT wake the leader. The local requestId is generated
  // once per episode and persisted; it is never regenerated per view.
  let pendingAttention: AttentionSummary | null = null;
  let attentionTimer: NodeJS.Timeout | null = null;
  const confirmMs = attentionConfirmMs();
  // Set true once a permission episode is CONFIRMED (persisted as
  // needs_attention): sawUserPrompt says "a published block exists",
  // stdoutSincePublish says "conclusive stdout already resolved it". Together
  // they guard the child-close final status below — a published block that is
  // still unresolved must survive the code-based succeeded/failed mapping.
  // NOTE: the sticky close guard keys on the persisted attentionLog (not these
  // memory booleans); a persisted attention episode must be explicitly resolved
  // by reply/cancel.
  let sawUserPrompt = false;
  let stdoutSincePublish = false;

  // Real output evidence, throttled to at most one job-file write every 5s.
  // (lastActivityAt is only a 30s keepalive and is NOT output evidence.)
  const touchOutput = (): void => {
    lastOutputMs = Date.now();
    // T2C2b: periodic metrics persist rides the output-evidence path; the
    // internal 5s throttle keeps this at most one job-file write per 5s.
    persistMetrics();
    if (lastOutputMs - lastPersistedMs >= 5000) {
      lastPersistedMs = lastOutputMs;
      updateJob(jobId, { lastOutputAt: new Date(lastOutputMs).toISOString() });
    }
  };

  const heartbeat = setInterval(() => {
    if (child.exitCode !== null) return;
    // T2C2b: silent phases still refresh metrics (throttled to ≤1/5s).
    persistMetrics();
    updateJob(jobId, { lastActivityAt: nowIso() });
  }, 30000);

  const killTimer = setTimeout(() => {
    if (child.exitCode !== null) return;
    timeoutFired = true;
    appendStderrLog(jobId, `\n===== TIMEOUT after ${job.maxRuntimeMinutes}min, killing job =====\n`);
    // The live child handle IS the worker we spawned, so this kill needs no
    // identity query (the OS pid was ours at spawn time).
    if (child.pid) killTree(child.pid);
    // Terminal write under the CAS guard: a concurrent cancel that won must not
    // be regressed to failed.
    const updated = updateJobIf(
      jobId,
      (j) => !isTerminal(j.status) && j.status !== 'cancelled',
      { status: 'failed', substatus: 'timeout', endedAt: nowIso(), exitCode: null },
    );
    const final = readJob(jobId) ?? { ...job, status: 'failed', substatus: 'timeout', endedAt: nowIso() };
    // T2C2b: forced timeout — land the metrics accumulated so far.
    persistMetrics(true);
    writeDone(jobId, final.status, final);
  }, job.maxRuntimeMinutes * 60_000);

  // stdout = pure stream-json (kept raw and faithful in <jobId>.log). stderr =
  // claude's human logs/errors, kept in <jobId>.stderr.log alongside our own
  // meta banners. The stdout log has exactly one writer, so the incremental
  // LineParser can reconstruct events that claude's pipe splits mid-JSON.

  // Clear any unconfirmed candidate; used when the worker exits or errors.
  const clearPendingAttention = (): void => {
    pendingAttention = null;
    if (attentionTimer) {
      clearTimeout(attentionTimer);
      attentionTimer = null;
    }
  };

  // Merge two permission signals by information content (monotone): an
  // upstream-id summary wins, `unknown` never overwrites a known tool, and a
  // generic echo never overwrites a structured candidate. Two DISTINCT upstream
  // requestIds never reach this merge — notePermissionSignal force-persists the
  // pending candidate first — so this only merges same-id upstream updates and
  // the local/local or local/upstream supersede cases.
  const mergeAttention = (current: AttentionSummary, incoming: AttentionSummary): AttentionSummary => {
    if (incoming.requestIdSource === 'upstream') return incoming;
    if (current.requestIdSource === 'upstream') return current;
    if (current.tool === 'unknown' && incoming.tool !== 'unknown') return incoming;
    if (incoming.tool === 'unknown' && current.tool !== 'unknown') return current;
    const curScore = (current.action !== 'unknown' ? 1 : 0) + (current.path ? 1 : 0);
    const incScore = (incoming.action !== 'unknown' ? 1 : 0) + (incoming.path ? 1 : 0);
    return incScore > curScore ? incoming : current;
  };

  // Reuse the episode's stable local requestId while the same block is still
  // open: from the pending candidate, or from the persisted attentionLog when
  // the block was published and the worker has NOT produced conclusive progress
  // since. Once the worker moves on, a new local signal is a NEW episode and
  // gets a fresh id (distinct local episodes must not share an id). Upstream ids
  // are authoritative and never relabeled, so distinct real requestIds stay
  // isolated.
  const withStableId = (summary: AttentionSummary): AttentionSummary => {
    if (summary.requestIdSource === 'upstream') return summary;
    if (pendingAttention) {
      return { ...summary, requestId: pendingAttention.requestId, requestIdSource: pendingAttention.requestIdSource };
    }
    if (!stdoutSincePublish && sawUserPrompt) {
      const cur = readJob(jobId);
      if (cur && cur.status === 'needs_attention' && cur.attentionLog && cur.attentionLog.length > 0) {
        const last = cur.attentionLog[cur.attentionLog.length - 1];
        if (last.requestIdSource === 'local') {
          return { ...summary, requestId: last.requestId, requestIdSource: 'local' };
        }
      }
    }
    return summary;
  };

  const notePermissionSignal = (summary: AttentionSummary): void => {
    // Distinct genuine upstream requests must NOT replace each other inside the
    // pending confirmation window, or the first real request would be lost
    // before recordAttention ever runs. When the incoming is a DIFFERENT
    // non-empty upstream requestId, synchronously persist the current pending
    // candidate through the CAS-locked recordAttention path (same-id dedupe,
    // distinct ids kept in order) BEFORE adopting the new one. Local/transient
    // pending superseded by a genuine upstream signal is replaced WITHOUT
    // force-persisting, so no local unknown is manufactured.
    if (
      pendingAttention &&
      summary.requestIdSource === 'upstream' &&
      pendingAttention.requestIdSource === 'upstream' &&
      pendingAttention.requestId.length > 0 &&
      summary.requestId.length > 0 &&
      summary.requestId !== pendingAttention.requestId
    ) {
      const toPersist = pendingAttention;
      // Clear ownership BEFORE persisting so the old timer cannot double-publish
      // and the persist never observes a half-replaced pending candidate.
      if (attentionTimer) {
        clearTimeout(attentionTimer);
        attentionTimer = null;
      }
      pendingAttention = null;
      recordAttention(jobId, toPersist);
      sawUserPrompt = true; // a real block was recorded
      stdoutSincePublish = false; // a new episode begins
    }

    const merged = pendingAttention ? mergeAttention(pendingAttention, summary) : summary;
    pendingAttention = withStableId(merged);
    if (attentionTimer) clearTimeout(attentionTimer);
    attentionTimer = setTimeout(() => {
      attentionTimer = null;
      if (!pendingAttention || child.exitCode !== null) {
        pendingAttention = null;
        return;
      }
      const confirmed = pendingAttention;
      pendingAttention = null;
      sawUserPrompt = true; // a real block was recorded
      stdoutSincePublish = false; // a new episode begins
      recordAttention(jobId, confirmed);
    }, confirmMs);
  };

  // CONCLUSIVE stdout progress (a result event or a tool_use) proves the worker
  // is not blocked waiting on a human: cancel an unconfirmed candidate, and
  // mark that a published block has ended (the request was resolved before
  // close, so the block must not pin needs_attention at close). Plain text
  // banners are NOT conclusive — a still-blocked worker may emit a short banner
  // without resolving.
  const noteStdoutActivity = (hadConclusive: boolean): void => {
    if (hadConclusive && pendingAttention) clearPendingAttention();
    if (hadConclusive && sawUserPrompt) stdoutSincePublish = true;
  };

  const onStdout = (chunk: Buffer): void => {
    const s = chunk.toString();
    appendLog(jobId, s);
    touchOutput();
    for (const line of stdoutParser.feed(s)) {
      const ev = parseLine(line);
      // T2C2b: every complete event passes its single raw line to the
      // collector (tool_use/usage extraction). The raw line itself is never
      // persisted — only the flat sanitized aggregates are.
      jobMetrics?.observeStreamJsonLine(ev.raw);
      if (ev.type === 'userPrompt') {
        notePermissionSignal(sanitizePermission(ev.permission, { workFolder: job.workFolder, at: nowIso() }));
      } else if (ev.type === 'result') {
        // Conclusive only clears permission candidates that preceded THIS
        // event; a later candidate in the same chunk must stay pending.
        noteStdoutActivity(true);
        finalText = ev.result;
      } else if (ev.type === 'assistant') {
        if (ev.toolUses && ev.toolUses.length > 0) noteStdoutActivity(true);
        if (ev.text) finalText = ev.text;
      }
      // Plain raw text / stream_event / other are NOT conclusive progress: a
      // blocked worker may emit a brief banner without having resolved.
    }
  };
  const onStderr = (chunk: Buffer): void => {
    const s = chunk.toString();
    appendStderrLog(jobId, s);
    touchOutput();
  };
  child.stdout!.on('data', onStdout);
  child.stderr!.on('data', onStderr);

  child.on('error', (err) => {
    clearInterval(heartbeat);
    clearTimeout(killTimer);
    clearPendingAttention();
    appendStderrLog(jobId, `\n===== spawn error: ${err.message} =====\n`);
    const updated = updateJobIf(
      jobId,
      (j) => !isTerminal(j.status) && j.status !== 'cancelled',
      { status: 'failed', substatus: 'spawn_error', endedAt: nowIso(), exitCode: null },
    );
    const final = readJob(jobId) ?? { ...job, status: 'failed', substatus: 'spawn_error', endedAt: nowIso() };
    // T2C2b: spawn failed — worker never ran; force the metrics we have.
    persistMetrics(true);
    writeDone(jobId, final.status, final);
    releaseSupervisorClaim(jobId);
  });

  child.on('close', async (code) => {
    clearInterval(heartbeat);
    clearTimeout(killTimer);
    clearPendingAttention();
    // T2C2b: the worker ended — record the anchor before any finalize path.
    jobMetrics?.markWorkerEnded(Date.now());
    // Flush any trailing partial line into the extraction before finalizing.
    for (const line of stdoutParser.flush()) {
      const ev = parseLine(line);
      // T2C2b: trailing partial line reconstructed by flush is still one
      // complete event — observed the same way, never persisted raw.
      jobMetrics?.observeStreamJsonLine(ev.raw);
      if (ev.type === 'result') finalText = ev.result;
      else if (ev.type === 'assistant' && ev.text) finalText = ev.text;
    }
    const current = readJob(jobId);
    if (current && (isTerminal(current.status) || current.status === 'cancelled')) {
      writeDone(jobId, current.status, current);
      releaseSupervisorClaim(jobId);
      process.exit(0);
    }
    let status: JobStatus;
    let substatus: string | null;
    if (timeoutFired) {
      status = 'failed';
      substatus = 'timeout';
    } else if (code === 0) {
      status = 'succeeded';
      substatus = null;
    } else if (code === 3 && (job.workerBackend ?? 'claude') === 'claude') {
      status = 'needs_attention';
      substatus = 'permission_required';
    } else {
      status = 'failed';
      // Upstream-error discrimination (2026-08-24): a bare exit_1 hides the
      // real cause. When the log tail shows provider quota/upstream failures,
      // name them so the leader stops misreading them as permission or
      // classifier problems (real incident: a weekly-quota 429 batch was
      // reported as "权限审查连续超时"). Best-effort: unparseable tails keep
      // the plain exit_<code> substatus.
      let refinedSub: string | null = null;
      try {
        const detail = extractFailureDetail(jobId);
        if (detail) {
          if (/weekly usage limit|\b429\b/i.test(detail)) refinedSub = 'upstream_rate_limited';
          else if (/\b502\b|上游连接失败/i.test(detail)) refinedSub = 'upstream_unavailable';
        }
      } catch {
        /* best-effort: log tail unavailable */
      }
      substatus = refinedSub ?? `exit_${String(code)}`;
    }
    const stickyAttention = current !== null && (current.attentionLog ?? []).length > 0;
    if (stickyAttention) {
      // Sticky attention: the close-entry readJob sees a persisted confirmed
      // attention episode (attentionLog non-empty), and only the explicit
      // reply/cancel flows may resolve it. A worker's conclusive stdout after
      // publication is NOT leader acknowledgement, so stdoutSincePublish never
      // auto-resolves a persisted attention episode.
      status = 'needs_attention';
      substatus = current.substatus ?? 'permission_request';
    } else if (sawUserPrompt && !stdoutSincePublish && status === 'failed') {
      // A worker failure after an observed permission prompt is still exposed
      // as attention when the prompt was not resolved before close.
      status = 'needs_attention';
      substatus = 'permission_request';
    }
    // The worker's own outcome decides whether the compact .txt report is
    // written (existing behavior); a deliverable contract flip below must not
    // suppress it — the .txt is the compact completion summary, and the
    // deliverable .md is never overwritten or synthesized.
    const reportStatus = status;
    let workerStatus: JobStatus = status;
    let workerSubstatus: string | null = substatus;
    // Bounded sanitized failure reason for failed terminal states: the leader
    // sees WHY (proxy/synthetic API error, etc.) instead of blindly retrying.
    // Declared here (not const) so the T1E-E2B review paths can replace it with
    // their safe, sanitized summary.
    let failureDetail = status === 'failed' ? extractFailureDetail(jobId) : null;
    // T2C2: fixed budget violation code (undefined = no budget violation).
    // Set by the budget state read above; NEVER raw worker text.
    let budgetViolation: string | undefined;

    // Research/analysis deliverable contract: inspect the required artifact
    // BEFORE publishing the terminal status. A valid artifact is a regular
    // file, non-empty, and hashable (SHA-256). Record the hash + verified flag
    // when valid (even if the worker failed for another reason). If the worker
    // would otherwise succeed but the artifact is absent/non-file/empty/
    // unhashable, flip the terminal status to failed with a concise sanitized
    // substatus naming only the artifact contract failure.
    //
    // T1E-E2B note: for a read_only_report contract the deliverable is the
    // SINGLE legitimate workspace write, produced by the worker (or, in the
    // tests, by an acceptance command running INSIDE the review after-window).
    // The artifact flip here runs before the audit, and the review write
    // policy below takes precedence over it: a review violation fails with
    // review_write_violation (never deliverable_missing), and a clean audit
    // with a written deliverable keeps the deliverable hash. With no audit
    // (flag off) the flip keeps its exact legacy behavior.
    let deliverablePatch: Partial<Job> | undefined;
    const isDeliverableTask =
      (job.taskType === 'research' || job.taskType === 'analysis') &&
      typeof job.deliverablePath === 'string';
    const acceptancePendingFlag = job.contract !== undefined && job.acceptanceStatus === 'pending';
    const auditActive = job.contract?.writePolicy === 'read_only_report' && acceptancePendingFlag === true;
    if (isDeliverableTask && job.deliverablePath) {
      const insp = inspectDeliverable(job.deliverablePath);
      if (insp.valid) {
        deliverablePatch = { deliverableHash: insp.hash ?? undefined, missingDeliverable: false };
      } else if (!auditActive) {
        deliverablePatch = { missingDeliverable: true };
        if (status === 'succeeded') {
          status = 'failed';
          substatus = deliverableFailureSubstatus(insp.reason);
        }
      } else {
        // T1E-E2B: under an active review audit the review write policy takes
        // precedence over the artifact flip. missingDeliverable is still an
        // actual-inspection fact: only a genuinely absent artifact is marked
        // missing — an existing-but-invalid artifact is never marked missing.
        if (insp.reason === 'missing') {
          deliverablePatch = { missingDeliverable: true };
        }
      }
    }

    // T1E-E2A V2 final-state flow: the supervisor NEVER re-reads the feature
    // flag; the decision is baked into the job record — a v2 contract present
    // with acceptanceStatus 'pending' (set at start) enables the gate. Such a
    // contract exists only when the start-time decision was V2-on.
    // Persisted write order (rule 8):
    //   1. workerStatus (the worker's true outcome; the job's own status field
    //      is untouched here, so the job is never observably `succeeded` before
    //      the acceptance gate has finished);
    //   2. acceptanceStatus + gateResults;
    //   3. the overall terminal status (single CAS-guarded write).
    // needs_attention is NOT a terminal state: it runs no gate and never
    // touches a 'pending' acceptance.
    const contract = job.contract;

    // T2C2 rule 6: budget failure takes precedence over acceptance. The state
    // file is read HERE (before any acceptance command runs, after the worker
    // closed) so a budget verdict can suppress the gate entirely. Read is
    // strict-minimal: only the mode + violationCode that the final decision
    // needs; anything else in the file is ignored.
    let budgetState: BudgetState | null = null;
    if (budgetEnforcementEnabled(job)) {
      const bs = readBudgetState(job);
      if (bs === null) {
        // Corrupt/missing state: fail closed with a fixed code (rule 4).
        status = 'failed';
        substatus = 'budget_violation';
        budgetState = null;
        budgetViolation = 'invalid_state';
      } else {
        budgetState = bs;
        if (bs.violationCode !== undefined) {
          // A recorded violation (or a mode that implies one) is final: it
          // overrides ANY worker outcome, including a successful worker.
          status = 'failed';
          substatus = 'budget_violation';
          budgetViolation = bs.violationCode;
        } else if (bs.mode === 'report_only' || bs.mode === 'failed') {
          // Mode flipped without a recorded code (report-only window). The
          // report-only window is a violation by itself.
          status = 'failed';
          substatus = 'budget_violation';
          budgetViolation = 'report_only_window';
        }
      }
    }
    // T2C2 rule 6: a worker that failed / needs attention / was cancelled does
    // NOT get its outcome rewritten to success by the budget path. Only a
    // budget failure (or invalid state) overrides the terminal outcome. When
    // enforcement is off, budgetState is null and the gate keeps its exact
    // legacy behavior (budgetActive=true so it never suppresses acceptance).
    const budgetActive =
      !budgetEnforcementEnabled(job) ||
      (budgetState !== null && budgetState.violationCode === undefined && budgetState.mode === 'active');

    const acceptancePending = job.acceptanceStatus === 'pending';
    // T1E-E2B: read_only_report contracts ALSO run the review manifest audit
    // (see runReviewAudit). The audit outcome decides whether the acceptance
    // gate runs at all. Runs for ANY worker outcome (rule 7: a failed/cancelled
    // worker still records the audit result, without overriding its substatus).
    const reviewAuditResult = contract && acceptancePending ? runReviewAudit(beforeManifest, contract, job.workFolder) : null;
    // Rule 8 write order (T1E-E2B rule 8): the audit runs BEFORE any
    // acceptance command, so the after-window captures exactly the worker's
    // workspace effect. For a successful worker the audit is folded in at
    // Step 1 and flips the terminal state; for a failed/cancelled worker the
    // audit result is recorded without overriding the original substatus.
    const reviewAuditFailed = reviewAuditResult !== null && reviewAuditResult.acceptanceStatus === 'fail';
    const reviewAuditBlocked = reviewAuditResult !== null && reviewAuditResult.acceptanceStatus === 'blocked';
    // missingDeliverable comes ONLY from the deliverable inspection above — a
    // review violation or an absent pending contract never fabricates it: a
    // written artifact keeps missingDeliverable=false, and an audit verdict
    // changes the review outcome, not the artifact evidence.
    const runsAcceptanceGate = acceptancePending && workerStatus === 'succeeded' && contract !== undefined && budgetActive;
    if (runsAcceptanceGate) {
      // Step 1: persist the worker's true outcome. The status field keeps its
      // live value (running/needs_attention), so no concurrent reader can ever
      // observe an overall `succeeded` while the gate is still running.
      const withWorkerStatus = updateJobIf(
        jobId,
        (j) => !isTerminal(j.status) && j.status !== 'cancelled',
        { workerStatus, ...(workerSubstatus ? { substatus: workerSubstatus } : { substatus: null }) },
      );
      if (withWorkerStatus) {
        if (reviewAuditFailed) {
          // T1E-E2B rule 4: the worker wrote outside the single legitimate
          // deliverable — a review violation. The worker's true outcome is
          // already persisted (step 1). Persist the synthetic gate, flip the
          // acceptance to fail, and demote the overall terminal state; the
          // acceptance commands NEVER run.
          updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
            acceptanceStatus: 'fail',
            gateResults: [reviewAuditResult!.gate],
          });
          status = 'failed';
          substatus = 'review_write_violation';
          failureDetail = 'review write violation';
        } else if (reviewAuditBlocked) {
          // T1E-E2B fail-closed: the manifest capture/diff itself threw. No
          // acceptance command runs. The synthetic gate names ONLY the error
          // class — never the message, which may embed manifest internals.
          updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
            acceptanceStatus: 'blocked',
            gateResults: [reviewAuditResult!.gate],
          });
          status = 'failed';
          substatus = 'review_manifest_error';
          failureDetail = 'review manifest error';
        } else {
          // Step 2: run the acceptance commands (fail-closed) and persist the
          // internal GateResult[] + acceptanceStatus. Reached only when the
          // review audit is clean (or not triggered).
          const withGates = await runAndPersistAcceptance(jobId, contract.acceptance, job.workFolder);
          if (withGates === null) {
            // A concurrent writer (cancel / recovery) reached a terminal/cancelled
            // state while the gate was running: honor the winner, never flip it.
            const latest = readJob(jobId);
            if (latest) {
              writeDone(jobId, latest.status, latest);
              releaseSupervisorClaim(jobId);
              process.exit(0);
            }
          } else if (withGates.acceptanceStatus === 'pass') {
            // Step 3: summary decides the overall terminal state. A deliverable-
            // contract flip above (research/analysis artifact invalid) already
            // demoted the terminal state; a gate pass must not resurrect it.
            if (status === 'succeeded') substatus = null;
          } else if (withGates.acceptanceStatus === 'blocked') {
            status = 'failed';
            substatus = 'acceptance_blocked';
          } else {
            status = 'failed';
            substatus = 'acceptance_failed';
          }
        }
      } else {
        // A concurrent writer (cancel / recovery) reached a terminal/cancelled
        // state while the gate was starting: honor the winner, never flip it.
        const latest = readJob(jobId);
        if (latest) {
          writeDone(jobId, latest.status, latest);
          releaseSupervisorClaim(jobId);
          process.exit(0);
        }
      }
    } else if (acceptancePending && workerStatus === 'failed') {
      // Rule 4: a failed/cancelled worker runs NO acceptance gate. The worker's
      // true outcome is persisted, acceptance is 'blocked' (it was pending and
      // never ran), gateResults stay empty, and the overall terminal state
      // keeps the original worker failure/cancellation semantics with its
      // failureDetail. T1E-E2B rule 7: a review violation/manifest error on a
      // failed worker is still recorded — the synthetic gate lands in
      // gateResults, but the original substatus is never overridden.
      updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
        workerStatus,
        acceptanceStatus: reviewAuditResult ? reviewAuditResult.acceptanceStatus : 'blocked',
        gateResults: reviewAuditResult ? [reviewAuditResult.gate] : [],
        // T2C2 rule 4: the budget outcome is fixed regardless of worker status.
        ...(budgetViolation !== undefined ? { budgetStatus: 'failed', budgetViolation } : {}),
      });
    } else if (acceptancePending) {
      // Rule 5: needs_attention is not a terminal state — no gate, and the
      // 'pending' acceptance status is left untouched (a reply resumes the
      // pending contract). Rules 2-3 (a deliverable flip to failed) already
      // applied above.
      updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', {
        workerStatus,
        // T2C2: a budget violation on a needs_attention worker is still fixed.
        ...(budgetViolation !== undefined ? { budgetStatus: 'failed', budgetViolation } : {}),
      });
    } else {
      // No pending contract (flag off / legacy job): the gate branches above
      // are skipped, but the worker's true outcome is still persisted here,
      // under the same CAS guard as the terminal write below, so workerStatus
      // is never left at its start-time mirror.
      updateJobIf(jobId, (j) => !isTerminal(j.status) && j.status !== 'cancelled', { workerStatus });
    }
    if (stickyAttention) {
      // Same stickyAttention as the close-entry fold: the persisted attention
      // episode must be explicitly resolved by reply/cancel; downstream
      // acceptance/budget bookkeeping cannot implicitly resolve it. Re-assert
      // immediately before the final CAS write; cancel remains authoritative
      // because the final guard below will reject this write.
      status = 'needs_attention';
      substatus = current?.substatus ?? 'permission_request';
    }
    // T2C2b: every deliverable/budget/acceptance gate has finished — the
    // overall terminal write below is the last gate-adjacent step, so this is
    // the gates-end anchor.
    jobMetrics?.markGatesEnded(Date.now());
    // The report/attention-fold path below remains shared; sticky attention is
    // reasserted immediately before the final terminal CAS above the publish.

    appendStderrLog(jobId, `\n===== worker backend=${job.workerBackend ?? 'claude'} exit code=${String(code)} status=${status} =====\n`);
    // Persist the report BEFORE publishing the terminal status. The watch (and
    // status/viewer readers) resolve on the status field, so the terminal
    // artifact must already be on disk when a `succeeded` status becomes
    // visible — otherwise a watch would announce an acceptably-succeeded job
    // with hasReport=false. needs_attention written while the worker is still
    // alive is unaffected: it is published from onStdout/onStderr far earlier
    // and carries no report.
    if (reportStatus === 'succeeded' || reportStatus === 'needs_attention') {
      if (budgetEnforcementEnabled(job)) {
        // T2C2: the budget-owned report replaces the bare writeReport path.
        // The skeleton's front matter is preserved; completeness is 'complete'
        // ONLY when the worker succeeded and no budget violation occurred
        // (otherwise 'partial' — a budget failure is always partial);
        // evidenceCount stays 0 (evidence collection is a later stage) and
        // lastUpdatedAt is refreshed to now. The body is the final text or a
        // bounded rendered tail — never prompt/env/raw log content. Flag off
        // keeps the legacy bare report path below.
        const skeleton = buildEvidenceReportSkeleton(job.jobId, new Date(budgetStartedAtMs(job)).toISOString());
        const completeness = reportStatus === 'succeeded' && budgetViolation === undefined ? 'complete' : 'partial';
        // Preserve the skeleton's front matter exactly, then rewrite the
        // completeness line and lastUpdatedAt line in place; append the body.
        const lines = skeleton.split('\n');
        const out: string[] = [];
        let replacedCompleteness = false;
        let replacedUpdatedAt = false;
        for (const line of lines) {
          if (line.startsWith('completeness: ')) {
            out.push(`completeness: ${completeness}`);
            replacedCompleteness = true;
          } else if (line.startsWith('lastUpdatedAt: ')) {
            out.push(`lastUpdatedAt: ${nowIso()}`);
            replacedUpdatedAt = true;
          } else {
            out.push(line);
          }
        }
        if (!replacedCompleteness || !replacedUpdatedAt) {
          // Skeleton shape changed (should not happen): fail safe by falling
          // back to a fresh skeleton with the final completeness.
          writeReport(job.jobId, buildEvidenceReportSkeleton(job.jobId, nowIso()).replace(/^completeness: skeleton$/m, `completeness: ${completeness}`));
        } else {
          fs.writeFileSync(reportFilePath(job.jobId), out.join('\n') + budgetReportBody(job, finalText), 'utf8');
        }
        updateJob(job.jobId, { reportCompleteness: completeness });
      } else {
        // T2C2b: legacy bare report write — first report write of the job.
        jobMetrics?.markFirstReportWrite(Date.now());
        writeReport(job.jobId, finalText || renderedTail(jobId, { lines: 10, maxChars: 2000 }));
      }
    }
    // A needs_attention with no recorded summary (e.g. exit code 3 with no
    // userPrompt event) still gets a safe generic structured summary so watch
    // and status always carry a bounded, sanitized attentionDetail. Folded into
    // the SAME atomic update as the terminal status so no intermediate
    // (permission_request) state is ever visible to a concurrent reader.
    let attentionLog: AttentionSummary[] | undefined;
    if (status === 'needs_attention') {
      // Decide the generic-fold against the LATEST locked job so a stale read
      // can never clobber a real entry a concurrent writer published. If the
      // lock is briefly held, fail closed and skip the fold (the status write
      // below is still guarded); never write from an unlocked snapshot.
      const acq = acquireJobStateLock(jobId);
      if (acq !== null) {
        try {
          const preFinal = readJob(jobId);
          if (preFinal && (!preFinal.attentionLog || preFinal.attentionLog.length === 0)) {
            attentionLog = [genericAttentionSummary({ at: nowIso() })];
          }
        } finally {
          releaseJobStateLock(acq.handle);
        }
      }
    }
    // Bounded sanitized failure reason for failed terminal states: the leader
    // sees WHY (proxy/synthetic API error, etc.) instead of blindly retrying.
    // (Declared above next to the other mutables; the T1E-E2B review paths
    // replace it with their safe summary.)
    const updated = updateJobIf(
      jobId,
      (j) => !isTerminal(j.status) && j.status !== 'cancelled',
      {
        status,
        substatus,
        exitCode: code ?? null,
        endedAt: nowIso(),
        lastOutputAt: new Date(lastOutputMs).toISOString(),
        ...(failureDetail ? { failureDetail } : {}),
        ...(attentionLog !== undefined ? { attentionLog } : {}),
        ...(deliverablePatch ?? {}),
        // T2C2: budget fields ride the SAME CAS-guarded terminal write so the
        // failure can never be overwritten by a later `succeeded` (rule 4).
        ...(budgetViolation !== undefined ? { budgetStatus: 'failed', budgetViolation } : {}),
        ...(budgetState !== null && budgetViolation === undefined && budgetState.mode === 'active'
          ? { budgetStatus: 'active' }
          : {}),
      },
    );
    if (updated) {
      // T2C2b: terminal write landed — force-persist the final metrics so
      // the terminal job record carries the complete aggregates.
      persistMetrics(true);
      writeDone(jobId, status, updated);
    } else {
      // A concurrent writer (cancel / recovery / another finalizer) reached a
      // terminal/cancelled state first. Terminal statuses are immutable: honor
      // the winner, never overwrite it.
      const latest = readJob(jobId);
      if (latest) writeDone(jobId, latest.status, latest);
    }
    releaseSupervisorClaim(jobId);
    process.exit(0);
  });

  // The child's stdio pipes keep this process alive while it runs; the
  // 'close' handler above writes the final status and exits.
}

// Crash guard: never leave a job stuck in "running".
process.on('uncaughtException', (err) => {
  try {
    const { jobId } = parseArgs();
    const cur = readJob(jobId);
    if (cur && !isTerminal(cur.status)) {
      appendStderrLog(jobId, `\n===== supervisor error: ${err.message} =====\n`);
      const updated = updateJobIf(
        jobId,
        (j) => !isTerminal(j.status),
        { status: 'failed', substatus: 'supervisor_error', endedAt: nowIso(), exitCode: null },
      );
      const final = readJob(jobId) ?? cur;
      // T2C2b: crash path — force-persist whatever the collector has.
      persistMetrics(true);
      writeDone(jobId, final.status, final);
    }
    releaseSupervisorClaim(jobId);
  } catch {
    /* nothing else to do */
  }
  process.exit(1);
});

// Test-only guard: importing this module from the test process must not run
// the detached-supervisor mainline (it would die with "usage: supervisor
// --job <jobId>" and fail the import). The scheduler integration tests import
// the pure buildCommand helper; the real entry path is spawned with --job and
// never hits this branch.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(parseArgs().jobId).catch((err) => {
    process.stderr.write(`supervisor fatal: ${String(err)}\n`);
    try {
      releaseSupervisorClaim(parseArgs().jobId);
    } catch {
      /* best effort */
    }
    process.exit(1);
  });
}
