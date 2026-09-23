// Unit tests for the shared JobEventBroker and the watchJob core, driven by
// synthetic job files (no fake claude / no detached supervisors). Uses a fast
// internal fallback interval so tests are deterministic even if Windows
// fs.watch misses a directory event.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rt = path.join(os.tmpdir(), `orc-events-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0';

import {
  atomicWriteJson,
  jobFilePath,
  doneFilePath,
  updateJob,
  newJobId,
  newSessionId,
  type Job,
} from '../src/job-store.js';
import {
  setFallbackMsForTest,
  closeJobEventBrokerForTest,
  brokerDiagnostics,
  emitWatcherErrorForTest,
  jobEventTestHooks,
} from '../src/job-events.js';
import { watchJob, clampWatchSeconds, watchTestHooks } from '../src/scheduler.js';
import { WATCH_DEFAULT_SECONDS, WATCH_MAX_SECONDS } from '../src/config.js';

setFallbackMsForTest(25);
after(() => closeJobEventBrokerForTest());

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

function makeJob(status: Job['status'] = 'running', extra: Partial<Job> = {}): Job {
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
    status,
    substatus: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    lastActivityAt: new Date().toISOString(),
    exitCode: null,
    logPath: '',
    stderrLogPath: '',
    reportPath: path.join(rt, 'reports', `${status}-${newJobId()}.txt`),
    prompt: 'SECRET PROMPT',
    lastOutputAt: null,
    ...extra,
  };
}

test('clampWatchSeconds: default 14400, floor 1, cap 14400', () => {
  assert.equal(clampWatchSeconds(undefined), WATCH_DEFAULT_SECONDS);
  assert.equal(clampWatchSeconds(5), 5);
  assert.equal(clampWatchSeconds(0.5), 1);
  assert.equal(clampWatchSeconds(-3), 1);
  assert.equal(clampWatchSeconds(999999), WATCH_MAX_SECONDS);
  assert.equal(clampWatchSeconds(Number.NaN), WATCH_DEFAULT_SECONDS);
});

test('watch on a missing job returns not_found immediately', async () => {
  const t0 = Date.now();
  const v = await watchJob('missing-job-id', { timeoutSeconds: 30 });
  assert.ok(Date.now() - t0 < 1000, 'not-found must be fast');
  assert.equal(v.wakeReason, 'not_found');
  assert.equal(v.status, 'not_found');
});

test('already-terminal job returns immediately without subscribing', async () => {
  const job = makeJob('succeeded', { endedAt: new Date().toISOString(), exitCode: 0 });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const t0 = Date.now();
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.ok(Date.now() - t0 < 1000, 'terminal must return immediately');
  assert.equal(v.wakeReason, 'terminal');
  assert.equal(v.status, 'succeeded');
  assert.equal(brokerDiagnostics().subscribers, 0, 'no subscriber should be created');
});

test('already needs_attention returns immediately with a hint', async () => {
  const job = makeJob('needs_attention', { substatus: 'permission_request' });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.wakeReason, 'needs_attention');
  assert.equal(v.status, 'needs_attention');
  assert.ok(v.attention && v.attention.length > 0, 'attention hint present');
});

test('running -> succeeded wakes exactly once and cleans up', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  let wakeCount = 0;
  const p = watchJob(job.jobId, { timeoutSeconds: 10 }).then((v) => {
    wakeCount += 1;
    return v;
  });
  await sleep(100);
  assert.equal(wakeCount, 0, 'must not resolve while still running');
  updateJob(job.jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
  const v = await p;
  assert.equal(v.wakeReason, 'terminal');
  assert.equal(v.status, 'succeeded');
  assert.equal(wakeCount, 1, 'resolves exactly once');
  await sleep(80);
  assert.equal(wakeCount, 1, 'no spurious wake after resolution');
  assert.equal(brokerDiagnostics().subscribers, 0);
});

test('running -> failed wakes once with substatus', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(job.jobId, { status: 'failed', substatus: 'exit_1', endedAt: new Date().toISOString(), exitCode: 1 });
  const v = await p;
  assert.equal(v.status, 'failed');
  assert.equal(v.substatus, 'exit_1');
});

test('running -> cancelled wakes once', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(job.jobId, { status: 'cancelled', substatus: 'test cancel', endedAt: new Date().toISOString() });
  const v = await p;
  assert.equal(v.status, 'cancelled');
  assert.equal(v.substatus, 'test cancel');
});

test('needs_attention while alive wakes the watch (no done marker needed)', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  // Supervisor writes needs_attention into the job JSON while Claude is alive.
  updateJob(job.jobId, { status: 'needs_attention', substatus: 'permission_request' });
  const v = await p;
  assert.equal(v.wakeReason, 'needs_attention');
  assert.equal(v.status, 'needs_attention');
  assert.ok(!fs.existsSync(doneFilePath(job.jobId)), 'no done marker is needed to wake');
});

test('check/subscribe race: job completing in the recheck window is not missed', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  let recheckRan = false;
  watchTestHooks.beforeRecheck = (id) => {
    recheckRan = true;
    updateJob(id, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
  };
  try {
    const v = await watchJob(job.jobId, { timeoutSeconds: 5 });
    assert.equal(recheckRan, true, 'recheck seam was exercised');
    assert.equal(v.status, 'succeeded');
    assert.equal(v.wakeReason, 'terminal');
  } finally {
    watchTestHooks.beforeRecheck = undefined;
  }
  assert.equal(brokerDiagnostics().subscribers, 0);
});

test('multiple watchers on one job all wake, no listener/handle leak', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p1 = watchJob(job.jobId, { timeoutSeconds: 10 });
  const p2 = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(job.jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
  const [v1, v2] = await Promise.all([p1, p2]);
  assert.equal(v1.status, 'succeeded');
  assert.equal(v2.status, 'succeeded');
  assert.equal(brokerDiagnostics().subscribers, 0, 'all watchers cleaned up');
  assert.equal(brokerDiagnostics().watcher, false, 'dir watcher closed when idle');
  assert.equal(brokerDiagnostics().fallback, false, 'fallback closed when idle');
});

test('abort resolves with watch_cancelled and never touches the job', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const ac = new AbortController();
  const p = watchJob(job.jobId, { signal: ac.signal, timeoutSeconds: 10 });
  await sleep(50);
  ac.abort();
  const v = await p;
  assert.equal(v.wakeReason, 'watch_cancelled');
  assert.equal(v.status, 'watch_cancelled');
  const after = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as Job;
  assert.equal(after.status, 'running', 'job status untouched by abort');
  assert.equal(brokerDiagnostics().subscribers, 0);
});

test('watch timeout resolves as watch_timeout and does not cancel the job', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const t0 = Date.now();
  const v = await watchJob(job.jobId, { timeoutSeconds: 1 });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 900 && elapsed < 3000, `watch_timeout should fire ~1s (took ${elapsed}ms)`);
  assert.equal(v.wakeReason, 'watch_timeout');
  assert.equal(v.status, 'watch_timeout');
  const after = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as Job;
  assert.equal(after.status, 'running', 'job still running after watch timeout');
});

test('fs.watch error: broken watcher closes but fallback still wakes the watch', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  assert.equal(await waitFor(() => brokerDiagnostics().watcher, 2000), true, 'watcher established');
  const emitted = emitWatcherErrorForTest(new Error('simulated watcher error'));
  assert.equal(emitted, true);
  assert.equal(brokerDiagnostics().watcher, false, 'broken watcher closed');
  // The fast fallback still wakes the watch when the job finishes.
  updateJob(job.jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
  const v = await p;
  assert.equal(v.status, 'succeeded');
});

test('fs.watch error: watcher is rebuilt while subscribers remain', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  assert.equal(await waitFor(() => brokerDiagnostics().watcher, 2000), true);
  emitWatcherErrorForTest();
  assert.equal(brokerDiagnostics().watcher, false);
  const rebuilt = await waitFor(() => brokerDiagnostics().watcher, 3000);
  assert.equal(rebuilt, true, 'watcher should be rebuilt while subscribers remain');
  // Release the subscriber and confirm teardown.
  updateJob(job.jobId, { status: 'cancelled', endedAt: new Date().toISOString() });
  await p;
  assert.equal(brokerDiagnostics().subscribers, 0);
});

test('broker works in fallback-only mode when fs.watch creation fails', async () => {
  const prev = jobEventTestHooks.createDirWatcher;
  jobEventTestHooks.createDirWatcher = () => null;
  try {
    const job = makeJob('running');
    atomicWriteJson(jobFilePath(job.jobId), job);
    const p = watchJob(job.jobId, { timeoutSeconds: 10 });
    assert.equal(brokerDiagnostics().watcher, false, 'no dir watcher in fallback-only mode');
    await sleep(50);
    updateJob(job.jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
    const v = await p;
    assert.equal(v.status, 'succeeded');
  } finally {
    jobEventTestHooks.createDirWatcher = prev;
  }
});

test('broker starts shared resources only while subscribed and stops when idle', async () => {
  assert.equal(brokerDiagnostics().watcher, false);
  assert.equal(brokerDiagnostics().fallback, false);
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  assert.equal(await waitFor(() => brokerDiagnostics().watcher || brokerDiagnostics().fallback, 2000), true);
  updateJob(job.jobId, { status: 'failed', substatus: 'x', endedAt: new Date().toISOString() });
  await p;
  assert.equal(brokerDiagnostics().subscribers, 0);
  assert.equal(brokerDiagnostics().watcher, false);
  assert.equal(brokerDiagnostics().fallback, false);
});

test('watch output stays compact: no prompt, token, raw log, or diff', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  fs.mkdirSync(path.join(rt, 'reports'), { recursive: true });
  fs.writeFileSync(job.reportPath, 'short report body');
  const p = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(job.jobId, { status: 'succeeded', substatus: null, endedAt: new Date().toISOString(), exitCode: 0 });
  const v = await p;
  assert.equal(v.hasReport, true);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('SECRET PROMPT'), 'no prompt leak');
  assert.ok(!raw.includes('PROXY_MANAGED'), 'no token leak');
  assert.ok(!raw.includes('"progress"'), 'no raw log tail');
  assert.ok(!('prompt' in v), 'no prompt field');
  assert.ok(!('logPath' in v), 'no log path field');
  // jobId, status, wakeReason, substatus, elapsedSeconds, idleSeconds,
  // reportPath, hasReport, replyMode (attention absent for a succeeded job).
  // Exact 9-key shape: replyMode is a first-class key (mirrors WatchView),
  // null for jobs that never went through reply preflight.
  assert.equal(Object.keys(v).length, 9, 'compact shape');
  assert.equal(v.replyMode, null, 'replyMode present and null for a job that never went through reply preflight');
  const j = makeJob('running');
  j.replyMode = 'fresh_turn';
  atomicWriteJson(jobFilePath(j.jobId), j);
  const p2 = watchJob(j.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(j.jobId, { status: 'succeeded', substatus: null, endedAt: new Date().toISOString(), exitCode: 0 });
  const v2 = await p2;
  assert.equal(Object.keys(v2).length, 9, 'compact shape with replyMode');
  assert.equal(v2.replyMode, 'fresh_turn', 'replyMode mirrors the job record');
});

test('a second watch re-attaches after the first was aborted', async () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const ac = new AbortController();
  const p1 = watchJob(job.jobId, { signal: ac.signal, timeoutSeconds: 10 });
  await sleep(50);
  ac.abort();
  const v1 = await p1;
  assert.equal(v1.wakeReason, 'watch_cancelled');
  const p2 = watchJob(job.jobId, { timeoutSeconds: 10 });
  await sleep(50);
  updateJob(job.jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
  const v2 = await p2;
  assert.equal(v2.status, 'succeeded');
  assert.equal(v2.jobId, job.jobId);
});
