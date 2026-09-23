// Wave 5B1: retention dry-run planner (pure, read-only).
//
// planRetention() scans an EXISTING runtime root and returns a RetentionPlan
// of candidate actions. It NEVER creates directories, never writes, never
// renames, never truncates, never unlinks, never chmods, and never follows
// symlinks/reparse points: this module is the "planner" only — execution of
// the plan is a separate stage that does not exist here.
//
// Design rules from the Wave 5B1 spec:
//
//   - Read scope is fixed: jobs/*.json (minimal jobId/status/endedAt/
//     startedAt only), logs/<jobId>.log and logs/<jobId>.stderr.log,
//     settings/<jobId>.json, claims/<jobId>.<kind>.json (kind = recover |
//     supervisor), registry/instances/*.json. Everything else is out of
//     scope and never read. Report and job metadata are retained
//     independently (never candidates); the planner has NO delete action at
//     all — actions are archive_registry, truncate_log_candidate,
//     archive_claim_candidate, archive_settings_candidate, keep, skip.
//   - Non-regular files (dirs, symlinks, reparse points, devices) are
//     fixed-skip WITHOUT reading the target. Names come from readdir only
//     (basenames, never interpreted as paths), and any candidate whose
//     normalized relative path escapes the runtime root is skipped without
//     being read. jobs/*.json filenames are matched by a strict regex so a
//     hostile name can never alias another record.
//   - A plan item's age is the NEWER of the file mtime and the record's
//     endedAt (for job-derived candidates) — a job that "ended" long ago
//     whose log was just re-written is NOT a candidate (fresh data must not
//     be listed for truncation). TTLs for log candidates are keyed to the
//     job status: succeeded logs use succeededLogTtlMs; failed/cancelled
//     logs use failedLogTtlMs; needs_attention logs (not terminal, but
//     long-lived by policy) use needsAttentionLogTtlMs. Unknown or corrupt
//     jobs are keep/skip only — the planner never guesses a TTL for
//     something it cannot classify, and never deletes.
//   - Terminal statuses are succeeded | failed | cancelled (shared with
//     job-store's TERMINAL_STATUSES via isTerminal).
//   - Registry staleness reuses the EXISTING registry semantics (corrupt/
//     invalid/pid_not_found/identity_unverified/identity_mismatch/
//     heartbeat_timeout; invalid timestamps classify as invalid): a record
//     is a candidate only when it is stale for a CONTINUOUS time >
//     staleRegistryTtlMs — continuous means the record was also stale at
//     the TTL cutoff, which is proven by its heartbeat timestamp (the
//     heartbeat is the only dateable anchor shared by every stale class).
//     A record stale now but fresh at the cutoff (heartbeat resumed) is
//     keep; a stale record whose stale age cannot be dated (unreadable
//     timestamp) is keep. Live instances, the current self instance,
//     future heartbeats (clock skew) and unreadable registry dirs are
//     keep. Same-host multi-window instances are never a duplicate reason
//     for any action.
//   - Privacy: plan items expose ONLY relativePath (normalized, forward
//     slashes, no ".."), kind, action, fixedReason, ageMs, bytes, and an
//     optional jobId. The absolute runtime root, record contents, prompt,
//     env, PID, tokens and instanceIds never surface.
//   - Determinism: items are sorted by (action, relativePath); one item per
//     file at most; the plan depends only on the scanned tree and `now`.
import fs from 'node:fs';
import path from 'node:path';
import { registryHeartbeatMs, registryStaleAfterMs } from './config.js';
import { isTerminal, type JobStatus } from './job-store.js';
import type { ProcessInspector } from './registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** How a job's logs age: succeeded uses the short TTL; failed/cancelled and
 *  needs_attention use the long TTL (needs_attention is not terminal but its
 *  logs still age out under policy). */
export type JobLogClass = 'succeeded' | 'failed' | 'needs_attention';

export type RetentionAction =
  | 'archive_registry'
  | 'truncate_log_candidate'
  | 'archive_claim_candidate'
  | 'archive_settings_candidate'
  | 'keep'
  | 'skip';

export type PlanItemKind = 'log' | 'stderr_log' | 'settings' | 'claim' | 'registry';

/** Fixed, sanitized reason tokens — never paths, never record content. */
export type RetentionFixedReason =
  | 'terminal_succeeded'
  | 'terminal_failed'
  | 'terminal_cancelled'
  | 'needs_attention_log'
  | 'corrupt'
  | 'invalid'
  | 'pid_not_found'
  | 'identity_unverified'
  | 'identity_mismatch'
  | 'heartbeat_timeout'
  | 'live_instance'
  | 'self_instance'
  | 'future_heartbeat'
  | 'stale_age_unknown'
  | 'not_continuously_stale'
  | 'not_terminal'
  | 'unknown_job'
  | 'not_a_regular_file'
  | 'path_unsafe'
  | 'out_of_scope';

export interface RetentionPolicy {
  /** TTL for succeeded-job logs (default 7d). */
  succeededLogTtlMs: number;
  /** TTL for failed/cancelled-job logs (default 30d). */
  failedLogTtlMs: number;
  /** TTL for needs_attention-job logs (default 30d). */
  needsAttentionLogTtlMs: number;
  /** TTL for terminal jobs' claims and settings (default 14d). */
  terminalClaimSettingsTtlMs: number;
  /** Continuous-stale TTL for registry records (default 24h). */
  staleRegistryTtlMs: number;
}

/** One planned action. Only sanitized, path-bounded fields — never the
 *  absolute runtime root, never record content (prompt/env/PID/token). */
export interface RetentionPlanItem {
  /** Normalized root-relative path, forward slashes, no "..", never absolute. */
  relativePath: string;
  kind: PlanItemKind;
  action: RetentionAction;
  fixedReason: RetentionFixedReason;
  /** Continuous age of the candidate (ms). Absent when no reliable age exists. */
  ageMs: number | null;
  /** File size in bytes when the file is a regular file, else 0. */
  bytes: number;
  /** Job the item belongs to; absent when not job-scoped. */
  jobId?: string;
}

export interface RetentionPlanTotals {
  counts: Record<RetentionAction, number>;
  /** Total bytes per action. */
  bytes: Record<RetentionAction, number>;
}

export interface RetentionPlan {
  items: RetentionPlanItem[];
  totals: RetentionPlanTotals;
}

export interface PlanRetentionOptions {
  /** Absolute path of the runtime root to scan (never surfaced in the plan). */
  runtimeRoot: string;
  /** Injectable "now" (epoch ms). */
  now: number;
  /** Retention policy; fields are clamped to [1h, 365d]. */
  policy: RetentionPolicy;
  /** Process inspector (same semantics as snapshotRegistry's inspector). */
  pidInspector: ProcessInspector;
  /** Test overrides (defaults match the registry's production defaults). */
  overrides?: {
    /** Planner's own instanceId: its record is never archived. */
    instanceId?: string | null;
    /** Heartbeat freshness window (defaults to registryHeartbeatMs()). */
    heartbeatMs?: number;
    /** Continuous-stale window for registry records (defaults to registryStaleAfterMs()). */
    staleAfterMs?: number;
    /** Identity tolerance (defaults to 5000ms). */
    identityToleranceMs?: number;
  };
}

/** Structural subset of ProcessInspector (the planner only needs the two
 *  read-only probes). */
export type InspectorLike = {
  exists(pid: number): boolean;
  startTime(pid: number): number | null;
};

/** Result of classifying one registry record. */
export interface RegistryClassification {
  action: 'archive_registry' | 'keep';
  fixedReason: RetentionFixedReason;
  /** Continuous stale age in ms (ageMs on the plan item), or null. */
  staleSinceMs: number | null;
}

const MIN_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 365 days
const FUTURE_HEARTBEAT_SKEW_MS = 60 * 1000; // >1min in the future = clock skew
const REGISTRY_FILE_RE = /\.json$/;

/** Defaults from the Wave 5B1 policy: succeeded logs 7d; failed and
 *  needs_attention logs 30d; terminal claims/settings 14d; stale registry
 *  entries 24h. */
export function defaultRetentionPolicy(): RetentionPolicy {
  return {
    succeededLogTtlMs: 7 * 24 * 60 * 60 * 1000,
    failedLogTtlMs: 30 * 24 * 60 * 60 * 1000,
    needsAttentionLogTtlMs: 30 * 24 * 60 * 60 * 1000,
    terminalClaimSettingsTtlMs: 14 * 24 * 60 * 60 * 1000,
    staleRegistryTtlMs: 24 * 60 * 60 * 1000,
  };
}

/** Every policy field is clamped to [1h, 365d]. */
export function boundPolicy(policy: RetentionPolicy): RetentionPolicy {
  const bound = (v: number): number => {
    if (typeof v !== 'number') return MIN_TTL_MS;
    if (v === Number.POSITIVE_INFINITY) return MAX_TTL_MS; // overflow → max
    if (!Number.isFinite(v)) return MIN_TTL_MS; // NaN / -Infinity → min
    return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, v));
  };
  return {
    succeededLogTtlMs: bound(policy.succeededLogTtlMs),
    failedLogTtlMs: bound(policy.failedLogTtlMs),
    needsAttentionLogTtlMs: bound(policy.needsAttentionLogTtlMs),
    terminalClaimSettingsTtlMs: bound(policy.terminalClaimSettingsTtlMs),
    staleRegistryTtlMs: bound(policy.staleRegistryTtlMs),
  };
}

// ---------------------------------------------------------------------------
// Path safety (fixed-skip, never read the target)
// ---------------------------------------------------------------------------

const JOB_FILE_RE = /^[0-9a-zA-Z_.-]+\.json$/;
const CLAIM_FILE_RE = /^[0-9a-zA-Z_.-]+\.(recover|supervisor)\.json$/;

/** Strict containment: `inner` is a proper descendant of `outer`
 *  (segment-boundary aware; equality is not inside). */
function isInside(inner: string, outer: string): boolean {
  const rel = path.relative(outer, inner);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Root-relative forward-slash key of a path strictly inside the root, or
 *  null when not inside (escape or equality). */
function relativeKey(inner: string, root: string): string | null {
  return isInside(inner, root) ? path.relative(root, inner).split(path.sep).join('/') : null;
}

/** Basenames of a directory, sorted, or [] when missing/unreadable. */
function listDir(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names.sort();
}

// ---------------------------------------------------------------------------
// Minimal job record view (never the full Job record, never the prompt)
// ---------------------------------------------------------------------------

interface JobView {
  jobId: string;
  status: JobStatus;
  endedAt: string | null;
}

function isJobStatus(v: unknown): v is JobStatus {
  return (
    v === 'queued' ||
    v === 'running' ||
    v === 'needs_attention' ||
    v === 'succeeded' ||
    v === 'failed' ||
    v === 'cancelled'
  );
}

/** Read only the fields the plan needs. Bad/unknown records return null and
 *  the caller falls back to keep/skip — never a guess. */
function readJobView(file: string): JobView | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== 'object' || o === null) return null;
  const r = o as Record<string, unknown>;
  const jobId = r.jobId;
  const status = r.status;
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  if (typeof status !== 'string' || !isJobStatus(status)) return null;
  if (typeof r.startedAt !== 'string' || r.startedAt.length === 0) return null;
  if (r.endedAt !== null && r.endedAt !== undefined && typeof r.endedAt !== 'string') return null;
  return {
    jobId,
    status,
    endedAt: typeof r.endedAt === 'string' ? r.endedAt : null,
  };
}

// ---------------------------------------------------------------------------
// Policy → TTL selection
// ---------------------------------------------------------------------------

function logClassOf(status: JobStatus): JobLogClass | null {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'needs_attention') return 'needs_attention';
  return null; // queued/running: no TTL, never a candidate
}

function ttlFor(logClass: JobLogClass, policy: RetentionPolicy): number {
  if (logClass === 'succeeded') return policy.succeededLogTtlMs;
  if (logClass === 'failed') return policy.failedLogTtlMs;
  return policy.needsAttentionLogTtlMs;
}

function fixedForTerminal(status: JobStatus): RetentionFixedReason {
  return status === 'succeeded'
    ? 'terminal_succeeded'
    : status === 'failed'
      ? 'terminal_failed'
      : 'terminal_cancelled';
}

// ---------------------------------------------------------------------------
// Registry: reuses the existing stale semantics + continuous-age proof
// ---------------------------------------------------------------------------

function isValidRegistryRecord(o: Record<string, unknown>): boolean {
  return (
    o.schemaVersion === 1 &&
    typeof o.instanceId === 'string' &&
    o.instanceId.length > 0 &&
    typeof o.pid === 'number' &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.processStartedAt === 'string' &&
    o.processStartedAt.length > 0 &&
    typeof o.serverStartedAt === 'string' &&
    o.serverStartedAt.length > 0 &&
    typeof o.entry === 'string' &&
    typeof o.buildFingerprint === 'string' &&
    typeof o.lastHeartbeatAt === 'string' &&
    o.lastHeartbeatAt.length > 0 &&
    typeof o.version === 'string'
  );
}

export interface ClassifyRegistryOptions {
  /** Parsed record JSON (anything non-object is corrupt). */
  record: unknown;
  selfInstanceId: string | null;
  now: number;
  /** Freshness window (same default as the registry). */
  heartbeatMs: number;
  /** Stale window (same default as the registry). */
  staleAfterMs: number;
  /** Continuous-stale TTL for archiving. */
  staleRegistryTtlMs: number;
  identityToleranceMs: number;
  inspector: ProcessInspector;
}

/** Per-record classification using the EXISTING registry semantics. A record
 *  is archive_registry only when it is stale at scan time AND was still stale
 *  at the TTL cutoff (proven by its heartbeat timestamp) — i.e. continuously
 *  stale for > staleRegistryTtlMs. Anything unprovable is keep. */
export function classifyRegistryRecord(opts: ClassifyRegistryOptions): RegistryClassification {
  const o = opts.record;
  const invalid = (): RegistryClassification => ({
    action: 'keep',
    fixedReason: 'invalid',
    staleSinceMs: null,
  });

  if (typeof o !== 'object' || o === null) {
    return { action: 'keep', fixedReason: 'corrupt', staleSinceMs: null };
  }
  const r = o as Record<string, unknown>;
  if (!isValidRegistryRecord(r)) return invalid();
  if (opts.selfInstanceId !== null && r.instanceId === opts.selfInstanceId) {
    // The planner's own record: always keep (we are the process writing it).
    return { action: 'keep', fixedReason: 'self_instance', staleSinceMs: null };
  }

  const pid = r.pid as number;
  const hbMs = Date.parse(r.lastHeartbeatAt as string);
  const reasons: RetentionFixedReason[] = [];

  if (Number.isNaN(hbMs)) {
    // Undateable heartbeat: stale age can never be proven.
    return { action: 'keep', fixedReason: 'invalid', staleSinceMs: null };
  }
  if (hbMs > opts.now + FUTURE_HEARTBEAT_SKEW_MS) {
    // Clock skew: never a candidate.
    return { action: 'keep', fixedReason: 'future_heartbeat', staleSinceMs: null };
  }
  if (opts.now - hbMs > opts.staleAfterMs) {
    reasons.push('heartbeat_timeout');
  }
  const staleNow = reasons.length > 0;

  // Identity: live process whose OS start time matches the record.
  let exists: boolean;
  try {
    exists = opts.inspector.exists(pid);
  } catch {
    exists = false;
  }
  if (!exists) {
    reasons.push('pid_not_found');
  } else {
    const startMs = Date.parse(r.processStartedAt as string);
    if (Number.isNaN(startMs)) {
      reasons.push('invalid');
    } else {
      let osStart: number | null = null;
      try {
        osStart = opts.inspector.startTime(pid);
      } catch {
        osStart = null;
      }
      if (osStart === null) {
        reasons.push('identity_unverified');
      } else if (Math.abs(osStart - startMs) > opts.identityToleranceMs) {
        reasons.push('identity_mismatch');
      }
    }
  }

  if (!staleNow && reasons.length === 0) {
    // Identity-verified live: keep.
    return { action: 'keep', fixedReason: 'live_instance', staleSinceMs: null };
  }

  if (reasons.length > 0) {
    // Stale at scan time. Archive only when ALSO stale at the TTL cutoff
    // (continuous staleness), proven by the heartbeat timestamp.
    const cutoff = opts.now - opts.staleRegistryTtlMs;
    if (hbMs > cutoff) {
      // Fresh at the cutoff: staleness is not continuous past the TTL.
      return { action: 'keep', fixedReason: 'not_continuously_stale', staleSinceMs: null };
    }
    // The most specific reason: identity diagnostics are pushed after the
    // heartbeat check, so the last reason carries the finer diagnosis
    // (pid_not_found / identity_mismatch / identity_unverified) instead of
    // the generic heartbeat_timeout every stale record would otherwise show.
    return {
      action: 'archive_registry',
      fixedReason: reasons[reasons.length - 1],
      staleSinceMs: opts.now - hbMs,
    };
  }

  // Fresh heartbeat, identity live: keep.
  return { action: 'keep', fixedReason: 'live_instance', staleSinceMs: null };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

interface ScanCtx {
  root: string;
  now: number;
  policy: RetentionPolicy;
  selfInstanceId: string | null;
  heartbeatMs: number;
  staleAfterMs: number;
  identityToleranceMs: number;
  inspector: ProcessInspector;
}

const ALL_ACTIONS: readonly RetentionAction[] = [
  'archive_registry',
  'truncate_log_candidate',
  'archive_claim_candidate',
  'archive_settings_candidate',
  'keep',
  'skip',
];

function emptyTotals(): RetentionPlanTotals {
  const counts = {} as Record<RetentionAction, number>;
  const bytes = {} as Record<RetentionAction, number>;
  for (const a of ALL_ACTIONS) {
    counts[a] = 0;
    bytes[a] = 0;
  }
  return { counts, bytes };
}

/** One plan item per file, max. */
function scanFile(
  ctx: ScanCtx,
  abs: string,
  kind: PlanItemKind,
  job: JobView | null,
): RetentionPlanItem | null {
  const rel = relativeKey(abs, ctx.root);
  if (!rel) {
    // Structurally impossible from readdir basenames, but never read a
    // candidate that escapes the root.
    return { relativePath: '', kind, action: 'skip', fixedReason: 'path_unsafe', ageMs: null, bytes: 0 };
  }
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return null; // vanished between listing and scan: no item at all
  }
  if (st.isSymbolicLink()) {
    return { relativePath: rel, kind, action: 'skip', fixedReason: 'not_a_regular_file', ageMs: null, bytes: 0 };
  }
  if (!st.isFile()) {
    // Directory, reparse point, device, etc: fixed-skip, never read.
    return { relativePath: rel, kind, action: 'skip', fixedReason: 'not_a_regular_file', ageMs: null, bytes: 0 };
  }

  // Job-scoped age: the newer of record endedAt and file mtime (fresh data
  // must never be listed).
  const jobEndMs = job && job.endedAt !== null ? Date.parse(job.endedAt) : NaN;
  const referenceMs = !Number.isNaN(jobEndMs) ? Math.max(jobEndMs, st.mtimeMs) : st.mtimeMs;
  const ageMs = Math.max(0, ctx.now - referenceMs);

  const keep = (fixedReason: RetentionFixedReason): RetentionPlanItem => ({
    relativePath: rel,
    kind,
    action: 'keep',
    fixedReason,
    ageMs,
    bytes: st.size,
    ...(job ? { jobId: job.jobId } : {}),
  });
  const action = (act: RetentionAction, fixedReason: RetentionFixedReason): RetentionPlanItem => ({
    relativePath: rel,
    kind,
    action: act,
    fixedReason,
    ageMs,
    bytes: st.size,
    ...(job ? { jobId: job.jobId } : {}),
  });

  if (kind === 'log' || kind === 'stderr_log') {
    if (job === null) return keep('unknown_job');
    const logClass = logClassOf(job.status);
    if (logClass === null) return keep('not_terminal');
    const ttl = ttlFor(logClass, ctx.policy);
    if (ageMs >= ttl) {
      const fixedReason =
        logClass === 'succeeded' ? 'terminal_succeeded' : logClass === 'failed' ? 'terminal_failed' : 'needs_attention_log';
      return action('truncate_log_candidate', fixedReason);
    }
    return keep(
      logClass === 'succeeded'
        ? 'terminal_succeeded'
        : logClass === 'failed'
          ? 'terminal_failed'
          : 'needs_attention_log',
    );
  }

  if (kind === 'settings') {
    if (job === null) return keep('unknown_job');
    if (!isTerminal(job.status)) return keep('not_terminal');
    if (ageMs >= ctx.policy.terminalClaimSettingsTtlMs) {
      return action('archive_settings_candidate', fixedForTerminal(job.status));
    }
    return keep(fixedForTerminal(job.status));
  }

  if (kind === 'claim') {
    if (job === null) return keep('unknown_job');
    if (!isTerminal(job.status)) return keep('not_terminal');
    if (ageMs >= ctx.policy.terminalClaimSettingsTtlMs) {
      return action('archive_claim_candidate', fixedForTerminal(job.status));
    }
    return keep(fixedForTerminal(job.status));
  }

  return keep('out_of_scope');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Plan retention actions for one runtime root. Read-only by contract: no
 *  mkdir/rename/write/truncate/unlink/chmod, no symlink/reparse following. */
export function planRetention(opts: PlanRetentionOptions): RetentionPlan {
  const root = path.resolve(opts.runtimeRoot);
  const now = opts.now;
  const policy = boundPolicy(opts.policy);
  const ctx: ScanCtx = {
    root,
    now,
    policy,
    selfInstanceId: opts.overrides?.instanceId ?? null,
    heartbeatMs: opts.overrides?.heartbeatMs ?? registryHeartbeatMs(),
    staleAfterMs: opts.overrides?.staleAfterMs ?? registryStaleAfterMs(),
    identityToleranceMs: opts.overrides?.identityToleranceMs ?? 5000,
    inspector: opts.pidInspector,
  };

  const items: RetentionPlanItem[] = [];
  const totals = emptyTotals();
  const add = (it: RetentionPlanItem | null): void => {
    if (!it) return;
    items.push(it);
    totals.counts[it.action] += 1;
    totals.bytes[it.action] += it.bytes;
  };

  // 1. jobs/*.json — minimal view only.
  const jobs = new Map<string, JobView>();
  for (const name of listDir(path.join(root, 'jobs'))) {
    if (!JOB_FILE_RE.test(name)) continue; // atomic-write tmp files etc: skipped
    const view = readJobView(path.join(root, 'jobs', name));
    if (view) jobs.set(view.jobId, view);
  }

  // 2. logs/<jobId>.log and logs/<jobId>.stderr.log.
  for (const name of listDir(path.join(root, 'logs'))) {
    if (!name.endsWith('.log')) continue;
    const isErr = name.endsWith('.stderr.log');
    const jobId = isErr ? name.slice(0, -'.stderr.log'.length) : name.slice(0, -'.log'.length);
    const job = jobs.get(jobId) ?? null;
    add(scanFile(ctx, path.join(root, 'logs', name), isErr ? 'stderr_log' : 'log', job));
  }

  // 3. settings/<jobId>.json.
  for (const name of listDir(path.join(root, 'settings'))) {
    if (!name.endsWith('.json')) continue;
    const jobId = name.slice(0, -'.json'.length);
    const job = jobs.get(jobId) ?? null;
    add(scanFile(ctx, path.join(root, 'settings', name), 'settings', job));
  }

  // 4. claims/<jobId>.<kind>.json (recover | supervisor).
  for (const name of listDir(path.join(root, 'claims'))) {
    if (!CLAIM_FILE_RE.test(name)) continue;
    const m = /^(.+)\.(recover|supervisor)\.json$/.exec(name);
    if (!m) continue;
    const job = jobs.get(m[1]) ?? null;
    add(scanFile(ctx, path.join(root, 'claims', name), 'claim', job));
  }

  // 5. registry/instances/*.json.
  for (const name of listDir(path.join(root, 'registry', 'instances'))) {
    if (!REGISTRY_FILE_RE.test(name)) continue;
    const abs = path.join(root, 'registry', 'instances', name);
    const rel = relativeKey(abs, root);
    if (!rel) continue; // escape is structurally impossible from a basename
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue; // vanished between listing and scan
    }
    if (!st.isFile()) continue; // non-regular: fixed-skip, never read
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      raw = null;
    }
    const cls = classifyRegistryRecord({
      record: raw,
      selfInstanceId: ctx.selfInstanceId,
      now: ctx.now,
      heartbeatMs: ctx.heartbeatMs,
      staleAfterMs: ctx.staleAfterMs,
      staleRegistryTtlMs: ctx.policy.staleRegistryTtlMs,
      identityToleranceMs: ctx.identityToleranceMs,
      inspector: ctx.inspector,
    });
    add({
      relativePath: rel,
      kind: 'registry',
      action: cls.action,
      fixedReason: cls.fixedReason,
      ageMs: cls.staleSinceMs,
      bytes: st.size,
    });
  }

  // Deterministic order: action, then relativePath.
  items.sort((a, b) => {
    if (a.action !== b.action) return a.action < b.action ? -1 : 1;
    if (a.relativePath !== b.relativePath) return a.relativePath < b.relativePath ? -1 : 1;
    return 0;
  });

  return { items, totals };
}
