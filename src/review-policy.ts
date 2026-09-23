// T1C review policy: permission model for 'read_only_report' tasks (pure module).
//
// A read_only_report task may Read/Glob/Grep inside workFolder and may
// Write/Edit/MultiEdit ONLY the exact deliverable path; without a valid
// deliverable the task is zero-write. Bash and NotebookEdit are never granted.
//
// Path checks are platform-faithful:
//   - Windows comparisons are case-insensitive, POSIX case-sensitive.
//   - NUL bytes, empty paths, '..' escapes, and adjacent-prefix lookalikes
//     (workFolder 'wf' vs sibling 'wf2', file 'report.md' vs prefix 'report')
//     are all denied.
//   - Symlink / reparse escapes are denied via realpath of the nearest existing
//     ancestor, so a not-yet-existing deliverable is supported as long as its
//     parent directory is inside workFolder.
//
// The workspace manifest maps relative paths -> {size, mtimeMs, sha256} with a
// stable, deterministic walk (sorted, never follows links) and default excludes
// runtime / node_modules / audit-evidence / dist-backup-* / *.bak-*. The diff
// reports added / removed / changed and ignores the legitimate deliverable
// itself.
//
// Self-contained: reads only fs / path / crypto, never config, env, runtime
// state, or the build.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type ReviewPolicy = 'read_only_report' | 'deliverable_write' | 'deny';

export interface ReviewPolicyInput {
  profile: string;
  taskType: string;
  workFolder: string;
  /** Optional absolute or workFolder-relative deliverable path (may not exist yet). */
  deliverablePath?: string | null;
}

export interface ResolvedReviewPolicy {
  policy: ReviewPolicy;
  /** Canonical absolute deliverable path when writable, else null. */
  deliverablePath: string | null;
  /** Tools this policy permits; write tools appear only with a valid deliverable. */
  allowedTools: string[];
  /** Present only when the policy is 'deny'. */
  deniedReason?: string;
}

export type CandidateResolution =
  | { kind: 'ok'; path: string }
  | { kind: 'deliverable'; path: string }
  | { kind: 'deny'; reason: string };

export interface ManifestEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

export type WorkspaceManifest = Record<string, ManifestEntry>;

export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Entries matching the legitimate deliverable, excluded from the other buckets. */
  ignored: string[];
}

const IS_WIN = process.platform === 'win32';
const REVIEW_PROFILES = new Set(['review', 'normal']);
const REVIEW_TASK_TYPE = 'read_only_report';
const READ_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit'] as const;
const EXCLUDED_DIR_EXACT = new Set(['runtime', 'node_modules', 'audit-evidence']);
const EXCLUDED_DIR_PREFIX = 'dist-backup-';
const EXCLUDED_FILE_RE = /\.bak-/;

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

function segmentEqual(a: string, b: string): boolean {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function splitSegments(p: string): string[] {
  return path.resolve(p).split(path.sep).filter((s) => s.length > 0);
}

/** Strict containment: `inner` is a proper descendant of `outer` (segment-boundary aware, so adjacent-prefix lookalikes fail). */
function isInside(inner: string, outer: string): boolean {
  const innerParts = splitSegments(inner);
  const outerParts = splitSegments(outer);
  if (innerParts.length <= outerParts.length) return false;
  for (let i = 0; i < outerParts.length; i++) {
    if (!segmentEqual(innerParts[i], outerParts[i])) return false;
  }
  return true;
}

/** Relative key of `inner` below `outer` (forward slashes), or null when not strictly inside. */
function relativeKey(inner: string, outer: string): string | null {
  const innerParts = splitSegments(inner);
  const outerParts = splitSegments(outer);
  if (innerParts.length <= outerParts.length) return null;
  for (let i = 0; i < outerParts.length; i++) {
    if (!segmentEqual(innerParts[i], outerParts[i])) return null;
  }
  return innerParts.slice(outerParts.length).join('/');
}

function samePath(a: string, b: string): boolean {
  return IS_WIN ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// realpath of the nearest existing ancestor plus the not-yet-existing suffix,
// so a deliverable that does not exist yet is still resolved against the real
// (symlink-free) directory tree. Returns null when nothing up to the root exists.
function recomposed(p: string): string | null {
  let cur = p;
  const missing: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      return path.join(fs.realpathSync.native(cur), ...missing);
    } catch {
      // component does not exist yet: climb to its parent
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  return null;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function normalizeCandidatePath(
  candidate: string,
  workFolder: string,
  deliverablePath?: string | null,
): CandidateResolution {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return { kind: 'deny', reason: 'empty candidate path' };
  }
  if (candidate.includes('\0')) {
    return { kind: 'deny', reason: 'NUL byte in candidate path' };
  }
  if (typeof workFolder !== 'string' || workFolder.length === 0 || !isDirectory(workFolder)) {
    return { kind: 'deny', reason: 'workFolder is not a readable directory' };
  }
  const root = recomposed(workFolder);
  if (!root) return { kind: 'deny', reason: 'workFolder has no existing ancestor' };
  const canonical = recomposed(path.resolve(workFolder, candidate));
  if (!canonical) return { kind: 'deny', reason: 'candidate has no existing ancestor' };
  if (!isInside(canonical, root)) {
    return { kind: 'deny', reason: 'candidate escapes workFolder' };
  }
  if (deliverablePath && samePath(canonical, deliverablePath)) {
    return { kind: 'deliverable', path: canonical };
  }
  return { kind: 'ok', path: canonical };
}

export function isAllowedWritePath(
  candidate: string,
  workFolder: string,
  deliverablePath?: string | null,
): boolean {
  if (!deliverablePath) return false;
  const deliverable = normalizeCandidatePath(deliverablePath, workFolder);
  if (deliverable.kind === 'deny') return false;
  return normalizeCandidatePath(candidate, workFolder, deliverable.path).kind === 'deliverable';
}

export function resolveReviewPolicy(input: ReviewPolicyInput): ResolvedReviewPolicy {
  if (!REVIEW_PROFILES.has(input.profile)) {
    return {
      policy: 'deny',
      deliverablePath: null,
      allowedTools: [],
      deniedReason: `profile '${input.profile}' is not a review profile`,
    };
  }
  if (input.taskType !== REVIEW_TASK_TYPE) {
    return {
      policy: 'deny',
      deliverablePath: null,
      allowedTools: [],
      deniedReason: `taskType '${input.taskType}' is not '${REVIEW_TASK_TYPE}'`,
    };
  }
  if (!isDirectory(input.workFolder)) {
    // Deliverable cannot be validated without a readable workFolder: zero-write.
    return { policy: 'read_only_report', deliverablePath: null, allowedTools: [...READ_TOOLS] };
  }
  let canonical: string | null = null;
  if (input.deliverablePath) {
    // 'ok' already means strictly inside workFolder (equality is denied by
    // isInside), so the deliverable's parent is inside workFolder by
    // construction and the file itself may not exist yet.
    const r = normalizeCandidatePath(input.deliverablePath, input.workFolder);
    if (r.kind === 'ok') canonical = r.path;
  }
  return canonical
    ? {
        policy: 'deliverable_write',
        deliverablePath: canonical,
        allowedTools: [...READ_TOOLS, ...WRITE_TOOLS],
      }
    : { policy: 'read_only_report', deliverablePath: null, allowedTools: [...READ_TOOLS] };
}

// ---------------------------------------------------------------------------
// Workspace manifest
// ---------------------------------------------------------------------------

export function captureWorkspaceManifest(workFolder: string): WorkspaceManifest {
  const manifest: WorkspaceManifest = {};
  const root = recomposed(workFolder);
  if (!root || !isDirectory(root)) return manifest;
  walkTree(root, root, manifest);
  return manifest;
}

function walkTree(dir: string, root: string, out: WorkspaceManifest): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable subtree: stable-absent
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never follow links (escape + determinism)
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (isExcludedDir(e.name)) continue;
      walkTree(abs, root, out);
    } else if (e.isFile()) {
      if (isExcludedFile(e.name)) continue;
      const hex = sha256Hex(abs);
      if (!hex) continue; // unreadable file: stable-absent
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      out[path.relative(root, abs).split(path.sep).join('/')] = {
        size: st.size,
        mtimeMs: st.mtimeMs,
        sha256: hex,
      };
    }
  }
}

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIR_EXACT.has(name) || name.startsWith(EXCLUDED_DIR_PREFIX);
}

function isExcludedFile(name: string): boolean {
  return EXCLUDED_FILE_RE.test(name);
}

function sha256Hex(file: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Manifest diff
// ---------------------------------------------------------------------------

export interface DiffWorkspaceManifestOptions {
  /** Ignore the legitimate deliverable itself (absolute or workFolder-relative). */
  deliverablePath?: string | null;
  workFolder?: string | null;
}

export function diffWorkspaceManifest(
  before: WorkspaceManifest,
  after: WorkspaceManifest,
  opts: DiffWorkspaceManifestOptions = {},
): ManifestDiff {
  const deliverableRel =
    opts.deliverablePath && opts.workFolder ? relativeKey(opts.deliverablePath, opts.workFolder) : null;
  const ignored = new Set<string>();
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  // Classify each key exactly once over the union of before/after keys: only
  // actually-changed keys are reported (removed/added/changed); an unchanged
  // key is skipped entirely. A changed key that equals the legitimate
  // deliverable is only ever ignored.
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key];
    const a = after[key];
    const isRemoved = b !== undefined && a === undefined;
    const isAdded = a !== undefined && b === undefined;
    const isChanged = b !== undefined && a !== undefined && (a.size !== b.size || a.sha256 !== b.sha256);
    if (!isRemoved && !isAdded && !isChanged) continue;
    if (deliverableRel && segmentEqual(key, deliverableRel)) {
      ignored.add(key);
      continue;
    }
    if (isRemoved) {
      removed.push(key);
    } else if (isAdded) {
      added.push(key);
    } else {
      changed.push(key);
    }
  }
  const byName = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return {
    added: added.sort(byName),
    removed: removed.sort(byName),
    changed: changed.sort(byName),
    ignored: [...ignored].sort(byName),
  };
}
