// src/admission.ts
// Wave4A admission core: pure admission evaluation + O_EXCL lease lifecycle.
//
// Runtime file layout (created under <runtimeRoot>/admission on demand):
//   leases/<jobId>.json   — live leases
//   stale/                — dead/unverifiable leases, archived via rename (never deleted)
//   released/             — released leases, moved via rename (never deleted)
//   lease.lock            — global mutex, opened with O_EXCL ('wx')
//
// Public decisions return counts/reasons only. Absolute workFolder and
// pidStartedAt live in the internal lease files and are stripped from every
// public result. Nothing here touches env, prompt, or the network.

import fs from 'node:fs';
import path from 'node:path';

// ---------- Types ----------

export type AdmissionResourceClass = 'light' | 'build' | 'heavy';

export type AdmissionQueueReason =
  | 'desired_limit'
  | 'hard_safety_ceiling'
  | 'backend_profile_limit'
  | 'memory_reserve'
  | 'heavy_limit'
  | 'derived_space_conflict'
  | 'lock_busy';

export interface AdmissionPolicy {
  desiredWorkerConcurrency: number;
  hardSafetyCeiling: number;
  maxHeavyWorkers: number;
  memoryReserveMb: number;
  /** Optional independent hard caps; keys may be "<backend>/<profile>", "<backend>", or "<profile>". */
  backendProfileLimits?: Record<string, number>;
}

export interface AdmissionRequest {
  jobId: string;
  resourceClass: AdmissionResourceClass;
  backend: string;
  profile: string;
  workFolder: string;
  pid: number;
  pidStartedAt: number;
}

export const ADMISSION_LEASE_SCHEMA_VERSION = 1;

export interface AdmissionLease {
  schemaVersion: typeof ADMISSION_LEASE_SCHEMA_VERSION;
  jobId: string;
  resourceClass: AdmissionResourceClass;
  backend: string;
  profile: string;
  /** Absolute work folder. Internal lease-file field only — never returned publicly. */
  workFolder: string;
  pid: number;
  /** Process start time, used to detect PID reuse. Internal only — never returned publicly. */
  pidStartedAt: number;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

/** Public, sanitized lease view: identifiers and timestamps only — no paths, no process identity. */
export type PublicLease = Omit<AdmissionLease, 'workFolder' | 'pidStartedAt'>;

export interface LiveLeaseInfo {
  jobId: string;
  resourceClass: AdmissionResourceClass;
  workFolder: string;
  active: boolean;
}

export type EvaluationDenyReason = AdmissionQueueReason | 'invalid_policy' | 'invalid_request';

export interface AdmissionEvaluation {
  admitted: boolean;
  /** Derived from the liveLeases input — never fabricated. */
  active: number;
  /** Derived from the liveLeases input — never fabricated. */
  queued: number;
  desired: number;
  resourceLimit: number;
  /** Why admission failed; null when admitted. */
  reason: EvaluationDenyReason | null;
}

// ---------- Pure evaluation ----------

const RESOURCE_CLASSES: readonly AdmissionResourceClass[] = ['light', 'build', 'heavy'];
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WORKER_CONCURRENCY = 64;

function isPosInt(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}

/** Invalid policy field name, or null when the policy is valid. */
function invalidPolicyField(policy: AdmissionPolicy): string | null {
  if (typeof policy !== 'object' || policy === null) return 'policy';
  if (!isPosInt(policy.desiredWorkerConcurrency) || policy.desiredWorkerConcurrency > MAX_WORKER_CONCURRENCY) return 'desiredWorkerConcurrency';
  if (!isPosInt(policy.hardSafetyCeiling) || policy.hardSafetyCeiling > MAX_WORKER_CONCURRENCY) return 'hardSafetyCeiling';
  if (!isPosInt(policy.maxHeavyWorkers) || policy.maxHeavyWorkers > MAX_WORKER_CONCURRENCY) return 'maxHeavyWorkers';
  if (!Number.isInteger(policy.memoryReserveMb) || policy.memoryReserveMb < 0) return 'memoryReserveMb';
  if (policy.backendProfileLimits !== undefined) {
    if (typeof policy.backendProfileLimits !== 'object' || policy.backendProfileLimits === null || Array.isArray(policy.backendProfileLimits)) return 'backendProfileLimits';
    for (const v of Object.values(policy.backendProfileLimits)) {
      if (!isPosInt(v) || v > MAX_WORKER_CONCURRENCY) return 'backendProfileLimits';
    }
  }
  return null;
}

/** Invalid request field name, or null when the request is valid. */
function invalidRequestField(request: AdmissionRequest): string | null {
  if (typeof request !== 'object' || request === null) return 'request';
  if (typeof request.jobId !== 'string' || !JOB_ID_RE.test(request.jobId)) return 'jobId';
  if (!RESOURCE_CLASSES.includes(request.resourceClass)) return 'resourceClass';
  if (typeof request.backend !== 'string' || request.backend.length === 0) return 'backend';
  if (typeof request.profile !== 'string' || request.profile.length === 0) return 'profile';
  if (typeof request.workFolder !== 'string' || request.workFolder.length === 0) return 'workFolder';
  if (!Number.isInteger(request.pid) || request.pid <= 0) return 'pid';
  if (!Number.isInteger(request.pidStartedAt) || request.pidStartedAt <= 0) return 'pidStartedAt';
  return null;
}

/** Same work folder regardless of relative/absolute spelling and (on Windows) case. */
function canonicalWorkFolder(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Smallest applicable backend/profile limit, or Infinity when none applies. */
function scopeLimitFor(policy: AdmissionPolicy, request: AdmissionRequest): number {
  const limits = policy.backendProfileLimits;
  if (limits === undefined) return Number.POSITIVE_INFINITY;
  const applied = [
    limits[`${request.backend}/${request.profile}`],
    limits[request.backend],
    limits[request.profile],
  ].filter((v): v is number => typeof v === 'number');
  return applied.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...applied);
}

export function evaluateAdmission(
  policy: AdmissionPolicy,
  request: AdmissionRequest,
  liveLeases: LiveLeaseInfo[],
  runtime: { freeMemoryMb: number },
): AdmissionEvaluation {
  const leases = Array.isArray(liveLeases) ? liveLeases : [];
  const active = leases.filter((l) => l.active).length;
  const queued = leases.length - active;

  if (invalidPolicyField(policy) !== null) {
    return { admitted: false, active, queued, desired: 0, resourceLimit: 0, reason: 'invalid_policy' };
  }
  if (invalidRequestField(request) !== null) {
    return { admitted: false, active, queued, desired: 0, resourceLimit: 0, reason: 'invalid_request' };
  }

  const desired = policy.desiredWorkerConcurrency;
  const scope = scopeLimitFor(policy, request);
  const resourceLimit = Math.min(desired, policy.hardSafetyCeiling, scope);
  const deny = (reason: AdmissionQueueReason): AdmissionEvaluation => ({ admitted: false, active, queued, desired, resourceLimit, reason });

  // Global gate first, then class caps, then the worker-concurrency limit.
  if (policy.memoryReserveMb > 0 && runtime.freeMemoryMb < policy.memoryReserveMb) return deny('memory_reserve');
  if (request.resourceClass === 'heavy') {
    const heavyActive = leases.filter((l) => l.active && l.resourceClass === 'heavy').length;
    if (heavyActive >= policy.maxHeavyWorkers) return deny('heavy_limit');
  }
  if (request.resourceClass === 'build' || request.resourceClass === 'heavy') {
    const reqFolder = canonicalWorkFolder(request.workFolder);
    const conflict = leases.some(
      (l) => l.active && (l.resourceClass === 'build' || l.resourceClass === 'heavy') && canonicalWorkFolder(l.workFolder) === reqFolder,
    );
    if (conflict) return deny('derived_space_conflict');
  }
  if (active >= resourceLimit) {
    // The binding cap is the one that produced the minimum.
    const reason: AdmissionQueueReason =
      scope < Math.min(desired, policy.hardSafetyCeiling) ? 'backend_profile_limit'
      : policy.hardSafetyCeiling < desired ? 'hard_safety_ceiling'
      : 'desired_limit';
    return deny(reason);
  }
  return { admitted: true, active, queued, desired, resourceLimit, reason: null };
}

// ---------- Lease lifecycle (O_EXCL lock + file leases) ----------

export interface PidIdentityInspector {
  /** true = alive, false = confirmed dead/absent, null = cannot determine. */
  isAlive(pid: number): boolean | null;
  /** true = same process, false = PID reused by another process, null = cannot determine. */
  startedAtMatches(pid: number, pidStartedAt: number): boolean | null;
}

const UNKNOWN_INSPECTOR: PidIdentityInspector = { isAlive: () => null, startedAtMatches: () => null };

export interface AdmissionManagerOptions {
  /** Root for the admission area; <root>/admission/{leases,stale,released}/ and lease.lock live here. */
  runtimeRoot: string;
  /** Lease TTL in ms; clamped to [1000, 3600000]. Default 60000. */
  ttlMs?: number;
  /** Injectable clock for expiry/staleness decisions. Defaults to Date.now. */
  now?: () => number;
  /** PID identity inspector for stale classification. Defaults to "unknown", so TTL governs. */
  pidIdentity?: PidIdentityInspector;
  /** Bounded wait for the global O_EXCL lock before reporting lock_busy. Default 500 ms. */
  lockMaxWaitMs?: number;
}

export type AcquireDenyReason =
  | 'lock_busy'
  | 'invalid_job_id'
  | 'invalid_request'
  | 'invalid_policy'
  | 'duplicate_job'
  | 'denied';

export interface AcquireAdmissionResult {
  ok: boolean;
  /** Non-null exactly when ok === false. */
  reason: AcquireDenyReason | null;
  /** Sanitized lease; present only when ok === true. */
  lease: PublicLease | null;
  /** jobIds whose previous lease files were archived to admission/stale during this call. */
  staleArchived: string[];
  /** Evaluation verdict + decision counts; present whenever evaluation ran. */
  evaluation: AdmissionEvaluation | null;
}

export type OwnerOpReason =
  | 'lock_busy'
  | 'invalid_job_id'
  | 'invalid_next_owner'
  | 'lease_not_found'
  | 'owner_mismatch'
  | 'bad_lease_file';

export type HeartbeatResult =
  | { ok: true; jobId: string; heartbeatAt: number; expiresAt: number }
  | { ok: false; jobId: string; reason: OwnerOpReason };

export type ReleaseResult =
  | { ok: true; jobId: string }
  | { ok: false; jobId: string; reason: OwnerOpReason };

/** Wave4B1 lease-ownership handoff: the same jobId, a new worker pid identity. */
export type TransferLeaseResult =
  | { ok: true; jobId: string; pid: number; pidStartedAt: number; acquiredAt: number; heartbeatAt: number; expiresAt: number }
  | { ok: false; jobId: string; reason: OwnerOpReason };

export interface LeaseOwnerRef {
  jobId: string;
  pid: number;
  pidStartedAt: number;
}

const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 3_600_000;
const DEFAULT_TTL_MS = 60_000;
const LOCK_RETRY_STEP_MS = 10;
const DEFAULT_LOCK_MAX_WAIT_MS = 500;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

export class AdmissionManager {
  private readonly leasesDir: string;
  private readonly staleDir: string;
  private readonly releasedDir: string;
  private readonly lockPath: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly pidIdentity: PidIdentityInspector;
  private readonly lockMaxWaitMs: number;

  constructor(options: AdmissionManagerOptions) {
    const base = path.resolve(options.runtimeRoot, 'admission');
    this.leasesDir = path.join(base, 'leases');
    this.staleDir = path.join(base, 'stale');
    this.releasedDir = path.join(base, 'released');
    this.lockPath = path.join(base, 'lease.lock');
    for (const dir of [this.leasesDir, this.staleDir, this.releasedDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    let ttl = DEFAULT_TTL_MS;
    if (typeof options.ttlMs === 'number' && Number.isFinite(options.ttlMs)) ttl = options.ttlMs;
    this.ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, ttl));
    this.now = options.now ?? (() => Date.now());
    this.pidIdentity = options.pidIdentity ?? UNKNOWN_INSPECTOR;
    this.lockMaxWaitMs = options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS;
  }

  // -- Lock --

  /** O_EXCL global lock with bounded retry; stale locks reaped only when the holder PID is verifiably dead. */
  private acquireLock(): boolean {
    const deadline = this.now() + this.lockMaxWaitMs;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        try {
          fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: this.now() }));
        } finally {
          fs.closeSync(fd);
        }
        return true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') {
          if (this.reapDeadLock()) continue;
          if (this.now() >= deadline) return false;
          Atomics.wait(LOCK_WAIT, 0, 0, LOCK_RETRY_STEP_MS);
          continue;
        }
        return false;
      }
    }
  }

  private reapDeadLock(): boolean {
    let holderPid: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as { pid?: unknown };
      holderPid = typeof parsed?.pid === 'number' ? parsed.pid : null;
    } catch {
      holderPid = null;
    }
    // Unreadable/unverifiable lock content is treated as busy (fail closed); only a
    // verifiably-dead holder lets us unlink the leftover file and retry.
    if (holderPid === null) return false;
    if (this.pidIdentity.isAlive(holderPid) === false) {
      try {
        fs.unlinkSync(this.lockPath);
      } catch {
        /* raced */
      }
      return true;
    }
    return false;
  }

  private releaseLock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      /* best effort */
    }
  }

  // -- Lease files --

  /** Strict structural validation of a raw lease file; null = corrupt/unsafe. */
  private parseLease(raw: string): AdmissionLease | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const l = parsed as Record<string, unknown>;
    if (l.schemaVersion !== ADMISSION_LEASE_SCHEMA_VERSION) return null;
    if (typeof l.jobId !== 'string' || !JOB_ID_RE.test(l.jobId)) return null;
    if (!RESOURCE_CLASSES.includes(l.resourceClass as AdmissionResourceClass)) return null;
    if (typeof l.backend !== 'string' || l.backend.length === 0) return null;
    if (typeof l.profile !== 'string' || l.profile.length === 0) return null;
    if (typeof l.workFolder !== 'string' || l.workFolder.length === 0) return null;
    if (typeof l.pid !== 'number' || !Number.isInteger(l.pid) || l.pid <= 0) return null;
    if (typeof l.pidStartedAt !== 'number' || !Number.isInteger(l.pidStartedAt) || l.pidStartedAt <= 0) return null;
    for (const k of ['acquiredAt', 'heartbeatAt', 'expiresAt'] as const) {
      const v = l[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return null;
    }
    return l as unknown as AdmissionLease;
  }

  private toPublicLease(lease: AdmissionLease): PublicLease {
    const { workFolder: _workFolder, pidStartedAt: _pidStartedAt, ...pub } = lease;
    return pub;
  }

  /** Move leases/<jobId>.json into targetDir (timestamped name on collision). Never deletes. */
  private moveLeaseOut(jobId: string, targetDir: string): void {
    const src = path.join(this.leasesDir, `${jobId}.json`);
    let dest = path.join(targetDir, `${jobId}.json`);
    if (fs.existsSync(dest)) dest = path.join(targetDir, `${jobId}.${this.now()}.json`);
    fs.renameSync(src, dest);
  }

  /** Live vs stale: identity verdict when verifiable; otherwise the TTL decides. */
  private classifyLease(lease: AdmissionLease, now: number): 'live' | 'stale' {
    const alive = this.pidIdentity.isAlive(lease.pid);
    const identity = this.pidIdentity.startedAtMatches(lease.pid, lease.pidStartedAt);
    if (alive === false || identity === false) return 'stale'; // dead or PID reused
    if (alive === true && identity === true) return 'live'; // verifiably ours — keep even past TTL
    return now > lease.expiresAt ? 'stale' : 'live'; // unverifiable → TTL governs
  }

  /** Strictly validate every lease file; archive dead/corrupt ones to stale/ and return the live set. */
  private sweepLeases(): { live: AdmissionLease[]; staleArchived: string[] } {
    const live: AdmissionLease[] = [];
    const staleArchived: string[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.leasesDir, { withFileTypes: true });
    } catch {
      return { live, staleArchived };
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jobId = entry.name.slice(0, -'.json'.length);
      let lease: AdmissionLease | null = null;
      try {
        lease = this.parseLease(fs.readFileSync(path.join(this.leasesDir, entry.name), 'utf8'));
      } catch {
        lease = null;
      }
      if (lease === null) {
        // Corrupt/unparseable lease: fail closed — archive it, never count it as live.
        try {
          this.moveLeaseOut(jobId, this.staleDir);
          staleArchived.push(jobId);
        } catch {
          /* never counted live either way */
        }
        continue;
      }
      if (lease.jobId !== jobId || this.classifyLease(lease, this.now()) === 'stale') {
        try {
          this.moveLeaseOut(jobId, this.staleDir);
          staleArchived.push(jobId);
        } catch {
          /* never counted live either way */
        }
        continue;
      }
      live.push(lease);
    }
    return { live, staleArchived };
  }

  // -- Public API --

  /**
   * Under the global lock: strictly validate every lease file, archive
   * stale/dead/corrupt ones, evaluate admission, and on admit write the job
   * lease with O_EXCL ('wx').
   *
   * @param freeMemoryMb Optional live memory report; defaults to Infinity (no pressure).
   */
  acquireAdmissionLease(policy: AdmissionPolicy, request: AdmissionRequest, freeMemoryMb?: number): AcquireAdmissionResult {
    const notOk = (reason: AcquireDenyReason): AcquireAdmissionResult => ({
      ok: false,
      reason,
      lease: null,
      staleArchived: [],
      evaluation: null,
    });
    if (typeof request?.jobId !== 'string' || !JOB_ID_RE.test(request.jobId)) return notOk('invalid_job_id');
    if (invalidPolicyField(policy) !== null) return notOk('invalid_policy');
    if (invalidRequestField(request) !== null) return notOk('invalid_request');

    if (!this.acquireLock()) return notOk('lock_busy');
    try {
      const { live, staleArchived } = this.sweepLeases();
      const leaseInfo: LiveLeaseInfo[] = live.map((l) => ({
        jobId: l.jobId,
        resourceClass: l.resourceClass,
        workFolder: l.workFolder,
        active: true,
      }));
      const evaluation = evaluateAdmission(policy, request, leaseInfo, {
        freeMemoryMb: freeMemoryMb ?? Number.POSITIVE_INFINITY,
      });
      if (!evaluation.admitted) {
        return { ok: false, reason: 'denied', lease: null, staleArchived, evaluation };
      }
      const now = this.now();
      const lease: AdmissionLease = {
        schemaVersion: ADMISSION_LEASE_SCHEMA_VERSION,
        jobId: request.jobId,
        resourceClass: request.resourceClass,
        backend: request.backend,
        profile: request.profile,
        workFolder: request.workFolder,
        pid: request.pid,
        pidStartedAt: request.pidStartedAt,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      const leasePath = path.join(this.leasesDir, `${request.jobId}.json`);
      try {
        fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2), { flag: 'wx' }); // O_EXCL per contract
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EEXIST' || code === 'EPERM' || code === 'EBUSY') {
          return { ok: false, reason: 'duplicate_job', lease: null, staleArchived, evaluation };
        }
        throw err;
      }
      return { ok: true, reason: null, lease: this.toPublicLease(lease), staleArchived, evaluation };
    } finally {
      this.releaseLock();
    }
  }

  /** Extend a lease's TTL, but only when jobId and owner pid + pidStartedAt match the stored lease. */
  heartbeatLease(owner: LeaseOwnerRef): HeartbeatResult {
    const jobId = owner?.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, jobId: String(jobId ?? ''), reason: 'invalid_job_id' };
    if (!this.acquireLock()) return { ok: false, jobId, reason: 'lock_busy' };
    try {
      const leasePath = path.join(this.leasesDir, `${jobId}.json`);
      let lease: AdmissionLease | null = null;
      try {
        lease = this.parseLease(fs.readFileSync(leasePath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, jobId, reason: 'lease_not_found' };
        throw err;
      }
      if (lease === null) return { ok: false, jobId, reason: 'bad_lease_file' };
      if (lease.pid !== owner.pid || lease.pidStartedAt !== owner.pidStartedAt) {
        return { ok: false, jobId, reason: 'owner_mismatch' };
      }
      const now = this.now();
      const updated: AdmissionLease = { ...lease, heartbeatAt: now, expiresAt: now + this.ttlMs };
      // tmp + rename so a concurrent reader never observes a partial file.
      const tmp = `${leasePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
      fs.renameSync(tmp, leasePath);
      return { ok: true, jobId, heartbeatAt: now, expiresAt: now + this.ttlMs };
    } finally {
      this.releaseLock();
    }
  }

  /** Move a lease to admission/released (audit trail — never deleted), owner-checked. */
  releaseLease(owner: LeaseOwnerRef): ReleaseResult {
    const jobId = owner?.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, jobId: String(jobId ?? ''), reason: 'invalid_job_id' };
    if (!this.acquireLock()) return { ok: false, jobId, reason: 'lock_busy' };
    try {
      const leasePath = path.join(this.leasesDir, `${jobId}.json`);
      let lease: AdmissionLease | null = null;
      try {
        lease = this.parseLease(fs.readFileSync(leasePath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, jobId, reason: 'lease_not_found' };
        throw err;
      }
      if (lease === null) return { ok: false, jobId, reason: 'bad_lease_file' };
      if (lease.pid !== owner.pid || lease.pidStartedAt !== owner.pidStartedAt) {
        return { ok: false, jobId, reason: 'owner_mismatch' };
      }
      this.moveLeaseOut(jobId, this.releasedDir);
      return { ok: true, jobId };
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Wave4B1 ownership handoff: under the same global O_EXCL lock, strictly
   * parse the existing lease, verify `currentOwner` matches its pid identity
   * AND its jobId equals `nextOwner.jobId`, then atomically (tmp + rename)
   * replace pid/pidStartedAt with the next owner's. acquiredAt is preserved;
   * heartbeatAt/expiresAt are refreshed. A failed transfer never deletes or
   * releases the lease and reports one fixed OwnerOpReason — no paths, env or
   * prompt ever surface.
   */
  transferLeaseOwner(currentOwner: LeaseOwnerRef, nextOwner: LeaseOwnerRef): TransferLeaseResult {
    const jobId = currentOwner?.jobId;
    if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) return { ok: false, jobId: String(jobId ?? ''), reason: 'invalid_job_id' };
    if (typeof nextOwner !== 'object' || nextOwner === null) return { ok: false, jobId, reason: 'invalid_next_owner' };
    if (typeof nextOwner.jobId !== 'string' || nextOwner.jobId !== jobId) return { ok: false, jobId, reason: 'invalid_next_owner' };
    if (!Number.isInteger(nextOwner.pid) || nextOwner.pid <= 0 || !Number.isInteger(nextOwner.pidStartedAt) || nextOwner.pidStartedAt <= 0) {
      return { ok: false, jobId, reason: 'invalid_next_owner' };
    }
    if (!this.acquireLock()) return { ok: false, jobId, reason: 'lock_busy' };
    try {
      const leasePath = path.join(this.leasesDir, `${jobId}.json`);
      let lease: AdmissionLease | null = null;
      try {
        lease = this.parseLease(fs.readFileSync(leasePath, 'utf8'));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, jobId, reason: 'lease_not_found' };
        throw err;
      }
      if (lease === null) return { ok: false, jobId, reason: 'bad_lease_file' };
      if (lease.pid !== currentOwner.pid || lease.pidStartedAt !== currentOwner.pidStartedAt) {
        return { ok: false, jobId, reason: 'owner_mismatch' };
      }
      const now = this.now();
      const updated: AdmissionLease = {
        ...lease,
        pid: nextOwner.pid,
        pidStartedAt: nextOwner.pidStartedAt,
        heartbeatAt: now,
        expiresAt: now + this.ttlMs,
      };
      // tmp + rename so a concurrent reader never observes a partial file.
      const tmp = `${leasePath}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(updated, null, 2));
      fs.renameSync(tmp, leasePath);
      return { ok: true, jobId, pid: nextOwner.pid, pidStartedAt: nextOwner.pidStartedAt, acquiredAt: updated.acquiredAt, heartbeatAt: now, expiresAt: now + this.ttlMs };
    } finally {
      this.releaseLock();
    }
  }

  /** Read-only snapshot: strictly validated, sanitized live leases only. */
  listLiveLeases(): PublicLease[] {
    const out: PublicLease[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.leasesDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const jobId = entry.name.slice(0, -'.json'.length);
      let lease: AdmissionLease | null = null;
      try {
        lease = this.parseLease(fs.readFileSync(path.join(this.leasesDir, entry.name), 'utf8'));
      } catch {
        lease = null;
      }
      if (lease === null || lease.jobId !== jobId) continue;
      out.push(this.toPublicLease(lease));
    }
    out.sort((a, b) => a.acquiredAt - b.acquiredAt);
    return out;
  }
}
