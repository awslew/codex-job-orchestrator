// Unit tests for the read-only health/version/reload diagnostics (Stage 3,
// hardened in Stage 5).
//
// Stage 5 changes:
//   - reloadRequired is now decided by a deterministic full-production-module
//     fingerprint (computeBuildFingerprint over dist/), NOT the entry-only
//     hash. A change to a dependency module with an unchanged entry triggers
//     reload_required (covered here).
//   - duplicate_instance_suspected / registry_stale are REAL diagnostics fed by
//     the instance registry snapshot, never fabricated and never "deferred".
//   - The legacy entry-only buildHash fields are kept for backward compat.
//
// Wave 5A2b additions:
//   - runtime.jobIndex is an additive health section (enabled/consistency/
//     dirty/indexSize/jobFileCount/rebuildScheduled; fixed fields, no paths).
//     With the JobIndex flag ON the job counts come from the cached index
//     (never a per-file scan); flag-off keeps the legacy scan and reports
//     consistency 'disabled'.
//   - A missing/corrupt/disagreeing index makes health schedule ONE async
//     rebuild (never a synchronous block) and report rebuildScheduled=true;
//     the next health call sees consistent counts.
//   - computeHealth uses computeBuildFingerprintCached: the full content hash
//     is reused while the per-file (relative path, size, mtimeMs) signature is
//     unchanged, and recomputed on any modify/add/remove. The raw deterministic
//     computeBuildFingerprint is unchanged and remains the reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rt = path.join(os.tmpdir(), `orc-health-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;

import {
  computeHealth,
  computeBuildFingerprint,
  computeBuildFingerprintCached,
  invalidateHealthCachesForTests,
  fingerprintHashCalls,
  healthJobFileReads,
  legacyScanEnabled,
  sha256File,
  packageVersion,
  type RegistryHealthView,
} from '../src/health.js';
import { distDir, jobsDir } from '../src/config.js';
import { invalidateJobIndexForTests, rebuildJobIndexNow, scheduleJobIndexRebuild, scheduleJobIndexRebuildTestHooks, type Job, type JobIndexHealthSnapshot } from '../src/job-store.js';

let seedSeq = 0;
function nextSeedId(prefix: string): string {
  seedSeq += 1;
  return `${prefix}-${seedSeq}`;
}

/** A complete, VALID job record (passes isValidJobRecord/listJobs) so the
 *  job index can actually mirror it. Mirrors test/job-index.test.ts makeJob. */
function makeJob(over: Partial<Job> = {}): Job {
  const jobId = nextSeedId('job');
  const now = new Date().toISOString();
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
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    exitCode: null,
    logPath: path.join(rt, 'x.log'),
    stderrLogPath: path.join(rt, 'x.err.log'),
    reportPath: path.join(rt, 'x.report.json'),
    prompt: 'SECRET PROMPT',
    lastOutputAt: null,
    ...over,
  };
}

function makeEntry(content: string): string {
  const f = path.join(rt, 'entry.js');
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

const REGISTERED = ['claude_code_health', 'claude_code_watch', 'claude_code_status', 'claude_code_reply', 'claude_code_start'];

function healthyFingerprint(): string {
  return computeBuildFingerprint(distDir());
}

function baseOpts(over: Partial<Parameters<typeof computeHealth>[0]> = {}) {
  const entry = makeEntry('const A = 1;\n');
  return {
    entryPath: entry,
    loadedBuildHash: sha256File(entry),
    loadedBuildFingerprint: healthyFingerprint(),
    startedAt: Date.now(),
    registeredTools: REGISTERED,
    version: '1.0.0',
    ...over,
  };
}

function fakeRegistry(over: Partial<RegistryHealthView> = {}): RegistryHealthView {
  return {
    enabled: true,
    instanceId: 'inst-1',
    recorded: true,
    lastHeartbeatAt: new Date().toISOString(),
    heartbeatMs: 10_000,
    staleAfterMs: 30_000,
    instanceCount: 1,
    liveCount: 1,
    staleCount: 0,
    staleReasons: {},
    duplicateInstanceSuspected: false,
    registryStale: false,
    error: null,
    ...over,
  };
}

test('loaded fingerprint == disk fingerprint -> reloadRequired=false, diagnostic healthy/current', () => {
  const fp = healthyFingerprint();
  const v = computeHealth(baseOpts({ loadedBuildFingerprint: fp }));
  assert.equal(v.reloadRequired, false);
  assert.equal(v.diagnostic, 'healthy/current');
  assert.equal(v.loaded.buildFingerprint, fp);
  assert.equal(v.disk.buildFingerprint, fp);
});

test('entry bytes unchanged but a dependency module changed -> reload_required (Stage 5 blind-spot fix)', () => {
  // Loaded fingerprint captures the CURRENT disk module set.
  const fp = healthyFingerprint();
  const v = computeHealth(baseOpts({ loadedBuildFingerprint: fp }));
  assert.equal(v.reloadRequired, false);
  // Now simulate an old process that loaded a build whose DEPENDENCY differed
  // while the entry bytes were identical: the loaded fingerprint is stale even
  // though the entry hash matches.
  const staleLoadedFp = healthyFingerprint() + 'ff'; // differs from disk fingerprint
  const v2 = computeHealth(baseOpts({ loadedBuildHash: sha256File(makeEntry('const A = 1;\n')), loadedBuildFingerprint: staleLoadedFp }));
  assert.equal(v2.reloadRequired, true, 'dep change must trigger reload even with unchanged entry');
  assert.equal(v2.diagnostic, 'reload_required');
  assert.ok(
    v2.notes.some((n) => n.includes('dependency module') && n.includes('full-build fingerprint')),
    'note explains the entry-only blind spot',
  );
});

test('loaded fingerprint empty -> hash_unavailable + reloadRequired=true (cannot prove health)', () => {
  const v = computeHealth(baseOpts({ loadedBuildFingerprint: '' }));
  assert.equal(v.diagnostic, 'hash_unavailable');
  assert.equal(v.reloadRequired, true);
  assert.ok(v.notes.some((n) => n.includes('readable') && n.includes('rebuild')), 'advice tells to check readability/rebuild then reload');
  assert.equal(v.loaded.buildFingerprint, '');
});

test('disk fingerprint empty (unreadable module set) -> hash_unavailable + reloadRequired=true', () => {
  // computeBuildFingerprint returns '' for a missing/unreadable directory.
  assert.equal(computeBuildFingerprint(path.join(rt, 'no-such-dist')), '');
  const v = computeHealth(baseOpts({ loadedBuildFingerprint: '' }));
  assert.equal(v.disk.buildFingerprint, healthyFingerprint(), 'real dist is readable here');
  assert.equal(v.diagnostic, 'hash_unavailable');
  assert.equal(v.reloadRequired, true);
});

test('legacy entry-only buildHash fields stay available and unreadable entry yields empty hash', () => {
  const missing = path.join(rt, 'missing-entry.js');
  const v = computeHealth(baseOpts({ entryPath: missing, loadedBuildHash: '' }));
  assert.equal(v.disk.buildHash, '', 'unreadable entry yields empty legacy buildHash');
  assert.equal(typeof v.loaded.buildHash, 'string');
  assert.ok(!JSON.stringify(v).includes('ENOENT'), 'must not leak the raw exception message');
});

test('capabilities come from in-process registration facts, not disk source', () => {
  const full = computeHealth(baseOpts());
  assert.ok(full.capabilities.tools.includes('claude_code_watch'));
  assert.ok(full.capabilities.tools.includes('claude_code_health'));
  assert.equal(full.capabilities.structuredAttentionDetail, true, 'watch+status present -> structured attention exposed');
  assert.equal(full.capabilities.responseAudit, true, 'reply present -> response audit exposed');
  assert.deepEqual(full.capabilities.tools, [...REGISTERED].sort());

  const partial = computeHealth(baseOpts({ registeredTools: ['claude_code_list'] }));
  assert.equal(partial.capabilities.structuredAttentionDetail, false);
  assert.equal(partial.capabilities.responseAudit, false);
});

test('health output does not leak env/prompt/token/raw log/complete command line', () => {
  process.env.ORCHESTRATOR_TEST_SECRET = 'super-secret-value-123';
  const v = computeHealth(baseOpts({ registry: fakeRegistry() }));
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('super-secret-value-123'), 'must not leak env values');
  assert.ok(!raw.includes('PROXY_MANAGED'), 'must not leak auth token');
  assert.ok(!('prompt' in v), 'no prompt field');
  assert.ok(!('token' in v), 'no token field');
  assert.ok(!('env' in v), 'no env field');
  assert.ok(!('command' in v), 'no complete command line');
  assert.equal(v.instance.entry, 'entry.js');
  assert.equal(v.loaded.entry, 'entry.js');
  assert.equal(v.disk.entry, 'entry.js');
  assert.ok(!path.isAbsolute(v.runtime.runtimeDir), 'runtimeDir must be a basename');
});

test('registry diagnostics: duplicate_instance_suspected and registry_stale are real, structured, coexistable', () => {
  const dup = computeHealth(
    baseOpts({
      registry: fakeRegistry({ instanceCount: 2, liveCount: 2, duplicateInstanceSuspected: true }),
    }),
  );
  assert.equal(dup.duplicateInstanceSuspected, true);
  assert.equal(dup.registryStale, false);
  assert.equal(dup.diagnostic, 'healthy/current', 'build diagnostic stays healthy while duplicate is flagged');
  assert.ok(dup.diagnostics.some((d) => d.code === 'duplicate_instance_suspected' && d.severity === 'warning'));

  const stale = computeHealth(
    baseOpts({
      registry: fakeRegistry({
        staleCount: 2,
        registryStale: true,
        staleReasons: { heartbeat_timeout: 1, identity_mismatch: 1 },
      }),
    }),
  );
  assert.equal(stale.registryStale, true);
  assert.equal(stale.duplicateInstanceSuspected, false);
  assert.ok(stale.diagnostics.some((d) => d.code === 'registry_stale'));
  const d = stale.diagnostics.find((x) => x.code === 'registry_stale');
  assert.match(d?.detail ?? '', /heartbeat_timeout:1/);
  assert.match(d?.detail ?? '', /identity_mismatch:1/);
  assert.ok(!JSON.stringify(stale).includes(rt), 'stale-reason detail must not leak paths');

  // Build reload + instance stale can coexist (no single-enum information loss).
  const both = computeHealth(
    baseOpts({
      loadedBuildFingerprint: 'x'.repeat(64),
      registry: fakeRegistry({ staleCount: 1, registryStale: true, staleReasons: { pid_not_found: 1 } }),
    }),
  );
  assert.equal(both.diagnostic, 'reload_required');
  assert.equal(both.registryStale, true);
  const codes = both.diagnostics.map((x) => x.code).sort();
  assert.deepEqual(codes, ['registry_stale', 'reload_required']);
});

test('registry omitted -> inert registry section with a clear note', () => {
  const v = computeHealth(baseOpts());
  assert.equal(v.registry.enabled, false);
  assert.equal(v.registry.instanceCount, 0);
  assert.equal(v.duplicateInstanceSuspected, false);
  assert.equal(v.registryStale, false);
  assert.ok(v.notes.some((n) => n.includes('not enabled')));
});

test('job counts are read-only (no dir creation) and reflect on-disk jobs', () => {
  const missing = computeHealth(baseOpts({ registeredTools: [] }));
  assert.equal(missing.runtime.jobCounts.total, 0);
  assert.equal(fs.existsSync(path.join(rt, 'jobs')), false, 'health must not create runtime dirs');

  const jobsDir = path.join(rt, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  for (const [name, status] of [
    ['a.json', 'running'],
    ['b.json', 'needs_attention'],
    ['c.json', 'succeeded'],
    ['c.done.json', 'succeeded'], // done marker must be excluded from total
  ] as const) {
    fs.writeFileSync(path.join(jobsDir, name), JSON.stringify({ status }), 'utf8');
  }
  const v = computeHealth(baseOpts({ registeredTools: [] }));
  assert.equal(v.runtime.jobCounts.total, 3);
  assert.equal(v.runtime.jobCounts.running, 1);
  assert.equal(v.runtime.jobCounts.needs_attention, 1);
  assert.equal(v.runtime.jobCounts.succeeded, 1);
});

test('packageVersion reads package.json as single source', () => {
  assert.equal(packageVersion(), '1.0.0');
});

test('sha256File returns empty string for a missing file', () => {
  assert.equal(sha256File(path.join(rt, 'does-not-exist.js')), '');
});

// ---------------------------------------------------------------------------
// computeBuildFingerprint: deterministic full-module-set root hash.
// ---------------------------------------------------------------------------

function writeModuleDir(files: Record<string, string>): string {
  const dir = path.join(rt, `fp-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

test('fingerprint is deterministic for the same module set', () => {
  const dir = writeModuleDir({ 'index.js': 'const A=1;', 'scheduler.js': 'const B=2;' });
  assert.equal(computeBuildFingerprint(dir), computeBuildFingerprint(dir));
});

test('fingerprint changes when a DEPENDENCY module changes even if index.js is byte-identical', () => {
  const dir = writeModuleDir({ 'index.js': 'const A=1;', 'scheduler.js': 'const B=2;' });
  const before = computeBuildFingerprint(dir);
  fs.writeFileSync(path.join(dir, 'scheduler.js'), 'const B=3;', 'utf8'); // dep changed, entry unchanged
  const after = computeBuildFingerprint(dir);
  assert.notEqual(after, before, 'dep change must change the fingerprint');
});

test('fingerprint changes when a module is added or removed', () => {
  const dir = writeModuleDir({ 'index.js': 'const A=1;' });
  const before = computeBuildFingerprint(dir);
  fs.writeFileSync(path.join(dir, 'new-module.js'), 'const C=1;', 'utf8');
  assert.notEqual(computeBuildFingerprint(dir), before, 'adding a module changes the fingerprint');
  fs.unlinkSync(path.join(dir, 'new-module.js'));
  assert.equal(computeBuildFingerprint(dir), before, 'removing it restores the fingerprint');
});

test('fingerprint is order-independent (sorted paths)', () => {
  const a = writeModuleDir({ 'b.js': 'x', 'a.js': 'y' });
  const b = writeModuleDir({ 'a.js': 'y', 'b.js': 'x' });
  assert.equal(computeBuildFingerprint(a), computeBuildFingerprint(b));
});

test('fingerprint of an empty directory is a stable, non-empty hash', () => {
  const dir = writeModuleDir({});
  assert.equal(computeBuildFingerprint(dir).length, 64);
});

// ---------------------------------------------------------------------------
// Wave 5A2b: runtime.jobIndex health section + JobIndex-flagged job counts.
// ---------------------------------------------------------------------------

// This test file runs with ORCHESTRATOR_RUNTIME pointed at a fresh temp dir
// and the default env (flag OFF). Each test flips the flag explicitly for its
// runtime context; flag-on tests restore the OFF default afterwards, so the
// legacy-scan tests above keep asserting flag-off behavior.
async function withJobIndexFlag(flagOn: boolean, fn: () => void | Promise<void>): Promise<void> {
  const prevFlag = process.env.ORCHESTRATOR_RETENTION_V2;
  if (flagOn) process.env.ORCHESTRATOR_RETENTION_V2 = '1';
  else delete process.env.ORCHESTRATOR_RETENTION_V2;
  try {
    await fn(); // callers await this helper, so an async body runs to completion
  } finally {
    if (prevFlag === undefined) delete process.env.ORCHESTRATOR_RETENTION_V2;
    else process.env.ORCHESTRATOR_RETENTION_V2 = prevFlag;
  }
}

async function flushScheduledRebuild(): Promise<void> {
  // The queued rebuild runs on setImmediate; one await lets it finish.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Job-status histogram from the index counts, plus the total. */
function expectedCounts(statusCounts: JobIndexHealthSnapshot['statusCounts']): Record<string, number> {
  return { total: statusCounts.queued + statusCounts.running + statusCounts.needs_attention + statusCounts.succeeded + statusCounts.failed + statusCounts.cancelled, ...statusCounts };
}

function seedJobs(count: number): void {
  const dir = jobsDir();
  fs.mkdirSync(dir, { recursive: true });
  const statuses = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'] as const;
  for (let i = 0; i < count; i += 1) {
    const job = makeJob({ status: statuses[i % statuses.length] });
    fs.writeFileSync(path.join(dir, `${job.jobId}.json`), JSON.stringify(job), 'utf8');
  }
}

/** Drop every leftover job file and the job-index directory from the shared
 *  runtime root so each Wave5A2b test starts from a clean, known state. */
function resetRuntimeState(): void {
  const dir = jobsDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.join(dir, '..', 'job-index'), { recursive: true, force: true });
  invalidateJobIndexForTests();
}

test('Wave5A2b: flag off -> runtime.jobIndex.consistency=disabled, legacy scan counts, jobFileCount from stat-only listing', () => {
  withJobIndexFlag(false, () => {
    resetRuntimeState();
    seedJobs(6); // one per status
    const v = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v.runtime.jobCounts.total, 6, 'flag off keeps the legacy per-file scan');
    assert.equal(v.runtime.jobCounts.running, 1);
    assert.equal(v.runtime.jobCounts.succeeded, 1);
    assert.equal(v.runtime.jobIndex.enabled, false);
    assert.equal(v.runtime.jobIndex.consistency, 'disabled');
    assert.equal(v.runtime.jobIndex.indexSize, 0);
    assert.equal(v.runtime.jobIndex.dirty, false);
    assert.equal(v.runtime.jobIndex.jobFileCount, 6, 'jobFileCount is the stat-only listing count');
    assert.equal(v.runtime.jobIndex.rebuildScheduled, false, 'flag off never schedules');
  });
});

test('Wave5A2b: flag on -> jobCounts come from the consistent index counts; jobIndex section is additive and non-sensitive', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    seedJobs(3); // statuses: queued, running, needs_attention
    // Index the three seed files (their content is minimal, so the mirror
    // path may or may not pick them up — the authoritative rebuild guarantees
    // the index matches the files before the health assertions).
    rebuildJobIndexNow();

    const v = computeHealth(baseOpts({ registeredTools: [] }));
    const ji = v.runtime.jobIndex;
    assert.equal(ji.enabled, true);
    assert.equal(ji.consistency, 'consistent');
    assert.equal(ji.dirty, false);
    assert.equal(ji.indexSize, 3);
    assert.equal(ji.jobFileCount, 3);
    assert.deepEqual(v.runtime.jobCounts, expectedCounts({ queued: 1, running: 1, needs_attention: 1, succeeded: 0, failed: 0, cancelled: 0 }), 'counts come from the index, matching the files');
    assert.equal(ji.rebuildScheduled, false, 'consistent + matching sizes never schedule');

    // Additive section only; the fixed field set carries no paths or ids.
    assert.deepEqual(Object.keys(ji).sort(), ['consistency', 'dirty', 'enabled', 'indexSize', 'jobFileCount', 'rebuildScheduled']);
    assert.ok(!JSON.stringify(ji).includes('C:\\'), 'no paths in the jobIndex section');
    assert.ok(!JSON.stringify(ji).includes('job-index'), 'no index-dir names in the jobIndex section');
    assert.ok(!JSON.stringify(v).includes(rt), 'no absolute runtime path in the health view');
  });
});

test('Wave5A2b: missing index -> first health schedules ONE async rebuild and reports rebuildScheduled; second health sees consistent counts', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    seedJobs(2);
    assert.ok(!fs.existsSync(path.join(jobsDir(), '..', 'job-index')), 'no index before health');

    const v1 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v1.runtime.jobIndex.enabled, true);
    assert.equal(v1.runtime.jobIndex.consistency, 'missing');
    assert.equal(v1.runtime.jobIndex.rebuildScheduled, true, 'first health reports the scheduled rebuild');
    assert.equal(v1.runtime.jobCounts.total, 0, 'counts are still the pre-rebuild cache view (never a sync rebuild)');

    await flushScheduledRebuild();
    const v2 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v2.runtime.jobIndex.consistency, 'consistent', 'the async rebuild made the index consistent');
    assert.equal(v2.runtime.jobIndex.rebuildScheduled, false);
    assert.equal(v2.runtime.jobIndex.indexSize, 2);
    assert.equal(v2.runtime.jobIndex.jobFileCount, 2);
    assert.deepEqual(v2.runtime.jobCounts.total, 2, 'second health sees consistent counts');
  });
});

test('Wave5A2b: legacy scan (flag off) reads every job file; the read counter is per-scan', () => {
  withJobIndexFlag(false, () => {
    resetRuntimeState();
    invalidateHealthCachesForTests();
    seedJobs(4);
    computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(healthJobFileReads(), 4, 'flag off reads each job file exactly once');
    invalidateHealthCachesForTests();
    computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(healthJobFileReads(), 4, 'a fresh scan reads the same 4 files');
  });
});

test('Wave5A2b: health never reads job file contents when the index is enabled', () => {
  withJobIndexFlag(true, () => {
    resetRuntimeState();
    invalidateHealthCachesForTests();
    seedJobs(2);
    rebuildJobIndexNow();
    computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(healthJobFileReads(), 0, 'index counts are O(1) cache reads, not file reads');
  });
});

test('Wave5A2b: missing index + job count mismatch -> only ONE schedule across repeated health calls until the rebuild completes', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    scheduleJobIndexRebuildTestHooks.alreadyScheduled = false;
    try {
      seedJobs(1);
      // First health: missing index -> schedules.
      const v1 = computeHealth(baseOpts({ registeredTools: [] }));
      assert.equal(v1.runtime.jobIndex.rebuildScheduled, true);
      assert.equal(scheduleJobIndexRebuildTestHooks.alreadyScheduled, true, 'health queued exactly one rebuild');
      // Repeated health calls while the rebuild is still queued must NOT
      // schedule again (the public flag stays true, the hook count stays 1).
      for (let i = 0; i < 3; i += 1) {
        const v = computeHealth(baseOpts({ registeredTools: [] }));
        assert.equal(v.runtime.jobIndex.rebuildScheduled, true, `still queued at call ${i + 2}`);
      }
      assert.equal(scheduleJobIndexRebuildTestHooks.alreadyScheduled, true, 'no duplicate scheduling');
      await flushScheduledRebuild();
      const v2 = computeHealth(baseOpts({ registeredTools: [] }));
      assert.equal(v2.runtime.jobIndex.rebuildScheduled, false);
      assert.equal(v2.runtime.jobIndex.consistency, 'consistent');
    } finally {
      scheduleJobIndexRebuildTestHooks.alreadyScheduled = undefined;
    }
  });
});

test('Wave5A2b: mirror gap (index behind the job files) -> health schedules once; after the rebuild the counts agree', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    seedJobs(1);
    rebuildJobIndexNow(); // consistent index over the one seeded job
    // A VALID job file written WITHOUT the mirror path (direct disk write)
    // leaves the cached index smaller than the file count. The health pass
    // cannot know about the write path's dirty flag (this write never went
    // through the mirror), but the size mismatch is the same observable
    // signal: schedule a rebuild and surface the gap.
    const extra = makeJob({ status: 'running' });
    fs.writeFileSync(path.join(jobsDir(), `${extra.jobId}.json`), JSON.stringify(extra), 'utf8');

    const v1 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v1.runtime.jobIndex.indexSize, 1);
    assert.equal(v1.runtime.jobIndex.jobFileCount, 2);
    assert.equal(v1.runtime.jobIndex.rebuildScheduled, true, 'size mismatch schedules a rebuild');
    assert.equal(v1.runtime.jobCounts.total, 1, 'no sync rebuild during health');

    await flushScheduledRebuild();
    const v2 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v2.runtime.jobIndex.indexSize, 2);
    assert.equal(v2.runtime.jobIndex.jobFileCount, 2);
    assert.equal(v2.runtime.jobIndex.rebuildScheduled, false);
    assert.equal(v2.runtime.jobCounts.total, 2, 'counts now match the files');
  });
});

test('Wave5A2b: corrupt journal -> health schedules once (rebuild_required); after flush the counts are consistent', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    seedJobs(1);
    rebuildJobIndexNow(); // consistent index over the seed file; journal is empty
    // Corrupt the journal tail; the health pass must detect the change via the
    // stat-only check and reload (never rebuild synchronously).
    const journal = path.join(jobsDir(), '..', 'job-index', 'journal.jsonl');
    fs.appendFileSync(journal, '{corrupt}\n', 'utf8');

    const v1 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v1.runtime.jobIndex.consistency, 'rebuild_required');
    assert.equal(v1.runtime.jobIndex.rebuildScheduled, true);
    assert.ok(fs.existsSync(journal), 'health never archives/rebuilds synchronously');

    await flushScheduledRebuild();
    const v2 = computeHealth(baseOpts({ registeredTools: [] }));
    assert.equal(v2.runtime.jobIndex.consistency, 'consistent');
    assert.equal(v2.runtime.jobIndex.indexSize, 1);
    assert.equal(v2.runtime.jobCounts.total, 1);
  });
});

// ---------------------------------------------------------------------------
// Wave 5A2b: computeBuildFingerprintCached — reuse on unchanged signature,
// recompute on any modify/add/remove. The raw computeBuildFingerprint is the
// unchanged deterministic reference; the cached variant must agree with it.
// fingerprintHashCalls() counts full content-hash computations (test-only).
// ---------------------------------------------------------------------------

function fpSetup(files: Record<string, string>): string {
  const dir = writeModuleDir(files);
  invalidateHealthCachesForTests(); // also resets the hash counter
  return dir;
}

test('Wave5A2b: cached fingerprint reuses the hash when the module set is unchanged (no file re-hash)', () => {
  const dir = fpSetup({ 'index.js': 'const A=1;', 'scheduler.js': 'const B=2;' });
  const c1 = computeBuildFingerprintCached(dir);
  assert.equal(c1, computeBuildFingerprint(dir), 'cached value equals the raw deterministic fingerprint');
  assert.equal(fingerprintHashCalls(), 1, 'first call computes the full hash once');
  const c2 = computeBuildFingerprintCached(dir);
  assert.equal(c2, c1);
  assert.equal(fingerprintHashCalls(), 1, 'unchanged signature must not re-hash any file');
});

test('Wave5A2b: modifying a module invalidates the cache and recomputes the full hash', () => {
  const dir = fpSetup({ 'index.js': 'const A=1;', 'scheduler.js': 'const B=2;' });
  const c1 = computeBuildFingerprintCached(dir);
  // Same-size writes can land on the same mtime tick (Windows mtime
  // resolution), so use a DIFFERENT length to force a signature change.
  fs.writeFileSync(path.join(dir, 'scheduler.js'), 'const B = 3; // modified', 'utf8');
  const before = fingerprintHashCalls();
  const c2 = computeBuildFingerprintCached(dir);
  assert.notEqual(c2, c1, 'modifying a dependency module changes the fingerprint');
  assert.equal(c2, computeBuildFingerprint(dir), 'the recomputed value still matches the raw reference');
  assert.ok(fingerprintHashCalls() > before, 'the change was re-hashed');
});

test('Wave5A2b: adding or removing a module invalidates the cache', () => {
  const dir = fpSetup({ 'index.js': 'const A=1;' });
  const c1 = computeBuildFingerprintCached(dir);
  fs.writeFileSync(path.join(dir, 'new-module.js'), 'const C=1;', 'utf8');
  assert.notEqual(computeBuildFingerprintCached(dir), c1, 'adding a module changes the fingerprint');
  fs.unlinkSync(path.join(dir, 'new-module.js'));
  const c3 = computeBuildFingerprintCached(dir);
  assert.equal(c3, c1, 'removing it restores the fingerprint');
  assert.equal(c3, computeBuildFingerprint(dir));
});

test('Wave5A2b: cached fingerprint is invalidated when the signature is invalid (unreadable module)', () => {
  const dir = fpSetup({ 'index.js': 'const A=1;' });
  const c1 = computeBuildFingerprintCached(dir);
  // Windows cannot make a regular file unreadable (no chmod), so make the
  // WHOLE module set unreachable: the directory rename makes both the
  // signature and the raw fingerprint uncomputable -> hash_unavailable.
  const moved = path.join(rt, `fp-moved-${Math.random().toString(36).slice(2)}`);
  fs.renameSync(dir, moved);
  assert.equal(computeBuildFingerprintCached(dir), '', 'unreachable module set yields hash_unavailable');
  // Restore: the cache entry was dropped, so the next call recomputes.
  fs.renameSync(moved, dir);
  assert.equal(computeBuildFingerprintCached(dir), c1, 'after restoration the fingerprint is correct again');
});

// ---------------------------------------------------------------------------
// Wave 5A2b: 10,000-job synthetic index — 20 computeHealth calls under 1s p95
// with zero job-file content reads (read-count hook).
// ---------------------------------------------------------------------------

function syntheticJobs(count: number): Job[] {
  const statuses = ['queued', 'running', 'needs_attention', 'succeeded', 'failed', 'cancelled'] as const;
  const jobs: Job[] = [];
  for (let i = 0; i < count; i += 1) {
    jobs.push(
      makeJob({
        jobId: `perf-${String(i).padStart(5, '0')}`,
        sessionId: `perf-session-${i % 100}`,
        status: statuses[i % statuses.length],
        startedAt: new Date(1_767_225_600_000 + i).toISOString(),
      }),
    );
  }
  return jobs;
}

test('Wave5A2b: 10,000-job index -> 20 computeHealth calls p95 < 1000ms with zero job-file reads', async () => {
  await withJobIndexFlag(true, async () => {
    resetRuntimeState();
    scheduleJobIndexRebuildTestHooks.alreadyScheduled = false;
    try {
      // Seed the jobs dir with 10,000 real job files and let the async
      // rebuild (scheduled by health) index them once.
      const dir = jobsDir();
      fs.mkdirSync(dir, { recursive: true });
      for (const j of syntheticJobs(10_000)) {
        fs.writeFileSync(path.join(dir, `${j.jobId}.json`), JSON.stringify(j), 'utf8');
      }
      const v0 = computeHealth(baseOpts({ registeredTools: [] }));
      assert.equal(v0.runtime.jobIndex.rebuildScheduled, true, 'first health schedules the index build');
      await flushScheduledRebuild();
      // Warm the build-fingerprint cache (one full content-hash computation
      // happens here, before sampling) so the sampled calls prove reuse.
      computeHealth(baseOpts({ registeredTools: [] }));
      const fpBaseline = fingerprintHashCalls();

      const samples: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        const t = performance.now();
        const v = computeHealth(baseOpts({ registeredTools: [] }));
        samples.push(performance.now() - t);
        assert.equal(v.runtime.jobIndex.enabled, true);
        assert.equal(v.runtime.jobIndex.consistency, 'consistent');
        assert.equal(v.runtime.jobIndex.indexSize, 10_000);
        assert.equal(v.runtime.jobCounts.total, 10_000, 'counts come from the index');
        assert.equal(healthJobFileReads(), 0, 'computeHealth must never read job file contents');
        assert.equal(fingerprintHashCalls(), fpBaseline, 'the cached build fingerprint is fully warm during sampling');
      }
      samples.sort((a, b) => a - b);
      const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
      assert.ok(p95 < 1000, `20 computeHealth calls p95 = ${p95}ms (samples=${samples.map((s) => s.toFixed(1)).join(',')})`);
    } finally {
      scheduleJobIndexRebuildTestHooks.alreadyScheduled = undefined;
    }
  });
});
