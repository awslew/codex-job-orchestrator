// Process helpers shared by the scheduler (MCP server side) and the
// supervisor (detached job runner).
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type StdioOptions } from 'node:child_process';
import { queryProcessStartTime } from './registry.js';

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Windows console-window policy for background/helper children. A background
// child spawned on Windows must not pop a visible console window (the observed
// blank node.exe flash); on other platforms `windowsHide` is a no-op, so it is
// left undefined and behavior is byte-identical to before.
export function windowsHideOnWindows(platform: NodeJS.Platform = process.platform): boolean | undefined {
  return platform === 'win32' ? true : undefined;
}

// Add windowsHide only where it has an effect (win32); elsewhere the options
// object is returned untouched so non-Windows behavior never changes.
function withWindowsHide(options: object, platform: NodeJS.Platform): SpawnOptions {
  const hide = windowsHideOnWindows(platform);
  return hide === undefined ? { ...options } : { ...options, windowsHide: hide };
}

// Env-gated spawn recorder (tests only, never set in production). When
// ORCHESTRATOR_PROC_SPY_FILE is set, every resolved spawn is appended as one
// JSON line so tests can prove the ACTUAL call sites (including inside the
// detached supervisor process) apply the correct Windows visibility policy. A
// spy must never break a spawn, so all failures are swallowed.
function recordSpawn(
  kind: 'background' | 'viewer' | 'helper',
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): void {
  const file = process.env.ORCHESTRATOR_PROC_SPY_FILE;
  if (!file) return;
  try {
    fs.appendFileSync(
      file,
      `${JSON.stringify({ kind, command, args, windowsHide: options.windowsHide, platform: process.platform, pid: process.pid })}\n`,
      'utf8',
    );
  } catch {
    /* best effort */
  }
}

export interface BackgroundSpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: StdioOptions;
  shell?: boolean;
}

// Compute the child_process options for a background spawn. Exported as a pure
// function so tests can assert the windowsHide decision on any platform.
export function backgroundSpawnOptions(
  options: BackgroundSpawnOptions = {},
  platform: NodeJS.Platform = process.platform,
): SpawnOptions {
  return withWindowsHide(options, platform);
}

// Spawn a background subprocess (supervisor, worker, helper). On Windows the
// child is created with its console window hidden; other platforms are
// unchanged. All other spawn options are passed through verbatim.
export function spawnBackground(
  command: string,
  args: readonly string[],
  options: BackgroundSpawnOptions = {},
): ChildProcess {
  const resolved = backgroundSpawnOptions(options);
  recordSpawn('background', command, args, resolved);
  return spawn(command, args, resolved);
}

export interface ViewerLauncherOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
  stdio?: StdioOptions;
}

// Compute the child_process options for the live-viewer launcher. The launcher
// is a short-lived cmd.exe `start` host that is itself hidden; the viewer it
// starts runs in its own NEW console window and must stay visible, so it never
// inherits this hide policy.
export function viewerLauncherOptions(
  options: ViewerLauncherOptions = {},
  platform: NodeJS.Platform = process.platform,
): SpawnOptions {
  return withWindowsHide(options, platform);
}

// Spawn the SHORT-LIVED launcher that opens the live viewer. Hides only the
// launcher process on Windows; the final viewer (`cmd /c start ... node
// viewer.js`) is created by `start` in a fresh console and remains visible.
export function spawnViewerLauncher(
  command: string,
  args: readonly string[],
  options: ViewerLauncherOptions = {},
): ChildProcess {
  const resolved = viewerLauncherOptions(options);
  recordSpawn('viewer', command, args, resolved);
  return spawn(command, args, resolved);
}

// Kill a process and its whole child tree. On Windows uses taskkill /T /F.
export function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      // Bounded taskkill: an occasional taskkill hang must never block the
      // MCP server's single-threaded event loop forever (same style as
      // win32ParentPid's timeout: 3000 below).
      const opts = { windowsHide: windowsHideOnWindows(), timeout: 5000 };
      recordSpawn('helper', 'taskkill', ['/pid', String(pid), '/T', '/F'], opts);
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], opts);
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// PID launch-identity helpers (core consistency).
//
// A recorded pid alone lies under PID reuse: the OS may recycle the number for
// a different process. Every pid we persist is therefore paired with the
// OS-reported creation time captured right after spawn (pidStartedAt /
// supervisorPidStartedAt). Killing / attaching / resuming requires the CURRENT
// process behind the pid to have the SAME creation time (bounded tolerance), so
// a reused pid is never mistaken for our worker. These helpers never inspect or
// store command lines, env, or any payload.
// ---------------------------------------------------------------------------

export type PidIdentityStatus =
  | 'no_identity'       // pid and/or startedAt absent (legacy job)
  | 'verified_live'     // process exists and creation time matches
  | 'verified_dead'     // no process with this pid
  | 'identity_mismatch' // a DIFFERENT process now owns the pid (reuse)
  | 'unverifiable';     // process exists but creation time unreadable

export interface PidIdentityQuery {
  exists?: (pid: number) => boolean;
  startTime?: (pid: number) => number | null;
}

/** OS-reported creation time of a pid (epoch ms), or null when unreadable. */
export function queryPidStartedAt(pid: number): number | null {
  return queryProcessStartTime(pid);
}

const pidSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * Capture the creation time of a freshly spawned child as an ISO string. A
 * brand-new process may not be queryable for a few ms, so this retries a
 * bounded number of times; null means the identity could not be captured
 * (callers then persist a null identity and behave conservatively).
 */
export function capturePidStartedAt(
  pid: number,
  opts: { attempts?: number; intervalMs?: number; startTime?: (pid: number) => number | null } = {},
): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const attempts = opts.attempts ?? 3;
  const intervalMs = opts.intervalMs ?? 50;
  const startTime = opts.startTime ?? queryPidStartedAt;
  for (let i = 0; i < attempts; i++) {
    const t = startTime(pid);
    if (t !== null) return new Date(t).toISOString();
    if (i < attempts - 1 && intervalMs > 0) Atomics.wait(pidSleepBuffer, 0, 0, intervalMs);
  }
  return null;
}

/**
 * Classify a recorded pid + startedAt against the live OS. Only
 * 'verified_live' may be treated as our (still-running) child. 'no_identity'
 * and 'unverifiable' are conservative unknowns; 'identity_mismatch' is PID
 * reuse and is never our worker; 'verified_dead' is simply gone.
 */
export function pidIdentityStatus(
  pid: number | null | undefined,
  startedAt: string | null | undefined,
  query: PidIdentityQuery = {},
  toleranceMs = 5000,
): PidIdentityStatus {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return 'no_identity';
  if (!startedAt || typeof startedAt !== 'string') return 'no_identity';
  const exists = query.exists ?? isAlive;
  const startTime = query.startTime ?? queryPidStartedAt;
  let alive: boolean;
  try {
    alive = exists(pid);
  } catch {
    alive = false;
  }
  if (!alive) return 'verified_dead';
  const recorded = Date.parse(startedAt);
  if (Number.isNaN(recorded)) return 'unverifiable';
  let osStart: number | null;
  try {
    osStart = startTime(pid);
  } catch {
    osStart = null;
  }
  if (osStart === null) return 'unverifiable';
  return Math.abs(osStart - recorded) <= toleranceMs ? 'verified_live' : 'identity_mismatch';
}

/** True only when we can PROVE the recorded child no longer owns the pid: the
 *  process is gone (verified_dead) or the pid was reused by a different
 *  process (identity_mismatch). Unknowns are never treated as "not our child",
 *  so recovery stays conservative on legacy jobs. */
export function pidIsNotOurChild(
  pid: number | null | undefined,
  startedAt: string | null | undefined,
  query: PidIdentityQuery = {},
  toleranceMs = 5000,
): boolean {
  const s = pidIdentityStatus(pid, startedAt, query, toleranceMs);
  return s === 'verified_dead' || s === 'identity_mismatch';
}

/**
 * killTree, but ONLY when the pid is identity-verified as our live child.
 * Returns null when the tree was killed (or the pid is already provably dead,
 * so nothing to kill); returns a concise conservative diagnostic otherwise
 * ('no_identity' | 'identity_mismatch' | 'unverifiable' | 'self') so callers
 * record why they refused to kill.
 */
export function killTreeVerified(
  pid: number | null | undefined,
  startedAt: string | null | undefined,
  opts: { query?: PidIdentityQuery; toleranceMs?: number } = {},
): string | null {
  if (!pid || pid <= 0) return null;
  if (pid === process.pid) return 'self'; // never kill our own process
  const status = pidIdentityStatus(pid, startedAt, opts.query, opts.toleranceMs);
  if (status === 'verified_live') {
    killTree(pid);
    return null;
  }
  return status === 'verified_dead' ? null : status;
}

// ---------------------------------------------------------------------------
// Ancestor-chain helpers (aligned with the Stage-7 smoke guard).
//
// These are the "is this pid one of OUR ancestors?" guard used to prove a
// candidate pid is a descendant (or a fresh unrelated process), never a reused
// ancestor pid. They never inspect or store command lines, env, or payloads.
// ---------------------------------------------------------------------------

/** OS-reported parent pid of `pid`, or null when unreadable/invalid. */
export function queryParentPid(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') return win32ParentPid(pid);
    if (process.platform === 'linux') return linuxParentPid(pid);
    return posixParentPid(pid);
  } catch {
    return null;
  }
}

function win32ParentPid(pid: number): number | null {
  try {
    const r = spawnSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'],
      { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    const m = /ParentProcessId=(\d+)/.exec(r.stdout ?? '');
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

// Parse field 4 (ppid) from a /proc/<pid>/stat line. The comm field may contain
// spaces/parens, so we anchor on the last ')'; fields after it are 1-indexed
// starting at 3 (state), so ppid is index 1.
function linuxParentPid(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    if (close < 0) return null;
    const rest = stat.slice(close + 1).trim().split(/\s+/);
    const v = Number(rest[1]);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function posixParentPid(pid: number): number | null {
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    const v = Number((r.stdout ?? '').trim());
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Walk the ancestor chain upward from process.ppid into a bounded, acyclic Set.
 * Stops at the max depth, at an invalid/root parent, or on a cycle (a pid that
 * is its own ancestor). The injectable query lets tests synthesize a chain.
 */
export function buildAncestorPidSet(
  opts: { queryParentPidFn?: (pid: number) => number | null; maxDepth?: number } = {},
): Set<number> {
  const queryParent = opts.queryParentPidFn ?? queryParentPid;
  const maxDepth = opts.maxDepth ?? 32;
  const set = new Set<number>();
  let current: number | null = process.ppid;
  for (let i = 0; i < maxDepth && current !== null; i++) {
    if (!Number.isInteger(current) || current <= 0) break;
    if (set.has(current)) break; // cycle -> stop
    set.add(current);
    current = queryParent(current);
  }
  return set;
}

export interface PidCandidateOptions {
  ownPid?: number;
  ancestorPids?: Set<number>;
  runStartedAtMs?: number;
  osStartTimeFn?: (pid: number) => number | null;
}

/**
 * Fail-closed identity gate for a candidate pid recorded in a job: reject
 * non-positive, self, any ancestor, an unreadable/absent run threshold, an
 * unreadable OS start time, or a start time BEFORE the run threshold (a pid
 * reused from before this run is never ours). Returns exactly { ok: true } for
 * a safe candidate.
 */
export function evaluatePidCandidate(
  pid: number,
  opts: PidCandidateOptions = {},
): { ok: boolean; reason?: string } {
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid_pid' };
  if (opts.ownPid !== undefined && pid === opts.ownPid) return { ok: false, reason: 'self' };
  if (opts.ancestorPids && opts.ancestorPids.has(pid)) return { ok: false, reason: 'ancestor' };
  if (opts.runStartedAtMs === undefined || Number.isNaN(opts.runStartedAtMs)) {
    return { ok: false, reason: 'no_run_threshold' };
  }
  if (typeof opts.osStartTimeFn !== 'function') return { ok: false, reason: 'unverifiable' };
  let start: number | null;
  try {
    start = opts.osStartTimeFn(pid);
  } catch {
    start = null;
  }
  if (start === null || Number.isNaN(start)) return { ok: false, reason: 'unverifiable' };
  if (start < opts.runStartedAtMs) return { ok: false, reason: 'pre_run_start' };
  return { ok: true };
}
