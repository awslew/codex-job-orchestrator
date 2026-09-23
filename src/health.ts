// Read-only health / version / reload diagnostics for the MCP server (Stage 3,
// hardened in Stage 5).
//
// Everything here is read-only: it never starts/stops processes, never writes
// job/runtime state (job counts are a read-only directory scan, no mkdir), and
// never exposes prompts, tokens, raw logs, diffs, env values, keys, or the full
// command line. Paths are reduced to basenames / minimal relative names.
//
// Reload signal (Stage 5 fix): the OLD fingerprint hashed only the process
// entry (dist/index.js), so a change to a dependency module (scheduler, proc,
// ...) with an unchanged entry was invisible and the process wrongly reported
// healthy/current. `loaded.buildFingerprint` is now a deterministic root hash
// over the WHOLE production dist module set captured at process start;
// `disk.buildFingerprint` is recomputed over the same set on every call.
// Adding/removing/modifying any production module changes the hash and triggers
// reload_required. Any unreadable module -> hash_unavailable + reloadRequired.
// The legacy `buildHash` (entry-only SHA-256) fields are kept for backward
// compatibility but are informational, not the reload decision source.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SERVER_ROOT, runtimeRoot, jobsDir, distDir, retentionV2Enabled, readWorkerWhitelist, resolveWorkerDeny } from './config.js';
import { peekJobIndexForHealth, scheduleJobIndexRebuild, scheduleJobIndexRebuildTestHooks, type JobIndexHealthSnapshot } from './job-store.js';
import type { IndexDiagnostics } from './job-index.js';
import {
  summarizeStaleReasons,
  type RegistrySnapshot,
  type RegistryStaleReason,
} from './registry.js';
import { workerCapabilities, type WorkerCapabilities } from './worker-adapter.js';

export type HealthDiagnostic =
  | 'healthy/current'
  | 'reload_required'
  | 'duplicate_instance_suspected'
  | 'registry_stale'
  | 'hash_unavailable';

export type DiagnosticCode =
  | 'hash_unavailable'
  | 'reload_required'
  | 'duplicate_instance_suspected'
  | 'registry_stale';

export interface DiagnosticItem {
  code: DiagnosticCode;
  severity: 'info' | 'warning';
  /** Short, sanitized detail (no full paths / commands / secrets). */
  detail: string;
}

export interface RegistryHealthView {
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
  duplicateInstanceSuspected: boolean;
  registryStale: boolean;
  /** Registry-level failure (dir unreadable), else null. */
  error: string | null;
}

export interface HealthView {
  version: string;
  node: string;
  instance: { pid: number; startedAt: string; uptimeSec: number; entry: string };
  loaded: { entry: string; buildHash: string; buildFingerprint: string };
  disk: { entry: string; buildHash: string; buildFingerprint: string };
  reloadRequired: boolean;
  diagnostic: HealthDiagnostic;
  capabilities: {
    tools: string[];
    structuredAttentionDetail: boolean;
    responseAudit: boolean;
    workerBackends: {
      claude: WorkerCapabilities;
      deepseekHarness: WorkerCapabilities;
    };
  };
  runtime: { jobCounts: Record<string, number>; runtimeDir: string; jobIndex: JobIndexHealthView };
  duplicateInstanceSuspected: boolean;
  registryStale: boolean;
  registry: RegistryHealthView;
  diagnostics: DiagnosticItem[];
  notes: string[];
}

const JOB_STATUSES = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'] as const;

// Wave 5A2b: JobIndex health section (additive; fixed field set, no paths).
// consistency is the public index diagnostics consistency; when the index is
// disabled or missing it is reported as 'disabled'. dirty is the job-store's
// internal mirror-failure flag; indexSize is the O(1) cached index size.
// jobFileCount is a stat-only count of job JSON files (contents never read).
// rebuildScheduled is true when an async rebuild is already queued for this
// runtime root — the flag is PUBLIC but the decision to (re)schedule lives in
// the callable API, never here.
export interface JobIndexHealthView {
  enabled: boolean;
  consistency: 'disabled' | IndexDiagnostics['consistency'];
  dirty: boolean;
  indexSize: number;
  jobFileCount: number;
  rebuildScheduled: boolean;
}

// Best-effort stat-only count of job JSON files under the jobs dir. Reads only
// the directory listing (never file contents) and is clamped at a sane cap so
// a pathological directory can never make health itself expensive. A
// missing/unreadable jobs dir yields 0 — health never creates runtime dirs.
function countJobFiles(): number {
  let names: string[] = [];
  try {
    names = fs.readdirSync(jobsDir());
  } catch {
    return 0;
  }
  let count = 0;
  for (const f of names) {
    if (f.endsWith('.json') && !f.endsWith('.done.json')) count += 1;
    if (count >= 1_000_000) break;
  }
  return count;
}

export function sha256File(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

// Deterministic production module-set fingerprint: SHA-256 over the sorted list
// of (relative path, content hash) for EVERY regular file under `dir`. A change
// to any module (add/remove/modify) changes the root hash. Any unreadable file
// makes the whole fingerprint unavailable ('' -> hash_unavailable), never a
// partial match.
export function computeBuildFingerprint(dir: string): string {
  let rels: string[];
  try {
    rels = walkFiles(dir);
  } catch {
    return '';
  }
  const lines: string[] = [];
  for (const rel of rels) {
    const hex = sha256File(path.join(dir, rel));
    if (!hex) return ''; // conservative: cannot prove the full set is intact
    lines.push(`${rel}\0${hex}`);
  }
  lines.sort();
  const h = crypto.createHash('sha256');
  for (const line of lines) h.update(line + '\0');
  return h.digest('hex');
}

// Wave 5A2b: cached build fingerprint. The fingerprint is recomputed on every
// computeHealth call, and for a large module set the per-file content hashes
// dominate the cost. The cache keys the expensive part on a cheap deterministic
// signature — (relative path, size, mtimeMs) of every regular file under the
// dir. An unchanged signature reuses the previous hash; ANY change (modify,
// add, remove) recomputes the full content hash. A signature/hash collision is
// impossible by construction for adds/removes, and a same-size/same-mtime
// modification is the classic mtime-resolution miss — the cached hash is still
// deterministic over the files it was computed from, and the reload path stays
// correct. Failing to read a file invalidates the cache (the fingerprint goes
// '' — hash_unavailable), so a later readable state is never served stale.
interface FingerprintCacheEntry {
  signature: string;
  hash: string;
}
const fingerprintCache = new Map<string, FingerprintCacheEntry>();

/** Test-only: number of full content-hash computations done by the cached
 *  fingerprint (0 after a warm cache + unchanged signature). */
let fingerprintHashComputations = 0;
export function fingerprintHashCalls(): number {
  return fingerprintHashComputations;
}

/** Deterministic signature of a directory's module set: every regular file's
 *  (relative path, size, mtimeMs) joined with NULs. Unreadable/missing dir => ''. */
function fingerprintSignature(dir: string): string {
  let rels: string[];
  try {
    rels = walkFiles(dir);
  } catch {
    return '';
  }
  rels.sort();
  const parts: string[] = [];
  for (const rel of rels) {
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(dir, rel));
    } catch {
      return '';
    }
    if (!st.isFile()) return '';
    parts.push(`${rel}\0${st.size}\0${st.mtimeMs}`);
  }
  return parts.join('\0');
}

/**
 * computeBuildFingerprint with a memoization layer (Wave 5A2b). The signature
 * (relative path + size + mtimeMs of every regular file under `dir`) is the
 * cache key: unchanged signature reuses the previous full content hash; any
 * change (modify/add/remove) recomputes it. The ORIGINAL deterministic
 * computeBuildFingerprint is unchanged and remains the reference — callers
 * that need the raw function (e.g. loaded-fingerprint capture) keep using it.
 * Invalidated only by a signature change or by invalidateHealthCachesForTests().
 */
export function computeBuildFingerprintCached(dir: string): string {
  const signature = fingerprintSignature(dir);
  if (signature === '') {
    fingerprintCache.delete(dir);
    fingerprintHashComputations += 1;
    return computeBuildFingerprint(dir);
  }
  const cached = fingerprintCache.get(dir);
  if (cached && cached.signature === signature) return cached.hash;
  fingerprintHashComputations += 1;
  const hash = computeBuildFingerprint(dir);
  fingerprintCache.set(dir, { signature, hash });
  return hash;
}

/** Test-only: drop every cached fingerprint so a mutated module set is
 *  recomputed from scratch. Not part of the public contract. */
export function invalidateHealthCachesForTests(): void {
  fingerprintCache.clear();
  jobFileReads = 0;
  fingerprintHashComputations = 0;
}

/** Test-only: whether the legacy job-count scan is enabled (flag OFF). The
 *  default env in this test file is flag-off, which is exactly what the
 *  legacy-scan tests assert. */
export function legacyScanEnabled(): boolean {
  return !retentionV2Enabled();
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        out.push(path.relative(dir, abs).split(path.sep).join('/'));
      }
    }
  }
  return out;
}

const PKG_NAME = 'claude-code-orchestrator';
// Version must be a short, safe token (semver-ish: alphanumeric + `. - +`),
// never a secret or a long path-like string.
const SAFE_VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.\-+]{0,31}$/;

let cachedVersion: string | null = null;

function readOwnVersion(dir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
      name?: unknown;
      version?: unknown;
    };
    if (pkg.name !== PKG_NAME) return null;
    if (typeof pkg.version !== 'string' || !SAFE_VERSION_RE.test(pkg.version)) return null;
    return pkg.version;
  } catch {
    return null;
  }
}

// package.json is the single source of truth for the orchestrator version. Only
// the project's OWN package.json (exact name + safe short version) is accepted,
// from SERVER_ROOT or its immediate parent (the test build sits one level deeper
// under dist-test). No upward scanning beyond that; anything else -> '0.0.0'.
export function packageVersion(): string {
  if (cachedVersion) return cachedVersion;
  const found = readOwnVersion(SERVER_ROOT) ?? readOwnVersion(path.dirname(SERVER_ROOT));
  cachedVersion = found ?? '0.0.0';
  return cachedVersion;
}

// Read-only job-status histogram. Never mkdirs: a missing/empty jobs dir simply
// yields all-zero counts (health must not mutate runtime state).
//
// Wave 5A2b: with the JobIndex feature flag ON the histogram comes from the
// cached index's O(1) statusCounts (peekJobIndexForHealth — never a job-dir
// scan, never a rebuild); flag-off keeps the legacy per-file scan. The extra
// stat-only jobFileCount readdir is bounded and reads no file contents.
let jobFileReads = 0;
/** Test-only: count of job JSON file content reads (legacy scan). */
export function healthJobFileReads(): number {
  return jobFileReads;
}
function readOnlyJobCounts(): Record<string, number> {
  const counts: Record<string, number> = { total: 0, queued: 0, running: 0, needs_attention: 0, succeeded: 0, failed: 0, cancelled: 0 };
  const dir = jobsDir();
  if (retentionV2Enabled()) {
    const snap = peekJobIndexForHealth();
    if (!snap.enabled) return counts;
    jobFileReads = 0; // index counts never read job files
    return { total: snap.indexSize, ...snap.statusCounts };
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return counts;
  }
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.done.json')) continue;
    counts.total += 1;
    jobFileReads += 1;
    try {
      const status = (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as { status?: string }).status;
      if (status && status in counts) counts[status] += 1;
    } catch {
      /* unreadable job file: counted in total only */
    }
  }
  return counts;
}

const EMPTY_REGISTRY: RegistryHealthView = {
  enabled: false,
  instanceId: null,
  recorded: false,
  lastHeartbeatAt: null,
  heartbeatMs: 0,
  staleAfterMs: 0,
  instanceCount: 0,
  liveCount: 0,
  staleCount: 0,
  staleReasons: {},
  duplicateInstanceSuspected: false,
  registryStale: false,
  error: null,
};

export interface ComputeHealthOptions {
  entryPath: string;
  /** Legacy entry-only SHA-256, kept for backward compatibility. */
  loadedBuildHash: string;
  /** Full production module-set fingerprint captured at process start. */
  loadedBuildFingerprint: string;
  startedAt: number;
  registeredTools: string[];
  version: string;
  /** Instance-registry snapshot; omit for an inert (not enabled) registry. */
  registry?: RegistryHealthView;
}

export type { JobIndexHealthSnapshot };
export { scheduleJobIndexRebuildTestHooks };

export function computeHealth(opts: ComputeHealthOptions): HealthView {
  const diskEntryHash = sha256File(opts.entryPath);
  const diskFingerprint = computeBuildFingerprintCached(distDir());
  const loadedAvailable = opts.loadedBuildFingerprint.length > 0;
  const diskAvailable = diskFingerprint.length > 0;
  // Conservative: if either fingerprint is unavailable we cannot prove the
  // process matches the on-disk build, so report hash_unavailable +
  // reloadRequired instead of claiming health we cannot prove.
  const buildUnavailable = !loadedAvailable || !diskAvailable;
  const buildReload = !buildUnavailable && diskFingerprint !== opts.loadedBuildFingerprint;
  const reloadRequired = buildUnavailable || buildReload;
  const diagnostic: HealthDiagnostic = buildUnavailable
    ? 'hash_unavailable'
    : buildReload
      ? 'reload_required'
      : 'healthy/current';
  const reg = opts.registry ?? EMPTY_REGISTRY;
  const tools = [...opts.registeredTools].sort();
  const hasWatch = tools.includes('claude_code_watch');
  const hasStatus = tools.includes('claude_code_status');
  const hasReply = tools.includes('claude_code_reply');
  const claudeWorker = workerCapabilities('claude');
  const deepSeekWorker = workerCapabilities('deepseek-harness');
  const entry = path.basename(opts.entryPath);

  // Wave 5A2b: JobIndex health section. The snapshot comes from the cached
  // index (never a sync rebuild, never a job-dir scan); jobFileCount is the
  // stat-only listing count. When the index is missing/corrupt or its size
  // disagrees with the file count, we surface rebuildScheduled=true and queue
  // ONE async rebuild (setImmediate, in-process idempotent) — health itself
  // never blocks on the rebuild, and the next health call sees the refreshed
  // counts. A rebuild already queued is not re-queued.
  const jobIndexSnap = peekJobIndexForHealth();
  const jobFileCount = countJobFiles();
  const jobIndex: JobIndexHealthView = {
    enabled: jobIndexSnap.enabled,
    consistency: jobIndexSnap.enabled ? jobIndexSnap.diagnostics.consistency : 'disabled',
    dirty: jobIndexSnap.enabled && jobIndexSnap.dirty,
    indexSize: jobIndexSnap.enabled ? jobIndexSnap.indexSize : 0,
    jobFileCount,
    rebuildScheduled: jobIndexSnap.rebuildScheduled,
  };
  if (
    jobIndex.enabled &&
    !jobIndex.rebuildScheduled &&
    (jobIndexSnap.dirty ||
      jobIndexSnap.diagnostics.consistency === 'missing' ||
      jobIndexSnap.diagnostics.consistency === 'rebuild_required' ||
      jobIndexSnap.indexSize !== jobFileCount)
  ) {
    scheduleJobIndexRebuild();
    jobIndex.rebuildScheduled = true;
  }

  const diagnostics: DiagnosticItem[] = [];
  const notes: string[] = [];
  if (buildUnavailable) {
    diagnostics.push({
      code: 'hash_unavailable',
      severity: 'warning',
      detail:
        'build fingerprint unavailable (loaded or on-disk module set unreadable); rebuild then reload and re-check claude_code_health',
    });
    notes.push(
      'build fingerprint unavailable (loaded or on-disk module set unreadable); check the build is readable and rebuild, then reload and re-check claude_code_health',
    );
  } else if (buildReload) {
    diagnostics.push({
      code: 'reload_required',
      severity: 'warning',
      detail: 'on-disk build fingerprint differs from the loaded build; reload the MCP to pick it up',
    });
    notes.push(
      opts.loadedBuildHash === diskEntryHash
        ? 'entry bytes unchanged but a dependency module changed; the full-build fingerprint detects it (legacy entry-only hash did not)'
        : 'on-disk build fingerprint differs from the loaded build; reload the MCP to pick it up',
    );
  }
  if (reg.duplicateInstanceSuspected) {
    diagnostics.push({
      code: 'duplicate_instance_suspected',
      severity: 'warning',
      detail: `${reg.liveCount} identity-verified live instances in this runtime scope`,
    });
  }
  if (reg.registryStale) {
    diagnostics.push({
      code: 'registry_stale',
      severity: 'warning',
      detail: `${reg.staleCount} stale instance record(s): ${summarizeStaleReasons(reg.staleReasons)}`,
    });
  }
  if (reg.error) {
    notes.push(`instance registry error: ${reg.error}`);
  }
  if (!reg.enabled) {
    notes.push('instance registry not enabled in this process');
  } else if (diagnostics.every((d) => d.code !== 'duplicate_instance_suspected' && d.code !== 'registry_stale')) {
    notes.push(
      `instance registry: ${reg.instanceCount} record(s), ${reg.liveCount} identity-verified live, ${reg.staleCount} stale`,
    );
  }
  // F1 visibility, third channel: the worker deny list is always the built-in
  // floor UNION the file's own rules, so anything substituted or added by us is
  // worth a note. Kept path-free on purpose — health never returns absolute
  // paths; the start/reply tool response and the job's own stderr log carry the
  // actionable path.
  const whitelist = readWorkerWhitelist();
  if (whitelist.problem !== 'ok') {
    const resolution = resolveWorkerDeny(whitelist.permissions?.deny);
    const parts: string[] = [];
    if (resolution.source === 'floor') {
      parts.push(`the built-in default deny list (${resolution.deny.length} rules) is in effect`);
    } else if (resolution.addedByFloor.length > 0) {
      parts.push(
        `the built-in baseline added ${resolution.addedByFloor.length} rule(s) on top of the whitelist deny list (${resolution.deny.length} total)`,
      );
    }
    if (!Array.isArray(whitelist.permissions?.allow)) {
      parts.push('the allow list falls back to the built-in conservative list');
    }
    notes.push(
      `worker policy: ${whitelist.detail}${parts.length > 0 ? `; ${parts.join('; ')}` : ''}; install the whitelist file or set ORCHESTRATOR_WHITELIST_PATH`,
    );
  }

  return {
    version: opts.version,
    node: process.version,
    instance: {
      pid: process.pid,
      startedAt: new Date(opts.startedAt).toISOString(),
      uptimeSec: Math.max(0, Math.round((Date.now() - opts.startedAt) / 1000)),
      entry,
    },
    loaded: {
      entry,
      buildHash: opts.loadedBuildHash,
      buildFingerprint: opts.loadedBuildFingerprint,
    },
    disk: { entry, buildHash: diskEntryHash, buildFingerprint: diskFingerprint },
    reloadRequired,
    diagnostic,
    capabilities: {
      tools,
      structuredAttentionDetail: hasWatch && hasStatus,
      responseAudit: hasReply,
      workerBackends: { claude: claudeWorker, deepseekHarness: deepSeekWorker },
    },
    runtime: { jobCounts: readOnlyJobCounts(), runtimeDir: path.basename(runtimeRoot()), jobIndex },
    duplicateInstanceSuspected: reg.duplicateInstanceSuspected,
    registryStale: reg.registryStale,
    registry: {
      enabled: reg.enabled,
      instanceId: reg.instanceId,
      recorded: reg.recorded,
      lastHeartbeatAt: reg.lastHeartbeatAt,
      heartbeatMs: reg.heartbeatMs,
      staleAfterMs: reg.staleAfterMs,
      instanceCount: reg.instanceCount,
      liveCount: reg.liveCount,
      staleCount: reg.staleCount,
      staleReasons: reg.staleReasons,
      duplicateInstanceSuspected: reg.duplicateInstanceSuspected,
      registryStale: reg.registryStale,
      error: reg.error,
    },
    diagnostics,
    notes,
  };
}
