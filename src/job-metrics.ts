// JobMetricsV2 — Wave2 per-job metrics sink (pure, side-effect free).
//
// This module is intentionally pure: no I/O, no runtime coupling, so it can be
// imported by the supervisor, deepseek worker, and any test without touching
// the scheduler/registry runtime. It aggregates the life of one job into a
// flat, JSON-serializable summary:
//
//   - lifecycle timing: supervisor start → worker start → worker end → gates
//     end (all as non-negative ms deltas from an externally supplied nowMs,
//     or null while that stage has not happened yet);
//   - tool usage from streamed JSON lines (or already-parsed objects):
//     assistant tool_use calls counted by name, Read inputs deduplicated by
//     normalized path (the paths themselves are never exposed), Bash counted
//     as a plain counter (command text never stored);
//   - token usage from the first top-level/result/message usage seen: input,
//     output, cache-read and cache-creation input tokens; only non-negative
//     finite integers are accepted, anything else keeps the field null;
//   - counters: reply depth, transcript bytes, files touched (non-negative
//     integers only), prompt chars;
//   - first-report latch: markFirstReportWrite records only the FIRST call's
//     delta; later calls are ignored.
//
// The public shape exposes timings and counts only. Nothing sensitive is kept
// or exposed: no paths, no prompts, no bash commands, no raw environment —
// internal storage keeps a normalized Read-path Set for dedup, never surfaces
// it.

import path from 'node:path';

export interface JobMetricsV2 {
  promptChars: number;
  queueMs: number | null;
  supervisorStartMs: number | null;
  workerMs: number | null;
  gateMs: number | null;
  toolUseCounts: Record<string, number>;
  uniqueReadFiles: number;
  bashCommands: number;
  transcriptBytesBefore: number;
  replyDepth: number;
  reportFirstWriteMs: number | null;
  filesTouchedCount: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
}

/** Initial metrics: all timings/tokens null, all counters 0, values safely clamped. */
export function createJobMetrics(init?: Partial<JobMetricsV2>): JobMetricsV2 {
  return {
    promptChars: clampNonNegativeInt(init?.promptChars),
    queueMs: init?.queueMs ?? null,
    supervisorStartMs: init?.supervisorStartMs ?? null,
    workerMs: init?.workerMs ?? null,
    gateMs: init?.gateMs ?? null,
    toolUseCounts: { ...(init?.toolUseCounts ?? {}) },
    uniqueReadFiles: clampNonNegativeInt(init?.uniqueReadFiles),
    bashCommands: clampNonNegativeInt(init?.bashCommands),
    transcriptBytesBefore: clampNonNegativeInt(init?.transcriptBytesBefore),
    replyDepth: clampNonNegativeInt(init?.replyDepth),
    reportFirstWriteMs: init?.reportFirstWriteMs ?? null,
    filesTouchedCount: clampNonNegativeInt(init?.filesTouchedCount),
    inputTokens: init?.inputTokens ?? null,
    outputTokens: init?.outputTokens ?? null,
    cacheReadInputTokens: init?.cacheReadInputTokens ?? null,
    cacheCreationInputTokens: init?.cacheCreationInputTokens ?? null,
  };
}

export interface JobMetricsCollector {
  markSupervisorStarted(nowMs: number): void;
  markWorkerStarted(nowMs: number): void;
  markWorkerEnded(nowMs: number): void;
  markGatesEnded(nowMs: number): void;
  observeStreamJsonLine(line: unknown): void;
  markFirstReportWrite(nowMs: number): void;
  setFilesTouchedCount(count: number): void;
  toCompactMetrics(): JobMetricsV2;
}

/** Clamp a value to a non-negative integer, NaN-safe. */
function clampNonNegativeInt(value: unknown): number {
  if (typeof value !== 'number') return 0;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Normalize a Read input path for cross-platform dedup. */
function normalizeReadPath(raw: string): string {
  let p = path.normalize(raw).replace(/\\/g, '/');
  // Windows file systems are case-insensitive; keep POSIX case-sensitive.
  if (process.platform === 'win32') p = p.toLowerCase();
  return p;
}

/**
 * Validate a caller-supplied nowMs as a finite non-negative timestamp. Used
 * for the internal life anchors (queuedAt, supervisorStartedAt, workerStartedAt,
 * workerEndedAt); a value that fails validation must not become an anchor.
 */
function validNow(nowMs: number): number | null {
  if (!Number.isFinite(nowMs) || nowMs < 0) return null;
  return nowMs;
}

export function createJobMetricsCollector(
  initial?: Partial<JobMetricsV2>,
  timing?: { queuedAtMs?: number },
): JobMetricsCollector {
  const base = createJobMetrics(initial);
  // Initial counters are clamped to non-negative integers (NaN-safe), so a
  // partially-initialized record can never poison the aggregated metrics.
  const m: JobMetricsV2 = {
    promptChars: base.promptChars,
    queueMs: base.queueMs,
    supervisorStartMs: base.supervisorStartMs,
    workerMs: base.workerMs,
    gateMs: base.gateMs,
    toolUseCounts: { ...base.toolUseCounts },
    uniqueReadFiles: base.uniqueReadFiles,
    bashCommands: base.bashCommands,
    transcriptBytesBefore: base.transcriptBytesBefore,
    replyDepth: base.replyDepth,
    reportFirstWriteMs: base.reportFirstWriteMs,
    filesTouchedCount: base.filesTouchedCount,
    inputTokens: base.inputTokens,
    outputTokens: base.outputTokens,
    cacheReadInputTokens: base.cacheReadInputTokens,
    cacheCreationInputTokens: base.cacheCreationInputTokens,
  };
  // Internal-only storage; never surfaced in the public shape.
  const readPaths = new Set<string>();
  // Life anchors for the per-stage deltas. A set anchor is never overwritten:
  // each mark accepts only the first valid time. Invalid inputs never become
  // an anchor and never overwrite a field.
  let queuedAtMs: number | null = validNow(timing?.queuedAtMs ?? NaN);
  let supervisorStartedAt: number | null = null;
  let workerStartedAt: number | null = null;
  let workerEndedAt: number | null = null;
  let reportFirstWriteSeen = false;
  // First legal lifecycle time seen, used as the fallback reference for the
  // report delta when no queuedAt exists. Report-first is a queue-relative
  // measurement when a queue time is known, otherwise first-lifecycle-relative.
  let firstLifeAnchorMs: number | null = null;

  const anchor = (at: number | null): number => {
    if (at === null) return 0;
    if (firstLifeAnchorMs === null) firstLifeAnchorMs = at;
    return at;
  };

  function recordToken(kind: 'input' | 'output' | 'cacheRead' | 'cacheCreation', value: unknown): void {
    if (typeof value !== 'number') return;
    if (!Number.isFinite(value) || value < 0) return; // bad values keep the field null
    const n = Math.floor(value);
    const field =
      kind === 'input' ? 'inputTokens' : kind === 'output' ? 'outputTokens' : kind === 'cacheRead' ? 'cacheReadInputTokens' : 'cacheCreationInputTokens';
    if (m[field] === null) m[field] = n;
  }

  return {
    markSupervisorStarted(nowMs: number): void {
      const at = validNow(nowMs);
      if (at === null || supervisorStartedAt !== null) return; // first valid time only
      supervisorStartedAt = at;
      // Supervisor start is the earliest lifecycle event; anchor it so a
      // report-first without queuedAt is measured from supervisor start.
      anchor(at);
      if (queuedAtMs !== null) m.queueMs = Math.max(0, at - queuedAtMs); // queue wait; no queuedAt ⇒ no queueMs
    },
    markWorkerStarted(nowMs: number): void {
      const at = validNow(nowMs);
      if (at === null || workerStartedAt !== null) return; // first valid time only
      workerStartedAt = at;
      // Duration since the supervisor start; without one the worker was never
      // supervised, so 0. Never accumulates total time.
      m.supervisorStartMs = supervisorStartedAt === null ? 0 : Math.max(0, at - supervisorStartedAt);
      anchor(at);
    },
    markWorkerEnded(nowMs: number): void {
      const at = validNow(nowMs);
      if (at === null || workerEndedAt !== null) return; // first valid time only
      workerEndedAt = at;
      // Duration since the worker start; without one it never ran, so 0.
      m.workerMs = workerStartedAt === null ? 0 : Math.max(0, at - workerStartedAt);
      anchor(at);
    },
    markGatesEnded(nowMs: number): void {
      const at = validNow(nowMs);
      if (at === null || m.gateMs !== null) return; // first valid time only (gateMs is the gate latch)
      // Duration since the worker ended; without one it never ended, so 0.
      m.gateMs = workerEndedAt === null ? 0 : Math.max(0, at - workerEndedAt);
    },
    observeStreamJsonLine(line: unknown): void {
      // Accepts either a single JSON line (string) or an already-parsed object;
      // unparsable strings are ignored.
      let obj: Record<string, unknown> | null = null;
      if (typeof line === 'string') {
        try {
          const parsed: unknown = JSON.parse(line);
          if (typeof parsed === 'object' && parsed !== null) obj = parsed as Record<string, unknown>;
        } catch {
          obj = null; // parse failure: ignore the line
        }
      } else if (typeof line === 'object' && line !== null) {
        obj = line as Record<string, unknown>;
      }
      if (obj === null) return;
      if (obj.type === 'assistant' && typeof obj.message === 'object' && obj.message !== null) {
        const message = obj.message as Record<string, unknown>;
        if (Array.isArray(message.content)) {
          for (const item of message.content) {
            if (typeof item !== 'object' || item === null) continue;
            const it = item as Record<string, unknown>;
            if (it.type !== 'tool_use') continue;
            const name = typeof it.name === 'string' ? it.name : null;
            if (name === null || name === '') continue;
            m.toolUseCounts[name] = (m.toolUseCounts[name] ?? 0) + 1;
            if (name === 'Bash') m.bashCommands += 1;
            if (name === 'Read' && typeof it.input === 'object' && it.input !== null) {
              const input = it.input as Record<string, unknown>;
              const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
              if (raw !== null && raw !== '') {
                readPaths.add(normalizeReadPath(raw));
                m.uniqueReadFiles = readPaths.size;
              }
            }
          }
        }
      }
      if (obj.type === 'result') {
        // Usage may live at the top level, inside the result (when the result
        // is an object), or on the message; the result does not have to be an
        // object. First valid object wins.
        const topUsage = obj.usage && typeof obj.usage === 'object' ? (obj.usage as Record<string, unknown>) : undefined;
        const resultUsage =
          obj.result && typeof obj.result === 'object'
            ? (obj.result as Record<string, unknown>).usage && typeof (obj.result as Record<string, unknown>).usage === 'object'
              ? ((obj.result as Record<string, unknown>).usage as Record<string, unknown>)
              : undefined
            : undefined;
        const messageUsage =
          obj.message && typeof obj.message === 'object'
            ? (obj.message as Record<string, unknown>).usage && typeof (obj.message as Record<string, unknown>).usage === 'object'
              ? ((obj.message as Record<string, unknown>).usage as Record<string, unknown>)
              : undefined
            : undefined;
        const usage = topUsage ?? resultUsage ?? messageUsage;
        if (usage && typeof usage === 'object') {
          recordToken('input', usage.input_tokens);
          recordToken('output', usage.output_tokens);
          recordToken('cacheRead', usage.cache_read_input_tokens);
          recordToken('cacheCreation', usage.cache_creation_input_tokens);
        }
      }
    },
    markFirstReportWrite(nowMs: number): void {
      const at = validNow(nowMs);
      if (at === null || reportFirstWriteSeen) return; // first valid call only
      reportFirstWriteSeen = true;
      // Relative to queue time when one is known, otherwise to the first
      // legal lifecycle time; never negative.
      m.reportFirstWriteMs = queuedAtMs !== null ? Math.max(0, at - queuedAtMs) : firstLifeAnchorMs === null ? 0 : Math.max(0, at - firstLifeAnchorMs);
    },
    setFilesTouchedCount(count: number): void {
      // Non-negative integers only; any other value leaves the counter as-is.
      if (Number.isFinite(count) && count >= 0) m.filesTouchedCount = clampNonNegativeInt(count);
    },
    toCompactMetrics(): JobMetricsV2 {
      return { ...m, toolUseCounts: { ...m.toolUseCounts } };
    },
  };
}
