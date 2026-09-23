// JobMetricsV2 tests — pure module, no env mutation, no process spawning.
//
// Covers the Wave2 contract: lifecycle timing as stage durations measured
// mark-to-mark (queue wait, supervisor → worker, worker runtime, worker →
// gates), tool-use counting (Read paths deduplicated and never exposed, Bash counted
// without its command), usage-token capture (non-negative finite integers
// only, bad values keep null), first-report latch, non-negative counter
// clamping, and the guarantee that the public shape leaks no sensitive data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobMetrics,
  createJobMetricsCollector,
  type JobMetricsV2,
} from '../src/job-metrics.js';

const PUBLIC_FIELDS = [
  'promptChars',
  'queueMs',
  'supervisorStartMs',
  'workerMs',
  'gateMs',
  'toolUseCounts',
  'uniqueReadFiles',
  'bashCommands',
  'transcriptBytesBefore',
  'replyDepth',
  'reportFirstWriteMs',
  'filesTouchedCount',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
] as const;

function fresh(initial?: Partial<JobMetricsV2>, timing?: { queuedAtMs?: number }) {
  return createJobMetricsCollector(initial ? { ...createJobMetrics(), ...initial } : createJobMetrics(), timing);
}

function observeAll(c: ReturnType<typeof createJobMetricsCollector>, lines: unknown[]) {
  for (const line of lines) c.observeStreamJsonLine(line);
}

// ── lifecycle timing ────────────────────────────────────────────────────────

test('createJobMetrics initializes every counter to 0 and every time/token to null', () => {
  const m = createJobMetrics();
  const fields = PUBLIC_FIELDS;
  for (const f of fields) {
    const v = (m as unknown as Record<string, unknown>)[f];
    if (f === 'toolUseCounts') assert.deepEqual(v, {}, `${f} is an empty object`);
    else if (typeof v === 'number') assert.equal(v, 0, `${f} starts at 0`);
    else assert.equal(v, null, `${f} starts null`);
  }
});

test('lifecycle timings are stage durations between marks, anchored on queuedAtMs when given', () => {
  const c = fresh({}, { queuedAtMs: 500 });
  c.markSupervisorStarted(1_000);
  c.markWorkerStarted(3_500);
  c.markWorkerEnded(5_000);
  c.markGatesEnded(6_200);
  const m = c.toCompactMetrics();
  assert.equal(m.queueMs, 500); // supervisor (1_000) − queued (500)
  assert.equal(m.supervisorStartMs, 2_500); // worker start (3_500) − supervisor (1_000)
  assert.equal(m.workerMs, 1_500); // worker end (5_000) − worker start (3_500)
  assert.equal(m.gateMs, 1_200); // gates (6_200) − worker end (5_000)
});

test('timings that arrive before an earlier stage clamp to 0 instead of going negative', () => {
  const c = fresh();
  c.markSupervisorStarted(10_000);
  c.markWorkerStarted(2_000); // clock skew / out-of-order event
  c.markWorkerEnded(3_000);
  const m = c.toCompactMetrics();
  assert.equal(m.supervisorStartMs, 0); // worker start before supervisor start
  assert.equal(m.workerMs, 1_000); // 3_000 − 2_000; stage durations stay positive
});

test('non-finite or negative nowMs never poisons a timing', () => {
  const c = fresh();
  c.markSupervisorStarted(Number.NaN);
  c.markWorkerStarted(-5);
  c.markWorkerEnded(8_000);
  c.markGatesEnded(Number.POSITIVE_INFINITY);
  const m = c.toCompactMetrics();
  // Invalid marks never become anchors: NaN and -5 are ignored, so the
  // supervisor → worker stage is never measured and stays null.
  assert.equal(m.supervisorStartMs, null);
  assert.equal(m.workerMs, 0); // worker end (8_000) without a worker start is 0
  assert.equal(m.gateMs, null); // Infinity is ignored, so gates never end
});

test('workerMs is 0 when the worker never started', () => {
  // The end mark latches a duration from worker start; with no worker start
  // there is no runtime to measure, so it records 0 rather than measuring
  // from an earlier stage.
  const c = fresh();
  c.markSupervisorStarted(1_000);
  c.markWorkerEnded(2_000);
  const m = c.toCompactMetrics();
  assert.equal(m.workerMs, 0);
});

test('markWorkerEnded latches the first legal end, clamping to 0 when before worker start', () => {
  const c = fresh();
  c.markSupervisorStarted(1_000);
  c.markWorkerStarted(2_000);
  c.markWorkerEnded(1_500); // first legal end (1_500) is before worker start — clamps to 0 and locks
  c.markWorkerEnded(4_000); // later ends never overwrite the latched end
  const m = c.toCompactMetrics();
  assert.equal(m.workerMs, 0); // latched clamp, not 4_000 − 2_000
});

test('markWorkerStarted twice: supervisorStartMs is 0 and workerMs stays null', () => {
  const c = fresh();
  c.markWorkerStarted(500); // first legal start — no supervisor start, so 0
  c.markWorkerStarted(10_000); // ignored — first valid time only
  const m = c.toCompactMetrics();
  assert.equal(m.supervisorStartMs, 0); // no supervisor start — worker never supervised
  assert.equal(m.workerMs, null); // no worker end yet — runtime still unknown
});

// ── tool use: counting, Read dedup, Bash without command ────────────────────

test('assistant tool_use content blocks are counted by name', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf /' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 'a.txt' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'b.txt' } }] } },
  ]);
  const m = c.toCompactMetrics();
  assert.equal(m.toolUseCounts['Read'], 3);
  assert.equal(m.toolUseCounts['Bash'], 1);
  assert.equal(m.uniqueReadFiles, 2); // a.txt repeated, b.txt once
  assert.equal(m.bashCommands, 1); // count only — command text never stored
});

test('Read paths are deduplicated after normalization (separators, . and .., case on win32)', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/a/../job-metrics.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src\\job-metrics.ts' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'SRC/JOB-METRICS.TS' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/other.ts' } }] } },
  ]);
  const m = c.toCompactMetrics();
  // Windows file systems are case-insensitive, so the case variant collapses;
  // on POSIX it stays distinct.
  assert.equal(m.uniqueReadFiles, process.platform === 'win32' ? 2 : 3);
});

test('Read inputs without a path (or with an empty one) never affect uniqueReadFiles', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { path: 42 } }] } },
  ]);
  const m = c.toCompactMetrics();
  assert.equal(m.toolUseCounts['Read'], 3); // still counted as calls
  assert.equal(m.uniqueReadFiles, 0);
});

test('content blocks that are not tool_use are ignored', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_result', content: [] }] } },
    { type: 'assistant', message: { content: 'not an array of objects' } },
    { type: 'assistant', message: null },
    { type: 'user', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }, // user messages never count
  ]);
  assert.deepEqual(c.toCompactMetrics().toolUseCounts, {});
});

test('tool_use without a usable name is ignored', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: '', input: {} }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 7, input: {} }] } },
  ]);
  assert.deepEqual(c.toCompactMetrics().toolUseCounts, {});
});

// ── token usage ─────────────────────────────────────────────────────────────

test('result-level usage captures tokens once, non-negative finite integers only', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'result', result: { usage: { input_tokens: 100, output_tokens: 12, cache_read_input_tokens: 50, cache_creation_input_tokens: 7 } } },
    { type: 'result', result: { usage: { input_tokens: 999, output_tokens: 999 } } }, // first wins
  ]);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, 100);
  assert.equal(m.outputTokens, 12);
  assert.equal(m.cacheReadInputTokens, 50);
  assert.equal(m.cacheCreationInputTokens, 7);
});

test('message-level usage is accepted when result usage is missing', () => {
  const c = fresh();
  observeAll(c, [{ type: 'result', result: {}, message: { usage: { input_tokens: 5, output_tokens: 3 } } }]);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, 5);
  assert.equal(m.outputTokens, 3);
  assert.equal(m.cacheReadInputTokens, null);
  assert.equal(m.cacheCreationInputTokens, null);
});

test('fractional token counts floor to integers', () => {
  const c = fresh();
  observeAll(c, [{ type: 'result', result: { usage: { input_tokens: 10.9, output_tokens: 3.1 } } }]);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, 10);
  assert.equal(m.outputTokens, 3);
});

test('no usage at all leaves every token field null', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'result', result: {} },
    { type: 'result', result: { usage: null } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'no tokens here' }] } },
  ]);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, null);
  assert.equal(m.outputTokens, null);
  assert.equal(m.cacheReadInputTokens, null);
  assert.equal(m.cacheCreationInputTokens, null);
});

test('bad usage values keep the fields null', () => {
  const c = fresh();
  observeAll(c, [
    {
      type: 'result',
      result: {
        usage: {
          input_tokens: -1,
          output_tokens: Number.NaN,
          cache_read_input_tokens: Number.POSITIVE_INFINITY,
          cache_creation_input_tokens: '7',
        },
      },
    },
  ]);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, null);
  assert.equal(m.outputTokens, null);
  assert.equal(m.cacheReadInputTokens, null);
  assert.equal(m.cacheCreationInputTokens, null);
});

test('a bad value does not poison a later good one', () => {
  const c = fresh();
  observeAll(c, [
    { type: 'result', result: { usage: { input_tokens: -5 } } },
    { type: 'result', result: { usage: { input_tokens: 42 } } },
  ]);
  assert.equal(c.toCompactMetrics().inputTokens, 42);
});

// ── bad JSON lines ──────────────────────────────────────────────────────────

test('non-object or null lines are ignored without throwing', () => {
  const c = fresh();
  for (const line of [null, undefined, 42, 'junk', [], true]) c.observeStreamJsonLine(line);
  const m = c.toCompactMetrics();
  assert.equal(m.inputTokens, null);
  assert.deepEqual(m.toolUseCounts, {});
  assert.equal(m.uniqueReadFiles, 0);
});

// ── first-report latch ──────────────────────────────────────────────────────

test('markFirstReportWrite records only the first call', () => {
  const c = fresh();
  c.markSupervisorStarted(1_000);
  c.markFirstReportWrite(2_000);
  c.markFirstReportWrite(9_000); // must be ignored
  const m = c.toCompactMetrics();
  assert.equal(m.reportFirstWriteMs, 1_000);
});

test('reportFirstWriteMs stays null until the first mark', () => {
  const c = fresh();
  c.markSupervisorStarted(1_000);
  assert.equal(c.toCompactMetrics().reportFirstWriteMs, null);
});

// ── counters: clamping and invalid values ───────────────────────────────────

test('setFilesTouchedCount accepts non-negative integers and floors fractions', () => {
  const c = fresh();
  c.setFilesTouchedCount(3);
  assert.equal(c.toCompactMetrics().filesTouchedCount, 3);
  c.setFilesTouchedCount(0);
  assert.equal(c.toCompactMetrics().filesTouchedCount, 0);
  c.setFilesTouchedCount(2.9);
  assert.equal(c.toCompactMetrics().filesTouchedCount, 2);
});

test('setFilesTouchedCount ignores invalid values, keeping the last good one', () => {
  const c = fresh();
  c.setFilesTouchedCount(4);
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5 / 0, '3']) c.setFilesTouchedCount(bad as number);
  assert.equal(c.toCompactMetrics().filesTouchedCount, 4);
});

test('an invalid initial counter is clamped to 0, never negative', () => {
  const c = fresh({ filesTouchedCount: -7, promptChars: Number.NaN, transcriptBytesBefore: -1, replyDepth: 3.9, bashCommands: -2 });
  const m = c.toCompactMetrics();
  assert.equal(m.filesTouchedCount, 0);
  assert.equal(m.promptChars, 0);
  assert.equal(m.transcriptBytesBefore, 0);
  assert.equal(m.replyDepth, 3);
  assert.equal(m.bashCommands, 0);
});

// ── sensitive data must never leak ──────────────────────────────────────────

test('the public shape never contains paths, prompts, commands, or raw env', () => {
  const c = fresh();
  c.markSupervisorStarted(1_000);
  observeAll(c, [
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Users\\testuser\\secret\\notes.txt' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'rm -rf C:\\Users\\testuser' } }] } },
  ]);
  c.setFilesTouchedCount(2);
  const text = JSON.stringify(c.toCompactMetrics());
  for (const needle of ['secret', 'notes.txt', 'rm -rf', 'Users\\testuser', 'file_path', 'command']) {
    assert.ok(!text.includes(needle), `serialized metrics must not contain ${JSON.stringify(needle)}`);
  }
});

test('toCompactMetrics returns a defensive copy with exactly the public fields', () => {
  const c = fresh();
  c.markSupervisorStarted(1_000);
  observeAll(c, [{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'x' } }] } }]);
  const m = c.toCompactMetrics();
  assert.deepEqual(Object.keys(m).sort(), [...PUBLIC_FIELDS].sort(), 'no extra or missing fields');
  const fields = PUBLIC_FIELDS;
  for (const f of fields) {
    const v = (m as unknown as Record<string, unknown>)[f];
    if (f === 'toolUseCounts') continue;
    if (typeof v === 'number') assert.ok(Number.isFinite(v), `${f} is finite`);
  }
  // Mutating the returned copy must not affect the collector.
  m.toolUseCounts['Bash'] = 999;
  m.uniqueReadFiles = 999;
  assert.equal(c.toCompactMetrics().toolUseCounts['Bash'], 1);
  assert.equal(c.toCompactMetrics().uniqueReadFiles, 0);
});
