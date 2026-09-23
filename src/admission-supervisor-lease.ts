// src/admission-supervisor-lease.ts
// Wave4B2b1: supervisor-side admission lease lifecycle component.
//
// One job's supervisor owns ONE lease file under admission/leases/<jobId>.json
// (created by the leader via AdmissionManager, Wave4A). This component:
//   - waitForOwnership: polls the owner-checked heartbeatLease until the
//     leader's transfer lands (owner_mismatch / lease_not_found / lock_busy
//     are transient during a transfer window), failing fast only on
//     bad_lease_file / invalid_job_id, timing out as ownership_timeout.
//   - startHeartbeat: only after ownership is proven; one timer, heartbeats
//     only its own lease, never releases anyone's lease on failure.
//   - stopAndRelease: clears the timer and hands the lease back to the
//     leader via an owner-checked releaseLease (AdmissionManager archives it
//     under admission/released/ — nothing here deletes files).
//
// Everything is injectable (runtimeRoot, jobId, owner pid identity, manager
// or manager factory, now, sleep) so tests need no real waits. Public results
// are strictly {ok, state, fixed reason, jobId, heartbeatAt, expiresAt} —
// runtimeRoot, PID identity, paths, env and prompt never leave this file.

import {
  AdmissionManager,
  type HeartbeatResult,
  type LeaseOwnerRef,
  type OwnerOpReason,
  type ReleaseResult,
} from './admission.js';

export type AdmissionLeaseLifecycleState = 'uninitialized' | 'acquiring' | 'owned' | 'stopped' | 'failed';

export type AdmissionLeaseFixedFailure =
  | OwnerOpReason
  | 'ownership_timeout'
  | 'heartbeat_error'
  | 'release_error'
  | 'released'
  | 'already_stopped';

export interface AdmissionLeaseLifecycleResult {
  ok: boolean;
  state: AdmissionLeaseLifecycleState;
  /** Fixed reason; non-null exactly when state is 'failed' or 'stopped'. */
  reason: AdmissionLeaseFixedFailure | null;
  jobId: string;
  /** Present when ownership was proven and a heartbeat ran. */
  heartbeatAt: number | null;
  /** Present when ownership was proven and a heartbeat ran. */
  expiresAt: number | null;
}

export interface AdmissionLeaseLifecycleOptions {
  /** Root for the admission area; admission/{leases,stale,released}/ live here. */
  runtimeRoot: string;
  jobId: string;
  /** Owner pid identity that must match the lease exactly (PID reuse safe). */
  owner: Pick<LeaseOwnerRef, 'pid' | 'pidStartedAt'>;
  /**
   * AdmissionManager, or a factory returning one. A factory is preferred:
   * it is invoked lazily on first use, so callers may defer creating the
   * admission area. Mutually exclusive with `manager`.
   */
  manager?: AdmissionManager;
  managerFactory?: () => AdmissionManager;
  /** Injectable clock for heartbeat timestamps. Defaults to Date.now. */
  now?: () => number;
  /** Injectable sleep for waitForOwnership polling. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_POLL_MS = 50;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;

/** Transient while the leader may still be transferring the lease to us. */
const OWNERSHIP_RETRYABLE_REASONS: ReadonlySet<OwnerOpReason> = new Set<OwnerOpReason>([
  'owner_mismatch',
  'lease_not_found',
  'lock_busy',
]);

/** Fail closed immediately — the lease is corrupt or we are misconfigured. */
const OWNERSHIP_FIXED_REASONS: ReadonlySet<OwnerOpReason> = new Set<OwnerOpReason>([
  'bad_lease_file',
  'invalid_job_id',
]);

export class AdmissionSupervisorLease {
  private readonly runtimeRoot: string;
  private readonly jobId: string;
  private readonly owner: LeaseOwnerRef;
  private readonly managerFactory: () => AdmissionManager;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private manager: AdmissionManager | null;
  private timer: NodeJS.Timeout | null;
  private lastHeartbeatError: string | null;
  private failedReason: AdmissionLeaseFixedFailure | null;
  private state: AdmissionLeaseLifecycleState;

  constructor(options: AdmissionLeaseLifecycleOptions) {
    this.runtimeRoot = options.runtimeRoot;
    this.jobId = options.jobId;
    this.owner = { jobId: options.jobId, pid: options.owner.pid, pidStartedAt: options.owner.pidStartedAt };
    if (options.manager !== undefined && options.managerFactory !== undefined) {
      throw new Error('AdmissionSupervisorLease: manager and managerFactory are mutually exclusive');
    }
    this.manager = options.manager ?? null;
    this.managerFactory = options.managerFactory ?? (() => new AdmissionManager({ runtimeRoot: this.runtimeRoot }));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.timer = null;
    this.lastHeartbeatError = null;
    this.failedReason = null;
    this.state = 'uninitialized';
  }

  get stateValue(): AdmissionLeaseLifecycleState {
    return this.state;
  }

  /** Public, sanitized last heartbeat error — fixed reason strings only, never a stack or path. */
  get lastError(): string | null {
    return this.lastHeartbeatError;
  }

  private heartbeatOwner(): LeaseOwnerRef {
    return this.owner;
  }

  private result(
    state: AdmissionLeaseLifecycleState,
    ok: boolean,
    reason: AdmissionLeaseFixedFailure | null,
    heartbeatAt: number | null,
    expiresAt: number | null,
  ): AdmissionLeaseLifecycleResult {
    return { ok, state, reason, jobId: this.jobId, heartbeatAt, expiresAt };
  }

  private markFailed(reason: AdmissionLeaseFixedFailure): AdmissionLeaseLifecycleResult {
    this.clearTimer();
    this.failedReason = reason;
    this.state = 'failed';
    return this.result('failed', false, reason, null, null);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getManager(): AdmissionManager {
    if (this.manager === null) this.manager = this.managerFactory();
    return this.manager;
  }

  /**
   * Bounded heartbeat of our own lease. Every failure collapses to a fixed
   * reason: underlying OwnerOpReason, or heartbeat_error for an I/O
   * exception. A failing heartbeat never touches anyone's lease.
   */
  private heartbeatOnce(): { ok: true; heartbeatAt: number; expiresAt: number } | { ok: false; reason: AdmissionLeaseFixedFailure } {
    let res: HeartbeatResult;
    try {
      res = this.getManager().heartbeatLease(this.heartbeatOwner());
    } catch {
      this.lastHeartbeatError = 'heartbeat_error';
      return { ok: false, reason: 'heartbeat_error' };
    }
    if (res.ok) return { ok: true, heartbeatAt: res.heartbeatAt, expiresAt: res.expiresAt };
    this.lastHeartbeatError = res.reason;
    return { ok: false, reason: res.reason };
  }

  /**
   * Poll heartbeatLease until our owner identity matches the stored lease.
   * Retryable window: owner_mismatch / lease_not_found / lock_busy — the
   * leader may still be transferring the lease to us. Fixed failure:
   * bad_lease_file / invalid_job_id fail immediately; timeouts report
   * ownership_timeout. No result is ever silently treated as success.
   */
  async waitForOwnership(timeoutMs = DEFAULT_WAIT_TIMEOUT_MS, pollMs = DEFAULT_WAIT_POLL_MS): Promise<AdmissionLeaseLifecycleResult> {
    if (this.state === 'owned') return this.result('owned', true, null, null, null);
    if (this.state === 'stopped') return this.result('stopped', false, 'already_stopped', null, null);
    if (this.state === 'failed') return this.result('failed', false, this.failedReason ?? 'bad_lease_file', null, null);

    this.state = 'acquiring';
    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (this.now() >= deadline) return this.markFailed('ownership_timeout');

      let res: HeartbeatResult;
      try {
        res = this.getManager().heartbeatLease(this.heartbeatOwner());
      } catch {
        // Manager-level I/O error: retry within the window; the timeout governs.
        this.lastHeartbeatError = 'heartbeat_error';
        if (this.now() >= deadline) return this.markFailed('ownership_timeout');
        await this.sleep(pollMs);
        continue;
      }

      if (res.ok) {
        this.state = 'owned';
        return this.result('owned', true, null, res.heartbeatAt, res.expiresAt);
      }
      if (OWNERSHIP_FIXED_REASONS.has(res.reason)) return this.markFailed(res.reason);
      if (!OWNERSHIP_RETRYABLE_REASONS.has(res.reason)) return this.markFailed(res.reason);
      this.lastHeartbeatError = res.reason;
      if (this.now() >= deadline) return this.markFailed('ownership_timeout');
      await this.sleep(pollMs);
    }
  }

  /**
   * Heartbeat our own lease on a fixed interval. Only valid once
   * waitForOwnership succeeded; duplicate starts are no-ops so exactly one
   * timer can ever exist. A failing heartbeat never releases anyone's lease
   * — the fixed reason is recorded in lastError for the caller.
   */
  startHeartbeat(intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS): boolean {
    if (this.state !== 'owned' || this.timer !== null) return false;
    this.timer = setInterval(() => {
      if (this.state !== 'owned') return;
      const res = this.heartbeatOnce();
      if (!res.ok) this.lastHeartbeatError = res.reason;
    }, intervalMs);
    return true;
  }

  /**
   * Stop heartbeating and hand the lease back to the leader via the
   * owner-checked releaseLease (AdmissionManager archives it — never
   * deleted, never touched when ownership no longer matches). Idempotent:
   * the second call returns already_stopped and touches nothing.
   */
  async stopAndRelease(): Promise<AdmissionLeaseLifecycleResult> {
    if (this.state === 'stopped') return this.result('stopped', false, 'already_stopped', null, null);
    this.clearTimer();
    if (this.state === 'failed') {
      // Ownership was never proven — there is nothing of ours to release.
      this.state = 'stopped';
      return this.result('stopped', false, 'already_stopped', null, null);
    }

    let res: ReleaseResult;
    try {
      res = this.getManager().releaseLease(this.heartbeatOwner());
    } catch {
      this.state = 'stopped';
      return this.result('stopped', false, 'release_error', null, null);
    }
    this.state = 'stopped';
    if (res.ok) return this.result('stopped', false, 'released', null, null);
    // Owner no longer matches (e.g. leader re-transferred) or lease corrupt:
    // report the fixed reason, leave the lease exactly where it is.
    return this.result('stopped', false, res.reason, null, null);
  }
}
