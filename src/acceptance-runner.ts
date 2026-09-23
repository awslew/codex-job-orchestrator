// Acceptance runner: executes acceptance commands one at a time with a
// constrained environment and structured per-command results.
//
// The runner never throws for an individual gate: a failing / timed-out /
// un-spawnable command is recorded as a GateResult and folded into the
// summary's acceptanceStatus. Only the cwd-out-of-bounds guard rejects, and
// that rejection is recorded as a prevented gate, not a thrown error.
//
// Summary semantics: optional gates never affect acceptanceStatus. Required
// gates that actually executed and failed (exit non-zero / timeout / spawn
// error) fail the summary; required gates that could not execute because of a
// runner precondition (invalid cwd, or already-aborted signal) block it.
//
// Timeout handling uses a real per-command timer, plus an AbortSignal that
// fires once, with a guard against a race where the child exits at almost
// exactly the timeout moment.
import path from 'node:path';
import fs from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { killTree } from './proc.js';

// ---------------------------------------------------------------------------
// Types (module-local; contracts-v2 is being built in parallel and must not be
// imported yet).
// ---------------------------------------------------------------------------

export interface AcceptanceCommandLike {
  /** Unique id, used as the summary's per-command key. */
  id: string;
  /** argv[0] is the executable; the rest are its arguments. */
  argv: string[];
  /** Must resolve to a location inside the workFolder. */
  cwdRelative: string;
  /** Optional, defaults to Infinity. */
  timeoutSeconds?: number;
  /** Timeout in milliseconds; overrides timeoutSeconds when both are set.
   *  Optional, defaults to Infinity. */
  timeoutMs?: number;
  /** Optional, defaults to false. A required gate failing is a summary fail. */
  required?: boolean;
  /** Output is truncated from the tail to this many chars. Optional. */
  outputMaxChars?: number;
}

export interface GateResult {
  /** Mirror of the command's id. */
  id: string;
  /** Required mirror of the command's flag. */
  required: boolean;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number | null;
  /** True when the command was killed by the timeout (or the abort signal). */
  timedOut: boolean;
  /** 0 on success; nonzero when the process could not be spawned. */
  error?: number;
  /** Spawn error detail, e.g. ENOENT when the executable is missing. */
  errorCode?: string;
  /** Message of the spawn error, or why the gate did not run. */
  errorMessage?: string;
  /** True when the gate did not execute because of a runner precondition
   *  (cwd out-of-bounds, or an already-aborted signal). Distinguishes
   *  prevented gates from executed-and-failed gates. */
  prevented?: boolean;
  stdoutSummary: string;
  stderrSummary: string;
  /** Tail-truncated stdout, capped by outputMaxChars. */
  stdoutPreview: string;
  /** Tail-truncated stderr, capped by outputMaxChars. */
  stderrPreview: string;
}

export interface AcceptanceRunSummary {
  acceptanceStatus: 'pass' | 'fail' | 'blocked';
  startedAt: string;
  endedAt: string;
  /** One GateResult per command, keyed by command id. */
  gates: Record<string, GateResult>;
}

export interface AcceptanceContext {
  workFolder: string;
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Environment.
// ---------------------------------------------------------------------------

// Windows variants / aliases are carried over as-is (Windows resolves them
// case-insensitively; PATH is what POSIX lookups use).
const DEFAULT_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'ComSpec',
  'NODE_OPTIONS',
] as const;

/**
 * Build the environment handed to acceptance commands. When the caller
 * provides sourceEnv, its values are used; otherwise the real process
 * environment. Only allowlisted keys (plus NODE_OPTIONS, which is included
 * only when the caller explicitly provides it) are copied — the full
 * process.env is never inherited wholesale.
 */
export function buildGateEnv(
  sourceEnv: NodeJS.ProcessEnv,
  allowKeys?: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keys = allowKeys ?? DEFAULT_ENV_KEYS;
  for (const key of keys) {
    if (key === 'NODE_OPTIONS' && sourceEnv.NODE_OPTIONS === undefined) {
      continue;
    }
    const value = sourceEnv[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Output summarization.
// ---------------------------------------------------------------------------

const MAX_SUMMARY_CHARS = 2000;
const TRUNCATION_MARKER = '…[truncated]';

/** "sha256=<hex>" suffix appended to truncated summaries; the contract
 * guarantees the window holds the marker, at least one raw tail char, and
 * this suffix. For smaller legacy outputMaxChars the suffix is dropped and
 * the raw tail is kept instead — safe degradation, never an over-run. */
const SHA256_SUFFIX_PREFIX = '[sha256=';
const SHA256_SUFFIX_MIN = SHA256_SUFFIX_PREFIX.length + 64 + 1; // '[sha256=' + 64 hex + ']'

/**
 * Summarize one output stream: collapse to single lines, cap the tail at
 * summaryLimit, and mark truncation. Never throws — the summary must survive
 * even pathological output.
 *
 * Truncated summaries append the SHA-256 of the original full output as
 * [sha256=<hex>] and always end with the suffix's ']'. A summaryLimit of
 * Number.MAX_SAFE_INTEGER is the preview form: marked tail only, no hash.
 */
export function summarizeOutput(
  raw: string,
  outputMaxChars?: number,
  summaryLimit: number = MAX_SUMMARY_CHARS,
): string {
  try {
    const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const maxChars = outputMaxChars ?? summaryLimit;
    const isPreview = summaryLimit === Number.MAX_SAFE_INTEGER;
    let preview: string;
    let summary: string;
    if (normalized.length <= maxChars) {
      preview = normalized;
      summary = preview.length > summaryLimit ? preview.slice(-summaryLimit) : preview;
    } else {
      // Retain only the allowed tail chars after the marker; a negative slice
      // would re-include the whole tail when outputMaxChars < marker length.
      const tailChars = Math.max(0, maxChars - TRUNCATION_MARKER.length);
      preview = TRUNCATION_MARKER + (tailChars > 0 ? normalized.slice(-tailChars) : '');
      const window = Math.min(maxChars, summaryLimit);
      if (isPreview) {
        // Preview form: marked raw tail, no hash summary.
        summary = preview;
      } else if (window >= TRUNCATION_MARKER.length + SHA256_SUFFIX_MIN + 1) {
        const sha256 = createHash('sha256').update(normalized).digest('hex');
        const suffix = `${SHA256_SUFFIX_PREFIX}${sha256}]`;
        const tail = window - TRUNCATION_MARKER.length - suffix.length;
        summary = TRUNCATION_MARKER + normalized.slice(-tail) + suffix;
      } else {
        // Legacy small outputMaxChars: keep the marked raw tail instead.
        summary = preview.length > summaryLimit ? preview.slice(-summaryLimit) : preview;
      }
    }
    if (normalized.length === 0) {
      summary = '';
      preview = '';
    }
    return summary;
  } catch {
    return '';
  }
}

/** Single-line, capped rendering of a spawn error for the summaries. */
function spawnErrorLine(code: string | undefined, message: string): string {
  const detail = code ? `${code}: ${message}` : message;
  return detail.slice(0, 400);
}

// ---------------------------------------------------------------------------
// Runner.
// ---------------------------------------------------------------------------

/**
 * Resolve the gate's cwdRelative against the workFolder and validate it:
 * the resolved path must stay inside the workFolder and must exist as a
 * directory. Invalid resolutions return null, and the gate is prevented
 * (the same shape as the cwd-out-of-bounds guard) rather than spawned.
 */
function resolveGateCwd(
  command: AcceptanceCommandLike,
  context: AcceptanceContext,
): string | null {
  const workFolder = path.resolve(context.workFolder);
  const resolvedCwd = path.resolve(workFolder, command.cwdRelative);
  if (
    resolvedCwd !== workFolder &&
    !resolvedCwd.startsWith(workFolder + path.sep)
  ) {
    return null;
  }
  try {
    if (!fs.statSync(resolvedCwd).isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  return resolvedCwd;
}

/** Resolve the command's timeout in milliseconds; Infinity when unset. */
function timeoutMsOf(command: AcceptanceCommandLike): number {
  const ms = command.timeoutMs ?? (command.timeoutSeconds !== undefined
    ? command.timeoutSeconds * 1000
    : Infinity);
  // Defensive floor: a sub-millisecond timeout is meaningless; never raise a
  // real timeout above the caller's intent.
  return ms === Infinity ? Infinity : Math.max(1, ms);
}

/** Wrap the abort signal so onAbort fires at most once. */
function onceAbort(signal: AbortSignal, onAbort: () => void): () => void {
  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }
  const onAbortWrapper = () => {
    cleanup();
    onAbort();
  };
  const cleanup = () => {
    signal.removeEventListener('abort', onAbortWrapper);
  };
  signal.addEventListener('abort', onAbortWrapper, { once: true });
  return cleanup;
}

/**
 * Run a single acceptance command to completion and return its GateResult.
 * Never throws for gate failures, timeouts, or spawn errors. Optional gates
 * run and are recorded exactly like required ones — they simply never affect
 * the summary status.
 */
async function runGate(
  command: AcceptanceCommandLike,
  context: AcceptanceContext,
  cwd: string,
): Promise<GateResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const base: GateResult = {
    id: command.id,
    required: command.required ?? false,
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    exitCode: null,
    timedOut: false,
    stdoutSummary: '',
    stderrSummary: '',
    stdoutPreview: '',
    stderrPreview: '',
  };

  // Optional gates execute like required ones — spawn, wait, record exit /
  // timedOut / spawn error — they just never affect the summary status.
  if (context.signal?.aborted === true) {
    // Aborted before the command could start: this is a runner precondition,
    // not a command failure. Mark it prevented so the summary can distinguish
    // it from executed-and-failed required gates.
    return {
      ...base,
      error: 1,
      errorCode: 'ERR_ABORTED',
      errorMessage: 'aborted before the command could start',
      prevented: true,
      stderrSummary: 'aborted before the command could start',
      stderrPreview: 'aborted before the command could start',
    };
  }

  let stdout = '';
  let stderr = '';
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    child = spawn(command.argv[0], command.argv.slice(1), {
      cwd,
      env: buildGateEnv(process.env),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Spawn errors thrown synchronously (e.g. ENOENT) are structured, not thrown.
    return {
      ...base,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      error: 1,
      errorCode: error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
        ? (error as NodeJS.ErrnoException).code
        : undefined,
      errorMessage: error instanceof Error ? error.message : String(error),
      stdoutSummary: '',
      stderrSummary: spawnErrorLine(
        error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : undefined,
        error instanceof Error ? error.message : String(error),
      ),
    };
  }

  let timedOut = false;
  let settled = false;
  const settle = () => {
    settled = true;
  };
  const onAbort = () => {
    if (settled) {
      return;
    }
    timedOut = true;
    settle();
    try {
      if (child.pid !== undefined) {
        killTree(child.pid);
      }
    } catch {
      // best effort — the child may already be gone
    }
  };
  const cleanupAbort = onceAbort(context.signal ?? new AbortController().signal, onAbort);

  // Real per-command timer: fires at the configured millisecond timeout
  // (never raised above the caller's intent) and kills the process tree
  // immediately, without waiting for the child to exit naturally.
  const timeoutMs = timeoutMsOf(command);
  const timeoutTimer = timeoutMs === Infinity
    ? undefined
    : setTimeout(() => {
        onAbort();
      }, timeoutMs);

  try {
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (error) => {
        // Late error (e.g. spawn ENOENT arrives asynchronously): record it
        // as a structured spawn error, then close out with exit code null.
        base.error = 1;
        base.errorCode = typeof (error as NodeJS.ErrnoException).code === 'string'
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        base.errorMessage = error.message;
        if (stderr.length === 0) {
          stderr = spawnErrorLine(base.errorCode, error.message);
        }
        resolve(null);
      });
      child.on('close', (code) => {
        resolve(code);
      });
    });

    const endedAt = new Date().toISOString();
    const gate: GateResult = {
      ...base,
      endedAt,
      durationMs: Date.now() - startedMs,
      // Keep the real exit code (0 included) on success; a timed-out gate
      // reports a stable nonzero code (124) regardless of what the close
      // event delivered.
      exitCode: timedOut ? 124 : exitCode,
      timedOut,
      stdoutSummary: summarizeOutput(stdout, command.outputMaxChars),
      stderrSummary: summarizeOutput(stderr, command.outputMaxChars),
      stdoutPreview: summarizeOutput(stdout, command.outputMaxChars, Number.MAX_SAFE_INTEGER),
      stderrPreview: summarizeOutput(stderr, command.outputMaxChars, Number.MAX_SAFE_INTEGER),
    };
    return gate;
  } finally {
    if (timeoutTimer !== undefined) {
      clearTimeout(timeoutTimer);
    }
    cleanupAbort();
  }
}

/**
 * Run acceptance commands in order. Each command runs to completion (or
 * timeout) before the next starts. Returns a structured summary; never
 * throws for gate failures.
 */
export async function runAcceptanceCommands(
  commands: AcceptanceCommandLike[],
  context: AcceptanceContext,
): Promise<AcceptanceRunSummary> {
  const startedAt = new Date().toISOString();
  const gates: Record<string, GateResult> = {};

  for (const command of commands) {
    const resolvedCwd = resolveGateCwd(command, context);
    if (resolvedCwd === null) {
      const workFolder = path.resolve(context.workFolder);
      const resolvedPath = path.resolve(workFolder, command.cwdRelative);
      gates[command.id] = {
        id: command.id,
        required: command.required ?? false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 0,
        exitCode: null,
        timedOut: false,
        error: 1,
        errorCode: 'ERR_INVALID_CWD',
        errorMessage: `cwd resolves outside workFolder: ${resolvedPath}`,
        prevented: true,
        stdoutSummary: '',
        stderrSummary: `cwd resolves outside workFolder: ${resolvedPath}`,
        stdoutPreview: '',
        stderrPreview: `cwd resolves outside workFolder: ${resolvedPath}`,
      };
      continue;
    }
    gates[command.id] = await runGate(command, context, resolvedCwd);
  }

  // The summary reads each gate's required flag from the input commands it
  // was launched with — gates are stored in insertion order, so the same
  // index pairs a command with its result (preferred over reading a
  // requirement mirror off each result, which can drift out of sync).
  const gateList = Object.values(gates);
  const paired = gateList.map((gate, index) => ({
    gate,
    required: commands[index]?.required ?? false,
  }));

  // Summary status (only required gates decide):
  //   blocked:  a required gate was prevented by a runner precondition
  //             (invalid cwd, or already-aborted signal)
  //   fail:     no blocked, and a required gate executed but timed out,
  //             exited non-zero / null, or failed to spawn
  //   pass:     everything else, including all optional-gate failures
  const requiredPrevented = paired.some(({ required, gate }) => required && gate.prevented === true);
  const executedRequiredFailed = paired.some(
    ({ required, gate }) =>
      required &&
      gate.prevented !== true &&
      (gate.timedOut || gate.exitCode !== 0 || gate.error !== undefined),
  );
  const acceptanceStatus: AcceptanceRunSummary['acceptanceStatus'] = requiredPrevented
    ? 'blocked'
    : executedRequiredFailed
      ? 'fail'
      : 'pass';

  return {
    acceptanceStatus,
    startedAt,
    endedAt: new Date().toISOString(),
    gates,
  };
}
