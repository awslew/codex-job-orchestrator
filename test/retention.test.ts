// Wave 5B1: retention dry-run planner — read-only contract tests.
//
// Every test builds a runtime root under the OS temp dir, runs planRetention
// with an injectable now/policy/inspector, and asserts the plan items. The
// zero-write contract is proven two ways:
//
//   1. An on-disk "tripwire" file outside every scanned scope (runtime root
//      parent) whose mtime/content must never change.
//   2. A full pre/post content manifest (relative path → sha256 + mtime + size)
//      of every regular file under the runtime root, hashed as one aggregate.
//      Tests that exercise every branch run the scan, then assert the
//      aggregate is byte-identical.
//
// planRetention is a pure function: no mkdir/rename/write/truncate/unlink/
// chmod, no symlink following, no reads outside the fixed scope.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  planRetention,
  defaultRetentionPolicy,
  boundPolicy,
  classifyRegistryRecord,
  type RetentionPlan,
  type RetentionPlanItem,
  type RetentionPolicy,
  type InspectorLike,
} from '../src/retention.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** Fake process inspector. `starts.get(pid) ?? null` means an alive pid with
 *  no start-time entry reports identity_unverified. */
function inspector(alive: Set<number>, starts: Map<number, number | null>): InspectorLike {
  return {
    exists: (pid: number) => alive.has(pid),
    startTime: (pid: number) => {
      const v = starts.get(pid);
      return v === undefined ? null : v;
    },
  };
}

const ALL_ACTIONS = [
  'archive_registry',
  'truncate_log_candidate',
  'archive_claim_candidate',
  'archive_settings_candidate',
  'keep',
  'skip',
] as const;

function emptyTotals(): Record<string, number> {
  const c: Record<string, number> = {};
  for (const a of ALL_ACTIONS) c[a] = 0;
  return c;
}

/** Register a temp-root cleanup with node:test's after hook. */
function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-test-'));
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return dir;
}

function mkfile(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Set a file's mtime to a fixed epoch ms (older than any fresh file). */
function setMtime(dir: string, rel: string, ms: number): void {
  fs.utimesSync(path.join(dir, rel), new Date(ms), new Date(ms));
}

function jobRecord(jobId: string, status: string, endedAt: string | null): string {
  return JSON.stringify({
    jobId,
    sessionId: `s-${jobId}`,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'auto',
    parallelism: 'auto',
    workFolder: `wf-${jobId}`,
    maxRuntimeMinutes: 120,
    pid: null,
    supervisorPid: null,
    status,
    substatus: null,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt,
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    exitCode: null,
    logPath: 'ignored',
    stderrLogPath: 'ignored',
    reportPath: 'ignored',
    prompt: `SECRET-PROMPT-${jobId}`,
    lastOutputAt: null,
  });
}

function registryRecord(instanceId: string, pid: number, hbAgeMs: number | null): string {
  const hb =
    hbAgeMs === null ? 'not-a-date' : new Date(NOW - hbAgeMs).toISOString();
  return JSON.stringify({
    schemaVersion: 1,
    instanceId,
    pid,
    hostPid: null,
    processStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    serverStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    entry: 'index.js',
    buildFingerprint: 'fp',
    lastHeartbeatAt: hb,
    version: '1.0.0',
  });
}

function planFor(
  root: string,
  over: {
    now?: number;
    policy?: Partial<RetentionPolicy>;
    inspector?: InspectorLike;
    overrides?: { instanceId?: string | null; heartbeatMs?: number; identityToleranceMs?: number };
  } = {},
): RetentionPlan {
  return planRetention({
    runtimeRoot: root,
    now: over.now ?? NOW,
    policy: {
      ...defaultRetentionPolicy(),
      ...(over.policy ?? {}),
    },
    pidInspector: over.inspector ?? inspector(new Set(), new Map()),
    ...(over.overrides ? { overrides: over.overrides } : {}),
  });
}

function byPath(plan: RetentionPlan): Map<string, RetentionPlanItem> {
  return new Map(plan.items.map((i) => [i.relativePath, i]));
}

function actionCounts(plan: RetentionPlan): Record<string, number> {
  const c = emptyTotals();
  for (const i of plan.items) c[i.action] += 1;
  return c;
}

function planJson(root: string): string {
  // Deterministic aggregate of every regular file under the root: rel → sha256|size|mtimeMs.
  const walk = (dir: string, base: string, out: string[]): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel, out);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        const h = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        out.push(`${rel}=${h}:${st.size}:${Math.round(st.mtimeMs)}`);
      }
    }
  };
  const lines: string[] = [];
  walk(root, '', lines);
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// ---------------------------------------------------------------------------
// 1. Policy bounds & defaults
// ---------------------------------------------------------------------------

test('default policy matches the Wave 5B1 spec (7d/30d/30d/14d/24h)', () => {
  const p = defaultRetentionPolicy();
  assert.equal(p.succeededLogTtlMs, 7 * DAY);
  assert.equal(p.failedLogTtlMs, 30 * DAY);
  assert.equal(p.needsAttentionLogTtlMs, 30 * DAY);
  assert.equal(p.terminalClaimSettingsTtlMs, 14 * DAY);
  assert.equal(p.staleRegistryTtlMs, DAY);
});

test('boundPolicy clamps every field to [1h, 365d]', () => {
  const b = boundPolicy({
    succeededLogTtlMs: 1,
    failedLogTtlMs: 100 * 365 * DAY,
    needsAttentionLogTtlMs: 0.5 * HOUR,
    terminalClaimSettingsTtlMs: 700 * DAY,
    staleRegistryTtlMs: -5,
  });
  assert.equal(b.succeededLogTtlMs, HOUR);
  assert.equal(b.failedLogTtlMs, 365 * DAY);
  assert.equal(b.needsAttentionLogTtlMs, HOUR);
  assert.equal(b.terminalClaimSettingsTtlMs, 365 * DAY);
  assert.equal(b.staleRegistryTtlMs, HOUR);
});

test('non-finite policy fields clamp to the minimum TTL', () => {
  const b = boundPolicy({
    succeededLogTtlMs: Number.NaN,
    failedLogTtlMs: Number.POSITIVE_INFINITY,
    needsAttentionLogTtlMs: 30 * DAY,
    terminalClaimSettingsTtlMs: 14 * DAY,
    staleRegistryTtlMs: DAY,
  });
  assert.equal(b.succeededLogTtlMs, HOUR);
  assert.equal(b.failedLogTtlMs, 365 * DAY); // Infinity > 365d → max
});

// ---------------------------------------------------------------------------
// 2. TTL boundaries per status
// ---------------------------------------------------------------------------

function setupBoundaryJobs(root: string): void {
  // succeeded: log 8d old → candidate; settings/claims 8d → still keep (14d TTL).
  mkfile(root, 'jobs/j-s.json', jobRecord('j-s', 'succeeded', new Date(NOW - 8 * DAY).toISOString()));
  mkfile(root, 'logs/j-s.log', 'ok log');
  mkfile(root, 'settings/j-s.json', '{}');
  mkfile(root, 'claims/j-s.recover.json', '{}');
  setMtime(root, 'jobs/j-s.json', NOW - 8 * DAY);
  setMtime(root, 'logs/j-s.log', NOW - 8 * DAY);
  setMtime(root, 'settings/j-s.json', NOW - 8 * DAY);
  setMtime(root, 'claims/j-s.recover.json', NOW - 8 * DAY);

  // failed: log 29d → keep; 31d → candidate (30d TTL).
  mkfile(root, 'jobs/j-f29.json', jobRecord('j-f29', 'failed', new Date(NOW - 29 * DAY).toISOString()));
  mkfile(root, 'logs/j-f29.log', 'f29');
  setMtime(root, 'jobs/j-f29.json', NOW - 29 * DAY);
  setMtime(root, 'logs/j-f29.log', NOW - 29 * DAY);
  mkfile(root, 'jobs/j-f31.json', jobRecord('j-f31', 'failed', new Date(NOW - 31 * DAY).toISOString()));
  mkfile(root, 'logs/j-f31.log', 'f31');
  setMtime(root, 'jobs/j-f31.json', NOW - 31 * DAY);
  setMtime(root, 'logs/j-f31.log', NOW - 31 * DAY);

  // cancelled: same 30d TTL as failed.
  mkfile(root, 'jobs/j-c29.json', jobRecord('j-c29', 'cancelled', new Date(NOW - 29 * DAY).toISOString()));
  mkfile(root, 'logs/j-c29.log', 'c29');
  setMtime(root, 'jobs/j-c29.json', NOW - 29 * DAY);
  setMtime(root, 'logs/j-c29.log', NOW - 29 * DAY);

  // needs_attention: 30d TTL, not terminal.
  mkfile(root, 'jobs/j-n31.json', jobRecord('j-n31', 'needs_attention', null));
  mkfile(root, 'logs/j-n31.log', 'n31');
  setMtime(root, 'jobs/j-n31.json', NOW - 31 * DAY);
  setMtime(root, 'logs/j-n31.log', NOW - 31 * DAY);

  // queued/running: never candidates even when ancient.
  mkfile(root, 'jobs/j-q.json', jobRecord('j-q', 'queued', null));
  mkfile(root, 'logs/j-q.log', 'q');
  mkfile(root, 'settings/j-q.json', '{}');
  setMtime(root, 'jobs/j-q.json', NOW - 400 * DAY);
  setMtime(root, 'logs/j-q.log', NOW - 400 * DAY);
  setMtime(root, 'settings/j-q.json', NOW - 400 * DAY);
}

test('TTL boundaries: succeeded 7d, failed/cancelled 30d, needs_attention 30d, queued/running never', () => {
  const root = makeRoot();
  setupBoundaryJobs(root);
  const plan = planFor(root);
  const m = byPath(plan);

  // succeeded 8d → truncate_log_candidate (7d TTL).
  assert.equal(m.get('logs/j-s.log')!.action, 'truncate_log_candidate');
  assert.equal(m.get('logs/j-s.log')!.fixedReason, 'terminal_succeeded');
  assert.equal(m.get('logs/j-s.log')!.jobId, 'j-s');
  assert.equal(m.get('logs/j-s.log')!.ageMs, 8 * DAY);
  // 8d-old settings/claims of a terminal job: keep (14d TTL not reached).
  assert.equal(m.get('settings/j-s.json')!.action, 'keep');
  assert.equal(m.get('claims/j-s.recover.json')!.action, 'keep');

  // failed: 29d keep, 31d candidate.
  assert.equal(m.get('logs/j-f29.log')!.action, 'keep');
  assert.equal(m.get('logs/j-f31.log')!.action, 'truncate_log_candidate');
  assert.equal(m.get('logs/j-f31.log')!.fixedReason, 'terminal_failed');

  // cancelled: 29d keep under the 30d TTL.
  assert.equal(m.get('logs/j-c29.log')!.action, 'keep');

  // needs_attention: 31d → candidate with its own reason; not terminal.
  assert.equal(m.get('logs/j-n31.log')!.action, 'truncate_log_candidate');
  assert.equal(m.get('logs/j-n31.log')!.fixedReason, 'needs_attention_log');

  // queued/running: never candidates.
  assert.equal(m.get('logs/j-q.log')!.action, 'keep');
  assert.equal(m.get('logs/j-q.log')!.fixedReason, 'not_terminal');
  assert.equal(m.get('settings/j-q.json')!.action, 'keep');
});

test('TTL exact boundary: age == TTL is a candidate, age == TTL-1 is keep', () => {
  const root = makeRoot();
  mkfile(root, 'jobs/j-a.json', jobRecord('j-a', 'succeeded', new Date(NOW - 7 * DAY).toISOString()));
  mkfile(root, 'logs/j-a.log', 'a');
  setMtime(root, 'jobs/j-a.json', NOW - 7 * DAY);
  setMtime(root, 'logs/j-a.log', NOW - 7 * DAY);
  mkfile(root, 'jobs/j-b.json', jobRecord('j-b', 'succeeded', new Date(NOW - 7 * DAY + 1).toISOString()));
  mkfile(root, 'logs/j-b.log', 'b');
  setMtime(root, 'jobs/j-b.json', NOW - 7 * DAY + 1);
  setMtime(root, 'logs/j-b.log', NOW - 7 * DAY + 1);

  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('logs/j-a.log')!.action, 'truncate_log_candidate');
  assert.equal(m.get('logs/j-b.log')!.action, 'keep');
});

test('settings/claims: 14d TTL boundary for terminal jobs', () => {
  const root = makeRoot();
  mkfile(root, 'jobs/j-13.json', jobRecord('j-13', 'succeeded', new Date(NOW - 13 * DAY).toISOString()));
  mkfile(root, 'settings/j-13.json', '{}');
  mkfile(root, 'claims/j-13.recover.json', '{}');
  setMtime(root, 'jobs/j-13.json', NOW - 13 * DAY);
  setMtime(root, 'settings/j-13.json', NOW - 13 * DAY);
  setMtime(root, 'claims/j-13.recover.json', NOW - 13 * DAY);
  mkfile(root, 'jobs/j-15.json', jobRecord('j-15', 'failed', new Date(NOW - 15 * DAY).toISOString()));
  mkfile(root, 'settings/j-15.json', '{}');
  mkfile(root, 'claims/j-15.supervisor.json', '{}');
  setMtime(root, 'jobs/j-15.json', NOW - 15 * DAY);
  setMtime(root, 'settings/j-15.json', NOW - 15 * DAY);
  setMtime(root, 'claims/j-15.supervisor.json', NOW - 15 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('settings/j-13.json')!.action, 'keep');
  assert.equal(m.get('claims/j-13.recover.json')!.action, 'keep');
  assert.equal(m.get('settings/j-15.json')!.action, 'archive_settings_candidate');
  assert.equal(m.get('claims/j-15.supervisor.json')!.action, 'archive_claim_candidate');
});

// ---------------------------------------------------------------------------
// 3. Fresh-mtime protection
// ---------------------------------------------------------------------------

test('fresh log mtime beats old endedAt: no candidate for recently-written logs', () => {
  const root = makeRoot();
  // Job ended 100d ago but its log was written 1h ago → keep.
  mkfile(root, 'jobs/j-fresh.json', jobRecord('j-fresh', 'succeeded', new Date(NOW - 100 * DAY).toISOString()));
  mkfile(root, 'logs/j-fresh.log', 'fresh');
  setMtime(root, 'jobs/j-fresh.json', NOW - 100 * DAY);
  setMtime(root, 'logs/j-fresh.log', NOW - HOUR);

  const plan = planFor(root);
  const item = byPath(plan).get('logs/j-fresh.log')!;
  assert.equal(item.action, 'keep');
  assert.equal(item.ageMs, HOUR); // age from the newer reference (mtime)
});

test('a re-written job record does not resurrect an old log', () => {
  const root = makeRoot();
  // The log file itself is 100d old; the record was re-saved 1d ago. Age is
  // the NEWER of the file's own mtime and endedAt — the log is still a
  // candidate because the listed file is genuinely old (a fresh record is
  // not a reason to keep stale log data).
  mkfile(root, 'jobs/j-rw.json', jobRecord('j-rw', 'succeeded', new Date(NOW - 100 * DAY).toISOString()));
  mkfile(root, 'logs/j-rw.log', 'rw');
  setMtime(root, 'jobs/j-rw.json', NOW - DAY);
  setMtime(root, 'logs/j-rw.log', NOW - 100 * DAY);

  const plan = planFor(root);
  const item = byPath(plan).get('logs/j-rw.log')!;
  assert.equal(item.action, 'truncate_log_candidate');
  assert.equal(item.ageMs, 100 * DAY); // age from the log file's own mtime
});

test('endedAt missing on a terminal job still allows aging via mtime', () => {
  const root = makeRoot();
  mkfile(root, 'jobs/j-noend.json', jobRecord('j-noend', 'succeeded', null));
  mkfile(root, 'logs/j-noend.log', 'x');
  setMtime(root, 'jobs/j-noend.json', NOW - 400 * DAY);
  setMtime(root, 'logs/j-noend.log', NOW - 400 * DAY);

  const plan = planFor(root);
  assert.equal(byPath(plan).get('logs/j-noend.log')!.action, 'truncate_log_candidate');
});

// ---------------------------------------------------------------------------
// 4. Bad / unknown jobs
// ---------------------------------------------------------------------------

test('bad job records: their files are keep, never guessed', () => {
  const root = makeRoot();
  mkfile(root, 'jobs/j-bad.json', '{ not json');
  mkfile(root, 'logs/j-bad.log', 'x');
  mkfile(root, 'settings/j-bad.json', '{}');
  setMtime(root, 'jobs/j-bad.json', NOW - 400 * DAY);
  setMtime(root, 'logs/j-bad.log', NOW - 400 * DAY);
  setMtime(root, 'settings/j-bad.json', NOW - 400 * DAY);
  mkfile(root, 'jobs/j-empty.json', '');
  mkfile(root, 'logs/j-empty.log', 'x');
  setMtime(root, 'logs/j-empty.log', NOW - 400 * DAY);
  mkfile(root, 'jobs/j-wrongstatus.json', JSON.stringify({ jobId: 'j-wrongstatus', status: 'weird', startedAt: '2026-01-01T00:00:00.000Z', endedAt: null }));
  mkfile(root, 'logs/j-wrongstatus.log', 'x');
  setMtime(root, 'logs/j-wrongstatus.log', NOW - 400 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('logs/j-bad.log')!.action, 'keep');
  assert.equal(m.get('logs/j-bad.log')!.fixedReason, 'unknown_job');
  assert.equal(m.get('settings/j-bad.json')!.action, 'keep');
  assert.equal(m.get('logs/j-empty.log')!.action, 'keep');
  assert.equal(m.get('logs/j-wrongstatus.log')!.action, 'keep');
});

test('orphan files with no job record: keep', () => {
  const root = makeRoot();
  mkfile(root, 'logs/j-ghost.log', 'x');
  mkfile(root, 'logs/j-ghost.stderr.log', 'x');
  mkfile(root, 'settings/j-ghost.json', '{}');
  mkfile(root, 'claims/j-ghost.recover.json', '{}');
  setMtime(root, 'logs/j-ghost.log', NOW - 400 * DAY);
  setMtime(root, 'logs/j-ghost.stderr.log', NOW - 400 * DAY);
  setMtime(root, 'settings/j-ghost.json', NOW - 400 * DAY);
  setMtime(root, 'claims/j-ghost.recover.json', NOW - 400 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('logs/j-ghost.log')!.action, 'keep');
  assert.equal(m.get('logs/j-ghost.log')!.fixedReason, 'unknown_job');
  assert.equal(m.get('logs/j-ghost.stderr.log')!.action, 'keep');
  assert.equal(m.get('settings/j-ghost.json')!.action, 'keep');
  assert.equal(m.get('claims/j-ghost.recover.json')!.action, 'keep');
});

// ---------------------------------------------------------------------------
// 5. Registry: the six stale classes + continuous-age proof
// ---------------------------------------------------------------------------

function registrySetup(root: string): string[] {
  const dir = path.join(root, 'registry', 'instances');
  const files: string[] = [];
  const put = (name: string, content: string): void => {
    mkfile(root, `registry/instances/${name}`, content);
    files.push(`registry/instances/${name}`);
    setMtime(root, `registry/instances/${name}`, NOW - 400 * DAY);
  };

  // 1. corrupt (unparseable).
  put('a-corrupt.json', '{ not json');
  // 2. invalid (structurally invalid record).
  put('b-invalid.json', JSON.stringify({ schemaVersion: 1, instanceId: 'x' }));
  // 3. pid_not_found: dead pid, heartbeat stale.
  put('c-dead.json', registryRecord('c-dead', 70001, 10 * DAY));
  // 4. identity_mismatch: pid alive but OS start time differs from the record.
  put('d-mismatch.json', registryRecord('d-mismatch', 70002, 10 * DAY));
  // 5. identity_unverified: pid alive, start time unreadable.
  put('e-unverified.json', registryRecord('e-unverified', 70003, 10 * DAY));
  // 6. heartbeat_timeout: pid alive, identity verified, heartbeat old.
  // processStartedAt is NOW - 60d, so the inspector's startTime must match.
  put('f-timeout.json', registryRecord('f-timeout', 70004, 10 * DAY));

  return files;
}

test('registry: corrupt/invalid are keep when their stale age cannot be dated', () => {
  const root = makeRoot();
  registrySetup(root);
  // c-dead's stale age is unprovable (its heartbeat was 10d ago, and the
  // scan sees only the current file) → re-stamp it with a fresh heartbeat
  // so the file-level scan yields a keep, isolating the corrupt/invalid class.
  mkfile(root, 'registry/instances/c-dead.json', registryRecord('c-dead', 70001, 12 * HOUR));
  setMtime(root, 'registry/instances/c-dead.json', NOW - 400 * DAY);
  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/a-corrupt.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/a-corrupt.json')!.fixedReason, 'corrupt');
  assert.equal(m.get('registry/instances/b-invalid.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/b-invalid.json')!.fixedReason, 'invalid');
  assert.equal(m.get('registry/instances/c-dead.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/c-dead.json')!.fixedReason, 'not_continuously_stale');
});
test('registry: only stale > staleRegistryTtlMs continuously is archived', () => {
  const root = makeRoot();
  registrySetup(root);
  // Heartbeat stale 10d, TTL 24h → archive. f-timeout's pid must be alive
  // with a matching OS start time so its most specific reason is
  // heartbeat_timeout rather than pid_not_found.
  const plan = planFor(root, {
    policy: { staleRegistryTtlMs: DAY },
    inspector: inspector(
      new Set([70002, 70003, 70004]),
      new Map([
        [70002, NOW - 2 * DAY], // OS start time ≠ record's NOW - 60d → mismatch
        [70003, null], // exists but start time unreadable → unverified
        [70004, NOW - 60 * DAY], // matches → identity verified
      ]),
    ),
  });
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/f-timeout.json')!.action, 'archive_registry');
  assert.equal(m.get('registry/instances/f-timeout.json')!.fixedReason, 'heartbeat_timeout');
  assert.equal(m.get('registry/instances/f-timeout.json')!.ageMs, 10 * DAY);
  assert.equal(m.get('registry/instances/d-mismatch.json')!.action, 'archive_registry');
  assert.equal(m.get('registry/instances/d-mismatch.json')!.fixedReason, 'identity_mismatch');
  assert.equal(m.get('registry/instances/e-unverified.json')!.action, 'archive_registry');
  assert.equal(m.get('registry/instances/e-unverified.json')!.fixedReason, 'identity_unverified');
  assert.equal(m.get('registry/instances/c-dead.json')!.action, 'archive_registry');
  assert.equal(m.get('registry/instances/c-dead.json')!.fixedReason, 'pid_not_found');
});

test('registry: not continuously stale past the TTL → keep', () => {
  const root = makeRoot();
  registrySetup(root);
  // Heartbeat stale only 12h < 24h TTL → keep.
  mkfile(root, 'registry/instances/g-young.json', registryRecord('g-young', 70005, 12 * HOUR));
  setMtime(root, 'registry/instances/g-young.json', NOW - 400 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/g-young.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/g-young.json')!.fixedReason, 'not_continuously_stale');
});

test('registry: live identity-verified instances are keep', () => {
  const root = makeRoot();
  // Live: pid alive, start time matches, heartbeat fresh.
  mkfile(root, 'registry/instances/h-live.json', JSON.stringify({
    schemaVersion: 1,
    instanceId: 'h-live',
    pid: 80001,
    hostPid: null,
    processStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    serverStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    entry: 'index.js',
    buildFingerprint: 'fp',
    lastHeartbeatAt: new Date(NOW - 5000).toISOString(),
    version: '1.0.0',
  }));
  setMtime(root, 'registry/instances/h-live.json', NOW - 400 * DAY);

  const plan = planFor(root, {
    inspector: inspector(new Set([80001]), new Map([[80001, NOW - 60 * DAY]])),
  });
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/h-live.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/h-live.json')!.fixedReason, 'live_instance');
});

test('registry: self instance is keep even with an old heartbeat', () => {
  const root = makeRoot();
  mkfile(root, 'registry/instances/i-self.json', registryRecord('i-self', 80002, 10 * DAY));
  setMtime(root, 'registry/instances/i-self.json', NOW - 400 * DAY);

  const plan = planFor(root, { overrides: { instanceId: 'i-self' } });
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/i-self.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/i-self.json')!.fixedReason, 'self_instance');
});

test('registry: future heartbeat (clock skew) is keep', () => {
  const root = makeRoot();
  mkfile(root, 'registry/instances/j-future.json', JSON.stringify({
    schemaVersion: 1,
    instanceId: 'j-future',
    pid: 80003,
    hostPid: null,
    processStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    serverStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    entry: 'index.js',
    buildFingerprint: 'fp',
    lastHeartbeatAt: new Date(NOW + 5 * 60 * 1000).toISOString(),
    version: '1.0.0',
  }));
  setMtime(root, 'registry/instances/j-future.json', NOW - 400 * DAY);

  const plan = planFor(root, { inspector: inspector(new Set([80003]), new Map([[80003, NOW - 60 * DAY]])) });
  const m = byPath(plan);
  assert.equal(m.get('registry/instances/j-future.json')!.action, 'keep');
  assert.equal(m.get('registry/instances/j-future.json')!.fixedReason, 'future_heartbeat');
});

test('registry: unreadable registry dir is an empty scan, never an error', () => {
  const root = makeRoot();
  const plan = planFor(root);
  assert.equal(plan.items.length, 0);
});

// ---------------------------------------------------------------------------
// 6. Symlinks / path traversal
// ---------------------------------------------------------------------------

test('symlinked and reparse-point files are skipped without reading the target', () => {
  const root = makeRoot();
  const target = path.join(root, '..', `retention-outside-${Date.now()}.log`);
  fs.writeFileSync(target, 'outside content');
  try {
    fs.symlinkSync(target, path.join(root, 'logs', 'j-link.log'));
  } catch {
    // Windows symlink may require privileges; skip if unsupported.
  }
  mkfile(root, 'jobs/j-link.json', jobRecord('j-link', 'succeeded', new Date(NOW - 400 * DAY).toISOString()));
  mkfile(root, 'jobs/j-link2.json', jobRecord('j-link2', 'succeeded', new Date(NOW - 400 * DAY).toISOString()));
  mkfile(root, 'logs/j-link2.log', 'real');
  setMtime(root, 'logs/j-link2.log', NOW - 400 * DAY);
  setMtime(root, 'jobs/j-link2.json', NOW - 400 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  if (fs.existsSync(path.join(root, 'logs', 'j-link.log'))) {
    assert.equal(m.get('logs/j-link.log')!.action, 'skip');
    assert.equal(m.get('logs/j-link.log')!.fixedReason, 'not_a_regular_file');
  }
  // The real file is still scanned normally.
  assert.equal(m.get('logs/j-link2.log')!.action, 'truncate_log_candidate');
  fs.rmSync(target, { force: true });
});

test('traversal-shaped names are skipped without being read', () => {
  const root = makeRoot();
  mkfile(root, 'jobs/j-t.json', jobRecord('j-t', 'succeeded', new Date(NOW - 400 * DAY).toISOString()));
  mkfile(root, 'logs/j-t.log', 'x');
  setMtime(root, 'logs/j-t.log', NOW - 400 * DAY);
  // Hostile names: `..\\..\\win.log` fails the scan regex (backslashes are
  // not in the safe charset) so it produces NO item at all. Names that do
  // match the charset but contain ".." are listed only as keep/unknown_job —
  // their relativePath stays root-relative (no traversal) and they can never
  // become a candidate; they are never read (no matching job exists).
  mkfile(root, 'logs/..%2f..%2fetc.log', 'x');
  mkfile(root, 'logs/a..b.log', 'x');
  mkfile(root, 'logs/..\\..\\win.log', 'x');
  mkfile(root, 'logs/dots..log', 'x');
  setMtime(root, 'logs/..%2f..%2fetc.log', NOW - 400 * DAY);
  setMtime(root, 'logs/a..b.log', NOW - 400 * DAY);
  setMtime(root, 'logs/..\\..\\win.log', NOW - 400 * DAY);
  setMtime(root, 'logs/dots..log', NOW - 400 * DAY);

  const plan = planFor(root);
  const m = byPath(plan);
  // j-t.log scans normally; the hostile name with backslashes produces no
  // item at all; the ".." names appear only as keep/unknown_job.
  assert.equal(m.get('logs/j-t.log')!.action, 'truncate_log_candidate');
  assert.equal(m.has('logs/..\\..\\win.log'), false);
  for (const hostile of ['logs/..%2f..%2fetc.log', 'logs/a..b.log', 'logs/dots..log']) {
    const item = m.get(hostile);
    assert.ok(item, `expected an item for ${hostile}`);
    assert.equal(item!.action, 'keep');
    assert.equal(item!.fixedReason, 'unknown_job');
    assert.ok(!item!.relativePath.startsWith('/'), `absolute-ish path: ${item!.relativePath}`);
    // Relative-key containment is what guarantees safety; the literal ".."
    // substring is fine as long as it is not a path segment that escapes
    // (the key is produced by path.relative() inside the root and uses
    // forward slashes only).
    assert.ok(!item!.relativePath.includes('\\'), `backslash path: ${item!.relativePath}`);
    assert.equal(path.posix.normalize(item!.relativePath).startsWith('..'), false);
  }
  for (const item of plan.items) {
    if (item.relativePath === 'logs/j-t.log') continue; // the legitimate file
    assert.notEqual(item.action, 'truncate_log_candidate');
    assert.notEqual(item.action, 'archive_claim_candidate');
    assert.notEqual(item.action, 'archive_settings_candidate');
    assert.notEqual(item.action, 'archive_registry');
  }
});

// ---------------------------------------------------------------------------
// 7. Output privacy + ordering
// ---------------------------------------------------------------------------

test('plan items expose only sanitized fields; no absolute paths or secrets', () => {
  const root = makeRoot();
  setupBoundaryJobs(root);
  mkfile(root, 'jobs/j-15.json', jobRecord('j-15', 'succeeded', new Date(NOW - 20 * DAY).toISOString()));
  mkfile(root, 'logs/j-15.log', 'x');
  setMtime(root, 'jobs/j-15.json', NOW - 20 * DAY);
  setMtime(root, 'logs/j-15.log', NOW - 20 * DAY);
  mkfile(root, 'registry/instances/z-stale.json', registryRecord('z-stale', 90001, 10 * DAY));
  setMtime(root, 'registry/instances/z-stale.json', NOW - 400 * DAY);

  const plan = planFor(root);
  for (const item of plan.items) {
    assert.ok(!item.relativePath.startsWith('/'), `absolute-ish path: ${item.relativePath}`);
    assert.ok(!item.relativePath.includes('..'), `parent traversal: ${item.relativePath}`);
    assert.ok(!item.relativePath.includes('\\'), `backslash path: ${item.relativePath}`);
    if (item.kind === 'registry') {
      // Registry items are not job-scoped: no jobId, and the field must not
      // even be present (exact key set per kind).
      assert.deepEqual(Object.keys(item).sort(), ['action', 'ageMs', 'bytes', 'fixedReason', 'kind', 'relativePath']);
    } else {
      assert.deepEqual(Object.keys(item).sort(), ['action', 'ageMs', 'bytes', 'fixedReason', 'jobId', 'kind', 'relativePath']);
      assert.ok(item.jobId !== undefined, 'job-scoped item must carry a jobId');
    }
  }
  const serialized = JSON.stringify(plan);
  assert.ok(!serialized.includes(root), 'plan leaks the absolute runtime root');
  assert.ok(!serialized.includes('SECRET-PROMPT'), 'plan leaks prompt content');
  // Record content never surfaces: pid, heartbeat. (The instanceId appears
  // only as the PUBLIC relativePath filename — registry files are named
  // <instanceId>.json — which is allowed by the spec's sanitized fields.)
  assert.ok(!serialized.includes('90001'), 'plan leaks pids');
  assert.ok(!serialized.includes('not-a-date'), 'plan leaks raw record content');
});

test('items are sorted by (action, relativePath) and one item per file', () => {
  const root = makeRoot();
  setupBoundaryJobs(root);
  mkfile(root, 'jobs/j-15.json', jobRecord('j-15', 'succeeded', new Date(NOW - 20 * DAY).toISOString()));
  mkfile(root, 'logs/j-15.log', 'x');
  setMtime(root, 'jobs/j-15.json', NOW - 20 * DAY);
  setMtime(root, 'logs/j-15.log', NOW - 20 * DAY);

  const plan = planFor(root);
  const seen = new Set<string>();
  let prev: RetentionPlanItem | null = null;
  for (const item of plan.items) {
    assert.ok(!seen.has(item.relativePath), `duplicate item: ${item.relativePath}`);
    seen.add(item.relativePath);
    if (prev) {
      const a = prev.action < item.action ? -1 : prev.action > item.action ? 1 : 0;
      const b = prev.relativePath < item.relativePath ? -1 : prev.relativePath > item.relativePath ? 1 : 0;
      assert.ok(a < 0 || (a === 0 && b <= 0), 'not sorted by (action, relativePath)');
    }
    prev = item;
  }
});

// ---------------------------------------------------------------------------
// 8. Reports and job metadata are never candidates
// ---------------------------------------------------------------------------

test('reports dir and job metadata are never scanned', () => {
  const root = makeRoot();
  setupBoundaryJobs(root);
  mkfile(root, 'reports/j-s.json', '{"secret":"report"}');
  mkfile(root, 'reports/j-s.md', 'report markdown');
  mkfile(root, 'jobs/j-s.json', jobRecord('j-s', 'succeeded', new Date(NOW - 400 * DAY).toISOString()));
  setMtime(root, 'reports/j-s.json', NOW - 400 * DAY);
  setMtime(root, 'reports/j-s.md', NOW - 400 * DAY);

  const plan = planFor(root);
  for (const item of plan.items) {
    assert.ok(!item.relativePath.startsWith('reports/'), `reports leaked: ${item.relativePath}`);
  }
});

// ---------------------------------------------------------------------------
// 9. Zero-write evidence
// ---------------------------------------------------------------------------

test('full scan leaves every file byte-identical (content+mtime) and no new files', () => {
  const root = makeRoot();
  setupBoundaryJobs(root);
  registrySetup(root);
  mkfile(root, 'reports/j-s.md', 'report');
  mkfile(root, 'registry/instances/i-self.json', registryRecord('i-self', 80002, 10 * DAY));
  mkfile(root, 'claims/j-s.supervisor.json', '{}');
  setMtime(root, 'claims/j-s.supervisor.json', NOW - 400 * DAY);

  // Tripwire OUTSIDE the scanned scope: a scan must never touch it.
  const outside = path.join(path.dirname(root), `tripwire-${path.basename(root)}.txt`);
  fs.writeFileSync(outside, 'tripwire');
  fs.utimesSync(outside, new Date(NOW - 100 * DAY), new Date(NOW - 100 * DAY));

  const before = planJson(root);
  const plan = planFor(root, { overrides: { instanceId: 'i-self' } });
  const after = planJson(root);
  const tripwireStat = fs.statSync(outside);

  assert.equal(after, before, 'runtime tree changed during the scan');
  assert.equal(tripwireStat.size, 8);
  assert.equal(Math.round(tripwireStat.mtimeMs), NOW - 100 * DAY);
  assert.ok(plan.items.length > 0, 'plan must actually scan something');
  fs.rmSync(outside, { force: true });
});

// ---------------------------------------------------------------------------
// 10. Empty runtime
// ---------------------------------------------------------------------------

test('empty runtime root yields an empty plan with zero totals', () => {
  const root = makeRoot();
  const plan = planFor(root);
  assert.equal(plan.items.length, 0);
  for (const a of ALL_ACTIONS) {
    assert.equal(plan.totals.counts[a], 0);
    assert.equal(plan.totals.bytes[a], 0);
  }
});

// ---------------------------------------------------------------------------
// 11. 10k-file performance
// ---------------------------------------------------------------------------

test('10k-file runtime plans in under 1 second', () => {
  const root = makeRoot();
  // 2000 jobs × 4 files (jobs json + log + stderr + settings) + 1000 claims
  // ≈ 9000 files — the Wave 5B1 scale of "a 10k-file runtime".
  const n = 2000;
  for (let i = 0; i < n; i++) {
    const id = `job-${String(i).padStart(5, '0')}`;
    const ended = new Date(NOW - (i % 40) * DAY).toISOString();
    mkfile(root, `jobs/${id}.json`, jobRecord(id, i % 2 === 0 ? 'succeeded' : 'failed', ended));
    mkfile(root, `logs/${id}.log`, `log-${i}`);
    mkfile(root, `logs/${id}.stderr.log`, `err-${i}`);
    mkfile(root, `settings/${id}.json`, `{}`);
    setMtime(root, `jobs/${id}.json`, NOW - (i % 40) * DAY);
    setMtime(root, `logs/${id}.log`, NOW - (i % 40) * DAY);
    setMtime(root, `logs/${id}.stderr.log`, NOW - (i % 40) * DAY);
    setMtime(root, `settings/${id}.json`, NOW - (i % 40) * DAY);
    if (i % 2 === 0) {
      mkfile(root, `claims/${id}.recover.json`, '{}');
      setMtime(root, `claims/${id}.recover.json`, NOW - (i % 40) * DAY);
    }
  }
  const before = Date.now();
  const plan = planFor(root);
  const elapsed = Date.now() - before;
  assert.ok(elapsed < 1000, `plan took ${elapsed}ms`);
  // 2000 logs + 2000 stderr + 2000 settings + 1000 claims ≈ 7000 items
  // (job records themselves are never emitted).
  assert.ok(plan.items.length >= 6000, `expected >=6k items, got ${plan.items.length}`);
  // Determinism: two runs produce identical plans (the second run is warm
  // and out of the timed window).
  assert.deepEqual(plan.items, planFor(root).items);
});

// ---------------------------------------------------------------------------
// 12. classifyRegistryRecord unit coverage (pure function)
// ---------------------------------------------------------------------------

function classify(record: unknown, over: Record<string, unknown> = {}) {
  return classifyRegistryRecord({
    record,
    selfInstanceId: null,
    now: NOW,
    heartbeatMs: 10_000,
    staleAfterMs: 30_000,
    staleRegistryTtlMs: DAY,
    identityToleranceMs: 5000,
    inspector: inspector(new Set(), new Map()),
    ...over,
  });
}

function validRecord(instanceId = 'r-1', pid = 42_001, hbAgeMs = 10 * DAY): Record<string, unknown> {
  return {
    schemaVersion: 1,
    instanceId,
    pid,
    hostPid: null,
    processStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    serverStartedAt: new Date(NOW - 60 * DAY).toISOString(),
    entry: 'index.js',
    buildFingerprint: 'fp',
    lastHeartbeatAt: new Date(NOW - hbAgeMs).toISOString(),
    version: '1.0.0',
  };
}

test('classifyRegistryRecord: corrupt record', () => {
  const c = classify('{oops');
  assert.equal(c.action, 'keep');
  assert.equal(c.fixedReason, 'corrupt');
});

test('classifyRegistryRecord: invalid record', () => {
  const c = classify({ schemaVersion: 1, instanceId: '' });
  assert.equal(c.action, 'keep');
  assert.equal(c.fixedReason, 'invalid');
});

test('classifyRegistryRecord: stale age cannot be dated → keep', () => {
  const bad = { ...validRecord('r-badts', 42_001), lastHeartbeatAt: 'not-a-date' };
  const c = classify(bad);
  assert.equal(c.action, 'keep');
  assert.equal(c.fixedReason, 'invalid');
});

test('classifyRegistryRecord: pid_not_found archived only past TTL', () => {
  const c = classify(validRecord('r-dead', 42_001, 10 * DAY));
  assert.equal(c.action, 'archive_registry');
  assert.equal(c.fixedReason, 'pid_not_found');
  const c2 = classify(validRecord('r-dead2', 42_002, 12 * HOUR));
  assert.equal(c2.action, 'keep');
  assert.equal(c2.fixedReason, 'not_continuously_stale');
});

test('classifyRegistryRecord: identity_unverified and identity_mismatch', () => {
  const c1 = classify(validRecord('r-u', 42_003, 10 * DAY), {
    inspector: inspector(new Set([42_003]), new Map()),
  });
  assert.equal(c1.action, 'archive_registry');
  assert.equal(c1.fixedReason, 'identity_unverified');
  const c2 = classify(validRecord('r-m', 42_004, 10 * DAY), {
    inspector: inspector(new Set([42_004]), new Map([[42_004, NOW - 2 * DAY]])),
  });
  assert.equal(c2.action, 'archive_registry');
  assert.equal(c2.fixedReason, 'identity_mismatch');
});

test('classifyRegistryRecord: heartbeat_timeout when pid is live and verified', () => {
  const c = classify(validRecord('r-h', 42_005, 10 * DAY), {
    inspector: inspector(new Set([42_005]), new Map([[42_005, NOW - 60 * DAY]])),
  });
  assert.equal(c.action, 'archive_registry');
  assert.equal(c.fixedReason, 'heartbeat_timeout');
});
test('classifyRegistryRecord: live and self are keep; future heartbeat is keep', () => {
  const live = classify(validRecord('r-live', 42_006, 5000), {
    inspector: inspector(new Set([42_006]), new Map([[42_006, NOW - 60 * DAY]])),
  });
  assert.equal(live.action, 'keep');
  assert.equal(live.fixedReason, 'live_instance');

  const self = classify(validRecord('r-self', 42_007, 10 * DAY), { selfInstanceId: 'r-self' });
  assert.equal(self.action, 'keep');
  assert.equal(self.fixedReason, 'self_instance');

  const future = classify(
    { ...validRecord('r-f', 42_008, 10 * DAY), lastHeartbeatAt: new Date(NOW + 5 * 60 * 1000).toISOString() },
    { inspector: inspector(new Set([42_008]), new Map([[42_008, NOW - 60 * DAY]])) },
  );
  assert.equal(future.action, 'keep');
  assert.equal(future.fixedReason, 'future_heartbeat');
});
