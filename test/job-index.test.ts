import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Isolate runtime state per test-file process before any config function call.
const rt = path.join(os.tmpdir(), `orc-job-index-${process.pid}-${Date.now()}`);
process.env.ORCHESTRATOR_RUNTIME = rt;

import {
  INDEX_SCHEMA_VERSION,
  indexDir,
  indexSnapshotPath,
  indexJournalPath,
  indexLockPath,
  indexArchiveDir,
  emptyJobIndex,
  emptyStatusCounts,
  applyIndexedJob,
  loadIndex,
  recordIndexedJob,
  rebuildIndex,
  consistencyCheck,
  getIndexedJob,
  jobsForSession,
  statusCountsOf,
  replyChildrenOf,
  replyChain,
  indexSize,
  acquireIndexLock,
  releaseIndexLock,
  type JobIndex,
  type JobIndexOptions,
  type IndexedJobInput,
  type IndexLockHandle,
  type IndexLockStatus,
} from '../src/job-index.js';
import type { Job, JobStatus } from '../src/job-store.js';
import type { ProcessInspector } from '../src/registry.js';

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}
function nextSession(): string {
  seq += 1;
  return `session-${String(seq).padStart(4, '0')}`;
}

function input(over: Partial<IndexedJobInput> = {}): IndexedJobInput {
  return {
    jobId: nextId('job'),
    sessionId: 's1',
    status: 'queued',
    kind: 'start',
    replyToJobId: null,
    startedAt: new Date(Date.now() + seq).toISOString(),
    endedAt: null,
    ...over,
  };
}

function makeJob(over: Partial<Job> = {}): Job {
  const jobId = nextId('job');
  return {
    jobId,
    sessionId: 's1',
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'auto',
    parallelism: 'auto',
    workFolder: rt,
    maxRuntimeMinutes: 120,
    pid: null,
    supervisorPid: null,
    status: 'queued',
    substatus: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: new Date().toISOString(),
    exitCode: null,
    logPath: path.join(rt, 'x.log'),
    stderrLogPath: path.join(rt, 'x.err.log'),
    reportPath: path.join(rt, 'x.report.json'),
    prompt: 'SECRET PROMPT',
    lastOutputAt: null,
    ...over,
  };
}

function freshDir(): string {
  return path.join(os.tmpdir(), `orc-job-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
function freshDirCount(): number {
  return freshDirsCreated.length;
}
// Every freshDir() must be deleted by its owning test (via t.after).
// The final hygiene test asserts the counters balance and the process ends
// with zero self-created temp dirs left behind.
const freshDirsCreated: string[] = [];
const freshDirsCleaned: string[] = [];
function trackFreshDir(dir: string): void {
  freshDirsCreated.push(dir);
}
function untrackFreshDir(dir: string): void {
  if (!freshDirsCleaned.includes(dir)) freshDirsCleaned.push(dir);
}
function assertZeroSelfDirsLeft(): void {
  const left = freshDirsCreated.filter((d) => !freshDirsCleaned.includes(d));
  assert.deepEqual(left, [], `self-created temp dirs left behind: ${left.join(', ')}`);
  for (const d of freshDirsCreated) {
    assert.equal(fs.existsSync(d), false, `self-created temp dir still exists: ${d}`);
  }
}
test('temp-dir hygiene: this process ends with zero self-created dirs left', () => {
  assert.equal(freshDirsCreated.length, freshDirsCleaned.length);
  assert.equal(freshDirCount(), 0, `tests leaked ${freshDirCount()} freshDir() calls`);
  assertZeroSelfDirsLeft();
});

function optionsFor(over: Partial<JobIndexOptions> = {}): JobIndexOptions {
  return { rootDir: rt, now: () => baseNow, retryDelayMs: 1, ...over };
}
let baseNow = Date.now();

function journalLines(): string[] {
  return fs.readFileSync(indexJournalPath(rt), 'utf8').split('\n').filter((l) => l.length > 0);
}
function lockExists(): boolean {
  return fs.existsSync(indexLockPath(rt));
}

function withFakeOwner(inspector: ProcessInspector, exists: boolean): ProcessInspector {
  return {
    exists: (pid: number) => (pid === 42 ? exists : inspector.exists(pid)),
    startTime: (pid: number) => (pid === 42 ? baseNow - 1000 : inspector.startTime(pid)),
  };
}

/** Write a hand-authored index.lock record and return its status string. */
function indexLockStatusOf(
  status: 'queued' | 'busy' | 'acquired',
  owner: { pid: number; startedAt: string; acquiredAt: string; expiresAt: string },
  opts: Partial<JobIndexOptions> = {},
): string {
  const rootDir = opts.rootDir ?? rt;
  // Write the same complete JSON the real acquireIndexLock would have left on
  // disk (schemaVersion/ownerId/ownerPid/ownerStartedAt/acquiredAt/expiresAt),
  // and close the handle before the caller runs: no open fd may masquerade as
  // the owner — the inspector decides the stale-lease verdict, not the OS.
  fs.mkdirSync(indexDir(rootDir), { recursive: true });
  fs.writeFileSync(indexLockPath(rootDir), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: 'locked-test-owner',
    ownerPid: owner.pid,
    ownerStartedAt: owner.startedAt,
    acquiredAt: owner.acquiredAt,
    expiresAt: owner.expiresAt,
  }), 'utf8');
  return acquireIndexLock(optionsFor(opts)).status;
}

function countStatus(index: JobIndex, status: JobStatus): number {
  return index.statusCounts[status];
}

// ---------------------------------------------------------------------------
// Empty state / basic record
// ---------------------------------------------------------------------------

test('empty index: load returns missing, no files are created', () => {
  const { index, diagnostics } = loadIndex(rt);
  assert.equal(indexSize(index), 0);
  assert.equal(diagnostics.consistency, 'missing');
  assert.equal(diagnostics.snapshotLoaded, false);
  assert.equal(diagnostics.journalApplied, 0);
  assert.equal(fs.existsSync(indexDir(rt)), false);
});

test('create/update/duplicate: status counts move, idempotent duplicates', () => {
  const index = emptyJobIndex();
  const job = input({ status: 'queued' });
  assert.equal(recordIndexedJob(index, job, optionsFor()), true);
  assert.equal(fs.existsSync(indexDir(rt)), true);
  assert.equal(indexSize(index), 1);
  assert.equal(countStatus(index, 'queued'), 1);
  assert.equal(indexSize(loadIndex(rt).index), 1);

  assert.equal(recordIndexedJob(index, { ...job, status: 'running' }, optionsFor()), true);
  assert.equal(countStatus(index, 'queued'), 0);
  assert.equal(countStatus(index, 'running'), 1);
  assert.equal(getIndexedJob(index, job.jobId)?.status, 'running');

  // duplicate of the current record: idempotent no-op
  assert.equal(recordIndexedJob(index, { ...job, status: 'running' }, optionsFor()), true);
  assert.equal(indexSize(index), 1);
  assert.equal(countStatus(index, 'running'), 1);
  assert.equal(journalLines().length, 2);
});

test('record on a locked index returns false without blocking past the busy budget', () => {
  const index = emptyJobIndex();
  const opts = optionsFor({ lockBusyMs: 80 });
  const a = acquireIndexLock(opts);
  assert.equal(a.status, 'acquired');
  const before = Date.now();
  const ok = recordIndexedJob(index, input(), opts);
  const elapsed = Date.now() - before;
  assert.equal(ok, false);
  assert.ok(elapsed <= 1500, `record() blocked too long: ${elapsed}ms`);
  if (a.status === 'acquired') releaseIndexLock(a.handle, opts);
});

// ---------------------------------------------------------------------------
// Session ordering
// ---------------------------------------------------------------------------

test('jobsForSession is ordered by startedAt asc with jobId tie-break', () => {
  const index = emptyJobIndex();
  const t0 = new Date(1000).toISOString();
  const t1 = new Date(2000).toISOString();
  const t2 = new Date(3000).toISOString();
  recordIndexedJob(index, input({ jobId: 'job-a', sessionId: 'sess', startedAt: t1 }), optionsFor());
  recordIndexedJob(index, input({ jobId: 'job-b', sessionId: 'sess', startedAt: t0 }), optionsFor());
  recordIndexedJob(index, input({ jobId: 'job-c', sessionId: 'sess', startedAt: t2 }), optionsFor());
  recordIndexedJob(index, input({ jobId: 'job-d', sessionId: 'sess', startedAt: t1 }), optionsFor());
  assert.deepEqual(jobsForSession(index, 'sess'), ['job-b', 'job-a', 'job-d', 'job-c']);
});

// ---------------------------------------------------------------------------
// Reply chains
// ---------------------------------------------------------------------------

test('replyChain returns deterministic root-to-target order; branch; cycle -> null', () => {
  const index = emptyJobIndex();
  const root = input({ jobId: 'root', status: 'succeeded' });
  const a = input({ jobId: 'a', replyToJobId: 'root', status: 'running' });
  const b = input({ jobId: 'b', replyToJobId: 'root', status: 'queued' });
  const c = input({ jobId: 'c', replyToJobId: 'a', status: 'queued' });
  for (const j of [root, a, b, c]) applyIndexedJob(index, j);

  assert.deepEqual(replyChain(index, 'c'), ['root', 'a', 'c']);
  assert.deepEqual(replyChain(index, 'root'), ['root']);
  assert.deepEqual(replyChain(index, 'unknown'), null);

  const cycA = input({ jobId: 'cycA', replyToJobId: 'cycB' });
  const cycB = input({ jobId: 'cycB', replyToJobId: 'cycA' });
  applyIndexedJob(index, cycA);
  applyIndexedJob(index, cycB);
  assert.equal(replyChain(index, 'cycA'), null);
  assert.equal(replyChain(index, 'cycB'), null);

  // dangling ancestor (missing root) -> null, no crash
  const orphan = input({ jobId: 'orphan', replyToJobId: 'nobody' });
  applyIndexedJob(index, orphan);
  assert.equal(replyChain(index, 'orphan'), null);

  // branch children lists
  assert.deepEqual(replyChildrenOf(index, 'root'), ['a', 'b']);
  assert.deepEqual(replyChildrenOf(index, 'a'), ['c']);
  assert.deepEqual(replyChildrenOf(index, 'nope'), []);
});

test('status counts match after updates and statusCountsOf is a copy', () => {
  const index = emptyJobIndex();
  const j = input({ status: 'running' });
  applyIndexedJob(index, j);
  applyIndexedJob(index, { ...j, status: 'failed' });
  const counts = statusCountsOf(index);
  assert.deepEqual(counts, { queued: 0, running: 0, needs_attention: 0, succeeded: 0, failed: 1, cancelled: 0 });
  counts.failed = 999; // must not mutate the index
  assert.equal(index.statusCounts.failed, 1);
});

// ---------------------------------------------------------------------------
// Snapshot + journal reload
// ---------------------------------------------------------------------------

test('snapshot+journal reload: rebuild then record, reload gives the same index', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  const jobs = [
    makeJob({ jobId: 'a1', status: 'succeeded', startedAt: new Date(1000).toISOString() }),
    makeJob({ jobId: 'a2', status: 'running', startedAt: new Date(2000).toISOString() }),
  ];
  const stats = rebuildIndex(jobs, opts);
  assert.deepEqual(stats, { indexed: 2, skipped: 0, archivedJournalFiles: 0 });

  const index = emptyJobIndex();
  assert.equal(recordIndexedJob(index, input({ jobId: 'a3', status: 'queued' }), opts), true);
  // snapshot stays at the rebuild records (2); journal holds the 1 delta
  assert.equal(JSON.parse(fs.readFileSync(indexSnapshotPath(dir), 'utf8')).jobs.length, 2);
  assert.equal(journalLinesFor(dir).length, 1);

  const reloaded = loadIndex(dir);
  assert.equal(reloaded.diagnostics.consistency, 'consistent');
  assert.equal(reloaded.diagnostics.snapshotLoaded, true);
  assert.equal(reloaded.diagnostics.journalApplied, 1);
  assert.equal(indexSize(reloaded.index), 3);
  assert.equal(countStatus(reloaded.index, 'running'), 1);
});

test('record() appends to the journal and never rewrites the snapshot; reload replays both', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });

  // 1) rebuild produces the snapshot; capture its bytes + mtime.
  const stats = rebuildIndex([
    makeJob({ jobId: 'b1', status: 'succeeded', startedAt: new Date(1000).toISOString() }),
    makeJob({ jobId: 'b2', status: 'running', startedAt: new Date(2000).toISOString() }),
  ], opts);
  assert.deepEqual(stats, { indexed: 2, skipped: 0, archivedJournalFiles: 0 });
  assert.equal(journalLinesFor(dir).length, 0); // post-rebuild journal starts empty
  const snapBefore = fs.statSync(indexSnapshotPath(dir));
  const bytesBefore = snapBefore.size;
  const mtimeBefore = snapBefore.mtimeMs;
  assert.ok(bytesBefore > 0);

  // 2) A run of record() calls — fresh inserts and status updates — must
  //    only append to the journal: snapshot bytes AND mtime stay unchanged.
  const index = emptyJobIndex();
  const inserted = input({ jobId: 'b3', status: 'queued' });
  const inserted2 = input({ jobId: 'b4', status: 'queued', sessionId: 's2' });
  assert.equal(recordIndexedJob(index, inserted, opts), true);
  assert.equal(recordIndexedJob(index, inserted2, opts), true);
  assert.equal(recordIndexedJob(index, { ...inserted, status: 'running' }, opts), true);
  assert.equal(recordIndexedJob(index, { ...inserted2, status: 'succeeded' }, opts), true);
  assert.equal(recordIndexedJob(index, { ...inserted, status: 'failed' }, opts), true);
  assert.equal(journalLinesFor(dir).length, 5);

  const snapAfter = fs.statSync(indexSnapshotPath(dir));
  assert.equal(snapAfter.size, bytesBefore, 'snapshot bytes changed after record()');
  assert.equal(snapAfter.mtimeMs, mtimeBefore, 'snapshot mtime changed after record()');
  const snapshotContent = fs.readFileSync(indexSnapshotPath(dir), 'utf8');
  const snapshotJobs = (JSON.parse(snapshotContent) as { jobs: unknown[] }).jobs;
  assert.equal(snapshotJobs.length, 2, 'snapshot still holds only the rebuild records');

  // 3) Reload = snapshot + journal replay: the final state is complete.
  const reloaded = loadIndex(dir);
  assert.equal(reloaded.diagnostics.consistency, 'consistent');
  assert.equal(reloaded.diagnostics.snapshotLoaded, true);
  assert.equal(reloaded.diagnostics.journalApplied, 5);
  assert.equal(indexSize(reloaded.index), 4);
  assert.equal(getIndexedJob(reloaded.index, 'b1')?.status, 'succeeded');
  assert.equal(getIndexedJob(reloaded.index, 'b2')?.status, 'running');
  assert.equal(getIndexedJob(reloaded.index, 'b3')?.status, 'failed');
  assert.equal(getIndexedJob(reloaded.index, 'b4')?.status, 'succeeded');
  assert.equal(countStatus(reloaded.index, 'succeeded'), 2);
  assert.equal(countStatus(reloaded.index, 'failed'), 1);
  assert.equal(countStatus(reloaded.index, 'queued'), 0);
  assert.equal(countStatus(reloaded.index, 'running'), 1);
});

function deltaFor(input: IndexedJobInput): string {
  return JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    jobId: input.jobId,
    sessionId: input.sessionId,
    status: input.status,
    kind: input.kind,
    replyToJobId: input.replyToJobId ?? null,
    startedAt: input.startedAt ?? '',
    endedAt: input.endedAt ?? null,
  });
}

test('truncated final journal line marks rebuild_required and keeps the prefix', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  // Snapshot contains only t1; the journal's t2 delta line is truncated.
  const stats = rebuildIndex([makeJob({ jobId: 't1', status: 'queued' })], opts);
  assert.equal(stats.indexed, 1);
  fs.writeFileSync(indexJournalPath(dir), `${deltaFor(input({ jobId: 't1', status: 'queued' }))}\n${'{"jobId":"t2","status":"running"'}`);
  const { index: loaded, diagnostics } = loadIndex(dir);
  assert.equal(diagnostics.consistency, 'rebuild_required');
  assert.equal(diagnostics.journalBadLines, 1);
  assert.ok(diagnostics.journalPrefixBytes > 0);
  assert.equal(indexSize(loaded), 1); // snapshot prefix only
  assert.equal(getIndexedJob(loaded, 't1')?.status, 'queued');
  assert.equal(getIndexedJob(loaded, 't2'), null); // truncated suffix dropped
});

test('bad JSON mid-journal marks rebuild_required and keeps only the verified prefix', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  // Snapshot contains only m1; the journal has a bad line after m1 and an
  // m3 delta after that — the suffix after the bad line must be dropped.
  const stats = rebuildIndex([makeJob({ jobId: 'm1', status: 'queued' })], opts);
  assert.equal(stats.indexed, 1);
  fs.writeFileSync(indexJournalPath(dir), [
    deltaFor(input({ jobId: 'm1', status: 'queued' })),
    '{this is not json',
    deltaFor(input({ jobId: 'm3', status: 'running' })),
    '',
  ].join('\n'));
  const { index: loaded, diagnostics } = loadIndex(dir);
  assert.equal(diagnostics.consistency, 'rebuild_required');
  assert.equal(diagnostics.journalBadLines, 1);
  assert.equal(indexSize(loaded), 1); // snapshot prefix only
  assert.equal(getIndexedJob(loaded, 'm1')?.status, 'queued');
  assert.equal(getIndexedJob(loaded, 'm3'), null); // suffix after bad line dropped
});

test('invalid schema row mid-journal is a bad line, not a crash', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  const index = emptyJobIndex();
  recordIndexedJob(index, input({ jobId: 's1', status: 'queued' }), opts);
  fs.writeFileSync(indexJournalPath(dir), [
    deltaFor(input({ jobId: 's1', status: 'queued' })),
    JSON.stringify({ schemaVersion: 1, jobId: 's2', status: 'made_up_status' }),
    '',
  ].join('\n'));
  const { index: loaded, diagnostics } = loadIndex(dir);
  assert.equal(diagnostics.consistency, 'rebuild_required');
  assert.equal(indexSize(loaded), 1);
});

// ---------------------------------------------------------------------------
// rebuild()
// ---------------------------------------------------------------------------

test('rebuild archives the old journal (never deletes) and truncates the new one', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  const index = emptyJobIndex();
  recordIndexedJob(index, input({ jobId: 'old1', status: 'queued' }), opts);
  recordIndexedJob(index, input({ jobId: 'old2', status: 'running' }), opts);
  assert.ok(journalLinesFor(dir).length >= 2);

  const jobs = [
    makeJob({ jobId: 'n1', status: 'succeeded' }),
    makeJob({ jobId: 'n2', status: 'running' }),
    makeJob({ jobId: 'bad', status: 'invalid_status' as JobStatus, startedAt: 123 as unknown as string }),
  ];
  const stats = rebuildIndex(jobs, opts);
  assert.deepEqual(stats, { indexed: 2, skipped: 1, archivedJournalFiles: 1 });

  const archived = fs.readdirSync(indexArchiveDir(dir)).filter((f) => f.startsWith('journal.') && f.endsWith('.jsonl'));
  assert.equal(archived.length, 1);
  assert.ok(JSON.parse(fs.readFileSync(path.join(indexArchiveDir(dir), archived[0]), 'utf8').split('\n')[0]).jobId);

  assert.equal(journalLinesFor(dir).length, 0);
  const reloaded = loadIndex(dir);
  assert.equal(reloaded.diagnostics.consistency, 'consistent');
  assert.equal(indexSize(reloaded.index), 2);
  assert.equal(countStatus(reloaded.index, 'succeeded'), 1);
  assert.equal(countStatus(reloaded.index, 'running'), 1);
});

test('rebuild returns exact counts and skips invalid records', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const jobs = [
    makeJob({ jobId: 'r1', status: 'succeeded' }),
    makeJob({ jobId: 'r2', status: 'failed' }),
    makeJob({ jobId: 'r3', status: 'queued' }),
    makeJob({ jobId: 'r4', status: 'bad_status' as JobStatus, startedAt: 123 as unknown as string }),
  ];
  const stats = rebuildIndex(jobs, optionsFor({ rootDir: dir }));
  assert.deepEqual(stats, { indexed: 3, skipped: 1, archivedJournalFiles: 0 });
  const reloaded = loadIndex(dir).index;
  assert.equal(indexSize(reloaded), 3);
  assert.deepEqual(statusCountsOf(reloaded), {
    queued: 1, running: 0, needs_attention: 0, succeeded: 1, failed: 1, cancelled: 0,
  });
});

// ---------------------------------------------------------------------------
// consistencyCheck()
// ---------------------------------------------------------------------------

test('consistencyCheck flags status/session/reply mismatches with counters', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const index = emptyJobIndex();
  applyIndexedJob(index, input({ jobId: 'c1', status: 'succeeded', sessionId: 'sa' }));
  applyIndexedJob(index, input({ jobId: 'c2', status: 'running', sessionId: 'sa', replyToJobId: 'c1' }));
  const jobs = [
    makeJob({ jobId: 'c1', status: 'failed', sessionId: 'sa' }), // status mismatch
    makeJob({ jobId: 'c2', status: 'running', sessionId: 'sb', replyToJobId: 'c1' }), // session mismatch
    makeJob({ jobId: 'c3', status: 'queued', sessionId: 'sb' }),  // missing from index
  ];
  const report = consistencyCheck(index, jobs);
  assert.equal(report.consistent, false);
  assert.ok(report.statusCountMismatch >= 1);
  assert.ok(report.sessionMembershipMismatch >= 1);
  assert.ok(report.replyToMismatch >= 0);
  assert.ok(report.totalMismatch >= report.statusCountMismatch + report.sessionMembershipMismatch);

  const ok = consistencyCheck(rebuildIndexForCheck(dir), jobs);
  assert.equal(ok.consistent, true);
  assert.equal(ok.totalMismatch, 0);
});

function journalLinesFor(dir: string): string[] {
  return fs.readFileSync(indexJournalPath(dir), 'utf8').split('\n').filter((l) => l.length > 0);
}

function rebuildIndexForCheck(rootDir: string): JobIndex {
  const jobs = [
    makeJob({ jobId: 'c1', status: 'failed', sessionId: 'sa' }),
    makeJob({ jobId: 'c2', status: 'running', sessionId: 'sb', replyToJobId: 'c1' }),
    makeJob({ jobId: 'c3', status: 'queued', sessionId: 'sb' }),
  ];
  rebuildIndex(jobs, optionsFor({ rootDir }));
  return loadIndex(rootDir).index;
}

// ---------------------------------------------------------------------------
// Lock contention
// ---------------------------------------------------------------------------

test('locked-index: unexpired lease returns busy without consulting the inspector', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const q: { exists: number; startTime: number } = { exists: 0, startTime: 0 };
  const spy: ProcessInspector = {
    exists: (pid: number) => {
      q.exists += 1;
      return pid === 42; // a live owner — would verify live if queried
    },
    startTime: (pid: number) => {
      q.startTime += 1;
      return pid === 42 ? baseNow - 1000 : null;
    },
  };
  // Lease still valid (expires 60s in the future) -> busy from the lease alone.
  assert.equal(indexLockStatusOf('busy', {
    pid: 42,
    startedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 1000).toISOString(),
    expiresAt: new Date(baseNow + 60_000).toISOString(),
  }, { rootDir: dir, inspector: spy }), 'busy');
  assert.deepEqual(q, { exists: 0, startTime: 0 }, 'inspector must not be consulted for an unexpired lease');
  assert.equal(fs.existsSync(indexLockPath(dir)), true, 'unexpired lease must never be stolen');
});

test('locked-index: expired lease with verified_live owner returns queued (never stolen)', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const q: { exists: number; startTime: number } = { exists: 0, startTime: 0 };
  const spy: ProcessInspector = {
    exists: (pid: number) => {
      q.exists += 1;
      return pid === 42;
    },
    startTime: (pid: number) => {
      q.startTime += 1;
      return pid === 42 ? baseNow - 1000 : null;
    },
  };
  // Lease expired but identity verifies the owner is still alive -> queued.
  assert.equal(indexLockStatusOf('queued', {
    pid: 42,
    startedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 2000).toISOString(),
    expiresAt: new Date(baseNow - 500).toISOString(),
  }, { rootDir: dir, inspector: spy }), 'queued');
  assert.ok(q.exists === 1 && q.startTime === 1, `inspector consulted exactly once for the expired lease (exists=${q.exists}, startTime=${q.startTime})`);
  assert.equal(fs.existsSync(indexLockPath(dir)), true, 'verified_live holder must never be stolen');
});

test('locked-index: expired lease with verified_dead owner is stolen (inspector consulted)', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const q: { exists: number; startTime: number } = { exists: 0, startTime: 0 };
  const spy: ProcessInspector = {
    exists: (pid: number) => {
      q.exists += 1;
      return pid === 4242 ? false : true;
    },
    startTime: (pid: number) => {
      q.startTime += 1;
      return pid === 4242 ? null : baseNow - 1;
    },
  };
  const opts = optionsFor({
    rootDir: dir,
    lockBusyMs: 2000,
    inspector: spy,
  });
  fs.mkdirSync(indexDir(dir), { recursive: true });
  // Complete real-format lock record with a dead owner (pid 4242 has no OS
  // process); write handle closed before record() — no open fd may masquerade
  // as the owner, only the inspector's verified_dead verdict may justify the
  // steal. recordIndexedJob releases the stolen lock in its finally, so after
  // the record the lock file must be gone.
  fs.writeFileSync(indexLockPath(dir), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: 'ghost',
    ownerPid: 4242,
    ownerStartedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 2000).toISOString(),
    expiresAt: new Date(baseNow - 500).toISOString(),
  }), 'utf8');
  const index = emptyJobIndex();
  const ok = recordIndexedJob(index, input({ jobId: 'd1', status: 'queued' }), opts);
  assert.equal(ok, true);
  assert.ok(q.exists === 1, `inspector consulted exactly once (exists=${q.exists}, startTime=${q.startTime})`);
  const reloaded = loadIndex(dir).index;
  assert.equal(getIndexedJob(reloaded, 'd1')?.status, 'queued');
  assert.deepEqual(jobsForSession(reloaded, 's1'), ['d1'], 'recorded job must be queryable by session');
  assert.equal(fs.existsSync(indexLockPath(dir)), false, 'dead owner lock must be gone');
});

test('locked-index: expired lease with identity_mismatch owner is stolen (inspector consulted)', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const q: { exists: number; startTime: number } = { exists: 0, startTime: 0 };
  const spy: ProcessInspector = {
    exists: (pid: number) => {
      q.exists += 1;
      return pid === 42; // pid exists...
    },
    startTime: (pid: number) => {
      q.startTime += 1;
      return pid === 42 ? baseNow - 9_000_000 : null; // ...but far older: reuse
    },
  };
  const opts = optionsFor({
    rootDir: dir,
    lockBusyMs: 2000,
    inspector: spy,
  });
  fs.mkdirSync(indexDir(dir), { recursive: true });
  // Complete real-format lock record whose owner pid was reused (start time far
  // older than the recorded identity) -> identity_mismatch, same recovery.
  // Handle closed before record(), and the stolen lock is released by
  // recordIndexedJob's finally, so after the record the lock file must be gone.
  fs.writeFileSync(indexLockPath(dir), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: 'reused-owner',
    ownerPid: 42,
    ownerStartedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 2000).toISOString(),
    expiresAt: new Date(baseNow - 500).toISOString(),
  }), 'utf8');
  const index = emptyJobIndex();
  const ok = recordIndexedJob(index, input({ jobId: 'd2', status: 'queued' }), opts);
  assert.equal(ok, true);
  assert.ok(q.exists === 1 && q.startTime === 1, `inspector consulted exactly once (exists=${q.exists}, startTime=${q.startTime})`);
  const reloaded = loadIndex(dir).index;
  assert.equal(getIndexedJob(reloaded, 'd2')?.status, 'queued');
  assert.deepEqual(jobsForSession(reloaded, 's1'), ['d2'], 'recorded job must be queryable by session');
  assert.equal(fs.existsSync(indexLockPath(dir)), false, 'mismatched-identity lock must be gone');
});

test('locked-index: expired lease with unverifiable owner fails closed on busy', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const q: { exists: number; startTime: number } = { exists: 0, startTime: 0 };
  const spy: ProcessInspector = {
    exists: (pid: number) => {
      q.exists += 1;
      return pid === 42; // exists but...
    },
    startTime: (pid: number) => {
      q.startTime += 1;
      return null; // ...creation time unreadable -> unverifiable
    },
  };
  // Lease expired but the identity cannot be established -> fail closed
  // immediately: busy, never trySteal (spy guarantees the lock file is
  // renameable, so an attempt would have succeeded).
  assert.equal(indexLockStatusOf('busy', {
    pid: 42,
    startedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 2000).toISOString(),
    expiresAt: new Date(baseNow - 500).toISOString(),
  }, { rootDir: dir, inspector: spy }), 'busy');
  assert.ok(q.exists === 1 && q.startTime === 1, `inspector consulted exactly once (exists=${q.exists}, startTime=${q.startTime})`);
  assert.equal(fs.existsSync(indexLockPath(dir)), true, 'unverifiable holder must never be stolen');
});

test('two instances on the same runtime: held lock never drops a committed delta', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  const a = emptyJobIndex();
  const b = emptyJobIndex();
  const j1 = input({ jobId: 'x1', status: 'queued' });
  assert.equal(recordIndexedJob(a, j1, opts), true);
  assert.equal(recordIndexedJob(b, j1, opts), true); // duplicate: both apply
  assert.equal(recordIndexedJob(b, { ...j1, status: 'running' }, opts), true);

  const reloaded = loadIndex(dir);
  assert.equal(indexSize(reloaded.index), 1);
  assert.equal(getIndexedJob(reloaded.index, 'x1')?.status, 'running');
  assert.equal(countStatus(reloaded.index, 'running'), 1);
  assert.equal(journalLinesFor(dir).length, 2);
});

test('dead lock holder is recovered via verified_dead identity', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({
    rootDir: dir,
    lockBusyMs: 2000,
    inspector: {
      exists: (pid: number) => pid === 4242 ? false : true,
      startTime: (pid: number) => (pid === 4242 ? baseNow - 1000 : baseNow - 1),
    },
  });
  fs.mkdirSync(indexDir(dir), { recursive: true });
  // Complete real-format lock record, write handle closed before record():
  // only the inspector's verified_dead verdict may justify stealing this lock.
  fs.writeFileSync(indexLockPath(dir), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: 'ghost',
    ownerPid: 4242,
    ownerStartedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 5000).toISOString(),
    expiresAt: new Date(baseNow - 500).toISOString(),
  }), 'utf8');
  const index = emptyJobIndex();
  const ok = recordIndexedJob(index, input({ jobId: 'r1', status: 'queued' }), opts);
  assert.equal(ok, true);
  const reloaded = loadIndex(dir).index;
  assert.equal(getIndexedJob(reloaded, 'r1')?.status, 'queued');
  assert.deepEqual(jobsForSession(reloaded, 's1'), ['r1'], 'recorded job must be queryable by session');
  assert.equal(fs.existsSync(indexLockPath(dir)), false);
});

test('live lock holder returns busy and does not archive a live lock', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({
    rootDir: dir,
    lockBusyMs: 60,
    inspector: {
      exists: (pid: number) => pid === 42,
      startTime: (pid: number) => baseNow - 1000,
    },
  });
  fs.mkdirSync(indexDir(dir), { recursive: true });
  // Same complete-format record as acquireIndexLock writes; handle closed so
  // no fd defends this lock — the unexpired lease must defend it alone.
  fs.writeFileSync(indexLockPath(dir), JSON.stringify({
    schemaVersion: INDEX_SCHEMA_VERSION,
    ownerId: 'live-owner',
    ownerPid: 42,
    ownerStartedAt: new Date(baseNow - 1000).toISOString(),
    acquiredAt: new Date(baseNow - 1000).toISOString(),
    expiresAt: new Date(baseNow + 60_000).toISOString(),
  }), 'utf8');
  const index = emptyJobIndex();
  const before = Date.now();
  const ok = recordIndexedJob(index, input({ jobId: 'l1', status: 'queued' }), opts);
  const elapsed = Date.now() - before;
  assert.equal(ok, false);
  assert.ok(elapsed <= 1500, `record() blocked too long: ${elapsed}ms`);
  assert.equal(fs.existsSync(indexLockPath(dir)), true); // live lock must survive
  assert.ok(fs.readFileSync(indexLockPath(dir), 'utf8').includes('live-owner'));
});

// ---------------------------------------------------------------------------
// Performance: 10,000 synthetic rebuild + session lookup
// ---------------------------------------------------------------------------

test('10,000 job rebuild completes in under 1000ms (own timing)', { timeout: 120_000 }, (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const jobs: Job[] = [];
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 10_000; i += 1) {
    const status = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'][i % 6] as JobStatus;
    jobs.push(makeJob({
      jobId: `perf-${String(i).padStart(5, '0')}`,
      sessionId: `perf-session-${i % 100}`,
      status,
      startedAt: new Date(t0 + i).toISOString(),
      replyToJobId: i > 0 && i % 7 === 0 ? `perf-${String(i - 1).padStart(5, '0')}` : null,
    }));
  }
  const opts = optionsFor({ rootDir: dir });
  const t1 = process.hrtime.bigint();
  const stats = rebuildIndex(jobs, opts);
  const elapsedMs = Number(process.hrtime.bigint() - t1) / 1_000_000;
  assert.equal(stats.indexed, 10_000);
  assert.equal(indexSize(loadIndex(dir).index), 10_000);
  assert.ok(elapsedMs < 1000, `single 10k rebuild took ${elapsedMs.toFixed(1)}ms (must be < 1000ms)`);
});

test('10,000 job lookup p95 < 100ms: pure jobsForSession samples after warm-up', { timeout: 120_000 }, (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const jobs: Job[] = [];
  const sessions: string[] = [];
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  for (let i = 0; i < 10_000; i += 1) {
    const s = `perf-session-${i % 100}`;
    if (!sessions.includes(s)) sessions.push(s);
    const status = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'][i % 6] as JobStatus;
    jobs.push(makeJob({
      jobId: `perf-${String(i).padStart(5, '0')}`,
      sessionId: s,
      status,
      startedAt: new Date(t0 + i).toISOString(),
      replyToJobId: i > 0 && i % 7 === 0 ? `perf-${String(i - 1).padStart(5, '0')}` : null,
    }));
  }
  const opts = optionsFor({ rootDir: dir });
  rebuildIndex(jobs, opts);
  const index = loadIndex(dir).index;

  // Warm-up: 2,000 pure lookups (results unused) so JIT/caches settle before
  // any sample is taken.
  for (let q = 0; q < 2_000; q += 1) {
    jobsForSession(index, sessions[q % sessions.length]);
  }

  // 20 timed samples, each a single pure jobsForSession query — rebuild is
  // excluded from the sample set by construction.
  const samples: number[] = [];
  for (let s = 0; s < 20; s += 1) {
    const session = sessions[s % sessions.length];
    const t1 = process.hrtime.bigint();
    const list = jobsForSession(index, session);
    samples.push(Number(process.hrtime.bigint() - t1) / 1_000_000);
    assert.ok(Array.isArray(list));
    assert.ok(list.length > 0, `session ${session} must have indexed jobs`);
  }
  samples.sort((x, y) => x - y);
  // Nearest-rank p95: the ceiling(0.95 * n)th sample of the sorted set.
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? samples[samples.length - 1];
  assert.ok(p95 < 100, `jobsForSession p95 = ${p95.toFixed(3)}ms (samples=${samples.map((x) => x.toFixed(3)).join(',')})`);
});

// ---------------------------------------------------------------------------
// No sensitive fields in any output
// ---------------------------------------------------------------------------

test('index never stores or surfaces prompt/paths/tokens/pids', (t) => {
  const dir = freshDir();
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    untrackFreshDir(dir);
  });
  trackFreshDir(dir);
  const opts = optionsFor({ rootDir: dir });
  const index = emptyJobIndex();
  const job = makeJob({
    jobId: 'sec-1',
    prompt: 'SUPER SECRET PROMPT',
    logPath: 'C:/secret/log.txt',
    reportPath: 'C:/secret/report.json',
    workFolder: 'C:/secret/work',
    pid: 12345,
    extraEnv: { TOKEN: 'sekrit' },
    replyToJobId: null,
  });
  // record() only appends to the journal and never rewrites the snapshot, so
  // rebuildIndex is what creates snapshot.json here. It also proves
  // toIndexedJob strips the secret fields at the rebuild boundary.
  assert.equal(rebuildIndex([job], opts).indexed, 1);
  // A real delta vs. the rebuild state: 'queued' -> 'running'.
  assert.equal(
    recordIndexedJob(index, {
      jobId: job.jobId,
      sessionId: job.sessionId,
      status: 'running',
      kind: job.kind,
      replyToJobId: job.replyToJobId,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    }, opts),
    true,
  );

  const snap = fs.readFileSync(indexSnapshotPath(dir), 'utf8');
  assert.ok(!snap.includes('SUPER SECRET PROMPT'));
  assert.ok(!snap.includes('C:/secret'));
  assert.ok(!snap.includes('12345'));
  assert.ok(!snap.includes('sekrit'));
  const journalRaw = fs.readFileSync(indexJournalPath(dir), 'utf8');
  assert.ok(!journalRaw.includes('SUPER SECRET'));
  assert.ok(!journalRaw.includes('C:/secret'));
  assert.ok(!journalRaw.includes('sekrit'));

  const reloaded = loadIndex(dir);
  const rec = getIndexedJob(reloaded.index, 'sec-1');
  assert.ok(rec);
  assert.equal((rec as unknown as Record<string, unknown>).prompt, undefined);
  assert.equal((rec as unknown as Record<string, unknown>).logPath, undefined);
  assert.equal((rec as unknown as Record<string, unknown>).workFolder, undefined);
  assert.equal((rec as unknown as Record<string, unknown>).pid, undefined);
  assert.equal(JSON.stringify(rec).includes('SUPER SECRET'), false);
  assert.equal(JSON.stringify(rec).includes('C:/secret'), false);
  assert.equal(JSON.stringify(rec).includes('12345'), false);
  assert.equal(JSON.stringify(rec).includes('sekrit'), false);

  const diag = loadIndex(dir).diagnostics;
  assert.ok(!JSON.stringify(diag).includes('C:/'));
  assert.ok(!JSON.stringify(diag).includes('job-index'));
  assert.ok(indexDiagnosticsSummarySafe(diag).includes('consistency='));
});

function indexDiagnosticsSummarySafe(d: { consistency: string }): string {
  return `consistency=${d.consistency}`;
}
