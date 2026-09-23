// The scheduler API powering the MCP tools. Jobs are launched as detached
// `supervisor` sub-processes (node dist/supervisor.js --job <id>) so a single
// start/wait/status call never exceeds the 300s Codex tool boundary, and jobs
// survive MCP server restarts.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  newJobId,
  newSessionId,
  readJob,
  updateJob,
  updateJobIf,
  createJobRecord,
  listJobs,
  toPublicView,
  appendStderrLog,
  doneFilePath,
  logFilePath,
  stderrLogFilePath,
  reportFilePath,
  readLogTail,
  isTerminal,
  isValidBootstrap,
  parseDoneMarker,
  indexedJobIdsForSession,
  type Job,
  type JobStatus,
  type JobView,
  type DoneMarker,
  type AttentionResponseAudit,
} from './job-store.js';
import {
  validateStartParams,
  resolveRouting,
  buildStartDefaults,
  type StartParams,
  type Profile,
  type Parallelism,
  type TaskType,
} from './router.js';
import { buildLegacyContract, type TaskContractV2 } from './contracts-v2.js';
import { buildPrompt } from './leader.js';
import { createJobMetrics, type JobMetricsV2 } from './job-metrics.js';
import {
  ensureRuntimeDirs,
  runtimeRoot,
  WAIT_MAX_SECONDS,
  WAIT_POLL_MS,
  SERVER_ROOT,
  WATCH_MAX_SECONDS,
  WATCH_DEFAULT_SECONDS,
  WATCH_MIN_SECONDS,
  bootstrapGraceMs,
  recoveryClaimLeaseMs,
  admissionControlEnabled,
  retentionV2Enabled,
  desiredWorkerConcurrencyDefault,
  readWorkerWhitelist,
  resolveWorkerDeny,
  DEFAULT_WORKER_ALLOW,
  DEFAULT_WORKER_DENY,
} from './config.js';
import { isAlive, spawnBackground, spawnViewerLauncher, capturePidStartedAt, killTreeVerified, pidIdentityStatus, pidIsNotOurChild, queryParentPid, queryPidStartedAt } from './proc.js';
import { renderedTail, type TailOptions } from './render.js';
import { toAttentionSnapshot, type AttentionSummary } from './parser.js';
import { getJobEventBroker } from './job-events.js';
import {
  acquireClaim,
  releaseClaim,
  inspectClaimFile,
  claimFileMtimeAgeMs,
  claimOwnerVerifiedDead,
  newBootstrap,
  productionInspector,
  type JobBootstrap,
} from './recovery.js';
import type { ProcessInspector } from './registry.js';
import { defaultWorkerBackend, type WorkerBackend } from './worker-adapter.js';
// Wave 3B reply preflight: pure policy decisions (transcript threshold, reply
// modes, fixed denial codes) live in backend-policy.ts; the scheduler only
// applies them at reply time. backend-policy is a leaf module (no imports), so
// this import cannot create a cycle.
import {
  evaluateReplyPreflight,
  replyTranscriptMaxBytes,
  type ReplyMode,
  type ReplyPreflight,
} from './backend-policy.js';
// Type-only import (erased at runtime): the WatchView mirror carries the
// persisted legacy receipt shape but never scans receipts; kept for the
// historical reader only. The supervisor no longer scans receipt text.
import type { LeaderDecisionRecord } from './leader-decision.js';
// Wave 4B2b2 admission-control wiring: the controller (a pure testable unit,
// owns no timers or JobStore writes) decides each pump's candidates; the
// scheduler owns the O_EXCL-gated lease lifecycle handoff and every JobStore
// write. The manager is used directly for the post-pump counts refresh.
import {
  AdmissionController,
  type AdmissionCandidate,
  type LaunchedSupervisor,
  type AdmissionDecision,
} from './admission-controller.js';
import { AdmissionManager, type PublicLease, type AdmissionQueueReason } from './admission.js';
import { isAlive as procIsAlive, queryPidStartedAt as procQueryPidStartedAt } from './proc.js';

const supervisorEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'supervisor.js');

// T1E Contract V2 feature flag. Only the exact value '1' enables Contract V2
// preparation; any other value (including absent) keeps the full V1 execution
// path unchanged. The scheduler only PREPARES contract data for persistence —
// it never runs acceptance, captures manifests, or decides worker final state;
// the supervisor reads these fields back from the JobStore by jobId.
const CONTRACT_V2_FLAG = 'ORCHESTRATOR_CONTRACT_V2';
function contractV2Enabled(): boolean {
  return process.env[CONTRACT_V2_FLAG] === '1';
}

// T2C helper flags. Only the exact value '1' enables the feature; any other
// value (including absent) keeps the legacy lifecycle initialization unchanged.
// Mirrors the supervisor gates (metricsV2Enabled / budgetEnforcementEnabled).
const METRICS_V2_FLAG = 'ORCHESTRATOR_METRICS_V2';
function metricsV2Enabled(): boolean {
  return process.env[METRICS_V2_FLAG] === '1';
}
const BUDGET_ENFORCEMENT_FLAG = 'ORCHESTRATOR_BUDGET_ENFORCEMENT';
function budgetEnforcementEnabled(): boolean {
  return process.env[BUDGET_ENFORCEMENT_FLAG] === '1';
}

// Wave 3B reply preflight feature flag. Only the exact value '1' enables the
// Claude reply preflight gate (transcript-size guard); the DEEPSEEK-HARNESS
// preflight is unconditional and NEVER depends on this flag — a reply to a
// one-shot backend job always requires explicit fresh-turn authorization.
const REPLY_PREFLIGHT_FLAG = 'ORCHESTRATOR_REPLY_PREFLIGHT';
function replyPreflightEnabled(): boolean {
  return process.env[REPLY_PREFLIGHT_FLAG] === '1';
}

// T2C reply-depth clamp: the supervisor-side depth grows one per reply, so a
// runaway reply chain is bounded at a fixed ceiling (matches the metrics
// collector's non-negative clamp, but with an explicit upper bound).
const REPLY_DEPTH_MAX = 10000;

// T2C scheduler lifecycle initialization for a NEW job:
//   - metrics flag on  -> persist createJobMetrics({ promptChars: prompt
//     length, transcriptBytesBefore: 0, replyDepth: 0 }); flag off leaves
//     metrics absent entirely;
//   - budget flag on AND the job's final record carries a contract ->
//     budgetStatus: 'active' (the supervisor's prepareBudget treats it as
//     already in force); otherwise explicitly 'not_requested'. Nothing here
//     ever writes reportCompleteness — that is the supervisor's measurement.
// Returns {} (no lifecycle fields) when both flags are off, so a legacy record
// stays byte-identical to pre-T2C.
function lifecycleInitForNewJob(opts: { promptLength: number; contractPresent: boolean }): Partial<Job> {
  const fields: Partial<Job> = {};
  if (metricsV2Enabled()) {
    fields.metrics = createJobMetrics({
      promptChars: opts.promptLength,
      transcriptBytesBefore: 0,
      replyDepth: 0,
    });
  }
  fields.budgetStatus = budgetEnforcementEnabled() && opts.contractPresent ? 'active' : 'not_requested';
  return fields;
}

// T1E contract preparation for a start/reply job. Never executed here: the
// effective contract is persisted for downstream consumption, and the T1D
// mirrors (workerStatus/acceptanceStatus/gateResults) are initialized to the
// state that matches whether a contract is in effect. flag on + no explicit
// contract synthesizes a workspace_legacy contract from the legacy job fields
// (buildLegacyContract) so a V1 caller still lands in the Contract V2 flow.
function prepareContractV2(opts: {
  contract?: TaskContractV2;
  taskType?: TaskType;
  workFolder: string;
  maxRuntimeMinutes: number;
  deliverablePath?: string;
  status: JobStatus;
}): Pick<Job, 'contract' | 'workerStatus' | 'acceptanceStatus' | 'gateResults'> | null {
  if (!contractV2Enabled()) return null;
  const effectiveContract = opts.contract ?? buildLegacyContract({
    taskType: opts.taskType ?? 'execution',
    workFolder: opts.workFolder,
    maxRuntimeMinutes: opts.maxRuntimeMinutes,
    deliverablePath: opts.deliverablePath,
  });
  return {
    contract: effectiveContract,
    workerStatus: opts.status,
    acceptanceStatus: 'pending',
    gateResults: [],
  };
}

export function clampWaitSeconds(n: number): number {
  if (!Number.isFinite(n)) return WAIT_MAX_SECONDS;
  return Math.min(Math.max(1, Math.floor(n)), WAIT_MAX_SECONDS);
}

// Anti-burst stagger for `start` spawns. A Codex wave starts several workers in
// the same second; those concurrent first-requests hit the upstream gateway
// together and intermittently trigger its 429 rate-limit (an instant
// in=0/failed worker, wasting the cold-start it already paid to re-warm).
// Deferring each supervisor spawn by up to this many ms de-syncs the burst.
// Sized under recovery's bootstrap grace (15s) so a server crash before the
// timer fires is still resumed as a plain 'queued' job. Override with
// ORCHESTRATOR_START_JITTER_MAX_MS (0 disables).
//
// Wave 4B2b2: when admission control is ON the jitter path is skipped entirely
// — a start never spawns directly, it enqueues for the admission pump.
const START_JITTER_DEFAULT_MS = 800;
export function startJitterMaxMs(): number {
  const v = Number(process.env.ORCHESTRATOR_START_JITTER_MAX_MS);
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  return START_JITTER_DEFAULT_MS;
}

/**
 * Wave 4B2b2 start params extension: per-job admission target. The MCP schema
 * addition is a later task; this internal API accepts an explicit integer 1..64
 * (or null = policy default) only when admission control is enabled, and
 * parallelism must NEVER derive desired concurrency.
 */
export interface AdmissionStartParams {
  /** Explicit per-job desired worker concurrency (1..64), or null for the policy default. */
  desiredWorkerConcurrency?: number | null;
}

// ---------------------------------------------------------------------------
// F1 visibility: the deny list is the ONLY hard policy in the default `auto`
// profile. That profile runs the worker under --permission-mode
// bypassPermissions, where `allow` merely suppresses prompts — `deny` is what
// actually blocks a tool call. The supervisor injects the built-in floor UNION
// the file's own rules (see config.resolveWorkerDeny): a config file can raise
// the bar, never lower it. Anything actually substituted or added by us is
// reported here, through the warnings[] channel the start/reply tools already
// return, because the detached supervisor's own stderr is discarded
// (stdio:'ignore').
// ---------------------------------------------------------------------------
function workerPolicyWarnings(): string[] {
  const whitelist = readWorkerWhitelist();
  if (whitelist.problem === 'ok') return [];
  const resolution = resolveWorkerDeny(whitelist.permissions?.deny);
  const where = whitelist.path ? ` (${whitelist.path})` : '';
  const facts: string[] = [];
  if (resolution.source === 'floor') {
    facts.push(
      `no deny list could be read, so the built-in default list applies in full (${DEFAULT_WORKER_DENY.length} rules)`,
    );
  } else if (resolution.addedByFloor.length > 0) {
    const sample = resolution.addedByFloor.slice(0, 4).join(', ');
    const more = resolution.addedByFloor.length > 4 ? ', …' : '';
    facts.push(
      `your deny list misses ${resolution.addedByFloor.length} built-in baseline rule(s) (${sample}${more}); the baseline is ` +
        `union-ed into it, so deny = ${resolution.deny.length} rules total and your list can only be tightened, never lowered`,
    );
  }
  if (!Array.isArray(whitelist.permissions?.allow)) {
    facts.push(
      `permissions.allow is not an array, so the built-in conservative allow list applies (${DEFAULT_WORKER_ALLOW.length} rules)`,
    );
  }
  const header =
    whitelist.problem === 'deny_floor_added'
      ? `worker whitelist incomplete — ${whitelist.detail}${where}.`
      : `worker whitelist unusable: ${whitelist.detail}${where}.`;
  const advice =
    whitelist.problem === 'deny_floor_added'
      ? 'Nothing is broken — the baseline only tightens the policy; copy the missing rules into your file to silence this note.'
      : "Create the whitelist file (or set ORCHESTRATOR_WHITELIST_PATH) to use your own policy; the job's stderr log carries the same notice.";
  return [`${header} ${facts.join('; ')}. ${advice}`];
}

export function startJob(params: StartParams & AdmissionStartParams): { job: JobView; warnings: string[] } {
  const errors = validateStartParams(params);
  if (errors.length > 0) {
    throw new Error(`invalid params: ${errors.join('; ')}`);
  }
  // Wave 4B2b2 contract: an explicit desiredWorkerConcurrency is only honored
  // when admission control is on; it must then be an integer 1..64. An invalid
  // explicit value fails the start with a fixed param error (never a fallback).
  const desired = params.desiredWorkerConcurrency;
  if (desired !== undefined && desired !== null && admissionControlEnabled()) {
    if (!Number.isInteger(desired) || desired < 1 || desired > 64) {
      throw new Error('invalid params: desiredWorkerConcurrency must be an integer in 1..64');
    }
  }
  ensureRuntimeDirs();
  const defaults = buildStartDefaults(params);
  const { profile, parallelism, maxRuntimeMinutes } = defaults;
  const routing = resolveRouting(profile);
  const workerBackend: WorkerBackend = params.workerBackend ?? defaultWorkerBackend();
  // Legacy compact-record discipline: the resolved backend is NOT persisted on
  // the job record when the caller never selected one (the record stays
  // byte-compatible with the pre-Wave-3B shape; watch/status/list then omit
  // workerBackend and the runtime resolves the same default via
  // j.workerBackend ?? 'claude'). Explicit selection persists verbatim.
  const workerBackendPersisted: WorkerBackend | undefined =
    params.workerBackend !== undefined ? workerBackend : undefined;
  // Single-artifact write exception (2026-08-23): review profile + research/
  // analysis + deliverablePath is a legitimate combination (evidence audit
  // that must land exactly one report file), but plan mode hard-blocks writes
  // so the worker deadlocks at the only write it needs. Derive instead of
  // failing: permission-mode default plus an exact-path Write/Edit allowance
  // for the report file (granted by the supervisor settings); every other
  // write still escalates via needs_attention.
  const warnings: string[] = [];
  let effectivePermissionMode: string = routing.permissionMode;
  // F1: a job started without a usable worker whitelist runs under the built-in
  // deny floor instead of the user's own policy — say so in the tool response.
  warnings.push(...workerPolicyWarnings());
  const isDeliverableTask = params.taskType === 'research' || params.taskType === 'analysis';
  const artifactWriteException =
    isDeliverableTask &&
    profile === 'review' &&
    typeof params.deliverablePath === 'string' &&
    params.deliverablePath.length > 0;
  if (artifactWriteException) {
    effectivePermissionMode = 'default';
    warnings.push(
      'review+deliverablePath: plan mode would deadlock the report write — this job runs in default mode with a single-file write allowance for ' +
        params.deliverablePath +
        '; any other write still escalates via needs_attention.'
    );
  }

  const jobId = newJobId();
  const sessionId = newSessionId();
  const startedAt = new Date().toISOString();
  // T2C: the raw caller prompt length is the metrics source of truth — the
  // same value the supervisor recomputes from the persisted record's own
  // prompt (metricsInitial), so a flag-on start and its supervisor agree.
  const rawPromptChars = params.prompt.length;
  // T2C contract presence for the budget gate: the final record's contract is
  // the spread below (explicit contract wins; flag-on synthesizes a
  // workspace_legacy contract; flag-off yields none).
  const contractPrepared = prepareContractV2({
    contract: undefined,
    taskType: params.taskType,
    workFolder: path.resolve(params.workFolder),
    maxRuntimeMinutes,
    deliverablePath: params.deliverablePath,
    status: 'queued',
  });
  const job: Job = {
    jobId,
    sessionId,
    kind: 'start',
    replyToJobId: null,
    profile,
    port: routing.port,
    permissionMode: effectivePermissionMode,
    parallelism,
    workFolder: path.resolve(params.workFolder),
    maxRuntimeMinutes,
    pid: null,
    supervisorPid: null,
    status: 'queued',
    // Wave 4B2b2: admission flag on -> the job is enqueued for the admission
    // pump (admission_wait), never directly spawned; flag off -> legacy null.
    substatus: admissionControlEnabled() ? 'admission_wait' : null,
    startedAt,
    endedAt: null,
    lastActivityAt: startedAt,
    exitCode: null,
    logPath: logFilePath(jobId),
    stderrLogPath: stderrLogFilePath(jobId),
    reportPath: reportFilePath(jobId),
    prompt: buildPrompt(
      profile,
      params.prompt,
      parallelism,
      {
        taskType: params.taskType,
        deliverablePath: params.deliverablePath,
      },
      workerBackend === 'deepseek-harness'
        ? { backend: workerBackend as WorkerBackend, replyMode: 'fresh_turn' as ReplyMode }
        : undefined,
    ),
    claudeCli: params.claudeCli,
    claudePrefix: params.claudePrefix,
    extraEnv: params.extraEnv,
    workerBackend: workerBackendPersisted,
    taskType: params.taskType,
    deliverablePath: params.deliverablePath,
    artifactWriteException: artifactWriteException ? true : undefined,
    lastOutputAt: startedAt,
    // T1E Contract V2 persistence — explicit mirrors on every start record
    // (never left to toPublicView fallback). contract keeps a supplied explicit
    // contract even when the flag is off (internal observability only: the
    // flag decides whether it is ever executed); flag on + no explicit
    // contract synthesizes a workspace_legacy contract from legacy fields.
    ...(params.contract
      ? { contract: params.contract }
      : (contractPrepared ?? {})),
    workerStatus: 'queued',
    acceptanceStatus: contractV2Enabled() ? 'pending' : 'not_requested',
    gateResults: [],
    // T2C lifecycle initialization (metrics + budgetStatus). Derived AFTER the
    // contract spread so the budget gate sees the record's final contract;
    // reportCompleteness is deliberately never written here (the supervisor
    // measures the report when the worker actually produced it).
    ...lifecycleInitForNewJob({ promptLength: rawPromptChars, contractPresent: !!params.contract || contractPrepared !== null }),
    // Wave 4B2b2 admission persistence: flag on -> the job waits in the
    // admission queue (substatus admission_wait) with the effective desired
    // concurrency, its resource class, and queuedAt=startedAt. Flag off ->
    // every admission field stays absent (legacy byte-identical record).
    ...(admissionControlEnabled()
      ? {
          desiredWorkerConcurrency: desired ?? desiredWorkerConcurrencyDefault(),
          admissionState: 'queued' as const,
          admissionResourceClass: (params.contract?.admission?.resourceClass ?? 'light') as 'light' | 'build' | 'heavy',
          admissionQueueReason: null,
          queuedAt: startedAt,
          admittedAt: null,
          activeWorkers: 0,
          queuedWorkers: 0,
          resourceLimit: null,
        }
      : {}),
    // Stage 6 bootstrap checkpoint: stamped BEFORE the supervisor spawn so a
    // crash between the job write and the spawn is resumable (and never falsely
    // claims any Claude step was reached).
    bootstrap: newBootstrap('job_persisted', startedAt),
  };
  // Exclusive per-job create under the state lock (never two creators).
  if (!createJobRecord(job)) {
    throw new Error(`job creation failed (concurrent holder): ${jobId}`);
  }
  // Defer the detached supervisor spawn by a random sub-second jitter so a
  // wave of concurrent starts doesn't fire their first API requests at the
  // exact same instant into the 429-prone upstream gateway. The job stays
  // 'queued' meanwhile; recovery still resumes it if the server dies before
  // the timer fires (grace is 15s, jitter is ≤~0.8s). 0 disables (tests).
  //
  // Wave 4B2b2: admission flag on -> the start never spawns directly; it is
  // admitted by the pump (candidates are sorted and decided there, and the
  // job's explicit desired concurrency is already persisted above). Flag off
  // keeps the jittered legacy spawn byte-for-byte.
  if (admissionControlEnabled()) {
    pumpAdmissionQueueOnce();
  } else {
    const jmax = startJitterMaxMs();
    const jitterMs = jmax === 0 ? 0 : crypto.randomInt(0, jmax);
    if (jitterMs > 0) setTimeout(() => spawnSupervisor(jobId), jitterMs);
    else spawnSupervisor(jobId);
  }
  maybeOpenLiveView(jobId);
  const updated = readJob(jobId);
  return { job: toPublicView(updated ?? job), warnings };
}

/**
 * Spawn the detached supervisor for a job and persist its identity atomically
 * with the pid. Returns {pid, pidStartedAt} (epoch-ms) for the admission
 * lease transfer, or null when the spawn or the identity capture failed — a
 * supervisor without a captured creation identity must never be treated as a
 * transferable owner (PID reuse protection), so the admission controller
 * releases the lease instead.
 */
function spawnSupervisor(jobId: string): { pid: number; pidStartedAt: number } | null {
  const hook = admissionPumpTestHooks.spawnSupervisor;
  if (hook) {
    const identity = hook(jobId);
    if (identity === null) return null;
    if (!Number.isInteger(identity.pid) || identity.pid <= 0 ||
        !Number.isInteger(identity.pidStartedAt) || identity.pidStartedAt <= 0) return null;
    // Test seam: persist the fake identity exactly like the production shape
    // (pid + ISO creation time) so the record is byte-compatible with a real
    // spawn; no process is ever started.
    updateJob(jobId, {
      supervisorPid: identity.pid,
      supervisorPidStartedAt: new Date(identity.pidStartedAt).toISOString(),
    });
    return identity;
  }
  // Background process: on Windows the supervisor's node.exe must not pop a
  // console window (spawnBackground sets windowsHide there).
  const child = spawnBackground(process.execPath, [supervisorEntry, '--job', jobId], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  const pid = child.pid ?? null;
  child.unref();
  if (!pid) return null;
  // Capture the child's OS creation identity right after spawn and persist it
  // atomically with the pid. A pid without an identity is never killed or
  // attached (PID reuse protection).
  const iso = capturePidStartedAt(pid);
  let pidStartedAt = iso === null ? null : Date.parse(iso);
  if (!Number.isInteger(pidStartedAt) || (pidStartedAt as number) <= 0) {
    // Fallback: the registry's own OS query may succeed when the retry loop's
    // first attempts raced the process creation.
    pidStartedAt = queryPidStartedAt(pid);
  }
  updateJob(jobId, { supervisorPid: pid, supervisorPidStartedAt: iso });
  if (!Number.isInteger(pidStartedAt) || (pidStartedAt as number) <= 0) return null;
  return { pid, pidStartedAt: pidStartedAt as number };
}

// Whether a live viewer should open for a job. Windows only, and explicitly
// enabled only with OPEN_LIVE_VIEW=1 (default off: unset, empty, '0', or any
// other value are off). Pure so tests can exercise the gate on any platform
// without opening a real window.
export function shouldOpenLiveView(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return env.OPEN_LIVE_VIEW === '1' && platform === 'win32';
}

// The exact spawn intent the live viewer launcher uses. Exposed so tests can
// assert the production call shape (cmd /c start <spaced-title> ...) without
// opening a real window.
export interface ViewerLaunchIntent {
  command: 'cmd.exe';
  args: string[];
  options: { detached: true; stdio: 'ignore' };
}

// Test seam (mirrors watchTestHooks / recoverJobsTestHooks): lets tests observe
// live-viewer launch decisions (OPEN_LIVE_VIEW gate, one-viewer-per-session,
// reply reuse) without ever opening a real window. Production never sets it.
export const liveViewTestHooks: { launch?: (jobId: string, intent: ViewerLaunchIntent) => void } = {};

// Open a dedicated, human-visible console window for a job (Windows only). The
// viewer tails the job's stdout/stderr logs and follows the session chain so
// `reply` jobs stream into the same window. It is a human convenience only:
// sol's programmatic visibility always goes through the MCP tools, never the
// window. Enable explicitly with OPEN_LIVE_VIEW=1 (default off).
function maybeOpenLiveView(jobId: string): void {
  if (!shouldOpenLiveView()) return;
  const nodePath = process.execPath;
  const viewerPath = path.join(SERVER_ROOT, 'dist', 'viewer.js');
  // Title must contain a space so Node quotes it (cmd `start` otherwise treats
  // an unquoted first token as the PROGRAM, not the title). Pass paths WITHOUT
  // manual quotes — Node quotes them; wrapping them in literal quotes here
  // double-escapes and breaks the command line.
  const title = `Claude-CC ${jobId.slice(0, 8)}`;
  const intent: ViewerLaunchIntent = {
    command: 'cmd.exe',
    args: ['/c', 'start', title, nodePath, viewerPath, jobId],
    options: { detached: true, stdio: 'ignore' },
  };
  if (liveViewTestHooks.launch) {
    liveViewTestHooks.launch(jobId, intent);
    return;
  }
  try {
    // spawnViewerLauncher hides ONLY the short-lived cmd host window. cmd's
    // `start` opens the final viewer in its own NEW console window, so the
    // viewer stays explicitly visible and never inherits the background hide
    // policy.
    const child = spawnViewerLauncher(intent.command, intent.args, intent.options);
    child.unref();
  } catch {
    // A viewer must never fail a start.
  }
}

export function getStatus(jobId: string, progressChars = 300): JobView & { progress: string } {
  const job = readJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  return { ...toPublicView(job), progress: readLogTail(jobId, progressChars) };
}

// Readable status tail: renders the last few stream-json events (assistant
// text / tool calls / result) plus the last stderr meta lines, so sol sees the
// worker's actual recent output and the "why it ended" banner without ever
// receiving raw stream-json or a half-JSON chunk. Bounded by TailOptions.
export function getRenderedStatus(jobId: string, opts: TailOptions = {}): JobView & { progress: string } {
  const job = readJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  return { ...toPublicView(job), progress: renderedTail(jobId, opts) };
}

function viewOrThrow(jobId: string): JobView {
  const job = readJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  return toPublicView(job);
}

export async function waitForJob(jobId: string, waitSeconds = WAIT_MAX_SECONDS): Promise<JobView> {
  const requested = clampWaitSeconds(waitSeconds);
  const deadline = Date.now() + requested * 1000;
  let last = viewOrThrow(jobId);
  while (Date.now() < deadline) {
    if (isTerminal(last.status) || last.status === 'needs_attention') return last;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, remaining)));
    last = viewOrThrow(jobId);
  }
  // Final catch-up check so a job that finishes right at the deadline is not
  // reported as still running.
  last = viewOrThrow(jobId);
  return last;
}

// ---------------------------------------------------------------------------
// claude_code_watch: event-driven wait.
//
// Unlike `wait` (a bounded poll), `watch` stays suspended until the job reaches
// a terminal state or needs_attention, or a watch-level outcome occurs
// (timeout / client abort / not-found / internal-error). It NEVER returns
// `running` while the job is running, so it costs zero model turns. State
// changes are observed through the shared JobEventBroker (directory fs.watch +
// internal fallback), not by polling. A client abort only tears down this
// watcher; it never cancels the job, kills a worker, or changes job state.
// ---------------------------------------------------------------------------

export type WatchWakeReason =
  | 'terminal'
  | 'needs_attention'
  | 'watch_timeout'
  | 'watch_cancelled'
  | 'not_found'
  | 'internal_error';

export type WatchStatus = JobStatus | 'watch_timeout' | 'watch_cancelled' | 'not_found' | 'internal_error';

export interface WatchView {
  jobId: string;
  status: WatchStatus;
  wakeReason: WatchWakeReason;
  substatus: string | null;
  elapsedSeconds: number;
  idleSeconds: number | null;
  reportPath: string;
  hasReport: boolean;
  /** Minimal human-readable hint; present only for needs_attention. */
  attention?: string;
  /** Sanitized structured attention summary; present only for needs_attention. */
  attentionDetail?: AttentionSummary | null;
  // Deliverable contract (research/analysis only; optional, old jobs omit it).
  // Mirrors JobView: taskType, the exact absolute deliverablePath, the SHA-256
  // deliverableHash of a valid artifact, and missingDeliverable=true when the
  // artifact was absent/invalid at terminal time. Never the report content.
  taskType?: TaskType;
  deliverablePath?: string;
  deliverableHash?: string;
  missingDeliverable?: boolean;
  // Worker backend / reply-mode mirrors (Wave 3B): which adapter ran this job
  // and whether the current execution is a resume or a fresh bounded turn.
  // workerBackend appears only when the job explicitly selected one (legacy
  // default jobs omit it); replyMode is always present with null when the job
  // never went through reply preflight. Mirrors JobView exactly.
  workerBackend?: WorkerBackend;
  replyMode: ReplyMode | null;
  // Historical leader-decision record (read compatibility only): mirrors
  // JobView — present only when the zero-exit final output handed the decision
  // up (failed + substatus leader_decision_required). Never carried by a
  // reply-created follow-up job.
  leaderDecision?: LeaderDecisionRecord;
}

export function clampWatchSeconds(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return WATCH_DEFAULT_SECONDS;
  return Math.min(Math.max(WATCH_MIN_SECONDS, Math.floor(n)), WATCH_MAX_SECONDS);
}

function watchWakeFor(status: JobStatus): WatchWakeReason | null {
  if (status === 'needs_attention') return 'needs_attention';
  if (isTerminal(status)) return 'terminal';
  return null;
}

function attentionHint(job: Job): string {
  if (job.substatus === 'permission_request' || job.substatus === 'permission_required') {
    return '需要审批：Claude 请求权限，用 claude_code_reply 注入答复';
  }
  return `需要审批（${job.substatus ?? 'unspecified'}），用 claude_code_reply 处理`;
}

function lastAttention(job: Job): AttentionSummary | null {
  if (!job.attentionLog || job.attentionLog.length === 0) return null;
  return job.attentionLog[job.attentionLog.length - 1];
}

// Keep `status` and `wakeReason` as distinct contracts. `status` mirrors the
// job's real state for terminal/needs_attention, or the watch-level outcome
// otherwise; `wakeReason` always says WHAT ended the watch. 'terminal' is a
// wake-reason only, never a status value.
function watchStatusValue(wakeReason: WatchWakeReason, job: Job | null): WatchStatus {
  if (job && (wakeReason === 'terminal' || wakeReason === 'needs_attention')) {
    return job.status;
  }
  // Watch-level outcomes are valid WatchStatus values. A defensive fallback
  // covers the (impossible) terminal/attention-without-job pairing.
  return wakeReason === 'terminal' || wakeReason === 'needs_attention' ? 'internal_error' : wakeReason;
}

function watchViewFromJob(jobId: string, job: Job | null, wakeReason: WatchWakeReason): WatchView {
  const view: WatchView = {
    jobId,
    status: watchStatusValue(wakeReason, job),
    wakeReason,
    substatus: null,
    elapsedSeconds: 0,
    idleSeconds: null,
    reportPath: '',
    hasReport: false,
    // Wave 3B: replyMode is a first-class key in the watch result — always
    // present (null for jobs that never went through reply preflight). Mirrors
    // toPublicView's unconditional `replyMode: job.replyMode ?? null`; the
    // legacy 8-key shape keeps its replyMode-null slot without materializing
    // undefined keys.
    replyMode: null,
  };
  if (!job) return view;
  const pub = toPublicView(job);
  view.substatus = job.substatus;
  view.elapsedSeconds = pub.runningSeconds ?? 0;
  view.idleSeconds = pub.idleSeconds;
  view.reportPath = job.reportPath;
  view.hasReport = pub.hasReport;
  // Worker-backend mirror: included only when the job record explicitly
  // selected one (conditional assignment, exactly like toPublicView) so a
  // legacy default-backend job keeps the compact view shape.
  if (job.workerBackend) view.workerBackend = job.workerBackend;
  view.replyMode = job.replyMode ?? null;
  // Deliverable contract fields: include each ONLY when the corresponding job
  // field is actually defined (mirrors toPublicView). Unconditional assignment
  // would materialize `key: undefined` on every execution job and change the
  // legacy 8-key WatchView shape. missingDeliverable must test "defined", not
  // truthiness, so research/analysis `missingDeliverable=false` is preserved.
  if (job.taskType) view.taskType = job.taskType;
  if (job.deliverablePath) view.deliverablePath = job.deliverablePath;
  if (job.deliverableHash) view.deliverableHash = job.deliverableHash;
  if (job.missingDeliverable !== undefined) view.missingDeliverable = job.missingDeliverable;
  if (job.status === 'needs_attention') {
    const att = lastAttention(job);
    view.attentionDetail = att;
    view.attention = att?.message ?? attentionHint(job);
  }
  if (job.leaderDecision) view.leaderDecision = job.leaderDecision;
  return view;
}

// Test seam (mirrors atomicWriteTestHooks): lets tests complete a job exactly in
// the check/subscribe re-read window so the check/subscribe race is verified
// deterministically.
export const watchTestHooks: { beforeRecheck?: (jobId: string) => void } = {};

// Test seam for the recovery read→write window: lets tests drive a job into a
// terminal state between recovery's outer read and its guarded update, so the
// terminal-state race is verified deterministically.
export const recoverJobsTestHooks: { beforeUpdate?: (jobId: string) => void } = {};

export async function watchJob(
  jobId: string,
  opts: { timeoutSeconds?: number; signal?: AbortSignal } = {},
): Promise<WatchView> {
  if (typeof jobId !== 'string' || jobId.length === 0) {
    throw new Error('jobId must be a non-empty string');
  }
  try {
    return await watchJobInner(jobId, opts);
  } catch {
    // A watch must never die with an untyped error; surface an explicit
    // watch-level outcome so the leader can decide (re-watch / investigate).
    return watchViewFromJob(jobId, readJob(jobId), 'internal_error');
  }
}

async function watchJobInner(
  jobId: string,
  opts: { timeoutSeconds?: number; signal?: AbortSignal },
): Promise<WatchView> {
  const timeoutSeconds = clampWatchSeconds(opts.timeoutSeconds);
  const deadline = Date.now() + timeoutSeconds * 1000;
  const broker = getJobEventBroker();

  // 1) Read current state. Already terminal / needs_attention => return now.
  const first = readJob(jobId);
  if (!first) return watchViewFromJob(jobId, null, 'not_found');
  const early = watchWakeFor(first.status);
  if (early) return watchViewFromJob(jobId, first, early);

  return new Promise<WatchView>((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let timer: NodeJS.Timeout | null = null;

    const finish = (view: WatchView): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(view);
    };
    const cleanup = (): void => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      const cur = readJob(jobId);
      const st = cur ? watchWakeFor(cur.status) : null;
      // Client abort only ends THIS watch; the job is untouched.
      finish(watchViewFromJob(jobId, cur, st ?? 'watch_cancelled'));
    };
    const onEvent = (): void => {
      const cur = readJob(jobId);
      if (!cur) {
        finish(watchViewFromJob(jobId, null, 'not_found'));
        return;
      }
      const st = watchWakeFor(cur.status);
      if (st) finish(watchViewFromJob(jobId, cur, st));
      // Not a target state yet -> keep waiting (fallback will re-check).
    };

    // 2) Register the listener BEFORE the re-read.
    unsubscribe = broker.subscribe(jobId, onEvent);

    // 3) Re-read to eliminate the check/subscribe race: a job that reaches a
    // target state between the first read and the subscribe is caught here (or
    // by the just-registered listener / the broker fallback).
    if (watchTestHooks.beforeRecheck) {
      try {
        watchTestHooks.beforeRecheck(jobId);
      } catch {
        /* a test seam must never break the watch */
      }
    }
    const re = readJob(jobId);
    if (!re) {
      finish(watchViewFromJob(jobId, null, 'not_found'));
      return;
    }
    const reSt = watchWakeFor(re.status);
    if (reSt) {
      finish(watchViewFromJob(jobId, re, reSt));
      return;
    }

    // 4) Abort wiring (MCP client cancel / disconnect).
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    // 5) Watch timeout: bounded, never cancels the job.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      finish(watchViewFromJob(jobId, readJob(jobId), 'watch_timeout'));
      return;
    }
    timer = setTimeout(() => finish(watchViewFromJob(jobId, readJob(jobId), 'watch_timeout')), remaining);
  });
}

// Stage 2A response audit: a sanitized, pure-observability record written on a
// NEW reply job when the leader replies to a needs_attention job. It snapshots
// the observed attention (never the reply prompt / user prompt / token / raw
// log) and always marks authorization=false — a reply only resumes the session.
function buildResponseAudit(base: Job, recordedAt: string): AttentionResponseAudit {
  const last =
    base.attentionLog && base.attentionLog.length > 0 ? base.attentionLog[base.attentionLog.length - 1] : null;
  return {
    kind: 'leader_reply_submitted',
    recordedAt,
    attention: last ? toAttentionSnapshot(last) : null,
    effect: 'resume_requested',
    authorization: false,
  };
}

// T2C: byte size of the parent job's own log file, captured at reply creation
// so the child's transcriptBytesBefore is the resume baseline. Safe read: any
// absence, read error, or non-finite size yields 0 (never throws); negative
// sizes are clamped to 0.
function parentTranscriptBytes(base: Job): number {
  try {
    const size = fs.statSync(base.logPath).size;
    return Number.isFinite(size) ? Math.max(0, size) : 0;
  } catch {
    return 0;
  }
}

export interface ReplyOptions {
  /** Explicit override: allow resuming a Claude session past the transcript cap. */
  allowLargeResume?: boolean;
  /** Explicit override: allow a fresh bounded turn for a one-shot backend. */
  allowFreshTurn?: boolean;
}

export function replyJob(
  jobId: string,
  prompt: string,
  opts: ReplyOptions = {},
): { job: JobView; warnings: string[] } {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('prompt must be a non-empty string');
  }
  const warnings: string[] = [];
  const base = readJob(jobId);
  if (!base) throw new Error(`job not found: ${jobId}`);
  // F1: the reply spawns its own supervisor, so the same whitelist caveat
  // applies to it (see workerPolicyWarnings above).
  warnings.push(...workerPolicyWarnings());

  // Giant-session guard: resuming a multi-day worker session re-sends its full
  // transcript every turn (observed in the wild: an 18.6 MB screenshot-inflated
  // session). Surface a bounded warning so the leader prefers a fresh start.
  if (base.sessionId && base.workFolder) {
    const projectsRoot = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude', 'projects',
    );
    const munged = base.workFolder.replace(/[^a-zA-Z0-9]/g, '-');
    const transcript = path.join(projectsRoot, munged, `${base.sessionId}.jsonl`);
    try {
      const st = fs.statSync(transcript);
      if (st.size > 4 * 1024 * 1024) {
        warnings.push(
          `reply: session transcript is ${(st.size / (1024 * 1024)).toFixed(1)} MB — ` +
            'resending it every turn costs quota and dilutes focus; prefer a fresh start with minimal context',
        );
      }
    } catch {
      /* transcript not found (different layout or already pruned) — best effort */
    }
  }

  // Wave 3B reply preflight (flag-gated; flag off keeps the legacy path
  // byte-for-byte identical). Runs BEFORE any kill/supersede/createJobRecord/
  // spawn side effect: a denied reply throws synchronously with a fixed code
  // prefix and nothing on disk or in process state changes.
  let replyMode: ReplyMode | null = null;
  let replySessionId = base.sessionId;
  // Wave 3B reply preflight. The HARNESS branch is unconditional — a reply to
  // a deepseek-harness job is capability-gated regardless of the feature flag
  // (the adapter is one-shot: a reply without explicit fresh-turn authorization
  // must fail fast, never silently fake a "resume"). It runs BEFORE any
  // kill/supersede/createJobRecord/spawn side effect: a denied reply throws
  // synchronously with a fixed code prefix and nothing on disk or in process
  // state changes. The Claude branch stays flag-gated: flag off keeps the
  // legacy path byte-for-byte identical.
  if (base.workerBackend === 'deepseek-harness') {
    const harnessPreflight: ReplyPreflight = evaluateReplyPreflight(
      'deepseek-harness',
      0,
      {
        allowLargeResume: false,
        allowFreshTurn: opts.allowFreshTurn === true,
        maxBytes: 0,
      },
    );
    if (!harnessPreflight.allowed) {
      throw new Error(
        `${harnessPreflight.code}: reply to a deepseek-harness job requires an explicit fresh-turn override ` +
          '(the one-shot adapter never resumes a session); pass allowFreshTurn=true to run a new independent bounded turn ' +
          `(backend=${harnessPreflight.backend})`,
      );
    }
    // Explicit fresh-turn authorization: a NEW session id, replyMode=fresh_turn,
    // and an explicit warning that this is a new bounded turn, not a resume.
    // The reply record keeps lineage via replyToJobId only.
    replyMode = 'fresh_turn';
    replySessionId = newSessionId();
    warnings.push(
      `reply: fresh_turn mode — parent session ${base.sessionId} is NOT resumed; ` +
        `this reply runs as a new independent turn in session ${replySessionId}`,
    );
  } else if (replyPreflightEnabled() && base.sessionId && base.workFolder) {
    const projectsRoot = path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.claude', 'projects',
    );
    const munged = base.workFolder.replace(/[^a-zA-Z0-9]/g, '-');
    const transcript = path.join(projectsRoot, munged, `${base.sessionId}.jsonl`);
    // Transcript size: absent/unreadable transcript counts as 0 bytes.
    let bytes = 0;
    try {
      const st = fs.statSync(transcript);
      bytes = st.size;
    } catch {
      /* transcript not found (different layout or already pruned) — 0 bytes */
    }
    const preflight: ReplyPreflight = evaluateReplyPreflight(
      base.workerBackend ?? 'claude',
      bytes,
      {
        allowLargeResume: opts.allowLargeResume === true,
        allowFreshTurn: opts.allowFreshTurn === true,
        maxBytes: replyTranscriptMaxBytes(),
      },
    );
    if (!preflight.allowed) {
      throw new Error(
        `${preflight.code}: reply denied by preflight (backend=${preflight.backend}, bytes=${bytes}, threshold=${preflight.threshold}); ` +
          'start a new job or pass the explicit override (allowLargeResume/allowFreshTurn)',
      );
    }
    if (preflight.replyMode) replyMode = preflight.replyMode;
    if (replyMode === 'fresh_turn') {
      // A fresh bounded turn uses a NEW session id and explicitly does NOT
      // resume the parent session; the reply record keeps the lineage via
      // replyToJobId. Safe warning only — bytes/threshold are never exposed.
      replySessionId = newSessionId();
      warnings.push(
        `reply: fresh_turn mode — parent session ${base.sessionId} is NOT resumed; ` +
          `this reply runs as a new independent turn in session ${replySessionId}`,
      );
    } else if (replyMode === 'resume_session' && bytes > preflight.threshold) {
      warnings.push(
        `reply: session transcript is ${(bytes / (1024 * 1024)).toFixed(1)} MB ` +
          `(threshold ${(preflight.threshold / (1024 * 1024)).toFixed(1)} MB) — ` +
          'resuming anyway per explicit allowLargeResume',
      );
    }
  }

  // One active process per session. If the referenced job's claude process is
  // identity-verified live (e.g. blocked waiting on a permission request),
  // terminate it before resuming so we never have two writers on the same
  // session. A pid that cannot be verified is NEVER killed (PID reuse
  // protection): we record a concise conservative diagnostic instead.
  // Fresh-turn replies do NOT resume the parent session, so they skip the
  // kill/critical-section/supersede guards entirely (their session id is new
  // and no other writer can be holding it).
  let oldWorkerWasLive = false;
  if (replyMode !== 'fresh_turn' && base.pid) {
    const identity = pidIdentityStatus(base.pid, base.pidStartedAt);
    const mightBeLive =
      identity === 'verified_live' || (identity === 'no_identity' && isAlive(base.pid));
    if (base.status === 'running' && mightBeLive) {
      throw new Error(`job is still running: ${jobId} (wait or cancel first)`);
    }
    const killDiag = killTreeVerified(base.pid, base.pidStartedAt);
    if (killDiag !== null) {
      warnings.push(`reply: worker pid ${base.pid} not killed (${killDiag}); stale worker may remain`);
    } else {
      oldWorkerWasLive = mightBeLive;
    }
  }

  // Critical-section guard: after killing the previous worker, wait (bounded,
  // at most 2000ms, synchronous Atomics.sleep so the whole reply stays atomic
  // within this single-threaded process) for the old process to actually exit
  // before spawning its replacement — two writers must never overlap on one
  // Claude session.
  if (replyMode !== 'fresh_turn' && oldWorkerWasLive && base.pid) {
    const deadline = Date.now() + 2000;
    while (isAlive(base.pid) && Date.now() < deadline) {
      Atomics.wait(replyPollBuffer, 0, 0, 50);
    }
  }

  // Session-level single-writer guard (supersede semantics): any OTHER
  // non-terminal reply job on this session holds — or is about to hold — a
  // second `--resume` writer. The newest instruction wins: cancel the older
  // in-flight reply trees before spawning ours. Audits already recorded on
  // superseded jobs stay readable; the original job's own record is untouched.
  // (replyJob is synchronous, but two SEQUENTIAL tool calls both pass the
  // per-job checks above because the original job's status never changes —
  // only this session-wide scan closes that window.)
  if (replyMode !== 'fresh_turn') {
    try {
      // Wave 5A2b1 supersede scan: retention on uses the session index (O(k)
      // ids, each verified with readJob — the index is a hint, the job JSON is
      // the truth, so a bad/deleted id is silently skipped); flag off keeps
      // the legacy listJobs(1000) scan exactly as before. Both paths apply the
      // same filters below: same session, kind=reply, not the current base,
      // not terminal.
      if (retentionV2Enabled()) {
        for (const id of indexedJobIdsForSession(base.sessionId)) {
          const j = readJob(id);
          if (!j) continue;
          if (j.jobId === jobId) continue;
          if (j.kind !== 'reply' || j.sessionId !== base.sessionId) continue;
          if (isTerminal(j.status) || j.status === 'cancelled') continue;
          cancelJob(j.jobId, 'superseded by a newer reply on the same session');
          warnings.push(`reply: superseded in-flight reply ${j.jobId} (${j.status}) on the same session`);
        }
      } else {
        for (const j of listJobs(1000)) {
          if (j.jobId === jobId) continue;
          if (j.kind !== 'reply' || j.sessionId !== base.sessionId) continue;
          if (isTerminal(j.status) || j.status === 'cancelled') continue;
          cancelJob(j.jobId, 'superseded by a newer reply on the same session');
          warnings.push(`reply: superseded in-flight reply ${j.jobId} (${j.status}) on the same session`);
        }
      }
    } catch (e) {
      warnings.push(`reply: supersede scan failed: ${String(e)}`);
    }
  }

  ensureRuntimeDirs();
  const replyId = newJobId();
  const startedAt = new Date().toISOString();
  // T2C reply lifecycle init (metrics + budgetStatus). Metrics always derive
  // from THIS reply's own prompt and the parent's persisted log/metrics —
  // the parent metrics object reference is never passed to the child.
  const replyMetrics: JobMetricsV2 | undefined = metricsV2Enabled()
    ? createJobMetrics({
        promptChars: prompt.length,
        // Safe read of the parent job's log file: absent/unreadable = 0.
        transcriptBytesBefore: parentTranscriptBytes(base),
        // Parent depth wins; a reply chained on a reply counts the chain
        // depth, a start parent counts 1. Clamped to REPLY_DEPTH_MAX.
        replyDepth: Math.min(
          (base.metrics?.replyDepth ?? (base.kind === 'reply' ? 1 : 0)) + 1,
          REPLY_DEPTH_MAX,
        ),
      })
    : undefined;
  // Budget inheritance: flag on AND the parent's contract is inherited below
  // -> this reply is in force ('active'); otherwise explicitly 'not_requested'.
  // Parent budget violation / completeness are never inherited.
  const replyBudgetStatus = budgetEnforcementEnabled() && base.contract !== undefined ? 'active' : 'not_requested';
  const reply: Job = {
    jobId: replyId,
    // resume_session keeps the parent session; fresh_turn uses a NEW session
    // (set by the preflight block above). Legacy/flag-off replies keep the
    // historical sessionId inheritance exactly as before.
    sessionId: replySessionId,
    kind: 'reply',
    replyToJobId: base.jobId,
    profile: base.profile,
    port: base.port,
    permissionMode: base.permissionMode,
    parallelism: base.parallelism,
    workFolder: base.workFolder,
    maxRuntimeMinutes: base.maxRuntimeMinutes,
    pid: null,
    supervisorPid: null,
    status: 'queued',
    // Wave 4B2b2: admission flag on -> the reply also waits in the admission
    // queue (substatus admission_wait); flag off -> legacy null.
    substatus: admissionControlEnabled() ? 'admission_wait' : null,
    startedAt,
    endedAt: null,
    lastActivityAt: startedAt,
    exitCode: null,
    logPath: logFilePath(replyId),
    stderrLogPath: stderrLogFilePath(replyId),
    reportPath: reportFilePath(replyId),
    // Wave 3B: when a reply is allowed by preflight, the execution context
    // (backend + replyMode) is passed into the prompt builder so the worker
    // sees the correct execution semantics (harness fresh_turn = independent
    // bounded turn, never a fake "resume"; claude resume_session = persisted
    // session continuation). Legacy/flag-off Claude replies omit the 5th arg and
    // stay byte-for-byte historical; harness replies always carry the
    // fresh_turn context (their preflight is unconditional).
    prompt: buildPrompt(
      base.profile as Profile,
      prompt,
      base.parallelism as Parallelism,
      {
        taskType: base.taskType,
        deliverablePath: base.deliverablePath,
      },
      replyMode ? { backend: base.workerBackend ?? 'claude', replyMode } : undefined,
    ),
    claudeCli: base.claudeCli,
    claudePrefix: base.claudePrefix,
    extraEnv: base.extraEnv,
    workerBackend: base.workerBackend ?? 'claude',
    // Wave 3B: replyMode is set for every preflight-allowed reply (Claude
    // resume/fresh under the flag, and ALL harness replies — their preflight is
    // unconditional). Legacy/flag-off Claude replies omit it and the view
    // reports null.
    ...(replyMode !== null ? { replyMode } : {}),
    // Reply jobs inherit the referenced job's taskType and the EXACT
    // deliverablePath (same artifact is continued/fixed); they cannot choose a
    // new path. deliverableHash/missingDeliverable are NOT inherited — they are
    // recomputed by the supervisor at this reply's terminal time. The same
    // non-inheritance holds for the legacy leaderDecision field. New jobs
    // never receive it (fresh literal below — never spreads the base record).
    taskType: base.taskType,
    deliverablePath: base.deliverablePath,
    artifactWriteException: base.artifactWriteException === true ? true : undefined,
    lastOutputAt: startedAt,
    // T1E Contract V2 inheritance — explicit mirrors on every reply record
    // (never left to toPublicView fallback). A reply resumes the parent's
    // session and artifact, so it inherits the parent contract when present;
    // the flag alone decides whether it becomes an EXECUTED contract (pending)
    // or stays internal observability (not_requested, exactly like a V1 start).
    ...(base.contract ? { contract: base.contract } : {}),
    workerStatus: 'queued',
    // T1E acceptance contract for a reply: only a Contract V2 flag AND a
    // parent contract make this reply an EXECUTED contract (pending);
    // otherwise it stays not_requested exactly like a V1 reply.
    acceptanceStatus: contractV2Enabled() && base.contract ? 'pending' : 'not_requested',
    gateResults: [],
    // T2C lifecycle initialization (metrics + budgetStatus). The metrics are
    // this reply's OWN aggregates (see replyMetrics above) and the budget
    // status is this reply's own enforcement state — the parent's budget
    // violation and reportCompleteness are never copied onto the child.
    ...(replyMetrics !== undefined ? { metrics: replyMetrics } : {}),
    budgetStatus: replyBudgetStatus,
    // Wave 4B2b2 admission persistence for a reply: flag on -> the reply waits
    // in the admission queue exactly like a start. It inherits the parent's
    // desired concurrency (no reply-specific override in this unit) and its
    // admission resource class (the parent contract's class when present).
    ...(admissionControlEnabled()
      ? {
          desiredWorkerConcurrency: base.desiredWorkerConcurrency ?? desiredWorkerConcurrencyDefault(),
          admissionState: 'queued' as const,
          admissionResourceClass: (base.contract?.admission?.resourceClass ?? 'light') as 'light' | 'build' | 'heavy',
          admissionQueueReason: null,
          queuedAt: startedAt,
          admittedAt: null,
          activeWorkers: 0,
          queuedWorkers: 0,
          resourceLimit: null,
        }
      : {}),
    // Reply jobs carry their own independent bootstrap checkpoint; session
    // lineage (sessionId + replyToJobId) is preserved by the fields above.
    bootstrap: newBootstrap('job_persisted', startedAt),
  };
  // Stage 2A: pure observability — only when the target job is currently
  // needs_attention AND this reply job is being created, record a sanitized
  // response audit on the NEW reply job. The old job is never modified and
  // nothing here authorizes an action.
  if (base.status === 'needs_attention') {
    reply.attentionResponseAudit = buildResponseAudit(base, startedAt);
  }
  if (!createJobRecord(reply)) {
    throw new Error(`reply creation failed (concurrent holder): ${replyId}`);
  }
  // Wave 4B2b2: admission flag on -> the reply is enqueued for the admission
  // pump (its desired concurrency is inherited, never overridden here); flag
  // off keeps the legacy direct spawn.
  if (admissionControlEnabled()) pumpAdmissionQueueOnce();
  else spawnSupervisor(replyId);
  const updated = readJob(replyId);
  return { job: toPublicView(updated ?? reply), warnings };
}

export function cancelJob(jobId: string, reason?: string): JobView {
  const job = readJob(jobId);
  if (!job) throw new Error(`job not found: ${jobId}`);
  if (job.status === 'cancelled') {
    return toPublicView(job);
  }
  if (isTerminal(job.status)) {
    return toPublicView(job);
  }
  const now = new Date().toISOString();
  // CAS guard: only a non-terminal, non-cancelled job may be cancelled. If a
  // concurrent writer reached a terminal state first, cancel loses and must
  // never regress it.
  const updated = updateJobIf(
    jobId,
    (j) => !isTerminal(j.status) && j.status !== 'cancelled',
    { status: 'cancelled', substatus: reason || 'cancelled', endedAt: now },
  );
  if (!updated) {
    const latest = readJob(jobId);
    return toPublicView(latest ?? job);
  }
  // Kill only on identity match. A pid that cannot be verified as OUR live
  // child is never killed (PID reuse protection); record a concise diagnostic.
  if (job.pid) {
    const diag = killTreeVerified(job.pid, job.pidStartedAt);
    if (diag !== null) {
      appendStderrLog(jobId, `\n===== cancel: worker pid ${job.pid} not killed (${diag}) =====\n`);
    }
  }
  if (job.supervisorPid && job.supervisorPid !== process.pid) {
    const diag = killTreeVerified(job.supervisorPid, job.supervisorPidStartedAt);
    if (diag !== null) {
      appendStderrLog(jobId, `\n===== cancel: supervisor pid ${job.supervisorPid} not killed (${diag}) =====\n`);
    }
  }
  appendStderrLog(jobId, `\n===== cancelled by request (reason: ${reason || 'unspecified'}) =====\n`);
  const final = readJob(jobId);
  return toPublicView(final ?? updated);
}

export function listJobsView(limit = 20): JobView[] {
  return listJobs(limit).map(toPublicView);
}

// Called on MCP server startup. Re-attaches to in-flight jobs from the job
// store so a restart never loses or wrongly fails a live task, and resumes a
// scheduler-owned bootstrap only where that is PROVABLY safe (see the stage
// decision matrix below). Recovery NEVER replays Claude tool steps or approved
// actions; Claude content resumption remains the job of session/reply.
export interface RecoveryReport {
  /** Existing contract: "<jobId>:<status>|<outcome>" per job acted on. */
  recovered: string[];
  /** New: sanitized, fixed-token diagnostics (no paths/commands/secrets). */
  diagnostics: string[];
  /** New: how many supervisors recovery spawned (bootstrap resumes). */
  spawned: number;
  /** New: how many stale 'recover' claims were stolen. */
  claimsStolen: number;
}

// A supervisor owns its job for the whole runtime, so its claim lives far
// longer than a recovery pass. Stealing a supervisor claim is only ever decided
// on verified-death, never on expiry, so this value is just metadata.
const SUPERVISOR_CLAIM_LEASE_MS = 8 * 60 * 60 * 1000;

const nowIso = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------
// Same-session reply serialization.
//
// replyJob's read -> kill-old-worker -> createJobRecord -> spawnSupervisor
// sequence is fully synchronous, so within this single-threaded process two
// replies on one session can never interleave. The promise chain below is a
// defense-in-depth gate for the async MCP tool path (replyJobQueued): if any
// future await slips into the critical section, same-session replies still
// queue behind each other instead of double-writing the session. Different
// sessions never block each other.
// ---------------------------------------------------------------------------
const replySessionChains = new Map<string, Promise<unknown>>();

export async function replyJobQueued(
  jobId: string,
  prompt: string,
): Promise<{ job: JobView; warnings: string[] }> {
  const base = readJob(jobId);
  if (!base) throw new Error(`job not found: ${jobId}`);
  const sessionKey = base.sessionId;
  const prev = replySessionChains.get(sessionKey) ?? Promise.resolve();
  const run = prev.then(
    () => replyJob(jobId, prompt),
    () => replyJob(jobId, prompt),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  replySessionChains.set(sessionKey, tail);
  try {
    return await run;
  } finally {
    if (replySessionChains.get(sessionKey) === tail) replySessionChains.delete(sessionKey);
  }
}

// Process-exit poll buffer (sync sleep without spinning the event loop).
const replyPollBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Signal-shutdown cleanup: enumerate every non-terminal job in the store and
 * tree-kill its worker and supervisor pids (identity-verified via
 * killTreeVerified — a reused/unverifiable pid is never killed; refusals are
 * returned as diagnostics). Used by index.ts SIGINT/SIGTERM handlers so an
 * MCP shutdown does not orphan detached supervisors/worker trees.
 */
export function shutdownActiveJobs(): string[] {
  const diagnostics: string[] = [];
  let jobs: Job[] = [];
  try {
    jobs = listJobs(1000);
  } catch {
    return diagnostics;
  }
  for (const job of jobs) {
    if (isTerminal(job.status) || job.status === 'cancelled') continue;
    // Ownership guard: reap only supervisors that are OUR OWN detached children.
    // A leaked second MCP instance's in-flight jobs are not ours to kill — its
    // supervisors are parented by THAT instance, not by this process. The
    // worker pid is covered transitively: it sits inside the supervisor's
    // killTree, so killing our child supervisor takes the worker with it.
    const isOurs =
      !!job.supervisorPid &&
      job.supervisorPid !== process.pid &&
      queryParentPid(job.supervisorPid) === process.pid;
    if (!isOurs) {
      diagnostics.push(`${job.jobId}:supervisor_${job.supervisorPid ?? 'none'}_not_our_child_skip`);
      continue;
    }
    if (job.pid && job.pid !== process.pid) {
      const diag = killTreeVerified(job.pid, job.pidStartedAt);
      if (diag !== null) diagnostics.push(`${job.jobId}:worker_${job.pid}_not_killed(${diag})`);
    }
    if (job.supervisorPid && job.supervisorPid !== process.pid) {
      const diag = killTreeVerified(job.supervisorPid, job.supervisorPidStartedAt);
      if (diag !== null) diagnostics.push(`${job.jobId}:supervisor_${job.supervisorPid}_not_killed(${diag})`);
    }
  }
  return diagnostics;
}

// ---------------------------------------------------------------------------
// Wave 4B2b2 admission pump.
//
// One synchronous pass over every queued + admissionState='queued' job: the
// candidates are handed to a fresh AdmissionController (sorted priority desc /
// queuedAt asc / jobId by the controller), whose launch callback CAS-guards the
// job (still queued/admission_wait, never terminal) BEFORE spawning the
// supervisor, then transfers the lease to the spawned supervisor. Every
// decision writeback is guarded so a cancelled/terminal job is never
// overwritten, and every lease outcome is enforced by the AdmissionManager's
// O_EXCL lock (never a module-level counter), so concurrent MCP instances
// racing the last slot stay safe.
//
// Public results are strictly {ok, state, reason, ...} — runtimeRoot, PID
// identity, env and prompt never leave this file.
// ---------------------------------------------------------------------------

/** Test seam (mirrors watchTestHooks / recoverJobsTestHooks): observes and
 *  deterministically breaks pump runs without touching production logic.
 *  beforePump runs before each controller pass; launch overrides the launch
 *  callback (tests force spawn/transfer failure and cancel jobs mid-pump). */
export const admissionPumpTestHooks: {
  beforePump?: (jobs: Job[]) => void;
  launch?: (candidate: AdmissionCandidate) => LaunchedSupervisor;
  /** Replaces the supervisor spawn identity only (never the launch CAS).
   *  Returning an identity persists supervisorPid/supervisorPidStartedAt exactly
   *  like a real spawn, without starting a process. */
  spawnSupervisor?: (jobId: string) => { pid: number; pidStartedAt: number } | null;
} = {};

/** One fixed queue reason per controller decision; non-AdmissionQueueReason
 *  reasons (invalid_policy / invalid_request / duplicate_job) are mapped to
 *  null (job-store ADMISSION_QUEUE_REASONS must stay in sync). */
const ADMISSION_QUEUE_REASONS: ReadonlySet<string> = new Set<string>([
  'desired_limit',
  'hard_safety_ceiling',
  'backend_profile_limit',
  'memory_reserve',
  'heavy_limit',
  'derived_space_conflict',
  'lock_busy',
]);
function admissionQueueReasonFor(reason: string | null): AdmissionQueueReason | null {
  if (reason === null) return null;
  return ADMISSION_QUEUE_REASONS.has(reason) ? (reason as AdmissionQueueReason) : null;
}

/**
 * Run one admission pass. Synchronous: every controller callback is
 * synchronous (spawnSupervisor yields the pid synchronously), so no interleaved
 * pump can double-decide a candidate. Idempotent per candidate: the launch CAS
 * re-verifies the job is still admission-waiting, so a job already admitted
 * (active) or cancelled by a concurrent writer is skipped without a spawn.
 */
export function pumpAdmissionQueueOnce(): { admitted: number; queued: number; failed: number; skipped: number } {
  const beforePump = admissionPumpTestHooks.beforePump;
  let jobs: Job[] = [];
  try {
    jobs = listJobs(1000);
  } catch {
    return { admitted: 0, queued: 0, failed: 0, skipped: 0 };
  }
  if (beforePump) {
    try {
      beforePump(jobs);
    } catch {
      /* a test seam must never break the pump */
    }
  }
  // Candidate set: still queued and admission-waiting, in controller order.
  const candidates = jobs
    .filter((j) => j.status === 'queued' && j.admissionState === 'queued')
    .map((j) => candidateFor(j))
    .filter((c): c is AdmissionCandidate => c !== null);

  let controller: AdmissionController;
  try {
    const ownerStartedIso = capturePidStartedAt(process.pid);
    const ownerPidStartedAt =
      ownerStartedIso === null ? 1 : Date.parse(ownerStartedIso);
    controller = new AdmissionController({
      runtimeRoot: runtimeRoot(),
      // Live free memory in MiB; a freeMemoryMb of 0 or undefined disables
      // pressure — undefined here keeps memory_reserve inactive.
      freeMemoryMb: () => Math.floor(os.freemem() / 1048576),
      // Current owner identity of this scheduler while it holds newly-acquired
      // leases. The controller hardcodes `new AdmissionManager` without an
      // injectable PID inspector (Wave4A residual constraint), so stale
      // classification relies on the lease TTL — irrelevant within one pump,
      // because ownership is transferred synchronously to the supervisor.
      ownerPid: process.pid,
      ownerPidStartedAt,
      launch: (candidate) => admissionLaunch(candidate),
      terminate: (candidate, supervisor) => admissionTerminate(candidate, supervisor),
    });
  } catch {
    return { admitted: 0, queued: 0, failed: 0, skipped: 0 };
  }

  let decisions: AdmissionDecision[] = [];
  try {
    decisions = controller.pump(candidates);
  } catch {
    /* a controller throw must never break the scheduler */
  }

  // Writebacks for the decisions of THIS pass, each guarded so a concurrent
  // cancel / terminal write is never overwritten.
  const involved = new Set<string>(decisions.map((d) => d.jobId));
  for (const d of decisions) {
    if (d.state === 'queued') writeQueuedDecision(d);
    else if (d.state === 'active') writeActiveDecision(d);
    else if (d.state === 'failed') writeFailedDecision(d);
  }

  // Contract 9: refresh the live admission counts of exactly the jobs this
  // pump touched (queued/active states), without rewriting identical fields.
  if (involved.size > 0) refreshAdmissionCounts(involved);

  let admitted = 0;
  let queued = 0;
  let failed = 0;
  for (const d of decisions) {
    if (d.state === 'active') admitted += 1;
    else if (d.state === 'queued') queued += 1;
    else failed += 1;
  }
  // Jobs that were queued at candidate-build time but skipped by the launch
  // CAS (admitted/cancelled meanwhile by a concurrent writer) are neither
  // written back nor counted.
  const skipped = Math.max(0, candidates.length - decisions.length);
  return { admitted, queued, failed, skipped };
}

function candidateFor(j: Job): AdmissionCandidate | null {
  const resourceClass = j.admissionResourceClass ?? 'light';
  const priority = j.contract?.admission?.priority ?? 0;
  const queuedAt = j.queuedAt ?? j.startedAt;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority < 0 || priority > 3) return null;
  return {
    jobId: j.jobId,
    desiredWorkerConcurrency: j.desiredWorkerConcurrency ?? null,
    resourceClass,
    priority,
    backend: j.workerBackend ?? 'claude',
    profile: j.profile,
    workFolder: j.workFolder,
    queuedAt,
  };
}

/** The launch callback of the pump's controller: CAS-guard the job first, then
 *  spawn. A failed guard or spawn throws so the controller releases the lease
 *  ('supervisor_spawn_failed'); a transfer failure path calls terminate.
 *  admissionPumpTestHooks.launch replaces the SPAWN ONLY — the queued->active
 *  CAS and the identity writeback still run, so a test-faked launch exercises
 *  the same guard/state paths as a real spawn. */
function admissionLaunch(candidate: AdmissionCandidate): LaunchedSupervisor {
  const guard = updateJobIf(
    candidate.jobId,
    // status === 'queued' already excludes cancelled/terminal — the explicit
    // checks are redundant with the store's allowed transitions.
    (j) => j.status === 'queued' && j.admissionState === 'queued',
    { admissionState: 'active', admittedAt: nowIso(), admissionQueueReason: null },
  );
  if (!guard) throw new Error('admission: job no longer queued');
  if (admissionPumpTestHooks.launch) {
    return admissionPumpTestHooks.launch(candidate);
  }
  const identity = spawnSupervisor(candidate.jobId);
  if (identity === null) throw new Error('admission: supervisor spawn failed (identity)');
  return identity;
}

/** Best-effort terminate after a failed lease transfer (failure path only). */
function admissionTerminate(candidate: AdmissionCandidate, supervisor: LaunchedSupervisor): void {
  try {
    // Identity-guarded: only a verified live child is ever killed.
    killTreeVerified(supervisor.pid, new Date(supervisor.pidStartedAt).toISOString());
  } catch {
    /* best effort — the required part is the scheduler's lease release */
  }
}

/** Queued decision writeback: keep the job queued with the fixed queue reason
 *  and the public counts from the evaluation. */
function writeQueuedDecision(d: AdmissionDecision): void {
  updateJobIf(
    d.jobId,
    // status === 'queued' already excludes cancelled/terminal — the explicit
    // checks are redundant with the store's allowed transitions.
    (j) => j.status === 'queued' && j.admissionState === 'queued',
    {
      substatus: 'admission_wait',
      admissionQueueReason: admissionQueueReasonFor(d.reason),
      activeWorkers: d.active,
      queuedWorkers: d.queued,
      resourceLimit: d.resourceLimit,
    },
  );
}

/** Active decision writeback: counts/limit; admissionState/admittedAt were
 *  already persisted by the launch CAS. */
function writeActiveDecision(d: AdmissionDecision): void {
  updateJobIf(
    d.jobId,
    (j) => j.admissionState === 'active' && !isTerminal(j.status) && j.status !== 'cancelled',
    {
      admissionQueueReason: null,
      activeWorkers: d.active,
      queuedWorkers: d.queued,
      resourceLimit: d.resourceLimit,
    },
  );
}

/** Failed decision writeback: mark the job failed with the fixed failure code —
 *  but never overwrite a cancelled/terminal job. */
function writeFailedDecision(d: AdmissionDecision): void {
  const reason = d.reason === 'supervisor_spawn_failed' || d.reason === 'lease_transfer_failed' ? d.reason : 'supervisor_spawn_failed';
  updateJobIf(
    d.jobId,
    (j) => !isTerminal(j.status) && j.status !== 'cancelled',
    {
      status: 'failed',
      substatus: reason,
      endedAt: nowIso(),
      admissionState: 'released',
      admissionQueueReason: null,
      activeWorkers: 0,
      queuedWorkers: 0,
      resourceLimit: null,
    },
  );
}

/** Post-pump counts refresh for exactly the jobs this pass decided into a
 *  live (queued/active) admission state: active = live lease count for the
 *  job (0 when its lease is gone), queued = current admission_wait count from
 *  the store, resourceLimit = the lease's remaining policy limit. Identical
 *  fields are never rewritten. */
function refreshAdmissionCounts(jobIds: ReadonlySet<string>): void {
  let leases: PublicLease[] = [];
  try {
    // Identity-aware manager: a lease whose owner pid is provably alive and
    // matches the recorded creation time counts live (identity wins over the
    // TTL, mirroring classifyLease's contract); a reused/dead pid is archived
    // stale, so a count refresh never resurrects a slot.
    leases = new AdmissionManager({
      runtimeRoot: runtimeRoot(),
      pidIdentity: {
        isAlive: procIsAlive,
        startedAtMatches: (pid, startedAt) => {
          const osStart = procQueryPidStartedAt(pid);
          return osStart !== null && Math.abs(osStart - startedAt) <= 5000;
        },
      },
    }).listLiveLeases();
  } catch {
    /* a lease read failure never breaks the pump; counts stay stale */
  }
  const liveByJob = new Map<string, PublicLease>();
  for (const l of leases) liveByJob.set(l.jobId, l);
  const currentQueued = new Map<string, number>();
  try {
    for (const j of listJobs(1000)) {
      if (j.status === 'queued' && j.admissionState === 'queued') {
        currentQueued.set(j.jobId, (currentQueued.get(j.jobId) ?? 0) + 1);
      }
    }
  } catch {
    /* stale queued count — the guarded writeback below still lands counts */
  }
  for (const jobId of jobIds) {
    const lease = liveByJob.get(jobId) ?? null;
    const active = lease ? 1 : 0;
    const queued = currentQueued.get(jobId) ?? 0;
    updateJobIf(
      jobId,
      (j) =>
        (j.status === 'queued' || j.admissionState === 'active') &&
        !isTerminal(j.status) &&
        j.status !== 'cancelled' &&
        (j.activeWorkers !== active || j.queuedWorkers !== queued),
      { activeWorkers: active, queuedWorkers: queued },
    );
  }
}

let admissionPumpTimer: NodeJS.Timeout | null = null;

/**
 * Start the recurring admission pump (default 1000ms). Same-process idempotent:
 * a second call returns false and starts nothing; the timer is unref'd so it
 * never keeps the process alive, and a throwing pump never kills the server.
 * Flag off -> no-op. Returns true when a timer was (re)started.
 */
export function startAdmissionPump(intervalMs = 1000): boolean {
  if (!admissionControlEnabled()) return false;
  if (admissionPumpTimer !== null) return false;
  const run = (): void => {
    try {
      pumpAdmissionQueueOnce();
    } catch {
      /* a throwing pump must never kill the MCP server */
    }
  };
  admissionPumpTimer = setInterval(run, intervalMs);
  admissionPumpTimer.unref();
  return true;
}

export function recoverJobs(): RecoveryReport {
  ensureRuntimeDirs();
  const report: RecoveryReport = { recovered: [], diagnostics: [], spawned: 0, claimsStolen: 0 };
  const inspector = productionInspector();
  for (const job of listJobs(1000)) {
    try {
      recoverOne(job, report, inspector);
    } catch {
      // One bad job must never break the whole recovery pass.
      report.diagnostics.push(`${job.jobId}:recovery_error`);
    }
  }
  return report;
}

function recoverOne(job: Job, report: RecoveryReport, inspector: ProcessInspector): void {
  const jobId = job.jobId;

  // Wave 4B2b2: an admission-waiting job has no supervisor, no worker and no
  // .done yet — it is never bootstrap-resumable and never failed as
  // interrupted. The admission pump restores it (the scheduler's own live
  // recovery path); a restart must not double-spawn or auto-resume it.
  if (job.status === 'queued' && job.admissionState === 'queued') {
    report.diagnostics.push(`${jobId}:admission_wait_skip`);
    return;
  }

  // 1) A .done marker is terminal truth; apply it and move on. Only a marker
  // that parses AND validates (matching jobId) may update the Job; an invalid /
  // unreadable / mismatched .done is treated as absent so it can never regress
  // or falsely advance the record.
  const done = doneFilePath(jobId);
  if (fs.existsSync(done)) {
    let marker: DoneMarker | null = null;
    try {
      marker = parseDoneMarker(JSON.parse(fs.readFileSync(done, 'utf8')), jobId);
    } catch {
      /* unreadable done file, fall through */
    }
    if (marker) {
      const updated = updateJobIf(
        jobId,
        (j) => !isTerminal(j.status) && j.status !== 'cancelled',
        { status: marker.status, exitCode: marker.exitCode ?? job.exitCode, endedAt: marker.endedAt ?? job.endedAt },
      );
      if (updated) report.recovered.push(`${jobId}:${marker.status}`);
    }
    return;
  }

  // 2) Liveness: a parent-recorded supervisor pid, a supervisor claim that
  // might belong to a live supervisor, and the worker pid. A bare pid
  // (kill(pid,0)) lies under PID reuse, so when a supervisor claim names the
  // SAME pid and its owner is PROVABLY dead, the recorded pid must not count as
  // a live supervisor (recovery would otherwise block forever on a job whose
  // supervisor is actually gone).
  const supClaimState = inspectClaimFile(jobId, 'supervisor');
  const supClaim = supClaimState.kind === 'valid' ? supClaimState.claim : null;
  // A corrupt supervisor claim with a fresh mtime is treated as possibly live
  // (the supervisor may be mid create->write); never spawn over it.
  const supClaimMaybeLive = supClaim
    ? !claimOwnerVerifiedDead(supClaim, inspector)
    : supClaimState.kind === 'corrupt' && claimFileMtimeAgeMs(jobId, 'supervisor', Date.now()) < 5000;
  const supPidAlive =
    !!job.supervisorPid &&
    pidIdentityStatus(job.supervisorPid, job.supervisorPidStartedAt) === 'verified_live';
  const supPidContradictedByClaim =
    !!supClaim &&
    !!job.supervisorPid &&
    supClaim.ownerPid === job.supervisorPid &&
    claimOwnerVerifiedDead(supClaim, inspector);
  const supervisorAlive = supPidAlive && !supPidContradictedByClaim;
  const claudeAlive =
    !!job.pid && pidIdentityStatus(job.pid, job.pidStartedAt) === 'verified_live';

  // Two-factor zombie guard (real-world case fe7e49fc): a supervisor that died
  // without writing .done leaves status=running forever, and its recorded pid
  // may later be REUSED by an unrelated process. When a recorded pid is
  // PROVABLY not our child (gone, or a different process now owns it —
  // creation-time mismatch), a merely "maybe live" corrupt/fresh claim must no
  // longer keep the job attached: fall through to the checkpoint logic, which
  // marks the job failed/interrupted instead of running forever.
  const provablyGone =
    (!!job.supervisorPid && pidIsNotOurChild(job.supervisorPid, job.supervisorPidStartedAt)) ||
    (!!job.pid && pidIsNotOurChild(job.pid, job.pidStartedAt));

  // 3) Live child present -> attach only, never spawn.
  if ((supervisorAlive || claudeAlive) || (supClaimMaybeLive && !provablyGone)) {
    if (recoverJobsTestHooks.beforeUpdate) {
      try {
        recoverJobsTestHooks.beforeUpdate(jobId);
      } catch {
        /* a test seam must never break recovery */
      }
    }
    const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
    const maxMs = job.maxRuntimeMinutes * 60_000;
    if (elapsedMs > maxMs) {
      // maxRuntime hard cap takes priority over needs_attention (unchanged).
      if (job.pid) {
        const diag = killTreeVerified(job.pid, job.pidStartedAt);
        if (diag !== null) report.diagnostics.push(`${jobId}:timeout_worker_not_killed(${diag})`);
      }
      const updated = updateJobIf(
        jobId,
        (j) => !isTerminal(j.status) && j.status !== 'cancelled',
        { status: 'failed', substatus: 'timeout', endedAt: nowIso() },
      );
      if (updated) report.recovered.push(`${jobId}:timeout`);
    } else if (job.status === 'needs_attention') {
      // Preserve a legitimately-published block across an MCP restart. Do NOT
      // downgrade to running: that would lose the blocking signal and make
      // claude_code_reply throw "job is still running". attentionLog /
      // attentionDetail / requestId are preserved by the spread.
      const updated = updateJobIf(
        jobId,
        (j) => j.status === 'needs_attention',
        { status: 'needs_attention', substatus: job.substatus ?? 'permission_request' },
      );
      if (updated) report.recovered.push(`${jobId}:needs_attention`);
    } else {
      const updated = updateJobIf(
        jobId,
        (j) => !isTerminal(j.status) && j.status !== 'cancelled' && j.status !== 'needs_attention',
        { status: 'running', substatus: job.substatus === 'permission_request' ? 'permission_request' : null },
      );
      if (updated) report.recovered.push(`${jobId}:running`);
    }
    return;
  }

  // 4) No live child. Old jobs predate the checkpoint -> existing conservative
  // behavior: never auto-resume (could double-spawn a pre-Stage-6 bootstrap).
  const bp = isValidBootstrap(job.bootstrap) ? job.bootstrap : null;
  if (!bp) {
    const updated = updateJobIf(
      jobId,
      (j) => !isTerminal(j.status) && j.status !== 'cancelled',
      { status: 'failed', substatus: 'interrupted (MCP restart)', endedAt: nowIso() },
    );
    if (updated) report.recovered.push(`${jobId}:failed_interrupted`);
    return;
  }

  // 5) Checkpoint-driven decisions. The ordering rule that makes "never acked
  // => never spawned a worker" hold: the supervisor persists
  // supervisor_acknowledged STRICTLY BEFORE spawning the worker, and a failed
  // ack write makes the supervisor exit without spawning. So a job still at
  // job_persisted has never reached the worker-spawn boundary.
  switch (bp.stage) {
    case 'job_persisted': {
      const supervisorPidDead =
        !!job.supervisorPid && pidIsNotOurChild(job.supervisorPid, job.supervisorPidStartedAt);
      const supClaimDead = !!supClaim && claimOwnerVerifiedDead(supClaim, inspector);
      if (supervisorPidDead || supClaimDead) {
        // Provably no live supervisor, and it never acked -> never spawned a
        // worker -> safe to resume the bootstrap.
        resumeBootstrap(job, report, inspector);
        return;
      }
      // No supervisorPid and no (live) supervisor claim. Either the bootstrap
      // was never spawned, or it was spawned in the tiny window before its
      // pid/claim landed. The supervisor's own bootstrap (claim + ack) completes
      // within ~1s of spawn, so after a generous grace "still unclaimed" is a
      // reliable never-started signal.
      const elapsedMs = Date.now() - new Date(job.startedAt).getTime();
      if (elapsedMs < bootstrapGraceMs()) {
        // Ambiguous window: at-most-once. Do NOT spawn; surface a diagnosable
        // pending state so a later recovery / manual action can resume.
        const updated = updateJobIf(
          jobId,
          (j) => !isTerminal(j.status) && j.status !== 'cancelled' && j.status === 'queued',
          { status: 'queued', substatus: 'bootstrap_pending' },
        );
        if (updated) report.diagnostics.push(`${jobId}:bootstrap_pending`);
        return;
      }
      resumeBootstrap(job, report, inspector);
      return;
    }
    case 'supervisor_acknowledged':
      // The supervisor acked, so a worker may have been spawned. With no live
      // child now this is ambiguous: auto-resuming could replay side effects.
      // at-most-once: mark a diagnosable failure and let the leader reply /
      // investigate. Never auto-replay.
      {
        const updated = updateJobIf(
          jobId,
          (j) => !isTerminal(j.status) && j.status !== 'cancelled',
          { status: 'failed', substatus: 'unacknowledged_worker', endedAt: nowIso() },
        );
        if (updated) {
          report.recovered.push(`${jobId}:failed_unacknowledged_worker`);
          report.diagnostics.push(`${jobId}:ambiguous_worker`);
        }
      }
      return;
    case 'worker_spawned':
      // A worker was spawned and both supervisor and worker are gone. No
      // auto-resume (the worker may have executed side effects).
      {
        const updated = updateJobIf(
          jobId,
          (j) => !isTerminal(j.status) && j.status !== 'cancelled',
          { status: 'failed', substatus: 'interrupted (MCP restart)', endedAt: nowIso() },
        );
        if (updated) {
          report.recovered.push(`${jobId}:failed_interrupted`);
          report.diagnostics.push(`${jobId}:orphan_worker_lost`);
        }
      }
      return;
  }
}

// Single-recoverer bootstrap resume: only the O_EXCL 'recover' claim winner may
// spawn. The job is re-read and guarded after acquisition so a concurrent
// recoverer / finalizer that changed it meanwhile is never double-spawned.
function resumeBootstrap(job: Job, report: RecoveryReport, inspector: ProcessInspector): void {
  const jobId = job.jobId;
  const ownerId = crypto.randomUUID();
  const acq = acquireClaim({
    jobId,
    kind: 'recover',
    ownerId,
    now: Date.now,
    leaseMs: recoveryClaimLeaseMs(),
    inspector,
  });
  if (acq.status !== 'acquired') {
    if (acq.status === 'stolen') report.claimsStolen += 1;
    report.diagnostics.push(`${jobId}:recovery_claimed_elsewhere`);
    return;
  }
  try {
    const cur = readJob(jobId);
    if (!cur || isTerminal(cur.status) || cur.status === 'cancelled') return;
    // Wave 4B2b2: an admission-waiting job is restored by the admission pump,
    // never by a recovery bootstrap resume (belt and suspenders with the
    // recoverOne early skip above).
    if (cur.admissionState === 'queued') return;
    const curBp = isValidBootstrap(cur.bootstrap) ? cur.bootstrap : null;
    if (!curBp || curBp.stage !== 'job_persisted' || cur.status !== 'queued') return;
    // Stamp a fresh bootstrap id for this new spawn intent, guarded so only one
    // recoverer can land it.
    const stamped = updateJobIf(
      jobId,
      (j) => j.status === 'queued' && isValidBootstrap(j.bootstrap) && j.bootstrap!.stage === 'job_persisted',
      { bootstrap: { stage: 'job_persisted', bootstrapId: newBootstrap('job_persisted', nowIso()).bootstrapId, updatedAt: nowIso() } },
    );
    if (!stamped) return;
    spawnSupervisor(jobId);
    report.spawned += 1;
    report.recovered.push(`${jobId}:resumed`);
  } finally {
    releaseClaim(jobId, 'recover', ownerId);
  }
}
