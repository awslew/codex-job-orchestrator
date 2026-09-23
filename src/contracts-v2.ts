// TaskContractV2 — pure contract model and validation (T1A).
//
// This module is intentionally pure: no I/O, no runtime coupling, so any module
// can import it without touching the scheduler/supervisor runtime. It defines
// the v2 task-contract shape (schemaVersion 2) and two entry points:
//
//   - validateTaskContractV2(input, workFolder): strict validation producing a
//     discriminated {ok:true,value} | {ok:false,errors} result that collects
//     EVERY violation (not just the first).
//   - buildLegacyContract(...): builds a v2 contract from legacy job fields,
//     mapping taskType to a write policy and using the same loose defaults the
//     pre-v2 code relied on, so existing behavior is unchanged.
//
// Path containment is checked against workFolder with Windows semantics
// (case-insensitive) for drive-letter/backslash paths and POSIX semantics
// otherwise, so validation behaves identically on both platforms.

import path from 'node:path';

export const CONTRACT_V2_SCHEMA_VERSION = 2;

export type WritePolicy = 'read_only_report' | 'listed_writes' | 'workspace_legacy';

export interface BudgetSpec {
  /** Positive integer minutes the job may run before it is force-stopped. */
  maxRuntimeMinutes: number;
  /** Optional: only report (no live streaming) after this many minutes; 0 = immediately. */
  reportOnlyAfterMinutes?: number;
  /** Optional: positive integer cap on distinct files read. */
  maxFilesRead?: number;
  /** Optional: positive integer cap on source lines read. */
  maxSourceLines?: number;
  /** Optional: positive integer cap on agent tool calls. */
  maxToolCalls?: number;
  /** Optional: positive integer cap on bash commands run. */
  maxBashCommands?: number;
  /** Optional: non-negative integer exploration minutes; must not exceed maxRuntimeMinutes (nor reportOnlyAfterMinutes when present). */
  explorationMinutes?: number;
  /** Optional: positive integer cap on transcript bytes captured. */
  maxTranscriptBytes?: number;
  /** Optional: behavior when a budget is exceeded. */
  onExceeded?: 'report_partial' | 'fail';
}

/** Strictly: id, argv, cwdRelative, timeoutSeconds, required, outputMaxChars — nothing else. */
export interface AcceptanceCommandSpec {
  /** 1-64 chars from [A-Za-z0-9._-]. */
  id: string;
  /** Non-empty; every entry a non-empty string without NUL. */
  argv: string[];
  /** Relative path that must resolve inside workFolder. */
  cwdRelative: string;
  /** Integer seconds in [1, 3600]. */
  timeoutSeconds: number;
  required: boolean;
  /** Integer chars in [100, 50000]. */
  outputMaxChars: number;
}

export interface ReportingSpec {
  /** When present: absolute .md path inside workFolder. */
  deliverablePath?: string;
}

export interface AdmissionSpec {
  resourceClass: 'light' | 'build' | 'heavy';
  /** Integer in [0, 3]. */
  priority: number;
}

export interface ScopeSpec {
  /** Read-file globs; every entry must stay inside workFolder. */
  readGlobs: string[];
  /** Write-file globs; every entry must stay inside workFolder. */
  writeFiles: string[];
  /** Forbidden-file globs; every entry must stay inside workFolder. */
  forbiddenGlobs: string[];
}

export interface TaskContractV2 {
  schemaVersion: 2;
  scope: ScopeSpec;
  writePolicy: WritePolicy;
  budget: BudgetSpec;
  acceptance: AcceptanceCommandSpec[];
  reporting: ReportingSpec;
  admission: AdmissionSpec;
}

export type TaskContractValidationResult =
  | { ok: true; value: TaskContractV2 }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Path containment helpers. Path style is inferred per value: drive letter or
// backslash -> Windows semantics (case-insensitive), otherwise POSIX.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Field validators (all push to `errors`; nothing throws).
// ---------------------------------------------------------------------------

const WRITE_POLICIES: ReadonlySet<string> = new Set([
  'read_only_report',
  'listed_writes',
  'workspace_legacy',
]);
const RESOURCE_CLASSES: ReadonlySet<string> = new Set(['light', 'build', 'heavy']);
const ACCEPTANCE_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'argv',
  'cwdRelative',
  'timeoutSeconds',
  'required',
  'outputMaxChars',
]);
const TOP_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'scope',
  'writePolicy',
  'budget',
  'acceptance',
  'reporting',
  'admission',
]);
const SCOPE_FIELDS: ReadonlySet<string> = new Set(['readGlobs', 'writeFiles', 'forbiddenGlobs']);
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

function validateGlobEntry(
  g: unknown,
  field: string,
  index: number,
  workFolder: string,
  errors: string[],
): void {
  if (typeof g !== 'string' || g.length === 0) {
    errors.push(`${field}[${index}] must be a non-empty string`);
    return;
  }
  if (g.includes('\0')) {
    errors.push(`${field}[${index}] must not contain NUL`);
    return;
  }
  if (isAbsolute(g)) {
    errors.push(`${field}[${index}] must be a relative path, not absolute`);
    return;
  }
  if (!isInside(workFolder, resolveInside(workFolder, g))) {
    errors.push(`${field}[${index}] must not escape workFolder`);
  }
}

function validateGlobArray(value: unknown, field: string, workFolder: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    validateGlobEntry(value[i], field, i, workFolder, errors);
  }
}

function validateCwdRelative(value: unknown, field: string, workFolder: string, errors: string[]): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${field} must be a non-empty relative path inside workFolder`);
    return;
  }
  if (isAbsolute(value)) {
    errors.push(`${field} must be a relative path, not absolute`);
    return;
  }
  if (!isInside(workFolder, resolveInside(workFolder, value))) {
    errors.push(`${field} must not escape workFolder`);
  }
}

function validateScope(value: unknown, workFolder: string, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('scope must be an object');
    return;
  }
  const s = value as Record<string, unknown>;
  for (const k of Object.keys(s)) {
    if (!SCOPE_FIELDS.has(k)) {
      errors.push(`unknown scope field '${k}'`);
    }
  }
  for (const field of ['readGlobs', 'writeFiles', 'forbiddenGlobs']) {
    if (s[field] === undefined) {
      errors.push(`scope.${field} is required`);
    }
  }
  validateGlobArray(s.readGlobs, 'scope.readGlobs', workFolder, errors);
  validateGlobArray(s.writeFiles, 'scope.writeFiles', workFolder, errors);
  validateGlobArray(s.forbiddenGlobs, 'scope.forbiddenGlobs', workFolder, errors);
}

const BUDGET_FIELDS: ReadonlySet<string> = new Set([
  'maxRuntimeMinutes',
  'reportOnlyAfterMinutes',
  'maxFilesRead',
  'maxSourceLines',
  'maxToolCalls',
  'maxBashCommands',
  'explorationMinutes',
  'maxTranscriptBytes',
  'onExceeded',
]);
const ON_EXCEEDED_VALUES: ReadonlySet<string> = new Set(['report_partial', 'fail']);
const LEGACY_DEFAULT_ON_EXCEEDED = 'report_partial' as const;

function isPositiveInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

function isNonNegativeInteger(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function validateBudget(value: unknown, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('budget must be an object');
    return;
  }
  const b = value as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!BUDGET_FIELDS.has(k)) {
      errors.push(`unknown budget field '${k}'`);
    }
  }
  const max = b.maxRuntimeMinutes;
  if (typeof max !== 'number' || !Number.isInteger(max) || max <= 0) {
    errors.push('budget.maxRuntimeMinutes must be a positive integer');
  }
  const ro = b.reportOnlyAfterMinutes;
  if (ro !== undefined) {
    if (typeof ro !== 'number' || !Number.isInteger(ro) || ro < 0) {
      errors.push('budget.reportOnlyAfterMinutes must be a non-negative integer');
    } else if (typeof max === 'number' && Number.isInteger(max) && ro > max) {
      errors.push('budget.reportOnlyAfterMinutes must not exceed budget.maxRuntimeMinutes');
    }
  }
  const positiveFields: [string, unknown][] = [
    ['maxFilesRead', b.maxFilesRead],
    ['maxSourceLines', b.maxSourceLines],
    ['maxToolCalls', b.maxToolCalls],
    ['maxBashCommands', b.maxBashCommands],
    ['maxTranscriptBytes', b.maxTranscriptBytes],
  ];
  for (const [field, v] of positiveFields) {
    if (v !== undefined && !isPositiveInteger(v)) {
      errors.push(`budget.${field} must be a positive integer`);
    }
  }
  const exp = b.explorationMinutes;
  if (exp !== undefined) {
    if (typeof exp !== 'number' || !Number.isInteger(exp) || exp < 0) {
      errors.push('budget.explorationMinutes must be a non-negative integer');
    } else if (typeof max === 'number' && Number.isInteger(max) && exp > max) {
      errors.push('budget.explorationMinutes must not exceed budget.maxRuntimeMinutes');
    } else if (
      typeof ro === 'number' &&
      Number.isInteger(ro) &&
      typeof max === 'number' &&
      Number.isInteger(max) &&
      exp <= max &&
      exp > ro
    ) {
      errors.push('budget.explorationMinutes must not exceed budget.reportOnlyAfterMinutes');
    }
  }
  if (b.onExceeded !== undefined && (typeof b.onExceeded !== 'string' || !ON_EXCEEDED_VALUES.has(b.onExceeded))) {
    errors.push('budget.onExceeded must be report_partial | fail');
  }
}

function validateAcceptanceEntry(entry: unknown, index: number, workFolder: string, errors: string[]): void {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    errors.push(`acceptance[${index}] must be an object`);
    return;
  }
  const e = entry as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (!ACCEPTANCE_FIELDS.has(k)) {
      errors.push(`unknown acceptance[${index}] field '${k}'`);
    }
  }
  const id = e.id;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    errors.push(`acceptance[${index}].id must match ^[A-Za-z0-9._-]{1,64}$`);
  }
  const argv = e.argv;
  if (
    !Array.isArray(argv) ||
    argv.length === 0 ||
    argv.some((a) => typeof a !== 'string' || a.length === 0 || a.includes('\0'))
  ) {
    errors.push(`acceptance[${index}].argv must be a non-empty array of non-empty strings without NUL`);
  }
  validateCwdRelative(e.cwdRelative, `acceptance[${index}].cwdRelative`, workFolder, errors);
  const timeout = e.timeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 3600) {
    errors.push(`acceptance[${index}].timeoutSeconds must be an integer in [1, 3600]`);
  }
  if (typeof e.required !== 'boolean') {
    errors.push(`acceptance[${index}].required must be a boolean`);
  }
  const chars = e.outputMaxChars;
  if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 100 || chars > 50000) {
    errors.push(`acceptance[${index}].outputMaxChars must be an integer in [100, 50000]`);
  }
}

function validateAcceptance(value: unknown, workFolder: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push('acceptance must be an array');
    return;
  }
  for (let i = 0; i < value.length; i++) {
    validateAcceptanceEntry(value[i], i, workFolder, errors);
  }
}

function validateReporting(value: unknown, workFolder: string, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('reporting must be an object');
    return;
  }
  const r = value as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== 'deliverablePath') {
      errors.push(`unknown reporting field '${k}'`);
    }
  }
  const d = r.deliverablePath;
  if (d === undefined) return;
  if (typeof d !== 'string' || d.length === 0) {
    errors.push('reporting.deliverablePath must be a non-empty string');
    return;
  }
  if (!isAbsolute(d)) {
    errors.push('reporting.deliverablePath must be an absolute path');
    return;
  }
  if (!isInside(workFolder, resolveInside(workFolder, d))) {
    errors.push('reporting.deliverablePath must be inside workFolder');
    return;
  }
  if (!norm(d).endsWith('.md')) {
    errors.push('reporting.deliverablePath must end with .md');
  }
}

function validateAdmission(value: unknown, errors: string[]): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    errors.push('admission must be an object');
    return;
  }
  const a = value as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k !== 'resourceClass' && k !== 'priority') {
      errors.push(`unknown admission field '${k}'`);
    }
  }
  if (typeof a.resourceClass !== 'string' || !RESOURCE_CLASSES.has(a.resourceClass)) {
    errors.push('admission.resourceClass must be light | build | heavy');
  }
  const p = a.priority;
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 3) {
    errors.push('admission.priority must be an integer in [0, 3]');
  }
}

// ---------------------------------------------------------------------------
// Entry points.
// ---------------------------------------------------------------------------

export function validateTaskContractV2(input: unknown, workFolder: string): TaskContractValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['contract must be an object'] };
  }
  const c = input as Record<string, unknown>;
  for (const k of Object.keys(c)) {
    if (!TOP_LEVEL_FIELDS.has(k)) {
      errors.push(`unknown top-level field '${k}'`);
    }
  }
  if (c.schemaVersion !== CONTRACT_V2_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${CONTRACT_V2_SCHEMA_VERSION}`);
  }
  validateScope(c.scope, workFolder, errors);
  if (typeof c.writePolicy !== 'string' || !WRITE_POLICIES.has(c.writePolicy)) {
    errors.push('writePolicy must be read_only_report | listed_writes | workspace_legacy');
  }
  validateBudget(c.budget, errors);
  validateAcceptance(c.acceptance, workFolder, errors);
  validateReporting(c.reporting, workFolder, errors);
  validateAdmission(c.admission, errors);

  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, value: c as unknown as TaskContractV2 };
}

/**
 * Loose defaults for legacy-built contracts. These mirror pre-v2 job behavior:
 * no acceptance commands, no admission gating, unrestricted scope.
 */
const LEGACY_DEFAULT_MAX_RUNTIME_MINUTES = 120;

export interface LegacyContractOptions {
  taskType: string;
  /** Optional report deliverable; passed through to reporting when given. */
  deliverablePath?: string;
  workFolder: string;
  /** Optional; falls back to the legacy default when omitted. */
  maxRuntimeMinutes?: number;
}

export function buildLegacyContract(opts: LegacyContractOptions): TaskContractV2 {
  const writePolicy: WritePolicy =
    opts.taskType === 'research' || opts.taskType === 'analysis'
      ? opts.deliverablePath !== undefined
        ? 'read_only_report'
        : 'workspace_legacy'
      : 'workspace_legacy';
  const reporting: ReportingSpec =
    opts.deliverablePath !== undefined ? { deliverablePath: opts.deliverablePath } : {};
  const maxRuntimeMinutes = opts.maxRuntimeMinutes ?? LEGACY_DEFAULT_MAX_RUNTIME_MINUTES;
  return {
    schemaVersion: CONTRACT_V2_SCHEMA_VERSION,
    scope: { readGlobs: [], writeFiles: [], forbiddenGlobs: [] },
    writePolicy,
    budget: {
      maxRuntimeMinutes,
      reportOnlyAfterMinutes: maxRuntimeMinutes,
      maxFilesRead: 200,
      maxSourceLines: 50000,
      maxToolCalls: 500,
      maxBashCommands: 100,
      explorationMinutes: Math.min(15, maxRuntimeMinutes),
      maxTranscriptBytes: 4194304,
      onExceeded: LEGACY_DEFAULT_ON_EXCEEDED,
    },
    acceptance: [],
    reporting,
    admission: { resourceClass: 'light', priority: 0 },
  };
}
