// test/admission.test.ts
// Wave4A admission tests: pure evaluation matrix, fail-closed validation,
// O_EXCL lease lifecycle, stale archival, owner checks, path traversal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ADMISSION_LEASE_SCHEMA_VERSION,
  AdmissionManager,
  evaluateAdmission,
  type AdmissionPolicy,
  type AdmissionRequest,
  type LiveLeaseInfo,
  type PidIdentityInspector,
} from '../src/admission.js';

// ---------- helpers ----------

let tmpSeq = 0;
function tmpRoot(): string {
  tmpSeq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `admission-test-${process.pid}-${tmpSeq}-`));
  return dir;
}

const BASE_POLICY: AdmissionPolicy = {
  desiredWorkerConcurrency: 8,
  hardSafetyCeiling: 8,
  maxHeavyWorkers: 2,
  memoryReserveMb: 0,
};

const BASE_REQUEST: AdmissionRequest = {
  jobId: 'job-a',
  resourceClass: 'light',
  backend: 'deepseek',
  profile: 'auto',
  workFolder: path.join(os.tmpdir(), 'wf-a'),
  pid: 1234,
  pidStartedAt: 1_700_000_000_000,
};

function req(over: Partial<AdmissionRequest>): AdmissionRequest {
  return { ...BASE_REQUEST, ...over };
}

/** n live leases, all same resourceClass/workFolder (or explicit override per index). */
function leases(count: number, resourceClass: AdmissionRequest['resourceClass'], folder = 'x'): LiveLeaseInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    jobId: `j${i}`,
    resourceClass,
    workFolder: path.join(os.tmpdir(), folder),
    active: true,
  }));
}

function policy(over: Partial<AdmissionPolicy>): AdmissionPolicy {
  return { ...BASE_POLICY, ...over };
}

/** Inspector where every pid is alive and every pidStartedAt matches. */
const ALIVE_MATCH: PidIdentityInspector = { isAlive: () => true, startedAtMatches: () => true };

interface ManagerFixture {
  manager: AdmissionManager;
  root: string;
}

function makeManager(over: Partial<ConstructorParameters<typeof AdmissionManager>[0]> = {}): ManagerFixture {
  const root = tmpRoot();
  const manager = new AdmissionManager({ runtimeRoot: root, ...over });
  return { manager, root };
}

function readLeaseFile(root: string, jobId: string): Record<string, unknown> | null {
  const p = path.join(root, 'admission', 'leases', `${jobId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

function listDir(root: string, sub: string): string[] {
  const p = path.join(root, 'admission', sub);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

// ---------- pure evaluation ----------

test('admission: desired=8 hard=8 admits up to 8', () => {
  const r = req({ resourceClass: 'light' });
  for (const n of [0, 7]) {
    const ev = evaluateAdmission(BASE_POLICY, r, leases(n, 'light'), { freeMemoryMb: 16_384 });
    assert.equal(ev.admitted, true, `n=${n}`);
    assert.equal(ev.reason, null);
    assert.equal(ev.active, n);
    assert.equal(ev.desired, 8);
    assert.equal(ev.resourceLimit, 8);
  }
  const ninth = evaluateAdmission(BASE_POLICY, r, leases(8, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(ninth.admitted, false);
  assert.equal(ninth.reason, 'desired_limit');
  assert.equal(ninth.active, 8);
  assert.equal(ninth.queued, 0);
});

test('admission: desired=8 hard=5 — 6th lease is hard_safety_ceiling', () => {
  const p = policy({ hardSafetyCeiling: 5 });
  const r = req({ resourceClass: 'light' });
  const fifth = evaluateAdmission(p, r, leases(4, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(fifth.admitted, true);
  assert.equal(fifth.resourceLimit, 5);
  const sixth = evaluateAdmission(p, r, leases(5, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(sixth.admitted, false);
  assert.equal(sixth.reason, 'hard_safety_ceiling');
  assert.equal(sixth.resourceLimit, 5);
});

test('admission: backend/profile scope limits are independent hard caps', () => {
  const p = policy({ backendProfileLimits: { 'deepseek/auto': 3, 'deepseek/pro': 5, qwen: 4, openai: 6 } });
  const r = req({ resourceClass: 'light', backend: 'deepseek', profile: 'auto' });
  const third = evaluateAdmission(p, r, leases(2, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(third.admitted, true);
  assert.equal(third.resourceLimit, 3);
  const fourth = evaluateAdmission(p, r, leases(3, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(fourth.admitted, false);
  assert.equal(fourth.reason, 'backend_profile_limit');

  // Same limits with a different profile/backend are untouched.
  const otherProfile = evaluateAdmission(p, req({ resourceClass: 'light', backend: 'deepseek', profile: 'pro' }), leases(4, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(otherProfile.admitted, true);
  assert.equal(otherProfile.resourceLimit, 5);
  const otherBackend = evaluateAdmission(p, req({ resourceClass: 'light', backend: 'qwen', profile: 'auto' }), leases(3, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(otherBackend.admitted, true);
  assert.equal(otherBackend.resourceLimit, 4);
});

test('admission: user desired value wins over lower defaults (never overridden by heuristics)', () => {
  const p = policy({ desiredWorkerConcurrency: 2, hardSafetyCeiling: 64, backendProfileLimits: { 'deepseek/auto': 4 } });
  const r = req({ resourceClass: 'light' });
  // Explicit desired=2 is the binding limit — the higher scope limit must not inflate it.
  const ev = evaluateAdmission(p, r, leases(2, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(ev.admitted, false);
  assert.equal(ev.reason, 'desired_limit');
  assert.equal(ev.resourceLimit, 2);
  // desired=64 with a default scope of 4 is capped at 4.
  const p2 = policy({ desiredWorkerConcurrency: 64, backendProfileLimits: { 'deepseek/auto': 4 } });
  const ev2 = evaluateAdmission(p2, r, leases(3, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(ev2.admitted, true);
  assert.equal(ev2.resourceLimit, 4);
  const ev3 = evaluateAdmission(p2, r, leases(4, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(ev3.admitted, false);
  assert.equal(ev3.reason, 'backend_profile_limit');
});

test('admission: heavy cap via maxHeavyWorkers', () => {
  const p = policy({ maxHeavyWorkers: 2, desiredWorkerConcurrency: 64, hardSafetyCeiling: 64 });
  const r = req({ resourceClass: 'heavy' });
  const second = evaluateAdmission(p, r, leases(1, 'heavy'), { freeMemoryMb: 16_384 });
  assert.equal(second.admitted, true);
  const third = evaluateAdmission(p, r, leases(2, 'heavy'), { freeMemoryMb: 16_384 });
  assert.equal(third.admitted, false);
  assert.equal(third.reason, 'heavy_limit');
  // Light workers do not consume the heavy cap.
  const lightBacked = evaluateAdmission(p, r, leases(20, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(lightBacked.admitted, true);
});

test('admission: build/heavy conflict on same canonical workFolder, not on different folders', () => {
  const p = policy({ desiredWorkerConcurrency: 64, hardSafetyCeiling: 64 });
  // leases() uses os.tmpdir()/x as the lease folder; same-folder means the
  // request's workFolder must match it exactly.
  const r = req({ resourceClass: 'build', workFolder: path.join(os.tmpdir(), 'x') });
  const sameFolder = evaluateAdmission(p, r, leases(1, 'build'), { freeMemoryMb: 16_384 });
  assert.equal(sameFolder.admitted, false);
  assert.equal(sameFolder.reason, 'derived_space_conflict');
  const differentFolder = evaluateAdmission(p, req({ resourceClass: 'build', workFolder: path.join(os.tmpdir(), 'wf-other') }), leases(1, 'build'), { freeMemoryMb: 16_384 });
  assert.equal(differentFolder.admitted, true);
  // A light lease on the same folder is not a space conflict.
  const lightOnFolder = evaluateAdmission(p, r, leases(1, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(lightOnFolder.admitted, true);
  // A build lease held by a stale (dead) lease is not a conflict — the stale
  // lease is archived first, freeing the folder.
  const staleBuild = evaluateAdmission(p, r, [{ ...leases(1, 'build')[0], active: false }], { freeMemoryMb: 16_384 });
  assert.equal(staleBuild.admitted, true);
});

test('admission: memory_reserve when free memory is below reserve', () => {
  const p = policy({ memoryReserveMb: 2_048 });
  const ev = evaluateAdmission(p, req({ resourceClass: 'light' }), [], { freeMemoryMb: 1_024 });
  assert.equal(ev.admitted, false);
  assert.equal(ev.reason, 'memory_reserve');
  const ok = evaluateAdmission(p, req({ resourceClass: 'light' }), [], { freeMemoryMb: 4_096 });
  assert.equal(ok.admitted, true);
});

test('admission: 20 light jobs produce visible decision counts', () => {
  const p = policy({ desiredWorkerConcurrency: 20, hardSafetyCeiling: 20 });
  const ev = evaluateAdmission(p, req({ resourceClass: 'light' }), leases(20, 'light'), { freeMemoryMb: 16_384 });
  assert.equal(ev.admitted, false);
  assert.equal(ev.active, 20);
  assert.equal(ev.queued, 0);
  const queued = evaluateAdmission(p, req({ resourceClass: 'light' }), [
    ...leases(8, 'light'),
    ...leases(2, 'light').map((l) => ({ ...l, active: false })),
  ], { freeMemoryMb: 16_384 });
  assert.equal(queued.active, 8);
  assert.equal(queued.queued, 2);
  assert.equal(queued.admitted, true);
});

test('admission: active/queued derived from input leases, never fabricated', () => {
  const ev = evaluateAdmission(BASE_POLICY, req({ resourceClass: 'light' }), [], { freeMemoryMb: 16_384 });
  assert.equal(ev.active, 0);
  assert.equal(ev.queued, 0);
  assert.equal(ev.admitted, true);
});

test('admission: fail closed on invalid policy', () => {
  const bad: Partial<AdmissionPolicy>[] = [
    { desiredWorkerConcurrency: 0 },
    { desiredWorkerConcurrency: 65 },
    { desiredWorkerConcurrency: 1.5 },
    { hardSafetyCeiling: 0 },
    { maxHeavyWorkers: 65 },
    { memoryReserveMb: -1 },
    { backendProfileLimits: { x: 0 } },
  ];
  for (const over of bad) {
    const ev = evaluateAdmission(policy(over), req({ resourceClass: 'light' }), [], { freeMemoryMb: 16_384 });
    assert.equal(ev.admitted, false, JSON.stringify(over));
    assert.equal(ev.reason, 'invalid_policy', JSON.stringify(over));
    assert.equal(ev.resourceLimit, 0, JSON.stringify(over));
  }
  // An empty limits map is a valid (no-op) policy, not a fail-closed error.
  const ev = evaluateAdmission(policy({ backendProfileLimits: {} }), req({ resourceClass: 'light' }), [], { freeMemoryMb: 16_384 });
  assert.equal(ev.admitted, true);
  assert.equal(ev.resourceLimit, 8);
});

test('admission: fail closed on invalid request', () => {
  const bad: Partial<AdmissionRequest>[] = [
    { jobId: '../evil' },
    { jobId: 'a/b' },
    { jobId: '' },
    { jobId: 'x'.repeat(65) },
    { resourceClass: 'massive' as AdmissionRequest['resourceClass'] },
    { backend: '' },
    { profile: '' },
    { workFolder: '' },
    { pid: 0 },
    { pidStartedAt: -5 },
  ];
  for (const over of bad) {
    const ev = evaluateAdmission(BASE_POLICY, req(over), [], { freeMemoryMb: 16_384 });
    assert.equal(ev.admitted, false, JSON.stringify(over));
    assert.equal(ev.reason, 'invalid_request', JSON.stringify(over));
  }
});

// ---------- lease lifecycle ----------

test('acquire: admits under capacity and writes a valid O_EXCL lease file', () => {
  const { manager, root } = makeManager();
  const res = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'job-a', resourceClass: 'build' }), 16_384);
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(res.staleArchived.length, 0);
  assert.ok(res.evaluation?.admitted);
  const file = readLeaseFile(root, 'job-a');
  assert.ok(file, 'lease file written');
  assert.equal(file.schemaVersion, ADMISSION_LEASE_SCHEMA_VERSION);
  assert.equal(file.jobId, 'job-a');
  assert.equal(file.resourceClass, 'build');
  assert.equal(file.workFolder, BASE_REQUEST.workFolder);
  assert.equal(file.pid, BASE_REQUEST.pid);
  assert.equal(file.pidStartedAt, BASE_REQUEST.pidStartedAt);
  for (const t of ['acquiredAt', 'heartbeatAt', 'expiresAt']) {
    assert.equal(typeof file[t], 'number');
  }
  assert.equal(res.lease?.jobId, 'job-a');
  assert.ok(!('workFolder' in (res.lease as object)), 'public lease must not leak workFolder');
  assert.ok(!('pidStartedAt' in (res.lease as object)), 'public lease must not leak pidStartedAt');
});

test('acquire: duplicate jobId is rejected without deleting the existing lease', () => {
  const { manager, root } = makeManager();
  const first = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'job-a' }), 16_384);
  assert.equal(first.ok, true);
  const dup = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'job-a' }), 16_384);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'duplicate_job');
  assert.equal(dup.evaluation?.admitted, true, 'denied only by the file-level O_EXCL guard');
  assert.ok(readLeaseFile(root, 'job-a'), 'original lease still in place');
});

test('acquire: queue reasons from the evaluation flow through the result', () => {
  const { manager } = makeManager();
  const r = req({ jobId: 'job-b' });
  for (let i = 0; i < 8; i += 1) {
    const res = manager.acquireAdmissionLease(BASE_POLICY, { ...r, jobId: `job-${i}` }, 16_384);
    assert.equal(res.ok, true, `admit ${i}`);
  }
  const denied = manager.acquireAdmissionLease(BASE_POLICY, r, 16_384);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'denied');
  assert.equal(denied.evaluation?.reason, 'desired_limit');
  assert.equal(denied.evaluation?.active, 8);
});

test('acquire: live leases are never reclaimed — only dead/unverifiable ones archive to stale', () => {
  // Inspector that can tell exactly which pids are alive: pid 4242 (dead-1) is
  // confirmed dead; keep-1/keep-2 pids (BASE_REQUEST.pid) are alive and ours.
  const { manager, root } = makeManager({
    pidIdentity: {
      isAlive: (pid: number) => (pid === 4242 ? false : pid === BASE_REQUEST.pid ? true : null),
      startedAtMatches: (pid: number) => (pid === BASE_REQUEST.pid ? true : null),
    },
  });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'alive-1' }), 16_384).ok, true);
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'alive-2' }), 16_384).ok, true);

  // Plant a lease held by a confirmed-dead pid (4242); it must be archived
  // during the next acquire, while the two live leases keep their slots.
  fs.writeFileSync(
    path.join(root, 'admission', 'leases', 'dead-1.json'),
    JSON.stringify({
      schemaVersion: 1, jobId: 'dead-1', resourceClass: 'light', backend: 'b', profile: 'p',
      workFolder: path.join(os.tmpdir(), 'wf-dead'), pid: 4242, pidStartedAt: 100,
      acquiredAt: 1, heartbeatAt: 1, expiresAt: Date.now() + 60_000,
    }),
  );

  // Sweep archived the dead lease; the two live leases still hold their slots.
  const res = manager.acquireAdmissionLease(
    BASE_POLICY,
    req({ jobId: 'after-sweep' }),
    16_384,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.staleArchived, ['dead-1']);
  // The sweep archived the dead lease during this acquire, so the live set is 2.
  assert.equal(res.evaluation?.active, 2, 'dead lease not counted');
  assert.ok(readLeaseFile(root, 'alive-1'));
  assert.ok(readLeaseFile(root, 'alive-2'));
  assert.equal(listDir(root, 'stale').length, 1, 'dead lease archived, never deleted');
  assert.equal(listDir(root, 'leases').length, 3);
});

test('acquire: dead / identity-mismatch / TTL-expired leases are archived and capacity recovers', () => {
  // keep-1/keep-2 (pid BASE_REQUEST.pid) stay verifiably alive and ours;
  // dead-1 (pid 4242) is confirmed dead; reuse-1 (pid 999) is alive but its
  // startedAt (100) does not match the current process (startedAt 200 → true,
  // so startedAtMatches(999,100) is false → identity mismatch);
  // expired-1 (pid 777) is unverifiable (null) → TTL decides → stale.
  const { manager, root } = makeManager({
    ttlMs: 60_000,
    pidIdentity: {
      isAlive: (pid: number) => (pid === 4242 ? false : pid === 999 ? true : pid === BASE_REQUEST.pid ? true : null),
      startedAtMatches: (pid: number, startedAt: number) =>
        pid === 999 ? startedAt === 100 ? false : null : pid === BASE_REQUEST.pid ? true : null,
    },
  });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'keep-1' }), 16_384).ok, true);
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'keep-2' }), 16_384).ok, true);

  // dead pid
  fs.writeFileSync(
    path.join(root, 'admission', 'leases', 'dead-1.json'),
    JSON.stringify({
      schemaVersion: 1, jobId: 'dead-1', resourceClass: 'light', backend: 'b', profile: 'p',
      workFolder: path.join(os.tmpdir(), 'wf-dead'), pid: 4242, pidStartedAt: 100,
      acquiredAt: 1, heartbeatAt: 1, expiresAt: Date.now() + 60_000,
    }),
  );
  // pid alive but startedAt mismatch (PID reuse)
  fs.writeFileSync(
    path.join(root, 'admission', 'leases', 'reuse-1.json'),
    JSON.stringify({
      schemaVersion: 1, jobId: 'reuse-1', resourceClass: 'light', backend: 'b', profile: 'p',
      workFolder: path.join(os.tmpdir(), 'wf-reuse'), pid: 999, pidStartedAt: 100,
      acquiredAt: 1, heartbeatAt: 1, expiresAt: Date.now() + 60_000,
    }),
  );
  // expired, unverifiable (inspector says unknown)
  fs.writeFileSync(
    path.join(root, 'admission', 'leases', 'expired-1.json'),
    JSON.stringify({
      schemaVersion: 1, jobId: 'expired-1', resourceClass: 'light', backend: 'b', profile: 'p',
      workFolder: path.join(os.tmpdir(), 'wf-expired'), pid: 777, pidStartedAt: 200,
      acquiredAt: 1, heartbeatAt: 1, expiresAt: Date.now() - 1_000,
    }),
  );

  // Plant all three stale leases BEFORE any acquire runs; the acquire that
  // follows sweeps them in one pass (this manager never sees pre-planted stales).
  const res = manager.acquireAdmissionLease(
    BASE_POLICY,
    req({ jobId: 'new-job' }),
    16_384,
  );
  assert.equal(res.ok, true);
  assert.deepEqual(res.staleArchived.sort(), ['dead-1', 'expired-1', 'reuse-1']);
  assert.equal(res.evaluation?.active, 2, 'only the live leases counted');
  assert.deepEqual(listDir(root, 'stale').sort(), ['dead-1.json', 'expired-1.json', 'reuse-1.json']);
  assert.deepEqual(listDir(root, 'leases').sort(), ['keep-1.json', 'keep-2.json', 'new-job.json']);
});

test('acquire: corrupt lease JSON is archived to stale and never counts as capacity', () => {
  const { manager, root } = makeManager({ pidIdentity: ALIVE_MATCH });
  const bad = path.join(root, 'admission', 'leases', 'corrupt-1.json');
  fs.writeFileSync(bad, '{ not json');
  const res = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'good-1' }), 16_384);
  assert.equal(res.ok, true);
  assert.deepEqual(res.staleArchived, ['corrupt-1']);
  assert.equal(res.evaluation?.active, 0);
  assert.equal(listDir(root, 'stale').length, 1);
});

test('acquire: verifiably-live lease past its TTL is kept (identity beats TTL)', () => {
  const { manager, root } = makeManager({ pidIdentity: ALIVE_MATCH, ttlMs: 1_000, now: () => 5_000 });
  const res = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'long-runner' }), 16_384);
  assert.equal(res.ok, true);
  // Simulate the file ageing past TTL; the live identity still keeps it.
  const p = path.join(root, 'admission', 'leases', 'long-runner.json');
  const lease = JSON.parse(fs.readFileSync(p, 'utf8')) as { expiresAt: number };
  lease.expiresAt = 100;
  fs.writeFileSync(p, JSON.stringify(lease));
  const second = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'second' }), 16_384);
  assert.equal(second.ok, true);
  assert.deepEqual(second.staleArchived, []);
  assert.equal(second.evaluation?.active, 1);
  assert.equal(listDir(root, 'stale').length, 0);
});

test('heartbeat: extends TTL only for the matching owner', () => {
  // Injectable clock that the test can advance.
  let nowMs = 1_000;
  const { manager, root } = makeManager({ now: () => nowMs });
  const r = req({ jobId: 'hb-1', pid: 100, pidStartedAt: 50 });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, r, 16_384).ok, true);
  const before = readLeaseFile(root, 'hb-1') as { heartbeatAt: number; expiresAt: number };

  // Advance the injected clock past the TTL so the heartbeat observably extends the lease.
  nowMs = 70_000;
  const ok = manager.heartbeatLease({ jobId: 'hb-1', pid: 100, pidStartedAt: 50 });
  assert.equal(ok.ok, true);
  const after = readLeaseFile(root, 'hb-1') as { heartbeatAt: number; expiresAt: number };
  assert.ok(after.heartbeatAt > before.heartbeatAt);
  assert.ok(after.expiresAt > before.expiresAt);

  const wrongPid = manager.heartbeatLease({ jobId: 'hb-1', pid: 101, pidStartedAt: 50 });
  assert.deepEqual(wrongPid, { ok: false, jobId: 'hb-1', reason: 'owner_mismatch' });
  const wrongStart = manager.heartbeatLease({ jobId: 'hb-1', pid: 100, pidStartedAt: 999 });
  assert.deepEqual(wrongStart, { ok: false, jobId: 'hb-1', reason: 'owner_mismatch' });
  const missing = manager.heartbeatLease({ jobId: 'nope', pid: 100, pidStartedAt: 50 });
  assert.deepEqual(missing, { ok: false, jobId: 'nope', reason: 'lease_not_found' });
});

test('release: moves the lease to released/ (audit trail) and owner-checks', () => {
  const { manager, root } = makeManager();
  const r = req({ jobId: 'rel-1', pid: 200, pidStartedAt: 70 });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, r, 16_384).ok, true);

  // Owner checks first — the lease must still exist for a mismatch to be reported.
  const wrongPid = manager.releaseLease({ jobId: 'rel-1', pid: 201, pidStartedAt: 70 });
  assert.deepEqual(wrongPid, { ok: false, jobId: 'rel-1', reason: 'owner_mismatch' });
  const wrongStart = manager.releaseLease({ jobId: 'rel-1', pid: 200, pidStartedAt: 71 });
  assert.deepEqual(wrongStart, { ok: false, jobId: 'rel-1', reason: 'owner_mismatch' });
  const missing = manager.releaseLease({ jobId: 'ghost', pid: 200, pidStartedAt: 70 });
  assert.deepEqual(missing, { ok: false, jobId: 'ghost', reason: 'lease_not_found' });

  // Correct owner releases: lease moves to released/ (audit trail, never deleted).
  assert.equal(manager.releaseLease({ jobId: 'rel-1', pid: 200, pidStartedAt: 70 }).ok, true);
  assert.equal(listDir(root, 'released').length, 1);
  assert.equal(listDir(root, 'leases').length, 0);
  const file = JSON.parse(fs.readFileSync(path.join(root, 'admission', 'released', 'rel-1.json'), 'utf8')) as { pid: number };
  assert.equal(file.pid, 200, 'lease content preserved in released/');
});

test('transferLeaseOwner: hands the lease to the next owner under the global lock', () => {
  let nowMs = 10_000;
  const { manager, root } = makeManager({ now: () => nowMs });
  const r = req({ jobId: 'tr-1', pid: 100, pidStartedAt: 50 });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, r, 16_384).ok, true);
  const before = readLeaseFile(root, 'tr-1') as { acquiredAt: number; heartbeatAt: number; expiresAt: number; pid: number; pidStartedAt: number };

  // Advance the injected clock past the TTL so the refresh is observable.
  nowMs = 70_000;
  const res = manager.transferLeaseOwner({ jobId: 'tr-1', pid: 100, pidStartedAt: 50 }, { jobId: 'tr-1', pid: 200, pidStartedAt: 90 });
  assert.equal(res.ok, true);
  assert.equal(res.jobId, 'tr-1');
  assert.equal(res.pid, 200);
  assert.equal(res.pidStartedAt, 90);
  assert.equal(res.acquiredAt, before.acquiredAt, 'acquiredAt must be preserved');
  assert.equal(res.heartbeatAt, 70_000, 'heartbeatAt refreshed');
  assert.equal(res.expiresAt, 70_000 + 60_000, 'expiresAt refreshed with the TTL');

  const after = readLeaseFile(root, 'tr-1') as {
    acquiredAt: number; heartbeatAt: number; expiresAt: number; pid: number; pidStartedAt: number;
    workFolder: string; resourceClass: string; backend: string; profile: string;
  };
  assert.equal(after.pid, 200);
  assert.equal(after.pidStartedAt, 90);
  assert.equal(after.acquiredAt, before.acquiredAt);
  assert.ok(after.heartbeatAt > before.heartbeatAt);
  assert.ok(after.expiresAt > before.expiresAt);
  assert.equal(after.workFolder, r.workFolder, 'workFolder preserved');
  assert.equal(after.resourceClass, 'light');
  assert.equal(after.backend, 'deepseek');
  assert.equal(after.profile, 'auto');
  assert.equal(listDir(root, 'leases').length, 1, 'lease stays in leases/, never moved or deleted');
  assert.equal(listDir(root, 'released').length, 0);
  assert.equal(listDir(root, 'stale').length, 0);

  // Old owner's heartbeat and release are now rejected; new owner's succeed.
  const oldHb = manager.heartbeatLease({ jobId: 'tr-1', pid: 100, pidStartedAt: 50 });
  assert.deepEqual(oldHb, { ok: false, jobId: 'tr-1', reason: 'owner_mismatch' });
  const oldRel = manager.releaseLease({ jobId: 'tr-1', pid: 100, pidStartedAt: 50 });
  assert.deepEqual(oldRel, { ok: false, jobId: 'tr-1', reason: 'owner_mismatch' });
  const newHb = manager.heartbeatLease({ jobId: 'tr-1', pid: 200, pidStartedAt: 90 });
  assert.equal(newHb.ok, true);
  const newRel = manager.releaseLease({ jobId: 'tr-1', pid: 200, pidStartedAt: 90 });
  assert.equal(newRel.ok, true);
  assert.equal(listDir(root, 'leases').length, 0);
  assert.equal(listDir(root, 'released').length, 1);
});

test('transferLeaseOwner: wrong current owner is rejected and the lease is untouched', () => {
  const { manager, root } = makeManager();
  const r = req({ jobId: 'tr-2', pid: 100, pidStartedAt: 50 });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, r, 16_384).ok, true);
  const before = readLeaseFile(root, 'tr-2');

  const wrongPid = manager.transferLeaseOwner({ jobId: 'tr-2', pid: 101, pidStartedAt: 50 }, { jobId: 'tr-2', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(wrongPid, { ok: false, jobId: 'tr-2', reason: 'owner_mismatch' });
  const wrongStart = manager.transferLeaseOwner({ jobId: 'tr-2', pid: 100, pidStartedAt: 999 }, { jobId: 'tr-2', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(wrongStart, { ok: false, jobId: 'tr-2', reason: 'owner_mismatch' });
  const wrongBoth = manager.transferLeaseOwner({ jobId: 'tr-2', pid: 101, pidStartedAt: 999 }, { jobId: 'tr-2', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(wrongBoth, { ok: false, jobId: 'tr-2', reason: 'owner_mismatch' });

  // Lease file byte-identical after every rejection; never deleted or moved.
  assert.deepEqual(readLeaseFile(root, 'tr-2'), before, 'lease untouched by rejected transfers');
  assert.equal(listDir(root, 'leases').length, 1);
  assert.equal(listDir(root, 'released').length, 0);
  assert.equal(listDir(root, 'stale').length, 0);
});

test('transferLeaseOwner: invalid next owner is rejected without touching the lease', () => {
  const { manager, root } = makeManager();
  const r = req({ jobId: 'tr-3', pid: 100, pidStartedAt: 50 });
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, r, 16_384).ok, true);
  const before = readLeaseFile(root, 'tr-3');

  const wrongJob = manager.transferLeaseOwner({ jobId: 'tr-3', pid: 100, pidStartedAt: 50 }, { jobId: 'other', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(wrongJob, { ok: false, jobId: 'tr-3', reason: 'invalid_next_owner' });
  const badPid = manager.transferLeaseOwner({ jobId: 'tr-3', pid: 100, pidStartedAt: 50 }, { jobId: 'tr-3', pid: 0, pidStartedAt: 90 });
  assert.deepEqual(badPid, { ok: false, jobId: 'tr-3', reason: 'invalid_next_owner' });
  const badPidStart = manager.transferLeaseOwner({ jobId: 'tr-3', pid: 100, pidStartedAt: 50 }, { jobId: 'tr-3', pid: 200, pidStartedAt: -1 });
  assert.deepEqual(badPidStart, { ok: false, jobId: 'tr-3', reason: 'invalid_next_owner' });
  const badNextJobId = manager.transferLeaseOwner({ jobId: 'tr-3', pid: 100, pidStartedAt: 50 }, { jobId: '../escape', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(badNextJobId, { ok: false, jobId: 'tr-3', reason: 'invalid_next_owner' });

  assert.deepEqual(readLeaseFile(root, 'tr-3'), before, 'lease untouched by invalid transfers');
  assert.equal(listDir(root, 'leases').length, 1);
});

test('transferLeaseOwner: missing lease, bad lease file and invalid job id are fixed reasons', () => {
  const { manager, root } = makeManager();
  const missing = manager.transferLeaseOwner({ jobId: 'ghost', pid: 100, pidStartedAt: 50 }, { jobId: 'ghost', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(missing, { ok: false, jobId: 'ghost', reason: 'lease_not_found' });

  fs.writeFileSync(path.join(root, 'admission', 'leases', 'corrupt.json'), 'garbage');
  const bad = manager.transferLeaseOwner({ jobId: 'corrupt', pid: 100, pidStartedAt: 50 }, { jobId: 'corrupt', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(bad, { ok: false, jobId: 'corrupt', reason: 'bad_lease_file' });

  const badJobId = manager.transferLeaseOwner({ jobId: '../escape', pid: 100, pidStartedAt: 50 }, { jobId: '../escape', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(badJobId, { ok: false, jobId: '../escape', reason: 'invalid_job_id' });

  // The corrupt file is never touched by a failed transfer (no deletion, no move).
  assert.equal(fs.readFileSync(path.join(root, 'admission', 'leases', 'corrupt.json'), 'utf8'), 'garbage');
  assert.equal(listDir(root, 'stale').length, 0);
  assert.equal(listDir(root, 'released').length, 0);
});

test('transferLeaseOwner: lock_busy is a structured result when the global lock is held', () => {
  const { manager, root } = makeManager({ lockMaxWaitMs: 50, pidIdentity: { isAlive: () => true, startedAtMatches: () => true } });
  fs.mkdirSync(path.join(root, 'admission'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'admission', 'lease.lock'),
    JSON.stringify({ pid: 999_997, createdAt: Date.now() }),
  );
  const res = manager.transferLeaseOwner({ jobId: 'busy-tr', pid: 100, pidStartedAt: 50 }, { jobId: 'busy-tr', pid: 200, pidStartedAt: 90 });
  assert.deepEqual(res, { ok: false, jobId: 'busy-tr', reason: 'lock_busy' });
  assert.equal(fs.existsSync(path.join(root, 'admission', 'lease.lock')), true, 'foreign lock left in place');
});

test('listLiveLeases: returns only strictly-validated, sanitized leases', () => {
  const { manager, root } = makeManager();
  assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'l-1' }), 16_384).ok, true);
  // Plant a corrupt file and a bad-schema file — both must be excluded.
  fs.writeFileSync(path.join(root, 'admission', 'leases', 'junk.json'), 'garbage');
  fs.writeFileSync(
    path.join(root, 'admission', 'leases', 'oldschema.json'),
    JSON.stringify({
      schemaVersion: 0, jobId: 'oldschema', resourceClass: 'light', backend: 'b', profile: 'p',
      workFolder: 'x', pid: 1, pidStartedAt: 1, acquiredAt: 1, heartbeatAt: 1, expiresAt: 1,
    }),
  );
  const live = manager.listLiveLeases();
  assert.equal(live.length, 1);
  assert.equal(live[0].jobId, 'l-1');
  assert.ok(!('workFolder' in live[0]));
  assert.ok(!('pidStartedAt' in live[0]));
  assert.equal(live[0].schemaVersion, ADMISSION_LEASE_SCHEMA_VERSION);
  assert.equal(live[0].pid, BASE_REQUEST.pid);
});

test('lock busy: lock_busy is a structured result when the O_EXCL lock is held', () => {
  const { manager, root } = makeManager({ lockMaxWaitMs: 50, pidIdentity: { isAlive: () => true, startedAtMatches: () => true } });
  fs.mkdirSync(path.join(root, 'admission'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'admission', 'lease.lock'),
    JSON.stringify({ pid: 999_999, createdAt: Date.now() }),
  );
  const res = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'busy-1' }), 16_384);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'lock_busy');
  assert.equal(res.lease, null);
  assert.equal(res.staleArchived.length, 0);
  assert.equal(res.evaluation, null);
});

test('lock: verifiably-dead lock holder is reaped and admission proceeds', () => {
  const { manager, root } = makeManager({
    lockMaxWaitMs: 500,
    pidIdentity: { isAlive: (pid: number) => (pid === 999_998 ? false : null), startedAtMatches: () => null },
  });
  fs.mkdirSync(path.join(root, 'admission'), { recursive: true });
  fs.writeFileSync(path.join(root, 'admission', 'lease.lock'), JSON.stringify({ pid: 999_998, createdAt: Date.now() }));
  const res = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'reap-1' }), 16_384);
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
});

test('acquire: invalid request / policy / jobId fail closed before any lock or file touch', () => {
  const { manager, root } = makeManager();
  const badJobId = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: '../escape' }));
  assert.equal(badJobId.ok, false);
  assert.equal(badJobId.reason, 'invalid_job_id');
  const badPolicy = manager.acquireAdmissionLease(policy({ desiredWorkerConcurrency: 0 }), req({ jobId: 'ok-1' }));
  assert.equal(badPolicy.ok, false);
  assert.equal(badPolicy.reason, 'invalid_policy');
  const badReq = manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: 'ok-2', pid: 0 }));
  assert.equal(badReq.ok, false);
  assert.equal(badReq.reason, 'invalid_request');
  // Nothing was written and no lock was left behind.
  assert.deepEqual(listDir(root, 'leases'), []);
  assert.equal(fs.existsSync(path.join(root, 'admission', 'lease.lock')), false);
});

test('acquire: concurrent subprocesses racing for the last slot — exactly one wins', () => {
  const { manager, root } = makeManager();
  for (let i = 0; i < 7; i += 1) {
    assert.equal(manager.acquireAdmissionLease(BASE_POLICY, req({ jobId: `pre-${i}` }), 16_384).ok, true);
  }
  // The compiled module is at dist-test/src/admission.js; resolve it relative to this test's dir.
  const moduleUrl = new URL('../src/admission.js', import.meta.url).href;
  const inline = `
    import { AdmissionManager } from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const manager = new AdmissionManager({ runtimeRoot: root, lockMaxWaitMs: 2000 });
    const res = manager.acquireAdmissionLease(
      { desiredWorkerConcurrency: 8, hardSafetyCeiling: 8, maxHeavyWorkers: 2, memoryReserveMb: 0 },
      { jobId: 'race-1', resourceClass: 'light', backend: 'deepseek', profile: 'auto',
        workFolder: ${JSON.stringify(path.join(os.tmpdir(), 'wf-race'))},
        pid: ${process.pid}, pidStartedAt: 1 },
      16384,
    );
    console.log(JSON.stringify(res));
  `;
  const run = (): string =>
    execFileSync(process.execPath, ['--input-type=module', '-e', inline], { encoding: 'utf8', timeout: 30_000 }).trim();
  const [a, b] = [run(), run()];
  const pa = JSON.parse(a) as { ok: boolean };
  const pb = JSON.parse(b) as { ok: boolean };
  const winners = [pa.ok, pb.ok].filter(Boolean).length;
  assert.equal(winners, 1, `expected exactly one winner, got ${winners}: ${a} / ${b}`);
  const loser = [pa, pb].find((r) => !r.ok);
  assert.ok(loser, 'one loser expected');
  assert.equal((loser as { reason?: string }).reason, 'denied');
});
