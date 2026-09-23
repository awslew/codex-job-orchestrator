// Pure backend policy: capability matrix and reply preflight decisions for
// worker backends.  This module has NO filesystem or process side effects —
// probing the on-disk Harness installation lives in worker-adapter.ts, which
// imports the capability booleans declared here as the single source of truth.
export const WORKER_BACKENDS = ['claude', 'deepseek-harness'] as const;
export type WorkerBackend = (typeof WORKER_BACKENDS)[number];

export function isWorkerBackend(value: unknown): value is WorkerBackend {
  return typeof value === 'string' && (WORKER_BACKENDS as readonly string[]).includes(value);
}

export const REPLY_MODES = ['resume_session', 'fresh_turn'] as const;
export type ReplyMode = (typeof REPLY_MODES)[number];

/** Max transcript bytes carried on a resume_session reply; override via env. */
export const DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;

export const ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES = 'ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES';

/** Parse the env override: positive integers only, invalid values fall back. */
export function replyTranscriptMaxBytes(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES];
  if (raw === undefined) return DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES;
}

export interface BackendCapabilities {
  backend: WorkerBackend;
  supportsCancel: true;
  supportsAttention: boolean;
  supportsLiveEvents: boolean;
  supportsSessionResume: boolean;
  replyMode: ReplyMode;
}

// Fixed per-backend semantics. Claude drives a persistent session; the rc8
// headless Harness is one-shot and every reply is a fresh, bounded turn.
export const BACKEND_CAPABILITIES: Record<WorkerBackend, BackendCapabilities> = {
  claude: {
    backend: 'claude',
    supportsCancel: true,
    supportsAttention: true,
    supportsLiveEvents: true,
    supportsSessionResume: true,
    replyMode: 'resume_session',
  },
  'deepseek-harness': {
    backend: 'deepseek-harness',
    supportsCancel: true,
    supportsAttention: false,
    supportsLiveEvents: false,
    supportsSessionResume: false,
    replyMode: 'fresh_turn',
  },
};

export type ReplyPreflightCode = 'new_start_required' | 'fresh_turn_authorization_required';
export type ReplyPreflightStatus = 'allowed' | 'denied';

export interface ReplyPreflight {
  status: ReplyPreflightStatus;
  allowed: boolean;
  code?: ReplyPreflightCode;
  replyMode?: ReplyMode;
  backend: WorkerBackend;
  bytes: number;
  threshold: number;
  allowLargeResume: boolean;
  allowFreshTurn: boolean;
  /** True only for an explicit env override; defaults keep the standard 2 MiB. */
  thresholdOverridden: boolean;
}

/**
 * Pure reply decision, no filesystem or process access.  `bytes` is the reply
 * transcript size already known to the caller; nothing here reads a path or a
 * prompt, and the returned object carries only fixed codes plus safe metadata.
 */
export function evaluateReplyPreflight(
  backend: WorkerBackend,
  bytes: number,
  opts: {
    allowLargeResume?: boolean;
    allowFreshTurn?: boolean;
    maxBytes?: number;
  } = {},
): ReplyPreflight {
  const caps = BACKEND_CAPABILITIES[backend];
  const threshold = opts.maxBytes ?? DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES;
  const allowLargeResume = opts.allowLargeResume === true;
  const allowFreshTurn = opts.allowFreshTurn === true;
  if (caps.replyMode === 'resume_session') {
    if (bytes > threshold && !allowLargeResume) {
      return {
        status: 'denied',
        allowed: false,
        code: 'new_start_required',
        backend,
        bytes,
        threshold,
        allowLargeResume,
        allowFreshTurn,
        thresholdOverridden: opts.maxBytes !== undefined,
      };
    }
    return {
      status: 'allowed',
      allowed: true,
      replyMode: 'resume_session',
      backend,
      bytes,
      threshold,
      allowLargeResume,
      allowFreshTurn,
      thresholdOverridden: opts.maxBytes !== undefined,
    };
  }
  if (!allowFreshTurn) {
    return {
      status: 'denied',
      allowed: false,
      code: 'fresh_turn_authorization_required',
      backend,
      bytes,
      threshold,
      allowLargeResume,
      allowFreshTurn,
      thresholdOverridden: opts.maxBytes !== undefined,
    };
  }
  return {
    status: 'allowed',
    allowed: true,
    replyMode: 'fresh_turn',
    backend,
    bytes,
    threshold,
    allowLargeResume,
    allowFreshTurn,
    thresholdOverridden: opts.maxBytes !== undefined,
  };
}
