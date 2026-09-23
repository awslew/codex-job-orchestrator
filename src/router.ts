// Profile -> port/permission-mode routing. Routing is keyed on the
// permission profile, never on a model name.
//
// Truth table (user-approved 2026-08-18; amended 2026-08-26): the 15722
// auto-mode router was removed (user canceled the 15722 claude-router
// process). All profiles route to the same local port directly:
//   auto   -> 15721 + permission-mode bypassPermissions (implementation
//              default; Auto Mode permission classifier REMOVED 2026-08-26
//              per user decision — every scheduled/worker run is fully
//              approved, no model-backed permission checks at all)
//   review -> 15721 + permission-mode plan      (read-only review)
//   normal -> 15721 + permission-mode acceptEdits (manual control / failure fallback only)
//
// The auto profile no longer uses the native permission classifier: it times
// out through the DeepSeek route and blocks already-approved work. By the
// 2026-08-26 user decision the classifier is gone for good: auto runs
// bypassPermissions (full approval), so the deny list is the ONLY effective
// policy layer. It is the union of the built-in baseline (config.
// DEFAULT_WORKER_DENY: bulk deletes, network egress, credential stores,
// env/printenv, system-dir writes, push/publish) and the rules in the user's
// whitelist file — config can tighten it, never lower it — and even then it is
// a literal prefix match, not a sandbox. allow rules merely suppress prompts.
import path from 'node:path';
import fs from 'node:fs';
import {
  DEFAULT_MAX_RUNTIME_MIN,
  MIN_MAX_RUNTIME_MIN,
  MAX_MAX_RUNTIME_MIN,
  PORT_REVIEW,
} from './config.js';
import {
  defaultWorkerBackend,
  isWorkerBackend,
  type WorkerBackend,
} from './worker-adapter.js';
import {
  validateTaskContractV2,
  type TaskContractV2,
} from './contracts-v2.js';

export const PROFILES = ['normal', 'review', 'auto'] as const;
export type Profile = (typeof PROFILES)[number];

export const PARALLELISM_VALUES = ['auto', '1', '2', '3', '4'] as const;
export type Parallelism = (typeof PARALLELISM_VALUES)[number];

// Task kind. `execution` is the historical behavior (implementation task with
// no explicit deliverable). `research`/`analysis` are explicit research /
// analysis tasks whose single primary artifact is a Markdown report written to
// the leader-provided absolute deliverablePath. Omitted taskType means
// execution and must preserve existing behavior byte-for-byte.
export const TASK_TYPES = ['execution', 'research', 'analysis'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export function isTaskType(v: unknown): v is TaskType {
  return typeof v === 'string' && (TASK_TYPES as readonly string[]).includes(v);
}

export interface Routing {
  port: number;
  permissionMode: 'acceptEdits' | 'plan' | 'bypassPermissions';
  label: string;
}

export function resolveRouting(profile: Profile): Routing {
  switch (profile) {
    case 'auto':
      return { port: PORT_REVIEW, permissionMode: 'bypassPermissions', label: '15721+bypass' };
    case 'review':
      return { port: PORT_REVIEW, permissionMode: 'plan', label: '15721+plan' };
    case 'normal':
      return { port: PORT_REVIEW, permissionMode: 'acceptEdits', label: '15721+acceptEdits' };
  }
}

export interface StartParams {
  prompt: string;
  workFolder: string;
  profile?: Profile;
  parallelism?: Parallelism;
  maxRuntimeMinutes?: number;
  // Task kind / deliverable contract. Omitted taskType means execution (the
  // existing behavior). research|analysis require an absolute deliverablePath
  // inside workFolder naming a .md file; execution rejects a supplied path.
  taskType?: TaskType;
  deliverablePath?: string;
  /** TaskContractV2 (strictly validated when supplied). Omitted keeps all V1
   *  behavior; the Router does NOT synthesize a legacy contract here. */
  contract?: TaskContractV2;
  // Internal/testing seams; not exposed through the MCP tool schema.
  claudeCli?: string;
  claudePrefix?: string[];
  extraEnv?: Record<string, string>;
  /** Worker adapter. Omitted keeps the historical Claude backend. */
  workerBackend?: WorkerBackend;
}

export function validateStartParams(p: StartParams): string[] {
  const errors: string[] = [];
  if (typeof p.prompt !== 'string' || p.prompt.trim().length === 0) {
    errors.push('prompt must be a non-empty string');
  }
  if (typeof p.workFolder !== 'string' || p.workFolder.trim().length === 0) {
    errors.push('workFolder must be an absolute path');
  } else if (!path.isAbsolute(p.workFolder)) {
    errors.push('workFolder must be an absolute path (relative paths are rejected)');
  } else {
    try {
      if (!fs.statSync(p.workFolder).isDirectory()) errors.push('workFolder must be a directory');
    } catch {
      errors.push('workFolder does not exist');
    }
  }
  const profile = p.profile ?? 'auto';
  if (!(PROFILES as readonly string[]).includes(profile)) {
    errors.push(`profile must be one of ${PROFILES.join(', ')}`);
  }
  const parallelism = p.parallelism ?? 'auto';
  if (!(PARALLELISM_VALUES as readonly string[]).includes(parallelism)) {
    errors.push(`parallelism must be one of ${PARALLELISM_VALUES.join(', ')}`);
  }
  const max = p.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MIN;
  if (typeof max !== 'number' || !Number.isInteger(max)) {
    errors.push('maxRuntimeMinutes must be an integer');
  } else if (max < MIN_MAX_RUNTIME_MIN || max > MAX_MAX_RUNTIME_MIN) {
    errors.push(`maxRuntimeMinutes must be between ${MIN_MAX_RUNTIME_MIN} and ${MAX_MAX_RUNTIME_MIN}`);
  }

  const workerBackend = p.workerBackend ?? defaultWorkerBackend();
  if (!isWorkerBackend(workerBackend)) {
    errors.push('workerBackend must be one of claude, deepseek-harness');
  }

  // Deliverable contract: research/analysis MUST carry an absolute
  // deliverablePath that resolves inside workFolder and names a .md file
  // (case-insensitive). execution rejects any supplied deliverablePath so the
  // contract stays unambiguous. All checks happen before the job is persisted.
  const taskType = p.taskType ?? 'execution';
  if (p.taskType !== undefined && !isTaskType(p.taskType)) {
    errors.push(`taskType must be one of ${TASK_TYPES.join(', ')}`);
  }
  if (taskType === 'execution' && p.deliverablePath !== undefined) {
    errors.push('deliverablePath is only allowed for research/analysis tasks');
  }
  if (taskType === 'research' || taskType === 'analysis') {
    const rawDp = typeof p.deliverablePath === 'string' ? p.deliverablePath.trim() : '';
    if (!rawDp) {
      errors.push('deliverablePath is required for research/analysis tasks');
    } else if (!path.isAbsolute(rawDp)) {
      errors.push('deliverablePath must be an absolute path');
    } else if (typeof p.workFolder !== 'string' || !path.isAbsolute(p.workFolder)) {
      // workFolder already recorded its own error; skip misleading containment
      // checks that would resolve against an invalid base.
    } else {
      if (!/\.md$/i.test(rawDp)) {
        errors.push('deliverablePath must name a .md file');
      }
      const wf = path.resolve(p.workFolder);
      const dp = path.resolve(rawDp);
      let rel: string;
      try {
        rel = path.relative(wf, dp);
      } catch {
        rel = '..';
      }
      if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
        errors.push('deliverablePath must resolve inside workFolder');
      } else if (rel === '') {
        errors.push('deliverablePath must not equal workFolder');
      }
    }
  }
  // TaskContractV2 (optional, strict). When supplied, validate against the
  // already validated/resolved absolute workFolder; failures are reported as
  // plain structured errors (field paths / reasons only — never echo prompt,
  // env or full argv). When omitted, nothing is validated and all V1 behavior
  // is preserved exactly (no legacy contract is synthesized here).
  if (p.contract !== undefined) {
    const res = validateTaskContractV2(p.contract, path.resolve(p.workFolder));
    if (!res.ok) errors.push(...res.errors);
  }
  return errors;
}

export interface StartDefaults {
  profile: Profile;
  parallelism: Parallelism;
  maxRuntimeMinutes: number;
}

// Resolve defaults for a validated StartParams. Implementation tasks default
// to the `auto` profile (15721 + permission-mode bypassPermissions, the fully
// approved mode) per the 2026-08-26 routing decision (permission classifier
// removed, scheduled/worker runs are fully approved); `normal`/`review` are
// explicit choices.
export function buildStartDefaults(p: StartParams): StartDefaults {
  return {
    profile: p.profile ?? 'auto',
    parallelism: p.parallelism ?? 'auto',
    maxRuntimeMinutes: p.maxRuntimeMinutes ?? DEFAULT_MAX_RUNTIME_MIN,
  };
}
