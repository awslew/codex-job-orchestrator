// Pure unit tests for the budget enforcement module (T2A1): spec resolution,
// per-call decisions across all modes and limits, unique-read dedup, the
// fail/report_partial strategies, the wall-clock window, and the evidence
// skeleton. No I/O, no runtime coupling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  createBudgetState,
  normalizeBudgetSpec,
  evaluateBudgetToolCall,
  buildEvidenceReportSkeleton,
  type BudgetState,
  type ResolvedBudget,
} from '../src/budget.js';
import type { BudgetSpec } from '../src/contracts-v2.js';

const MINUTE = 60_000;

function resolved(spec: Partial<BudgetSpec> & { maxRuntimeMinutes: number }): ResolvedBudget {
  return normalizeBudgetSpec(spec as BudgetSpec);
}

function active(startedAtMs: number, partial: Partial<BudgetState> = {}): BudgetState {
  return { ...createBudgetState(startedAtMs), ...partial };
}

/** Same canonicalization the module applies: path.resolve, then Windows-style lowercase. */
function canonical(p: string): string {
  const r = path.resolve(p);
  return /^[A-Za-z]:[\\/]/.test(r) || r.includes('\\') ? r.toLowerCase() : r;
}

// ---------------------------------------------------------------------------
// Resolution.
// ---------------------------------------------------------------------------

test('normalizeBudgetSpec fills omitted fields with the legacy defaults', () => {
  const r = resolved({ maxRuntimeMinutes: 120 });
  assert.equal(r.maxRuntimeMinutes, 120);
  assert.equal(r.reportOnlyAfterMinutes, 120);
  assert.equal(r.maxFilesRead, 200);
  assert.equal(r.maxSourceLines, 50000);
  assert.equal(r.maxToolCalls, 500);
  assert.equal(r.maxBashCommands, 100);
  assert.equal(r.explorationMinutes, 15);
  assert.equal(r.maxTranscriptBytes, 4194304);
  assert.equal(r.onExceeded, 'report_partial');
});

test('normalizeBudgetSpec clamps explorationMinutes and reportOnlyAfterMinutes to maxRuntimeMinutes', () => {
  const r = resolved({ maxRuntimeMinutes: 5, reportOnlyAfterMinutes: 30, explorationMinutes: 60 });
  assert.equal(r.reportOnlyAfterMinutes, 5);
  assert.equal(r.explorationMinutes, 5);
});

test('createBudgetState starts active with zeroed counters and an empty read set', () => {
  const s = createBudgetState(1000);
  assert.equal(s.startedAtMs, 1000);
  assert.equal(s.lastUpdatedAtMs, 1000);
  assert.equal(s.mode, 'active');
  assert.equal(s.toolCalls, 0);
  assert.equal(s.bashCommands, 0);
  assert.equal(s.sourceLines, 0);
  assert.deepEqual(s.uniqueReadFiles, []);
  assert.equal('violationCode' in s, false);
});

// ---------------------------------------------------------------------------
// Active mode: allowances and counting.
// ---------------------------------------------------------------------------

test('in-budget calls are allowed and advance the counters', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 2, maxBashCommands: 1, maxSourceLines: 10, maxFilesRead: 2 });
  let s = active(0);
  let d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 3, nowMs: 100 }, b);
  assert.equal(d.allow, true);
  assert.equal(d.code, 'ok');
  assert.equal(d.mode, 'active');
  assert.deepEqual(d.nextState.uniqueReadFiles, [canonical(path.resolve('/a.ts'))]);
  assert.equal(d.nextState.sourceLines, 3);
  assert.equal(d.nextState.toolCalls, 1);
  assert.equal(d.nextState.lastUpdatedAtMs, 100);
  assert.equal('violationCode' in d.nextState, false);

  s = d.nextState;
  d = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 200 }, b);
  assert.equal(d.allow, true);
  assert.equal(d.code, 'ok');
  assert.equal(d.nextState.toolCalls, 2);
  assert.equal(d.nextState.bashCommands, 1);
});

// ---------------------------------------------------------------------------
// Unique read tracking (canonical, case-normalized, sorted, deduped).
// ---------------------------------------------------------------------------

test('unique reads dedup by canonical path: case variants, separators, dot segments, duplicate calls', () => {
  const b = resolved({ maxRuntimeMinutes: 60, maxFilesRead: 10, maxSourceLines: 100 });
  let s = active(0);
  const cwd = process.cwd();
  const canonical = (p: string): string => {
    const r = path.resolve(p);
    return /^[A-Za-z]:[\\/]/.test(r) || r.includes('\\') ? r.toLowerCase() : r;
  };

  // Same file twice (identical path).
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: path.join(cwd, 'src', 'a.ts'), sourceLines: 1, nowMs: 100 }, b).nextState;
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: path.join(cwd, 'src', 'a.ts'), sourceLines: 1, nowMs: 200 }, b).nextState;
  assert.equal(s.uniqueReadFiles.length, 1);

  // Same file via a dot segment.
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: path.join(cwd, 'src', '.', 'a.ts'), sourceLines: 1, nowMs: 300 }, b).nextState;
  assert.equal(s.uniqueReadFiles.length, 1);

  let distinctInputs: string[];
  if (process.platform === 'win32') {
    // Windows: drive-letter case variants collapse to one canonical entry.
    s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: 'C:\\Src\\A.TS', sourceLines: 1, nowMs: 400 }, b).nextState;
    s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: 'c:/src/a.ts', sourceLines: 1, nowMs: 500 }, b).nextState;
    assert.equal(s.uniqueReadFiles.length, 2);
    distinctInputs = ['C:\\Src\\A.TS', 'c:/src/a.ts'];
  } else {
    // POSIX: paths stay case-sensitive.
    s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/SRC/A.TS', sourceLines: 1, nowMs: 400 }, b).nextState;
    s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/src/a.ts', sourceLines: 1, nowMs: 500 }, b).nextState;
    assert.equal(s.uniqueReadFiles.length, 2);
    distinctInputs = ['/SRC/A.TS', '/src/a.ts'];
  }

  // Two more distinct files; the read set stays sorted and duplicate-free.
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: path.join(cwd, 'z.ts'), sourceLines: 1, nowMs: 600 }, b).nextState;
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: path.join(cwd, 'b.ts'), sourceLines: 1, nowMs: 700 }, b).nextState;
  // Contains exactly the canonical forms of all distinct inputs, in any order.
  for (const p of [path.join(cwd, 'src', 'a.ts'), ...distinctInputs, path.join(cwd, 'z.ts'), path.join(cwd, 'b.ts')]) {
    assert.equal(s.uniqueReadFiles.includes(canonical(p)), true);
  }
  assert.equal(s.uniqueReadFiles.length, 4);
  assert.equal(new Set(s.uniqueReadFiles).size, s.uniqueReadFiles.length);
});

test('reads without a filePath never add unique files', () => {
  const b = resolved({ maxRuntimeMinutes: 60, maxFilesRead: 5 });
  const s = evaluateBudgetToolCall(
    createBudgetState(0),
    { toolName: 'Read', sourceLines: 5, nowMs: 100 },
    b,
  ).nextState;
  assert.deepEqual(s.uniqueReadFiles, []);
  assert.equal(s.sourceLines, 5);
});

test('non-Read tools never add unique files', () => {
  const b = resolved({ maxRuntimeMinutes: 60, maxFilesRead: 5 });
  let s = createBudgetState(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Bash', filePath: '/whatever', nowMs: 100 }, b).nextState;
  s = evaluateBudgetToolCall(s, { toolName: 'Write', filePath: '/out.md', nowMs: 200 }, b).nextState;
  assert.deepEqual(s.uniqueReadFiles, []);
});

// ---------------------------------------------------------------------------
// Source-line cap.
// ---------------------------------------------------------------------------

test('crossing the source-lines cap flips to report_only and denies the call', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxSourceLines: 10 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 6, nowMs: 100 }, b).nextState;
  assert.equal(s.mode, 'active');

  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 5, nowMs: 200 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.mode, 'report_only');
  assert.equal(d.code, 'budget_exceeded_report_only');
  assert.equal(d.nextState.mode, 'report_only');
  assert.equal(d.nextState.violationCode, 'source_lines_exceeded');
  // The denied call did not run: counters stay as they were.
  assert.equal(d.nextState.sourceLines, 6);
  assert.equal(d.nextState.toolCalls, 1);
});

// ---------------------------------------------------------------------------
// Tool-call cap and the second over-budget bash rejection.
// ---------------------------------------------------------------------------

test('the second over-budget Bash call is denied (first crossing flips the mode)', () => {
  const b = resolved({
    maxRuntimeMinutes: 60,
    reportOnlyAfterMinutes: 60,
    maxBashCommands: 1,
    maxToolCalls: 20,
    maxSourceLines: 100,
    maxFilesRead: 20,
  });
  let s = active(0);

  // Bash #1: within the cap.
  s = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 100 }, b).nextState;
  assert.equal(s.mode, 'active');
  assert.equal(s.bashCommands, 1);

  // Bash #2 would cross the cap: denied, mode flips to report_only.
  let d = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 200 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.mode, 'report_only');
  assert.equal(d.code, 'budget_exceeded_report_only');
  assert.equal(d.nextState.violationCode, 'bash_commands_exceeded');

  // Bash #3 in report_only: denied again, still report_only, counters unchanged.
  s = d.nextState;
  d = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 300 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.code, 'denied_report_only');
  assert.equal(d.mode, 'report_only');
  assert.equal(d.nextState.bashCommands, 1);
  assert.equal(d.nextState.toolCalls, 1);
});

test('crossing the tool-call cap is denied with tool_calls_exceeded', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 100 }, b).nextState;
  assert.equal(s.mode, 'active');

  const d = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 200 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.mode, 'report_only');
  assert.equal(d.nextState.violationCode, 'tool_calls_exceeded');
});

test('crossing the files-read cap is denied with files_read_exceeded', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxFilesRead: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;

  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: 200 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.code, 'budget_exceeded_report_only');
  assert.equal(d.nextState.mode, 'report_only');
  assert.equal(d.nextState.violationCode, 'files_read_exceeded');
});

// ---------------------------------------------------------------------------
// Report writes never consume tool calls.
// ---------------------------------------------------------------------------

test('report writes do not consume tool calls while active', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;

  const d = evaluateBudgetToolCall(
    s,
    { toolName: 'Write', filePath: '/out/report.md', isReportWrite: true, nowMs: 200 },
    b,
  );
  assert.equal(d.allow, true);
  assert.equal(d.code, 'ok');
  assert.equal(d.mode, 'active');
  // The report write adds no count; the earlier Read still leaves toolCalls at 1.
  assert.equal(d.nextState.toolCalls, 1);
});

// ---------------------------------------------------------------------------
// report_only mode.
// ---------------------------------------------------------------------------

test('report_only denies Read and Bash, allows report writes', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 5, maxBashCommands: 5 });
  const s = active(0, { mode: 'report_only' });

  for (const ev of [
    { toolName: 'Read' as const, filePath: '/a.ts', sourceLines: 1, nowMs: 100 },
    { toolName: 'Bash' as const, nowMs: 200 },
    { toolName: 'Write' as const, filePath: '/other.md', nowMs: 300 },
  ]) {
    const d = evaluateBudgetToolCall(s, ev, b);
    assert.equal(d.allow, false, ev.toolName);
    assert.equal(d.code, 'denied_report_only', ev.toolName);
    assert.equal(d.mode, 'report_only', ev.toolName);
    assert.equal(d.nextState.toolCalls, 0, ev.toolName);
    assert.equal(d.nextState.bashCommands, 0, ev.toolName);
    assert.deepEqual(d.nextState.uniqueReadFiles, [], ev.toolName);
  }

  const d = evaluateBudgetToolCall(s, { toolName: 'Write', filePath: '/out/report.md', isReportWrite: true, nowMs: 400 }, b);
  assert.equal(d.allow, true);
  assert.equal(d.code, 'report_write_allowed');
  assert.equal(d.mode, 'report_only');
  // Report writes do not consume tool calls in report_only either.
  assert.equal(d.nextState.toolCalls, 0);
});

// ---------------------------------------------------------------------------
// fail strategy.
// ---------------------------------------------------------------------------

test('onExceeded=fail flips to failed and denies the crossing call', () => {
  // Cap 1 allows the first call; the second call crosses the cap and fails.
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 1, onExceeded: 'fail' });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;

  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: 200 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.mode, 'failed');
  assert.equal(d.code, 'budget_exceeded_failed');
  assert.equal(d.nextState.mode, 'failed');
  assert.equal(d.nextState.violationCode, 'tool_calls_exceeded');
});

test('failed mode denies every call, including report writes', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxToolCalls: 1, onExceeded: 'fail' });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;
  const failed = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: 200 }, b).nextState;
  assert.equal(failed.mode, 'failed');

  for (const ev of [
    { toolName: 'Bash' as const, nowMs: 300 },
    { toolName: 'Read' as const, filePath: '/c.ts', sourceLines: 1, nowMs: 400 },
    { toolName: 'Write' as const, filePath: '/out/report.md', isReportWrite: true, nowMs: 500 },
  ]) {
    const d = evaluateBudgetToolCall(failed, ev, b);
    assert.equal(d.allow, false, ev.toolName);
    assert.equal(d.code, 'denied_failed', ev.toolName);
    assert.equal(d.mode, 'failed', ev.toolName);
    assert.equal(d.nextState.mode, 'failed', ev.toolName);
  }
});

// ---------------------------------------------------------------------------
// Wall clock: report-only window.
// ---------------------------------------------------------------------------

test('a call at the report-only window flips to report_only with report_only_window', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;
  assert.equal(s.mode, 'active');

  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: MINUTE }, b);
  assert.equal(d.allow, false);
  assert.equal(d.mode, 'report_only');
  assert.equal(d.code, 'report_only_window');
  assert.equal(d.nextState.violationCode, 'report_only_window');
});

test('a report write at the window flips to report_only and is allowed', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;
  assert.equal(s.mode, 'active');

  const d = evaluateBudgetToolCall(s, { toolName: 'Write', filePath: '/out/report.md', isReportWrite: true, nowMs: MINUTE }, b);
  assert.equal(d.allow, true);
  assert.equal(d.mode, 'report_only');
  assert.equal(d.code, 'report_write_allowed');
  assert.equal(d.nextState.mode, 'report_only');
  assert.equal(d.nextState.violationCode, 'report_only_window');
  // The report write adds no count; the earlier Read still leaves toolCalls at 1.
  assert.equal(d.nextState.toolCalls, 1);
});

test('report_only mode ignores the wall clock entirely', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 1 });
  const s = active(0, { mode: 'report_only' });
  // Far beyond the window: non-report calls stay denied, report writes allowed.
  const d1 = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 10 * MINUTE }, b);
  assert.equal(d1.allow, false);
  assert.equal(d1.code, 'denied_report_only');
  const d2 = evaluateBudgetToolCall(s, { toolName: 'Write', filePath: '/out/report.md', isReportWrite: true, nowMs: 10 * MINUTE }, b);
  assert.equal(d2.allow, true);
  assert.equal(d2.code, 'report_write_allowed');
});

test('failed mode ignores the wall clock entirely', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 1, maxToolCalls: 1, onExceeded: 'fail' });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;
  const failed = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: 200 }, b).nextState;
  assert.equal(failed.mode, 'failed');
  const d = evaluateBudgetToolCall(failed, { toolName: 'Write', filePath: '/out/report.md', isReportWrite: true, nowMs: 2 * MINUTE }, b);
  assert.equal(d.allow, false);
  assert.equal(d.code, 'denied_failed');
});

// ---------------------------------------------------------------------------
// Violation precedence and no-op safeguards.
// ---------------------------------------------------------------------------

test('when several caps trip together, the tool-call code wins', () => {
  const b = resolved({
    maxRuntimeMinutes: 60,
    reportOnlyAfterMinutes: 60,
    maxToolCalls: 2,
    maxBashCommands: 1,
    maxSourceLines: 5,
    maxFilesRead: 1,
  });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 5, nowMs: 100 }, b).nextState;
  s = evaluateBudgetToolCall(s, { toolName: 'Bash', nowMs: 200 }, b).nextState;
  assert.equal(s.mode, 'active');

  // This single call would cross tool, bash, source and file caps at once.
  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/b.ts', sourceLines: 1, nowMs: 300 }, b);
  assert.equal(d.allow, false);
  assert.equal(d.nextState.violationCode, 'tool_calls_exceeded');
});

test('a duplicate read cannot cross the files-read cap', () => {
  const b = resolved({ maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60, maxFilesRead: 1 });
  let s = active(0);
  s = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 100 }, b).nextState;
  const d = evaluateBudgetToolCall(s, { toolName: 'Read', filePath: '/a.ts', sourceLines: 1, nowMs: 200 }, b);
  assert.equal(d.allow, true);
  assert.equal(d.code, 'ok');
  assert.equal(d.nextState.uniqueReadFiles.length, 1);
});

// ---------------------------------------------------------------------------
// Evidence report skeleton.
// ---------------------------------------------------------------------------

test('buildEvidenceReportSkeleton renders the v1 front matter with a placeholder body', () => {
  const md = buildEvidenceReportSkeleton('job-abc-123', '2026-08-30T09:00:00.000Z');
  const lines = md.split('\n');
  assert.equal(lines[0], '---');
  assert.ok(lines.includes('schema: evidence-report-v1'));
  assert.ok(lines.includes('jobId: job-abc-123'));
  assert.ok(lines.includes('completeness: skeleton'));
  assert.ok(lines.includes('evidenceCount: 0'));
  assert.ok(lines.includes('startedAt: 2026-08-30T09:00:00.000Z'));
  assert.ok(lines.includes('lastUpdatedAt: 2026-08-30T09:00:00.000Z'));
  assert.equal(lines[lines.indexOf('---', 1) + 1], '');
  assert.ok(lines.join('\n').includes('# Evidence Report'));
  // Placeholder body, no sensitive content: no prompt or environment text.
  const body = md.slice(md.indexOf('\n---', 1) + 4);
  assert.ok(body.includes('placeholder'), 'body must be an explicit placeholder');
  assert.equal(body.includes('prompt'), false);
  assert.equal(body.includes('env'), false);
  assert.equal(body.includes('ANTHROPIC'), false);
  assert.equal(body.includes('TOKEN'), false);
  assert.equal(body.includes('SECRET'), false);
});
