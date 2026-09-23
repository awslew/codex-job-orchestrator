// Fast, offline attention-race stress coverage. Each iteration owns an
// isolated runtime so no state or broker subscription can bleed into another
// job. No Claude, supervisor, or real worker is started here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const previousRuntime = process.env.ORCHESTRATOR_RUNTIME;
process.env.OPEN_LIVE_VIEW = '0';

import {
  atomicWriteJson,
  jobFilePath,
  newJobId,
  newSessionId,
  updateJob,
  type Job,
} from '../src/job-store.js';
import { closeJobEventBrokerForTest, brokerDiagnostics, setFallbackMsForTest } from '../src/job-events.js';
import { getStatus, watchJob } from '../src/scheduler.js';
import type { AttentionSummary } from '../src/parser.js';

const ITERATIONS = 20;
const WATCH_TIMEOUT_SECONDS = 1;
const FALLBACK_MS = 10;

function makeJob(runtime: string, jobId: string, promptSecret: string): Job {
  const now = new Date().toISOString();
  return {
    jobId,
    sessionId: newSessionId(),
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'auto',
    parallelism: 'auto',
    workFolder: runtime,
    maxRuntimeMinutes: 120,
    pid: null,
    supervisorPid: null,
    status: 'running',
    substatus: null,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    exitCode: null,
    logPath: '',
    stderrLogPath: '',
    reportPath: path.join(runtime, 'reports', `${jobId}.txt`),
    prompt: promptSecret,
    lastOutputAt: null,
  };
}

function makeAttention(requestId: string, iteration: number): AttentionSummary {
  return {
    requestId,
    requestIdSource: 'upstream',
    tool: 'Bash',
    action: 'run',
    path: `iteration-${iteration}.txt`,
    risk: 'high',
    at: new Date().toISOString(),
    message: '需要审批：执行离线竞态测试',
  };
}

after(() => {
  closeJobEventBrokerForTest();
  setFallbackMsForTest(15_000);
  if (previousRuntime === undefined) delete process.env.ORCHESTRATOR_RUNTIME;
  else process.env.ORCHESTRATOR_RUNTIME = previousRuntime;
});

test('20 independent needs_attention races wake two watchers with one sanitized request', async () => {
  setFallbackMsForTest(FALLBACK_MS);
  const createdRuntimes: string[] = [];
  const createdJobIds: string[] = [];
  const startedAt = Date.now();

  try {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const runtime = path.join(
        os.tmpdir(),
        `orc-attention-stress-${process.pid}-${Date.now()}-${iteration}-${crypto.randomUUID()}`,
      );
      const jobId = newJobId();
      const requestId = `attention-stress-${iteration}-${crypto.randomUUID()}`;
      const promptSecret = `ORIGINAL_PROMPT_SECRET_${iteration}_${crypto.randomUUID()}`;
      const tokenSecret = `TOKEN_SECRET_${iteration}_${crypto.randomUUID()}`;
      const pending: Array<Promise<Awaited<ReturnType<typeof watchJob>>>> = [];
      const abortControllers = [new AbortController(), new AbortController()];
      createdRuntimes.push(runtime);
      createdJobIds.push(jobId);

      process.env.ORCHESTRATOR_RUNTIME = runtime;
      fs.mkdirSync(runtime, { recursive: true });
      atomicWriteJson(
        jobFilePath(jobId),
        makeJob(runtime, jobId, `${promptSecret} token=${tokenSecret}`),
      );

      try {
        pending.push(watchJob(jobId, { signal: abortControllers[0].signal, timeoutSeconds: WATCH_TIMEOUT_SECONDS }));
        pending.push(watchJob(jobId, { signal: abortControllers[1].signal, timeoutSeconds: WATCH_TIMEOUT_SECONDS }));
        assert.equal(brokerDiagnostics().subscribers, 2, `iteration ${iteration}: both listeners registered`);

        const attention = makeAttention(requestId, iteration);
        // This is the only state transition in the iteration: a synthetic
        // persisted needs_attention event, never a real worker event.
        const updated = updateJob(jobId, {
          status: 'needs_attention',
          substatus: 'permission_request',
          attentionLog: [attention],
        });
        assert.ok(updated, `iteration ${iteration}: needs_attention update persisted`);

        const [first, second] = await Promise.all(pending);
        for (const [watchIndex, view] of [first, second].entries()) {
          assert.equal(view.wakeReason, 'needs_attention', `iteration ${iteration}, watch ${watchIndex}`);
          assert.equal(view.status, 'needs_attention', `iteration ${iteration}, watch ${watchIndex}`);
          assert.equal(view.attentionDetail?.requestId, requestId, `iteration ${iteration}, watch ${watchIndex}`);
          assert.equal(view.attentionDetail?.requestIdSource, 'upstream', `iteration ${iteration}, watch ${watchIndex}`);
        }

        const persisted = JSON.parse(fs.readFileSync(jobFilePath(jobId), 'utf8')) as Job;
        const persistedAttention = persisted.attentionLog?.at(-1);
        assert.equal(persisted.status, 'needs_attention', `iteration ${iteration}: persisted status`);
        assert.deepEqual(persistedAttention, attention, `iteration ${iteration}: persisted attention detail`);

        const publicStatus = getStatus(jobId);
        assert.equal(publicStatus.status, persisted.status, `iteration ${iteration}: public status`);
        assert.deepEqual(publicStatus.attentionDetail, persistedAttention, `iteration ${iteration}: public detail`);
        const publicViews = JSON.stringify([first, second, publicStatus]);
        assert.ok(!publicViews.includes(promptSecret), `iteration ${iteration}: original prompt leaked`);
        assert.ok(!publicViews.includes(tokenSecret), `iteration ${iteration}: token leaked`);
      } finally {
        abortControllers.forEach((controller) => controller.abort());
        await Promise.allSettled(pending);
        closeJobEventBrokerForTest();
        const diagnostics = brokerDiagnostics();
        // Remove the exact runtime even when a cleanup assertion fails, so a
        // failed iteration cannot leave a watcher-held temp tree behind.
        fs.rmSync(runtime, { recursive: true, force: false });
        assert.deepEqual(
          diagnostics,
          { subscribers: 0, watcher: false, fallback: false },
          `iteration ${iteration}: broker/listener cleanup`,
        );
        assert.equal(fs.existsSync(runtime), false, `iteration ${iteration}: runtime cleanup`);
      }
    }
  } finally {
    closeJobEventBrokerForTest();
    if (previousRuntime === undefined) delete process.env.ORCHESTRATOR_RUNTIME;
    else process.env.ORCHESTRATOR_RUNTIME = previousRuntime;
  }

  assert.equal(createdRuntimes.length, ITERATIONS, 'exactly 20 independent runtimes were created');
  assert.equal(new Set(createdRuntimes).size, ITERATIONS, 'runtimes are unique');
  assert.equal(new Set(createdJobIds).size, ITERATIONS, 'job ids are unique');
  assert.ok(createdRuntimes.every((runtime) => !fs.existsSync(runtime)), 'all temporary runtimes were removed');
  assert.ok(Date.now() - startedAt < 10_000, 'stress test stays fast and offline');
});
