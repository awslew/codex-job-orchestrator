// src/admission-controller.ts
// Wave 4B2a: admission controller — a testable unit that runs admission
// decisions for a batch of candidates and hands successful ones to a launch
// callback. NOT wired into scheduler/index/supervisor; this file owns no
// timers, no JobStore writes, no MCP schema, and no heartbeat/release
// lifecycle — those belong to later wiring tasks.
//
// Contract (frozen by the task leader):
// - Fixed candidate ordering: priority desc, then queuedAt asc, then jobId
//   lexicographic.
// - Each candidate's explicit desiredWorkerConcurrency (non-null) wins over
//   the policy default.
// - Admission runs under the AdmissionManager's global O_EXCL lock — two
//   controllers sharing a runtimeRoot race the last slot safely; nothing is
//   counted from memory before writing the lease.
// - Rejection: fixed queue reason + public active/queued/resourceLimit from
//   the evaluation (never fabricated).
// - launch failure -> current owner releases the lease, decision state
//   'failed' with fixed failureCode 'supervisor_spawn_failed'. transfer
//   failure -> terminate callback invoked, best-effort release by the
//   current owner, decision state 'failed' with fixed failureCode
//   'lease_transfer_failed'. Neither may leave a slot occupied.
// - Success -> 'active' with admittedAt and public counts/limit; owner PID
//   identity, env, prompt and paths never surface.

import { AdmissionManager, type AdmissionPolicy, type AdmissionResourceClass, type AdmissionEvaluation } from './admission.js';
import {
  admissionControlEnabled,
  desiredWorkerConcurrencyDefault,
  admissionHardCeilingDefault,
  admissionMaxHeavyWorkersDefault,
  admissionMemoryReserveMbDefault,
} from './config.js';

/** Fixed failure codes surfaced on decisions; no free-form reasons. */
export type AdmissionFailureCode = 'supervisor_spawn_failed' | 'lease_transfer_failed';

export type AdmissionDecisionState = 'active' | 'queued' | 'failed';

/** A single candidate to pump; fields mirror the job record, not the lease. */
export interface AdmissionCandidate {
  jobId: string;
  /** Explicit per-job desired concurrency; null/undefined means use the policy default. */
  desiredWorkerConcurrency: number | null;
  resourceClass: AdmissionResourceClass;
  /** 0..3, higher = admitted first. */
  priority: number;
  backend: string;
  profile: string;
  workFolder: string;
  /** ISO timestamp; earlier candidates are admitted first. */
  queuedAt: string;
}

/** Supervisor identity produced by the launch callback. */
export interface LaunchedSupervisor {
  pid: number;
  /** Epoch-ms process start time; lease owner-identity verification uses it. */
  pidStartedAt: number;
}

export interface AdmissionControllerOptions {
  /** Root for the admission area (shared with AdmissionManager). */
  runtimeRoot: string;
  /**
   * Policy numbers. When omitted the env defaults from config.ts apply
   * (ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY etc., each with a documented
   * fallback). An explicit per-candidate desiredWorkerConcurrency overrides
   * the policy's desired only — hard ceiling, heavy cap and memory reserve
   * still apply.
   */
  policy?: AdmissionPolicy;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
  /** Live free-memory report in MB (number or callback). Omit => no pressure. */
  freeMemoryMb?: number | (() => number);
  /** Owner identity of this controller while it holds newly-acquired leases. */
  ownerPid?: number;
  ownerPidStartedAt?: number;
  /** Spawns the supervisor for an admitted candidate (Node spawn yields the pid synchronously). */
  launch: (candidate: AdmissionCandidate) => LaunchedSupervisor;
  /** Best-effort kill after a failed lease transfer (failure path only). */
  terminate: (candidate: AdmissionCandidate, supervisor: LaunchedSupervisor) => void;
}

/** Decision counts and reason — public values only, never paths or identities. */
export interface AdmissionDecision {
  jobId: string;
  state: AdmissionDecisionState;
  /** Present exactly when state === 'active' && the lease landed on the supervisor. */
  admittedAt: string | null;
  active: number;
  queued: number;
  desired: number;
  resourceLimit: number;
  /** Fixed queue reason (queued), fixed failureCode (failed handoff), or null (active). */
  reason: string | null;
}

/** Strict comparator for the fixed ordering: priority desc, queuedAt asc, jobId asc. */
export function compareCandidates(a: AdmissionCandidate, b: AdmissionCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const ta = Date.parse(a.queuedAt);
  const tb = Date.parse(b.queuedAt);
  if (ta !== tb) return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  return a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0;
}

const DEFAULT_OWNER_PID = 1_000_000;
const DEFAULT_OWNER_STARTED_AT = 1;

export class AdmissionController {
  private readonly manager: AdmissionManager;
  private readonly policy: AdmissionPolicy;
  private readonly now: () => number;
  private readonly freeMemoryMb: (() => number) | null;
  private readonly ownerPid: number;
  private readonly ownerPidStartedAt: number;
  private readonly launch: AdmissionControllerOptions['launch'];
  private readonly terminate: AdmissionControllerOptions['terminate'];

  constructor(options: AdmissionControllerOptions) {
    this.manager = new AdmissionManager({ runtimeRoot: options.runtimeRoot, now: options.now });
    this.policy = options.policy ?? defaultPolicyFromEnv();
    this.now = options.now ?? (() => Date.now());
    this.freeMemoryMb =
      typeof options.freeMemoryMb === 'function' ? options.freeMemoryMb
      : options.freeMemoryMb === undefined ? null
      : () => options.freeMemoryMb as number;
    this.ownerPid = options.ownerPid ?? DEFAULT_OWNER_PID;
    this.ownerPidStartedAt = options.ownerPidStartedAt ?? DEFAULT_OWNER_STARTED_AT;
    this.launch = options.launch;
    this.terminate = options.terminate;
  }

  /**
   * Run one admission pass over the candidates in the fixed order. Each
   * candidate is decided exactly once; launch/transfer failures never leave a
   * slot occupied, and successful decisions are active only after the lease
   * has been transferred to the launched supervisor.
   */
  pump(candidates: readonly AdmissionCandidate[]): AdmissionDecision[] {
    const sorted = [...candidates].sort(compareCandidates);
    const out: AdmissionDecision[] = [];
    for (const c of sorted) {
      out.push(this.decide(c));
    }
    return out;
  }

  private decide(c: AdmissionCandidate): AdmissionDecision {
    const policy: AdmissionPolicy = {
      ...this.policy,
      // Explicit per-job desired wins over the policy default; everything
      // else (hard ceiling, heavy cap, memory reserve) still applies.
      desiredWorkerConcurrency: c.desiredWorkerConcurrency ?? this.policy.desiredWorkerConcurrency,
    };
    const acquired = this.manager.acquireAdmissionLease(
      policy,
      {
        jobId: c.jobId,
        resourceClass: c.resourceClass,
        backend: c.backend,
        profile: c.profile,
        workFolder: c.workFolder,
        pid: this.ownerPid,
        pidStartedAt: this.ownerPidStartedAt,
      },
      // pid/pidStartedAt stay inside the manager (lease identity only); the
      // decision's public fields never surface them.
      this.freeMemoryMb ? this.freeMemoryMb() : undefined,
    );
    if (!acquired.ok) {
      const reason: string =
        acquired.evaluation?.reason ?? (acquired.reason === 'denied' ? 'desired_limit' : (acquired.reason ?? 'lock_busy'));
      return this.decision(c, 'queued', null, reason, acquired.evaluation);
    }
    return this.handoff(c, acquired.evaluation as AdmissionEvaluation);
  }

  /** Acquire succeeded: launch the supervisor, then transfer lease ownership. */
  private handoff(c: AdmissionCandidate, evaluation: AdmissionEvaluation): AdmissionDecision {
    let supervisor: LaunchedSupervisor;
    try {
      supervisor = this.launch(c);
    } catch {
      this.releaseByCurrentOwner(c.jobId);
      return this.decision(c, 'failed', null, 'supervisor_spawn_failed', evaluation);
    }
    if (
      typeof supervisor !== 'object' || supervisor === null ||
      !Number.isInteger(supervisor.pid) || supervisor.pid <= 0 ||
      !Number.isInteger(supervisor.pidStartedAt) || supervisor.pidStartedAt <= 0
    ) {
      // A bogus supervisor identity is a spawn failure — release, don't fake success.
      this.releaseByCurrentOwner(c.jobId);
      return this.decision(c, 'failed', null, 'supervisor_spawn_failed', evaluation);
    }
    const transfer = this.manager.transferLeaseOwner(
      { jobId: c.jobId, pid: this.ownerPid, pidStartedAt: this.ownerPidStartedAt },
      { jobId: c.jobId, pid: supervisor.pid, pidStartedAt: supervisor.pidStartedAt },
    );
    if (!transfer.ok) {
      // The supervisor must not keep running unowned, and the slot must not
      // stay occupied by the controller's (short-lived) identity.
      try {
        this.terminate(c, supervisor);
      } catch {
        /* best effort — releasing the lease is the required part */
      }
      this.releaseByCurrentOwner(c.jobId);
      return this.decision(c, 'failed', null, 'lease_transfer_failed', evaluation);
    }
    return this.decision(c, 'active', new Date(this.now()).toISOString(), null, evaluation);
  }

  /** Release by the owner identity the lease was acquired under; best-effort. */
  private releaseByCurrentOwner(jobId: string): void {
    try {
      this.manager.releaseLease({ jobId, pid: this.ownerPid, pidStartedAt: this.ownerPidStartedAt });
    } catch {
      /* best effort — a failed release never resurrects a slot */
    }
  }

  /** Public decision: counts/limit come from the evaluation, never fabricated. */
  private decision(
    c: AdmissionCandidate,
    state: AdmissionDecisionState,
    admittedAt: string | null,
    reason: string | null,
    evaluation: AdmissionEvaluation | null,
  ): AdmissionDecision {
    return {
      jobId: c.jobId,
      state,
      admittedAt,
      active: evaluation?.active ?? 0,
      queued: evaluation?.queued ?? 0,
      desired: evaluation?.desired ?? 0,
      resourceLimit: evaluation?.resourceLimit ?? 0,
      reason,
    };
  }
}

/** Default policy from env via the config.ts parsers (invalid values fall back to documented defaults). */
export function defaultPolicyFromEnv(): AdmissionPolicy {
  return {
    desiredWorkerConcurrency: desiredWorkerConcurrencyDefault(),
    hardSafetyCeiling: admissionHardCeilingDefault(),
    maxHeavyWorkers: admissionMaxHeavyWorkersDefault(),
    memoryReserveMb: admissionMemoryReserveMbDefault(),
  };
}

/** Wave 4B2a feature gate: only 1/true/on/yes (case-insensitive) enable admission control. */
export function admissionControlFlag(): boolean {
  return admissionControlEnabled();
}
