// Stage 6: per-job bootstrap checkpoints and single-recoverer claims.
//
// SCOPE DISCIPLINE: these primitives only track the scheduler-owned bootstrap /
// recovery stages (job persisted -> supervisor acknowledged -> worker spawned).
// They never claim to recover arbitrary Claude tool steps or replay approved
// actions; Claude content resumption remains the job of session/reply. Field
// whitelist: claim files contain only jobId + owner identity + lease timestamps
// — never prompts, tokens, raw logs, env, or the full command line.
//
// CLAIMS: a per-job claim is a small JSON file created with O_EXCL ('wx') under
// runtime/claims/<jobId>.<kind>.json, so concurrent recoverers (multiple MCP
// instances) can never both own the same job — no in-process mutex and no
// cross-process read-modify-write. Owner identity is (pid + process start time)
// verified through the same machinery the Stage 5 registry uses, so a stale
// lease is only ever stolen after the owner is proven gone (dead or PID
// reused), never on kill(pid,0) alone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { claimsDir } from './config.js';
import { queryProcessStartTime, type ProcessInspector } from './registry.js';

// ---------------------------------------------------------------------------
// Bootstrap checkpoint (embedded in the Job record as an optional field).
// ---------------------------------------------------------------------------

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

/** A fresh checkpoint at the given stage. */
export function newBootstrap(stage: BootstrapStage, at: string): JobBootstrap {
  return { stage, bootstrapId: crypto.randomUUID(), updatedAt: at };
}

export function isBootstrapStage(v: unknown): v is BootstrapStage {
  return typeof v === 'string' && (BOOTSTRAP_STAGES as readonly string[]).includes(v);
}

export function isValidBootstrap(b: unknown): b is JobBootstrap {
  if (!b || typeof b !== 'object') return false;
  const o = b as Record<string, unknown>;
  return isBootstrapStage(o.stage) && typeof o.bootstrapId === 'string' && typeof o.updatedAt === 'string';
}

// ---------------------------------------------------------------------------
// Claims.
// ---------------------------------------------------------------------------

export const CLAIM_SCHEMA_VERSION = 1;
export type ClaimKind = 'recover' | 'supervisor';

export interface RecoveryClaim {
  schemaVersion: 1;
  kind: ClaimKind;
  jobId: string;
  /** Who owns the claim (crypto.randomUUID per acquisition). */
  ownerId: string;
  ownerPid: number;
  /** Process identity at claim time: ISO of Date.now() - process.uptime(). */
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface AcquireClaimOptions {
  jobId: string;
  kind: ClaimKind;
  /** Fresh per-acquisition owner id. */
  ownerId: string;
  /** Injectable "now" (epoch ms) for clock-skew tests. */
  now: () => number;
  /** Lease length in ms; the claim becomes stealable (when owner unverifiable)
   *  after this. */
  leaseMs: number;
  /** Identity source; tests inject a fake, production uses the registry one. */
  inspector: ProcessInspector;
  /** Max |OS startTime - ownerStartedAt| that still counts as the same process. */
  identityToleranceMs?: number;
  /** A claim file that exists but is empty/partial/corrupt is treated as an
   *  in-progress create until its mtime is older than this (ms). Default 5000. */
  mtimeGraceMs?: number;
}

export type AcquireResult =
  | { status: 'acquired' }
  | { status: 'held'; existing: RecoveryClaim | null }
  | { status: 'stolen'; existing: RecoveryClaim | null };

export function claimFilePath(jobId: string, kind: ClaimKind): string {
  return path.join(claimsDir(), `${jobId}.${kind}.json`);
}

export function isValidClaim(raw: unknown): raw is RecoveryClaim {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return (
    o.schemaVersion === CLAIM_SCHEMA_VERSION &&
    (o.kind === 'recover' || o.kind === 'supervisor') &&
    typeof o.jobId === 'string' &&
    o.jobId.length > 0 &&
    typeof o.ownerId === 'string' &&
    typeof o.ownerPid === 'number' &&
    Number.isInteger(o.ownerPid) &&
    o.ownerPid > 0 &&
    typeof o.ownerStartedAt === 'string' &&
    typeof o.acquiredAt === 'string' &&
    typeof o.expiresAt === 'string'
  );
}

export function readClaim(jobId: string, kind: ClaimKind): RecoveryClaim | null {
  const f = claimFilePath(jobId, kind);
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    return isValidClaim(raw) ? raw : null;
  } catch {
    return null;
  }
}

export type ClaimFileState =
  | { kind: 'absent' }
  | { kind: 'valid'; claim: RecoveryClaim }
  | { kind: 'corrupt' };

/**
 * Distinguish a genuinely absent claim file from one that exists but is
 * empty/partial/corrupt. readClaim() collapses both to null; the acquire path
 * MUST NOT treat a mid-write file as absent (it would be stolen while the
 * winner is still writing, producing two holders).
 */
export function inspectClaimFile(jobId: string, kind: ClaimKind): ClaimFileState {
  const f = claimFilePath(jobId, kind);
  let exists = false;
  try {
    exists = fs.existsSync(f);
  } catch {
    return { kind: 'absent' };
  }
  if (!exists) return { kind: 'absent' };
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as unknown;
    if (isValidClaim(raw)) return { kind: 'valid', claim: raw };
    return { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

/** Age in ms of the claim file's mtime relative to `now` (Infinity when the
 *  file vanished or is unstatable, i.e. nothing to protect). */
export function claimFileMtimeAgeMs(jobId: string, kind: ClaimKind, now: number): number {
  try {
    return now - fs.statSync(claimFilePath(jobId, kind)).mtimeMs;
  } catch {
    return Infinity;
  }
}

// Atomic-write tmp markers: an in-flight atomicWriteJson leaves
// `<claimPath>.<pid>.<seq>.<uuid>.tmp` beside the target until the rename
// lands. A FRESH marker means the writer may still be mid create->write, so
// the claim must NOT be stolen; an AGED marker is crash residue and is cleaned
// up. This is an ADDITIONAL guard on top of the target's own mtime grace: a
// corrupt/empty/partial TARGET is itself gated by its mtime (never stolen
// while fresh), so a fresh target with no side marker is safe too.
function findClaimTmpMarkers(jobId: string, kind: ClaimKind): string[] {
  const prefix = `${jobId}.${kind}.`;
  try {
    return fs
      .readdirSync(claimsDir())
      .filter((f) => f.startsWith(prefix) && f.endsWith('.tmp'))
      .map((f) => path.join(claimsDir(), f));
  } catch {
    return [];
  }
}

function claimTmpAgeMs(markerPath: string, now: number): number {
  try {
    return now - fs.statSync(markerPath).mtimeMs;
  } catch {
    return Infinity; // vanished -> not a fresh in-progress marker
  }
}

/**
 * Identity-verified liveness of a claim owner. The only case treated as LIVE is
 * a process whose OS-reported start time matches the claim's ownerStartedAt
 * within tolerance (or our own pid). A dead pid, a start-time mismatch (PID
 * reuse), or an unverifiable start time is never "live".
 */
export function claimOwnerLive(
  claim: RecoveryClaim,
  inspector: ProcessInspector,
  toleranceMs = 5000,
): boolean {
  if (claim.ownerPid === process.pid) return true; // we are the owner; we are alive
  let exists: boolean;
  try {
    exists = inspector.exists(claim.ownerPid);
  } catch {
    exists = false;
  }
  if (!exists) return false;
  const recorded = Date.parse(claim.ownerStartedAt);
  if (Number.isNaN(recorded)) return false;
  let osStart: number | null = null;
  try {
    osStart = inspector.startTime(claim.ownerPid);
  } catch {
    osStart = null;
  }
  if (osStart === null) return false; // unverifiable -> never claims live
  return Math.abs(osStart - recorded) <= toleranceMs;
}

/**
 * Whether the claim owner is PROVABLY gone (dead pid, or the pid was reused by
 * a different process). The single case we may rely on to displace an existing
 * claim WITHOUT risking a live owner: an owner we cannot verify is treated as
 * possibly-live (never proven dead), so it never permits a double spawn.
 */
export function claimOwnerVerifiedDead(
  claim: RecoveryClaim | null,
  inspector: ProcessInspector,
  toleranceMs = 5000,
): boolean {
  if (!claim || !isValidClaim(claim)) return true; // corrupt -> cannot be a live owner
  if (claim.ownerPid === process.pid) return false; // our own claim is live
  let exists: boolean;
  try {
    exists = inspector.exists(claim.ownerPid);
  } catch {
    exists = false;
  }
  if (!exists) return true; // no process with this pid -> provably gone
  const recorded = Date.parse(claim.ownerStartedAt);
  let osStart: number | null = null;
  try {
    osStart = inspector.startTime(claim.ownerPid);
  } catch {
    osStart = null;
  }
  if (osStart === null) return false; // process exists but unverifiable -> possibly alive
  if (Number.isNaN(recorded) || Math.abs(osStart - recorded) > toleranceMs) {
    return true; // PID reused by a different process -> the original owner is gone
  }
  return false; // identity-verified live
}

/**
 * Whether a RECOVER claim may be safely stolen. NEVER steal a claim whose owner
 * might be alive; steal only when the owner is proven gone, falling back to the
 * lease expiry as a bounded backstop for the unverifiable case (a crashed
 * recoverer whose start time we cannot read must not block recovery forever).
 */
export function claimIsStale(
  claim: RecoveryClaim | null,
  inspector: ProcessInspector,
  now: number,
  toleranceMs = 5000,
): boolean {
  if (!claim || !isValidClaim(claim)) return true; // corrupt/missing -> stale
  if (claimOwnerVerifiedDead(claim, inspector, toleranceMs)) return true;
  // A claim whose owner is identity-verified ALIVE is never stale: displacing it
  // would let two recoverers own the same job. Lease expiry is only a bounded
  // backstop for the UNVERIFIABLE case (the owner's process exists but its start
  // time cannot be read), so a crashed recoverer never blocks recovery forever.
  if (claimOwnerLive(claim, inspector, toleranceMs)) return false;
  const exp = Date.parse(claim.expiresAt);
  return Number.isNaN(exp) || now > exp;
}

/**
 * Whether an existing claim of the given kind blocks a fresh acquisition. For
 * SUPERVISOR claims this is stricter than RECOVER claims: a supervisor lives for
 * the whole job, so an expired-but-alive owner must never be displaced (that
 * would permit two supervisors). A supervisor claim is only stealable when its
 * owner is provably dead. A RECOVER claim is stealable on verified-death OR
 * (unverifiable AND expired).
 */
export function claimBlocksAcquisition(
  claim: RecoveryClaim | null,
  kind: ClaimKind,
  inspector: ProcessInspector,
  now: number,
  toleranceMs = 5000,
): boolean {
  if (!claim || !isValidClaim(claim)) return false; // corrupt -> not blocking
  if (claimOwnerVerifiedDead(claim, inspector, toleranceMs)) return false; // stealable
  if (kind === 'supervisor') return true; // possibly-alive supervisor blocks
  return !claimIsStale(claim, inspector, now, toleranceMs); // recover: expiry backstop
}

// Bounded retry for the O_EXCL create and the steal rename. Windows can
// transiently report EPERM/EBUSY (antivirus scanning a fresh file, a directory
// momentarily locked); both clear on their own within milliseconds.
const CLAIM_TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY']);
const CLAIM_MAX_ATTEMPTS = 6;
const CLAIM_RETRY_BASE_MS = 20;
const CLAIM_BACKOFF_CAP_MS = 50;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function defaultSleep(ms: number): void {
  if (ms > 0) Atomics.wait(sleepBuffer, 0, 0, ms);
}
function monotonicMs(): number {
  return performance.now();
}

export interface ClaimTestHooks {
  /** Called before each O_EXCL open attempt; throwing simulates the error. */
  beforeOpen?: (attempt: number, p: string) => void;
  /** Called before each steal rename; throwing simulates the rename error. */
  beforeRename?: (attempt: number, from: string, to: string) => void;
  sleep?: (ms: number) => void;
}
export const claimTestHooks: ClaimTestHooks = {};

/**
 * Try to acquire a per-job claim with real O_EXCL semantics. Returns:
 *   acquired  - this call owns the claim (file created exclusively).
 *   held     - a live/valid claim exists; caller must back off.
 *   stolen   - a stale claim was removed and this call now owns it.
 * A failed transient open/rename is retried a bounded number of times.
 */
export function acquireClaim(opts: AcquireClaimOptions): AcquireResult {
  const p = claimFilePath(opts.jobId, opts.kind);
  const nowMs = opts.now();
  const claim: RecoveryClaim = {
    schemaVersion: CLAIM_SCHEMA_VERSION,
    kind: opts.kind,
    jobId: opts.jobId,
    ownerId: opts.ownerId,
    ownerPid: process.pid,
    ownerStartedAt: new Date(nowMs - process.uptime() * 1000).toISOString(),
    acquiredAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + opts.leaseMs).toISOString(),
  };
  const tolerance = opts.identityToleranceMs ?? 5000;
  const mtimeGraceMs = opts.mtimeGraceMs ?? 5000;
  const started = monotonicMs();
  let attempt = 0;
  let steals = 0;
  for (;;) {
    attempt += 1;
    // An in-progress atomic write leaves a fresh <claimPath>.*.tmp marker. The
    // claim must NOT be stolen while a writer may still be between the O_EXCL
    // create and the JSON write (that is the empty/partial create-write race:
    // readClaim() collapses the half-written target to null, which would
    // otherwise be treated as absent and stolen mid-write). Block while the
    // marker is fresh; an aged marker is crash residue and is cleaned up.
    const markers = findClaimTmpMarkers(opts.jobId, opts.kind);
    if (markers.length > 0) {
      const fresh = markers.some((m) => claimTmpAgeMs(m, opts.now()) < mtimeGraceMs);
      if (fresh) {
        if (attempt >= CLAIM_MAX_ATTEMPTS) return { status: 'held', existing: null };
        (claimTestHooks.sleep ?? defaultSleep)(
          Math.min(CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1), CLAIM_BACKOFF_CAP_MS),
        );
        continue;
      }
      for (const m of markers) {
        try {
          fs.unlinkSync(m); // abandon the stale marker
        } catch {
          /* best effort */
        }
      }
    }
    try {
      claimTestHooks.beforeOpen?.(attempt, p);
      const fd = fs.openSync(p, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(claim, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { status: 'acquired' };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EEXIST') {
        const state = inspectClaimFile(opts.jobId, opts.kind);
        if (state.kind === 'absent') {
          continue; // it vanished (someone else stole it); retry the O_EXCL create
        }
        if (state.kind === 'valid') {
          const existing = state.claim;
          if (!claimBlocksAcquisition(existing, opts.kind, opts.inspector, opts.now(), tolerance)) {
            // Steal: rename the stale claim to a unique tombstone so exactly one
            // concurrent stealer wins (a lost rename race surfaces as ENOENT).
            if (steals >= 2) return { status: 'held', existing };
            steals += 1;
            const tomb = `${p}.${crypto.randomUUID()}.stale`;
            try {
              claimTestHooks.beforeRename?.(steals, p, tomb);
              fs.renameSync(p, tomb);
              try {
                fs.unlinkSync(tomb); // best-effort tombstone cleanup
              } catch {
                /* leftover tombstone in claims/ is inert */
              }
              continue; // retry the O_EXCL create
            } catch (renameErr) {
              const rcode = (renameErr as NodeJS.ErrnoException).code ?? '';
              if (rcode === 'ENOENT') continue; // someone else stole it first
              if (CLAIM_TRANSIENT_CODES.has(rcode)) {
                if (attempt >= CLAIM_MAX_ATTEMPTS) return { status: 'held', existing };
                (claimTestHooks.sleep ?? defaultSleep)(
                  Math.min(CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1), CLAIM_BACKOFF_CAP_MS),
                );
                continue;
              }
              return { status: 'held', existing };
            }
          }
          return { status: 'held', existing };
        }
        // Empty/partial/corrupt target claim (exists but cannot parse or
        // validate): classify it as unverifiable/corrupt, NOT dead. The writer
        // may still be between the O_EXCL create and the JSON write — a fresh
        // corrupt target with no .tmp side marker is exactly the case the
        // frozen contract protects. Block while the target's OWN mtime is
        // fresh and NEVER rename/steal it; only once the target mtime is older
        // than the grace is it a crashed writer's residue, and then exactly one
        // contender recovers via the unique tombstone rename.
        const targetAge = claimFileMtimeAgeMs(opts.jobId, opts.kind, opts.now());
        if (targetAge < mtimeGraceMs) {
          if (attempt >= CLAIM_MAX_ATTEMPTS) return { status: 'held', existing: null };
          (claimTestHooks.sleep ?? defaultSleep)(
            Math.min(CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1), CLAIM_BACKOFF_CAP_MS),
          );
          continue;
        }
        if (steals >= 2) return { status: 'held', existing: null };
        steals += 1;
        const tomb = `${p}.${crypto.randomUUID()}.stale`;
        try {
          claimTestHooks.beforeRename?.(steals, p, tomb);
          fs.renameSync(p, tomb);
          try {
            fs.unlinkSync(tomb); // best-effort tombstone cleanup
          } catch {
            /* leftover tombstone in claims/ is inert */
          }
          continue; // retry the O_EXCL create
        } catch (renameErr) {
          const rcode = (renameErr as NodeJS.ErrnoException).code ?? '';
          if (rcode === 'ENOENT') continue; // someone else recovered it first
          if (CLAIM_TRANSIENT_CODES.has(rcode)) {
            if (attempt >= CLAIM_MAX_ATTEMPTS) return { status: 'held', existing: null };
            (claimTestHooks.sleep ?? defaultSleep)(
              Math.min(CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1), CLAIM_BACKOFF_CAP_MS),
            );
            continue;
          }
          return { status: 'held', existing: null };
        }
      }
      if (CLAIM_TRANSIENT_CODES.has(code) && attempt < CLAIM_MAX_ATTEMPTS && monotonicMs() - started < 300) {
        (claimTestHooks.sleep ?? defaultSleep)(Math.min(CLAIM_RETRY_BASE_MS * 2 ** (attempt - 1), CLAIM_BACKOFF_CAP_MS));
        continue;
      }
      throw err;
    }
  }
}

/** Remove a claim ONLY if this caller still owns it (ownerId matches). */
export function releaseClaim(jobId: string, kind: ClaimKind, ownerId: string): boolean {
  const p = claimFilePath(jobId, kind);
  try {
    const cur = readClaim(jobId, kind);
    if (cur && cur.ownerId !== ownerId) return false; // a different owner took over
    fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

// Re-export the production inspector as the default for recovery callers.
export function productionInspector(): ProcessInspector {
  return { exists: (pid) => isAliveForInspector(pid), startTime: (pid) => queryProcessStartTime(pid) };
}

function isAliveForInspector(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
