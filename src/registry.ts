// Instance registry / heartbeat for the orchestrator MCP server (Stage 5).
//
// Purpose: let `claude_code_health` detect duplicate live MCP instances and
// stale crash residue in the SAME runtime scope (same runtime root), without
// ever trusting `kill(pid, 0)` alone (PID reuse). Design rules from the spec:
//
//   - One JSON record file per instance under runtime/registry/instances/
//     <instanceId>.json. Each MCP process writes ONLY its own file using the
//     existing Windows-hardened atomic write (unique tmp + EPERM/EBUSY bounded
//     retry), so concurrent processes never share a mutable single JSON and
//     cannot overwrite each other.
//   - Records never save env, prompt, token, raw logs, the full command line,
//     or keys. Paths are basenames only.
//   - Heartbeat is a bounded, unref'd interval; normal shutdown best-effort
//     unregisters; crash residue is detected via stale/identity checks, never
//     by assuming cleanup happened.
//   - This module NEVER kills, restarts, or cleans up any instance. It is a
//     read-only diagnostic source (write-only for the caller's own heartbeat).
//
// Process identity: on every supported platform we compare the OS-reported
// process creation time against the record's `processStartedAt` (recorded at
// registration as `Date.now() - process.uptime()*1000`). Any failure degrades
// conservatively to unknown/stale, never to "healthy".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { instancesDir, registryHeartbeatMs, registryStaleAfterMs } from './config.js';
import { atomicWriteJson } from './job-store.js';
import { isAlive } from './proc.js';

export interface InstanceRecord {
  schemaVersion: 1;
  /** Non-colliding per-process id (crypto.randomUUID). */
  instanceId: string;
  pid: number;
  /** Host identity for duplicate grouping (see hostPidOf). Absent/null for legacy records. */
  hostPid?: number | null;
  /** Verifiable process start identity, ISO (Date.now() - process.uptime()). */
  processStartedAt: string;
  /** MCP server start, ISO. */
  serverStartedAt: string;
  /** Entry basename only (never a full path). */
  entry: string;
  /** Deterministic production module-set fingerprint (see health.ts). */
  buildFingerprint: string;
  lastHeartbeatAt: string;
  version: string;
}

export type RegistryStaleReason =
  | 'corrupt'
  | 'invalid'
  | 'invalid_timestamp'
  | 'heartbeat_timeout'
  | 'pid_not_found'
  | 'identity_unverified'
  | 'identity_mismatch';

export interface RegistrySnapshot {
  enabled: boolean;
  instanceId: string | null;
  recorded: boolean;
  lastHeartbeatAt: string | null;
  heartbeatMs: number;
  staleAfterMs: number;
  instanceCount: number;
  liveCount: number;
  staleCount: number;
  staleReasons: Partial<Record<RegistryStaleReason, number>>;
  /** True only when >=2 identity-verified live instances exist in this scope
   * across >=2 distinct hosts (per-host grouping: same-host multi-window
   * setups are not duplicates). */
  duplicateInstanceSuspected: boolean;
  /** True when any record is stale (heartbeat / dead / reused / corrupt). */
  registryStale: boolean;
  /** Registry-level failure (dir unreadable), else null. */
  error: string | null;
}

// ---------------------------------------------------------------------------
// Process identity (injectable for tests; conservative on any failure).
// ---------------------------------------------------------------------------

export interface ProcessInspector {
  /** Whether the process exists (kill(pid,0), EPERM => alive). */
  exists(pid: number): boolean;
  /** OS-reported epoch-ms process creation time, or null if unreadable. */
  startTime(pid: number): number | null;
}

/**
 * Parse a wmic DMTF CreationDate line ("CreationDate=YYYYMMDDHHMMSS[.ffffff]
 * [+ZZZ]") into epoch ms. The date fields are LOCAL wall-clock time plus a
 * SIGNED UTC offset in minutes — either "+480" (minutes) or "+0800" (HHMM).
 * UTC = local - offset, so a negative offset ("-300", UTC-5) must be ADDED
 * back, not subtracted. Any malformed input, including a missing offset (which
 * makes local -> UTC conversion unreliable), returns null so process identity
 * degrades conservatively to unknown/stale, never to healthy. Exported as a
 * pure function so the timezone math is unit-testable without spawning wmic.
 */
export function parseWmicCreationDate(raw: string): number | null {
  const m = /CreationDate=(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{1,3})?\d*([+-]\d+)?/.exec(
    raw,
  );
  if (!m) return null;
  const base = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(m[7] ?? 0),
  );
  const off = m[8];
  if (!off) return null; // no offset -> cannot reliably convert local to UTC
  const sign = off[0] === '-' ? -1 : 1;
  const num = off.slice(1);
  const minutes =
    num.length <= 3
      ? Number(num)
      : Number(num.slice(0, num.length - 2)) * 60 + Number(num.slice(-2));
  if (!Number.isFinite(minutes)) return null;
  return base - sign * minutes * 60_000;
}

function win32WmicCreationDate(pid: number): number | null {
  try {
    const r = spawnSync(
      'wmic',
      ['process', 'where', `ProcessId=${pid}`, 'get', 'CreationDate', '/value'],
      { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    // Never surface the raw line; only the parsed epoch ms.
    return parseWmicCreationDate(r.stdout ?? '');
  } catch {
    return null;
  }
}

function win32PowerShellStartTime(pid: number): number | null {
  try {
    const r = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { windowsHide: true, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (r.status !== 0) return null;
    const t = Date.parse((r.stdout ?? '').trim());
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

// Win11 24H2 removed wmic; PowerShell is the primary probe and wmic is only a
// legacy fallback (kept for old Windows where powershell cold-start is slower).
function win32ProcessStartTime(pid: number): number | null {
  return win32PowerShellStartTime(pid) ?? win32WmicCreationDate(pid);
}

// Parse field 22 (starttime in clock ticks since boot) from a /proc/<pid>/stat
// line. The comm field may contain spaces/parens, so we anchor on the last ')';
// fields after it are 1-indexed starting at 3 (state).
function linuxStarttimeTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const rest = stat.slice(close + 1).trim().split(/\s+/);
  const v = Number(rest[19]); // field 22 => index 22 - 3 = 19
  return Number.isFinite(v) ? v : null;
}

let cachedClkTck: number | null = null;
function clkTck(): number {
  if (cachedClkTck !== null) return cachedClkTck;
  try {
    const r = spawnSync('getconf', ['CLK_TCK'], {
      windowsHide: true,
      timeout: 2000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status === 0) {
      const v = Number((r.stdout ?? '').trim());
      if (Number.isFinite(v) && v > 0) {
        cachedClkTck = v;
        return v;
      }
    }
  } catch {
    /* fall through to the conservative default */
  }
  cachedClkTck = 100;
  return cachedClkTck;
}

function linuxProcessStartTime(pid: number): number | null {
  try {
    const pidTicks = linuxStarttimeTicks(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
    const selfTicks = linuxStarttimeTicks(fs.readFileSync('/proc/self/stat', 'utf8'));
    if (pidTicks === null || selfTicks === null) return null;
    const selfEpochMs = Date.now() - process.uptime() * 1000;
    return selfEpochMs + (pidTicks - selfTicks) * (1000 / clkTck());
  } catch {
    return null;
  }
}

// macOS / BSD: `ps -o etimes=` reports elapsed seconds, locale-independent.
function posixProcessStartTime(pid: number): number | null {
  try {
    const r = spawnSync('ps', ['-o', 'etimes=', '-p', String(pid)], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    const sec = Number((r.stdout ?? '').trim());
    if (!Number.isFinite(sec) || sec < 0) return null;
    return Date.now() - sec * 1000;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// queryProcessStartTime memoization. A process creation time is immutable, so
// a successful lookup is cached for the pid's lifetime (validated by a cheap
// isAlive on every hit: once the pid is gone the entry is dropped, so a reused
// pid can never be served a stale identity). Failed lookups (process absent or
// unreadable) are cached with a short TTL so repeated queries in one pass do
// not re-pay the synchronous PowerShell/wmic spawn; the map is bounded and
// evicts oldest-first to prevent unbounded growth.
// ---------------------------------------------------------------------------

interface StartTimeCacheEntry {
  value: number | null;
  /** true = authoritative success (creation time); false = failure (TTL only). */
  resolved: boolean;
  atMs: number;
}

const startTimeCache = new Map<number, StartTimeCacheEntry>();
const START_TIME_CACHE_MAX_ENTRIES = 500;
const START_TIME_FAILURE_TTL_MS = 30_000;

/** Test/debug seam: empty the memo cache (production code never calls it). */
export function clearProcessStartTimeCache(): void {
  startTimeCache.clear();
}

function cachePutStartTime(pid: number, value: number | null): void {
  // Only cache failures when the process is provably gone: an alive-but-
  // unreadable process may become readable a few ms later (fresh spawn), so a
  // transient failure must stay cacheable-by-retry.
  if (value === null && isAlive(pid)) return;
  if (startTimeCache.size >= START_TIME_CACHE_MAX_ENTRIES && !startTimeCache.has(pid)) {
    const oldest = startTimeCache.keys().next().value;
    if (oldest !== undefined) startTimeCache.delete(oldest);
  }
  startTimeCache.set(pid, { value, resolved: value !== null, atMs: Date.now() });
}

/** OS-reported process creation time (epoch ms), or null when unreadable. */
export function queryProcessStartTime(pid: number): number | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const cached = startTimeCache.get(pid);
  if (cached) {
    if (cached.resolved) {
      // Creation time is immutable while the SAME process lives; a dead pid
      // invalidates the entry (and guards against serving a stale identity to
      // a later reuse of the same pid number).
      if (!isAlive(pid)) {
        startTimeCache.delete(pid);
      } else {
        return cached.value;
      }
    } else if (Date.now() - cached.atMs < START_TIME_FAILURE_TTL_MS) {
      return null;
    } else {
      startTimeCache.delete(pid);
    }
  }
  let value: number | null = null;
  try {
    if (process.platform === 'win32') value = win32ProcessStartTime(pid);
    else if (process.platform === 'linux') value = linuxProcessStartTime(pid);
    else value = posixProcessStartTime(pid);
  } catch {
    value = null;
  }
  cachePutStartTime(pid, value);
  return value;
}

// Default process inspector used by retention planning (and the registry's
// own health snapshot). NOTE: the real startTime probe on Windows spawns a
// PowerShell/wmic subprocess per pid; retention previews on many-record
// runtimes can therefore be slow, and it is never exercised in unit tests.
// Exporting the real default keeps preview behavior identical to the
// registry's own stale-instance classification.
export const defaultInspector: ProcessInspector = {
  exists: (pid) => isAlive(pid),
  startTime: (pid) => queryProcessStartTime(pid),
};

// ---------------------------------------------------------------------------
// Registration / heartbeat.
// ---------------------------------------------------------------------------

export interface RegisterInstanceOptions {
  /** Entry basename (never a full path). */
  entry: string;
  /** Loaded build fingerprint (deterministic production module-set hash). */
  buildFingerprint: string;
  version: string;
  serverStartedAt?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  heartbeatMs?: number;
  staleAfterMs?: number;
}

export interface RegistryHandle {
  instanceId: string;
  /** Write one heartbeat now (used by the interval and by tests). */
  beat(): void;
  stopHeartbeat(): void;
  /** Best-effort unregister (remove own record). Idempotent. */
  unregister(): void;
}

export function instanceFilePath(instanceId: string): string {
  return path.join(instancesDir(), `${instanceId}.json`);
}

function isValidRecord(r: Partial<InstanceRecord>): r is InstanceRecord {
  return (
    r.schemaVersion === 1 &&
    typeof r.instanceId === 'string' &&
    r.instanceId.length > 0 &&
    typeof r.pid === 'number' &&
    Number.isInteger(r.pid) &&
    r.pid > 0 &&
    typeof r.processStartedAt === 'string' &&
    r.processStartedAt.length > 0 &&
    typeof r.serverStartedAt === 'string' &&
    r.serverStartedAt.length > 0 &&
    typeof r.entry === 'string' &&
    r.entry.length > 0 &&
    typeof r.buildFingerprint === 'string' &&
    typeof r.lastHeartbeatAt === 'string' &&
    r.lastHeartbeatAt.length > 0 &&
    typeof r.version === 'string'
  );
}

// Host identity for duplicate grouping. Codex Desktop spawns one orchestrator
// MCP instance PER SESSION WINDOW; the launcher (dist/orchestrator-launcher.cjs)
// injects ORCHESTRATOR_HOST_PID = the session key (parent codex PID, or the
// launcher's own PID for shell/manual spawns), and instances of one host are a
// normal multi-window setup, NOT duplicates. A missing value (legacy record or
// a direct index.js spawn without the launcher) yields null; duplicate
// detection then falls back to per-PID grouping so the old guard (>=2 live
// instances) still catches cross-host sharing of one runtime.
function hostPidOf(): number | null {
  const raw = process.env.ORCHESTRATOR_HOST_PID;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Register THIS process in the instance registry and start its heartbeat.
 * The initial record write is synchronous and throws on failure so the caller
 * can surface "registry unavailable" instead of a health view that claims the
 * registry is healthy. The heartbeat interval is unref'd and never holds the
 * process open. All failures are conservative: the record's own stale heartbeat
 * becomes visible to health rather than lying.
 */
export function registerInstance(opts: RegisterInstanceOptions): RegistryHandle {
  const instanceId = crypto.randomUUID();
  const now = opts.now ?? Date.now;
  const heartbeatMs = opts.heartbeatMs ?? registryHeartbeatMs();
  const staleAfterMs = opts.staleAfterMs ?? registryStaleAfterMs();
  const serverStartedAtMs = opts.serverStartedAt ?? now();
  const file = instanceFilePath(instanceId);
  const record: InstanceRecord = {
    schemaVersion: 1,
    instanceId,
    pid: process.pid,
    hostPid: hostPidOf(),
    processStartedAt: new Date(now() - process.uptime() * 1000).toISOString(),
    serverStartedAt: new Date(serverStartedAtMs).toISOString(),
    entry: opts.entry,
    buildFingerprint: opts.buildFingerprint,
    lastHeartbeatAt: new Date(now()).toISOString(),
    version: opts.version,
  };

  const write = (): void => {
    try {
      fs.mkdirSync(instancesDir(), { recursive: true });
    } catch {
      /* the write below will surface a real dir problem */
    }
    atomicWriteJson(file, record);
  };

  // Initial registration. Throws on failure so index.ts can mark the registry
  // as unavailable instead of letting health claim a healthy heartbeat.
  write();

  const handle: RegistryHandle = {
    instanceId,
    beat: () => {
      record.lastHeartbeatAt = new Date(now()).toISOString();
      try {
        write();
      } catch {
        /* a heartbeat write failure is surfaced via snapshot (self record goes
           heartbeat_timeout); it must never crash the server */
      }
    },
    stopHeartbeat: () => {
      clearInterval(interval);
    },
    unregister: () => {
      clearInterval(interval);
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort: residue is handled by stale/identity detection */
      }
    },
  };
  const interval = setInterval(() => handle.beat(), heartbeatMs);
  interval.unref();
  return handle;
}

// ---------------------------------------------------------------------------
// Read-only snapshot / diagnostics.
// ---------------------------------------------------------------------------

function bump(map: Partial<Record<RegistryStaleReason, number>>, key: RegistryStaleReason): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** Compact, sanitized reason summary (fixed tokens only, no paths). */
export function summarizeStaleReasons(
  reasons: Partial<Record<RegistryStaleReason, number>>,
): string {
  const entries = Object.entries(reasons).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return entries.map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
}

export interface SnapshotRegistryOptions {
  /** This process's own instanceId, or null when not registered. */
  instanceId: string | null;
  /** Injectable "now" (epoch ms). */
  now: number;
  heartbeatMs: number;
  staleAfterMs: number;
  inspector: ProcessInspector;
  /** Max |OS startTime - recorded processStartedAt| that still verifies. */
  identityToleranceMs?: number;
}

/**
 * Read-only scan of the instance registry. Never creates the dir, never writes,
 * never kills/cleans up anything. A missing dir is an empty registry; an
 * unreadable dir is an error. Duplicate suspicion is based ONLY on identity-
 * verified live instances (stale residue can never count as a duplicate).
 */
export function snapshotRegistry(opts: SnapshotRegistryOptions): RegistrySnapshot {
  const tolerance = opts.identityToleranceMs ?? 5000;
  const dir = instancesDir();
  const snap: RegistrySnapshot = {
    enabled: true,
    instanceId: opts.instanceId ?? null,
    recorded: false,
    lastHeartbeatAt: null,
    heartbeatMs: opts.heartbeatMs,
    staleAfterMs: opts.staleAfterMs,
    instanceCount: 0,
    liveCount: 0,
    staleCount: 0,
    staleReasons: {},
    duplicateInstanceSuspected: false,
    registryStale: false,
    error: null,
  };
  // Identity-verified live instances grouped by host: several instances of ONE
  // host (Codex Desktop multi-window setup) are not duplicates.
  const liveHosts = new Set<string | number>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    if (fs.existsSync(dir)) snap.error = 'registry_dir_unreadable';
    return snap;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // skip atomic-write tmp files
    const f = path.join(dir, name);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      snap.instanceCount += 1;
      snap.staleCount += 1;
      bump(snap.staleReasons, 'corrupt');
      continue;
    }
    const r = raw as Partial<InstanceRecord>;
    if (!isValidRecord(r)) {
      snap.instanceCount += 1;
      snap.staleCount += 1;
      bump(snap.staleReasons, 'invalid');
      continue;
    }
    snap.instanceCount += 1;
    const isSelf = opts.instanceId !== null && r.instanceId === opts.instanceId;
    const reasons: RegistryStaleReason[] = [];
    let identityLive = false;

    // Heartbeat freshness.
    const hbMs = Date.parse(r.lastHeartbeatAt);
    if (Number.isNaN(hbMs)) {
      reasons.push('invalid_timestamp');
    } else if (opts.now - hbMs > opts.staleAfterMs) {
      reasons.push('heartbeat_timeout');
    }

    // Identity: alive + creation time matches the record's processStartedAt.
    if (isSelf) {
      // We are the process running the scan; our identity is trivially live,
      // but our own heartbeat staleness must still flag registry_stale.
      identityLive = true;
      snap.recorded = true;
      snap.lastHeartbeatAt = r.lastHeartbeatAt;
    } else {
      let exists: boolean;
      try {
        exists = opts.inspector.exists(r.pid);
      } catch {
        exists = false;
      }
      if (!exists) {
        reasons.push('pid_not_found');
      } else {
        const startMs = Date.parse(r.processStartedAt);
        if (Number.isNaN(startMs)) {
          reasons.push('invalid_timestamp');
        } else {
          let osStart: number | null = null;
          try {
            osStart = opts.inspector.startTime(r.pid);
          } catch {
            osStart = null;
          }
          if (osStart === null) {
            // Conservative: cannot prove identity => unknown/stale, never healthy.
            reasons.push('identity_unverified');
          } else if (Math.abs(osStart - startMs) > tolerance) {
            // PID reused by a different process (or a lie in the record).
            reasons.push('identity_mismatch');
          } else {
            identityLive = true;
          }
        }
      }
    }
    if (identityLive) snap.liveCount += 1;
    // Group live instances by host. Codex Desktop spawns one MCP instance per
    // session window, all under the SAME app-server PID (the launcher injects
    // that PID via ORCHESTRATOR_HOST_PID); several live instances of ONE host
    // are a normal multi-window setup, NOT duplicates. A record without
    // hostPid (legacy/direct spawn) is grouped by its own PID, so the old
    // cross-host guard still works for shared-runtime setups.
    if (
      identityLive &&
      r.hostPid !== undefined &&
      r.hostPid !== null &&
      Number.isInteger(r.hostPid) &&
      r.hostPid > 0
    ) {
      liveHosts.add(r.hostPid);
    } else if (identityLive) {
      liveHosts.add(`pid:${r.pid}`);
    }
    if (reasons.length > 0) {
      snap.staleCount += 1;
      for (const rn of reasons) bump(snap.staleReasons, rn);
    }
  }
  snap.duplicateInstanceSuspected = snap.liveCount >= 2 && liveHosts.size >= 2;
  snap.registryStale = snap.staleCount > 0;
  return snap;
}
