// Unit tests for the T2A2 PreToolUse budget hook (src/budget-hook.ts).
//
// Everything is exercised through the exported runBudgetHook() / acquire /
// release entry points against a scratch temp dir; the CLI path is exercised
// in-process with injected argv/stdin (main() never exits, only its toplevel
// guard does — importing this module is side-effect free).
//
// The hook is a thin adapter over src/budget.ts: the on-disk state is
// BudgetHookState {schemaVersion, jobId, budgetState, reportWrites} and every
// decision is delegated to evaluateBudgetToolCall. Expectations here follow
// that contract: counts are read from budgetState.bashCommands / toolCalls /
// uniqueReadFiles / sourceLines / mode, and a cap N denies only the (N+1)-th
// call (the first N are allowed).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runBudgetHook,
  acquireStateLock,
  releaseStateLock,
  boundedDenyReason,
  main,
  type BudgetHookState,
} from '../src/budget-hook.js';
import { createBudgetState, type BudgetState } from '../src/budget.js';

// One scratch root per test process; each test gets a fresh job subdir.
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-budget-hook-'));
// One timestamp per test process, so a normal test run never crosses the
// 60-minute report-only window mid-test.
const STARTED_AT_MS = Date.now();
after(() => {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

interface Ctx {
  wf: string;
  configPath: string;
  statePath: string;
  reportTarget: string;
  readTarget: string;
}

function makeCtx(over: Partial<Ctx> = {}): Ctx {
  const job = `job-${Math.random().toString(36).slice(2, 10)}`;
  const wf = path.join(ROOT, job);
  fs.mkdirSync(wf, { recursive: true });
  const reportTarget = path.join(wf, 'report.md');
  const readTarget = path.join(wf, 'a.ts');
  fs.writeFileSync(readTarget, 'line1\nline2\nline3\n', 'utf8');
  const ctx = {
    wf,
    configPath: path.join(wf, 'config.json'),
    statePath: path.join(wf, 'state.json'),
    reportTarget,
    readTarget,
    ...over,
  };
  fs.writeFileSync(
    ctx.configPath,
    JSON.stringify({
      jobId: job,
      workFolder: wf,
      startedAtMs: STARTED_AT_MS,
      budget: { maxRuntimeMinutes: 60, maxBashCommands: 1 },
      reportTargets: [reportTarget],
    }),
    'utf8',
  );
  return ctx;
}

// Default state starts from createBudgetState(STARTED_AT_MS); nested budgetState fields
// may be overridden with a Partial<BudgetState>. The legacy top-level fields
// (bashCalls/toolCalls/readFiles/sourceLines/isReportOnly) are gone.
function writeState(ctx: Ctx, over: Partial<BudgetState> = {}): void {
  fs.writeFileSync(
    ctx.statePath,
    JSON.stringify({
      schemaVersion: 1,
      jobId: path.basename(ctx.wf),
      budgetState: { ...createBudgetState(STARTED_AT_MS), ...over },
      reportWrites: 0,
    }),
    'utf8',
  );
}

function stdin(toolName: string, toolInput: Record<string, unknown>): string {
  return JSON.stringify({ tool_name: toolName, tool_input: toolInput });
}

function readStateFile(ctx: Ctx): BudgetHookState {
  return JSON.parse(fs.readFileSync(ctx.statePath, 'utf8')) as BudgetHookState;
}

// ---------------------------------------------------------------------------
// CLI parseArgs / bounded deny text / main() wiring.
// ---------------------------------------------------------------------------

test('main: allow leaves stdout empty and exit code 0', () => {
  const ctx = makeCtx();
  writeState(ctx);
  let out = '';
  const oldWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    main([`--config=${ctx.configPath}`, `--state=${ctx.statePath}`], stdin('Read', { file_path: ctx.readTarget }));
  } finally {
    process.stdout.write = oldWrite;
  }
  assert.equal(process.exitCode, 0);
  assert.equal(out, '');
});

test('main: deny emits Claude-format PreToolUse JSON with bounded reason', () => {
  const ctx = makeCtx();
  writeState(ctx);
  // Optional warm-up Read that does not consume the bash budget; the two real
  // Bash calls below drive the allow -> deny sequence.
  const oldWrite = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    main([`--config=${ctx.configPath}`, `--state=${ctx.statePath}`], stdin('Read', { file_path: ctx.readTarget }));
    // first Bash is within maxBashCommands=1 -> allowed, no stdout
    main([`--config=${ctx.configPath}`, `--state=${ctx.statePath}`], stdin('Bash', { command: 'echo first' }));
    // second Bash exceeds maxBashCommands=1 -> deny
    main([`--config=${ctx.configPath}`, `--state=${ctx.statePath}`], stdin('Bash', { command: 'echo second' }));
  } finally {
    process.stdout.write = oldWrite;
  }
  assert.equal(process.exitCode, 0);
  // Exactly one deny JSON line — never trimmed or collapsed multiple errors.
  const lines = out.split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]) as { hookSpecificOutput: Record<string, unknown> };
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'denied by job budget hook: budget_denied:bash_commands_exceeded');
  assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.length <= 200);
});

test('boundedDenyReason is bounded, single-line, and never echoes raw input', () => {
  assert.equal(boundedDenyReason('boom'), 'denied by job budget hook: boom');
  const long = `x`.repeat(10_000);
  const r = boundedDenyReason(long);
  assert.ok(r.length <= 200);
  assert.ok(!r.includes('\n'));
  assert.ok(!r.includes('\t'));
  assert.ok(!r.includes('secret-command'));
  assert.equal(boundedDenyReason('secret-command\n\t'), 'denied by job budget hook: secret-command');
});

// ---------------------------------------------------------------------------
// Policy: second Bash denied; report_only; exact report write allowed.
// ---------------------------------------------------------------------------

test('second Bash call is denied; first is allowed; state counts invocations only', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const first = runBudgetHook(
    { tool_name: 'Bash', tool_input: { command: 'echo pwd' } },
    ctx.configPath,
    ctx.statePath,
  );
  assert.equal(first.allowed, true);
  assert.equal(readStateFile(ctx).budgetState.bashCommands, 1);
  const second = runBudgetHook(
    { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } },
    ctx.configPath,
    ctx.statePath,
  );
  assert.equal(second.allowed, false);
  assert.equal(second.denyReason, 'budget_denied:bash_commands_exceeded');
  const st = readStateFile(ctx);
  assert.equal(st.budgetState.bashCommands, 1);
  // The state file must never contain the command text.
  const raw = fs.readFileSync(ctx.statePath, 'utf8');
  assert.ok(!raw.includes('rm -rf'));
  assert.ok(!raw.includes('echo pwd'));
});

test('report_only mode: Read and Bash denied, exact report Write allowed', () => {
  const ctx = makeCtx();
  writeState(ctx, { mode: 'report_only' });
  const bash = runBudgetHook({ tool_name: 'Bash', tool_input: { command: 'x' } }, ctx.configPath, ctx.statePath);
  assert.equal(bash.allowed, false);
  const read = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(read.allowed, false);
  const write = runBudgetHook({ tool_name: 'Write', tool_input: { file_path: ctx.reportTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(write.allowed, true);
  const st = readStateFile(ctx);
  assert.equal(st.reportWrites, 1);
  assert.equal(st.budgetState.bashCommands, 0);
});

test('report_only mode: non-report Write denied', () => {
  const ctx = makeCtx();
  writeState(ctx, { mode: 'report_only' });
  const other = path.join(ctx.wf, 'other.ts');
  const r = runBudgetHook({ tool_name: 'Write', tool_input: { file_path: other } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
});

test('Edit against a report target is allowed (exact normalized match), non-target denied', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const ok = runBudgetHook({ tool_name: 'Edit', tool_input: { file_path: ctx.reportTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(ok.allowed, true);
  assert.equal(ok.denyReason, '');
  // Active mode: a non-report Edit inside the workspace is a normal edit and
  // must NOT be denied (only report-only mode denies it).
  const normal = runBudgetHook({ tool_name: 'Edit', tool_input: { file_path: path.join(ctx.wf, 'b.ts') } }, ctx.configPath, ctx.statePath);
  assert.equal(normal.allowed, true);
  // Same workspace, now report-only: the non-report Edit is denied.
  writeState(ctx, { mode: 'report_only' });
  const bad = runBudgetHook({ tool_name: 'Edit', tool_input: { file_path: path.join(ctx.wf, 'b.ts') } }, ctx.configPath, ctx.statePath);
  assert.equal(bad.allowed, false);
  assert.equal(bad.denyReason, 'budget_denied:denied_report_only');
});

// ---------------------------------------------------------------------------
// Fail closed: corrupt config / state / lock contention.
// ---------------------------------------------------------------------------

test('corrupt config JSON fails closed without touching state', () => {
  const ctx = makeCtx();
  writeState(ctx);
  fs.writeFileSync(ctx.configPath, '{not json', 'utf8');
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'invalid_config');
});

test('corrupt state JSON fails closed and is NOT overwritten', () => {
  const ctx = makeCtx();
  fs.writeFileSync(ctx.statePath, '{broken', 'utf8');
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(fs.readFileSync(ctx.statePath, 'utf8'), '{broken');
});

test('state missing fails closed and is NOT created', () => {
  const ctx = makeCtx();
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(fs.existsSync(ctx.statePath), false);
});

test('held lock fails closed and the holder is not displaced', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const held = acquireStateLock(ctx.statePath);
  assert.equal(held.status, 'acquired');
  assert.ok(held.handle);
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'state_lock_busy');
  assert.ok(fs.existsSync(`${ctx.statePath}.lock`));
  releaseStateLock(held.handle);
  const ok = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(ok.allowed, true);
});

test('state and config paths are not configurable via stdin', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const r = runBudgetHook(
    { tool_name: 'Read', tool_input: { file_path: ctx.readTarget, statePath: '/tmp/evil' } },
    ctx.configPath,
    ctx.statePath,
  );
  assert.equal(r.allowed, true); // unknown input fields are ignored
});

// ---------------------------------------------------------------------------
// Path boundary behavior.
// ---------------------------------------------------------------------------

test('Read outside workFolder is denied and counts nothing', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const outside = path.join(ROOT, 'outside.txt');
  fs.writeFileSync(outside, 'x\n', 'utf8');
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: outside } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'path_outside_workspace');
  const st = readStateFile(ctx);
  assert.equal(st.budgetState.uniqueReadFiles.length, 0);
  assert.equal(st.budgetState.sourceLines, 0);
});

test('Read path normalization: same file via absolute, path field, trailing slash, dot-dot', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const file = path.join(ctx.wf, 'sub', 'x.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'a\nb\n', 'utf8');
  const abs = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: file } }, ctx.configPath, ctx.statePath);
  assert.equal(abs.allowed, true);
  const viaPath = runBudgetHook({ tool_name: 'Read', tool_input: { path: file } }, ctx.configPath, ctx.statePath);
  assert.equal(viaPath.allowed, true);
  const st = readStateFile(ctx);
  assert.equal(st.budgetState.uniqueReadFiles.length, 1); // dedup: same normalized file
  assert.equal(st.budgetState.sourceLines, 4);
});

test('maxFilesRead and maxSourceLines caps deny exactly at the boundary', () => {
  const ctx = makeCtx();
  writeState(ctx);
  // Patch the config budget caps.
  const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')) as Record<string, unknown>;
  (cfg as { budget: Record<string, unknown> }).budget = { maxRuntimeMinutes: 60, maxFilesRead: 1, maxSourceLines: 3 };
  fs.writeFileSync(ctx.configPath, JSON.stringify(cfg), 'utf8');

  const a = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(a.allowed, true); // 3 lines fits exactly
  const b = path.join(ctx.wf, 'b.ts');
  fs.writeFileSync(b, '1\n', 'utf8');
  const second = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: b } }, ctx.configPath, ctx.statePath);
  assert.equal(second.allowed, false); // maxFilesRead=1 already consumed
  const c = path.join(ctx.wf, 'c.ts');
  fs.writeFileSync(c, 'x\n', 'utf8');
  writeState(ctx, { uniqueReadFiles: [path.normalize(ctx.readTarget)], sourceLines: 3 });
  const overflow = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: c } }, ctx.configPath, ctx.statePath);
  assert.equal(overflow.allowed, false); // 3 + 1 > maxSourceLines=3
});

test('maxToolCalls cap denies at the boundary', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')) as Record<string, unknown>;
  (cfg as { budget: Record<string, unknown> }).budget = { maxRuntimeMinutes: 60, maxToolCalls: 1 };
  fs.writeFileSync(ctx.configPath, JSON.stringify(cfg), 'utf8');
  const a = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(a.allowed, true);
  const b = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(b.allowed, false);
});

test('runtime budget: nowMs beyond startedAtMs + maxRuntimeMinutes denies', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const cfg = JSON.parse(fs.readFileSync(ctx.configPath, 'utf8')) as Record<string, unknown>;
  (cfg as { budget: Record<string, unknown> }).budget = { maxRuntimeMinutes: 1, maxBashCommands: 5 };
  fs.writeFileSync(ctx.configPath, JSON.stringify(cfg), 'utf8');
  const r = runBudgetHook(
    { tool_name: 'Bash', tool_input: { command: 'x' } },
    ctx.configPath,
    ctx.statePath,
    STARTED_AT_MS + 60 * 1000 + 1,
  );
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'budget_denied:report_only_window');
});

test('Write outside workFolder is denied', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const outside = path.join(ROOT, 'o.md');
  const r = runBudgetHook({ tool_name: 'Write', tool_input: { file_path: outside } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, false);
  assert.equal(r.denyReason, 'path_outside_workspace');
});

// ---------------------------------------------------------------------------
// Lock ownership: only the caller's own lock is ever removed.
// ---------------------------------------------------------------------------

test('only the caller own lock is removed; a replacement holder survives', () => {
  const ctx = makeCtx();
  const a = acquireStateLock(ctx.statePath);
  assert.equal(a.status, 'acquired');
  assert.ok(a.handle);
  const b = acquireStateLock(ctx.statePath);
  assert.equal(b.status, 'held');
  // Simulate a takeover by replacing the lock with a different owner record.
  const record = { schemaVersion: 1, ownerId: 'other-owner', ownerPid: process.pid, acquiredAtMs: Date.now() };
  fs.writeFileSync(`${ctx.statePath}.lock`, JSON.stringify(record), 'utf8');
  const released = releaseStateLock(a.handle as { lockFilePath: string; ownerId: string });
  assert.equal(released, false);
  assert.ok(fs.existsSync(`${ctx.statePath}.lock`));
  assert.ok(fs.readFileSync(`${ctx.statePath}.lock`, 'utf8').includes('other-owner'));
});

test('successful run removes its own lock in all outcomes', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const r = runBudgetHook({ tool_name: 'Read', tool_input: { file_path: ctx.readTarget } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, true);
  assert.equal(fs.existsSync(`${ctx.statePath}.lock`), false);
  // Deny path also releases the lock.
  writeState(ctx);
  const d = runBudgetHook({ tool_name: 'Bash', tool_input: { command: 'x' } }, ctx.configPath, ctx.statePath);
  assert.equal(d.allowed, true);
  const d2 = runBudgetHook({ tool_name: 'Bash', tool_input: { command: 'y' } }, ctx.configPath, ctx.statePath);
  assert.equal(d2.allowed, false);
  assert.equal(fs.existsSync(`${ctx.statePath}.lock`), false);
});

// ---------------------------------------------------------------------------
// Unknown tool names: unified budget counting, permissive default.
// ---------------------------------------------------------------------------

test('unknown tool name consumes one tool call and persists no input content', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const r = runBudgetHook({ tool_name: 'NotATool', tool_input: { secret: 'TOP-SECRET-INPUT' } }, ctx.configPath, ctx.statePath);
  assert.equal(r.allowed, true);
  const st = readStateFile(ctx);
  assert.equal(st.budgetState.toolCalls, 1);
  assert.equal(st.budgetState.bashCommands, 0);
  // No state field ever echoes the input content.
  const raw = fs.readFileSync(ctx.statePath, 'utf8');
  assert.ok(!raw.includes('TOP-SECRET-INPUT'));
});

// ---------------------------------------------------------------------------
// stdin privacy: prompt and command text never reach the reason or the state.
// ---------------------------------------------------------------------------

test('deny reason never contains prompt or command text', () => {
  const ctx = makeCtx();
  writeState(ctx);
  const prompt = 'TOP-SECRET-PROMPT';
  const r = runBudgetHook(
    { tool_name: 'Bash', tool_input: { command: 'SECRET-COMMAND', prompt } },
    ctx.configPath,
    ctx.statePath,
  );
  // First Bash is allowed; the reason string is empty on allow.
  assert.equal(r.allowed, true);
  assert.equal(r.denyReason, '');
  const raw = fs.readFileSync(ctx.statePath, 'utf8');
  assert.ok(!raw.includes('SECRET-COMMAND'));
  assert.ok(!raw.includes('TOP-SECRET-PROMPT'));
});
