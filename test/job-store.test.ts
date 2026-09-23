import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Isolate runtime state per test-file process before any config function call.
const rt = path.join(os.tmpdir(), `orc-jobstore-${process.pid}-${Date.now()}`);
process.env.ORCHESTRATOR_RUNTIME = rt;

import {
  newJobId,
  newSessionId,
  atomicWriteJson,
  atomicWriteTestHooks,
  readJob,
  updateJob,
  updateJobIf,
  createJobRecord,
  listJobs,
  writeReport,
  appendLog,
  appendStderrLog,
  readLogTail,
  toPublicView,
  inspectDeliverable,
  jobFilePath,
  doneFilePath,
  reportFilePath,
  logFilePath,
  stderrLogFilePath,
  jobsDir,
  jobStateLockFilePath,
  acquireJobStateLock,
  releaseJobStateLock,
  parseDoneMarker,
  toGateSummary,
  CONTRACT_V2_SCHEMA_VERSION,
  ensureJobIndex,
  indexedJobIdsForSession,
  indexedStatusCounts,
  peekJobIndexForHealth,
  scheduleJobIndexRebuild,
  scheduleJobIndexRebuildTestHooks,
  rebuildJobIndexNow,
  invalidateJobIndexForTests,
  type AtomicWriteTestHooks,
  type DoneMarker,
  type Job,
  type JobStatus,
  type JobAcceptanceStatus,
  type TaskContractV2,
} from '../src/job-store.js';
import type { AdmissionQueueReason } from '../src/admission.js';
import type { ProcessInspector } from '../src/registry.js';
import { indexDir, indexJournalPath, loadIndex, statusCountsOf } from '../src/job-index.js';

function makeJob(): Job {
  return {
    jobId: newJobId(),
    sessionId: newSessionId(),
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
    logPath: logFilePath('x'),
    stderrLogPath: stderrLogFilePath('x'),
    reportPath: reportFilePath('x'),
    prompt: 'SECRET PROMPT',
    lastOutputAt: null,
  };
}

// Runs fn with fault-injection hooks installed, then restores the previous
// hooks. node:test runs tests in a file sequentially, so the shared hooks
// object is safe as long as every test restores it.
function withHooks(hooks: Partial<AtomicWriteTestHooks>, fn: () => void): void {
  const prev: AtomicWriteTestHooks = { ...atomicWriteTestHooks };
  Object.assign(atomicWriteTestHooks, hooks, { sleep: hooks.sleep ?? (() => {}) });
  try {
    fn();
  } finally {
    atomicWriteTestHooks.beforeRename = prev.beforeRename;
    atomicWriteTestHooks.beforeUnlink = prev.beforeUnlink;
    atomicWriteTestHooks.sleep = prev.sleep;
  }
}

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

function tmpLeftovers(): string[] {
  const dir = jobsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
}

test('create/read/update are atomic and persistent across reads', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read1 = readJob(j.jobId);
  assert.ok(read1);
  assert.equal(read1.prompt, 'SECRET PROMPT');

  updateJob(j.jobId, { status: 'running', pid: 1234 });
  const read2 = readJob(j.jobId);
  assert.equal(read2?.status, 'running');
  assert.equal(read2?.pid, 1234);
  assert.equal(read2?.prompt, 'SECRET PROMPT');

  // No leftover tmp files after atomic write.
  const leftovers = fs.readdirSync(rt).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('readJob returns null for missing job', () => {
  assert.equal(readJob('does-not-exist'), null);
});

test('updateJob returns null for missing job', () => {
  assert.equal(updateJob('does-not-exist', { status: 'failed' }), null);
});

test('listJobs sorts newest first and respects limit', () => {
  // Isolate this assertion in its own runtime dir: other tests in this file
  // also write job files into the shared rt, and their real "now" startedAt
  // would outrank the fixed timestamps below.
  const fresh = path.join(os.tmpdir(), `orc-list-${process.pid}-${Date.now()}`);
  process.env.ORCHESTRATOR_RUNTIME = fresh;
  try {
    const a = makeJob();
    const b = makeJob();
    a.startedAt = '2026-08-11T00:00:01.000Z';
    b.startedAt = '2026-08-11T00:00:02.000Z';
    atomicWriteJson(jobFilePath(a.jobId), a);
    atomicWriteJson(jobFilePath(b.jobId), b);
    const list = listJobs(1);
    assert.equal(list.length, 1);
    assert.equal(list[0].jobId, b.jobId);
  } finally {
    process.env.ORCHESTRATOR_RUNTIME = rt;
  }
});

test('public view never exposes the stored prompt', () => {
  const j = makeJob();
  const v = toPublicView(j);
  assert.ok(!JSON.stringify(v).includes('SECRET PROMPT'));
  assert.ok('jobId' in v && 'sessionId' in v && 'status' in v);
});

test('done marker can be written and read via file existence', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  atomicWriteJson(doneFilePath(j.jobId), { jobId: j.jobId, status: 'succeeded', exitCode: 0 });
  assert.ok(fs.existsSync(doneFilePath(j.jobId)));
});

test('report and log helpers write and read back', () => {
  const j = makeJob();
  writeReport(j.jobId, 'short report');
  assert.ok(fs.existsSync(reportFilePath(j.jobId)));
  appendLog(j.jobId, 'a'.repeat(100) + 'TAIL');
  const tail = readLogTail(j.jobId, 10);
  assert.ok(tail.endsWith('TAIL'));
});

test('stderr log helper writes to the separate stderr file', () => {
  const j = makeJob();
  appendLog(j.jobId, '{"type":"result","result":"DONE"}\n');
  appendStderrLog(j.jobId, '===== claude exit code=0 status=succeeded =====\n');
  const stdout = fs.readFileSync(logFilePath(j.jobId), 'utf8');
  const stderr = fs.readFileSync(stderrLogFilePath(j.jobId), 'utf8');
  assert.ok(stdout.includes('DONE'));
  assert.ok(!stdout.includes('====='));
  assert.ok(stderr.includes('succeeded'));
  assert.ok(!stderr.includes('DONE'));
});

test('idleSeconds falls back to null (not NaN) when lastOutputAt is missing', () => {
  const j = makeJob();
  // Old jobs predate the field entirely.
  delete (j as Partial<Job>).lastOutputAt;
  const v = toPublicView(j);
  assert.equal(v.idleSeconds, null);
});

test('idleSeconds is a sane non-negative number when lastOutputAt is present', () => {
  const j = makeJob();
  j.lastOutputAt = new Date(Date.now() - 42_000).toISOString();
  const v = toPublicView(j);
  assert.ok(v.idleSeconds !== null && v.idleSeconds >= 40 && v.idleSeconds <= 45);
});

test('rename retries on transient EPERM then succeeds', () => {
  withHooks(
    {
      beforeRename: (attempt) => {
        if (attempt <= 2) throw errWithCode('EPERM');
      },
    },
    () => {
      const j = makeJob();
      atomicWriteJson(jobFilePath(j.jobId), j);
      assert.equal(readJob(j.jobId)?.jobId, j.jobId);
      assert.deepEqual(tmpLeftovers(), []);
    },
  );
});

test('rename retries on EBUSY then succeeds', () => {
  withHooks(
    {
      beforeRename: (attempt) => {
        if (attempt === 1) throw errWithCode('EBUSY');
      },
    },
    () => {
      const j = makeJob();
      atomicWriteJson(jobFilePath(j.jobId), j);
      assert.equal(readJob(j.jobId)?.jobId, j.jobId);
      assert.deepEqual(tmpLeftovers(), []);
    },
  );
});

test('exceeding the retry limit throws a diagnosable error and preserves the previous JSON', () => {
  const j = makeJob();
  j.status = 'running';
  atomicWriteJson(jobFilePath(j.jobId), j); // the valid "old" JSON

  withHooks(
    {
      beforeRename: () => {
        throw errWithCode('EPERM');
      },
    },
    () => {
      assert.throws(
        () => atomicWriteJson(jobFilePath(j.jobId), { ...j, status: 'failed' }),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'EPERM');
          assert.match(err.message, /atomicWriteJson/);
          assert.match(err.message, /failed \d+ times/);
          assert.match(err.message, /previous valid JSON/);
          return true;
        },
      );
    },
  );

  // The old JSON is still intact and readable after the failed overwrite.
  const after = readJob(j.jobId);
  assert.ok(after);
  assert.equal(after.status, 'running');
  assert.deepEqual(tmpLeftovers(), []);
});

test('tmp names are unique per call and nothing is left after success', () => {
  const seen: string[] = [];
  withHooks(
    {
      beforeRename: (_attempt, tmpPath) => {
        seen.push(tmpPath);
      },
    },
    () => {
      for (let i = 0; i < 5; i++) {
        const j = makeJob();
        atomicWriteJson(jobFilePath(j.jobId), j);
      }
    },
  );
  assert.equal(seen.length, 5);
  assert.equal(new Set(seen).size, 5, 'tmp names must be unique across calls');
  for (const t of seen) {
    assert.ok(t.includes(`.${process.pid}.`), 'tmp name embeds the pid');
    assert.ok(t.endsWith('.tmp'));
  }
  assert.deepEqual(tmpLeftovers(), []);
});

test('high-frequency consecutive updates never corrupt the JSON', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const N = 200;
  for (let i = 1; i <= N; i++) {
    updateJob(j.jobId, { substatus: `step-${i}`, exitCode: i });
  }
  const after = readJob(j.jobId);
  assert.ok(after, 'readJob must still return parseable JSON');
  assert.equal(after.substatus, `step-${N}`);
  assert.equal(after.exitCode, N);
  assert.deepEqual(tmpLeftovers(), []);
});

test('cleanup failure is reported without masking the original error', () => {
  let tmpSeen: string | null = null;
  withHooks(
    {
      beforeRename: () => {
        throw errWithCode('EPERM'); // force write/rename failure
      },
      beforeUnlink: (tmpPath) => {
        tmpSeen = tmpPath;
        throw errWithCode('EACCES'); // inject cleanup failure
      },
    },
    () => {
      assert.throws(
        () => atomicWriteJson(jobFilePath(makeJob().jobId), {}),
        (err: NodeJS.ErrnoException) => {
          assert.equal(err.code, 'EPERM'); // original error is preserved
          assert.match(err.message, /tmp cleanup of .* failed: simulated EACCES/);
          return true;
        },
      );
    },
  );

  // The leftover tmp is the controlled exception: cleanup itself was injected
  // to fail, so it is reported via the addendum rather than silently left.
  assert.ok(tmpSeen);
  assert.ok(fs.existsSync(tmpSeen!), 'injected cleanup failure leaves the tmp behind');
  try {
    fs.unlinkSync(tmpSeen!); // tidy the temp artifact so the runtime dir stays clean
  } catch {
    /* ignore */
  }
  assert.deepEqual(tmpLeftovers(), []);
});

test('EACCES is not retried (single rename attempt)', () => {
  let attempts = 0;
  withHooks(
    {
      beforeRename: () => {
        attempts += 1;
        throw errWithCode('EACCES');
      },
    },
    () => {
      assert.throws(
        () => atomicWriteJson(jobFilePath(makeJob().jobId), {}),
        (err: NodeJS.ErrnoException) => err.code === 'EACCES',
      );
    },
  );
  assert.equal(attempts, 1, 'EACCES must fail fast, not be retried');
  assert.deepEqual(tmpLeftovers(), []);
});

// ---------------------------------------------------------------------------
// Research/analysis deliverable contract: persistence, public shape and
// backward compatibility.
// ---------------------------------------------------------------------------

test('deliverable metadata round-trips through the persisted job', () => {
  const j = makeJob();
  j.taskType = 'research';
  j.deliverablePath = path.join(rt, 'report.md');
  j.deliverableHash = 'a'.repeat(64);
  j.missingDeliverable = false;
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read);
  assert.equal(read.taskType, 'research');
  assert.equal(read.deliverablePath, j.deliverablePath);
  assert.equal(read.deliverableHash, 'a'.repeat(64));
  assert.equal(read.missingDeliverable, false);
});

test('sanitized public view exposes only task/deliverable metadata, never prompt or report content', () => {
  const j = makeJob();
  j.taskType = 'analysis';
  j.deliverablePath = path.join(rt, 'report.md');
  j.deliverableHash = 'b'.repeat(64);
  j.missingDeliverable = true;
  const v = toPublicView(j);
  assert.equal(v.taskType, 'analysis');
  assert.equal(v.deliverablePath, j.deliverablePath);
  assert.equal(v.deliverableHash, 'b'.repeat(64));
  assert.equal(v.missingDeliverable, true);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('SECRET PROMPT'), 'public view must not expose the prompt');
  // Only task/deliverable metadata/hash/missing flag are added; no report content.
  assert.ok(!('reportContent' in v), 'no report content key in the public view');
});

test('legacy Job without the optional deliverable fields still works', () => {
  const j = makeJob(); // predates taskType/deliverablePath entirely
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read);
  assert.equal(read.taskType, undefined);
  assert.equal(read.deliverablePath, undefined);
  const v = toPublicView(j);
  assert.ok(!('taskType' in v));
  assert.ok(!('deliverablePath' in v));
  assert.ok(!('deliverableHash' in v));
  assert.ok(!('missingDeliverable' in v));
  assert.equal(v.status, 'queued');
});

// ---------------------------------------------------------------------------
// T1D: v2 contract / acceptance persistence. New fields are additive: legacy
// records load untouched (no content/mtime rewrite), new fields round-trip
// through the normal persist path, and the public view normalizes defaults
// while exposing only safe summaries — never the contract body, gate previews,
// argv, cwd or env.
// ---------------------------------------------------------------------------

function t1dContract(workFolder: string, acceptanceCount = 1): TaskContractV2 {
  const acceptance = Array.from({ length: acceptanceCount }, (_, i) => ({
    id: `gate-${i}`,
    argv: ['node', '--test', 'test/gate.test.js'],
    cwdRelative: '.',
    timeoutSeconds: 300,
    required: i === 0,
    outputMaxChars: 10000,
  }));
  return {
    schemaVersion: CONTRACT_V2_SCHEMA_VERSION,
    scope: { readGlobs: ['src/**/*.ts'], writeFiles: ['docs/*.md'], forbiddenGlobs: ['secrets/**'] },
    writePolicy: 'listed_writes',
    budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 15 },
    acceptance,
    reporting: { deliverablePath: path.join(workFolder, 'docs', 'report.md') },
    admission: { resourceClass: 'light', priority: 1 },
  };
}

function sampleGateResult(): Record<string, unknown> {
  return {
    id: 'unit-tests',
    required: true,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: 1234,
    exitCode: 0,
    timedOut: false,
    prevented: false,
    errorCode: 'ENOENT',
    stdoutSummary: '1..3\n# tests 3\n# pass 3',
    stderrSummary: '',
    stdoutPreview: 'RAW PREVIEW',
    stderrPreview: 'RAW STDERR PREVIEW',
    argv: ['node', '--test'],
    cwd: '/secret/cwd',
    env: { SECRET: 'top' },
  };
}

test('T1D legacy job (no contract/acceptance fields) loads without rewrite and shows normalized defaults', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const p = jobFilePath(j.jobId);
  const before = fs.readFileSync(p, 'utf8');
  const beforeMtime = fs.statSync(p).mtimeMs;
  const read = readJob(j.jobId);
  assert.ok(read);
  assert.equal(read.contract, undefined);
  assert.equal(read.workerStatus, undefined);
  assert.equal(read.acceptanceStatus, undefined);
  assert.equal(read.gateResults, undefined);
  // The legacy file is byte-identical and its mtime is untouched: reading
  // never rewrites a legacy job.
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'legacy file content must be untouched by readJob');
  assert.equal(fs.statSync(p).mtimeMs, beforeMtime, 'legacy file mtime must be untouched by readJob');
  const v = toPublicView(read);
  assert.equal(v.workerStatus, 'queued', 'workerStatus defaults to the job status');
  assert.equal(v.acceptanceStatus, 'not_requested', 'no contract => acceptance not_requested');
  assert.deepEqual(v.gateResults, [], 'no stored gates => empty list');
  assert.equal(v.contractSchemaVersion, null, 'no contract => null');
});

test('T1D new fields round-trip through the persisted job and public view', () => {
  const j = makeJob();
  j.contract = t1dContract(rt, 2);
  j.workerStatus = 'succeeded';
  j.acceptanceStatus = 'pass';
  j.gateResults = [sampleGateResult() as unknown as NonNullable<Job['gateResults']>[number]];
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read);
  assert.equal(read.contract?.schemaVersion, CONTRACT_V2_SCHEMA_VERSION);
  assert.equal(read.contract?.acceptance.length, 2);
  assert.equal(read.workerStatus, 'succeeded');
  assert.equal(read.acceptanceStatus, 'pass');
  assert.equal(read.gateResults?.length, 1);
  assert.equal(read.gateResults?.[0]?.id, 'unit-tests');
  const v = toPublicView(read);
  assert.equal(v.workerStatus, 'succeeded', 'stored workerStatus wins');
  assert.equal(v.acceptanceStatus, 'pass', 'stored acceptanceStatus wins');
  assert.equal(v.gateResults.length, 1);
  assert.equal(v.gateResults[0]!.id, 'unit-tests');
  assert.equal(v.gateResults[0]!.exitCode, 0);
  assert.equal(v.contractSchemaVersion, CONTRACT_V2_SCHEMA_VERSION, 'version surfaces without the body');
});

test('T1D workerStatus/acceptanceStatus persist through updateJobIf (not only create)', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const updated = updateJobIf(j.jobId, () => true, {
    workerStatus: 'failed',
    acceptanceStatus: 'fail',
    gateResults: [sampleGateResult() as unknown as NonNullable<Job['gateResults']>[number]],
  });
  assert.ok(updated, 'updateJobIf must accept T1D fields');
  assert.equal(updated?.workerStatus, 'failed');
  assert.equal(updated?.acceptanceStatus, 'fail');
  const read = readJob(j.jobId);
  assert.equal(read?.workerStatus, 'failed');
  assert.equal(read?.acceptanceStatus, 'fail');
  assert.equal(read?.gateResults?.length, 1);
  const v = toPublicView(read!);
  assert.equal(v.workerStatus, 'failed');
  assert.equal(v.acceptanceStatus, 'fail');
});

// ---------------------------------------------------------------------------
// Wave4B1: admission public-state contract. New optional persisted fields are
// additive — legacy records stay readable (byte-identical, no rewrite), new
// fields round-trip through the normal persist path, and the public view
// normalizes defaults while exposing only safe summaries. No lease owner, PID
// identity, or other internal admission detail is ever exposed.
// ---------------------------------------------------------------------------

function admissionJob(over: Partial<Job> = {}): Job {
  return { ...makeJob(), ...over };
}

const ISO_A = '2026-08-30T10:00:00.000Z';
const ISO_B = '2026-08-30T10:05:00.000Z';

test('Wave4B1 legacy job without admission fields stays readable, untouched and disabled', () => {
  const j = makeJob(); // predates the admission fields entirely
  atomicWriteJson(jobFilePath(j.jobId), j);
  const p = jobFilePath(j.jobId);
  const before = fs.readFileSync(p, 'utf8');
  const beforeMtime = fs.statSync(p).mtimeMs;
  const read = readJob(j.jobId);
  assert.ok(read, 'legacy job without admission fields stays readable');
  assert.equal(read.desiredWorkerConcurrency, undefined);
  assert.equal(read.admissionState, undefined);
  assert.equal(read.admissionResourceClass, undefined);
  assert.equal(read.admissionQueueReason, undefined);
  assert.equal(read.queuedAt, undefined);
  assert.equal(read.admittedAt, undefined);
  assert.equal(read.activeWorkers, undefined);
  assert.equal(read.queuedWorkers, undefined);
  assert.equal(read.resourceLimit, undefined);
  // Reading never rewrites a legacy job.
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'legacy file content must be untouched by readJob');
  assert.equal(fs.statSync(p).mtimeMs, beforeMtime, 'legacy file mtime must be untouched by readJob');

  const v = toPublicView(read);
  assert.equal(v.desiredWorkerConcurrency, null);
  assert.equal(v.internalAgentParallelism, j.parallelism, 'always mirrors the persisted parallelism field');
  assert.equal(v.admissionState, 'disabled', 'legacy default state is disabled');
  assert.equal(v.admissionResourceClass, null);
  assert.equal(v.queueReason, null);
  assert.equal(v.queuedAt, null);
  assert.equal(v.admittedAt, null);
  assert.equal(v.activeWorkers, 0);
  assert.equal(v.queuedWorkers, 0);
  assert.equal(v.resourceLimit, null);
  assert.equal(v.queueMs, 0, 'no queuedAt => queueMs 0');
});

test('Wave4B1 admission fields round-trip through persist and the public view', () => {
  const j = admissionJob({
    desiredWorkerConcurrency: 4,
    admissionState: 'active',
    admissionResourceClass: 'build',
    admissionQueueReason: null,
    queuedAt: ISO_A,
    admittedAt: ISO_B,
    activeWorkers: 3,
    queuedWorkers: 1,
    resourceLimit: 4,
  });
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read, 'job with valid admission fields stays readable');
  assert.equal(read.desiredWorkerConcurrency, 4);
  assert.equal(read.admissionState, 'active');
  assert.equal(read.admissionResourceClass, 'build');
  assert.equal(read.admissionQueueReason, null);
  assert.equal(read.queuedAt, ISO_A);
  assert.equal(read.admittedAt, ISO_B);
  assert.equal(read.activeWorkers, 3);
  assert.equal(read.queuedWorkers, 1);
  assert.equal(read.resourceLimit, 4);

  const v = toPublicView(read);
  assert.equal(v.desiredWorkerConcurrency, 4);
  assert.equal(v.internalAgentParallelism, j.parallelism);
  assert.equal(v.admissionState, 'active');
  assert.equal(v.admissionResourceClass, 'build');
  assert.equal(v.queueReason, null);
  assert.equal(v.queuedAt, ISO_A);
  assert.equal(v.admittedAt, ISO_B);
  assert.equal(v.activeWorkers, 3);
  assert.equal(v.queuedWorkers, 1);
  assert.equal(v.resourceLimit, 4);
  // admitted: queueMs = admittedAt - queuedAt = 5 minutes.
  assert.equal(v.queueMs, 300_000);
});

test('Wave4B1 queueMs: still-queued uses now-queuedAt; never negative', () => {
  // Still queued (no admittedAt): queueMs = now - queuedAt, computed live.
  const j = admissionJob({ admissionState: 'queued', queuedAt: new Date(Date.now() - 10_000).toISOString(), admittedAt: null });
  let v = toPublicView(j);
  assert.ok(v.queueMs >= 10_000, `expected >= 10000, got ${v.queueMs}`);
  // Future/out-of-order timestamps clamp to 0, never negative.
  const bad = admissionJob({ admissionState: 'queued', queuedAt: ISO_B, admittedAt: ISO_A });
  assert.equal(toPublicView(bad).queueMs, 0, 'out-of-order stamps clamp to 0');
});

test('Wave4B1 public view never exposes admission internals (owner/PID identity/workFolder)', () => {
  const j = admissionJob({
    admissionState: 'active',
    admissionResourceClass: 'heavy',
    admissionQueueReason: 'desired_limit',
    queuedAt: ISO_A,
    admittedAt: ISO_B,
    activeWorkers: 2,
    queuedWorkers: 0,
    resourceLimit: 2,
  });
  const v = toPublicView(j);
  const keys = Object.keys(v);
  // lease owner, PID identity and the new admission internals must never leak;
  // workFolder is an existing public field (asserted below) and stays.
  for (const secret of ['pid', 'pidStartedAt', 'supervisorPid', 'supervisorPidStartedAt', 'lease', 'owner', 'queueReasonDetail']) {
    assert.ok(!keys.includes(secret), `public view must not expose ${secret}`);
  }
  // The existing parallelism field is preserved for old clients.
  assert.equal(v.parallelism, j.parallelism);
  assert.equal(v.workFolder, j.workFolder, 'workFolder is an existing public field and stays');
});

test('Wave4B1 admission fields persist through updateJobIf (not only create)', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const updated = updateJobIf(j.jobId, () => true, {
    desiredWorkerConcurrency: 2,
    admissionState: 'queued',
    admissionResourceClass: 'light',
    admissionQueueReason: 'desired_limit' as AdmissionQueueReason,
    queuedAt: ISO_A,
    admittedAt: null,
    activeWorkers: 0,
    queuedWorkers: 2,
    resourceLimit: 2,
  });
  assert.ok(updated, 'updateJobIf must accept Wave4B1 admission fields');
  assert.equal(updated?.admissionState, 'queued');
  assert.equal(updated?.queuedWorkers, 2);
  const read = readJob(j.jobId);
  assert.equal(read?.desiredWorkerConcurrency, 2);
  assert.equal(read?.admissionState, 'queued');
  assert.equal(read?.queuedAt, ISO_A);
  const v = toPublicView(read!);
  assert.equal(v.admissionState, 'queued');
  assert.equal(v.queueReason, 'desired_limit');
  assert.equal(v.queuedWorkers, 2);
});

test('Wave4B1 readJob rejects wrong-typed admission fields (present-but-invalid)', () => {
  expectReadRejected('desiredWorkerConcurrency 0', (j) => {
    j.desiredWorkerConcurrency = 0;
  });
  expectReadRejected('desiredWorkerConcurrency 65', (j) => {
    j.desiredWorkerConcurrency = 65;
  });
  expectReadRejected('desiredWorkerConcurrency fractional', (j) => {
    j.desiredWorkerConcurrency = 1.5;
  });
  expectReadRejected('desiredWorkerConcurrency string', (j) => {
    j.desiredWorkerConcurrency = '4' as never;
  });
  expectReadRejected('admissionState not in enum', (j) => {
    j.admissionState = 'paused' as never;
  });
  expectReadRejected('admissionResourceClass not in enum', (j) => {
    j.admissionResourceClass = 'xl' as never;
  });
  expectReadRejected('admissionQueueReason not in enum', (j) => {
    j.admissionQueueReason = 'mystery' as never;
  });
  expectReadRejected('queuedAt not a date', (j) => {
    j.queuedAt = 'not-a-date';
  });
  expectReadRejected('admittedAt not a date', (j) => {
    j.admittedAt = 'not-a-date';
  });
  expectReadRejected('activeWorkers negative', (j) => {
    j.activeWorkers = -1;
  });
  expectReadRejected('activeWorkers fractional', (j) => {
    j.activeWorkers = 1.5;
  });
  expectReadRejected('queuedWorkers negative', (j) => {
    j.queuedWorkers = -1;
  });
  expectReadRejected('resourceLimit negative', (j) => {
    j.resourceLimit = -1;
  });
  expectReadRejected('resourceLimit fractional', (j) => {
    j.resourceLimit = 1.5;
  });
});

test('T1D public gate summary exposes only safe fields, never preview/argv/cwd/env or full output', () => {
  const j = makeJob();
  j.contract = t1dContract(rt, 1);
  j.gateResults = [sampleGateResult() as unknown as NonNullable<Job['gateResults']>[number]];
  const v = toPublicView(j);
  assert.equal(v.gateResults.length, 1);
  const g = v.gateResults[0]!;
  assert.deepEqual(
    Object.keys(g).sort(),
    ['durationMs', 'errorCode', 'exitCode', 'id', 'prevented', 'required', 'stderrSummary', 'stdoutSummary', 'timedOut'],
    'gate summary must expose exactly the whitelisted keys',
  );
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('RAW PREVIEW'), 'no stdout preview in the public view');
  assert.ok(!raw.includes('RAW STDERR PREVIEW'), 'no stderr preview in the public view');
  assert.ok(!raw.includes('SECRET PROMPT'), 'no prompt in the public view');
  assert.ok(!raw.includes('/secret/cwd'), 'no cwd in the public view');
  assert.ok(!raw.includes('SECRET'), 'no env in the public view');
  assert.ok(!raw.includes('node --test'), 'no gate argv in the public view');
  assert.ok(!raw.includes('test/gate.test.js'), 'no acceptance argv in the public view');
});

test('T1D contract body never appears in the public view; only the schema version does', () => {
  const j = makeJob();
  j.contract = t1dContract(rt, 1);
  const v = toPublicView(j);
  assert.equal(v.contractSchemaVersion, CONTRACT_V2_SCHEMA_VERSION);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('listed_writes'), 'no writePolicy in the public view');
  assert.ok(!raw.includes('readGlobs'), 'no scope in the public view');
  assert.ok(!raw.includes('reportOnlyAfterMinutes'), 'no budget in the public view');
  assert.ok(!raw.includes('gate-0'), 'no acceptance array in the public view');
  assert.ok(!raw.includes('docs/report.md'), 'no reporting path in the public view');
  assert.ok(!raw.includes('resourceClass'), 'no admission in the public view');
});

test('T1D contract present but acceptance never requested => acceptanceStatus unknown', () => {
  const j = makeJob();
  j.contract = t1dContract(rt, 1);
  const v = toPublicView(j);
  assert.equal(v.workerStatus, 'queued');
  assert.equal(v.acceptanceStatus, 'unknown');
  assert.deepEqual(v.gateResults, []);
  assert.equal(v.contractSchemaVersion, CONTRACT_V2_SCHEMA_VERSION);
});

test('T1D toGateSummary is a pure safe mapper: keeps summary fields, drops preview/argv/cwd/env', () => {
  const g = sampleGateResult() as unknown as Parameters<typeof toGateSummary>[0];
  const s = toGateSummary(g);
  assert.deepEqual(
    Object.keys(s).sort(),
    ['durationMs', 'errorCode', 'exitCode', 'id', 'prevented', 'required', 'stderrSummary', 'stdoutSummary', 'timedOut'],
  );
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('RAW PREVIEW'));
  assert.ok(!raw.includes('RAW STDERR PREVIEW'));
  assert.ok(!raw.includes('node --test'));
  assert.ok(!raw.includes('/secret/cwd'));
  assert.ok(!raw.includes('SECRET'));
  // Defensive: missing optional gate fields map to safe defaults, not garbage.
  const sparse = toGateSummary({ id: 'g', required: false } as unknown as Parameters<typeof toGateSummary>[0]);
  assert.equal(sparse.exitCode, null);
  // timedOut / durationMs are REQUIRED GateResult fields, so a sparse input
  // passes them through as-is — not a summary defaulting case.
  assert.equal(sparse.timedOut, undefined);
  assert.equal(sparse.durationMs, undefined);
  assert.equal(sparse.stdoutSummary, '');
  assert.equal(sparse.stderrSummary, '');
  assert.equal(sparse.prevented, undefined, 'absent prevented stays absent (no key)');
  assert.equal(sparse.errorCode, undefined, 'absent errorCode stays absent (no key)');
});

test('T1D readJob rejects wrong-typed new fields (present-but-invalid)', () => {
  expectReadRejected('contract non-object', (j) => {
    j.contract = 'not-a-contract' as never;
  });
  expectReadRejected('contract wrong schemaVersion', (j) => {
    j.contract = { ...t1dContract(rt, 1), schemaVersion: 1 } as never;
  });
  expectReadRejected('workerStatus not a JobStatus', (j) => {
    j.workerStatus = 'not-a-status' as JobStatus;
  });
  expectReadRejected('acceptanceStatus not in enum', (j) => {
    j.acceptanceStatus = 'nope' as JobAcceptanceStatus;
  });
  expectReadRejected('gateResults not an array', (j) => {
    j.gateResults = { id: 'x' } as never;
  });
  expectReadRejected('gateResult entry wrong shape', (j) => {
    j.gateResults = [{ id: 'x', required: 'yes' }] as never;
  });
});

// Wave 3B: replyMode is an optional additive field — absent stays valid
// (legacy), present must be exactly one of the two reply modes, and the public
// view always carries it (null default).
test('Wave3B readJob rejects an invalid replyMode (present-but-invalid)', () => {
  expectReadRejected('replyMode non-string', (j) => {
    j.replyMode = 42 as never;
  });
  expectReadRejected('replyMode not in enum', (j) => {
    j.replyMode = 'nope' as never;
  });
  expectReadRejected('replyMode empty string', (j) => {
    j.replyMode = '' as never;
  });
});

test('Wave3B replyMode round-trips through persist and the public view', () => {
  for (const mode of ['resume_session', 'fresh_turn'] as const) {
    const j = makeJob();
    j.replyMode = mode;
    atomicWriteJson(jobFilePath(j.jobId), j);
    const read = readJob(j.jobId);
    assert.ok(read, 'a job with a valid replyMode stays readable');
    assert.equal(read!.replyMode, mode);
    const v = toPublicView(read!);
    assert.equal(v.replyMode, mode, 'public view surfaces the stored replyMode');
  }
});

test('Wave3B legacy job without replyMode reads fine and the view reports null', () => {
  const j = makeJob();
  // Simulate a record that predates replyMode entirely.
  delete (j as unknown as Record<string, unknown>).replyMode;
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read, 'a legacy record without replyMode stays readable');
  assert.equal(read!.replyMode, undefined, 'absent replyMode stays absent on the raw record');
  const v = toPublicView(read!);
  assert.equal(v.replyMode, null, 'public view always carries replyMode, null on legacy jobs');
});

test('Wave3B public view never leaks the stored prompt for reply-mode jobs', () => {
  const j = makeJob();
  j.replyMode = 'resume_session';
  const v = toPublicView(j);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('SECRET PROMPT'), 'public view must not expose the prompt');
  assert.equal(v.replyMode, 'resume_session');
});

test('inspectDeliverable: valid regular non-empty .md yields SHA-256 and ok', () => {
  const f = path.join(rt, 'deliv-ok.md');
  const content = '# Report\nDeterministic evidence.';
  fs.writeFileSync(f, content, 'utf8');
  const insp = inspectDeliverable(f);
  assert.equal(insp.valid, true);
  assert.equal(insp.reason, 'ok');
  assert.equal(insp.hash, crypto.createHash('sha256').update(content).digest('hex'));
});

test('inspectDeliverable: absent, empty and non-file artifacts are invalid with sanitized reasons', () => {
  const missing = path.join(rt, 'deliv-missing.md');
  assert.deepEqual(inspectDeliverable(missing), { valid: false, hash: null, reason: 'missing' });

  const empty = path.join(rt, 'deliv-empty.md');
  fs.writeFileSync(empty, '', 'utf8');
  assert.deepEqual(inspectDeliverable(empty), { valid: false, hash: null, reason: 'empty' });

  const notFile = path.join(rt, 'deliv-not-file.md');
  fs.mkdirSync(notFile, { recursive: true });
  assert.deepEqual(inspectDeliverable(notFile), { valid: false, hash: null, reason: 'not_file' });
});

// ---------------------------------------------------------------------------
// Core-consistency: frozen CAS/claim/PID contract.
//
// The API under test is FROZEN: updateJob/updateJobIf (unchanged signatures)
// now perform lock+reread+predicate+monotonic+atomic replace; job-store
// exports jobStateLockFilePath / acquireJobStateLock / releaseJobStateLock
// with the whitelisted lock schema; Job carries optional pidStartedAt and
// supervisorPidStartedAt. A few acquire-option field names (inspector /
// ownerId / leaseMs / now) mirror the recovery-claim API and are the only
// expected alignment surface here; blocked acquisition is treated as
// fail-closed (throw OR null), and a "result" shape with a `handle` property
// is unwrapped defensively so these tests survive the minimal option/result/
// handle types.
// ---------------------------------------------------------------------------

const SELF_START = Date.now() - process.uptime() * 1000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Compiled layout: dist-test/test/job-store.test.js -> dist-test/src/job-store.js.
const JOB_STORE_MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'job-store.js'),
).href;

interface JobStateLockRecord {
  schemaVersion: number;
  jobId: string;
  ownerId: string;
  ownerPid: number;
  ownerStartedAt: string;
  acquiredAt: string;
  expiresAt: string;
}

type LockOptions = NonNullable<Parameters<typeof acquireJobStateLock>[1]>;
type LockResult = ReturnType<typeof acquireJobStateLock>;
type LockHandleLike = { jobId?: string; ownerId?: string };

function lockFilePath(jobId: string): string {
  const p = jobStateLockFilePath(jobId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function readLock(jobId: string): JobStateLockRecord | null {
  const p = lockFilePath(jobId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as JobStateLockRecord;
  } catch {
    return null;
  }
}

function writeLock(jobId: string, over: Partial<JobStateLockRecord> = {}): JobStateLockRecord {
  const record: JobStateLockRecord = {
    schemaVersion: 1,
    jobId,
    ownerId: 'owner-a',
    ownerPid: 42_001,
    ownerStartedAt: new Date(SELF_START - 60_000).toISOString(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...over,
  };
  atomicWriteJson(lockFilePath(jobId), record);
  return record;
}

function inspectorFor(alive: Set<number>, starts: Map<number, number>): ProcessInspector {
  return {
    exists: (pid) => alive.has(pid),
    startTime: (pid) => starts.get(pid) ?? null,
  };
}

// Defensive handle extraction: the frozen contract keeps the acquire result
// minimal; a `handle`-carrying result and a bare handle are both accepted.
function extractHandle(r: LockResult): LockHandleLike {
  if (r === null || r === undefined) throw new Error('acquisition failed unexpectedly');
  if (typeof r === 'object' && 'handle' in (r as object)) {
    return (r as { handle: LockHandleLike }).handle;
  }
  return r as LockHandleLike;
}

function acquisitionSucceeded(r: LockResult): boolean {
  if (r === null || r === undefined) return false;
  if (typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if ('handle' in o) return true;
    if ('ok' in o) return o['ok'] === true;
    if ('status' in o) return o['status'] === 'acquired';
  }
  return true;
}

function acquire(jobId: string, options: Record<string, unknown> = {}): LockHandleLike {
  lockFilePath(jobId); // ensure the lock dir exists before any acquisition
  const h = extractHandle(acquireJobStateLock(jobId, options as unknown as LockOptions));
  assert.ok(h, 'acquisition must return a handle');
  return h;
}

function release(handle: LockHandleLike): boolean {
  return releaseJobStateLock(handle as unknown as Parameters<typeof releaseJobStateLock>[0]);
}

// Asserts acquisition fails closed AND the lock file is byte-identical after.
function expectBlocked(jobId: string, options: Record<string, unknown>, label: string): void {
  const p = lockFilePath(jobId);
  const before = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  let acquired = false;
  try {
    acquired = acquisitionSucceeded(acquireJobStateLock(jobId, options as unknown as LockOptions));
  } catch {
    acquired = false;
  }
  assert.equal(acquired, false, label);
  const after = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
  assert.equal(after, before, `${label}: the lock file is unchanged`);
}

function mutationFailsClosed(jobId: string, patch: Partial<Job>): void {
  let failed = false;
  try {
    failed = updateJob(jobId, patch) === null;
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'mutation must fail closed (null or throw)');
}

function mutationIfFailsClosed(jobId: string, guard: (j: Job) => boolean, patch: Partial<Job>): void {
  let failed = false;
  try {
    failed = updateJobIf(jobId, guard, patch) === null;
  } catch {
    failed = true;
  }
  assert.equal(failed, true, 'guarded mutation must fail closed (null or throw)');
}

// ---------------------------------------------------------------------------
// Monotonic status contract (matrix 9).
// ---------------------------------------------------------------------------

test('terminal statuses are immutable: no transition out of succeeded/failed/cancelled', () => {
  const terminals: JobStatus[] = ['succeeded', 'failed', 'cancelled'];
  for (const terminal of terminals) {
    const j = makeJob();
    j.status = terminal;
    j.endedAt = new Date().toISOString();
    atomicWriteJson(jobFilePath(j.jobId), j);
    const attempts: Array<Partial<Job>> = [
      { status: 'queued' },
      { status: 'running' },
      { status: 'needs_attention' },
      { status: terminals.find((t) => t !== terminal) as JobStatus },
    ];
    for (const patch of attempts) {
      mutationFailsClosed(j.jobId, patch);
      assert.equal(readJob(j.jobId)?.status, terminal, `${terminal} must stay ${terminal} after ${patch.status}`);
    }
  }
});

test('needs_attention cannot be downgraded to queued/running but may fail', () => {
  const j = makeJob();
  j.status = 'needs_attention';
  j.substatus = 'permission_request';
  atomicWriteJson(jobFilePath(j.jobId), j);
  mutationFailsClosed(j.jobId, { status: 'queued' });
  mutationFailsClosed(j.jobId, { status: 'running' });
  assert.equal(readJob(j.jobId)?.status, 'needs_attention', 'a published block is never downgraded');
  const failed = updateJob(j.jobId, { status: 'failed', substatus: 'exit_1', endedAt: new Date().toISOString() });
  assert.ok(failed, 'needs_attention -> failed is allowed');
  assert.equal(readJob(j.jobId)?.status, 'failed');
});

test('needs_attention -> cancelled is allowed', () => {
  const j = makeJob();
  j.status = 'needs_attention';
  atomicWriteJson(jobFilePath(j.jobId), j);
  const c = updateJob(j.jobId, { status: 'cancelled', endedAt: new Date().toISOString() });
  assert.ok(c, 'needs_attention -> cancelled is allowed');
  assert.equal(readJob(j.jobId)?.status, 'cancelled');
});

test('allowed monotonic progression queued -> running -> needs_attention -> failed', () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  assert.equal(updateJob(j.jobId, { status: 'running', pid: 1234 })?.status, 'running');
  assert.equal(updateJob(j.jobId, { status: 'needs_attention', substatus: 'permission_request' })?.status, 'needs_attention');
  assert.equal(updateJob(j.jobId, { status: 'failed', substatus: 'exit_1', endedAt: new Date().toISOString() })?.status, 'failed');
});

test('non-status patches are compatible with a terminal job', () => {
  const j = makeJob();
  j.status = 'succeeded';
  j.endedAt = new Date().toISOString();
  atomicWriteJson(jobFilePath(j.jobId), j);
  const updated = updateJob(j.jobId, { substatus: 'post-run', exitCode: 0, lastActivityAt: new Date().toISOString() });
  assert.ok(updated, 'a patch that does not change status is compatible with a terminal job');
  assert.equal(updated?.status, 'succeeded');
  assert.equal(updated?.substatus, 'post-run');
  assert.equal(readJob(j.jobId)?.exitCode, 0);
});

// ---------------------------------------------------------------------------
// Lock whitelist / no sensitive data (matrix 15).
// ---------------------------------------------------------------------------

test('job-state lock files serialize exactly the whitelisted fields and no sensitive data', () => {
  const jobId = 'lock-whitelist';
  const h = acquire(jobId, { ownerId: 'owner-w' });
  try {
    const raw = fs.readFileSync(lockFilePath(jobId), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ['acquiredAt', 'expiresAt', 'jobId', 'ownerId', 'ownerPid', 'ownerStartedAt', 'schemaVersion'],
      'lock serializes exactly the frozen schema',
    );
    assert.ok(!raw.includes(rt), 'lock must not embed the runtime path');
    assert.ok(!raw.includes('SECRET PROMPT'), 'lock must not embed the prompt');
  } finally {
    release(h);
  }
});

// ---------------------------------------------------------------------------
// Acquisition / ownership (matrix 7).
// ---------------------------------------------------------------------------

test('non-owner release fails; owner release succeeds and removes the lock', () => {
  const jobId = 'lock-release';
  const h = acquire(jobId, { ownerId: 'owner-x' });
  const intruder: LockHandleLike = { jobId, ownerId: 'intruder' };
  assert.equal(release(intruder), false, 'a different owner is refused');
  assert.ok(readLock(jobId), 'the lock survives a refused release');
  assert.equal(release(h), true, 'the owner release succeeds');
  assert.equal(readLock(jobId), null, 'release removes the lock file');
});

// ---------------------------------------------------------------------------
// Verified-live vs PID reuse (matrix 3, 5).
// ---------------------------------------------------------------------------

test('a verified-live lock owner is never stolen after lease expiry (self identity)', () => {
  const jobId = 'lock-verified-live';
  writeLock(jobId, {
    ownerId: 'live-owner',
    ownerPid: process.pid,
    ownerStartedAt: new Date(SELF_START).toISOString(),
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  expectBlocked(
    jobId,
    { inspector: inspectorFor(new Set([process.pid]), new Map([[process.pid, SELF_START]])) },
    'a verified-live owner must block acquisition even far past the lease',
  );
  assert.equal(readLock(jobId)?.ownerId, 'live-owner', 'the lock file is untouched');
});

test('a verified-live lock owner (foreign live pid) is never stolen after lease expiry', async () => {
  const jobId = 'lock-verified-live-foreign';
  // A real live stand-in pid. The recorded identity is the spawn moment, which is
  // within the registry's 5s identity tolerance of the child's OS-reported start,
  // so the test holds whether the source honors the injected inspector or queries
  // the real OS (queryProcessStartTime).
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], { stdio: 'ignore', windowsHide: true });
  const childStartMs = Date.now();
  try {
    const childPid = child.pid as number;
    writeLock(jobId, {
      ownerId: 'live-owner',
      ownerPid: childPid,
      ownerStartedAt: new Date(childStartMs).toISOString(),
      acquiredAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expectBlocked(
      jobId,
      { inspector: inspectorFor(new Set([childPid]), new Map([[childPid, childStartMs]])) },
      'a verified-live foreign owner must block acquisition past the lease',
    );
    assert.equal(readLock(jobId)?.ownerId, 'live-owner');
  } finally {
    try {
      child.kill();
    } catch {
      /* best effort */
    }
  }
});

test('PID reuse/identity mismatch never treats a reused PID as the owner (stolen)', () => {
  const jobId = 'lock-pid-reuse';
  // The pid exists (our own process) but its recorded start time differs from the
  // OS-reported identity -> provably a reused pid, never the recorded owner.
  writeLock(jobId, {
    ownerId: 'old-owner',
    ownerPid: process.pid,
    ownerStartedAt: new Date(SELF_START - 3600_000).toISOString(),
    acquiredAt: new Date(Date.now() - 120_000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const h = acquire(jobId, {
    ownerId: 'new-owner',
    inspector: inspectorFor(new Set([process.pid]), new Map([[process.pid, SELF_START]])),
  });
  assert.equal(readLock(jobId)?.ownerId, 'new-owner', 'a reused pid is safely stolen');
  release(h);
});

test('a fresh lease with identity mismatch is still stealable (reused pid)', () => {
  const jobId = 'lock-pid-reuse-fresh';
  writeLock(jobId, {
    ownerId: 'old-owner',
    ownerPid: process.pid,
    ownerStartedAt: new Date(SELF_START - 3600_000).toISOString(),
    acquiredAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const h = acquire(jobId, {
    ownerId: 'new-owner',
    inspector: inspectorFor(new Set([process.pid]), new Map([[process.pid, SELF_START]])),
  });
  assert.equal(readLock(jobId)?.ownerId, 'new-owner', 'identity mismatch is provable death, not a lease question');
  release(h);
});

// ---------------------------------------------------------------------------
// Empty/partial lock grace + one-winner acquisition (matrix 6).
// ALIGNMENT-SENSITIVE: the grace window is assumed mtime-based (a partial
// target blocks while fresh and is taken once aged); if the source implements
// the grace differently, this is the exact surface to align.
// ---------------------------------------------------------------------------

test('an empty/partial lock blocks acquisition during the grace window', () => {
  const jobId = 'lock-grace-partial';
  fs.writeFileSync(lockFilePath(jobId), '{"schemaVersion":1,"jobId":"', 'utf8');
  expectBlocked(jobId, {}, 'a fresh partial lock must block during grace');
});

test('a partial lock older than the grace window is taken and never double-owned', () => {
  const jobId = 'lock-grace-aged';
  const p = lockFilePath(jobId);
  fs.writeFileSync(p, '{"schemaVersion":1,"jobId":"', 'utf8');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(p, past, past);
  const h = acquire(jobId, { ownerId: 'new-owner' });
  assert.ok(h);
  assert.equal(readLock(jobId)?.ownerId, 'new-owner');
  release(h);
  assert.equal(readLock(jobId), null, 'a full acquire + release leaves no residue');
});

function lockRaceChildScript(jobId: string): string {
  return `
import { acquireJobStateLock } from ${JSON.stringify(JOB_STORE_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
function extract(r) { if (r && typeof r === 'object' && 'handle' in r) return r.handle; return r; }
let h = null;
try { h = extract(acquireJobStateLock(jobId)); } catch {}
if (h) {
  process.stdout.write(JSON.stringify({ acquired: true }));
  // Hold the lock for a bounded window so a concurrent contender is guaranteed
  // to observe it, then exit WITHOUT releasing: the parent reads the winner's
  // lock still on disk (readLock truthy), preserving the exactly-one owner.
  setTimeout(() => process.exit(0), 3000);
} else {
  process.stdout.write(JSON.stringify({ acquired: false }));
  process.exit(0);
}
`;
}

async function runModuleChild(scriptFile: string, label: string): Promise<string> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const cp = spawn(process.execPath, [scriptFile], {
      env: { ...process.env, ORCHESTRATOR_RUNTIME: rt },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      cp.kill();
      reject(new Error(`${label} timed out (stderr: ${err || 'none'})`));
    }, 20_000);
    cp.stdout.on('data', (d) => {
      out += String(d);
    });
    cp.stderr.on('data', (d) => {
      err += String(d);
    });
    cp.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    cp.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${label} exited ${code}: ${err}`));
    });
  });
  return stdout;
}

test('two processes racing the same lock path -> exactly one holder, never double owners', async () => {
  const jobId = `lock-race-${process.pid}-${Date.now()}`;
  const script = path.join(rt, `lock-race-${process.pid}.mjs`);
  fs.writeFileSync(script, lockRaceChildScript(jobId), 'utf8');
  try {
    const [ra, rb] = await Promise.all([runModuleChild(script, 'race-a'), runModuleChild(script, 'race-b')]);
    const results = [JSON.parse(ra), JSON.parse(rb)];
    assert.equal(
      results.filter((r) => r.acquired === true).length,
      1,
      `exactly one racer holds the lock, got ${JSON.stringify(results)}`,
    );
    const final = readLock(jobId);
    assert.ok(final, 'the winner leaves a valid single-owner lock');
  } finally {
    try {
      fs.unlinkSync(script);
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Cross-process updateJobIf CAS (matrix 1).
// ---------------------------------------------------------------------------

function updateRaceChildScript(jobId: string): string {
  return `
import { updateJobIf, readJob } from ${JSON.stringify(JOB_STORE_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
let r = null;
try {
  r = updateJobIf(jobId, (j) => j.status === 'queued', {
    status: 'running',
    pid: process.pid,
    pidStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
  });
} catch { r = null; }
const after = readJob(jobId);
process.stdout.write(JSON.stringify({ won: r !== null, finalStatus: after ? after.status : null, finalPid: after ? after.pid : null }));
process.exit(0);
`;
}

test('two child processes racing updateJobIf: exactly one succeeds and the final JSON is valid', async () => {
  const j = makeJob();
  atomicWriteJson(jobFilePath(j.jobId), j);
  lockFilePath(j.jobId); // ensure the job-state lock dir exists before the children race
  const a = path.join(rt, `update-race-a-${process.pid}.mjs`);
  const b = path.join(rt, `update-race-b-${process.pid}.mjs`);
  fs.writeFileSync(a, updateRaceChildScript(j.jobId), 'utf8');
  fs.writeFileSync(b, updateRaceChildScript(j.jobId), 'utf8');
  try {
    const [ra, rb] = await Promise.all([runModuleChild(a, 'update-race-a'), runModuleChild(b, 'update-race-b')]);
    const results = [JSON.parse(ra), JSON.parse(rb)];
    assert.equal(results.filter((r) => r.won === true).length, 1, `exactly one racer wins, got ${JSON.stringify(results)}`);
    const final = readJob(j.jobId);
    assert.ok(final, 'the final job JSON must remain valid');
    assert.equal(final.status, 'running');
    assert.ok(final.pid && final.pid > 0);
    assert.ok(results.some((r) => r.won === true), 'the winner observed a successful guarded update');
  } finally {
    for (const f of [a, b]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Lock owner crash + recovery; cross-process held lock (matrix 4, 8).
// ---------------------------------------------------------------------------

function crashHolderChildScript(jobId: string): string {
  return `
import { acquireJobStateLock } from ${JSON.stringify(JOB_STORE_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
let h = null;
try { h = acquireJobStateLock(jobId); } catch {}
if (!h) { console.error('no-handle'); process.exit(3); }
process.stdout.write('acquired\\n');
process.exit(1);
`;
}

test('owner process crashes without release; another process recovers and updates', async () => {
  const jobId = `lock-crash-${process.pid}-${Date.now()}`;
  const j = makeJob();
  j.jobId = jobId;
  atomicWriteJson(jobFilePath(jobId), j);
  lockFilePath(jobId); // ensure the lock dir exists before the holder child acquires
  const script = path.join(rt, `crash-${process.pid}.mjs`);
  fs.writeFileSync(script, crashHolderChildScript(jobId), 'utf8');
  let childPid = 0;
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const cp = spawn(process.execPath, [script], {
        env: { ...process.env, ORCHESTRATOR_RUNTIME: rt },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      childPid = cp.pid ?? 0;
      cp.on('error', reject);
      cp.on('exit', resolve);
    });
    assert.equal(exitCode, 1, 'the holder crashed (exit 1) without releasing');
    assert.ok(readLock(jobId), 'the crashed holder leaves a lock behind');

    // Another process (this one) recovers: acquisition succeeds once the owner
    // is provably gone. A short retry absorbs the exit-visible timing race.
    let handle: LockHandleLike | null = null;
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        handle = acquire(jobId, { ownerId: 'recoverer' });
        break;
      } catch {
        if (Date.now() > deadline) throw new Error('recovery acquire did not succeed after the holder exited');
        await sleep(150);
      }
    }
    // Release before the mutation so the mutation path owns its own lock cycle
    // (the frozen contract keeps mutation locking internal to updateJob).
    release(handle);
    const updated = updateJob(jobId, { status: 'failed', substatus: 'recovered_after_crash', endedAt: new Date().toISOString() });
    assert.ok(updated, 'the recoverer can update the job after the lock is recovered');
    assert.equal(readJob(jobId)?.status, 'failed');
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, 9);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.unlinkSync(script);
    } catch {
      /* best effort */
    }
  }
});

function holderChildScript(jobId: string): string {
  return `
import { acquireJobStateLock, releaseJobStateLock } from ${JSON.stringify(JOB_STORE_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
function extract(r) { if (r && typeof r === 'object' && 'handle' in r) return r.handle; return r; }
let h = null;
try { h = extract(acquireJobStateLock(jobId)); } catch {}
if (!h) { console.error('no-handle'); process.exit(3); }
process.stdout.write('held\\n');
process.stdin.resume();
process.stdin.on('data', () => {
  try { releaseJobStateLock(h); } catch {}
  process.exit(0);
});
`;
}

test('a lock held by another process makes mutations fail closed (no unlocked mutation)', async () => {
  const jobId = `lock-held-${process.pid}-${Date.now()}`;
  const j = makeJob();
  j.jobId = jobId;
  j.status = 'running';
  atomicWriteJson(jobFilePath(jobId), j);
  lockFilePath(jobId); // ensure the lock dir exists before the holder child acquires
  const script = path.join(rt, `holder-${process.pid}.mjs`);
  fs.writeFileSync(script, holderChildScript(jobId), 'utf8');
  let childPid = 0;
  try {
    const cp = spawn(process.execPath, [script], {
      env: { ...process.env, ORCHESTRATOR_RUNTIME: rt },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    childPid = cp.pid ?? 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder child did not confirm')), 15_000);
      cp.stdout.on('data', (d) => {
        if (String(d).includes('held')) {
          clearTimeout(timer);
          resolve();
        }
      });
      cp.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });

    const before = fs.readFileSync(jobFilePath(jobId), 'utf8');
    mutationFailsClosed(jobId, { status: 'failed' });
    mutationIfFailsClosed(jobId, (cur) => cur.status === 'running', { status: 'failed' });
    assert.equal(fs.readFileSync(jobFilePath(jobId), 'utf8'), before, 'no unlocked mutation while the lock is held');

    // Signal the holder to release and exit, then the same mutations succeed.
    cp.stdin.write('q\n');
    await new Promise<void>((resolve) => {
      cp.on('exit', () => resolve());
      setTimeout(resolve, 3000);
    });
    const ok = updateJob(jobId, { status: 'failed', endedAt: new Date().toISOString() });
    assert.ok(ok, 'mutation succeeds once the lock is released');
    assert.equal(readJob(jobId)?.status, 'failed');
  } finally {
    if (childPid) {
      try {
        process.kill(childPid, 9);
      } catch {
        /* already gone */
      }
    }
    try {
      fs.unlinkSync(script);
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Frozen validation contract: readJob/listJobs route through isValidJobRecord
// and parseDoneMarker guards the .done marker. Each parseable critical
// corruption is rejected independently; legacy records stay readable.
// ---------------------------------------------------------------------------

function writeJobRecord(mutate: (j: Job) => void): string {
  const j = makeJob();
  mutate(j);
  atomicWriteJson(jobFilePath(j.jobId), j);
  return j.jobId;
}

function expectReadRejected(label: string, mutate: (j: Job) => void): void {
  const id = writeJobRecord(mutate);
  assert.equal(readJob(id), null, `${label}: readJob must reject the corrupt record`);
}

test('readJob rejects an invalid status', () => {
  expectReadRejected('status', (j) => {
    j.status = 'not-a-status' as JobStatus;
  });
});

test('readJob rejects an invalid/non-date startedAt', () => {
  expectReadRejected('startedAt', (j) => {
    j.startedAt = 'not-a-date';
  });
});

test('readJob rejects non-integer or out-of-range maxRuntimeMinutes', () => {
  expectReadRejected('maxRuntimeMinutes noninteger', (j) => {
    j.maxRuntimeMinutes = 120.5;
  });
  expectReadRejected('maxRuntimeMinutes below 30', (j) => {
    j.maxRuntimeMinutes = 20;
  });
  expectReadRejected('maxRuntimeMinutes above 180', (j) => {
    j.maxRuntimeMinutes = 200;
  });
});

test('readJob rejects an invalid profile', () => {
  expectReadRejected('profile', (j) => {
    j.profile = 'premium' as never;
  });
});

test('readJob rejects an invalid parallelism', () => {
  expectReadRejected('parallelism numeric', (j) => {
    j.parallelism = '8' as never;
  });
  expectReadRejected('parallelism token', (j) => {
    j.parallelism = 'one' as never;
  });
});

test('readJob rejects zero/negative/fraction/string pid and supervisorPid', () => {
  for (const bad of [0, -1, 0.5, '123']) {
    expectReadRejected(`pid ${JSON.stringify(bad)}`, (j) => {
      j.pid = bad as unknown as number;
    });
    expectReadRejected(`supervisorPid ${JSON.stringify(bad)}`, (j) => {
      j.supervisorPid = bad as unknown as number;
    });
  }
});

test('readJob rejects an invalid optional PID-start timestamp', () => {
  // A PID-start identity is optional on legacy jobs; when present it must be a
  // valid timestamp (string parseable as a date) or null. Both a non-string and
  // a non-parseable string are corrupt and make the whole record unreadable.
  expectReadRejected('pidStartedAt non-string', (j) => {
    j.pidStartedAt = 123 as unknown as string;
  });
  expectReadRejected('supervisorPidStartedAt non-string', (j) => {
    j.supervisorPidStartedAt = false as unknown as string;
  });
  expectReadRejected('pidStartedAt non-parseable', (j) => {
    j.pidStartedAt = 'not-a-valid-iso';
  });
  expectReadRejected('supervisorPidStartedAt non-parseable', (j) => {
    j.supervisorPidStartedAt = 'not-a-valid-iso';
  });
});

test('readJob rejects negative/fraction/string exitCode', () => {
  for (const bad of [-1, 0.5, '0']) {
    expectReadRejected(`exitCode ${JSON.stringify(bad)}`, (j) => {
      j.exitCode = bad as unknown as number;
    });
  }
});

test('a legacy valid Job with later optional fields absent remains readable', () => {
  const j = makeJob();
  // A "later optional fields" legacy record: every field introduced in a later
  // stage is absent entirely, yet the record stays valid and readable.
  for (const k of [
    'pidStartedAt',
    'supervisorPidStartedAt',
    'claudeCli',
    'claudePrefix',
    'extraEnv',
    'attentionLog',
    'attentionResponseAudit',
    'bootstrap',
    'taskType',
    'deliverablePath',
    'deliverableHash',
    'missingDeliverable',
    'workerBackend',
    'replyMode',
    'desiredWorkerConcurrency',
    'admissionState',
    'admissionResourceClass',
    'admissionQueueReason',
    'queuedAt',
    'admittedAt',
    'activeWorkers',
    'queuedWorkers',
    'resourceLimit',
  ] as const) {
    delete (j as unknown as Record<string, unknown>)[k];
  }
  atomicWriteJson(jobFilePath(j.jobId), j);
  const read = readJob(j.jobId);
  assert.ok(read, 'a legacy record with later optional fields absent stays readable');
  assert.equal(read!.jobId, j.jobId);
  assert.equal(read!.status, 'queued');
  assert.equal(read!.maxRuntimeMinutes, 120);
  assert.equal(read!.pidStartedAt, undefined);
  assert.equal(read!.supervisorPidStartedAt, undefined);
  assert.equal(read!.attentionLog, undefined);
  assert.equal(read!.bootstrap, undefined);
  assert.equal(read!.taskType, undefined);
  assert.equal(read!.deliverablePath, undefined);
});

test('listJobs skips parseable corrupt records while returning valid records', () => {
  const fresh = path.join(os.tmpdir(), `orc-list-corrupt-${process.pid}-${Date.now()}`);
  process.env.ORCHESTRATOR_RUNTIME = fresh;
  try {
    const good = makeJob();
    atomicWriteJson(jobFilePath(good.jobId), good);
    const bad = makeJob();
    bad.status = 'not-a-status' as JobStatus;
    atomicWriteJson(jobFilePath(bad.jobId), bad);
    const list = listJobs(20);
    assert.ok(list.some((j) => j.jobId === good.jobId), 'the valid record is listed');
    assert.ok(!list.some((j) => j.jobId === bad.jobId), 'the parseable corrupt record is skipped');
    assert.equal(list.length, 1, 'exactly the valid record survives');
    assert.equal(list[0].jobId, good.jobId);
  } finally {
    process.env.ORCHESTRATOR_RUNTIME = rt;
  }
});

// ---------------------------------------------------------------------------
// parseDoneMarker: the .done terminal-truth gate. A marker that fails to parse
// (non-JobStatus, missing/mismatched jobId, invalid endedAt or exitCode) must
// never be applied to a Job.
// ---------------------------------------------------------------------------

const DONE_ISO = '2026-08-14T00:00:00.000Z';

// Returns null both when parseDoneMarker returns null and when it throws, so
// the acceptance/rejection assertions are robust to either contract.
function parseMarker(raw: unknown, expectedJobId?: string): DoneMarker | null {
  try {
    return parseDoneMarker(raw, expectedJobId);
  } catch {
    return null;
  }
}

test('parseDoneMarker accepts legitimate succeeded/failed/cancelled/needs_attention markers', () => {
  const ok = parseMarker({ jobId: 'job-a', status: 'succeeded', exitCode: 0, endedAt: DONE_ISO }, 'job-a');
  assert.ok(ok, 'succeeded marker with a matching jobId is accepted');
  assert.equal(ok!.jobId, 'job-a');
  assert.equal(ok!.status, 'succeeded');
  assert.equal(ok!.exitCode, 0);
  assert.equal(ok!.endedAt, DONE_ISO);

  const failed = parseMarker({ jobId: 'job-f', status: 'failed', exitCode: 1 });
  assert.ok(failed, 'failed marker with no endedAt is accepted');
  assert.equal(failed!.status, 'failed');
  assert.equal(failed!.exitCode, 1);
  assert.equal(failed!.endedAt, null, 'absent endedAt is normalized to null');

  const cancelled = parseMarker({ jobId: 'job-c', status: 'cancelled', exitCode: null, endedAt: null });
  assert.ok(cancelled, 'cancelled marker with null exitCode/endedAt is accepted');
  assert.equal(cancelled!.status, 'cancelled');
  assert.equal(cancelled!.exitCode, null);
  assert.equal(cancelled!.endedAt, null);

  const attention = parseMarker({ jobId: 'job-n', status: 'needs_attention', exitCode: null });
  assert.ok(attention, 'needs_attention marker is accepted');
  assert.equal(attention!.status, 'needs_attention');
  assert.equal(attention!.exitCode, null);
  assert.equal(attention!.endedAt, null);
});

test('parseDoneMarker rejects missing, unknown or non-JobStatus status', () => {
  assert.equal(parseMarker({}), null, 'a marker with no jobId/status is rejected');
  assert.equal(parseMarker({ jobId: 'x', status: 'not-a-status' }), null, 'a non-JobStatus status is rejected');
  assert.equal(parseMarker({ jobId: 'x', status: 'unknown' }), null, 'unknown status is rejected');
  assert.equal(parseMarker({ jobId: 'x', exitCode: 0 }), null, 'a missing status is rejected');
});

test('parseDoneMarker rejects queued/running status at the parser boundary', () => {
  assert.equal(parseMarker({ jobId: 'x', status: 'queued', exitCode: null }), null, 'queued status is rejected');
  assert.equal(parseMarker({ jobId: 'x', status: 'running', exitCode: null }), null, 'running status is rejected');
});

test('parseDoneMarker rejects invalid, empty or mismatched jobId', () => {
  assert.equal(parseMarker({ status: 'succeeded' }), null, 'a missing jobId is rejected');
  assert.equal(parseMarker({ jobId: 123, status: 'succeeded' }), null, 'a non-string jobId is rejected');
  assert.equal(parseMarker({ jobId: '', status: 'succeeded' }), null, 'an empty jobId is rejected');
  assert.equal(parseMarker({ jobId: 'other', status: 'succeeded' }, 'expected'), null, 'a mismatched jobId is rejected');
  const match = parseMarker({ jobId: 'expected', status: 'succeeded', exitCode: null }, 'expected');
  assert.ok(match && match.status === 'succeeded', 'a matching jobId is accepted');
  const noExpected = parseMarker({ jobId: 'job-b', status: 'succeeded', exitCode: null });
  assert.ok(noExpected && noExpected.status === 'succeeded', 'a valid jobId with no expected id is accepted');
});

test('parseDoneMarker rejects invalid endedAt', () => {
  assert.equal(parseMarker({ jobId: 'x', status: 'succeeded', endedAt: 'not-a-date' }), null, 'a non-date endedAt is rejected');
  assert.equal(parseMarker({ jobId: 'x', status: 'succeeded', endedAt: 123 }), null, 'a non-string endedAt is rejected');
});

test('parseDoneMarker rejects negative/fraction/string exitCode', () => {
  for (const bad of [-1, 0.5, '0']) {
    assert.equal(
      parseMarker({ jobId: 'x', status: 'succeeded', exitCode: bad }),
      null,
      `exitCode ${JSON.stringify(bad)} is rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// Wave 5A2a: JobIndex persistence hook (feature-flagged).
//
// Each test redirects ORCHESTRATOR_RUNTIME to a fresh temp dir and sets the
// flag explicitly, so a flag-off assertion never sees a directory created by a
// flag-on test (and vice versa). The in-process cache is keyed per runtime
// root; invalidateJobIndexForTests() clears it after each switch so no stale
// entry from a previous root/flag state leaks into the next scenario.
// ---------------------------------------------------------------------------

const RETENTION_FLAG = 'ORCHESTRATOR_RETENTION_V2';

function retentionFreshDir(label: string): string {
  return path.join(os.tmpdir(), `orc-retention-${label}-${process.pid}-${Date.now()}`);
}

function withRetentionRuntime(label: string, flagOn: boolean, fn: (root: string) => void): void {
  const root = retentionFreshDir(label);
  const prevFlag = process.env[RETENTION_FLAG];
  const prevRoot = process.env.ORCHESTRATOR_RUNTIME;
  if (flagOn) process.env[RETENTION_FLAG] = '1';
  else delete process.env[RETENTION_FLAG];
  process.env.ORCHESTRATOR_RUNTIME = root;
  try {
    fn(root);
  } finally {
    invalidateJobIndexForTests();
    if (prevFlag === undefined) delete process.env[RETENTION_FLAG];
    else process.env[RETENTION_FLAG] = prevFlag;
    process.env.ORCHESTRATOR_RUNTIME = prevRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Create a job directly on disk (bypasses the index mirror on purpose). */
function seedJob(root: string, overrides: Partial<Job> = {}): Job {
  const j = makeJob();
  Object.assign(j, overrides);
  atomicWriteJson(jobFilePath(j.jobId), j);
  return j;
}

test('retention flag off: no job-index directory is ever created', () => {
  withRetentionRuntime('off', false, () => {
    const j = makeJob();
    createJobRecord(j);
    updateJob(j.jobId, { status: 'running' });
    const after = ensureJobIndex();
    assert.equal(after.dirty, false);
    assert.equal(after.diagnostics.consistency, 'missing');
    assert.equal(indexedJobIdsForSession(j.sessionId).length, 0);
    assert.equal(indexedStatusCounts().running, 0);
    assert.ok(!fs.existsSync(indexDir()), 'flag off must not create runtime/job-index');
  });
});

test('retention flag on: create + status updates are visible in the session/status index', () => {
  withRetentionRuntime('on', true, () => {
    const j = makeJob();
    const created = createJobRecord(j);
    assert.ok(created);
    assert.equal(ensureJobIndex().diagnostics.consistency, 'consistent');
    assert.deepEqual(indexedJobIdsForSession(j.sessionId), [j.jobId]);
    assert.equal(indexedStatusCounts().queued, 1);

    assert.ok(updateJob(j.jobId, { status: 'running' }));
    assert.equal(ensureJobIndex().diagnostics.consistency, 'consistent');
    assert.deepEqual(indexedJobIdsForSession(j.sessionId), [j.jobId]);
    assert.equal(indexedStatusCounts().running, 1);
    assert.equal(indexedStatusCounts().queued, 0);

    assert.ok(updateJobIf(j.jobId, (cur) => cur.status === 'running', { status: 'succeeded', endedAt: new Date().toISOString() }));
    assert.deepEqual(indexedJobIdsForSession(j.sessionId), [j.jobId]);
    assert.equal(indexedStatusCounts().succeeded, 1);
  });
});

test('retention on: replyToJobId relation is indexed (reply chain queryable)', () => {
  withRetentionRuntime('reply', true, () => {
    const rootJob = makeJob();
    createJobRecord(rootJob);
    const reply = makeJob();
    reply.kind = 'reply';
    reply.replyToJobId = rootJob.jobId;
    reply.sessionId = rootJob.sessionId;
    reply.startedAt = new Date(Date.now() + 1000).toISOString();
    createJobRecord(reply);
    ensureJobIndex();
    const ids = indexedJobIdsForSession(rootJob.sessionId);
    assert.deepEqual(ids, [rootJob.jobId, reply.jobId], 'session order is (startedAt asc, jobId asc)');
  });
});

test('retention on: cache is isolated per runtime root', () => {
  withRetentionRuntime('iso-a', true, (rootA) => {
    const a = makeJob();
    createJobRecord(a);
    assert.equal(indexedJobIdsForSession(a.sessionId).length, 1);

    const rootB = retentionFreshDir('iso-b');
    process.env.ORCHESTRATOR_RUNTIME = rootB;
    try {
      const b = makeJob();
      createJobRecord(b);
      assert.equal(indexedJobIdsForSession(a.sessionId).length, 0, 'root A session is not visible in root B');
      assert.equal(indexedJobIdsForSession(b.sessionId).length, 1);
      assert.ok(fs.existsSync(indexDir()), 'root B index exists');
      assert.ok(fs.existsSync(indexDir(rootA)), 'root A index untouched');
      assert.equal(indexedStatusCounts().queued, 1, 'status counts are per-root');
    } finally {
      process.env.ORCHESTRATOR_RUNTIME = rootA;
      fs.rmSync(rootB, { recursive: true, force: true });
    }
  });
});

test('retention on: journal append by another index instance is detected on ensure (stat-only reload)', () => {
  withRetentionRuntime('external', true, (root) => {
    const j = makeJob();
    createJobRecord(j);
    ensureJobIndex();
    assert.equal(indexedJobIdsForSession(j.sessionId).length, 1);

    // Another writer (as another process would) appends a delta straight to the
    // journal file and persists the job JSON; our in-process cache still holds
    // the pre-append state.
    const other = makeJob();
    other.sessionId = j.sessionId;
    other.startedAt = new Date(Date.now() + 2000).toISOString();
    atomicWriteJson(jobFilePath(other.jobId), other);
    const journalPath = indexJournalPath(root);
    const delta = JSON.stringify({
      schemaVersion: 1,
      jobId: other.jobId,
      sessionId: other.sessionId,
      status: 'queued',
      kind: 'start',
      replyToJobId: null,
      startedAt: other.startedAt,
      endedAt: null,
    });
    fs.appendFileSync(journalPath, `${delta}\n`, 'utf8');
    assert.equal(indexedJobIdsForSession(j.sessionId).length, 1, 'stale cache before ensure');

    ensureJobIndex();
    const ids = indexedJobIdsForSession(j.sessionId);
    assert.deepEqual(ids, [j.jobId, other.jobId], 'ensure detected the external append and reloaded');
  });
});

test('retention on: lock-busy on the index does not fail the job write and dirty is cleared after rebuild', () => {
  withRetentionRuntime('busy', true, (root) => {
    const j = makeJob();
    createJobRecord(j); // first mirror succeeds -> consistent cache
    const lockPath = indexDir(root) + '/index.lock';
    // Hold the index lock as a live foreign owner: write a valid lock record
    // with OUR pid and the REAL OS process start time, so pidIdentityStatus
    // sees a verified_live owner and recordIndexedJob's acquire returns busy.
    // (A fresh `new Date().toISOString()` would mismatch once the suite process
    // is older than the identity tolerance and the lock would be stolen.)
    const held = {
      schemaVersion: 1,
      ownerId: 'foreign-holder',
      ownerPid: process.pid,
      ownerStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    atomicWriteJson(lockPath, held);

    // The job write itself must succeed even though the index mirror cannot.
    const updated = updateJob(j.jobId, { status: 'running' });
    assert.ok(updated, 'job write succeeds while the index lock is held');
    assert.equal(readJob(j.jobId)?.status, 'running', 'job JSON is the source of truth');
    assert.equal(ensureJobIndex().dirty, true, 'the failed mirror marks the entry dirty');

    fs.unlinkSync(lockPath); // owner releases
    ensureJobIndex();
    const idx = loadIndex(root);
    assert.equal(idx.diagnostics.consistency, 'consistent', 'ensure rebuilt the index after the lock cleared');
    assert.equal(statusCountsOf(idx.index).running, 1, 'rebuild reflects the job write that had failed to mirror');
  });
});

test('retention on: corrupt journal triggers a rebuild that restores a consistent index', () => {
  withRetentionRuntime('corrupt', true, (root) => {
    const j = makeJob();
    createJobRecord(j);
    // Append a bad line after the valid ones: loadIndex keeps the verified
    // prefix and reports rebuild_required.
    const journalPath = indexJournalPath(root);
    fs.appendFileSync(journalPath, '{this is not json}\n', 'utf8');
    const r = ensureJobIndex();
    assert.equal(r.diagnostics.consistency, 'consistent', 'ensure rebuilt over the corrupt tail');
    assert.equal(indexedJobIdsForSession(j.sessionId).length, 1, 'the job is still indexed');
    assert.equal(indexedStatusCounts().queued, 1);
    assert.ok(fs.existsSync(indexDir(root) + '/archive'), 'the corrupt journal was archived, never deleted');
  });
});

test('retention on: legacy jobs with no index are still readable and never force an index on readJob', () => {
  withRetentionRuntime('legacy', true, () => {
    const legacy = seedJob('', { status: 'succeeded', endedAt: new Date().toISOString() });
    assert.ok(readJob(legacy.jobId), 'legacy job reads fine');
    assert.ok(!fs.existsSync(indexDir()), 'plain readJob never creates the index dir');
    // After a rebuild the legacy job is indexed too.
    const rebuilt = rebuildJobIndexNow();
    assert.ok(rebuilt && rebuilt.indexed >= 1, 'rebuild indexed the legacy job');
    assert.equal(indexedJobIdsForSession(legacy.sessionId).length, 1);
  });
});

test('retention on: index API never exposes prompt, paths or PID', () => {
  withRetentionRuntime('public', true, (root) => {
    const j = makeJob();
    j.prompt = 'SECRET PROMPT';
    j.workFolder = 'C:\\secret\\work';
    j.logPath = 'C:\\secret\\logs\\x.log';
    j.reportPath = 'C:\\secret\\reports\\x.txt';
    j.pid = 123456;
    createJobRecord(j);
    ensureJobIndex();
    // The in-memory JobIndex records are minimal and sanitized (no prompt,
    // no paths, no PID) — the same record set that loadIndex/replay yields.
    const index = ensureJobIndex().index;
    const rec = index.byId.get(j.jobId);
    assert.ok(rec);
    assert.deepEqual(Object.keys(rec).sort(), ['endedAt', 'jobId', 'kind', 'replyToJobId', 'sessionId', 'startedAt', 'status']);
    const serialized = JSON.stringify(rec);
    assert.ok(!serialized.includes('SECRET PROMPT'), 'prompt never surfaces');
    assert.ok(!serialized.includes('secret'), 'paths never surface');
    assert.ok(!serialized.includes('123456'), 'pid never surfaces');
    // Wave 5A2b1: the session index API returns STRING ids only — the caller
    // must readJob each id to see the persisted truth, which keeps prompts,
    // paths and PIDs out of the indexed surface entirely.
    const ids = indexedJobIdsForSession(j.sessionId);
    assert.deepEqual(ids, [j.jobId]);
    assert.ok(ids.every((id) => typeof id === 'string'), 'indexed ids are plain strings, never full Jobs');
    const idsJson = JSON.stringify(ids);
    assert.ok(!idsJson.includes('SECRET PROMPT'), 'id surface never carries the prompt');
    assert.ok(!idsJson.includes('secret'), 'id surface never carries paths');
    assert.ok(!idsJson.includes('123456'), 'id surface never carries the pid');
    assert.equal(indexedStatusCounts().queued, 1);
  });
});

// ---------------------------------------------------------------------------
// Wave 5A2b1: peekJobIndexForHealth — narrow read-only health snapshot.
//
// Same runtime-isolation helper as Wave 5A2a (withRetentionRuntime). The
// rebuild scheduler test awaits the setImmediate flush via a promise around
// setImmediate, with the scheduler's in-process idempotency hooks so a test
// can force a fresh queue state (the hooks are exported for tests only and
// are never called by production code).
// ---------------------------------------------------------------------------

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function flushScheduledRebuild(): Promise<void> {
  // The queued rebuild runs on setImmediate; one await after scheduling lets
  // the rebuild and its cleanup run. forceNext is cleared by the test itself.
  await flushImmediate();
}

/** Async variant of withRetentionRuntime: awaits fn so a queued rebuild
 *  completes BEFORE the runtime root is torn down. */
async function withRetentionRuntimeAsync(label: string, flagOn: boolean, fn: (root: string) => Promise<void>): Promise<void> {
  const root = retentionFreshDir(label);
  const prevFlag = process.env[RETENTION_FLAG];
  const prevRoot = process.env.ORCHESTRATOR_RUNTIME;
  if (flagOn) process.env[RETENTION_FLAG] = '1';
  else delete process.env[RETENTION_FLAG];
  process.env.ORCHESTRATOR_RUNTIME = root;
  try {
    await fn(root);
  } finally {
    invalidateJobIndexForTests();
    if (prevFlag === undefined) delete process.env[RETENTION_FLAG];
    else process.env[RETENTION_FLAG] = prevFlag;
    process.env.ORCHESTRATOR_RUNTIME = prevRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

function peekFreshState(): ReturnType<typeof peekJobIndexForHealth> {
  // Force a fresh cache entry so the peeks below reflect the CURRENT disk
  // index state of the active runtime root (the cache is per-root).
  invalidateJobIndexForTests();
  return peekJobIndexForHealth();
}

test('Wave5A2b1: peekJobIndexForHealth flag off -> enabled=false, fixed empty surface, never creates the index dir', () => {
  withRetentionRuntime('peek-off', false, () => {
    const j = makeJob();
    createJobRecord(j);
    const snap = peekJobIndexForHealth();
    assert.equal(snap.enabled, false);
    assert.equal(snap.dirty, false);
    assert.equal(snap.indexSize, 0);
    assert.equal(snap.rebuildScheduled, false);
    assert.equal(snap.diagnostics.consistency, 'missing');
    assert.deepEqual(snap.statusCounts, { queued: 0, running: 0, needs_attention: 0, succeeded: 0, failed: 0, cancelled: 0 });
    assert.ok(!fs.existsSync(indexDir()), 'flag off must not create runtime/job-index');
  });
});

test('Wave5A2b1: peekJobIndexForHealth flag on -> cached statusCounts/indexSize/diagnostics, no Job/ids/paths/PID', () => {
  withRetentionRuntime('peek-on', true, (root) => {
    const j = makeJob();
    createJobRecord(j);
    updateJob(j.jobId, { status: 'running' });
    assert.equal(ensureJobIndex().diagnostics.consistency, 'consistent');

    const snap = peekFreshState();
    assert.equal(snap.enabled, true);
    assert.equal(snap.indexSize, 1);
    assert.equal(snap.statusCounts.running, 1);
    assert.equal(snap.statusCounts.queued, 0);
    assert.equal(snap.diagnostics.consistency, 'consistent');
    assert.equal(snap.dirty, false);
    assert.equal(snap.rebuildScheduled, false);

    // Non-sensitive surface only.
    const keys = Object.keys(snap).sort();
    assert.deepEqual(keys, ['diagnostics', 'dirty', 'enabled', 'indexSize', 'rebuildScheduled', 'statusCounts']);
    const raw = JSON.stringify(snap);
    assert.ok(!raw.includes(j.jobId), 'no job ids');
    assert.ok(!raw.includes('SECRET PROMPT'), 'no prompt');
    assert.ok(!raw.includes(rt), 'no paths');
    assert.ok(!raw.includes('workFolder'), 'no path fields');
  });
});

test('Wave5A2b1: peek reflects an inconsistent index (corrupt journal tail) without rebuilding', () => {
  withRetentionRuntime('peek-inconsistent', true, (root) => {
    const j = makeJob();
    createJobRecord(j);
    ensureJobIndex();
    const journalPath = indexJournalPath(root);
    fs.appendFileSync(journalPath, '{corrupt tail}\n', 'utf8');

    const snap = peekFreshState();
    assert.equal(snap.enabled, true);
    assert.equal(snap.indexSize, 1, 'cache still serves the pre-corruption size');
    assert.equal(snap.diagnostics.consistency, 'rebuild_required', 'the corrupt tail is visible in diagnostics');
    // The peek must never have rebuilt: the journal file still exists.
    assert.ok(fs.existsSync(journalPath), 'peek never archives/rebuilds the journal');
    assert.equal(snap.rebuildScheduled, false, 'peek itself never schedules a rebuild');
  });
});

test('Wave5A2b1: scheduleJobIndexRebuild flag off is a no-op', () => {
  withRetentionRuntime('sched-off', false, () => {
    assert.equal(scheduleJobIndexRebuild(), false);
    assert.ok(!fs.existsSync(indexDir()), 'flag off scheduling must not create the index dir');
  });
});

test('Wave5A2b1: scheduleJobIndexRebuild is async, in-process idempotent, clears on completion', async () => {
  await withRetentionRuntimeAsync('sched-on', true, async (root) => {
    const j = makeJob();
    j.status = 'succeeded';
    j.endedAt = new Date().toISOString();
    createJobRecord(j); // mirrors into the cache -> consistent
    assert.equal(scheduleJobIndexRebuild(), true, 'first schedule returns true');
    assert.equal(peekJobIndexForHealth().rebuildScheduled, true, 'public snapshot reports the queued rebuild');
    assert.equal(scheduleJobIndexRebuild(), false, 'second schedule while queued is idempotent');
    assert.equal(peekJobIndexForHealth().rebuildScheduled, true, 'still queued after the duplicate attempt');
    await flushScheduledRebuild();
    assert.equal(peekJobIndexForHealth().rebuildScheduled, false, 'marker cleared after the rebuild ran');
    assert.ok(fs.existsSync(indexDir(root) + '/snapshot.json'), 'the async rebuild wrote a snapshot');
  });
});

test('Wave5A2b1: test hooks can force and observe scheduling state', () => {
  withRetentionRuntime('sched-hooks', true, () => {
    const j = makeJob();
    j.status = 'succeeded';
    j.endedAt = new Date().toISOString();
    createJobRecord(j);
    scheduleJobIndexRebuildTestHooks.alreadyScheduled = false;
    scheduleJobIndexRebuildTestHooks.forceNext = true;
    try {
      assert.equal(scheduleJobIndexRebuild(), true);
      assert.equal(scheduleJobIndexRebuildTestHooks.alreadyScheduled, true, 'hook observed the queued state');
    } finally {
      scheduleJobIndexRebuildTestHooks.alreadyScheduled = undefined;
      scheduleJobIndexRebuildTestHooks.forceNext = undefined;
    }
  });
});

after(() => {
  invalidateJobIndexForTests();
  try {
    fs.rmSync(rt, { recursive: true, force: true });
  } catch {
    /* best effort: temp dir cleanup must never fail the run */
  }
});
