// T2A2 — Claude PreToolUse budget hook (thin adapter over src/budget.ts).
// CLI: --config <json> --state <json> or --config=… --state=… ; stdin carries
// the PreToolUse JSON. Only <state> is mutated — atomically, under an
// exclusive <state>.lock (open wx; an existing lock is never overwritten).
// Allow => stdout empty, exit 0; deny => Claude PreToolUse JSON with a fixed
// permissionDecisionReason code. Fail closed on bad args, config/state
// (missing/corrupt state is never created or overwritten), a busy lock, or a
// path outside workFolder. Bash commands, prompts, and file contents are
// never read, echoed, or persisted; deny reasons are fixed short codes.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import type { BudgetSpec } from './contracts-v2.js';
import {
  createBudgetState,
  evaluateBudgetToolCall,
  normalizeBudgetSpec,
  type BudgetState,
  type BudgetToolEvent,
} from './budget.js';

// Types (strict shapes — unknown fields are rejected).

export interface BudgetHookConfig {
  jobId: string;
  workFolder: string;
  startedAtMs: number;
  budget: BudgetSpec;
  /** Absolute paths; every entry must stay inside workFolder. */
  reportTargets: string[];
}

/** On-disk state; never contains command/prompt content. */
export interface BudgetHookState {
  schemaVersion: 1;
  jobId: string;
  budgetState: BudgetState;
  /** Non-negative integer; +1 per allowed report-target write. */
  reportWrites: number;
}

export interface PreToolUseInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PreToolUseDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny';
    permissionDecisionReason: string;
  };
}

export interface BudgetHookResult {
  allowed: boolean;
  /** Fixed short code; '' when allowed. */
  denyReason: string;
  /** Next persisted state; null when the call failed closed. */
  state: BudgetHookState | null;
}

/** Fixed deny codes (fail-closed reasons; never echo paths/commands/contents). */
const DENY_CODES = 'invalid_config invalid_state state_lock_busy path_outside_workspace invalid_tool_input io_error';
type DenyCode =
  | 'invalid_config'
  | 'invalid_state'
  | 'state_lock_busy'
  | 'path_outside_workspace'
  | 'invalid_tool_input'
  | 'io_error';
function isDenyCode(c: string): boolean {
  return DENY_CODES.split(' ').includes(c);
}

// Strict helpers (fail closed on ANY mismatch).

function fail(code: DenyCode): never {
  throw new Error(`budget-hook:${code}`);
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && !/[\x00-\x1f]/.test(v);
}
function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}
function isNonNullObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Path style is inferred per value (mirrors contracts-v2): a drive letter or a
// backslash means Windows semantics (case-insensitive), else POSIX — behavior
// is identical on Windows and POSIX hosts.
function styleOf(p: string): 'win32' | 'posix' {
  return /^[A-Za-z]:[\\/]/.test(p) || p.includes('\\') ? 'win32' : 'posix';
}
function norm(p: string): string {
  const s = styleOf(p);
  const n = (s === 'win32' ? path.win32 : path.posix).normalize(p);
  return s === 'win32' ? n.toLowerCase() : n;
}
function isAbsolute(p: string): boolean {
  const s = styleOf(p);
  return (s === 'win32' ? path.win32 : path.posix).isAbsolute(p);
}
function resolveInside(root: string, p: string): string {
  const s = styleOf(root);
  return (s === 'win32' ? path.win32 : path.posix).resolve(root, p);
}
/** True when p equals root or sits below it (segment-boundary aware). */
function isInside(root: string, p: string): boolean {
  const a = norm(root);
  const b = norm(p);
  const sep = styleOf(root) === 'win32' ? '\\' : '/';
  return b === a || b.startsWith(a + sep);
}

// Config / state load (never auto-create, never overwrite damaged files).

function readJsonStrict(file: string, denyCode: DenyCode): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    fail(denyCode);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    fail(denyCode);
  }
}

const CONFIG_FIELDS = new Set(['jobId', 'workFolder', 'startedAtMs', 'budget', 'reportTargets']);

function validateConfig(raw: unknown): BudgetHookConfig {
  if (!isNonNullObject(raw)) fail('invalid_config');
  for (const k of Object.keys(raw)) {
    if (!CONFIG_FIELDS.has(k)) fail('invalid_config');
  }
  const jobId = raw.jobId;
  if (!isNonEmptyString(jobId)) fail('invalid_config');
  const workFolder = raw.workFolder;
  if (!isNonEmptyString(workFolder) || !isAbsolute(workFolder)) fail('invalid_config');
  const startedAtMs = raw.startedAtMs;
  if (typeof startedAtMs !== 'number' || !Number.isFinite(startedAtMs) || startedAtMs < 0) fail('invalid_config');
  if (!isNonNullObject(raw.budget)) fail('invalid_config');
  if (!isPositiveInt((raw.budget as Record<string, unknown>).maxRuntimeMinutes)) fail('invalid_config');
  const reportTargets = raw.reportTargets;
  if (!Array.isArray(reportTargets)) fail('invalid_config');
  const targets: string[] = [];
  for (let i = 0; i < reportTargets.length; i++) {
    const t = reportTargets[i];
    if (!isNonEmptyString(t) || !isAbsolute(t) || !isInside(workFolder, t)) fail('invalid_config');
    targets.push(t);
  }
  return { jobId, workFolder, startedAtMs, budget: raw.budget as unknown as BudgetSpec, reportTargets: targets };
}

const STATE_FIELDS = new Set(['schemaVersion', 'jobId', 'budgetState', 'reportWrites']);

function isBudgetState(v: unknown): v is BudgetState {
  if (!isNonNullObject(v)) return false;
  if (typeof v.startedAtMs !== 'number' || !Number.isFinite(v.startedAtMs) || v.startedAtMs < 0) return false;
  if (typeof v.lastUpdatedAtMs !== 'number' || !Number.isFinite(v.lastUpdatedAtMs) || v.lastUpdatedAtMs < 0) return false;
  if (v.mode !== 'active' && v.mode !== 'report_only' && v.mode !== 'failed') return false;
  if (!isNonNegativeInt(v.toolCalls) || !isNonNegativeInt(v.bashCommands) || !isNonNegativeInt(v.sourceLines)) return false;
  if (!Array.isArray(v.uniqueReadFiles) || v.uniqueReadFiles.some((f) => !isNonEmptyString(f))) return false;
  if (v.violationCode !== undefined && typeof v.violationCode !== 'string') return false;
  return true;
}

function validateState(raw: unknown): BudgetHookState {
  if (!isNonNullObject(raw)) fail('invalid_state');
  for (const k of Object.keys(raw)) {
    if (!STATE_FIELDS.has(k)) fail('invalid_state');
  }
  if (raw.schemaVersion !== 1) fail('invalid_state');
  if (!isNonEmptyString(raw.jobId)) fail('invalid_state');
  if (!isBudgetState(raw.budgetState)) fail('invalid_state');
  if (!isNonNegativeInt(raw.reportWrites)) fail('invalid_state');
  return {
    schemaVersion: 1,
    jobId: raw.jobId,
    budgetState: raw.budgetState as BudgetState,
    reportWrites: raw.reportWrites,
  };
}

// State mutation: exclusive lock (open wx) + temp+rename atomic write; only
// the caller's own lock is ever removed (in finally).

export interface LockHandle {
  lockFilePath: string; // <state>.lock
  ownerId: string; // release-time ownership match
}

export interface StateLockResult {
  status: 'acquired' | 'held' | 'failed';
  handle: LockHandle | null;
}

export function acquireStateLock(statePath: string, nowMs?: number): StateLockResult {
  const lockFilePath = `${statePath}.lock`;
  const ownerId = crypto.randomUUID();
  const record = JSON.stringify({ schemaVersion: 1, ownerId, ownerPid: process.pid, acquiredAtMs: nowMs ?? Date.now() });
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockFilePath, 'wx');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EEXIST'
      ? { status: 'held', handle: null }
      : { status: 'failed', handle: null };
  }
  try {
    fs.writeFileSync(fd, record, 'utf8');
  } catch {
    try { fs.closeSync(fd); } catch { /* noop */ }
    try { fs.unlinkSync(lockFilePath); } catch { /* best-effort */ }
    return { status: 'failed', handle: null };
  }
  try {
    fs.closeSync(fd);
    fd = null;
  } catch {
    try { fs.unlinkSync(lockFilePath); } catch { /* best-effort */ }
    return { status: 'failed', handle: null };
  }
  return { status: 'acquired', handle: { lockFilePath, ownerId } };
}

function readLockRecord(file: string): { ownerId: string; ownerPid: number } | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!isNonNullObject(raw) || typeof raw.ownerId !== 'string' || raw.ownerId.length === 0) return null;
    if (typeof raw.ownerPid !== 'number' || !Number.isInteger(raw.ownerPid) || raw.ownerPid <= 0) return null;
    return { ownerId: raw.ownerId, ownerPid: raw.ownerPid };
  } catch {
    return null;
  }
}

/** Remove the lock ONLY if this caller still owns it (ownerId + pid match). */
export function releaseStateLock(handle: LockHandle): boolean {
  const cur = readLockRecord(handle.lockFilePath);
  if (cur && (cur.ownerId !== handle.ownerId || cur.ownerPid !== process.pid)) {
    return false; // a different owner took over; never delete their lock
  }
  try {
    fs.unlinkSync(handle.lockFilePath);
    return true;
  } catch {
    return false;
  }
}

function uniqueTmpPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
}

/** temp + rename atomic write into the SAME directory as the target. */
function atomicWriteJson(file: string, data: unknown): void {
  const tmp = uniqueTmpPath(file);
  let wrote = false;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    wrote = true;
    fs.renameSync(tmp, file);
  } catch (err) {
    if (wrote) {
      try { fs.unlinkSync(tmp); } catch { /* leftover tmp is inert */ }
    }
    throw err;
  }
}

// Tool-call classification (thin adapter over budget.ts).

const MAX_SOURCE_LINES_PER_FILE = 500_000;

/** True when the (normalized) path is exactly one report target. */
function isReportTarget(reportTargets: string[], abs: string): boolean {
  const n = norm(abs);
  return reportTargets.some((t) => norm(t) === n);
}

/** Resolve a tool path strictly: inside workFolder, no control characters. */
function resolveToolPath(workFolder: string, p: string): string {
  if (!isNonEmptyString(p)) fail('invalid_tool_input');
  const abs = resolveInside(workFolder, p);
  if (!isInside(workFolder, abs)) fail('path_outside_workspace');
  return abs;
}

/** Read the file on disk and count its lines (never trusts tool_input). */
function countSourceLines(abs: string): number {
  const st = fs.statSync(abs);
  if (!st.isFile() || st.size === 0) return 0;
  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split('\n');
  // A trailing newline ends the last line without adding an empty one; drop
  // that single phantom segment before counting.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return Math.min(lines.length, MAX_SOURCE_LINES_PER_FILE);
}

// The hook core (testable): reads config + state, classifies the tool call,
// evaluates via budget.ts, persists the next state atomically under the
// exclusive lock, returns allow/deny.

export function runBudgetHook(input: PreToolUseInput, configPath: string, statePath: string, nowMs?: number): BudgetHookResult {
  const now = nowMs ?? Date.now();
  try {
    const config = validateConfig(readJsonStrict(configPath, 'invalid_config'));
    const toolName = input.tool_name;
    if (!isNonEmptyString(toolName)) fail('invalid_tool_input');
    const toolInput = isNonNullObject(input.tool_input) ? input.tool_input : {};

    // A held or failed lock fails closed — never proceed unlocked.
    const lock = acquireStateLock(statePath, now);
    if (lock.status !== 'acquired' || lock.handle === null) fail('state_lock_busy');
    const handle = lock.handle;
    try {
      // State read under the lock; corrupt/missing state fails closed and is
      // never overwritten (a partial read may not be clobbered by a writer).
      const state = validateState(readJsonStrict(statePath, 'invalid_state'));
      if (state.jobId !== config.jobId) fail('invalid_state');

      // Classify into the budget event. Bash contributes only its tool name;
      // Read is counted from disk (never tool_input); Write/Edit mark exact
      // normalized report targets; any other tool contributes its toolName.
      let event: BudgetToolEvent = { toolName, nowMs: now };
      if (toolName === 'Read') {
        const p = toolInput.file_path ?? toolInput.path;
        if (typeof p !== 'string') fail('invalid_tool_input');
        const abs = resolveToolPath(config.workFolder, p);
        event = { ...event, filePath: abs, sourceLines: countSourceLines(abs) };
      } else if (toolName === 'Write' || toolName === 'Edit') {
        const p = toolInput.file_path ?? toolInput.path;
        if (typeof p !== 'string') fail('invalid_tool_input');
        const abs = resolveToolPath(config.workFolder, p);
        event = { ...event, isReportWrite: isReportTarget(config.reportTargets, abs) };
      }

      // Single source of truth for limits: budget.ts.
      const decision = evaluateBudgetToolCall(state.budgetState, event, normalizeBudgetSpec(config.budget));

      // Persist the next state whenever input/state were legal and the lock
      // was held — whether the call is allowed or denied.
      const next: BudgetHookState = {
        schemaVersion: 1,
        jobId: state.jobId,
        budgetState: decision.nextState,
        reportWrites: state.reportWrites + (decision.allow && event.isReportWrite === true ? 1 : 0),
      };
      atomicWriteJson(statePath, next);
      return {
        allowed: decision.allow,
        denyReason: decision.allow ? '' : `budget_denied:${decision.nextState.violationCode ?? decision.code}`,
        state: next,
      };
    } finally {
      try { releaseStateLock(handle); } catch { /* leftover lock fails closed next time — safe */ }
    }
  } catch (err) {
    // Fail closed: fixed code only — never echo paths, commands, or contents.
    return { allowed: false, denyReason: codeOf(err), state: null };
  }
}

function codeOf(err: unknown): DenyCode {
  const m = err instanceof Error ? err.message : '';
  const code = m.startsWith('budget-hook:') ? m.slice('budget-hook:'.length) : '';
  return isDenyCode(code) ? (code as DenyCode) : 'io_error';
}

// CLI wrapper. Importing this module NEVER exits; only running it as the main
// entry does. stdin is read synchronously because PreToolUse input is already
// fully buffered by Claude before the hook is invoked.

/** Fixed short codes; never echoes config paths, commands, or contents. */
export function boundedDenyReason(code: string): string {
  const base = 'denied by job budget hook';
  const c = String(code).replace(/[\x00-\x1f]+/g, ' ').trim();
  return (c.length > 0 ? `${base}: ${c}` : base).slice(0, 200);
}

export function denyOutput(reason: string): PreToolUseDenyOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: boundedDenyReason(reason),
    },
  };
}

function parseArgs(argv: string[]): { configPath: string; statePath: string } {
  const spaced = argv.length === 4 && argv[0] === '--config' && argv[2] === '--state';
  const equals = argv.length === 2 && argv[0].startsWith('--config=') && argv[1].startsWith('--state=');
  const configPath = spaced ? argv[1] : equals ? argv[0].slice('--config='.length) : '';
  const statePath = spaced ? argv[3] : equals ? argv[1].slice('--state='.length) : '';
  if (configPath === '' || statePath === '') fail('invalid_config');
  if (!isAbsolute(configPath) || !isAbsolute(statePath)) fail('invalid_config');
  return { configPath, statePath };
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parseStdin(raw: string): PreToolUseInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) fail('invalid_tool_input');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    fail('invalid_tool_input');
  }
  if (!isNonNullObject(parsed)) fail('invalid_tool_input');
  if (typeof parsed.tool_name !== 'string') fail('invalid_tool_input');
  const tool_input = parsed.tool_input;
  if (tool_input !== undefined && !isNonNullObject(tool_input)) fail('invalid_tool_input');
  return { tool_name: parsed.tool_name, tool_input: (tool_input ?? {}) as Record<string, unknown> };
}

export function main(argv: string[] = process.argv.slice(2), stdin: string = readStdin()): void {
  try {
    const args = parseArgs(argv);
    const input = parseStdin(stdin);
    const result = runBudgetHook(input, args.configPath, args.statePath);
    process.exitCode = 0;
    if (!result.allowed) {
      process.stdout.write(JSON.stringify(denyOutput(result.denyReason)) + '\n');
    }
  } catch (err) {
    // Fail closed: any CLI/config/state/lock/IO problem denies with a code.
    process.exitCode = 0;
    process.stdout.write(JSON.stringify(denyOutput(codeOf(err))) + '\n');
  }
}

const isMain =
  typeof process !== 'undefined' &&
  typeof process.argv !== 'undefined' &&
  process.argv.length > 1 &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main();
}
