// Pure-injection admission tests. No real supervisor, no fake claude, no
// waitForFinalized, no Get-Process: every spawn/launch is a fake identity
// returned by admissionPumpTestHooks, so the suite is hermetic, synchronous
// and fast. Controller matrix coverage (priority/hard5/heavy/derived/spawn
// transfer failure) lives in the controller suite — not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startJob, recoverJobs, pumpAdmissionQueueOnce, admissionPumpTestHooks } from '../src/scheduler.js';
import { atomicWriteJson, jobFilePath, readJob, type Job } from '../src/job-store.js';
import type { StartParams } from '../src/router.js';

const ADMISSION_FLAG = 'ORCHESTRATOR_ADMISSION_CONTROL';

// Every env key this suite writes (runtime, admission flag, viewer, jitter,
// memory reserve) is captured up front and restored exactly on each cleanup
// path — a key that did not exist before must be deleted again, never set.
const ENV_KEYS = [
  ADMISSION_FLAG,
  'ORCHESTRATOR_RUNTIME',
  'ORCHESTRATOR_START_JITTER_MAX_MS',
  'OPEN_LIVE_VIEW',
  'ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

function setFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[ADMISSION_FLAG];
  else process.env[ADMISSION_FLAG] = value;
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

// One isolated runtime dir per test case (each test sets its own env).
function freshRuntime(): string {
  const rt = path.join(os.tmpdir(), `orc-sched-adm-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(rt, { recursive: true });
  // startJob validates that each distinct workFolder exists on disk.
  for (const sub of ['wa', 'wb', 'wc']) fs.mkdirSync(path.join(rt, sub), { recursive: true });
  process.env.ORCHESTRATOR_RUNTIME = rt;
  process.env.ORCHESTRATOR_ADMISSION_CONTROL = '1';
  process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';
  process.env.OPEN_LIVE_VIEW = '0';
  // Admission policy reads the machine's live free memory; pin the reserve to
  // 0 so these tests never depend on the ambient free memory of the box.
  process.env.ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB = '0';
  return rt;
}

function fakeParams(rt: string, over: Partial<StartParams> & { desiredWorkerConcurrency?: number | null } = {}): StartParams & { desiredWorkerConcurrency?: number | null } {
  return {
    prompt: 'fake task',
    workFolder: rt,
    profile: 'auto',
    parallelism: 'auto',
    maxRuntimeMinutes: 120,
    claudeCli: path.join(rt, 'nonexistent-claude'),
    claudePrefix: [],
    ...over,
  };
}

function fakeIdentity(): { pid: number; pidStartedAt: number } {
  // The real process's own identity, re-derived per call: pid is the current
  // process.pid and pidStartedAt is the process start time in ms (from
  // Date.now() minus the process uptime). Each call returns a fresh object;
  // no fabricated random pids.
  return { pid: process.pid, pidStartedAt: Math.floor(Date.now() - process.uptime() * 1000) };
}

// Seams installed per test; t.after restores hooks and env and removes the dir.
function installHooks(): { launchCount: number; spawnCount: number } {
  const counters = { launchCount: 0, spawnCount: 0 };
  admissionPumpTestHooks.spawnSupervisor = () => {
    counters.spawnCount += 1;
    return fakeIdentity();
  };
  admissionPumpTestHooks.launch = (candidate) => {
    counters.launchCount += 1;
    const identity = admissionPumpTestHooks.spawnSupervisor!(candidate.jobId);
    if (identity === null) throw new Error('forced spawn failure');
    return identity;
  };
  return counters;
}

function clearHooks(): void {
  admissionPumpTestHooks.spawnSupervisor = undefined;
  admissionPumpTestHooks.launch = undefined;
  admissionPumpTestHooks.beforePump = undefined;
}

// A bare queued record written straight to the store (no scheduler call) — the
// recovery test needs an admission-waiting job that never passed startJob.
function writeQueuedJob(rt: string): Job {
  fs.mkdirSync(path.join(rt, 'wq'), { recursive: true });
  const job: Job = {
    jobId: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'sess',
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15670,
    permissionMode: 'default',
    parallelism: 'auto',
    workFolder: path.join(rt, 'wq'),
    maxRuntimeMinutes: 120,
    pid: null,
    supervisorPid: null,
    status: 'queued',
    substatus: 'admission_wait',
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: new Date().toISOString(),
    exitCode: null,
    logPath: '',
    stderrLogPath: '',
    reportPath: '',
    prompt: 'fake task',
    lastOutputAt: null,
    queuedAt: new Date().toISOString(),
    admissionState: 'queued',
    admissionQueueReason: 'desired_limit',
    desiredWorkerConcurrency: 1,
  };
  atomicWriteJson(jobFilePath(job.jobId), job);
  return job;
}

// 1) flag off: spawnSupervisor hook records one call; the start record carries
// no admission persistence fields; nothing waits for a terminal state.
test('flag off: hook identity, no admission fields, no terminal wait', (t) => {
  const rt = freshRuntime();
  const counters = installHooks();
  setFlag('0');
  t.after(() => {
    clearHooks();
    restoreEnv();
    fs.rmSync(rt, { recursive: true, force: true });
  });
  const { job } = startJob(fakeParams(rt));
  assert.equal(counters.spawnCount, 1, 'spawnSupervisor hook called exactly once');
  const stored = readJob(job.jobId)!;
  assert.equal(stored.admissionState, undefined, 'no admissionState on a legacy record');
  assert.equal(stored.admittedAt, undefined, 'no admittedAt on a legacy record');
  assert.equal(stored.desiredWorkerConcurrency, undefined, 'no explicit desired concurrency on a legacy record');
});

// 2) flag on, desired=1, two distinct workFolders: after one pump path exactly
// one is active and one is queued with reason desired_limit; the explicit
// desired is persisted; parallelism does not change the desired.
test('flag on desired=1: one active, one queued desired_limit, explicit desired persisted', (t) => {
  const rt = freshRuntime();
  const counters = installHooks();
  t.after(() => {
    clearHooks();
    restoreEnv();
    fs.rmSync(rt, { recursive: true, force: true });
  });
  const a = startJob(fakeParams(rt, { workFolder: path.join(rt, 'wa'), desiredWorkerConcurrency: 1 }));
  const b = startJob(fakeParams(rt, { workFolder: path.join(rt, 'wb'), desiredWorkerConcurrency: 1 }));
  // startJob's inline pump already decided both: a is active, b waits because
  // desired=1 is saturated. A second pump re-evaluates the same state and must
  // not re-admit or re-launch anything.
  const { admitted, queued } = pumpAdmissionQueueOnce();
  assert.equal(admitted, 0, 'no new admission this pass — desired already saturated');
  assert.equal(queued, 1, 'the waiting candidate stays queued');
  const ra = readJob(a.job.jobId)!;
  const rb = readJob(b.job.jobId)!;
  assert.equal(ra.admissionState, 'active', 'first candidate admitted');
  assert.equal(rb.admissionState, 'queued', 'second candidate waits');
  assert.equal(rb.admissionQueueReason, 'desired_limit', 'fixed queue reason');
  assert.equal(rb.desiredWorkerConcurrency, 1, 'explicit desired persisted on the queued record');
  assert.equal(ra.desiredWorkerConcurrency, 1, 'explicit desired persisted on the active record');
  assert.ok(counters.launchCount >= 1 && counters.launchCount <= 2, 'launch only via the pump (inline passes)');
});

// 3) invalid desired values are fixed parameter errors (0, 65, 1.5).
test('invalid desiredWorkerConcurrency 0/65/1.5 fails start', (t) => {
  const rt = freshRuntime();
  const counters = installHooks();
  t.after(() => {
    clearHooks();
    restoreEnv();
    fs.rmSync(rt, { recursive: true, force: true });
  });
  for (const bad of [0, 65, 1.5]) {
    assert.throws(
      () => startJob(fakeParams(rt, { desiredWorkerConcurrency: bad })),
      /desiredWorkerConcurrency must be an integer in 1\.\.64/,
      `desired ${String(bad)} rejected`,
    );
  }
  assert.equal(counters.launchCount, 0, 'no launch for invalid params');
});

// 4) a cancel-led skipped pass never launches; two consecutive passes never
// re-launch an already-active job.
test('no launch for cancelled/active jobs across pumps', (t) => {
  const rt = freshRuntime();
  const counters = installHooks();
  t.after(() => {
    clearHooks();
    restoreEnv();
    fs.rmSync(rt, { recursive: true, force: true });
  });
  const { job } = startJob(fakeParams(rt, { desiredWorkerConcurrency: 1 }));
  const first = pumpAdmissionQueueOnce();
  assert.equal(first.admitted, 0, 'already admitted — nothing new admitted');
  const before = counters.launchCount;
  const second = pumpAdmissionQueueOnce();
  assert.equal(second.admitted, 0, 'second pass admits nothing');
  assert.equal(counters.launchCount, before, 'no re-launch of the active job');
  const { job: cancelled } = startJob(fakeParams(rt, { workFolder: path.join(rt, 'wc'), desiredWorkerConcurrency: 1 }));
  const record = readJob(cancelled.jobId)!;
  record.status = 'cancelled';
  record.substatus = null;
  atomicWriteJson(jobFilePath(record.jobId), record);
  // A cancelled job leaves the candidate set (status filter) — it is never
  // admitted, and the launch hook is never called for it.
  const { admitted } = pumpAdmissionQueueOnce();
  assert.equal(admitted, 0, 'cancelled job is not admitted');
  assert.equal(counters.launchCount, before, 'no launch for the cancelled job');
});

// 5) recoverJobs reports admission_wait as a skip and never spawns; the pump
// admits it afterwards via the fake launch.
test('recoverJobs skips admission_wait; the pump restores it', (t) => {
  const rt = freshRuntime();
  const counters = installHooks();
  const queued = writeQueuedJob(rt);
  t.after(() => {
    clearHooks();
    restoreEnv();
    fs.rmSync(rt, { recursive: true, force: true });
  });
  const report = recoverJobs();
  assert.ok(
    report.diagnostics.some((d) => d.startsWith(`${queued.jobId}:admission_wait_skip`)),
    'recovery reports admission_wait_skip',
  );
  assert.equal(report.spawned, 0, 'recovery never spawns');
  assert.equal(counters.launchCount, 0, 'no launch during recovery');
  assert.equal(readJob(queued.jobId)!.admissionState, 'queued', 'still admission-waiting after recovery');
  const { admitted } = pumpAdmissionQueueOnce();
  assert.equal(admitted, 1, 'pump admits the restored candidate');
  assert.ok(counters.launchCount >= 1, 'fake launch ran in the pump');
  assert.equal(readJob(queued.jobId)!.admissionState, 'active', 'job admitted by the pump');
});
