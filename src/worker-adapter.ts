// Worker backends are selected by an explicit, persisted adapter name.  The
// scheduler/supervisor contract stays backend-neutral: a backend only owns
// process launch and its capability declaration; job state, watch, cancel,
// reports, PID identity and attention policy remain shared infrastructure.
//
// Capability booleans are declared once in backend-policy.ts (pure policy) and
// re-exported here so the adapter and every existing importer share one source
// of truth.  This file adds the read-only on-disk Harness probe.
import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_CAPABILITIES, isWorkerBackend, type WorkerBackend } from './backend-policy.js';

export {
  WORKER_BACKENDS,
  isWorkerBackend,
  type WorkerBackend,
  BACKEND_CAPABILITIES,
} from './backend-policy.js';

/** Backward-compatible default: existing jobs continue to use Claude. */
export function defaultWorkerBackend(env: Record<string, string | undefined> = process.env): WorkerBackend {
  return isWorkerBackend(env.ORCHESTRATOR_DEFAULT_WORKER_BACKEND)
    ? env.ORCHESTRATOR_DEFAULT_WORKER_BACKEND
    : 'claude';
}

export interface DeepSeekHarnessInstallation {
  available: boolean;
  root: string;
  runner: string | null;
  version: string | null;
  /**
   * Bridge patch path (relative/absolute) that exists on disk and is usable
   * by a run.  Probe fact only — it says nothing about whether the current
   * process opted into the bridge; see bridgeConfigured for that.
   */
  bridgePatch: string | null;
  reason: 'ok' | 'root_missing' | 'runner_missing';
}

/**
 * The bridge patch actually selected for this process's runs, or null.
 *
 * The bridge is an explicit opt-in: the on-disk probe result alone is not
 * enough — only a non-empty DEEPSEEK_HARNESS_BRIDGE_PATCH in the process
 * environment selects the bridge, and DEEPSEEK_HARNESS_DISABLE_BRIDGE=1
 * always overrides it (the harness then runs fully independently, even if
 * the env patch points at a file that exists).
 */
export function resolveBridgePatch(
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env.DEEPSEEK_HARNESS_DISABLE_BRIDGE === '1') return null;
  const explicit = (env.DEEPSEEK_HARNESS_BRIDGE_PATCH || '').trim();
  return explicit || null;
}

function readVersion(root: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' && raw.version.length <= 64 ? raw.version : null;
  } catch {
    return null;
  }
}

/**
 * Candidate Harness roots, probed in priority order.
 *
 * This used to default to a hard-coded author-local source checkout path,
 * which made the backend permanently unavailable on every other machine (and
 * on any machine where that path exists but holds no runnable bundle). An
 * explicit DEEPSEEK_HARNESS_ROOT still wins; otherwise the usual global-npm
 * locations of the published `@deepseek-ai/dsh` package are probed.
 */
function harnessRootCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  const explicit = (env.DEEPSEEK_HARNESS_ROOT || '').trim();
  if (explicit) out.push(explicit);
  const globalDirs = [
    env.APPDATA ? path.join(env.APPDATA, 'npm', 'node_modules') : '',
    env.PREFIX ? path.join(env.PREFIX, 'lib', 'node_modules') : '',
    env.HOME ? path.join(env.HOME, '.npm-global', 'lib', 'node_modules') : '',
    env.HOME ? path.join(env.HOME, '.local', 'share', 'npm', 'lib', 'node_modules') : '',
  ];
  for (const dir of globalDirs) {
    if (dir) out.push(path.join(dir, '@deepseek-ai', 'dsh'));
  }
  return out.filter((v, i) => !!v && out.indexOf(v) === i);
}

/** Runner entry points: published npm layout first, then source-checkout layout. */
function harnessRunnerCandidates(root: string): string[] {
  return [
    path.join(root, 'lib', 'bin.js'),
    path.join(root, 'apps', 'cli', 'lib', 'bin.js'),
    path.join(root, 'apps', 'cli', 'src', 'bin.ts'),
  ];
}

/**
 * Read-only local capability probe.  It never starts Harness, reads no
 * credentials and does not inspect a complete command line.
 */
export function detectDeepSeekHarness(
  env: Record<string, string | undefined> = process.env,
): DeepSeekHarnessInstallation {
  const requested = (env.DEEPSEEK_HARNESS_RUNNER || '').trim();
  const roots = harnessRootCandidates(env);

  let root = roots[0] ?? '';
  let runner: string | null = null;

  // An explicitly configured runner is authoritative when it exists on disk.
  if (requested && fs.existsSync(requested)) {
    runner = requested;
    if (!root || !fs.existsSync(root)) {
      // Fall back to the directory that owns the configured entry point.
      root = path.dirname(path.dirname(requested));
    }
  }
  if (!runner) {
    for (const candidateRoot of roots) {
      if (!fs.existsSync(candidateRoot)) continue;
      const found = harnessRunnerCandidates(candidateRoot).find((c) => fs.existsSync(c));
      if (found) {
        root = candidateRoot;
        runner = found;
        break;
      }
    }
  }

  if (!runner) {
    const anyRootExists = roots.some((r) => fs.existsSync(r));
    return {
      available: false,
      root,
      runner: null,
      version: root ? readVersion(root) : null,
      bridgePatch: null,
      reason: anyRootExists ? 'runner_missing' : 'root_missing',
    };
  }

  // Probe-only fact: the on-disk candidate the probe would use is reported
  // for observability, but it does NOT make the bridge "configured" — the
  // run itself only passes --patch when the process env opts in (see
  // resolveBridgePatch / the worker adapter).
  //
  // The bridge plugin is an optional third-party component that is NOT part
  // of this repository, so there is no default on-disk location to probe:
  // the path must be supplied explicitly through DEEPSEEK_HARNESS_BRIDGE_PATCH.
  const bridgeCandidate = (env.DEEPSEEK_HARNESS_BRIDGE_PATCH || '').trim();
  const bridgePatch =
    bridgeCandidate.length > 0 && fs.existsSync(bridgeCandidate) ? bridgeCandidate : null;
  return {
    available: true,
    root,
    runner,
    version: readVersion(root),
    bridgePatch,
    reason: 'ok',
  };
}

export interface WorkerCapabilities {
  backend: WorkerBackend;
  available: boolean;
  supportsCancel: true;
  supportsAttention: boolean;
  supportsLiveEvents: boolean;
  supportsSessionResume: boolean;
  bridgeConfigured: boolean;
  version?: string;
  unavailableReason?: string;
}

/** Capability matrix is deliberately honest about the local DeepSeek Harness headless adapter. */
export function workerCapabilities(
  backend: WorkerBackend,
  env: Record<string, string | undefined> = process.env,
): WorkerCapabilities {
  // Capability booleans come from the single source of truth in
  // backend-policy.ts; the probe only adds availability/version/bridge facts.
  const policy = BACKEND_CAPABILITIES[backend];
  if (backend === 'claude') {
    return {
      backend,
      available: true,
      supportsCancel: policy.supportsCancel,
      supportsAttention: policy.supportsAttention,
      supportsLiveEvents: policy.supportsLiveEvents,
      supportsSessionResume: policy.supportsSessionResume,
      bridgeConfigured: false,
    };
  }
  const probe = detectDeepSeekHarness(env);
  return {
    backend,
    available: probe.available,
    supportsCancel: policy.supportsCancel,
    // The documented headless runner exposes only final text; it does not
    // expose structured permission/control events or a live event stream.
    supportsAttention: policy.supportsAttention,
    supportsLiveEvents: policy.supportsLiveEvents,
    // The locally probed DeepSeek Harness headless bundle is one-shot.  Reply
    // jobs are intentionally kept as fresh bounded turns until a persistent
    // SDK adapter is added.
    supportsSessionResume: policy.supportsSessionResume,
    // bridgeConfigured is strictly "this process environment explicitly
    // opted in and did not disable": a non-empty DEEPSEEK_HARNESS_BRIDGE_PATCH
    // with DISABLE unset/≠1.  An auto-probed bridge file is available for
    // runs but is NOT configured.  `available` keeps its file-probe meaning.
    bridgeConfigured: resolveBridgePatch(env) !== null,
    ...(probe.version ? { version: probe.version } : {}),
    ...(probe.available ? {} : { unavailableReason: probe.reason }),
  };
}
