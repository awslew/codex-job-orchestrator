// Budget enforcement — pure budget model and per-call decisions (T2A1).
//
// This module is intentionally pure: no I/O, no runtime coupling, so the
// scheduler can import it without side effects. It owns the runtime semantics
// of the v2 BudgetSpec:
//
//   - normalizeBudgetSpec(spec)      resolves a BudgetSpec into concrete
//     limits. Omitted fields fall back to the same legacy values
//     buildLegacyContract uses (200 / 50000 / 500 / 100 / 15 / 4194304 /
//     report_partial); explorationMinutes and reportOnlyAfterMinutes are
//     clamped to maxRuntimeMinutes.
//   - createBudgetState(startedAtMs) starts a job in active mode with zeroed
//     counters; only timestamps and counters are stored, never command text
//     or file contents.
//   - evaluateBudgetToolCall(...)    decides one tool call against the current
//     state and returns the verdict plus the state that applies afterwards.
//   - buildEvidenceReportSkeleton()  renders the evidence-report front matter
//     (schema evidence-report-v1) with an explicit placeholder body; it never
//     embeds prompt or environment text.
//
// Modes are one-way: active -> report_only | failed. In report_only mode only
// report-target Write/Edit calls pass; in failed mode every call is denied.
// Report-target Write/Edit calls never consume tool calls. Tool names are
// matched exactly ('Read', 'Bash', 'Write', 'Edit'); the scheduler is
// responsible for sending canonical names and for setting isReportWrite only
// on Write/Edit calls that target the job's report deliverable.
//
// When several caps trip on the same call, violationCode names the first in
// this order: toolCalls, bashCommands, sourceLines, filesRead, then the
// report-only window.

import path from 'node:path';
import type { BudgetSpec } from './contracts-v2.js';

export type BudgetMode = 'active' | 'report_only' | 'failed';

export interface ResolvedBudget {
  /** Positive integer minutes the job may run before it is force-stopped. */
  maxRuntimeMinutes: number;
  /** Minutes after which only report writes pass; clamped to maxRuntimeMinutes. */
  reportOnlyAfterMinutes: number;
  /** Cap on distinct files read. */
  maxFilesRead: number;
  /** Cap on source lines read. */
  maxSourceLines: number;
  /** Cap on agent tool calls. */
  maxToolCalls: number;
  /** Cap on bash commands run. */
  maxBashCommands: number;
  /** Informational exploration minutes; clamped to maxRuntimeMinutes. */
  explorationMinutes: number;
  /** Cap on transcript bytes captured. */
  maxTranscriptBytes: number;
  /** Behavior when a limit is crossed while active. */
  onExceeded: 'report_partial' | 'fail';
}

export type BudgetViolationCode =
  | 'tool_calls_exceeded'
  | 'bash_commands_exceeded'
  | 'source_lines_exceeded'
  | 'files_read_exceeded'
  | 'report_only_window';

export interface BudgetState {
  startedAtMs: number;
  lastUpdatedAtMs: number;
  mode: BudgetMode;
  toolCalls: number;
  bashCommands: number;
  sourceLines: number;
  /** Canonical (resolved, Windows-case-normalized) distinct read paths, sorted. */
  uniqueReadFiles: string[];
  /** Set when a call leaves active mode; identifies the trigger. */
  violationCode?: BudgetViolationCode;
}

export interface BudgetToolEvent {
  /** Canonical tool name; matched exactly ('Read', 'Bash', 'Write', 'Edit', ...). */
  toolName: string;
  /** For Read: path of the file being read; counted once per distinct canonical path. */
  filePath?: string;
  /** For Read: number of source lines read by this call. */
  sourceLines?: number;
  /** True when this Write/Edit targets the job's report deliverable. */
  isReportWrite?: boolean;
  /** Epoch-ms timestamp of the call; drives the report-only window. */
  nowMs: number;
}

export type BudgetDecisionCode =
  | 'ok'
  | 'report_write_allowed'
  | 'denied_report_only'
  | 'denied_failed'
  | 'report_only_window'
  | 'budget_exceeded_report_only'
  | 'budget_exceeded_failed';

export interface BudgetDecision {
  /** Whether the call may proceed. */
  allow: boolean;
  /** The budget mode that applies after this decision (equals nextState.mode). */
  mode: BudgetMode;
  /** Fixed short code describing the verdict. */
  code: BudgetDecisionCode;
  /** Fixed short human text describing the verdict. */
  reason: string;
  /** The full budget state that applies after this decision. */
  nextState: BudgetState;
}

// ---------------------------------------------------------------------------
// Resolution and construction.
// ---------------------------------------------------------------------------

/**
 * Resolves a BudgetSpec into concrete limits. Omitted fields fall back to the
 * legacy defaults (matching buildLegacyContract in contracts-v2.ts);
 * explorationMinutes and reportOnlyAfterMinutes are clamped to
 * maxRuntimeMinutes.
 */
export function normalizeBudgetSpec(spec: BudgetSpec): ResolvedBudget {
  return {
    maxRuntimeMinutes: spec.maxRuntimeMinutes,
    reportOnlyAfterMinutes: Math.min(
      spec.reportOnlyAfterMinutes ?? spec.maxRuntimeMinutes,
      spec.maxRuntimeMinutes,
    ),
    maxFilesRead: spec.maxFilesRead ?? 200,
    maxSourceLines: spec.maxSourceLines ?? 50000,
    maxToolCalls: spec.maxToolCalls ?? 500,
    maxBashCommands: spec.maxBashCommands ?? 100,
    explorationMinutes: Math.min(spec.explorationMinutes ?? 15, spec.maxRuntimeMinutes),
    maxTranscriptBytes: spec.maxTranscriptBytes ?? 4194304,
    onExceeded: spec.onExceeded ?? 'report_partial',
  };
}

/** Starts a job in active mode with zeroed counters. */
export function createBudgetState(startedAtMs: number): BudgetState {
  return {
    startedAtMs,
    lastUpdatedAtMs: startedAtMs,
    mode: 'active',
    toolCalls: 0,
    bashCommands: 0,
    sourceLines: 0,
    uniqueReadFiles: [],
  };
}

// ---------------------------------------------------------------------------
// Evaluation.
// ---------------------------------------------------------------------------

/** path.resolve plus Windows-style case normalization (drive/backslash => lowercase). */
function canonicalReadPath(p: string): string {
  const resolved = path.resolve(p);
  return /^[A-Za-z]:[\\/]/.test(resolved) || resolved.includes('\\') ? resolved.toLowerCase() : resolved;
}

function addUniqueReadFile(files: string[], toolName: string, filePath: string | undefined): string[] {
  if (toolName !== 'Read' || filePath === undefined || filePath === '') return files;
  const canonical = canonicalReadPath(filePath);
  if (files.includes(canonical)) return files;
  const next = [...files, canonical];
  next.sort();
  return next;
}

function isReportWrite(event: BudgetToolEvent): boolean {
  return event.isReportWrite === true && (event.toolName === 'Write' || event.toolName === 'Edit');
}

function violationCodeOf(
  over: { toolCalls: boolean; bashCommands: boolean; sourceLines: boolean; filesRead: boolean },
  windowReached: boolean,
): BudgetViolationCode {
  if (over.toolCalls) return 'tool_calls_exceeded';
  if (over.bashCommands) return 'bash_commands_exceeded';
  if (over.sourceLines) return 'source_lines_exceeded';
  if (over.filesRead) return 'files_read_exceeded';
  return 'report_only_window';
}

/**
 * Decides one tool call against the current state. In active mode the counts
 * this call would produce are checked against the caps and the report-only
 * window; a call that crosses a limit never runs, so a denied call leaves the
 * counters untouched. See the module header for the mode and tool-name rules.
 */
export function evaluateBudgetToolCall(
  state: BudgetState,
  event: BudgetToolEvent,
  budget: ResolvedBudget,
): BudgetDecision {
  const reportWrite = isReportWrite(event);

  if (state.mode === 'failed') {
    return {
      allow: false,
      mode: 'failed',
      code: 'denied_failed',
      reason: 'budget failed: all calls denied',
      nextState: { ...state, lastUpdatedAtMs: event.nowMs },
    };
  }

  if (state.mode === 'report_only') {
    if (reportWrite) {
      return {
        allow: true,
        mode: 'report_only',
        code: 'report_write_allowed',
        reason: 'report write allowed',
        nextState: { ...state, lastUpdatedAtMs: event.nowMs },
      };
    }
    return {
      allow: false,
      mode: 'report_only',
      code: 'denied_report_only',
      reason: 'report_only mode: only report writes allowed',
      nextState: { ...state, lastUpdatedAtMs: event.nowMs },
    };
  }

  // active mode: evaluate the counts this call would produce.
  const toolCalls = state.toolCalls + (reportWrite ? 0 : 1);
  const bashCommands = state.bashCommands + (event.toolName === 'Bash' ? 1 : 0);
  const sourceLines = state.sourceLines + (reportWrite ? 0 : (event.sourceLines ?? 0));
  const uniqueReadFiles = reportWrite
    ? state.uniqueReadFiles
    : addUniqueReadFile(state.uniqueReadFiles, event.toolName, event.filePath);
  const windowReached = event.nowMs - state.startedAtMs >= budget.reportOnlyAfterMinutes * 60_000;

  const over = {
    toolCalls: toolCalls > budget.maxToolCalls,
    bashCommands: bashCommands > budget.maxBashCommands,
    sourceLines: sourceLines > budget.maxSourceLines,
    filesRead: uniqueReadFiles.length > budget.maxFilesRead,
  };
  const exceeded = over.toolCalls || over.bashCommands || over.sourceLines || over.filesRead;

  if (!exceeded && !windowReached) {
    return {
      allow: true,
      mode: 'active',
      code: 'ok',
      reason: 'within budget',
      nextState: {
        ...state,
        lastUpdatedAtMs: event.nowMs,
        toolCalls,
        bashCommands,
        sourceLines,
        uniqueReadFiles,
      },
    };
  }

  if (budget.onExceeded === 'fail') {
    return {
      allow: false,
      mode: 'failed',
      code: 'budget_exceeded_failed',
      reason: 'budget limit exceeded: job failed',
      nextState: {
        ...state,
        lastUpdatedAtMs: event.nowMs,
        mode: 'failed',
        violationCode: violationCodeOf(over, windowReached),
      },
    };
  }

  // report_partial: switch to report_only; only a report write passes the
  // call that crossed the line.
  const next: BudgetState = {
    ...state,
    lastUpdatedAtMs: event.nowMs,
    mode: 'report_only',
    violationCode: violationCodeOf(over, windowReached),
  };
  if (reportWrite) {
    return { allow: true, mode: 'report_only', code: 'report_write_allowed', reason: 'report write allowed', nextState: next };
  }
  return {
    allow: false,
    mode: 'report_only',
    code: exceeded ? 'budget_exceeded_report_only' : 'report_only_window',
    reason: exceeded ? 'budget limit exceeded: switched to report_only' : 'report-only window reached',
    nextState: next,
  };
}

// ---------------------------------------------------------------------------
// Evidence report skeleton.
// ---------------------------------------------------------------------------

/**
 * Renders the evidence-report skeleton for a job: YAML front matter (schema
 * evidence-report-v1) with a placeholder body. Never embeds prompt or
 * environment content.
 */
export function buildEvidenceReportSkeleton(jobId: string, startedAtIso: string): string {
  return [
    '---',
    'schema: evidence-report-v1',
    `jobId: ${jobId}`,
    'completeness: skeleton',
    'evidenceCount: 0',
    `startedAt: ${startedAtIso}`,
    `lastUpdatedAt: ${startedAtIso}`,
    '---',
    '',
    '# Evidence Report',
    '',
    'This is a placeholder skeleton: no evidence entries have been recorded yet.',
    '',
    '<!-- TODO: append evidence entries as the job runs. -->',
    '',
  ].join('\n');
}
