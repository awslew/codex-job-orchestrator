// ---------------------------------------------------------------------------
// Job/Session Index (Wave 5A1 — standalone module, NOT wired into
// job-store/scheduler/health/index.ts yet).
//
// Purpose: an O(1)/O(k) in-memory index over the jobs directory. The job JSON
// files under runtime/jobs remain the source of truth; the index is a
// rebuildable derived artifact under runtime/job-index/:
//   snapshot.json  — full serialized index (schemaVersion=1, atomic write)
//   journal.jsonl  — append-only JSONL upsert deltas (schemaVersion=1)
//   index.lock     — O_EXCL writer lock (owner record: pid + startedAt +
//                    lease), held for the duration of record()/rebuild()
//
// Indexed fields are minimal by design — jobId/sessionId/status/kind/
// replyToJobId/startedAt/endedAt only. prompt/extraEnv/workFolder/log/report/
// token/PID are NEVER stored or surfaced (see the "no secrets" tests).
// load() is a streaming prefix replays; a truncated line at EOF or any bad
// schema marks consistency='rebuild_required' and keeps the verified prefix.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runtimeRoot } from './config.js';
import type { JobStatus, JobKind, Job } from './job-store.js';
import type { ProcessInspector } from './registry.js';
import { pidIdentityStatus } from './proc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INDEX_SCHEMA_VERSION = 1;

/** Write policy: any job whose status is not in this set is a BAD index row. */
export const INDEX_JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'running',
  'needs_attention',
  'succeeded',
  'failed',
  'cancelled',
];

export const INDEX_JOB_KINDS: readonly JobKind[] = ['start', 'reply'];

// ---------------------------------------------------------------------------
// Public types (no paths, no prompts, no PIDs ever)
// ---------------------------------------------------------------------------

/** The minimal per-job record the index stores. */
export interface IndexedJob {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  kind: JobKind;
  replyToJobId: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface StatusCounts {
  queued: number;
  running: number;
  needs_attention: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** O(1)/O(k) in-memory index structure. */
export interface JobIndex {
  /** jobId -> minimal record (O(1) lookup). */
  byId: Map<string, IndexedJob>;
  /** sessionId -> jobIds sorted by (startedAt asc, jobId asc) (O(k)). */
  sessionOrder: Map<string, string[]>;
  /** status -> count of jobs in that status (O(1) tally). */
  statusCounts: StatusCounts;
  /** replyToJobId -> direct child jobIds (insertion order preserved). */
  replyChildren: Map<string, string[]>;
}

/** Counts returned by rebuild(); paths/counts only, never job payloads. */
export interface RebuildStats {
  indexed: number;
  skipped: number;
  archivedJournalFiles: number;
}

/** Mismatch counters from consistencyCheck(); counts only, never content. */
export interface ConsistencyReport {
  consistent: boolean;
  totalMismatch: number;
  statusCountMismatch: number;
  sessionMembershipMismatch: number;
  replyToMismatch: number;
}

/** Health of the loaded index; fixed public diagnostics (no paths). */
export interface IndexDiagnostics {
  consistency: 'consistent' | 'rebuild_required' | 'missing';
  snapshotLoaded: boolean;
  journalApplied: number;
  journalLinesRead: number;
  journalBadLines: number;
  /** Byte offset of the first bad/truncated journal line (validated prefix). */
  journalPrefixBytes: number;
}

export type LockBusyReason = 'held' | 'locked_busy';

export type IndexLockStatus =
  | { status: 'acquired'; handle: IndexLockHandle }
  | { status: 'queued'; reason: LockBusyReason }
  | { status: 'busy'; reason: LockBusyReason };

export interface IndexLockHandle {
  ownerId: string;
  ownerPid: number;
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
  lockFilePath: string;
}

export interface IndexLockRecord {
  schemaVersion: number;
  ownerId: string;
  ownerPid: number;
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface JobIndexOptions {
  rootDir?: string;
  /** Explicit lock owner id; defaults to a fresh UUID. */
  ownerId?: string;
  now?: () => number;
  inspector?: ProcessInspector;
  identityToleranceMs?: number;
  leaseMs?: number;
  /** Max wall-clock per O_EXCL attempt loop (rebuild may legitimately exceed). */
  lockBusyMs?: number;
  /** Extra pause between busy attempts (clock injection friendly). */
  retryDelayMs?: number;
}

export interface IndexedJobInput {
  jobId: string;
  sessionId: string;
  status: JobStatus;
  kind: JobKind;
  replyToJobId?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
}

// ---------------------------------------------------------------------------
// Lock helpers
// ---------------------------------------------------------------------------

export function indexDir(rootDir: string = runtimeRoot()): string {
  return path.join(rootDir, 'job-index');
}
export function indexSnapshotPath(rootDir: string = runtimeRoot()): string {
  return path.join(indexDir(rootDir), 'snapshot.json');
}
export function indexJournalPath(rootDir: string = runtimeRoot()): string {
  return path.join(indexDir(rootDir), 'journal.jsonl');
}
export function indexLockPath(rootDir: string = runtimeRoot()): string {
  return path.join(indexDir(rootDir), 'index.lock');
}
export function indexArchiveDir(rootDir: string = runtimeRoot()): string {
  return path.join(indexDir(rootDir), 'archive');
}

function monotonicMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

const LOCK_TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EMFILE', 'ENFILE', 'ENOSPC']);
const INDEX_RETRY_BASE_MS = 10;
const INDEX_RETRY_BACKOFF_CAP_MS = 200;

function defaultSleep(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function readIndexLockRecord(p: string): IndexLockRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Record<string, unknown>;
    if (
      o.schemaVersion !== INDEX_SCHEMA_VERSION ||
      typeof o.ownerId !== 'string' ||
      !Number.isInteger(o.ownerPid) ||
      (o.ownerPid as number) <= 0 ||
      typeof o.ownerStartedAt !== 'string' ||
      typeof o.acquiredAt !== 'string' ||
      typeof o.expiresAt !== 'string'
    ) {
      return null;
    }
    return o as unknown as IndexLockRecord;
  } catch {
    return null;
  }
}

// Rename an existing lock file to a unique tombstone so exactly one concurrent
// stealer wins (a lost rename race surfaces as ENOENT and counts as a win for
// the caller, which then retries the O_EXCL create). Returns true only when the
// caller may retry the create; any other failure returns false so the caller
// backs off and eventually fails closed (never an unbounded retry loop).
function tryStealIndexLock(p: string): boolean {
  const tomb = `${p}.${crypto.randomUUID()}.stale`;
  try {
    fs.renameSync(p, tomb);
    try {
      fs.unlinkSync(tomb); // best-effort tombstone cleanup
    } catch {
      /* leftover tombstone in job-index/ is inert */
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT') return true; // someone else stole it first
    return false;
  }
}

/**
 * Acquire the index writer lock with real O_EXCL semantics. A holder whose
 * lease has NOT expired returns 'queued'/'busy' immediately from the lease
 * alone — the PID inspector is never consulted, so a fast path costs zero
 * process queries. The identity inspector runs ONLY once the lease is
 * provably expired: verified_live is never stolen (the in-memory record may
 * pre-date the stale file); unverifiable fails closed immediately, never
 * trySteal; verified_dead / identity_mismatch are archived by the same
 * rename-steal as before. Owner-match release and tombstone recovery are
 * unchanged.
 */
export function acquireIndexLock(options: JobIndexOptions = {}): IndexLockStatus {
  const rootDir = options.rootDir ?? runtimeRoot();
  const leaseMs = options.leaseMs ?? 60_000;
  const now = options.now ?? Date.now;
  const inspector = options.inspector;
  const tolerance = options.identityToleranceMs ?? 5000;
  const busyMs = options.lockBusyMs ?? 500;
  const delayMs = options.retryDelayMs ?? 10;
  const p = indexLockPath(rootDir);
  try {
    fs.mkdirSync(indexDir(rootDir), { recursive: true });
  } catch {
    /* the O_EXCL open below will surface a real dir problem */
  }
  const nowMs = now();
  const record: IndexLockRecord = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: options.ownerId ?? crypto.randomUUID(),
    ownerPid: process.pid,
    ownerStartedAt: new Date(nowMs - process.uptime() * 1000).toISOString(),
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + leaseMs).toISOString(),
  };
  const started = monotonicMs();
  for (;;) {
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
        const existing = readIndexLockRecord(p);
        if (existing) {
          // Lease-first: an unexpired lease is authoritative on its own —
          // busy immediately, without ever querying the process inspector.
          // Only an expired lease may trigger a PID identity check.
          const exp = Date.parse(existing.expiresAt);
          if (!Number.isNaN(exp) && now() <= exp) {
            return { status: 'busy', reason: 'locked_busy' };
          }
          // Lease expired: now consult the identity inspector.
          const query = inspector ? { exists: inspector.exists, startTime: inspector.startTime } : {};
          const identity = pidIdentityStatus(existing.ownerPid, existing.ownerStartedAt, query, tolerance);
          if (identity === 'verified_live') {
            // The file is stale but the holder is demonstrably still running
            // (e.g. a holder that started before the lease clock). Never steal.
            return { status: 'queued', reason: 'held' };
          }
          if (identity === 'verified_dead' || identity === 'identity_mismatch') {
            if (tryStealIndexLock(p)) continue; // retry the O_EXCL create
            if (monotonicMs() - started >= busyMs) return { status: 'busy', reason: 'locked_busy' };
            defaultSleep(delayMs);
            continue;
          }
          // unverifiable even with an expired lease: fail closed immediately —
          // never trySteal on doubt, regardless of the busy budget.
          return { status: 'busy', reason: 'locked_busy' };
        }
        // Empty/partial/corrupt lock file: the writer may be mid create->write.
        // Recover by atomic rename; repeated failure fails closed on busy.
        if (tryStealIndexLock(p)) continue;
        if (monotonicMs() - started >= busyMs) return { status: 'busy', reason: 'locked_busy' };
        defaultSleep(delayMs);
        continue;
      }
      if (LOCK_TRANSIENT_CODES.has(code) && monotonicMs() - started < busyMs) {
        defaultSleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}

/** Remove the index lock ONLY if this caller still owns it (ownerId + pid). */
export function releaseIndexLock(
  handle: IndexLockHandle,
  options: JobIndexOptions = {},
): void {
  const p = handle.lockFilePath;
  try {
    const existing = readIndexLockRecord(p);
    if (existing && existing.ownerId === handle.ownerId && existing.ownerPid === handle.ownerPid) {
      fs.unlinkSync(p);
    }
  } catch {
    /* already gone (e.g. stolen as provably dead) — nothing to do */
  }
}

// ---------------------------------------------------------------------------
// Core in-memory structure
// ---------------------------------------------------------------------------

export function emptyStatusCounts(): StatusCounts {
  return { queued: 0, running: 0, needs_attention: 0, succeeded: 0, failed: 0, cancelled: 0 };
}

export function emptyJobIndex(): JobIndex {
  return { byId: new Map(), sessionOrder: new Map(), statusCounts: emptyStatusCounts(), replyChildren: new Map() };
}

const SESSION_ORDER_CAP = 10_000;

function cmpJobIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cmpIndexed(a: IndexedJob, b: IndexedJob): number {
  const t = a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0;
  if (t !== 0) return t;
  return cmpJobIds(a.jobId, b.jobId);
}

/**
 * Insert keeping (startedAt asc, jobId asc); O(k) worst case on shift.
 * ISO-8601 timestamps sort lexicographically, so plain string comparison is
 * correct and far cheaper than localeCompare. `knownAbsent` skips the
 * membership scan (the create path guarantees the job is not in the list yet).
 */
function sortedInsert(list: string[], job: IndexedJob, byId: Map<string, IndexedJob>, knownAbsent = false): void {
  if (!knownAbsent && list.includes(job.jobId)) return; // already present; keep existing position
  const target = job.startedAt;
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midRec = byId.get(list[mid]);
    if (!midRec) {
      lo = mid + 1; // defensive: entry vanished from byId; scan right
      continue;
    }
    const cmp = target < midRec.startedAt ? -1 : target > midRec.startedAt ? 1 : 0;
    if (cmp < 0 || (cmp === 0 && job.jobId < list[mid])) hi = mid;
    else lo = mid + 1;
  }
  list.splice(lo, 0, job.jobId);
}

/**
 * Apply one upsert delta to the in-memory structure. Status changes move the
 * job between status counts; same-content duplicate deltas are idempotent.
 * Returns false when the delta is a bad schema row (nothing was applied).
 */
export function applyIndexedJob(index: JobIndex, input: IndexedJobInput): boolean {
  if (
    !input ||
    typeof input.jobId !== 'string' ||
    typeof input.sessionId !== 'string' ||
    typeof input.status !== 'string' ||
    !(INDEX_JOB_STATUSES as readonly string[]).includes(input.status) ||
    typeof input.kind !== 'string' ||
    !(INDEX_JOB_KINDS as readonly string[]).includes(input.kind)
  ) {
    return false;
  }
  if (input.replyToJobId !== undefined && input.replyToJobId !== null && typeof input.replyToJobId !== 'string') {
    return false;
  }
  if (input.startedAt !== undefined && input.startedAt !== null && typeof input.startedAt !== 'string') {
    return false;
  }
  if (input.endedAt !== undefined && input.endedAt !== null && typeof input.endedAt !== 'string') {
    return false;
  }
  if (typeof input.jobId === 'string' && input.jobId.length === 0) return false;

  const prev = index.byId.get(input.jobId);
  const rec: IndexedJob = {
    jobId: input.jobId,
    sessionId: input.sessionId,
    status: input.status as JobStatus,
    kind: input.kind as JobKind,
    replyToJobId: input.replyToJobId ?? null,
    startedAt: input.startedAt ?? prev?.startedAt ?? '',
    endedAt: input.endedAt ?? prev?.endedAt ?? null,
  };
  if (rec.startedAt === '') return false;

  if (prev && prev.status === rec.status && prev.sessionId === rec.sessionId && prev.kind === rec.kind && prev.replyToJobId === rec.replyToJobId && prev.startedAt === rec.startedAt && prev.endedAt === rec.endedAt) {
    return true; // duplicate of the current record: idempotent no-op
  }

  if (prev) {
    index.statusCounts[prev.status] -= 1; // move between counts
    index.statusCounts[rec.status] += 1;
    const list = index.sessionOrder.get(rec.sessionId);
    if (!list) {
      index.sessionOrder.set(rec.sessionId, [rec.jobId]);
    } else {
      sortedInsert(list, rec, index.byId); // job may already be in this list (same-session update)
      if (list.length > SESSION_ORDER_CAP) {
        list.splice(0, list.length - SESSION_ORDER_CAP); // bounded memory
      }
    }
    if (rec.replyToJobId !== null) {
      const children = index.replyChildren.get(rec.replyToJobId);
      if (children) {
        if (!children.includes(rec.jobId)) children.push(rec.jobId);
      } else {
        index.replyChildren.set(rec.replyToJobId, [rec.jobId]);
      }
    }
    if (prev.sessionId !== rec.sessionId) {
      // Session move: remove from the old session list (first occurrence).
      const oldList = index.sessionOrder.get(prev.sessionId);
      if (oldList) {
        const i = oldList.indexOf(rec.jobId);
        if (i !== -1) oldList.splice(i, 1);
        if (oldList.length === 0) index.sessionOrder.delete(prev.sessionId);
      }
      const list = index.sessionOrder.get(rec.sessionId);
      if (!list) {
        index.sessionOrder.set(rec.sessionId, [rec.jobId]);
      } else {
        sortedInsert(list, rec, index.byId); // line 444 already inserted it; membership check dedups
      }
    } else if (prev.startedAt !== rec.startedAt) {
      const list = index.sessionOrder.get(rec.sessionId);
      if (list) {
        const i = list.indexOf(rec.jobId);
        if (i !== -1) {
          list.splice(i, 1);
          sortedInsert(list, rec, index.byId, true); // just removed it; guaranteed absent
        }
      }
    }
    if (prev.replyToJobId !== rec.replyToJobId) {
      if (prev.replyToJobId !== null) {
        const oldChildren = index.replyChildren.get(prev.replyToJobId);
        if (oldChildren) {
          const i = oldChildren.indexOf(rec.jobId);
          if (i !== -1) oldChildren.splice(i, 1);
          if (oldChildren.length === 0) index.replyChildren.delete(prev.replyToJobId);
        }
      }
      if (rec.replyToJobId !== null) {
        const children = index.replyChildren.get(rec.replyToJobId);
        if (children) {
          if (!children.includes(rec.jobId)) children.push(rec.jobId);
        } else {
          index.replyChildren.set(rec.replyToJobId, [rec.jobId]);
        }
      }
    }
  } else {
    index.statusCounts[rec.status] += 1;
    const list = index.sessionOrder.get(rec.sessionId);
    if (!list) {
      index.sessionOrder.set(rec.sessionId, [rec.jobId]);
    } else {
      sortedInsert(list, rec, index.byId, true); // create path: guaranteed not in any list yet
      if (list.length > SESSION_ORDER_CAP) {
        list.splice(0, list.length - SESSION_ORDER_CAP); // bounded memory
      }
    }
    if (rec.replyToJobId !== null) {
      const children = index.replyChildren.get(rec.replyToJobId);
      if (children) {
        if (!children.includes(rec.jobId)) children.push(rec.jobId);
      } else {
        index.replyChildren.set(rec.replyToJobId, [rec.jobId]);
      }
    }
  }
  index.byId.set(rec.jobId, rec);
  return true;
}

// ---------------------------------------------------------------------------
// Snapshot / journal persistence
// ---------------------------------------------------------------------------

interface SnapshotFile {
  schemaVersion: number;
  jobs: IndexedJob[];
}

function parseSnapshot(raw: unknown): IndexedJob[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.schemaVersion !== INDEX_SCHEMA_VERSION || !Array.isArray(o.jobs)) return null;
  const out: IndexedJob[] = [];
  for (const item of o.jobs) {
    if (!item || typeof item !== 'object') return null;
    const rec = item as Record<string, unknown>;
    if (
      typeof rec.jobId !== 'string' ||
      typeof rec.sessionId !== 'string' ||
      typeof rec.status !== 'string' ||
      !(INDEX_JOB_STATUSES as readonly string[]).includes(rec.status) ||
      typeof rec.kind !== 'string' ||
      !(INDEX_JOB_KINDS as readonly string[]).includes(rec.kind) ||
      (rec.replyToJobId !== null && typeof rec.replyToJobId !== 'string') ||
      typeof rec.startedAt !== 'string' ||
      (rec.endedAt !== null && typeof rec.endedAt !== 'string')
    ) {
      return null;
    }
    out.push({
      jobId: rec.jobId,
      sessionId: rec.sessionId,
      status: rec.status as JobStatus,
      kind: rec.kind as JobKind,
      replyToJobId: (rec.replyToJobId as string) ?? null,
      startedAt: rec.startedAt as string,
      endedAt: (rec.endedAt as string) ?? null,
    });
  }
  return out;
}

/**
 * Atomically write the full snapshot. The ONLY writer — record() appends to
 * the journal and never rewrites the snapshot, so rebuildIndex alone decides
 * when a fresh snapshot replaces the previous one.
 */
export function writeSnapshot(rootDir: string, index: JobIndex): void {
  const snap: SnapshotFile = { schemaVersion: INDEX_SCHEMA_VERSION, jobs: [...index.byId.values()] };
  const p = indexSnapshotPath(rootDir);
  const tmp = `${p}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const d = path.dirname(p);
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch {
    /* the write below will surface a real dir problem */
  }
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(snap), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, p);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Load the index: read snapshot.json (if any), then replay journal.jsonl in
 * order. A truncated final line, a bad JSON line, or an invalid row marks
 * consistency='rebuild_required' and keeps the verified prefix. Both files
 * missing => empty index with consistency='missing'.
 */
export function loadIndex(rootDir: string): { index: JobIndex; diagnostics: IndexDiagnostics } {
  const index = emptyJobIndex();
  const dir = indexDir(rootDir);
  const snapPath = indexSnapshotPath(rootDir);
  const journalPath = indexJournalPath(rootDir);
  const snapBytes = fs.existsSync(snapPath) ? fs.statSync(snapPath).size : 0;
  const journalBytes = fs.existsSync(journalPath) ? fs.statSync(journalPath).size : 0;

  const diag: IndexDiagnostics = {
    consistency: 'missing',
    snapshotLoaded: false,
    journalApplied: 0,
    journalLinesRead: 0,
    journalBadLines: 0,
    journalPrefixBytes: 0,
  };
  if (snapBytes === 0 && journalBytes === 0) {
    return { index, diagnostics: diag };
  }

  let truncated = false;
  let prefixBytes = 0;
  let sawSnapshot = false;
  let sawJournal = false;
  let firstBad = false;

  if (snapBytes > 0) {
    sawSnapshot = true;
    try {
      const raw = JSON.parse(fs.readFileSync(snapPath, 'utf8')) as unknown;
      const jobs = parseSnapshot(raw);
      if (!jobs) {
        truncated = true;
        firstBad = true;
      } else {
        for (const j of jobs) applyIndexedJob(index, j);
        diag.snapshotLoaded = true;
      }
    } catch {
      truncated = true;
      firstBad = true;
    }
  }

  if (journalBytes > 0) {
    sawJournal = true;
    prefixBytes = 0;
    if (!firstBad) {
      try {
        let fh: number | null = null;
        try {
          fh = fs.openSync(journalPath, 'r');
          const buf = Buffer.alloc(1024 * 1024);
          let carry = '';
          let position = 0;
          let eof = false;
          // stopEarly: replay stops at the first bad line so the verified
          // prefix is a single contiguous byte range [0, prefixBytes).
          let stopEarly = false;
          while (!eof) {
            const n = fs.readSync(fh, buf, 0, buf.length, position);
            if (n <= 0) {
              eof = true;
              break;
            }
            const chunk = carry + buf.toString('utf8', 0, n);
            position += n;
            let nl = chunk.indexOf('\n');
            let off = 0;
            while (nl !== -1) {
              const line = chunk.slice(off, nl);
              off = nl + 1;
              const lineStart = position - chunk.length + off;
              diag.journalLinesRead += 1;
              const last = nl === chunk.length - 1;
              let parsed: unknown;
              try {
                parsed = JSON.parse(line);
              } catch {
                diag.journalBadLines += 1;
                if (last) truncated = true;
                if (!firstBad) {
                  firstBad = true;
                  prefixBytes = lineStart - line.length - 1;
                }
                stopEarly = true;
                break;
              }
              if (!applyIndexedJob(index, parsed as IndexedJobInput)) {
                diag.journalBadLines += 1;
                if (!firstBad) {
                  firstBad = true;
                  prefixBytes = lineStart - line.length - 1;
                }
                stopEarly = true;
                break;
              }
              diag.journalApplied += 1;
              nl = chunk.indexOf('\n', off);
            }
            if (stopEarly) break;
            carry = chunk.slice(off);
          }
          // A non-empty carry at EOF is a final line without a trailing newline.
          // Per the delta format (each record ends with '\n'), that is a
          // truncated record: mark it bad and keep the verified prefix.
          if (carry.length > 0) {
            diag.journalLinesRead += 1;
            diag.journalBadLines += 1;
            truncated = true;
            if (!firstBad) {
              firstBad = true;
              const prefixEnd = position - carry.length;
              prefixBytes = prefixEnd > 0 ? prefixEnd : 0;
            }
          }
        } finally {
          if (fh !== null) fs.closeSync(fh);
        }
      } catch {
        truncated = true;
        firstBad = true;
      }
    }
  }

  if (!sawSnapshot && !sawJournal) {
    diag.consistency = 'missing';
  } else {
    diag.consistency = firstBad || truncated ? 'rebuild_required' : 'consistent';
    diag.journalPrefixBytes = prefixBytes;
  }
  return { index, diagnostics: diag };
}

// ---------------------------------------------------------------------------
// record() — the writer path
// ---------------------------------------------------------------------------

/**
 * Persist one upsert delta under the O_EXCL index.lock and apply it to memory.
 * The journal (journal.jsonl) is the durable source of truth and is only ever
 * appended; the snapshot is never rewritten here — writeSnapshot is called
 * exclusively by rebuildIndex. Load always replays snapshot + journal in order,
 * so a crash loses at most the deltas appended since the last rebuild.
 * Returns true only when the delta was durably appended AND applied; duplicate
 * deltas return true without appending.
 */
export function recordIndexedJob(
  index: JobIndex,
  input: IndexedJobInput,
  options: JobIndexOptions = {},
): boolean {
  const rootDir = options.rootDir ?? runtimeRoot();
  const journalPath = indexJournalPath(rootDir);
  try {
    fs.mkdirSync(indexDir(rootDir), { recursive: true });
  } catch {
    /* the append below will surface a real dir problem */
  }
  const status = acquireIndexLock(options);
  if (status.status !== 'acquired') return false;
  try {
    // Refresh state under the lock: a concurrent writer may have rotated the
    // journal (rebuild) between our call and the lock acquisition.
    let replaced = false;
    const loaded = loadIndex(rootDir);
    if (loaded.diagnostics.consistency !== 'missing' && loaded.index.byId.size > 0) {
      index.byId = loaded.index.byId;
      index.sessionOrder = loaded.index.sessionOrder;
      index.statusCounts = loaded.index.statusCounts;
      index.replyChildren = loaded.index.replyChildren;
      replaced = true;
    }
    // Apply to memory under the lock (the single source of truth). If this
    // delta is a no-op against the current state, nothing is persisted.
    const before = index.byId.get(input.jobId) ?? null;
    const applied = applyIndexedJob(index, input);
    if (!applied) return false;
    if (replaced && !inputDiffersFrom(before, input)) {
      return true; // duplicate of the current record: idempotent no-op
    }
    const delta = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      jobId: input.jobId,
      sessionId: input.sessionId,
      status: input.status,
      kind: input.kind,
      replyToJobId: input.replyToJobId ?? null,
      startedAt: input.startedAt ?? '',
      endedAt: input.endedAt ?? null,
    };
    try {
      fs.appendFileSync(journalPath, JSON.stringify(delta) + '\n', 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        fs.mkdirSync(indexDir(rootDir), { recursive: true });
        fs.appendFileSync(journalPath, JSON.stringify(delta) + '\n', 'utf8');
      } else {
        throw err;
      }
    }
    return true;
  } finally {
    releaseIndexLock(status.handle, options);
  }
}

/** True when `input` differs from the pre-apply record (i.e. a fresh record or
 *  a real mutation); false when it is a no-op duplicate. */
function inputDiffersFrom(before: IndexedJob | null, input: IndexedJobInput): boolean {
  if (!before) return true;
  return !(
    before.status === input.status &&
    before.sessionId === input.sessionId &&
    before.kind === input.kind &&
    (before.replyToJobId ?? null) === (input.replyToJobId ?? null) &&
    before.startedAt === (input.startedAt ?? before.startedAt) &&
    (before.endedAt ?? null) === (input.endedAt ?? before.endedAt ?? null)
  );
}

// ---------------------------------------------------------------------------
// rebuild() — full rebuild from the source of truth
// ---------------------------------------------------------------------------

function toIndexedJob(j: Job): IndexedJob | null {
  if (!j || typeof j !== 'object') return null;
  if (
    typeof j.jobId !== 'string' ||
    typeof j.sessionId !== 'string' ||
    typeof j.status !== 'string' ||
    !(INDEX_JOB_STATUSES as readonly string[]).includes(j.status) ||
    typeof j.kind !== 'string' ||
    !(INDEX_JOB_KINDS as readonly string[]).includes(j.kind) ||
    (j.replyToJobId !== null && j.replyToJobId !== undefined && typeof j.replyToJobId !== 'string') ||
    typeof j.startedAt !== 'string'
  ) {
    return null;
  }
  return {
    jobId: j.jobId,
    sessionId: j.sessionId,
    status: j.status as JobStatus,
    kind: j.kind as JobKind,
    replyToJobId: j.replyToJobId ?? null,
    startedAt: j.startedAt,
    endedAt: j.endedAt ?? null,
  };
}

function archiveJournal(rootDir: string): number {
  const dir = indexDir(rootDir);
  const journal = indexJournalPath(rootDir);
  let archived = 0;
  try {
    if (!fs.existsSync(journal)) return 0;
    fs.mkdirSync(indexArchiveDir(rootDir), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(indexArchiveDir(rootDir), `journal.${stamp}.${crypto.randomUUID().slice(0, 8)}.jsonl`);
    fs.renameSync(journal, dest);
    archived = 1;
  } catch {
    /* rename failures leave the journal in place; the rebuild still proceeds */
  }
  return archived;
}

/**
 * Full rebuild from the authoritative job list. Under the O_EXCL lock: archive
 * the old journal (never delete), atomically write a fresh snapshot, truncate
 * the journal. Invalid records are skipped and counted. Returns exact counts.
 */
export function rebuildIndex(jobs: Job[], options: JobIndexOptions = {}): RebuildStats {
  const rootDir = options.rootDir ?? runtimeRoot();
  const status = acquireIndexLock(options);
  if (status.status !== 'acquired') {
    return { indexed: 0, skipped: 0, archivedJournalFiles: 0 };
  }
  try {
    const index = emptyJobIndex();
    let skipped = 0;
    for (const j of jobs) {
      const rec = toIndexedJob(j);
      if (!rec || !applyIndexedJob(index, rec)) {
        skipped += 1;
        continue;
      }
    }
    const archivedJournalFiles = archiveJournal(rootDir);
    writeSnapshot(rootDir, index);
    // Truncate (not delete) the journal after the snapshot is safely on disk.
    try {
      fs.writeFileSync(indexJournalPath(rootDir), '', 'utf8');
    } catch {
      /* a stale journal survives rebuild; the snapshot is authoritative */
    }
    return { indexed: index.byId.size, skipped, archivedJournalFiles };
  } finally {
    releaseIndexLock(status.handle, options);
  }
}

// ---------------------------------------------------------------------------
// consistencyCheck() — compare the index against the source of truth
// ---------------------------------------------------------------------------

/**
 * Compare the loaded index against the authoritative job list. Never outputs
 * job content (prompt/paths); only counters. The caller decides whether to
 * trigger an asynchronous rebuild.
 */
export function consistencyCheck(
  index: JobIndex,
  jobs: Job[],
): ConsistencyReport {
  const total = index.byId.size;
  const statusCountMismatch: string[] = [];
  const sessionMembershipMismatch: string[] = [];
  const replyToMismatch: string[] = [];

  const counts = emptyStatusCounts();
  for (const j of jobs) {
    const rec = toIndexedJob(j);
    if (!rec) continue;
    if (rec.status) counts[rec.status] += 1;
    const idx = index.byId.get(j.jobId);
    if (!idx || idx.status !== rec.status) {
      statusCountMismatch.push(j.jobId);
    }
    if (!idx || idx.sessionId !== rec.sessionId) {
      sessionMembershipMismatch.push(j.jobId);
    }
    if (!idx || (idx.replyToJobId ?? null) !== (rec.replyToJobId ?? null)) {
      replyToMismatch.push(j.jobId);
    }
  }
  for (const s of INDEX_JOB_STATUSES) {
    if (index.statusCounts[s] !== counts[s]) {
      statusCountMismatch.push(`count:${s}`);
    }
  }
  for (const [sessionId, jobIds] of index.sessionOrder) {
    const seen = new Set(jobIds);
    for (const j of jobs) {
      if (j.sessionId === sessionId && !seen.has(j.jobId)) {
        sessionMembershipMismatch.push(`missing-in-session:${sessionId}`);
        break;
      }
    }
  }
  for (const [parent, children] of index.replyChildren) {
    const seen = new Set(children);
    for (const j of jobs) {
      if ((j.replyToJobId ?? null) === parent && !seen.has(j.jobId)) {
        replyToMismatch.push(`missing-child:${parent}`);
        break;
      }
    }
  }

  return {
    consistent: total > 0 && statusCountMismatch.length === 0 && sessionMembershipMismatch.length === 0 && replyToMismatch.length === 0,
    totalMismatch: statusCountMismatch.length + sessionMembershipMismatch.length + replyToMismatch.length,
    statusCountMismatch: statusCountMismatch.length,
    sessionMembershipMismatch: sessionMembershipMismatch.length,
    replyToMismatch: replyToMismatch.length,
  };
}

// ---------------------------------------------------------------------------
// Query helpers (O(1)/O(k))
// ---------------------------------------------------------------------------

/** O(1): the minimal record for a jobId, or null. */
export function getIndexedJob(index: JobIndex, jobId: string): IndexedJob | null {
  return index.byId.get(jobId) ?? null;
}

/** O(k): jobIds of a session sorted by (startedAt asc, jobId asc). */
export function jobsForSession(index: JobIndex, sessionId: string): string[] {
  return index.sessionOrder.get(sessionId) ?? [];
}

/** O(1): snapshot of status counts. */
export function statusCountsOf(index: JobIndex): StatusCounts {
  return { ...index.statusCounts };
}

/** O(1): direct children of a jobId. */
export function replyChildrenOf(index: JobIndex, jobId: string): string[] {
  return index.replyChildren.get(jobId) ?? [];
}

/**
 * The reply chain from root to the given jobId, following replyToJobId.
 * Returns null when the jobId is unknown, the chain contains a cycle, or the
 * chain leaves the index (missing ancestor). A job with no replyToJobId is its
 * own root (chain = [jobId]). Deterministic order: root first, then down to
 * the target.
 */
export function replyChain(index: JobIndex, jobId: string): string[] | null {
  const target = index.byId.get(jobId);
  if (!target) return null;
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = jobId;
  while (cur !== null) {
    if (seen.has(cur)) return null; // cycle
    seen.add(cur);
    const rec = index.byId.get(cur);
    if (!rec) return null; // dangling ancestor
    chain.unshift(cur);
    cur = rec.replyToJobId;
  }
  return chain;
}

/** Number of jobs in the index (O(1)). */
export function indexSize(index: JobIndex): number {
  return index.byId.size;
}

// ---------------------------------------------------------------------------
// Diagnostics (public, fixed; never expose paths)
// ---------------------------------------------------------------------------

export function indexDiagnosticsSummary(d: IndexDiagnostics): string {
  return `consistency=${d.consistency};snapshotLoaded=${d.snapshotLoaded};journalApplied=${d.journalApplied};journalLinesRead=${d.journalLinesRead};journalBadLines=${d.journalBadLines};journalPrefixBytes=${d.journalPrefixBytes}`;
}
