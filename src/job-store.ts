// Job store: one JSON file per job, written atomically (tmp file + rename).
// The full prompt is persisted locally for debug/session resumption but is
// NEVER returned by any tool (see toPublicView).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { jobsDir, logsDir, settingsDir, reportsDir, claimsDir, ensureRuntimeDirs, MIN_MAX_RUNTIME_MIN, MAX_MAX_RUNTIME_MIN, retentionV2Enabled, runtimeRoot } from './config.js';
import type { AttentionSnapshot, AttentionSummary } from './parser.js';
import { isTaskType, PROFILES, PARALLELISM_VALUES, type TaskType } from './router.js';
import { pidIdentityStatus } from './proc.js';
import type { ProcessInspector } from './registry.js';
import { isWorkerBackend, type WorkerBackend } from './worker-adapter.js';
import { REPLY_MODES, type ReplyMode } from './backend-policy.js';
// Value import of the receipt constants is safe: leader-decision.ts is a pure
// leaf module (zero imports) so this cannot create a cycle, and the validator
// needs the frozen schema version / field cap at runtime.
import {
  LEADER_DECISION_MAX_FIELD_CHARS,
  LEADER_DECISION_SCHEMA_VERSION,
  type LeaderDecisionRecord,
} from './leader-decision.js';
// Value + type import: CONTRACT_V2_SCHEMA_VERSION is a compile-time constant
// (schema version), TaskContractV2 is type-only. contracts-v2/acceptance-runner
// are parallel-built and never import job-store, so there is no cycle.
import { CONTRACT_V2_SCHEMA_VERSION } from './contracts-v2.js';
import type { TaskContractV2 } from './contracts-v2.js';
import type { GateResult } from './acceptance-runner.js';
// T2C per-job metrics: type import for the persisted shape, value import for
// the collector that produces the public safe copy (never the raw reference).
import type { JobMetricsV2 } from './job-metrics.js';
import { createJobMetricsCollector } from './job-metrics.js';
import type { AdmissionQueueReason } from './admission.js';
// Wave 5A2a JobIndex (parallel-built, never imports job-store): value import
// for the record/load/rebuild primitives, type import for the index shapes.
import { loadIndex, recordIndexedJob, rebuildIndex, jobsForSession, statusCountsOf, indexSize, indexJournalPath, emptyJobIndex } from './job-index.js';
import type { JobIndex, IndexDiagnostics, IndexedJobInput, StatusCounts } from './job-index.js';
export { CONTRACT_V2_SCHEMA_VERSION };
export type { TaskContractV2 };
export { jobsDir };

// Stage 2A response audit: a pure observability record written on a NEW reply
// job when the leader replies to a needs_attention job. It documents that a
// session resume was requested and snapshots the sanitized attention observed;
// it NEVER authorizes anything (authorization is always false).
export interface AttentionResponseAudit {
  kind: 'leader_reply_submitted';
  /** ISO time the reply job was created. */
  recordedAt: string;
  /** Sanitized snapshot of the observed needs_attention, or null if unobservable. */
  attention: AttentionSnapshot | null;
  /** The reply only resumes the saved session. */
  effect: 'resume_requested';
  /** Always false: a reply is not an authorization grant. */
  authorization: false;
}

// ---------------------------------------------------------------------------
// Atomic JSON write hardening (Windows).
//
// Rename retry policy, decided from Windows/Node evidence (Node 24, libuv
// MoveFileExW + MOVEFILE_REPLACE_EXISTING). Renaming a tmp over an existing
// target fails with EPERM when the target is held by another process (with or
// without FILE_SHARE_DELETE) or has the read-only attribute; EBUSY is the
// documented libuv mapping for a transient resource/sharing busy state (e.g.
// antivirus scanning the freshly written tmp). Both clear on their own within
// milliseconds, so we retry a bounded number of times with short backoff.
// EACCES was never observed as a transient rename condition on Windows (it is
// genuine permission denial), so it is deliberately NOT retried.
const RENAME_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 6; // total rename attempts (1 initial + 5 retries)
const RENAME_MAX_TOTAL_MS = 300; // hard wall-clock cap on all attempts combined
const RENAME_RETRY_BASE_MS = 20; // backoff base; doubles per retry, capped
const RENAME_BACKOFF_CAP_MS = 50;

// Synchronous sleep used between retries (Atomics.wait blocks the loop, which
// is what a retry needs; validated as working on the Node main thread).
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function defaultSleep(ms: number): void {
  if (ms > 0) Atomics.wait(sleepBuffer, 0, 0, ms);
}
function monotonicMs(): number {
  return performance.now();
}

// Unique per-call tmp path: pid + monotonic counter + random component. The
// counter guarantees consecutive writes never reuse a name even if two calls
// somehow raced; the random component makes the name unguessable/unpredictable.
let tmpSeq = 0;
function uniqueTmpPath(targetPath: string): string {
  tmpSeq += 1;
  return `${targetPath}.${process.pid}.${tmpSeq}.${crypto.randomUUID()}.tmp`;
}

// Test-only fault injection. Production callers never touch this; the test
// suite uses it to drive transient EPERM/EBUSY rename failures and tmp-cleanup
// failures deterministically without real sleeps.
export interface AtomicWriteTestHooks {
  /** Called before each rename attempt; throwing simulates a rename error. */
  beforeRename?: (attempt: number, tmpPath: string, targetPath: string) => void;
  /** Called before unlinking a leftover tmp; throwing simulates cleanup failure. */
  beforeUnlink?: (tmpPath: string) => void;
  /** Synchronous sleep between retries; tests install a no-op. */
  sleep?: (ms: number) => void;
}
export const atomicWriteTestHooks: AtomicWriteTestHooks = {};

function renameWithRetry(tmpPath: string, targetPath: string): void {
  const started = monotonicMs();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      atomicWriteTestHooks.beforeRename?.(attempt, tmpPath, targetPath);
      fs.renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const transient = RENAME_TRANSIENT_CODES.has(code);
      const canRetry =
        transient &&
        attempt < RENAME_MAX_ATTEMPTS &&
        monotonicMs() - started < RENAME_MAX_TOTAL_MS;
      if (!canRetry) {
        if (transient && attempt > 1) {
          // Make the terminal failure diagnosable and state that the target
          // still holds its previous valid JSON (rename is the only mutating
          // step, so a failed rename leaves the target untouched).
          const e = err as NodeJS.ErrnoException;
          e.message += ` [atomicWriteJson: rename ${path.basename(tmpPath)} -> ${path.basename(targetPath)} failed ${attempt} times (${code}); target still holds its previous valid JSON]`;
        }
        throw err;
      }
      const delay = Math.min(RENAME_RETRY_BASE_MS * 2 ** (attempt - 1), RENAME_BACKOFF_CAP_MS);
      (atomicWriteTestHooks.sleep ?? defaultSleep)(delay);
    }
  }
}

function cleanupTmp(tmpPath: string, originalError: unknown): void {
  try {
    atomicWriteTestHooks.beforeUnlink?.(tmpPath);
    fs.unlinkSync(tmpPath);
  } catch (cleanupErr) {
    // A failed cleanup must never mask the original write/rename error; it is
    // reported as a controlled addendum so the leftover tmp is visible.
    const e = originalError as Error;
    e.message += ` [atomicWriteJson: tmp cleanup of ${path.basename(tmpPath)} failed: ${(cleanupErr as Error).message}]`;
  }
}

export type JobStatus = 'queued' | 'running' | 'needs_attention' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind = 'start' | 'reply';

// Stage 6 bootstrap checkpoint. Records ONLY the scheduler-owned bootstrap /
// recovery stages (job persisted -> supervisor acknowledged -> worker spawned).
// It never claims to recover arbitrary Claude tool steps or replay approved
// actions; Claude content resumption remains the job of session/reply. Field
// whitelist: stage enum + bootstrapId + timestamp — no prompts/tokens/raw logs.
export const BOOTSTRAP_STAGES = ['job_persisted', 'supervisor_acknowledged', 'worker_spawned'] as const;
export type BootstrapStage = (typeof BOOTSTRAP_STAGES)[number];

export interface JobBootstrap {
  /** Latest scheduler-owned bootstrap stage REACHED. */
  stage: BootstrapStage;
  /** Stable per bootstrap attempt; a new id is stamped on every resume. */
  bootstrapId: string;
  /** ISO time of the last checkpoint write. */
  updatedAt: string;
}

export function isBootstrapStage(v: unknown): v is BootstrapStage {
  return typeof v === 'string' && (BOOTSTRAP_STAGES as readonly string[]).includes(v);
}

export function isValidBootstrap(b: unknown): b is JobBootstrap {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return isBootstrapStage(o.stage) && typeof o.bootstrapId === 'string' && typeof o.updatedAt === 'string';
}

// T2C budget lifecycle status, persisted on the internal Job. 'not_requested'
// is the default for old jobs that predate the budget feature entirely.
export const BUDGET_STATUSES = ['not_requested', 'active', 'report_only', 'failed'] as const;
export type BudgetStatus = (typeof BUDGET_STATUSES)[number];

// T2C report completeness: what fraction of the contract's report deliverable
// actually reached disk. Absent on old jobs (unknown), never fabricated.
export const REPORT_COMPLETENESSES = ['skeleton', 'partial', 'complete'] as const;
export type ReportCompleteness = (typeof REPORT_COMPLETENESSES)[number];

// A public budgetViolation may only be a fixed short code ([a-z0-9_:-], max
// 120 chars). Anything else — raw worker text, arbitrary strings, oversized
// payloads — is replaced with 'invalid_budget_violation' and never echoed.
const BUDGET_VIOLATION_CODE_RE = /^[a-z0-9_:-]{1,120}$/;
const INVALID_BUDGET_VIOLATION = 'invalid_budget_violation';

function sanitizeBudgetViolation(v: unknown): string | null {
  return typeof v === 'string' && BUDGET_VIOLATION_CODE_RE.test(v) ? v : INVALID_BUDGET_VIOLATION;
}

export interface Job {
  jobId: string;
  sessionId: string;
  kind: JobKind;
  replyToJobId: string | null;
  profile: string;
  port: number;
  permissionMode: string;
  parallelism: string;
  workFolder: string;
  maxRuntimeMinutes: number;
  pid: number | null;
  supervisorPid: number | null;
  // PID launch identity: the OS-reported creation time captured right after the
  // scheduler spawned the supervisor (supervisorPidStartedAt) and after the
  // supervisor spawned the worker (pidStartedAt). Absent on legacy jobs; a pid
  // with no identity is NEVER killed or attached (PID reuse protection).
  pidStartedAt?: string | null;
  supervisorPidStartedAt?: string | null;
  status: JobStatus;
  substatus: string | null;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  exitCode: number | null;
  logPath: string;
  stderrLogPath: string;
  reportPath: string;
  prompt: string;
  claudeCli?: string;
  claudePrefix?: string[];
  extraEnv?: Record<string, string>;
  // Worker adapter. Absent on legacy jobs => Claude (backward compatible).
  workerBackend?: WorkerBackend;
  // Reply execution semantics for reply jobs: how the worker backend resumes
  // (claude => persistent session resume; deepseek-harness => fresh bounded
  // turn with a NEW session id). Absent on legacy/start jobs => null view.
  replyMode?: ReplyMode;
  // Real worker output evidence: the ISO time of the most recent stdout/stderr
  // chunk. NOT the 30s keepalive heartbeat. Missing (old jobs) => idle unknown.
  lastOutputAt: string | null;
  // Sanitized, structured attention summaries for needs_attention events.
  // Append-only, bounded (latest N). Old jobs predate this field entirely.
  // Observability only: never changes the upstream auto decision.
  attentionLog?: AttentionSummary[];
  // Stage 2A response audit: present only on reply jobs created while the target
  // job was needs_attention. Observability only (authorization is always false).
  attentionResponseAudit?: AttentionResponseAudit;
  // Stage 6 scheduler-owned bootstrap checkpoint. Old jobs predate this field;
  // recovery treats a missing checkpoint with the existing conservative
  // behavior (no auto-resume of legacy queued jobs).
  bootstrap?: JobBootstrap;
  // Research/analysis deliverable contract (optional; old execution jobs
  // predate these fields entirely). taskType and deliverablePath are set at
  // start/reply; deliverableHash and missingDeliverable are computed by the
  // supervisor BEFORE the terminal status is published. Never the report
  // content itself.
  taskType?: TaskType;
  deliverablePath?: string;
  deliverableHash?: string;
  missingDeliverable?: boolean;
  // 2026-08-23 single-artifact write exception: review-profile research/
  // analysis jobs run in permission-mode default (not plan) with an exact-path
  // Write/Edit allowance for deliverablePath only (supervisor settings), so
  // the primary report never deadlocks against read-only routing. Set at
  // start; replies inherit it.
  artifactWriteException?: boolean;
  // Bounded (~200 chars) sanitized failure-reason summary extracted by the
  // supervisor from the worker's stream-json stdout when a job fails with a
  // non-zero exit code. Observability only; old jobs predate this field.
  failureDetail?: string;
  // Legacy receipt data is read for historical compatibility only. New jobs
  // never scan final text or change status based on this retired protocol.
  leaderDecision?: LeaderDecisionRecord;
  // T1D v2 task contract (optional). Internal persistence only: the full
  // contract (scope globs, acceptance argv, reporting path) is a privileged
  // creation-time artifact that the public view NEVER exposes — it surfaces
  // only contractSchemaVersion. Old jobs predate this field entirely.
  contract?: TaskContractV2;
  // T2C budget enforcement state (optional; old jobs predate these fields
  // entirely). budgetStatus defaults to 'not_requested' in the public view
  // when absent; budgetViolation is a short fixed-code string (see
  // toPublicView), never raw worker text; reportCompleteness is only set by
  // the supervisor when it actually measured the report; metrics is the flat
  // aggregate summary; the two absolute paths are INTERNAL ONLY and must
  // never surface through any public/watch interface.
  budgetStatus?: BudgetStatus;
  budgetViolation?: string;
  reportCompleteness?: ReportCompleteness;
  metrics?: JobMetricsV2;
  budgetConfigPath?: string;
  budgetStatePath?: string;
  // Wave4B1 admission persistence (all optional; old jobs predate these fields
  // entirely and are interpreted as disabled with zero counts — see
  // toPublicView). desiredWorkerConcurrency is the effective 1..64 target the
  // scheduler requests; admissionResourceClass/admissionQueueReason carry the
  // worker-side class and queue reason; queuedAt/admittedAt are ISO stamps;
  // activeWorkers/queuedWorkers/resourceLimit mirror the admission decision.
  desiredWorkerConcurrency?: number | null;
  admissionState?: 'disabled' | 'queued' | 'active' | 'released';
  admissionResourceClass?: 'light' | 'build' | 'heavy' | null;
  admissionQueueReason?: AdmissionQueueReason | null;
  queuedAt?: string | null;
  admittedAt?: string | null;
  activeWorkers?: number;
  queuedWorkers?: number;
  resourceLimit?: number | null;
  // T1D runner outcome mirrors, persisted by the D2 acceptance runner. Absent
  // on old jobs and on jobs whose acceptance was never requested. workerStatus
  // is the D2-published worker truth; the public view falls back to the
  // job's own lifecycle status when absent.
  workerStatus?: JobStatus;
  acceptanceStatus?: JobAcceptanceStatus;
  gateResults?: GateResult[];
}

/** Wave4B1 admission lifecycle state; absent on legacy jobs (viewed as 'disabled'). */
export type JobAdmissionState = 'disabled' | 'queued' | 'active' | 'released';

/** Worker-side resource class for the admission queue (see src/admission.ts). */
export type JobAdmissionResourceClass = 'light' | 'build' | 'heavy' | null;

export const TERMINAL_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled'];
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function newJobId(): string {
  return crypto.randomUUID();
}
export function newSessionId(): string {
  return crypto.randomUUID();
}

export function jobFilePath(jobId: string): string {
  return path.join(jobsDir(), `${jobId}.json`);
}
export function doneFilePath(jobId: string): string {
  return path.join(jobsDir(), `${jobId}.done.json`);
}
export function logFilePath(jobId: string): string {
  return path.join(logsDir(), `${jobId}.log`);
}
export function stderrLogFilePath(jobId: string): string {
  return path.join(logsDir(), `${jobId}.stderr.log`);
}
export function settingsFilePath(jobId: string): string {
  return path.join(settingsDir(), `${jobId}.settings.json`);
}
export function reportFilePath(jobId: string): string {
  return path.join(reportsDir(), `${jobId}.txt`);
}

// F4 (security): runtime files are owner-only on POSIX. They carry material the
// user would not hand to another account on the same machine: settings/*.json
// embed the per-job ANTHROPIC_AUTH_TOKEN, jobs/*.json embed the full prompt,
// and logs/*.log embed tool output and file contents. The default umask (022)
// made all of them world-readable (0644). Windows ignores the mode bits beyond
// the read-only flag, where 0o600 is harmless.
//
// Creation-mode only: `mode` is applied when the file is created. The atomic
// JSON path (fresh tmp + rename) therefore re-derives 0600 on every write, which
// also fixes a file created before this change; append-only logs keep the mode
// of the file they first created (a pre-existing 0644 log stays 0644 until it is
// rotated or archived).
const RUNTIME_FILE_MODE = 0o600;
const RUNTIME_FILE_OPTS = { encoding: 'utf8' as const, mode: RUNTIME_FILE_MODE };

export function atomicWriteJson(file: string, data: unknown): void {
  ensureRuntimeDirs();
  const tmp = uniqueTmpPath(file);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), RUNTIME_FILE_OPTS);
    renameWithRetry(tmp, file);
  } catch (err) {
    // Only this call's tmp is touched. If it may exist (full or partial
    // write), remove it so nothing we created is left behind; the target
    // file is untouched because rename is the only mutating step and
    // renameWithRetry only returns once the new content is fully in place.
    if (fs.existsSync(tmp)) {
      cleanupTmp(tmp, err);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Wave 5A2a: JobIndex persistence hook (feature-flagged).
//
// When ORCHESTRATOR_RETENTION_V2 enables retentionV2Enabled(), every successful
// job JSON write (createJobRecord / updateJob / updateJobIf) is mirrored into
// the JobIndex (runtime/job-index: snapshot.json + journal.jsonl + index.lock).
// The mirror is STRICTLY best-effort: an index write failure, a busy index lock
// or a corrupt index must never roll back, fail or block the job write itself
// (the job JSON is the single source of truth). On any such failure the entry
// is marked dirty so the next ensureJobIndex()/health pass rebuilds.
//
// The index lock is a GLOBAL per-root lock; the job state lock is per-job.
// Lock-order rule: the mirror is invoked only AFTER the job state lock has been
// released, so we never hold a job state lock while acquiring the global index
// lock (would deadlock two writers).
// ---------------------------------------------------------------------------

/** How many jobs rebuildIndex/ensureJobIndex list from disk when they rebuild. */
const RETENTION_REBUILD_LIMIT = 1_000_000;

/** Minimal index view of a job (subset of Job; only non-sensitive fields). */
interface IndexableJobView {
  jobId: string;
  sessionId: string;
  kind: JobKind;
  replyToJobId: string | null;
  status: JobStatus;
  startedAt: string;
  endedAt: string | null;
}

/** Per-runtime-root cache entry. Keyed by the CURRENT runtimeRoot() value so
 *  tests that redirect ORCHESTRATOR_RUNTIME never share an index across roots.
 *  journalStat is the last-seen (mtimeMs,size) of the journal file; a change
 *  detected on ensure means another process (or another index instance) wrote
 *  since our last load, so we reload instead of serving a stale cache. */
interface RetentionV2CacheEntry {
  index: JobIndex;
  diagnostics: IndexDiagnostics;
  journalStat: { mtimeMs: number; size: number } | null;
  dirty: boolean;
}

const retentionV2Cache = new Map<string, RetentionV2CacheEntry>();

function retentionV2EntryFor(root: string): RetentionV2CacheEntry {
  let entry = retentionV2Cache.get(root);
  if (!entry) {
    const loaded = loadIndex(root);
    entry = { index: loaded.index, diagnostics: loaded.diagnostics, journalStat: null, dirty: false };
    retentionV2Cache.set(root, entry);
    if (loaded.diagnostics.consistency === 'consistent') {
      entry.journalStat = statJournalOrNull(root);
    }
  }
  return entry;
}

function statJournalOrNull(root: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(indexJournalPath(root));
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null; // no journal yet (fresh root) — nothing to detect changes on
  }
}

function journalChangedSince(root: string, snapshot: { mtimeMs: number; size: number } | null): boolean {
  const cur = statJournalOrNull(root);
  if (cur === null) return snapshot !== null; // journal vanished
  if (snapshot === null) return cur.size > 0; // journal appeared non-empty
  return cur.size !== snapshot.size || cur.mtimeMs !== snapshot.mtimeMs;
}

/** True only for terminal records (never for the transient queued/running
 *  bootstrap window). Mirrors what the job-store treats as a stable truth. */
function isIndexableStatus(s: JobStatus): boolean {
  return s === 'needs_attention' || s === 'succeeded' || s === 'failed' || s === 'cancelled';
}

/** Minimal, non-sensitive index input built from a Job (never prompt/env/path
 *  or PID — see IndexedJob). Legacy fields absent on the Job map to defaults. */
function toIndexedJobInput(job: Job): IndexedJobInput {
  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    status: job.status,
    kind: job.kind,
    replyToJobId: job.replyToJobId ?? null,
    startedAt: job.startedAt,
    endedAt: job.endedAt ?? null,
  };
}

/** After any load/record/rebuild, refresh the journal stat so the next ensure
 *  does not re-trigger on our own writes. */
function refreshJournalStat(root: string, entry: RetentionV2CacheEntry): void {
  const cur = statJournalOrNull(root);
  if (cur !== null) entry.journalStat = cur;
}

/** Best-effort mirror of ONE job write into the index. Runs only while the
 *  flag is on; may silently no-op (kept bounded — a record after a missing
 *  journal leaves the entry dirty so a later ensure rebuilds). */
function recordIndexedJobBestEffort(job: Job): void {
  if (!retentionV2Enabled()) return;
  const root = runtimeRoot();
  try {
    const entry = retentionV2EntryFor(root);
    if (entry.diagnostics.consistency === 'missing' && isIndexableStatus(job.status)) {
      rebuildIndexNow(root, entry);
    }
    const recorded = recordIndexedJob(entry.index, toIndexedJobInput(job), { rootDir: root });
    if (recorded) {
      const loaded = loadIndex(root);
      entry.index = loaded.index;
      entry.diagnostics = loaded.diagnostics;
      if (loaded.diagnostics.consistency === 'consistent') refreshJournalStat(root, entry);
    } else {
      entry.dirty = true; // lock busy or bad row: rebuild on next ensure
    }
  } catch {
    const safe = entrySafe(root);
    if (safe) safe.dirty = true;
  }
}

/** Rebuild the index for a root from the authoritative job list, refreshing the
 *  cache entry. Returns the rebuild result, or null when the lock was busy. */
function rebuildIndexNow(root: string, entry: RetentionV2CacheEntry): { indexed: number; skipped: number; archivedJournalFiles: number } | null {
  const jobs = listJobs(RETENTION_REBUILD_LIMIT);
  const stats = rebuildIndex(jobs, { rootDir: root });
  if (stats.archivedJournalFiles === 0 && stats.indexed === 0 && stats.skipped === 0) {
    // Lock was busy (rebuildIndex returns the all-zero shape on lock failure).
    // The rebuild did NOT happen, so the entry STAYS dirty — a reload that
    // happens to be consistent must not clear it (the journal may be readable
    // yet missing records a busy mirror failed to write).
    const loaded = loadIndex(root);
    entry.index = loaded.index;
    entry.diagnostics = loaded.diagnostics;
    entry.dirty = true;
    if (loaded.diagnostics.consistency === 'consistent') refreshJournalStat(root, entry);
    return null;
  }
  const loaded = loadIndex(root);
  entry.index = loaded.index;
  entry.diagnostics = loaded.diagnostics;
  entry.dirty = false;
  if (loaded.diagnostics.consistency === 'consistent') refreshJournalStat(root, entry);
  return stats;
}

function entrySafe(root: string): RetentionV2CacheEntry | null {
  return retentionV2Cache.get(root) ?? null;
}

// ---------------------------------------------------------------------------
// Wave 5A2a public API (narrow; for the future health/wiring surface).
// ---------------------------------------------------------------------------

/** Result of the ensure pass; public diagnostics only (no paths). */
export interface JobIndexEnsureResult {
  index: JobIndex;
  diagnostics: IndexDiagnostics;
  dirty: boolean;
}

/** Public, non-sensitive health snapshot of the index (Wave 5A2b1). */
export interface JobIndexHealthSnapshot {
  enabled: boolean;
  dirty: boolean;
  diagnostics: IndexDiagnostics;
  statusCounts: StatusCounts;
  indexSize: number;
  /** True when an async rebuild is already queued for this runtime root. */
  rebuildScheduled: boolean;
}

/**
 * Make the cached index current for the active runtime root and return it.
 * Detects journal changes by OTHER writers via a stat-only check (no job-dir
 * scan) and reloads; rebuilds when the on-disk index is missing/corrupt.
 * Never throws. Flag-off callers get a fresh empty index (no directory side
 * effects) — this is what makes the health surface flag-safe.
 */
export function ensureJobIndex(): JobIndexEnsureResult {
  if (!retentionV2Enabled()) {
    return { index: emptyJobIndex(), diagnostics: { consistency: 'missing', snapshotLoaded: false, journalApplied: 0, journalLinesRead: 0, journalBadLines: 0, journalPrefixBytes: 0 }, dirty: false };
  }
  const root = runtimeRoot();
  const entry = retentionV2EntryFor(root);
  // A dirty entry means a mirror failed (e.g. the index lock was busy): the
  // journal may be readable yet MISSING that record, so a clean loadIndex
  // would wrongly clear dirty and serve a stale index. Dirty always forces a
  // rebuild from the authoritative job files; only a successful rebuild clears
  // it (the lock can be re-busy, in which case dirty survives for next time).
  if (entry.dirty) {
    const rebuilt = rebuildIndexNow(root, entry);
    if (rebuilt !== null) entry.dirty = false;
  } else if (entry.diagnostics.consistency !== 'consistent' || journalChangedSince(root, entry.journalStat)) {
    const loaded = loadIndex(root);
    entry.index = loaded.index;
    entry.diagnostics = loaded.diagnostics;
    if (loaded.diagnostics.consistency !== 'consistent') {
      const rebuilt = rebuildIndexNow(root, entry);
      // A lock-busy rebuild leaves the entry dirty for the NEXT ensure;
      // a successful rebuild clears it (dirty means "needs a rebuild").
      if (rebuilt !== null) entry.dirty = false;
    } else {
      refreshJournalStat(root, entry);
    }
  }
  return { index: entry.index, diagnostics: entry.diagnostics, dirty: entry.dirty };
}

/**
 * Job ids of a session from the index, in (startedAt asc, jobId asc) order.
 * The index is a hint, the job JSON is the truth — callers must readJob each
 * id before acting on it. The returned surface is ids only: no prompt, env,
 * paths or PID. Flag-off or absent index => [].
 */
export function indexedJobIdsForSession(sessionId: string): string[] {
  if (!retentionV2Enabled()) return [];
  const root = runtimeRoot();
  const entry = retentionV2EntryFor(root);
  return jobsForSession(entry.index, sessionId);
}

/** O(1) snapshot of index status counts (flag-off => all zeros). */
export function indexedStatusCounts(): StatusCounts {
  if (!retentionV2Enabled()) return emptyJobIndex().statusCounts;
  const root = runtimeRoot();
  return statusCountsOf(retentionV2EntryFor(root).index);
}

/**
 * O(1) health snapshot of the index for the active runtime root. Never returns
 * Job records or ids, prompts, paths or PIDs — only counts and public
 * diagnostics. The index is loaded/replayed into the cache; a journal change by
 * another writer is detected via a stat-only check (journalChangedSince) and
 * reloaded (snapshot + replay), but this NEVER synchronously rebuilds or scans
 * the jobs directory. Flag-off or absent index => enabled=false with the fixed
 * empty diagnostics.
 */
export function peekJobIndexForHealth(): JobIndexHealthSnapshot {
  if (!retentionV2Enabled()) {
    return { enabled: false, dirty: false, diagnostics: EMPTY_INDEX_DIAGNOSTICS, statusCounts: emptyJobIndex().statusCounts, indexSize: 0, rebuildScheduled: false };
  }
  const root = runtimeRoot();
  const entry = retentionV2EntryFor(root);
  // A journal written by another process (or a test corrupting the tail) makes
  // the cached snapshot stale. Detect it with the same stat-only check the
  // write path uses and reload (replay), never rebuild.
  if (entry.diagnostics.consistency === 'consistent' && journalChangedSince(root, entry.journalStat)) {
    const loaded = loadIndex(root);
    entry.index = loaded.index;
    entry.diagnostics = loaded.diagnostics;
    if (loaded.diagnostics.consistency === 'consistent') refreshJournalStat(root, entry);
  }
  return {
    enabled: true,
    dirty: entry.dirty,
    diagnostics: entry.diagnostics,
    statusCounts: statusCountsOf(entry.index),
    indexSize: indexSize(entry.index),
    rebuildScheduled: scheduledRebuilds.has(root),
  };
}

/** Fixed empty diagnostics for the flag-off/absent case (no paths, no counts). */
const EMPTY_INDEX_DIAGNOSTICS: IndexDiagnostics = {
  consistency: 'missing',
  snapshotLoaded: false,
  journalApplied: 0,
  journalLinesRead: 0,
  journalBadLines: 0,
  journalPrefixBytes: 0,
};

/** Test-only hook: force a rebuild even when one is already scheduled, and
 *  report whether it was already scheduled. Installed once by the test
 *  process; production never calls the hook (scheduling stays idempotent).
 *  Not part of the public contract. */
export const scheduleJobIndexRebuildTestHooks: { forceNext?: boolean; alreadyScheduled?: boolean } = {};

/** Set of runtime roots with a rebuild already scheduled (in-process). */
const scheduledRebuilds = new Set<string>();

/**
 * Schedule one async index rebuild for the active runtime root. In-process
 * idempotent: only the FIRST call per root queues the rebuild; a pending
 * rebuild is never duplicated. The rebuild runs on the next setImmediate
 * tick (never inside a health call) and clears the scheduled marker on
 * completion, so a later health pass can schedule again. A lock-busy rebuild
 * (null result) also clears the marker — the flag-off case is a no-op.
 * Flag-off callers get a no-op without touching any runtime state.
 */
export function scheduleJobIndexRebuild(): boolean {
  if (!retentionV2Enabled()) return false;
  const root = runtimeRoot();
  if (scheduledRebuilds.has(root) && !scheduleJobIndexRebuildTestHooks.forceNext) {
    return false;
  }
  scheduledRebuilds.add(root);
  const wasScheduled = scheduleJobIndexRebuildTestHooks.alreadyScheduled;
  if (scheduleJobIndexRebuildTestHooks.alreadyScheduled !== undefined) {
    scheduleJobIndexRebuildTestHooks.alreadyScheduled = true;
  }
  setImmediate(() => {
    try {
      rebuildJobIndexNow();
    } finally {
      scheduledRebuilds.delete(root);
      if (scheduleJobIndexRebuildTestHooks.alreadyScheduled !== undefined) {
        scheduleJobIndexRebuildTestHooks.alreadyScheduled = wasScheduled;
      }
    }
  });
  return true;
}

/** Force a rebuild from the authoritative job list now. Returns the rebuild
 *  stats (null when the index lock was busy and no rebuild ran). */
export function rebuildJobIndexNow(): { indexed: number; skipped: number; archivedJournalFiles: number } | null {
  if (!retentionV2Enabled()) return null;
  const root = runtimeRoot();
  return rebuildIndexNow(root, retentionV2EntryFor(root));
}

/** Test-only: drop the in-process cache so a fresh runtime root or a flipped
 *  flag starts from a clean slate. */
export function invalidateJobIndexForTests(): void {
  retentionV2Cache.clear();
}

// ---------------------------------------------------------------------------
// Persisted record validation (strict-but-backward-compatible).
//
// Job files are the trust boundary between processes: anything on disk is
// treated as untrusted until it validates. isValidJobRecord enforces the
// frozen public contract — status/profile/parallelism/pid/exitCode/maxRuntime
// are exact, required identity/routing/path fields keep their primitive type,
// and fields introduced in later stages (lastOutputAt, attention*, bootstrap,
// deliverable*, PID-start identities, claudeCli/claudePrefix/extraEnv) stay
// optional: absent on old jobs is fine, present-but-wrong is rejected.
//
// The .done marker is validated by parseDoneMarker (id + status + exitCode are
// required; status must be a completion truth — succeeded/failed/cancelled/
// needs_attention, never queued/running; endedAt may be absent, in which case
// recovery falls back to the job's own endedAt exactly as before).
// ---------------------------------------------------------------------------

/** Terminal-truth marker written by the supervisor (see src/supervisor.ts writeDone). */
export interface DoneMarker {
  jobId: string;
  status: JobStatus;
  endedAt: string | null;
  exitCode: number | null;
}

const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'];

// T1D acceptance status: superset of the runner's summary status. Absent on
// old jobs and on jobs whose acceptance was never requested.
export const ACCEPTANCE_STATUSES = [
  'not_requested',
  'pending',
  'pass',
  'fail',
  'blocked',
  'unknown',
] as const;
export type JobAcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

// A .done marker is the supervisor's completion truth: it can only legitimately
// carry a state the supervisor publishes as done. queued/running are transient
// lifecycle states that must never come from a .done marker — a stale or corrupt
// marker claiming them could falsely advance or freeze a live job — so they are
// rejected at the parse boundary. isValidJobRecord keeps accepting them for Job
// files; only the .done marker gate narrows to completion statuses.
const DONE_MARKER_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled', 'needs_attention'];

function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isValidTimestampString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

function isNullablePositiveSafeInt(v: unknown): boolean {
  return v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v > 0);
}

function isNullishOrNonNegativeSafeInt(v: unknown): boolean {
  return v === null || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0);
}

function isAbsentNullOrTimestamp(v: unknown): boolean {
  return v === undefined || v === null || isValidTimestampString(v);
}

function isStringRecord(v: unknown): boolean {
  if (!isNonNullObject(v)) return false;
  return Object.values(v).every((x) => typeof x === 'string');
}

// Legacy leader-decision receipt shape (read compatibility): only the exact
// schemaVersion is accepted and all three fields must be non-empty strings
// within the frozen length cap. Same rules as the supervisor's scan — a
// persisted record is always a validated scan result.
function isLeaderDecisionShape(v: unknown): boolean {
  if (!isNonNullObject(v)) return false;
  if ((v as Record<string, unknown>).schemaVersion !== LEADER_DECISION_SCHEMA_VERSION) return false;
  for (const field of ['reason', 'evidence', 'decisionNeeded'] as const) {
    const value = (v as Record<string, unknown>)[field];
    if (typeof value !== 'string' || value.trim().length === 0) return false;
    if (value.length > LEADER_DECISION_MAX_FIELD_CHARS) return false;
  }
  return true;
}

// attentionLog entries are sanitized parser outputs; only the array/object shape
// is enforced here so old summaries (which do carry `message`) keep validating.
function isAttentionLog(v: unknown): boolean {
  return Array.isArray(v) && v.every((entry) => isNonNullObject(entry));
}

// Stage 2A response audit: if present it must be the literal observability
// record — authorization exactly false and the snapshot carries no message.
function isAttentionResponseAudit(v: unknown): boolean {
  if (!isNonNullObject(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.kind !== 'leader_reply_submitted') return false;
  if (o.authorization !== false) return false;
  if (o.effect !== 'resume_requested') return false;
  if (!isValidTimestampString(o.recordedAt)) return false;
  if (o.attention === null) return true;
  if (!isNonNullObject(o.attention)) return false;
  const a = o.attention as Record<string, unknown>;
  if ('message' in a) return false; // a persisted snapshot never carries a message
  return (
    typeof a.requestId === 'string' &&
    (a.requestIdSource === 'upstream' || a.requestIdSource === 'local') &&
    typeof a.tool === 'string' &&
    typeof a.action === 'string' &&
    (a.path === null || typeof a.path === 'string') &&
    (a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' || a.risk === 'unknown') &&
    isValidTimestampString(a.at)
  );
}

const ADMISSION_STATES: readonly string[] = ['disabled', 'queued', 'active', 'released'];
/** Must stay in sync with src/admission.ts `AdmissionQueueReason`. */
const ADMISSION_QUEUE_REASONS: readonly string[] = [
  'desired_limit',
  'hard_safety_ceiling',
  'backend_profile_limit',
  'memory_reserve',
  'heavy_limit',
  'derived_space_conflict',
  'lock_busy',
];

/** Wave4B1: valid non-null desiredWorkerConcurrency is a 1..64 integer; null/absent allowed. */
function isValidDesiredConcurrency(v: unknown): boolean {
  return v === undefined || v === null ||
    (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 64);
}

/** Wave4B1: absent, null, or one of the admission states (nullable optional). */
function isAbsentNullOrAdmissionState(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && ADMISSION_STATES.includes(v));
}

/** Wave4B1: absent, null, or one of the worker resource classes. */
function isAbsentNullOrAdmissionResourceClass(v: unknown): boolean {
  return v === undefined || v === null || v === 'light' || v === 'build' || v === 'heavy';
}

/** Wave4B1: absent, null, or one of the admission queue reasons. */
function isAbsentNullOrAdmissionQueueReason(v: unknown): boolean {
  return v === undefined || v === null || ADMISSION_QUEUE_REASONS.includes(v as AdmissionQueueReason);
}

function isTaskContractV2Shape(v: unknown): boolean {
  if (!isNonNullObject(v)) return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== CONTRACT_V2_SCHEMA_VERSION) return false;
  if (o.writePolicy !== 'read_only_report' && o.writePolicy !== 'listed_writes' && o.writePolicy !== 'workspace_legacy') {
    return false;
  }
  if (!isNonNullObject(o.scope)) return false;
  const s = o.scope as Record<string, unknown>;
  for (const k of ['readGlobs', 'writeFiles', 'forbiddenGlobs']) {
    if (!Array.isArray(s[k]) || !s[k].every((g) => typeof g === 'string')) return false;
  }
  if (!isNonNullObject(o.budget)) return false;
  const b = o.budget as Record<string, unknown>;
  if (typeof b.maxRuntimeMinutes !== 'number' || !Number.isInteger(b.maxRuntimeMinutes) || b.maxRuntimeMinutes <= 0) {
    return false;
  }
  if (b.reportOnlyAfterMinutes !== undefined && typeof b.reportOnlyAfterMinutes !== 'number') return false;
  if (!Array.isArray(o.acceptance)) return false;
  if (!o.acceptance.every((e) => isNonNullObject(e))) return false;
  if (!isNonNullObject(o.reporting)) return false;
  if (!isNonNullObject(o.admission)) return false;
  const a = o.admission as Record<string, unknown>;
  return (
    (a.resourceClass === 'light' || a.resourceClass === 'build' || a.resourceClass === 'heavy') &&
    typeof a.priority === 'number' &&
    Number.isInteger(a.priority) &&
    a.priority >= 0 &&
    a.priority <= 3
  );
}

// gateResults entries are D2 runner outputs; the persisted record only checks
// the shape the public summary maps from. Deeper field types were validated by
// the runner itself before the array was persisted.
function isGateResultsArray(v: unknown): boolean {
  return (
    Array.isArray(v) &&
    v.every((g) => {
      if (!isNonNullObject(g)) return false;
      const o = g as Record<string, unknown>;
      const stdoutSummary: unknown = o.stdoutSummary;
      const stderrSummary: unknown = o.stderrSummary;
      return (
        typeof o.id === 'string' &&
        o.id.length > 0 &&
        typeof o.required === 'boolean' &&
        (o.exitCode === null || typeof o.exitCode === 'number') &&
        typeof o.timedOut === 'boolean' &&
        typeof o.durationMs === 'number' &&
        (stdoutSummary === undefined || typeof stdoutSummary === 'string') &&
        (stderrSummary === undefined || typeof stderrSummary === 'string')
      );
    })
  );
}

// T2C per-job metrics, as persisted on the Job record. The public view maps
// through the collector (toCompactMetrics), never the raw reference, so this
// shape only guards the aggregate field types — deeper details were validated
// by the collector itself before the record was persisted.
function isJobMetricsV2Shape(v: unknown): boolean {
  if (!isNonNullObject(v)) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.promptChars !== 'number') return false;
  if (o.queueMs !== null && typeof o.queueMs !== 'number') return false;
  if (o.supervisorStartMs !== null && typeof o.supervisorStartMs !== 'number') return false;
  if (o.workerMs !== null && typeof o.workerMs !== 'number') return false;
  if (o.gateMs !== null && typeof o.gateMs !== 'number') return false;
  if (o.toolUseCounts === undefined || !isNonNullObject(o.toolUseCounts)) return false;
  if (Object.values(o.toolUseCounts).some((n) => typeof n !== 'number')) return false;
  if (typeof o.uniqueReadFiles !== 'number') return false;
  if (typeof o.bashCommands !== 'number') return false;
  if (typeof o.transcriptBytesBefore !== 'number') return false;
  if (typeof o.replyDepth !== 'number') return false;
  if (o.reportFirstWriteMs !== null && typeof o.reportFirstWriteMs !== 'number') return false;
  if (typeof o.filesTouchedCount !== 'number') return false;
  if (o.inputTokens !== null && typeof o.inputTokens !== 'number') return false;
  if (o.outputTokens !== null && typeof o.outputTokens !== 'number') return false;
  if (o.cacheReadInputTokens !== null && typeof o.cacheReadInputTokens !== 'number') return false;
  if (o.cacheCreationInputTokens !== null && typeof o.cacheCreationInputTokens !== 'number') return false;
  return true;
}

/**
 * Validate a parsed job record against the frozen persisted contract. Returns
 * true only for records that are safe to expose and to mutate; anything else
 * (corrupt, wrong-typed, or untrusted) is treated as absent by readJob/listJobs.
 * Backward compatible: fields introduced in later stages may be absent.
 */
export function isValidJobRecord(value: unknown): value is Job {
  if (!isNonNullObject(value)) return false;
  const o = value as Record<string, unknown>;

  // Required identity/routing/kind fields: exact value or primitive type.
  if (typeof o.jobId !== 'string' || o.jobId.length === 0) return false;
  if (typeof o.sessionId !== 'string' || o.sessionId.length === 0) return false;
  if (o.kind !== 'start' && o.kind !== 'reply') return false;
  if (o.replyToJobId !== null && typeof o.replyToJobId !== 'string') return false;
  const profile = o.profile;
  if (typeof profile !== 'string' || !(PROFILES as readonly string[]).includes(profile)) return false;
  if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port <= 0) return false;
  if (typeof o.permissionMode !== 'string') return false;
  const parallelism = o.parallelism;
  if (typeof parallelism !== 'string' || !(PARALLELISM_VALUES as readonly string[]).includes(parallelism)) {
    return false;
  }
  if (typeof o.workFolder !== 'string') return false;

  const max = o.maxRuntimeMinutes;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < MIN_MAX_RUNTIME_MIN || max > MAX_MAX_RUNTIME_MIN) {
    return false;
  }

  // Pids: null or positive safe integers; PID-start identities optional.
  if (!isNullablePositiveSafeInt(o.pid)) return false;
  if (!isNullablePositiveSafeInt(o.supervisorPid)) return false;
  if (o.pidStartedAt !== undefined && !isAbsentNullOrTimestamp(o.pidStartedAt)) return false;
  if (o.supervisorPidStartedAt !== undefined && !isAbsentNullOrTimestamp(o.supervisorPidStartedAt)) return false;

  // Status/exitCode exact; timestamps validated.
  const status = o.status;
  if (typeof status !== 'string' || !(JOB_STATUSES as readonly string[]).includes(status)) return false;
  if (o.substatus !== null && typeof o.substatus !== 'string') return false;
  if (!isValidTimestampString(o.startedAt)) return false;
  if (o.endedAt !== null && !isValidTimestampString(o.endedAt)) return false;
  if (typeof o.lastActivityAt !== 'string') return false;
  if (!isNullishOrNonNegativeSafeInt(o.exitCode)) return false;

  // Required string fields keep their primitive type.
  if (typeof o.logPath !== 'string') return false;
  if (typeof o.stderrLogPath !== 'string') return false;
  if (typeof o.reportPath !== 'string') return false;
  if (typeof o.prompt !== 'string') return false;

  // Later-stage optional fields: absent is fine, present must validate.
  if (o.lastOutputAt !== undefined && o.lastOutputAt !== null && typeof o.lastOutputAt !== 'string') return false;
  if (o.claudeCli !== undefined && typeof o.claudeCli !== 'string') return false;
  const claudePrefix = o.claudePrefix;
  if (claudePrefix !== undefined && (!Array.isArray(claudePrefix) || !claudePrefix.every((x) => typeof x === 'string'))) {
    return false;
  }
  if (o.extraEnv !== undefined && !isStringRecord(o.extraEnv)) return false;
  if (o.workerBackend !== undefined && !isWorkerBackend(o.workerBackend)) return false;
  const replyMode = o.replyMode;
  if (replyMode !== undefined && (typeof replyMode !== 'string' || !(REPLY_MODES as readonly string[]).includes(replyMode))) return false;
  if (o.attentionLog !== undefined && !isAttentionLog(o.attentionLog)) return false;
  if (o.attentionResponseAudit !== undefined && !isAttentionResponseAudit(o.attentionResponseAudit)) return false;
  if (o.bootstrap !== undefined && !isValidBootstrap(o.bootstrap)) return false;
  if (o.taskType !== undefined && !isTaskType(o.taskType)) return false;
  if (o.deliverablePath !== undefined && typeof o.deliverablePath !== 'string') return false;
  if (o.artifactWriteException !== undefined && typeof o.artifactWriteException !== 'boolean') return false;
  if (o.deliverableHash !== undefined && typeof o.deliverableHash !== 'string') return false;
  if (o.missingDeliverable !== undefined && typeof o.missingDeliverable !== 'boolean') return false;
  if (o.failureDetail !== undefined && typeof o.failureDetail !== 'string') return false;
  if (o.leaderDecision !== undefined && !isLeaderDecisionShape(o.leaderDecision)) return false;
  // T1D fields: absent is fine (old jobs), present must validate.
  if (o.contract !== undefined && !isTaskContractV2Shape(o.contract)) return false;
  const acceptanceStatus = o.acceptanceStatus;
  if (
    acceptanceStatus !== undefined &&
    (typeof acceptanceStatus !== 'string' || !(ACCEPTANCE_STATUSES as readonly string[]).includes(acceptanceStatus))
  ) {
    return false;
  }
  if (o.gateResults !== undefined && !isGateResultsArray(o.gateResults)) return false;
  const workerStatus = o.workerStatus;
  if (
    workerStatus !== undefined &&
    (typeof workerStatus !== 'string' || !(JOB_STATUSES as readonly string[]).includes(workerStatus))
  ) {
    return false;
  }
  // T2C optional fields: absent is fine (old jobs), present must validate.
  const budgetStatus = o.budgetStatus;
  if (
    budgetStatus !== undefined &&
    (typeof budgetStatus !== 'string' || !(BUDGET_STATUSES as readonly string[]).includes(budgetStatus))
  ) {
    return false;
  }
  if (o.budgetViolation !== undefined && typeof o.budgetViolation !== 'string') return false;
  const reportCompleteness = o.reportCompleteness;
  if (
    reportCompleteness !== undefined &&
    (typeof reportCompleteness !== 'string' || !(REPORT_COMPLETENESSES as readonly string[]).includes(reportCompleteness))
  ) {
    return false;
  }
  if (o.metrics !== undefined && !isJobMetricsV2Shape(o.metrics)) return false;
  if (o.budgetConfigPath !== undefined && typeof o.budgetConfigPath !== 'string') return false;
  if (o.budgetStatePath !== undefined && typeof o.budgetStatePath !== 'string') return false;

  // Wave4B1 optional admission fields: absent is fine (legacy jobs), present
  // must validate. desiredWorkerConcurrency null/1..64; counts non-negative
  // integers; timestamps null/absent or ISO.
  if (!isValidDesiredConcurrency(o.desiredWorkerConcurrency)) return false;
  if (!isAbsentNullOrAdmissionState(o.admissionState)) return false;
  if (!isAbsentNullOrAdmissionResourceClass(o.admissionResourceClass)) return false;
  if (!isAbsentNullOrAdmissionQueueReason(o.admissionQueueReason)) return false;
  if (!isAbsentNullOrTimestamp(o.queuedAt)) return false;
  if (!isAbsentNullOrTimestamp(o.admittedAt)) return false;
  // Wave4B1: exitCode is pre-validated above; these are the shared helper's
  // only call sites whose value may be undefined (absent) on legacy jobs.
  if (o.activeWorkers !== undefined && !isNullishOrNonNegativeSafeInt(o.activeWorkers)) return false;
  if (o.queuedWorkers !== undefined && !isNullishOrNonNegativeSafeInt(o.queuedWorkers)) return false;
  if (o.resourceLimit !== undefined && o.resourceLimit !== null && !(typeof o.resourceLimit === 'number' && Number.isSafeInteger(o.resourceLimit) && o.resourceLimit >= 0)) {
    return false;
  }

  return true;
}

/**
 * Parse and validate a .done terminal-truth marker. Returns null when the value
 * is unreadable, missing required fields, the status is not a completion truth
 * (succeeded/failed/cancelled/needs_attention — queued/running are rejected at
 * this boundary), or the jobId does not match `expectedJobId` — a marker that
 * fails validation must never update the Job. `endedAt` is allowed to be absent
 * (old/test markers omit it); recovery then falls back to the job's own endedAt.
 */
export function parseDoneMarker(value: unknown, expectedJobId?: string): DoneMarker | null {
  if (!isNonNullObject(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.jobId !== 'string' || o.jobId.length === 0) return null;
  if (expectedJobId !== undefined && o.jobId !== expectedJobId) return null;
  const status = o.status;
  if (typeof status !== 'string' || !(DONE_MARKER_STATUSES as readonly string[]).includes(status)) return null;
  if (o.endedAt !== undefined && o.endedAt !== null && !isValidTimestampString(o.endedAt)) return null;
  if (!isNullishOrNonNegativeSafeInt(o.exitCode)) return null;
  return {
    jobId: o.jobId,
    status: o.status as JobStatus,
    endedAt: o.endedAt === undefined ? null : (o.endedAt as string | null),
    exitCode: o.exitCode as number | null,
  };
}

export function readJob(jobId: string): Job | null {
  const f = jobFilePath(jobId);
  if (!fs.existsSync(f)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(f, 'utf8'));
    return isValidJobRecord(parsed) ? (parsed as Job) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-job state lock (true cross-process CAS).
//
// A job file is one mutable JSON read by many processes (scheduler,
// supervisor, recovery) but written by exactly one at a time. The lock is a
// per-job O_EXCL file under claims/<jobId>.state.json, so concurrent writers
// serialize on the filesystem — never an in-process mutex and never a
// cross-process read-modify-write. The lock record carries owner identity
// (ownerId + pid + OS creation time) plus a lease; holders release with an
// owner-matched unlink, and a stale lock is only displaced by an atomic rename
// tombstone so exactly one contender ever wins.
//
// Lock classification:
//   verified live      -> blocks past any expiry (displacing it would let two
//                         writers own one job).
//   verified dead      -> provably gone, may recover.
//   identity mismatch  -> the pid was reused by a different process; the
//                         original owner is gone, may recover.
//   unverifiable       -> process exists but its creation time cannot be read;
//                         blocks until the lease expires, then one contender
//                         recovers by atomic rename.
//   corrupt/empty/partial -> NOT immediately stealable: the writer may be mid
//                         create->write. Blocks until the file's mtime grace
//                         expires, then one contender recovers by atomic rename.
// ---------------------------------------------------------------------------
export const JOB_STATE_LOCK_SCHEMA_VERSION = 1;

export interface JobStateLockRecord {
  schemaVersion: 1;
  jobId: string;
  /** Who owns the lock (crypto.randomUUID per acquisition). */
  ownerId: string;
  ownerPid: number;
  /** Process identity at acquisition, ISO of OS creation time. */
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface JobStateLockOptions {
  /** Optional caller-supplied owner id (default: crypto.randomUUID per acquisition). */
  ownerId?: string;
  /** Lease length in ms; a valid-but-unverifiable lock becomes recoverable after this. */
  leaseMs?: number;
  /** A lock file that exists but is empty/partial/corrupt is treated as an
   *  in-progress create until its mtime is older than this (ms). */
  mtimeGraceMs?: number;
  /** Injectable "now" (epoch ms) for clock-skew tests. */
  now?: () => number;
  /** Identity source; tests inject a fake, production uses the proc defaults. */
  inspector?: ProcessInspector;
  /** Max |OS startTime - ownerStartedAt| that still counts as the same process. */
  identityToleranceMs?: number;
  /** Total O_EXCL create + steal loop attempts (default 6). */
  maxAttempts?: number;
}

export type JobStateLockResult =
  | { status: 'acquired'; handle: JobStateLockHandle }
  | null;

export interface JobStateLockHandle {
  jobId: string;
  ownerId: string;
  ownerPid: number;
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
  lockFilePath: string;
}

export function jobStateLockFilePath(jobId: string): string {
  return path.join(claimsDir(), `${jobId}.state.json`);
}

const STATE_LOCK_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const STATE_LOCK_RETRY_BASE_MS = 20;
const STATE_LOCK_BACKOFF_CAP_MS = 50;

function isValidStateLockRecord(raw: unknown): raw is JobStateLockRecord {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    o.schemaVersion === JOB_STATE_LOCK_SCHEMA_VERSION &&
    typeof o.jobId === 'string' &&
    o.jobId.length > 0 &&
    typeof o.ownerId === 'string' &&
    o.ownerId.length > 0 &&
    typeof o.ownerPid === 'number' &&
    Number.isInteger(o.ownerPid) &&
    o.ownerPid > 0 &&
    typeof o.ownerStartedAt === 'string' &&
    typeof o.acquiredAt === 'string' &&
    typeof o.expiresAt === 'string'
  );
}

function readStateLockRecord(p: string): JobStateLockRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    return isValidStateLockRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

// Rename an existing lock file to a unique tombstone so exactly one concurrent
// stealer wins (a lost rename race surfaces as ENOENT and counts as a win for
// the caller, which then retries the O_EXCL create). Returns true only when the
// caller may retry the create; any other failure returns false so the caller
// backs off and eventually fails closed (never an unbounded retry loop).
function tryStealStateLock(p: string): boolean {
  const tomb = `${p}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(p, tomb);
    try {
      fs.unlinkSync(tomb); // best-effort tombstone cleanup
    } catch {
      /* leftover tombstone in claims/ is inert */
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT') return true; // someone else stole it first
    return false;
  }
}

/**
 * Acquire the per-job state lock with real O_EXCL semantics. Returns a handle-
 * carrying result on success, or null when the lock is held (fail-closed: the
 * caller must never proceed unlocked). A failed transient open/rename is
 * retried a bounded number of times; a held/stale lock is never stolen from a
 * verified-live owner.
 */
export function acquireJobStateLock(jobId: string, options: JobStateLockOptions = {}): JobStateLockResult {
  const leaseMs = options.leaseMs ?? 60_000;
  const mtimeGraceMs = options.mtimeGraceMs ?? 5_000;
  const now = options.now ?? Date.now;
  const inspector = options.inspector;
  const tolerance = options.identityToleranceMs ?? 5000;
  const maxAttempts = options.maxAttempts ?? 6;
  const p = jobStateLockFilePath(jobId);
  try {
    fs.mkdirSync(claimsDir(), { recursive: true });
  } catch {
    /* the O_EXCL open below will surface a real dir problem */
  }
  const nowMs = now();
  const record: JobStateLockRecord = {
    schemaVersion: JOB_STATE_LOCK_SCHEMA_VERSION,
    jobId,
    ownerId: options.ownerId ?? crypto.randomUUID(),
    ownerPid: process.pid,
    ownerStartedAt: new Date(nowMs - process.uptime() * 1000).toISOString(),
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
  };
  const started = monotonicMs();
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return {
        status: 'acquired',
        handle: {
          jobId,
          ownerId: record.ownerId,
          ownerPid: record.ownerPid,
          ownerStartedAt: record.ownerStartedAt,
          acquiredAt: record.acquiredAt,
          expiresAt: record.expiresAt,
          lockFilePath: p,
        },
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') {
        const existing = readStateLockRecord(p);
        if (existing) {
          const query = inspector ? { exists: inspector.exists, startTime: inspector.startTime } : {};
          const identity = pidIdentityStatus(existing.ownerPid, existing.ownerStartedAt, query, tolerance);
          if (identity === 'verified_live') {
            return null; // verified-live owner blocks past any expiry
          }
          if (identity === 'verified_dead' || identity === 'identity_mismatch') {
            if (tryStealStateLock(p)) continue; // retry the O_EXCL create
            if (attempt >= maxAttempts) return null;
            defaultSleep(Math.min(STATE_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), STATE_LOCK_BACKOFF_CAP_MS));
            continue;
          }
          // unverifiable: lease is the bounded backstop for a crashed owner.
          const exp = Date.parse(existing.expiresAt);
          if (!Number.isNaN(exp) && now() <= exp) {
            return null;
          }
          if (tryStealStateLock(p)) continue;
          if (attempt >= maxAttempts) return null;
          defaultSleep(Math.min(STATE_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), STATE_LOCK_BACKOFF_CAP_MS));
          continue;
        }
        // Empty/partial/corrupt lock file: the writer may be mid create->write.
        // Block through the mtime grace, then recover by atomic rename.
        let age = Infinity;
        try {
          age = now() - fs.statSync(p).mtimeMs;
        } catch {
          continue; // vanished -> retry the create
        }
        if (age < mtimeGraceMs) {
          if (attempt >= maxAttempts) return null;
          defaultSleep(Math.min(STATE_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), STATE_LOCK_BACKOFF_CAP_MS));
          continue;
        }
        if (tryStealStateLock(p)) continue;
        if (attempt >= maxAttempts) return null;
        defaultSleep(Math.min(STATE_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), STATE_LOCK_BACKOFF_CAP_MS));
        continue;
      }
      if (STATE_LOCK_TRANSIENT_CODES.has(code) && attempt < maxAttempts && monotonicMs() - started < 300) {
        defaultSleep(Math.min(STATE_LOCK_RETRY_BASE_MS * 2 ** (attempt - 1), STATE_LOCK_BACKOFF_CAP_MS));
        continue;
      }
      throw err;
    }
  }
}

/** Remove a state lock ONLY if this caller still owns it (ownerId + pid +
 *  startedAt all match). A non-owner can never delete a replacement holder. */
export function releaseJobStateLock(handle: JobStateLockHandle): boolean {
  try {
    const cur = readStateLockRecord(handle.lockFilePath);
    if (cur) {
      if (
        cur.ownerId !== handle.ownerId ||
        cur.ownerPid !== handle.ownerPid ||
        cur.ownerStartedAt !== handle.ownerStartedAt
      ) {
        return false; // a different owner took over; never delete their lock
      }
    }
    fs.unlinkSync(handle.lockFilePath);
    return true;
  } catch {
    return false;
  }
}

// Monotonic status enforcement: a status transition outside this table is
// rejected by the CAS writer. Terminal statuses are immutable, and
// needs_attention cannot fall back to queued/running (but may become
// failed/cancelled/succeeded — the supervisor's final worker outcome is truth).
const ALLOWED_STATUS_NEXT: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'],
  running: ['running', 'needs_attention', 'succeeded', 'failed', 'cancelled'],
  needs_attention: ['needs_attention', 'succeeded', 'failed', 'cancelled'],
  succeeded: ['succeeded'],
  failed: ['failed'],
  cancelled: ['cancelled'],
};

function isAllowedStatusTransition(from: JobStatus, to: JobStatus): boolean {
  return ALLOWED_STATUS_NEXT[from].includes(to);
}

// The ONLY writer of a job record file. Callers hold the job state lock (see
// updateJob/updateJobIf/createJobRecord); this centralizes the atomic replace.
function writeJobFile(job: Job): void {
  const f = jobFilePath(job.jobId);
  atomicWriteJson(f, job);
}

function applyPatch(cur: Job, patch: Partial<Job>): Job {
  return { ...cur, ...patch };
}

// Bounded retry on a held lock so a transient cross-process contention does
// not fail a write outright; a genuinely held (live) lock still fails closed.
function updateJobUnderLock(jobId: string, mutate: (cur: Job) => Job | null): Job | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const acq = acquireJobStateLock(jobId);
    if (acq !== null) {
      let next: Job | null = null;
      try {
        const cur = readJob(jobId);
        if (!cur) return null;
        next = mutate(cur);
        if (!next) return null;
        if (!isAllowedStatusTransition(cur.status, next.status)) return null;
        writeJobFile(next);
        return next;
      } finally {
        // Wave 5A2a: mirror AFTER the per-job state lock is released — the
        // index lock is a global per-root lock, so acquiring it while holding
        // a job state lock could deadlock two writers (lock-order inversion).
        releaseJobStateLock(acq.handle);
        if (next !== null) recordIndexedJobBestEffort(next);
      }
    }
    if (attempt < 2) defaultSleep(10);
  }
  return null;
}

/**
 * Create a brand-new job record under the job state lock. The lock makes the
 * create exclusive (a fresh UUID cannot collide, but two writers can never
 * both believe they created the same id). Returns the created job, or null if
 * the lock could not be acquired or a job with this id already exists.
 */
export function createJobRecord(job: Job): Job | null {
  const acq = acquireJobStateLock(job.jobId);
  if (acq === null) return null;
  try {
    if (readJob(job.jobId)) return null; // a job with this id already exists
    writeJobFile(job);
    recordIndexedJobBestEffort(job);
    return job;
  } finally {
    releaseJobStateLock(acq.handle);
  }
}

export function updateJob(jobId: string, patch: Partial<Job>): Job | null {
  return updateJobUnderLock(jobId, (cur) => applyPatch(cur, patch));
}

// Conditional atomic update: applies `patch` only while the current job still
// satisfies `guard`. Returns the new job, or null if the guard failed (or the
// job is missing). Runs under the per-job state lock (re-read under lock,
// predicate, monotonic status, atomic replace, release) so a job that reached
// a terminal/needs_attention state while a writer was deciding is never
// regressed.
export function updateJobIf(jobId: string, guard: (j: Job) => boolean, patch: Partial<Job>): Job | null {
  return updateJobUnderLock(jobId, (cur) => (guard(cur) ? applyPatch(cur, patch) : null));
}

export function listJobs(limit = 20): Job[] {
  ensureRuntimeDirs();
  const files = fs
    .readdirSync(jobsDir())
    .filter((f) => f.endsWith('.json') && !f.endsWith('.done.json'));
  const jobs = files
    .map((f) => {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(path.join(jobsDir(), f), 'utf8'));
        return isValidJobRecord(parsed) ? (parsed as Job) : null;
      } catch {
        return null;
      }
    })
    .filter((j): j is Job => j !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return jobs.slice(0, limit);
}

export function writeReport(jobId: string, text: string): void {
  ensureRuntimeDirs();
  const capped = text.length > 20000 ? `${text.slice(0, 20000)}\n... [truncated]` : text;
  fs.writeFileSync(reportFilePath(jobId), capped, RUNTIME_FILE_OPTS);
}

export function appendLog(jobId: string, chunk: string): void {
  ensureRuntimeDirs();
  fs.appendFileSync(logFilePath(jobId), chunk, RUNTIME_FILE_OPTS);
}

// stderr log: claude's stderr (human logs / errors) plus the supervisor's own
// meta banners. Kept separate from the stdout stream-json log so the stdout
// log stays pure JSON and the incremental parser can reconstruct events
// without cross-stream interleaving.
export function appendStderrLog(jobId: string, chunk: string): void {
  ensureRuntimeDirs();
  fs.appendFileSync(stderrLogFilePath(jobId), chunk, RUNTIME_FILE_OPTS);
}

export function readLogTail(jobId: string, maxChars = 500): string {
  const f = logFilePath(jobId);
  // Bounded tail read (render.ts readTailBytes style): never loads the whole
  // append-only stdout log into memory just to return the last `maxChars`.
  let fd: number;
  try {
    fd = fs.openSync(f, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - maxChars);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return text.length > maxChars ? `... ${text.slice(-maxChars)}` : text;
  } catch {
    return '';
  } finally {
    fs.closeSync(fd);
  }
}

// T1D gate summary: the ONLY slice of a runner GateResult the public view may
// expose. Deliberately excludes the raw output previews, argv, cwd, env and
// any runner-internal fields — a summary is bounded, sanitized and safe to
// surface to the leader.
export interface JobGateSummary {
  id: string;
  required: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  prevented?: boolean;
  errorCode?: string;
  stdoutSummary: string;
  stderrSummary: string;
}

/** Pure mapper from a runner GateResult to its public summary. Never throws. */
export function toGateSummary(g: GateResult): JobGateSummary {
  const result: JobGateSummary = {
    id: g.id,
    required: g.required,
    exitCode: g.exitCode ?? null,
    timedOut: g.timedOut,
    durationMs: g.durationMs,
    stdoutSummary: g.stdoutSummary ?? '',
    stderrSummary: g.stderrSummary ?? '',
  };
  if (g.prevented !== undefined) result.prevented = g.prevented;
  if (g.errorCode !== undefined) result.errorCode = g.errorCode;
  return result;
}

export interface JobView {
  jobId: string;
  sessionId: string;
  kind: JobKind;
  replyToJobId: string | null;
  profile: string;
  port: number;
  permissionMode: string;
  parallelism: string;
  workFolder: string;
  maxRuntimeMinutes: number;
  status: JobStatus;
  substatus: string | null;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  lastActivityAt: string;
  runningSeconds: number | null;
  // Seconds since the worker's last real stdout/stderr output. null when the
  // job predates this field (or the timestamp is unreadable). Advisory only:
  // a long tool call or a slow upstream can idle legitimately, and a
  // needs_attention job "idles" because it is waiting on the user.
  idleSeconds: number | null;
  reportPath: string;
  hasReport: boolean;
  /** Selected worker adapter; old jobs omit it and are interpreted as Claude. */
  workerBackend?: WorkerBackend;
  /** Reply execution semantics; always present, null on non-reply/legacy jobs. */
  replyMode: ReplyMode | null;
  // Structured, sanitized attention summary, present only for needs_attention
  // jobs that recorded one. New/optional field; old clients ignore it.
  attentionDetail?: AttentionSummary | null;
  // Stage 2A response audit, present only on reply jobs that recorded one.
  // New/optional field; old clients ignore it.
  attentionResponseAudit?: AttentionResponseAudit | null;
  // Stage 6 scheduler-owned bootstrap stage (sanitized enum), present only when
  // a job carries a bootstrap checkpoint. New/optional; old clients ignore it.
  bootstrapStage?: BootstrapStage;
  // Deliverable contract (research/analysis only; optional, old jobs omit it).
  // deliverablePath is the exact absolute report path; deliverableHash is the
  // SHA-256 of a valid artifact; missingDeliverable=true when the artifact was
  // absent/invalid at terminal time. Never the report content itself.
  taskType?: TaskType;
  deliverablePath?: string;
  deliverableHash?: string;
  missingDeliverable?: boolean;
  /** Present only on review-profile research/analysis jobs (see Job doc). */
  artifactWriteException?: boolean;
  // Sanitized failure-reason summary, present only on failed jobs where the
  // supervisor could extract one from the worker's stream-json output.
  failureDetail?: string;
  // Legacy receipt data from stored jobs only. New jobs do not scan text;
  // replies do not inherit this historical field.
  leaderDecision?: LeaderDecisionRecord;
  // T1D runner mirrors. workerStatus/acceptanceStatus/gateResults are ALWAYS
  // present with normalized defaults (see toPublicView); contractSchemaVersion
  // is 2 when a v2 contract is stored, null otherwise. The contract body
  // itself is never exposed.
  workerStatus: JobStatus;
  acceptanceStatus: JobAcceptanceStatus;
  gateResults: JobGateSummary[];
  contractSchemaVersion: number | null;
  // T2C public budget mirror (always present with normalized defaults, see
  // toPublicView). The absolute budget config/state paths and the raw metrics
  // reference are NEVER exposed here; metrics is a collector-produced safe
  // copy.
  budgetStatus: BudgetStatus;
  budgetViolation: string | null;
  reportCompleteness: ReportCompleteness | null;
  metrics: JobMetricsV2 | null;
  // Wave4B1 public admission mirror (always present with normalized defaults,
  // see toPublicView). internalAgentParallelism always mirrors the legacy
  // `parallelism` field. Legacy jobs: desired=null, state='disabled',
  // class=null, reason=null, timestamps=null, counts=0, resourceLimit=null,
  // queueMs=0.
  desiredWorkerConcurrency: number | null;
  internalAgentParallelism: string;
  admissionState: JobAdmissionState;
  admissionResourceClass: JobAdmissionResourceClass;
  queueReason: AdmissionQueueReason | null;
  queuedAt: string | null;
  admittedAt: string | null;
  activeWorkers: number;
  queuedWorkers: number;
  resourceLimit: number | null;
  queueMs: number;
}

// ---------------------------------------------------------------------------
// Deliverable inspection (research/analysis). A valid artifact is a regular
// file, non-empty, and hashable with SHA-256. Used by the supervisor BEFORE it
// publishes a terminal status so the leader never sees a silent
// "succeeded but no report" acceptance.
// ---------------------------------------------------------------------------

export type DeliverableValidityReason = 'ok' | 'missing' | 'not_file' | 'empty' | 'unhashable';

export interface DeliverableInspection {
  valid: boolean;
  /** SHA-256 hex digest, present only when valid. */
  hash: string | null;
  /** Human/diagnostic reason; 'ok' when valid. */
  reason: DeliverableValidityReason;
}

export function inspectDeliverable(deliverablePath: string): DeliverableInspection {
  let st: fs.Stats;
  try {
    st = fs.statSync(deliverablePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Only a genuinely absent path is "missing"; an unreadable path is
    // "unhashable" (present but not usable as an artifact).
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { valid: false, hash: null, reason: 'missing' }
      : { valid: false, hash: null, reason: 'unhashable' };
  }
  if (!st.isFile()) return { valid: false, hash: null, reason: 'not_file' };
  if (st.size === 0) return { valid: false, hash: null, reason: 'empty' };
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(deliverablePath));
    return { valid: true, hash: hash.digest('hex'), reason: 'ok' };
  } catch {
    return { valid: false, hash: null, reason: 'unhashable' };
  }
}

/** Wave4B1: queue wait in ms — 0 when never queued; admittedAt-queuedAt when
 * admitted; now-queuedAt while still queued; never negative. */
function queueMsFor(job: Job, now: number): number {
  if (!job.queuedAt) return 0;
  const queued = new Date(job.queuedAt).getTime();
  if (Number.isNaN(queued)) return 0;
  const end = job.admittedAt ? new Date(job.admittedAt).getTime() : now;
  if (Number.isNaN(end)) return 0;
  return Math.max(0, end - queued);
}

export function toPublicView(job: Job): JobView {
  const started = new Date(job.startedAt).getTime();
  const ended = job.endedAt ? new Date(job.endedAt).getTime() : null;
  let idleSeconds: number | null = null;
  if (job.lastOutputAt) {
    const t = new Date(job.lastOutputAt).getTime();
    if (!Number.isNaN(t)) idleSeconds = Math.max(0, Math.round((Date.now() - t) / 1000));
  }
  const view: JobView = {
    jobId: job.jobId,
    sessionId: job.sessionId,
    kind: job.kind,
    replyToJobId: job.replyToJobId,
    profile: job.profile,
    port: job.port,
    permissionMode: job.permissionMode,
    parallelism: job.parallelism,
    workFolder: job.workFolder,
    maxRuntimeMinutes: job.maxRuntimeMinutes,
    status: job.status,
    substatus: job.substatus,
    exitCode: job.exitCode,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    lastActivityAt: job.lastActivityAt,
    runningSeconds: ended ? Math.round((ended - started) / 1000) : Math.round((Date.now() - started) / 1000),
    idleSeconds,
    reportPath: job.reportPath,
    hasReport: fs.existsSync(job.reportPath),
    // T1D normalization (stored value wins; absent falls back):
    // workerStatus -> the job's own lifecycle status; acceptanceStatus ->
    // 'unknown' when a v2 contract exists (its acceptance was part of the
    // contract), 'not_requested' otherwise; gateResults -> empty; the contract
    // body itself is never exposed, only its schema version.
    workerStatus: job.workerStatus ?? job.status,
    acceptanceStatus: job.acceptanceStatus ?? (job.contract ? 'unknown' : 'not_requested'),
    replyMode: job.replyMode ?? null,
    gateResults: (job.gateResults ?? []).map(toGateSummary),
    contractSchemaVersion: job.contract ? CONTRACT_V2_SCHEMA_VERSION : null,
    // T2C normalization: budgetStatus defaults to 'not_requested' on old jobs;
    // reportCompleteness is only set when the supervisor actually measured the
    // report (absent => null, never fabricated as 'complete'); metrics is a
    // collector-produced public safe copy, never the persisted raw reference;
    // a budgetViolation is exposed only as a fixed short code (see
    // sanitizeBudgetViolation), never as raw worker text.
    budgetStatus: job.budgetStatus ?? 'not_requested',
    budgetViolation: job.budgetViolation !== undefined ? sanitizeBudgetViolation(job.budgetViolation) : null,
    reportCompleteness: job.reportCompleteness ?? null,
    metrics: job.metrics ? createJobMetricsCollector(job.metrics).toCompactMetrics() : null,
    // Wave4B1 normalized admission mirror: legacy jobs default to disabled with
    // zero counts; internalAgentParallelism always mirrors the persisted
    // parallelism field so old clients keep working unchanged.
    desiredWorkerConcurrency: job.desiredWorkerConcurrency ?? null,
    internalAgentParallelism: job.parallelism,
    admissionState: job.admissionState ?? 'disabled',
    admissionResourceClass: job.admissionResourceClass ?? null,
    queueReason: job.admissionQueueReason ?? null,
    queuedAt: job.queuedAt ?? null,
    admittedAt: job.admittedAt ?? null,
    activeWorkers: job.activeWorkers ?? 0,
    queuedWorkers: job.queuedWorkers ?? 0,
    resourceLimit: job.resourceLimit ?? null,
    queueMs: queueMsFor(job, Date.now()),
  };
  if (job.workerBackend) view.workerBackend = job.workerBackend;
  if (job.status === 'needs_attention' && job.attentionLog && job.attentionLog.length > 0) {
    view.attentionDetail = job.attentionLog[job.attentionLog.length - 1];
  }
  if (job.attentionResponseAudit) {
    view.attentionResponseAudit = job.attentionResponseAudit;
  }
  if (job.bootstrap) {
    view.bootstrapStage = job.bootstrap.stage;
  }
  if (job.taskType) {
    view.taskType = job.taskType;
  }
  if (job.deliverablePath) {
    view.deliverablePath = job.deliverablePath;
  }
  if (job.deliverableHash) {
    view.deliverableHash = job.deliverableHash;
  }
  if (job.missingDeliverable !== undefined) {
    view.missingDeliverable = job.missingDeliverable;
  }
  if (job.artifactWriteException) {
    view.artifactWriteException = true;
  }
  if (job.failureDetail) {
    view.failureDetail = job.failureDetail;
  }
  if (job.leaderDecision) {
    view.leaderDecision = job.leaderDecision;
  }
  return view;
}
