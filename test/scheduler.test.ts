// Integration tests for the scheduler + detached supervisor, driven by the
// fake claude (test/fake-claude.mjs) so nothing hits a real proxy. Runtime
// state is isolated per test-file process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const rt = path.join(os.tmpdir(), `orc-sched-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
// Tests must not pop live-view windows.
process.env.OPEN_LIVE_VIEW = '0';
// Short permission-confirm window for the detached supervisors used here.
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';
// Deterministic spawns: no anti-burst start jitter in tests.
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';

import {
  startJob,
  getStatus,
  getRenderedStatus,
  waitForJob,
  watchJob,
  replyJob,
  cancelJob,
  listJobsView,
  recoverJobs,
  recoverJobsTestHooks,
  clampWaitSeconds,
} from '../src/scheduler.js';
import { atomicWriteJson, atomicWriteTestHooks, jobFilePath, doneFilePath, settingsFilePath, logFilePath, stderrLogFilePath, readJob, updateJob, updateJobIf, isTerminal, type Job } from '../src/job-store.js';
import { rebuildJobIndexNow, invalidateJobIndexForTests } from '../src/job-store.js';
import { buildCommand } from '../src/supervisor.js';
import { WAIT_MAX_SECONDS } from '../src/config.js';
import { newBootstrap } from '../src/recovery.js';
import { pidIdentityStatus } from '../src/proc.js';
import { queryProcessStartTime } from '../src/registry.js';
import type { StartParams } from '../src/router.js';
import type { TaskContractV2 } from '../src/contracts-v2.js';

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');

function fakeParams(over: Partial<StartParams> & { extraEnv?: Record<string, string> } = {}): StartParams {
  return {
    prompt: 'fake task',
    workFolder: rt,
    profile: 'auto',
    parallelism: 'auto',
    maxRuntimeMinutes: 120,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    ...over,
  };
}

function fakeEnv(over: Record<string, string> = {}): Record<string, string> {
  return { FAKE_CLAUDE_RUN_SECONDS: '1', FAKE_CLAUDE_EXIT_CODE: '0', ...over };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// OS-verified identity timestamp for THIS test process, used by live fixtures
// (recovery attach / PID-identity fixtures) so identity verification treats our
// own pid as a verified-live match. Falls back to the registry's own process
// start formula only when the OS query is unavailable.
const SELF_IDENTITY_ISO = new Date(
  queryProcessStartTime(process.pid) ?? Date.now() - process.uptime() * 1000,
).toISOString();

// Poll until the supervisor has finalized the job (endedAt set), then return
// the public view. needs_attention is a valid "final" state for a still-blocked
// worker, so we cannot wait for a terminal status only.
async function waitForFinalized(jobId: string, timeoutMs = 15000): Promise<{ status: string; substatus: string | null; endedAt: string | null }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getStatus(jobId);
    if (s.endedAt) return s;
    await sleep(300);
  }
  throw new Error(`job not finalized: ${jobId}`);
}

async function waitForVerifiedPid(pid: number, startedAtMs: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: ReturnType<typeof pidIdentityStatus> = 'unverifiable';
  while (Date.now() < deadline) {
    lastStatus = pidIdentityStatus(pid, new Date(startedAtMs).toISOString());
    if (lastStatus === 'verified_live') return;
    await sleep(50);
  }
  throw new Error(`pid ${pid} did not reach verified_live before deadline; last status: ${lastStatus}`);
}

function makeRecoveryJob(status: Job['status'], extra: Partial<Job> = {}): Job {
  return {
    jobId: `recover-p2-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: `ses-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'bypassPermissions',
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
    reportPath: '',
    prompt: 'x',
    lastOutputAt: null,
    ...extra,
  };
}

test('clampWaitSeconds caps at 240 and floors at 1', () => {
  assert.equal(clampWaitSeconds(10), 10);
  assert.equal(clampWaitSeconds(9999), WAIT_MAX_SECONDS);
  assert.equal(clampWaitSeconds(0.5), 1);
  assert.equal(clampWaitSeconds(-5), 1);
  assert.equal(clampWaitSeconds(Number.NaN), WAIT_MAX_SECONDS);
});

test('start returns within 10s with correct auto routing (15721+bypass)', async () => {
  const t0 = Date.now();
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10000, `start took ${elapsed}ms`);
  assert.equal(job.profile, 'auto');
  assert.equal(job.port, 15721);
  assert.equal(job.permissionMode, 'bypassPermissions');
  // A very fast detached fake worker may legitimately finish before startJob's
  // final reread, so the returned view is queued, running, OR succeeded;
  // succeeding faster does not violate async start or routing identity.
  assert.ok(
    job.status === 'queued' || job.status === 'running' || job.status === 'succeeded',
    `job status is queued, running, or succeeded, got ${job.status}`,
  );
  assert.ok(job.sessionId);
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'succeeded');
});

test('successful fake job: report written, log non-empty, no prompt leak', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.exitCode, 0);
  assert.ok(final.hasReport, 'report should exist');
  const report = fs.readFileSync(final.reportPath, 'utf8');
  assert.match(report, /DONE/);
  const status = getStatus(job.jobId, 200);
  assert.ok(status.progress.length > 0, 'status should include a short progress tail');
  // Public view must not contain the stored prompt or the auth token value.
  const raw = JSON.stringify(status);
  assert.ok(!raw.includes('fake task'), 'status must not leak the prompt');
  assert.ok(!raw.includes('PROXY_MANAGED'), 'status must not leak auth token');
});

test('rendered status tail is readable text, not half-JSON, and carries the exit banner', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 60);
  const status = getRenderedStatus(job.jobId, { lines: 3, stderrLines: 2 });
  assert.equal(status.status, 'succeeded');
  const progress = status.progress;
  // Rendered assistant text + result.
  assert.match(progress, /working…/, 'rendered tail should include the assistant text');
  assert.match(progress, /DONE/, 'rendered tail should include the final result');
  // No raw stream-json leaks through.
  assert.ok(!progress.includes('"type":"assistant"'), 'rendered tail must not contain raw stream-json');
  // The "why it ended" banner from the stderr log is visible.
  assert.match(progress, /succeeded/, 'rendered tail should include the exit meta banner');
  // Still no prompt / token leakage.
  assert.ok(!JSON.stringify(status).includes('fake task'));
  assert.ok(!JSON.stringify(status).includes('PROXY_MANAGED'));
});

test('exit code 3 maps to needs_attention (permission_required)', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '3' }) }));
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'needs_attention');
  assert.equal(final.substatus, 'permission_required');
});

test('non-zero non-3 exit maps to failed', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '1' }) }));
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'failed');
  assert.equal(final.substatus, 'exit_1');
});

test('userPrompt event while alive -> needs_attention', async (t) => {
  const previousAttentionConfirm = process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS;
  process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '0';
  t.after(() => {
    if (previousAttentionConfirm === undefined) delete process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS;
    else process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = previousAttentionConfirm;
  });
  const { job } = startJob(
    fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_USER_PROMPT: '1', FAKE_CLAUDE_RUN_SECONDS: '3' }) }),
  );
  t.after(() => {
    try {
      cancelJob(job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  });
  let seen: string | null = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const s = getStatus(job.jobId);
    if (s.status === 'needs_attention') {
      seen = s.status;
      break;
    }
    await sleep(300);
  }
  assert.equal(seen, 'needs_attention');
  // Let it finish; supervisor must finalize without error.
  const final = await waitForJob(job.jobId, 30);
  assert.ok(['succeeded', 'needs_attention'].includes(final.status));
});

async function waitForFile(p: string, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return;
    await sleep(100);
  }
  throw new Error(`file did not appear: ${p}`);
}

test('settings file injects a routed base URL only when an endpoint is configured', async () => {
  // New contract (see config.anthropicRoute): with
  // ORCHESTRATOR_ANTHROPIC_BASE_URL unset the supervisor injects NO endpoint at
  // all, so a fresh install inherits the Claude CLI's own credentials instead of
  // being forced onto a local proxy that does not exist on the user's machine.
  const autoJob = startJob(fakeParams({ extraEnv: fakeEnv() })).job;
  await waitForFile(settingsFilePath(autoJob.jobId));
  const autoSettings = JSON.parse(fs.readFileSync(settingsFilePath(autoJob.jobId), 'utf8'));
  assert.equal(autoSettings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(autoSettings.env.ANTHROPIC_AUTH_TOKEN, undefined);
  await waitForJob(autoJob.jobId, 60);

  const reviewJob = startJob(
    fakeParams({ profile: 'review', extraEnv: fakeEnv() }),
  ).job;
  await waitForFile(settingsFilePath(reviewJob.jobId));
  const reviewSettings = JSON.parse(fs.readFileSync(settingsFilePath(reviewJob.jobId), 'utf8'));
  assert.equal(reviewSettings.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(reviewJob.port, 15721);
  assert.equal(reviewJob.permissionMode, 'plan');
  await waitForJob(reviewJob.jobId, 60);
});

test('reply resumes the same session as a new job', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 60);
  const reply = replyJob(job.jobId, 'narrow fix');
  assert.equal(reply.job.kind, 'reply');
  assert.equal(reply.job.replyToJobId, job.jobId);
  assert.equal(reply.job.sessionId, job.sessionId);
  const final = await waitForJob(reply.job.jobId, 60);
  assert.equal(final.status, 'succeeded');
  // The resume banner lives on the fake's stderr, i.e. the separate stderr log.
  const stderr = fs.readFileSync(stderrLogFilePath(reply.job.jobId), 'utf8');
  assert.match(stderr, /resume=true/, 'reply should spawn with --resume');
  const stdout = fs.readFileSync(logFilePath(reply.job.jobId), 'utf8');
  assert.ok(!stdout.includes('FAKE_CLAUDE'), 'stdout log must stay pure stream-json');
});

test('reply-mode buildCommand: legacy undefined and resume_session use --resume; fresh_turn uses --session-id', () => {
  const base: Partial<Job> = {
    jobId: 'cmd-1',
    sessionId: 'ses-cmd-1',
    kind: 'reply',
    workFolder: rt,
    permissionMode: 'bypassPermissions',
  };
  const spawnArgs = (job: Job) => buildCommand(job).args;
  // Legacy reply (no replyMode persisted, flag off): --resume keeps the old
  // resume behavior byte-for-byte.
  const legacy = spawnArgs(base as Job);
  assert.ok(legacy.includes('--resume'), 'legacy undefined replyMode must keep --resume');
  assert.equal(legacy[legacy.indexOf('--resume') + 1], 'ses-cmd-1');
  assert.ok(!legacy.includes('--session-id'), 'legacy undefined replyMode must not fall back to --session-id');
  // Wave3B resume_session: explicit resume of the parent session.
  const resumed = spawnArgs({ ...base, replyMode: 'resume_session' } as Job);
  assert.ok(resumed.includes('--resume'), 'resume_session must use --resume');
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'ses-cmd-1');
  assert.ok(!resumed.includes('--session-id'), 'resume_session must not use --session-id');
  // Wave3B fresh_turn: a NEW bounded turn, never a parent-session continuation.
  const fresh = spawnArgs({ ...base, replyMode: 'fresh_turn', sessionId: 'ses-cmd-2' } as Job);
  assert.ok(fresh.includes('--session-id'), 'fresh_turn must use --session-id');
  assert.equal(fresh[fresh.indexOf('--session-id') + 1], 'ses-cmd-2');
  assert.ok(!fresh.includes('--resume'), 'fresh_turn must never --resume');
  // Non-reply jobs are untouched by the reply contract.
  const started = spawnArgs({ ...base, kind: 'start', replyMode: undefined } as Job);
  assert.ok(started.includes('--session-id'), 'non-reply job keeps --session-id');
  assert.ok(!started.includes('--resume'), 'non-reply job must not --resume');
});

test('cancel kills only the target job', async () => {
  const a = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '8' }) })).job;
  const b = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '8' }) })).job;
  await sleep(1200); // let supervisors spawn
  const cancelled = cancelJob(a.jobId, 'test cancel');
  assert.equal(cancelled.status, 'cancelled');
  const bFinal = await waitForJob(b.jobId, 30);
  assert.equal(bFinal.status, 'succeeded', 'untargeted job must be unaffected');
  const aStatus = getStatus(a.jobId);
  assert.equal(aStatus.status, 'cancelled');
});

test('wait returns promptly when already terminal', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const t0 = Date.now();
  const final = await waitForJob(job.jobId, 60);
  assert.ok(Date.now() - t0 < 15000, 'wait on a short job should return quickly');
  assert.equal(final.status, 'succeeded');
});

test('recovery: applies done markers, keeps alive jobs running, marks dead ones interrupted', async () => {
  const mk = (status: Job['status'], extra: Partial<Job> = {}): Job => ({
    jobId: `rec-${Math.random().toString(36).slice(2, 10)}`,
    sessionId: `ses-${Math.random().toString(36).slice(2, 10)}`,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'bypassPermissions',
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
    reportPath: '',
    prompt: 'x',
    lastOutputAt: null,
    ...extra,
  });

  // 1. Running with a .done marker -> status applied from marker.
  const doneJob = mk('running', { pid: 999999 });
  atomicWriteJson(jobFilePath(doneJob.jobId), doneJob);
  atomicWriteJson(doneFilePath(doneJob.jobId), { jobId: doneJob.jobId, status: 'succeeded', exitCode: 0 });

  // 2. Running with a live pid (our own process) and no marker -> kept running.
  //    The recorded identity matches process.pid so recovery verifies it live.
  const aliveJob = mk('running', {
    pid: process.pid,
    supervisorPid: process.pid,
    pidStartedAt: SELF_IDENTITY_ISO,
    supervisorPidStartedAt: SELF_IDENTITY_ISO,
  });

  // 3. Running with a dead pid and no marker -> failed (interrupted).
  const deadJob = mk('running', { pid: 999998, supervisorPid: null });

  atomicWriteJson(jobFilePath(aliveJob.jobId), aliveJob);
  atomicWriteJson(jobFilePath(deadJob.jobId), deadJob);

  const { recovered } = recoverJobs();
  assert.ok(recovered.some((r) => r === `${doneJob.jobId}:succeeded`));
  assert.ok(recovered.some((r) => r === `${aliveJob.jobId}:running`));
  assert.ok(recovered.some((r) => r === `${deadJob.jobId}:failed_interrupted`));

  const done = JSON.parse(fs.readFileSync(jobFilePath(doneJob.jobId), 'utf8'));
  assert.equal(done.status, 'succeeded');
  const alive = JSON.parse(fs.readFileSync(jobFilePath(aliveJob.jobId), 'utf8'));
  assert.equal(alive.status, 'running');
});

test('listJobsView returns compact metadata and no prompts', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 60);
  const list = listJobsView(10);
  assert.ok(list.some((j) => j.jobId === job.jobId));
  assert.ok(!JSON.stringify(list).includes('fake task'));
});

test('a start that fails validation throws, never spawns', () => {
  assert.throws(() => startJob(fakeParams({ workFolder: 'relative' })), /absolute/);
});

test('recovery preserves a published needs_attention block (same requestId) and reply is accepted', async () => {
  const work = path.join(rt, 'recover-attn-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_RUN_SECONDS: '30',
      }),
    }),
  );
  let id = '';
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const st = getStatus(job.jobId);
    if (st.status === 'needs_attention') {
      id = st.attentionDetail?.requestId ?? '';
      break;
    }
    await sleep(200);
  }
  assert.ok(id.startsWith('local-'), `expected a local id, got ${id}`);
  assert.equal(getStatus(job.jobId).status, 'needs_attention');

  // Simulate an MCP restart while the supervisor is still alive.
  const { recovered } = recoverJobs();
  assert.ok(recovered.some((r) => r === `${job.jobId}:needs_attention`));
  const after = getStatus(job.jobId);
  assert.equal(after.status, 'needs_attention', 'recovery must NOT downgrade a block to running');
  assert.equal(after.attentionDetail?.requestId, id, 'the same requestId survives recovery');
  assert.equal(after.attentionDetail?.tool, 'Edit');

  // reply must be accepted (not rejected as "still running").
  const reply = replyJob(job.jobId, 'narrow fix');
  assert.equal(reply.job.kind, 'reply');
  assert.equal(reply.job.replyToJobId, job.jobId);
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('recovery never downgrades a terminal state', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const final = await waitForJob(job.jobId, 30);
  assert.equal(final.status, 'succeeded');
  recoverJobs();
  const after = getStatus(job.jobId);
  assert.equal(after.status, 'succeeded', 'recovery must not downgrade a terminal state');
});

test('a confirmed block that self-recovers then fails is reported as failed, not masked', async () => {
  const work = path.join(rt, 'mask-selfrecover-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_SELF_RECOVER: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_EXIT_CODE: '1',
        FAKE_CLAUDE_RUN_SECONDS: '3',
      }),
    }),
  );
  const fin = await waitForFinalized(job.jobId);
  assert.equal(fin.status, 'failed', 'a self-recovered failure must not be masked to needs_attention');
  assert.equal(fin.substatus, 'exit_1', 'the worker exit cause is preserved');
  // The block self-recovers before any watch can reliably snapshot it, so the
  // authoritative assertion is the FINAL state: failed with no surviving
  // blocking attention. The transient attentionLog snapshot is scheduling-
  // dependent and is not a stable contract here.
  const st = getStatus(job.jobId);
  assert.equal(st.status, 'failed', 'final stored state stays failed');
  assert.equal(st.exitCode, 1, 'the worker exit code is preserved');
  assert.equal(st.attentionDetail, undefined, 'no surviving blocking attentionDetail');
});

test('a confirmed block that self-recovers then succeeds is reported as succeeded', async () => {
  const work = path.join(rt, 'mask-selfrecover-ok-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_SELF_RECOVER: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_EXIT_CODE: '0',
        FAKE_CLAUDE_RUN_SECONDS: '3',
      }),
    }),
  );
  const fin = await waitForFinalized(job.jobId);
  assert.equal(fin.status, 'succeeded', 'a self-recovered block that succeeds is reported as succeeded');
  // The block self-recovers before any watch can reliably snapshot it, so the
  // authoritative assertion is the FINAL state: succeeded with no surviving
  // blocking attention. The transient attentionLog snapshot is scheduling-
  // dependent and is not a stable contract here.
  const st = getStatus(job.jobId);
  assert.equal(st.status, 'succeeded', 'final stored state stays succeeded');
  assert.equal(st.attentionDetail, undefined, 'no surviving blocking attentionDetail');
});

test('a still-blocked worker that fails (exit 1) is reported as needs_attention', async (t) => {
  const previousAttentionConfirm = process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS;
  process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '0';
  t.after(() => {
    if (previousAttentionConfirm === undefined) delete process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS;
    else process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = previousAttentionConfirm;
  });
  const work = path.join(rt, 'mask-stillblocked-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_EXIT_CODE: '1',
        FAKE_CLAUDE_RUN_SECONDS: '3',
      }),
    }),
  );
  t.after(() => {
    try {
      cancelJob(job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  });
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  const fin = await waitForFinalized(job.jobId);
  assert.equal(fin.status, 'needs_attention', 'a still-blocked failure keeps the block');
  assert.equal(fin.substatus, 'permission_request');
});

test('recoverJobs never reverts a terminal state that changed between read and write', async () => {
  const job = makeRecoveryJob('running', {
    pid: process.pid,
    supervisorPid: process.pid,
    pidStartedAt: SELF_IDENTITY_ISO,
    supervisorPidStartedAt: SELF_IDENTITY_ISO,
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  let flipped = false;
  recoverJobsTestHooks.beforeUpdate = (jobId) => {
    if (jobId === job.jobId && !flipped) {
      flipped = true;
      updateJob(jobId, { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 });
    }
  };
  try {
    const { recovered } = recoverJobs();
    const after = readJob(job.jobId);
    assert.equal(after?.status, 'succeeded', 'recovery must not revert a job that finalized mid-recovery');
    assert.ok(!recovered.some((r) => r === `${job.jobId}:running`), 'no spurious running recovery');
  } finally {
    recoverJobsTestHooks.beforeUpdate = undefined;
  }
});

test('reply to a needs_attention job records an exact, non-authorizing response audit (upstream id)', async () => {
  const work = path.join(rt, 'stage2a-work');
  fs.mkdirSync(work, { recursive: true });
  const permPath = path.join(work, 'probe.txt');
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: permPath,
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  await waitForJob(job.jobId, 30); // needs_attention
  assert.equal(getStatus(job.jobId).status, 'needs_attention');

  const replyPrompt = 'approve the specific fix';
  const reply = replyJob(job.jobId, replyPrompt);
  const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
  assert.ok(audit, 'reply job carries a response audit');
  assert.equal(audit!.kind, 'leader_reply_submitted');
  assert.ok(audit!.recordedAt.length > 0);
  assert.ok(audit!.attention);
  assert.equal(audit!.attention!.requestId, 'fake-prompt-1');
  assert.equal(audit!.attention!.requestIdSource, 'upstream');
  assert.equal(audit!.attention!.tool, 'Bash');
  assert.equal(audit!.attention!.action, 'delete');
  assert.equal(audit!.attention!.path, 'probe.txt');
  assert.equal(audit!.attention!.risk, 'high');
  assert.equal(audit!.effect, 'resume_requested');
  assert.equal(audit!.authorization, false);
  // The audit attention is exactly the seven safe fields: it never carries the
  // render-time message hint (or any prompt/raw/token).
  assert.deepEqual(
    Object.keys(audit!.attention!).sort(),
    ['action', 'at', 'path', 'requestId', 'requestIdSource', 'risk', 'tool'],
    'audit attention is exactly the seven safe fields',
  );
  assert.ok(!('message' in audit!.attention!), 'audit attention snapshot must not carry a message');

  const raw = JSON.stringify(audit);
  assert.ok(!raw.includes(replyPrompt), 'audit must not contain the reply prompt');
  assert.ok(!raw.includes('fake task'), 'audit must not contain the original user prompt');
  assert.ok(!raw.includes('PROXY_MANAGED'), 'audit must not contain a token');
  assert.ok(!raw.includes('rm '), 'audit must not contain the full command');
  assert.ok(!raw.includes('需要审批'), 'audit must not contain the attention message');

  // status/list expose the same refined audit for断线恢复.
  const st = getStatus(reply.job.jobId);
  assert.ok(st.attentionResponseAudit, 'status exposes the response audit');
  assert.equal(st.attentionResponseAudit?.authorization, false);
  assert.equal(st.attentionResponseAudit?.attention?.requestId, 'fake-prompt-1');
  const list = listJobsView(50);
  const listed = list.find((j) => j.jobId === reply.job.jobId);
  assert.ok(listed?.attentionResponseAudit, 'list exposes the response audit');

  // The old job is never modified with an audit field.
  assert.ok(!('attentionResponseAudit' in readJob(job.jobId)!), 'old job is never modified');

  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('reply audit records a local attention as clearly non-authorizing', async () => {
  const work = path.join(rt, 'stage2a-local-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  await waitForJob(job.jobId, 30);
  assert.equal(getStatus(job.jobId).status, 'needs_attention');
  const reply = replyJob(job.jobId, 'proceed');
  const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
  assert.ok(audit && audit.attention, 'local attention recorded');
  assert.equal(audit!.attention!.requestIdSource, 'local');
  assert.ok(audit!.attention!.requestId.startsWith('local-'));
  assert.equal(audit!.authorization, false);
  assert.equal(audit!.effect, 'resume_requested');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('a reply to a terminal (non-needs_attention) job has no response audit', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() })); // succeeds
  await waitForJob(job.jobId, 30);
  assert.equal(getStatus(job.jobId).status, 'succeeded');
  const reply = replyJob(job.jobId, 'polish the fix');
  const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
  assert.equal(audit, undefined, 'ordinary repair reply must not carry an audit');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('reply to a needs_attention job with unobservable attention records a null snapshot', async () => {
  const job = makeRecoveryJob('needs_attention', {
    workFolder: rt,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv(),
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const reply = replyJob(job.jobId, 'resume');
  const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
  assert.ok(audit, 'audit recorded even without observable attention');
  assert.equal(audit!.attention, null, 'unobservable attention is recorded as null');
  assert.equal(audit!.kind, 'leader_reply_submitted');
  assert.equal(audit!.authorization, false);
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('two replies to the same needs_attention job each record their own audit (no dedup)', async () => {
  const work = path.join(rt, 'stage2a-two-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Read',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'c.json'),
        FAKE_CLAUDE_RUN_SECONDS: '12',
      }),
    }),
  );
  await waitForJob(job.jobId, 30);
  assert.equal(getStatus(job.jobId).status, 'needs_attention');
  const r1 = replyJob(job.jobId, 'first');
  const r2 = replyJob(job.jobId, 'second');
  const a1 = readJob(r1.job.jobId)?.attentionResponseAudit;
  const a2 = readJob(r2.job.jobId)?.attentionResponseAudit;
  assert.ok(a1 && a2, 'each reply records its own audit');
  assert.equal(a1!.kind, 'leader_reply_submitted');
  assert.equal(a2!.kind, 'leader_reply_submitted');
  assert.notEqual(a1!.recordedAt, a2!.recordedAt, 'distinct recorded facts, no silent dedup');
  assert.equal(a1!.attention?.requestId, a2!.attention?.requestId, 'same observed attention snapshot');
  assert.equal(a1!.authorization, false);
  assert.equal(a2!.authorization, false);
  try {
    cancelJob(r1.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(r2.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('a reply that fails to create produces no fake audit and leaves the old job untouched', async () => {
  const work = path.join(rt, 'stage2a-fail-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'p.txt'),
        FAKE_CLAUDE_RUN_SECONDS: '8',
      }),
    }),
  );
  await waitForJob(job.jobId, 30);
  assert.equal(getStatus(job.jobId).status, 'needs_attention');
  const before = readJob(job.jobId)!;

  const prev = { ...atomicWriteTestHooks };
  atomicWriteTestHooks.beforeRename = () => {
    throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
  };
  atomicWriteTestHooks.sleep = () => {};
  let threw = false;
  try {
    replyJob(job.jobId, 'narrow fix');
  } catch {
    threw = true;
  } finally {
    atomicWriteTestHooks.beforeRename = prev.beforeRename;
    atomicWriteTestHooks.beforeUnlink = prev.beforeUnlink;
    atomicWriteTestHooks.sleep = prev.sleep;
  }
  assert.equal(threw, true, 'reply must throw when its write fails');
  const after = readJob(job.jobId)!;
  assert.equal(after.status, before.status, 'old job status unchanged');
  assert.ok(!('attentionResponseAudit' in after), 'old job never gains an audit');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// Stage 6: bootstrap-checkpoint recovery. These tests drive recoverJobs() with
// hand-written jobs (reusing the existing temp runtime + fake claude) and
// observe ONLY external behavior: the RecoveryReport (recovered/diagnostics/
// spawned) and the persisted job state (status/substatus/bootstrap id).
// No implementation string search; the only spawn observable is report.spawned
// plus the job's stamped bootstrapId, so a resume test really does launch a
// bounded fake-claude supervisor that is cancelled at the end.
// ---------------------------------------------------------------------------

test('stage6: job_persisted inside the bootstrap grace window stays pending and never spawns', () => {
  const prevGrace = process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS;
  process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS = '60000';
  const bp = newBootstrap('job_persisted', new Date().toISOString());
  const job = makeRecoveryJob('queued', { bootstrap: bp });
  atomicWriteJson(jobFilePath(job.jobId), job);
  try {
    const { recovered, diagnostics, spawned } = recoverJobs();
    assert.equal(spawned, 0, 'a fresh queued bootstrap must not spawn inside grace');
    assert.ok(!recovered.some((r) => r.startsWith(job.jobId)), 'no recovery outcome inside grace');
    assert.ok(diagnostics.includes(`${job.jobId}:bootstrap_pending`), 'pending state is diagnosable');
    const after = readJob(job.jobId)!;
    assert.equal(after.status, 'queued');
    assert.equal(after.substatus, 'bootstrap_pending');
    assert.equal(after.bootstrap?.bootstrapId, bp.bootstrapId, 'checkpoint untouched inside grace');
  } finally {
    if (prevGrace === undefined) delete process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS;
    else process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS = prevGrace;
    cancelJob(job.jobId);
  }
});

test('stage6: an over-grace or dead-supervisor job_persisted bootstrap resumes once and never twice', () => {
  const prevGrace = process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS;
  process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS = '60000';
  const runnable = {
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '5' }),
  };
  // Over grace: the queued job is older than the bootstrap grace window.
  const overGrace = makeRecoveryJob('queued', {
    ...runnable,
    startedAt: new Date(Date.now() - 70_000).toISOString(),
    bootstrap: newBootstrap('job_persisted', new Date(Date.now() - 70_000).toISOString()),
  });
  // Dead supervisor pid: provably never acked -> resume regardless of age. The
  // recorded historical identity satisfies recorded-identity presence; the OS
  // "no such process" is what verifies the dead supervisor.
  const deadSup = makeRecoveryJob('queued', {
    ...runnable,
    supervisorPid: 999999,
    supervisorPidStartedAt: new Date(Date.now() - 3600_000).toISOString(),
    bootstrap: newBootstrap('job_persisted', new Date().toISOString()),
  });
  atomicWriteJson(jobFilePath(overGrace.jobId), overGrace);
  atomicWriteJson(jobFilePath(deadSup.jobId), deadSup);
  const origOverId = overGrace.bootstrap!.bootstrapId;
  const origDeadId = deadSup.bootstrap!.bootstrapId;
  try {
    const first = recoverJobs();
    assert.equal(first.spawned, 2, 'each recoverable job resumes exactly once');
    assert.ok(first.recovered.includes(`${overGrace.jobId}:resumed`));
    assert.ok(first.recovered.includes(`${deadSup.jobId}:resumed`));
    const overAfter = readJob(overGrace.jobId)!;
    const deadAfter = readJob(deadSup.jobId)!;
    // The production supervisor may legally advance the persisted bootstrap to
    // supervisor_acknowledged (and then worker_spawned) before this synchronous
    // reread, so the resume's stamped stage is job_persisted, supervisor_acknowledged,
    // OR worker_spawned.
    assert.ok(
      overAfter.bootstrap?.stage === 'job_persisted' ||
        overAfter.bootstrap?.stage === 'supervisor_acknowledged' ||
        overAfter.bootstrap?.stage === 'worker_spawned',
      `resume stamps a fresh bootstrap checkpoint, got ${overAfter.bootstrap?.stage}`,
    );
    assert.notEqual(overAfter.bootstrap?.bootstrapId, origOverId, 'fresh bootstrapId stamped per resume');
    assert.notEqual(deadAfter.bootstrap?.bootstrapId, origDeadId, 'fresh bootstrapId stamped per resume');
    assert.ok(overAfter.supervisorPid, 'resume records a new supervisor pid');

    const second = recoverJobs();
    assert.equal(second.spawned, 0, 'a live resumed supervisor is attached, never re-spawned');
    assert.ok(!second.recovered.some((r) => r.endsWith(':resumed')), 'no second resume');
  } finally {
    if (prevGrace === undefined) delete process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS;
    else process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS = prevGrace;
    cancelJob(overGrace.jobId);
    cancelJob(deadSup.jobId);
  }
});

test('stage6: a live supervisor or worker is attached as running, never spawned', () => {
  const liveSup = makeRecoveryJob('queued', {
    supervisorPid: process.pid,
    supervisorPidStartedAt: SELF_IDENTITY_ISO,
    bootstrap: newBootstrap('job_persisted', new Date().toISOString()),
  });
  const liveWorker = makeRecoveryJob('running', {
    pid: process.pid,
    pidStartedAt: SELF_IDENTITY_ISO,
    bootstrap: newBootstrap('worker_spawned', new Date().toISOString()),
  });
  atomicWriteJson(jobFilePath(liveSup.jobId), liveSup);
  atomicWriteJson(jobFilePath(liveWorker.jobId), liveWorker);
  const { recovered, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'live supervisor/worker never spawns');
  assert.ok(recovered.includes(`${liveSup.jobId}:running`), 'live supervisor attaches as running');
  assert.ok(recovered.includes(`${liveWorker.jobId}:running`), 'live worker stays running');
  assert.equal(readJob(liveSup.jobId)?.status, 'running');
  assert.equal(readJob(liveWorker.jobId)?.status, 'running');
});

test('stage6: terminal and cancelled jobs never fall back to recovery decisions', () => {
  const succeeded = makeRecoveryJob('succeeded', {
    endedAt: new Date().toISOString(),
    bootstrap: newBootstrap('worker_spawned', new Date().toISOString()),
  });
  const cancelled = makeRecoveryJob('cancelled', {
    endedAt: new Date().toISOString(),
    substatus: 'test-cancel',
    bootstrap: newBootstrap('job_persisted', new Date().toISOString()),
  });
  const failed = makeRecoveryJob('failed', {
    endedAt: new Date().toISOString(),
    substatus: 'exit_1',
    bootstrap: newBootstrap('supervisor_acknowledged', new Date().toISOString()),
  });
  for (const j of [succeeded, cancelled, failed]) atomicWriteJson(jobFilePath(j.jobId), j);
  const { recovered, diagnostics, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'terminal jobs never spawn');
  for (const j of [succeeded, cancelled, failed]) {
    assert.ok(!recovered.some((r) => r.startsWith(j.jobId)), `${j.jobId} gets no recovery outcome`);
    assert.ok(!diagnostics.some((d) => d.startsWith(j.jobId)), `${j.jobId} gets no diagnostic`);
  }
  assert.equal(readJob(succeeded.jobId)?.status, 'succeeded');
  assert.equal(readJob(cancelled.jobId)?.status, 'cancelled');
  assert.equal(readJob(failed.jobId)?.status, 'failed');
});

test('stage6: recovery keeps a needs_attention block with the same requestId and never spawns', () => {
  const reqId = 'upstream-req-1';
  const at = new Date().toISOString();
  const job = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    supervisorPid: process.pid,
    supervisorPidStartedAt: SELF_IDENTITY_ISO,
    attentionLog: [
      { requestId: reqId, requestIdSource: 'upstream', tool: 'Edit', action: 'edit', path: 'x.ts', risk: 'high', at, message: 'needs approval' },
    ],
    bootstrap: newBootstrap('job_persisted', at),
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const { recovered, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'a blocked job must never spawn a replacement');
  assert.ok(recovered.includes(`${job.jobId}:needs_attention`));
  const after = readJob(job.jobId)!;
  assert.equal(after.status, 'needs_attention');
  assert.equal(after.substatus, 'permission_request');
  const log = after.attentionLog!;
  assert.ok(log.length > 0, 'attentionLog is preserved');
  assert.equal(log[log.length - 1].requestId, reqId, 'the same requestId survives recovery');
  assert.equal(getStatus(job.jobId).attentionDetail?.requestId, reqId, 'attentionDetail is preserved');
});

test('stage6: a legacy job with no bootstrap is conservatively failed, never spawned', () => {
  const job = makeRecoveryJob('queued');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const { recovered, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'legacy jobs never auto-resume');
  assert.ok(recovered.includes(`${job.jobId}:failed_interrupted`));
  const after = readJob(job.jobId)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.substatus, 'interrupted (MCP restart)');
});

test('stage6: a supervisor_acknowledged orphan fails as unacknowledged_worker, never spawns', () => {
  const job = makeRecoveryJob('running', {
    bootstrap: newBootstrap('supervisor_acknowledged', new Date().toISOString()),
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const { recovered, diagnostics, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'a possible worker must never be auto-resumed');
  assert.ok(recovered.includes(`${job.jobId}:failed_unacknowledged_worker`));
  assert.ok(diagnostics.includes(`${job.jobId}:ambiguous_worker`));
  const after = readJob(job.jobId)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.substatus, 'unacknowledged_worker');
});

test('stage6: a worker_spawned orphan fails as interrupted with orphan_worker_lost, never spawns', () => {
  const job = makeRecoveryJob('running', {
    pid: 999997,
    supervisorPid: 999996,
    bootstrap: newBootstrap('worker_spawned', new Date().toISOString()),
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const { recovered, diagnostics, spawned } = recoverJobs();
  assert.equal(spawned, 0, 'a worker may have run side effects; never auto-resume');
  assert.ok(recovered.includes(`${job.jobId}:failed_interrupted`));
  assert.ok(diagnostics.includes(`${job.jobId}:orphan_worker_lost`));
  const after = readJob(job.jobId)!;
  assert.equal(after.status, 'failed');
  assert.equal(after.substatus, 'interrupted (MCP restart)');
});

test('stage6: replyJob writes an independent job_persisted checkpoint with session lineage and a non-authorizing audit', () => {
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    attentionLog: [
      { requestId: 'up-req-9', requestIdSource: 'upstream', tool: 'Bash', action: 'run', path: 'p.sh', risk: 'high', at: new Date().toISOString(), message: 'run p.sh' },
    ],
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '2' }),
    bootstrap: newBootstrap('job_persisted', new Date().toISOString()),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  const reply = replyJob(base.jobId, 'go');
  const r = readJob(reply.job.jobId)!;
  // Independent checkpoint, not inherited. The real asynchronous supervisor may
  // acknowledge before the reread, so the stage is job_persisted or
  // supervisor_acknowledged; either proves the reply carries its own checkpoint.
  assert.equal(r.kind, 'reply');
  assert.ok(
    r.bootstrap?.stage === 'job_persisted' || r.bootstrap?.stage === 'supervisor_acknowledged',
    `reply checkpoint is job_persisted or supervisor_acknowledged, got ${r.bootstrap?.stage}`,
  );
  assert.ok(r.bootstrap?.bootstrapId, 'reply checkpoint has an id');
  assert.notEqual(r.bootstrap?.bootstrapId, base.bootstrap!.bootstrapId, 'reply checkpoint id is independent');
  // Same session lineage.
  assert.equal(r.sessionId, base.sessionId);
  assert.equal(r.replyToJobId, base.jobId);
  // Non-authorizing observability audit snapshot.
  assert.equal(r.attentionResponseAudit?.authorization, false);
  assert.equal(r.attentionResponseAudit?.effect, 'resume_requested');
  assert.equal(r.attentionResponseAudit?.attention?.requestId, 'up-req-9');
  assert.equal(r.attentionResponseAudit?.attention?.tool, 'Bash');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(base.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// T2b: structured-attention scheduler behavior. The fake claude modes
// (test/fake-claude.mjs) emit real banner / structured control / permission /
// transient / resume fixtures; these tests assert the supervisor's public
// behavior ONLY (status / attentionDetail / watch / attentionLog / audit) and
// that sanitization holds in every serialized evidence that leaves the process.
// ---------------------------------------------------------------------------

test('banner-only permission text (stdout or stderr) finishes succeeded with no attention', async () => {
  for (const mode of ['banner_stdout_success', 'banner_stderr_success'] as const) {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_MODE: mode }) }));
    const final = await waitForJob(job.jobId, 30);
    assert.equal(final.status, 'succeeded', `${mode} must succeed`);
    assert.equal(final.exitCode, 0);
    const view = getStatus(job.jobId);
    assert.equal(view.status, 'succeeded', `${mode} must never reach needs_attention`);
    assert.equal(view.attentionDetail, undefined, `${mode} must not publish attentionDetail`);
    const stored = readJob(job.jobId)!;
    assert.ok(!stored.attentionLog || stored.attentionLog.length === 0, `${mode} must not record a local unknown`);
    // The banner really was emitted on the intended stream.
    const bannerText = 'Claude needs your permission';
    if (mode === 'banner_stdout_success') {
      assert.ok(fs.readFileSync(logFilePath(job.jobId), 'utf8').includes(bannerText), 'stdout banner emitted');
    } else {
      assert.ok(fs.readFileSync(stderrLogFilePath(job.jobId), 'utf8').includes(bannerText), 'stderr banner emitted');
    }
  }
});

test('slow normal tool (>5s) finishes succeeded without a false wake', async () => {
  const { job } = startJob(
    fakeParams({ extraEnv: fakeEnv({ FAKE_MODE: 'slow_normal_success', FAKE_CLAUDE_SLOW_SECONDS: '6' }) }),
  );
  const deadline = Date.now() + 6000;
  let running = false;
  while (Date.now() < deadline) {
    if (getStatus(job.jobId).status === 'running') {
      running = true;
      break;
    }
    await sleep(100);
  }
  assert.ok(running, 'job entered running');
  // A genuinely long (>5s) ordinary tool: the confirm window is 300ms, so a job
  // still working well past it must never be promoted to needs_attention.
  await sleep(900);
  const mid = getStatus(job.jobId);
  assert.equal(mid.status, 'running', 'still working beyond the confirm window');
  assert.equal(mid.attentionDetail, undefined, 'no premature attention');
  const final = await waitForJob(job.jobId, 30);
  assert.equal(final.status, 'succeeded');
  const stored = readJob(job.jobId)!;
  assert.ok(!stored.attentionLog || stored.attentionLog.length === 0, 'no attention recorded');
});

test('structured_control_once publishes a sanitized upstream attention with no raw leaks', async () => {
  const work = path.join(rt, 'structured-control-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_MODE: 'structured_control_once',
        FAKE_REQUEST_ID: 'req-ctrl-1',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '30',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  assert.equal(v.wakeReason, 'needs_attention');
  const d = v.attentionDetail;
  assert.ok(d, 'attentionDetail present');
  assert.equal(d!.requestId, 'req-ctrl-1');
  assert.equal(d!.requestIdSource, 'upstream');
  assert.equal(d!.tool, 'Read');
  assert.equal(d!.action, 'read');
  assert.equal(d!.path, 'probe.txt');
  assert.equal(d!.risk, 'low');
  // The watch view carries only sanitized fields, never the raw event/payload.
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('fake task'), 'watch must not leak the prompt');
  assert.ok(!raw.includes('PROXY_MANAGED'), 'watch must not leak a token/key');
  assert.ok(!raw.includes('control_request'), 'watch must not leak the raw event type');
  assert.ok(!raw.includes('"permission"'), 'watch must not leak the raw payload wrapper');
  assert.ok(!raw.includes('rm '), 'watch must not leak the full command');
  assert.ok(!raw.includes('FAKE_MODE'), 'watch must not leak env keys');
  // Persisted job/attentionLog agree, deduped to the single published request.
  const st = getStatus(job.jobId);
  assert.equal(st.status, 'needs_attention');
  assert.equal(st.attentionDetail?.requestId, 'req-ctrl-1');
  const stored = readJob(job.jobId)!;
  const log = stored.attentionLog ?? [];
  assert.equal(log.length, 1, 'one published attention entry');
  assert.equal(log[0].requestId, 'req-ctrl-1');
  assert.equal(log[0].tool, 'Read');
  assert.equal(log[0].action, 'read');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('structured_permission_duplicate publishes one attention entry for one upstream id', async () => {
  const work = path.join(rt, 'structured-dup-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_MODE: 'structured_permission_duplicate',
        FAKE_REQUEST_ID: 'req-dup-1',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '30',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  assert.equal(v.attentionDetail?.requestId, 'req-dup-1');
  const stored = readJob(job.jobId)!;
  const log = stored.attentionLog ?? [];
  assert.equal(log.length, 1, 'the duplicated upstream id collapses to one entry');
  assert.equal(log[0].requestId, 'req-dup-1');
  assert.equal(log[0].requestIdSource, 'upstream');
  assert.equal(log[0].tool, 'Read');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('structured_two_ids keeps two distinct upstream request ids across episodes', async () => {
  const work = path.join(rt, 'structured-two-ids-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_MODE: 'structured_two_ids',
        FAKE_REQUEST_ID: 'req-a',
        FAKE_REQUEST_ID_2: 'req-b',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '5',
      }),
    }),
  );
  const deadline = Date.now() + 8000;
  let log: Array<{ requestId: string; requestIdSource: string }> = [];
  while (Date.now() < deadline) {
    log = (readJob(job.jobId)?.attentionLog ?? []).map((e) => ({
      requestId: e.requestId,
      requestIdSource: e.requestIdSource,
    }));
    if (log.length >= 2) break;
    await sleep(200);
  }
  assert.ok(log.length >= 2, `expected two distinct episodes, got ${log.length}`);
  const ids = log.map((e) => e.requestId);
  assert.ok(ids.includes('req-a'), 'first upstream id preserved');
  assert.ok(ids.includes('req-b'), 'second upstream id preserved');
  assert.equal(new Set(ids).size, 2, 'the two upstream ids stay distinct, never merged');
  assert.ok(log.every((e) => e.requestIdSource === 'upstream'), 'both ids stay upstream');
  assert.equal(log[0].requestId, 'req-a', 'first episode published first');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('structured_transient_success auto-resolves before the confirm window with no premature wake', async () => {
  const work = path.join(rt, 'structured-transient-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_MODE: 'structured_transient_success',
        FAKE_REQUEST_ID: 'req-transient',
        FAKE_CLAUDE_TRANSIENT_SECONDS: '0.1',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.wakeReason, 'terminal');
  assert.equal(v.attentionDetail, undefined, 'leader never woken for attention');
  assert.equal(getStatus(job.jobId).attentionDetail, undefined);
  const stored = readJob(job.jobId)!;
  assert.ok(!stored.attentionLog || stored.attentionLog.length === 0, 'no attention persisted');
});

test('resume_banner_success after an existing attention/reply path does not synthesize a local unknown', async () => {
  const reqId = 'upstream-resume-1';
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    attentionLog: [
      {
        requestId: reqId,
        requestIdSource: 'upstream',
        tool: 'Read',
        action: 'read',
        path: 'probe.txt',
        risk: 'low',
        at: new Date().toISOString(),
        message: 'needs approval',
      },
    ],
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_MODE: 'resume_banner_success', FAKE_CLAUDE_RUN_SECONDS: '2' }),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  const replyPrompt = 'resume the task';
  const reply = replyJob(base.jobId, replyPrompt);
  const final = await waitForJob(reply.job.jobId, 30);
  assert.equal(final.status, 'succeeded', 'resumed session succeeds');
  const r = readJob(reply.job.jobId)!;
  assert.ok(!r.attentionLog || r.attentionLog.length === 0, 'resume must not synthesize a local unknown attention');
  assert.equal(getStatus(reply.job.jobId).attentionDetail, undefined, 'no attentionDetail on the succeeded reply');
  const audit = r.attentionResponseAudit;
  assert.ok(audit, 'audit recorded on the reply');
  assert.ok(audit.attention, 'audit snapshots the existing attention');
  assert.equal(audit.attention!.requestId, reqId, 'audit keeps the existing upstream id, never a new local one');
  assert.equal(audit.attention!.requestIdSource, 'upstream');
  assert.equal(audit.attention!.tool, 'Read');
  assert.equal(audit.attention!.path, 'probe.txt');
  assert.equal(audit.authorization, false);
  const auditRaw = JSON.stringify(audit);
  assert.ok(!auditRaw.includes(replyPrompt), 'audit must not contain the reply prompt');
  assert.ok(!auditRaw.includes('fake task'), 'audit must not contain the original prompt');
  assert.ok(!auditRaw.includes('PROXY_MANAGED'), 'audit must not contain a token');
  assert.ok(!auditRaw.includes('rm '), 'audit must not contain the permission command');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(base.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('serialized job/status/watch/audit evidence lacks prompt/token/raw payload/command/env/key and never authorizes', async () => {
  const work = path.join(rt, 'serialized-evidence-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_MODE: 'structured_control_once',
        FAKE_REQUEST_ID: 'req-ev-1',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '30',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  const listed = listJobsView(50).find((j) => j.jobId === job.jobId);
  assert.ok(listed, 'job is listed');
  const st = getRenderedStatus(job.jobId, { lines: 3, stderrLines: 0 });
  assert.equal(st.status, 'needs_attention');
  const replyPrompt = 'approve the specific fix';
  const reply = replyJob(job.jobId, replyPrompt);
  const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
  assert.ok(audit, 'reply recorded a response audit');
  assert.equal(audit!.authorization, false, 'a reply never authorizes');

  const evidence = [JSON.stringify(job), JSON.stringify(listed), JSON.stringify(st), JSON.stringify(v), JSON.stringify(audit)];
  for (const raw of evidence) {
    assert.ok(!raw.includes('fake task'), 'no user prompt');
    assert.ok(!raw.includes('PROXY_MANAGED'), 'no auth token/key');
    assert.ok(!raw.includes('ANTHROPIC_'), 'no env/key prefix');
    assert.ok(!raw.includes('"permission"'), 'no raw structured payload wrapper');
    assert.ok(!raw.includes('control_request'), 'no raw event type');
    assert.ok(!raw.includes('rm '), 'no full permission command');
    assert.ok(!raw.includes('FAKE_MODE'), 'no env key');
    assert.ok(!raw.includes('FAKE_CLAUDE_RUN_SECONDS'), 'no env key');
    assert.ok(!raw.includes('FAKE_REQUEST_ID'), 'no env key');
    assert.ok(!raw.includes('CLAUDE_CLI_PREFIX'), 'no env key');
    assert.ok(!raw.includes(replyPrompt), 'no reply prompt');
    assert.ok(!raw.includes('"authorization":true'), 'authorization never true');
  }
  // The sanitized correlation id is still present and correct everywhere.
  assert.equal(v.attentionDetail?.requestId, 'req-ev-1');
  assert.equal(st.attentionDetail?.requestId, 'req-ev-1');
  assert.equal(audit!.attention?.requestId, 'req-ev-1');
  assert.equal(audit!.attention?.tool, 'Read');
  assert.equal(audit!.attention?.action, 'read');
  assert.equal(audit!.attention?.path, 'probe.txt');
  assert.equal(audit!.attention?.risk, 'low');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('maxRuntime × needs_attention: a timeout still kills the blocked worker first (kill-first preserved)', async () => {
  const child = spawnIdleChild();
  try {
    const work = path.join(rt, 'killfirst-work');
    fs.mkdirSync(work, { recursive: true });
    // The frozen record contract requires maxRuntimeMinutes to be an integer in
    // 30..180, so the elapsed-vs-max runtime is driven by a STARTED AT in the
    // past (35min ago) with a valid 30min cap — never by a fractional max. The
    // blocked (needs_attention) worker is a real identity-verified child.
    const base = makeRecoveryJob('needs_attention', {
      substatus: 'permission_request',
      workFolder: work,
      pid: child.pid,
      pidStartedAt: new Date(child.startedAtMs).toISOString(),
      supervisorPid: null,
      maxRuntimeMinutes: 30,
      startedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
      attentionLog: [
        {
          requestId: 'req-killfirst',
          requestIdSource: 'upstream',
          tool: 'Read',
          action: 'read',
          path: 'probe.txt',
          risk: 'low',
          at: new Date().toISOString(),
          message: 'needs approval',
        },
      ],
    });
    atomicWriteJson(jobFilePath(base.jobId), base);
    // maxRuntime wins over a published block: the blocked worker is killed
    // first, never left sitting in needs_attention forever.
    const { recovered } = recoverJobs();
    assert.ok(recovered.includes(`${base.jobId}:timeout`), 'timeout beats the preserved block');
    const after = readJob(base.jobId)!;
    assert.equal(after.status, 'failed', 'timeout kills the blocked job');
    assert.equal(after.substatus, 'timeout', 'kill-first substatus preserved');
    assert.equal(await waitForDead(child.pid), true, 'the identity-verified blocked worker is killed');
    // Observability of the published attention survives the kill.
    const log = after.attentionLog ?? [];
    assert.equal(log.length, 1, 'the published attention entry is still recorded');
    assert.equal(log[0].requestId, 'req-killfirst');
    assert.equal(log[0].requestIdSource, 'upstream');
  } finally {
    try {
      process.kill(child.pid, 9);
    } catch {
      /* already gone */
    }
  }
});

// ---------------------------------------------------------------------------
// Research/analysis deliverable contract: persistence, reply inheritance and
// terminal behavior through the real fake-claude supervisor harness.
// ---------------------------------------------------------------------------

function deliverableWork(name: string): string {
  const w = path.join(rt, name);
  fs.mkdirSync(w, { recursive: true });
  return w;
}

test('start persists taskType and deliverablePath for research; execution stays untyped', async () => {
  const work = deliverableWork('persist-deliverable-work');
  const dp = path.join(work, 'report.md');
  const { job } = startJob(
    fakeParams({ workFolder: work, taskType: 'research', deliverablePath: dp, extraEnv: fakeEnv() }),
  );
  try {
    assert.equal(job.taskType, 'research');
    assert.equal(job.deliverablePath, dp);
    const stored = readJob(job.jobId)!;
    assert.equal(stored.taskType, 'research');
    assert.equal(stored.deliverablePath, dp);
    // A freshly persisted start has no computed artifact evidence yet.
    assert.equal(stored.deliverableHash, undefined);
    assert.equal(stored.missingDeliverable, undefined);
  } finally {
    cancelJob(job.jobId);
  }
});

test('research/analysis reply inherits exact taskType/path and never inherits stale hash/missing', () => {
  for (const t of ['research', 'analysis'] as const) {
    const work = deliverableWork(`reply-inherit-${t}-work`);
    const dp = path.join(work, 'report.md');
    const base = makeRecoveryJob('needs_attention', {
      substatus: 'permission_request',
      workFolder: work,
      taskType: t,
      deliverablePath: dp,
      deliverableHash: 'stale-hash',
      missingDeliverable: true,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
    });
    atomicWriteJson(jobFilePath(base.jobId), base);
    const reply = replyJob(base.jobId, 'resume');
    // The reply inherits the EXACT taskType and deliverablePath ...
    assert.equal(reply.job.taskType, t);
    assert.equal(reply.job.deliverablePath, dp);
    // ... but never the stale artifact evidence; it is recomputed at terminal time.
    assert.equal(reply.job.deliverableHash, undefined, `${t}: no stale hash inherited`);
    assert.equal(reply.job.missingDeliverable, undefined, `${t}: no stale missing flag inherited`);
    const stored = readJob(reply.job.jobId)!;
    assert.equal(stored.taskType, t);
    assert.equal(stored.deliverablePath, dp);
    try {
      cancelJob(reply.job.jobId);
    } catch {
      /* best-effort cleanup */
    }
    try {
      cancelJob(base.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('execution reply remains unchanged: no taskType or deliverable contract injected', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() })); // omitted taskType = execution
  await waitForJob(job.jobId, 30);
  const reply = replyJob(job.jobId, 'polish the fix');
  assert.equal(reply.job.taskType, undefined);
  assert.equal(reply.job.deliverablePath, undefined);
  assert.equal(reply.job.deliverableHash, undefined);
  assert.equal(reply.job.missingDeliverable, undefined);
  const stored = readJob(reply.job.jobId)!;
  assert.ok(!stored.prompt.includes('【交付物契约】'), 'reply prompt must not inject the deliverable contract');
  assert.ok(!stored.prompt.includes('目标与范围'), 'reply prompt must not inject report headings');
  try {
    cancelJob(reply.job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('research/analysis success with a valid non-empty .md produces SHA-256 and missingDeliverable=false', async () => {
  for (const t of ['research', 'analysis'] as const) {
    const work = deliverableWork(`ok-deliverable-${t}-work`);
    const content = `# ${t} report\nDeterministic evidence for ${t}.`;
    const dp = path.join(work, 'report.md');
    fs.writeFileSync(dp, content, 'utf8');
    const { job } = startJob(
      fakeParams({ workFolder: work, taskType: t, deliverablePath: dp, extraEnv: fakeEnv() }),
    );
    const final = await waitForJob(job.jobId, 30);
    assert.equal(final.status, 'succeeded', t);
    assert.equal(final.missingDeliverable, false, t);
    assert.equal(final.deliverableHash, crypto.createHash('sha256').update(content).digest('hex'), t);
    assert.equal(final.deliverablePath, dp, t);
  }
});

test('absent/empty/non-file artifacts flip a successful worker to failed with sanitized substatus', async () => {
  const absentDp = path.join(deliverableWork('bad-absent-work'), 'report.md');
  const emptyDp = path.join(deliverableWork('bad-empty-work'), 'report.md');
  fs.writeFileSync(emptyDp, '', 'utf8');
  const notFileDp = path.join(deliverableWork('bad-notfile-work'), 'report.md');
  fs.mkdirSync(notFileDp, { recursive: true });

  const cases = [
    { label: 'absent', dp: absentDp, expect: 'deliverable_missing' },
    { label: 'empty', dp: emptyDp, expect: 'deliverable_empty' },
    { label: 'not_file', dp: notFileDp, expect: 'deliverable_not_file' },
  ];
  for (const c of cases) {
    const work = path.dirname(c.dp);
    const { job } = startJob(
      fakeParams({ workFolder: work, taskType: 'research', deliverablePath: c.dp, extraEnv: fakeEnv() }),
    );
    const final = await waitForJob(job.jobId, 30);
    assert.equal(final.status, 'failed', `${c.label}: successful worker flipped to failed`);
    assert.equal(final.substatus, c.expect, c.label);
    assert.equal(final.missingDeliverable, true, c.label);
    assert.equal(final.deliverableHash, undefined, `${c.label}: no hash for an invalid artifact`);
  }
});

// ---------------------------------------------------------------------------
// Single-artifact write exception (2026-08-23): review + research/analysis +
// deliverablePath must never deadlock against plan-mode read-only routing.
// ---------------------------------------------------------------------------

test('review + research/analysis derives the single-artifact write exception', () => {
  for (const t of ['research', 'analysis'] as const) {
    const work = deliverableWork(`review-exception-${t}-work`);
    const dp = path.join(work, '.agents', 'audit.md');
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    const { job, warnings } = startJob(
      fakeParams({ workFolder: work, profile: 'review', taskType: t, deliverablePath: dp, extraEnv: fakeEnv() }),
    );
    try {
      assert.equal(job.profile, 'review');
      assert.equal(job.permissionMode, 'default', `${t}: plan mode would deadlock the report write`);
      assert.equal(job.artifactWriteException, true, `${t}: exception flagged on the view`);
      assert.ok(
        warnings.some((w) => w.includes(dp) && w.includes('single-file write')),
        `${t}: start warning explains the derivation`,
      );
      const stored = readJob(job.jobId)!;
      assert.equal(stored.permissionMode, 'default', `${t}: persisted mode is default`);
      assert.equal(stored.artifactWriteException, true, `${t}: flag persisted`);
    } finally {
      try {
        cancelJob(job.jobId);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
});

test('review without a deliverable stays plan; auto with a deliverable stays auto', () => {
  const reviewWork = deliverableWork('review-plain-work');
  const { job: reviewJob } = startJob(
    fakeParams({ workFolder: reviewWork, profile: 'review', extraEnv: fakeEnv() }),
  );
  try {
    assert.equal(reviewJob.permissionMode, 'plan');
    assert.notEqual(reviewJob.artifactWriteException, true);
  } finally {
    try {
      cancelJob(reviewJob.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }

  const autoWork = deliverableWork('auto-deliverable-work');
  const autoDp = path.join(autoWork, 'report.md');
  const { job: autoJob } = startJob(
    fakeParams({ workFolder: autoWork, taskType: 'research', deliverablePath: autoDp, extraEnv: fakeEnv() }),
  );
  try {
    assert.equal(autoJob.permissionMode, 'bypassPermissions');
    assert.notEqual(autoJob.artifactWriteException, true);
  } finally {
    try {
      cancelJob(autoJob.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('reply inherits the artifact write exception and derived mode from its base job', () => {
  const work = deliverableWork('reply-exception-work');
  const dp = path.join(work, '.agents', 'audit.md');
  fs.mkdirSync(path.dirname(dp), { recursive: true });
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    profile: 'review',
    port: 15721,
    permissionMode: 'default',
    workFolder: work,
    taskType: 'analysis',
    deliverablePath: dp,
    artifactWriteException: true,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  const reply = replyJob(base.jobId, 'continue the audit');
  try {
    assert.equal(reply.job.profile, 'review');
    assert.equal(reply.job.permissionMode, 'default');
    assert.equal(reply.job.artifactWriteException, true);
    const stored = readJob(reply.job.jobId)!;
    assert.equal(stored.permissionMode, 'default');
    assert.equal(stored.artifactWriteException, true);
  } finally {
    try {
      cancelJob(reply.job.jobId);
    } catch {
      /* best-effort cleanup */
    }
    try {
      cancelJob(base.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }
});

test('ordinary execution success remains unchanged (no deliverable fields)', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const final = await waitForJob(job.jobId, 30);
  assert.equal(final.status, 'succeeded');
  assert.equal(final.substatus, null);
  assert.ok(!('taskType' in final), 'execution view has no taskType');
  assert.ok(!('deliverablePath' in final));
  assert.ok(!('deliverableHash' in final));
  assert.ok(!('missingDeliverable' in final));
});

test('worker failure is never converted into false success', async () => {
  // Valid artifact + worker failure: still failed; the hash is kept as evidence.
  const workOk = deliverableWork('fail-valid-work');
  const content = '# report';
  const dpOk = path.join(workOk, 'report.md');
  fs.writeFileSync(dpOk, content, 'utf8');
  const a = startJob(
    fakeParams({
      workFolder: workOk,
      taskType: 'research',
      deliverablePath: dpOk,
      extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '1' }),
    }),
  ).job;
  const fa = await waitForJob(a.jobId, 30);
  assert.equal(fa.status, 'failed');
  assert.equal(fa.substatus, 'exit_1');
  assert.equal(fa.missingDeliverable, false, 'valid artifact is not blamed for a worker failure');
  assert.equal(fa.deliverableHash, crypto.createHash('sha256').update(content).digest('hex'));

  // Missing artifact + worker failure: still failed with the worker's own cause.
  const workMiss = deliverableWork('fail-missing-work');
  const dpMiss = path.join(workMiss, 'report.md');
  const b = startJob(
    fakeParams({
      workFolder: workMiss,
      taskType: 'research',
      deliverablePath: dpMiss,
      extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '1' }),
    }),
  ).job;
  const fb = await waitForJob(b.jobId, 30);
  assert.equal(fb.status, 'failed');
  assert.equal(fb.substatus, 'exit_1', 'worker failure keeps its own substatus');
  assert.equal(fb.missingDeliverable, true);
});

test('research success: no report content, prompt, token, raw payload, or authorization=true leaks', async () => {
  const work = deliverableWork('leak-free-work');
  const secret = 'TOP-SECRET-REPORT-CONTENT-xyz';
  const dp = path.join(work, 'report.md');
  fs.writeFileSync(dp, secret, 'utf8');
  const { job } = startJob(
    fakeParams({ workFolder: work, taskType: 'research', deliverablePath: dp, extraEnv: fakeEnv() }),
  );
  const final = await waitForJob(job.jobId, 30);
  assert.equal(final.status, 'succeeded');
  const watch = await watchJob(job.jobId, { timeoutSeconds: 5 }); // already terminal
  const status = getStatus(job.jobId, 400);
  const rendered = getRenderedStatus(job.jobId, { lines: 3, stderrLines: 2 });
  const listed = listJobsView(50).find((j) => j.jobId === job.jobId);
  assert.ok(listed, 'job is listed');

  const evidence = [JSON.stringify(job), JSON.stringify(final), JSON.stringify(watch), JSON.stringify(status), JSON.stringify(rendered), JSON.stringify(listed)];
  for (const raw of evidence) {
    assert.ok(!raw.includes(secret), 'report content must not leak');
    assert.ok(!raw.includes('fake task'), 'prompt must not leak');
    assert.ok(!raw.includes('PROXY_MANAGED'), 'token must not leak');
    assert.ok(!raw.includes('"permission"'), 'raw structured payload must not leak');
    assert.ok(!raw.includes('control_request'), 'raw event type must not leak');
    assert.ok(!raw.includes('"authorization":true'), 'authorization never true');
  }
  // The stored job keeps the prompt for resumption, but no public view does.
  const stored = readJob(job.jobId)!;
  assert.ok(stored.prompt.includes('fake task'), 'prompt persisted for session resumption');
});

// ---------------------------------------------------------------------------
// Core-consistency: cancel/reply/recovery PID-identity contract (matrix 2, 11,
// 12, 13, 15, 16).
//
// These tests exercise the FROZEN contract through the public scheduler API:
// cancel/reply/recovery must never destructive-kill a pid whose recorded
// identity (pidStartedAt / supervisorPidStartedAt) is mismatched, unverifiable,
// or missing; the intended safe path (verified match) still kills. Real idle
// child processes stand in for workers so "never kill" is observable as
// process survival. Every spawned child is killed in a finally block (matrix
// 16); the recorded identity timestamps are written from the spawn moment,
// which is within the registry's 5s identity tolerance of the child's real
// OS-reported start.
// ---------------------------------------------------------------------------

function spawnIdleChild(): { pid: number; startedAtMs: number; kill: () => void } {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{}, 1<<30)'], { stdio: 'ignore', windowsHide: true });
  return {
    pid: child.pid as number,
    startedAtMs: Date.now(),
    kill: () => {
      try {
        child.kill();
      } catch {
        /* best effort */
      }
    },
  };
}

function childAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!childAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Matrix 2: cancel racing success never regresses a terminal status.
// ---------------------------------------------------------------------------

test('cancel racing success: a late cancel never regresses a terminal status', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const final = await waitForJob(job.jobId, 30);
  assert.equal(final.status, 'succeeded');
  const view = cancelJob(job.jobId, 'late cancel');
  assert.equal(view.status, 'succeeded', 'cancel must not regress success');
  assert.equal(readJob(job.jobId)?.status, 'succeeded', 'the persisted terminal is immutable');
  assert.equal(getStatus(job.jobId).status, 'succeeded');
});

test('cancel/success race: the guarded cancel write loses to an already-published terminal status', () => {
  // Deterministic simulation of the cancel read->write window: success lands
  // between cancel's read and its guarded write; the stale write fails closed.
  const job = makeRecoveryJob('running');
  atomicWriteJson(jobFilePath(job.jobId), job);
  const success = updateJobIf(
    job.jobId,
    (j) => !isTerminal(j.status) && j.status !== 'cancelled',
    { status: 'succeeded', endedAt: new Date().toISOString(), exitCode: 0 },
  );
  assert.ok(success, 'the success finalizer wins the race');
  const cancel = updateJobIf(
    job.jobId,
    (j) => !isTerminal(j.status) && j.status !== 'cancelled',
    { status: 'cancelled', endedAt: new Date().toISOString() },
  );
  assert.equal(cancel, null, 'the stale cancel write must fail closed');
  assert.equal(readJob(job.jobId)?.status, 'succeeded', 'the final terminal never regresses');
});

// ---------------------------------------------------------------------------
// Matrix 11: real fake-worker launches record supervisor + worker PID identities.
// ---------------------------------------------------------------------------

test('real fake-worker launches record supervisor and worker PID identities', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '3' }) }));
  let stored: Job | null = null;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const j = readJob(job.jobId);
    if (j && j.supervisorPid && j.supervisorPidStartedAt && j.pid && j.pidStartedAt) {
      stored = j;
      break;
    }
    await sleep(200);
  }
  assert.ok(stored, 'job must record supervisor + worker pid identities');
  assert.ok(stored!.supervisorPid !== process.pid, 'supervisor is a detached child');
  assert.ok(stored!.pid !== process.pid, 'worker is a detached child');
  const supMs = Date.parse(stored!.supervisorPidStartedAt!);
  const workerMs = Date.parse(stored!.pidStartedAt!);
  assert.ok(!Number.isNaN(supMs) && !Number.isNaN(workerMs), 'identity timestamps are valid ISO');
  // The poll above only persists a job once supervisorPid/pid are non-null and
  // the asserts above guarantee them, so these are safe non-null reads.
  const supPid = stored!.supervisorPid!;
  const workerPid = stored!.pid!;
  // The recorded identities are consistent with the OS-reported process starts.
  const supOs = queryProcessStartTime(supPid);
  if (supOs !== null) {
    assert.ok(Math.abs(supMs - supOs) < 30_000, `supervisor start identity: recorded ${supMs} vs OS ${supOs}`);
  }
  const workerOs = queryProcessStartTime(workerPid);
  if (workerOs !== null) {
    assert.ok(Math.abs(workerMs - workerOs) < 30_000, `worker start identity: recorded ${workerMs} vs OS ${workerOs}`);
  }
  // Public views never leak the stored prompt (matrix 15).
  const view = getStatus(job.jobId);
  assert.ok(!JSON.stringify(view).includes('fake task'), 'status view does not leak the prompt');
  await waitForJob(job.jobId, 30);
});

// ---------------------------------------------------------------------------
// Matrix 12: cancel/reply never destructive-kill on identity mismatch /
// unverifiable / missing; verified match permits the intended kill.
// ---------------------------------------------------------------------------

test('cancel never kills a worker whose recorded identity is mismatched/unverifiable/missing', async () => {
  const child = spawnIdleChild();
  try {
    const cases: Array<{ name: string; pidStartedAt?: string }> = [
      { name: 'mismatched', pidStartedAt: new Date(child.startedAtMs - 3600_000).toISOString() },
      { name: 'missing' },
    ];
    for (const c of cases) {
      const job = makeRecoveryJob('running', {
        pid: child.pid,
        supervisorPid: null,
        ...(c.pidStartedAt !== undefined ? { pidStartedAt: c.pidStartedAt } : {}),
      });
      atomicWriteJson(jobFilePath(job.jobId), job);
      const view = cancelJob(job.jobId, `cancel-${c.name}`);
      assert.equal(view.status, 'cancelled', `${c.name}: cancel still cancels the job`);
      await sleep(300); // a delayed (buggy) kill would have landed by now
      assert.equal(childAlive(child.pid), true, `${c.name}: the worker process must survive`);
      assert.equal(readJob(job.jobId)?.status, 'cancelled');
    }

    // A non-parseable PID-start identity is now a CORRUPT record (the frozen
    // validator requires a parseable timestamp): readJob rejects it, so cancel
    // fails closed with "job not found" and never reaches a kill decision.
    const unverifiable = makeRecoveryJob('running', {
      pid: child.pid,
      supervisorPid: null,
      pidStartedAt: 'not-a-valid-iso',
    });
    atomicWriteJson(jobFilePath(unverifiable.jobId), unverifiable);
    assert.equal(readJob(unverifiable.jobId), null, 'unverifiable: the corrupt identity record is rejected');
    assert.throws(() => cancelJob(unverifiable.jobId), /not found/, 'unverifiable: cancel fails closed');
    await sleep(300);
    assert.equal(childAlive(child.pid), true, 'unverifiable: the worker process must survive');
  } finally {
    child.kill();
  }
});

test('cancel kills the worker only when its recorded identity verifies against the live process', async () => {
  const child = spawnIdleChild();
  try {
    const job = makeRecoveryJob('running', {
      pid: child.pid,
      supervisorPid: null,
      pidStartedAt: new Date(child.startedAtMs).toISOString(),
    });
    atomicWriteJson(jobFilePath(job.jobId), job);
    cancelJob(job.jobId, 'verified cancel');
    assert.equal(await waitForDead(child.pid), true, 'an identity-verified worker is killed by cancel');
  } finally {
    try {
      process.kill(child.pid, 9);
    } catch {
      /* already gone */
    }
  }
});

test('reply to a needs_attention job never kills a mismatched/unverifiable worker', async () => {
  const child = spawnIdleChild();
  try {
    const cases: Array<{ name: string; pidStartedAt?: string }> = [
      { name: 'mismatched', pidStartedAt: new Date(child.startedAtMs - 3600_000).toISOString() },
      { name: 'missing' },
    ];
    for (const c of cases) {
      const base = makeRecoveryJob('needs_attention', {
        substatus: 'permission_request',
        pid: child.pid,
        supervisorPid: null,
        ...(c.pidStartedAt !== undefined ? { pidStartedAt: c.pidStartedAt } : {}),
        claudeCli: FAKE_CLAUDE,
        claudePrefix: [process.execPath],
        extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
      });
      atomicWriteJson(jobFilePath(base.jobId), base);
      const reply = replyJob(base.jobId, 'resume');
      await sleep(300); // a delayed (buggy) kill would have landed by now
      assert.equal(childAlive(child.pid), true, `${c.name}: reply must not kill the worker`);
      try {
        cancelJob(reply.job.jobId);
      } catch {
        /* best-effort cleanup */
      }
    }
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// Matrix 13: recovery attach / kill only on identity match.
// ---------------------------------------------------------------------------

test('recovery attaches a verified-live worker as running and never kills it', async () => {
  const child = spawnIdleChild();
  try {
    await waitForVerifiedPid(child.pid, child.startedAtMs);
    const job = makeRecoveryJob('running', {
      pid: child.pid,
      supervisorPid: null,
      pidStartedAt: new Date(child.startedAtMs).toISOString(),
    });
    atomicWriteJson(jobFilePath(job.jobId), job);
    const { recovered } = recoverJobs();
    assert.ok(recovered.includes(`${job.jobId}:running`), 'a verified worker is attached as running');
    await sleep(300);
    assert.equal(childAlive(child.pid), true, 'an attached worker is not killed');
    assert.equal(readJob(job.jobId)?.status, 'running');
  } finally {
    child.kill();
  }
});

test('recovery never attaches or kills a reused PID (identity mismatch)', async () => {
  const child = spawnIdleChild();
  try {
    const job = makeRecoveryJob('running', {
      pid: child.pid,
      supervisorPid: null,
      pidStartedAt: new Date(child.startedAtMs - 3600_000).toISOString(),
    });
    atomicWriteJson(jobFilePath(job.jobId), job);
    const { recovered } = recoverJobs();
    assert.ok(!recovered.includes(`${job.jobId}:running`), 'a reused PID is not attached as a live worker');
    assert.ok(recovered.includes(`${job.jobId}:failed_interrupted`), 'a legacy job with no live child fails conservatively');
    await sleep(300);
    assert.equal(childAlive(child.pid), true, 'a reused PID is never killed');
  } finally {
    child.kill();
  }
});

test('recovery does not attach or kill a worker with missing identity', async () => {
  const child = spawnIdleChild();
  try {
    const job = makeRecoveryJob('running', { pid: child.pid, supervisorPid: null });
    atomicWriteJson(jobFilePath(job.jobId), job);
    const { recovered } = recoverJobs();
    assert.ok(!recovered.includes(`${job.jobId}:running`), 'a missing identity is not attached as a live worker');
    await sleep(300);
    assert.equal(childAlive(child.pid), true, 'a missing identity is never killed');
  } finally {
    child.kill();
  }
});

test('recovery never attaches a reused self-pid and never kills the runner', () => {
  // process.pid exists but the recorded identity is a different "generation":
  // recovery must NOT treat it as a live worker (which would keep the job
  // running and could route a kill at our own test process).
  const job = makeRecoveryJob('running', {
    pid: process.pid,
    supervisorPid: null,
    pidStartedAt: new Date(Date.now() - 3600_000).toISOString(),
  });
  atomicWriteJson(jobFilePath(job.jobId), job);
  const { recovered } = recoverJobs();
  assert.ok(!recovered.includes(`${job.jobId}:running`), 'a reused self-pid is not attached as live');
  // The strongest no-broad-kill proof: this test process is still running.
  assert.equal(childAlive(process.pid), true, 'recovery must never kill the runner');
});

test('recovery maxRuntime kill fires only on an identity-verified match', async () => {
  const a = spawnIdleChild();
  const b = spawnIdleChild();
  try {
    // The frozen record contract requires maxRuntimeMinutes to be an integer in
    // 30..180, so over-runtime is driven by startedAt 35min in the past with a
    // valid 30min cap (35min elapsed > 30min max), not by a fractional max.
    const match = makeRecoveryJob('running', {
      pid: a.pid,
      supervisorPid: null,
      pidStartedAt: new Date(a.startedAtMs).toISOString(),
      maxRuntimeMinutes: 30,
      startedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    });
    const mismatch = makeRecoveryJob('running', {
      pid: b.pid,
      supervisorPid: null,
      pidStartedAt: new Date(b.startedAtMs - 3600_000).toISOString(),
      maxRuntimeMinutes: 30,
      startedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
    });
    atomicWriteJson(jobFilePath(match.jobId), match);
    atomicWriteJson(jobFilePath(mismatch.jobId), mismatch);
    recoverJobs();
    assert.equal(await waitForDead(a.pid), true, 'verified over-runtime worker is killed');
    await sleep(300);
    assert.equal(childAlive(b.pid), true, 'mismatched over-runtime pid is never killed');
  } finally {
    try {
      process.kill(a.pid, 9);
    } catch {
      /* already gone */
    }
    try {
      process.kill(b.pid, 9);
    } catch {
      /* already gone */
    }
  }
});

// ---------------------------------------------------------------------------
// Frozen validation contract: recovery routes .done markers through
// parseDoneMarker. A parseable-but-invalid marker (non-JobStatus status,
// non-terminal status, invalid exitCode, mismatched jobId) must never be
// written back to the Job; a valid marker still recovers.
// ---------------------------------------------------------------------------

test('recovery never writes back a parseable invalid .done status/exitCode/jobId; a valid marker still recovers', async () => {
  const mkLive = (): Job =>
    makeRecoveryJob('running', {
      pid: process.pid,
      supervisorPid: process.pid,
      pidStartedAt: SELF_IDENTITY_ISO,
      supervisorPidStartedAt: SELF_IDENTITY_ISO,
    });

  // 1) Non-JobStatus status + invalid exitCode + invalid endedAt.
  const badStatus = mkLive();
  atomicWriteJson(jobFilePath(badStatus.jobId), badStatus);
  atomicWriteJson(doneFilePath(badStatus.jobId), {
    jobId: badStatus.jobId,
    status: 'bogus',
    exitCode: -5,
    endedAt: 'not-a-date',
  });

  // 2) Parseable but non-terminal status: recovery must not regress to queued.
  const queuedStatus = mkLive();
  atomicWriteJson(jobFilePath(queuedStatus.jobId), queuedStatus);
  atomicWriteJson(doneFilePath(queuedStatus.jobId), {
    jobId: queuedStatus.jobId,
    status: 'queued',
    exitCode: 0,
  });

  // 3) Mismatched jobId: never applies even with an otherwise-valid marker.
  const badJobId = mkLive();
  atomicWriteJson(jobFilePath(badJobId.jobId), badJobId);
  atomicWriteJson(doneFilePath(badJobId.jobId), {
    jobId: 'some-other-job',
    status: 'succeeded',
    exitCode: 0,
  });

  // 4) Valid marker: still recovers.
  const good = mkLive();
  atomicWriteJson(jobFilePath(good.jobId), good);
  atomicWriteJson(doneFilePath(good.jobId), {
    jobId: good.jobId,
    status: 'succeeded',
    exitCode: 0,
    endedAt: new Date().toISOString(),
  });

  try {
    const { recovered } = recoverJobs();
    // The invalid markers are never applied (and never reported as recovered).
    assert.ok(!recovered.some((r) => r.startsWith(`${badStatus.jobId}:bogus`)), 'invalid status not reported');
    assert.ok(!recovered.some((r) => r.startsWith(`${queuedStatus.jobId}:queued`)), 'non-terminal status not applied');
    const afterBad = readJob(badStatus.jobId)!;
    assert.equal(afterBad.status, 'running', 'invalid done status is not written back');
    assert.notEqual(afterBad.exitCode, -5, 'invalid done exitCode is not written back');
    const afterQueued = readJob(queuedStatus.jobId)!;
    assert.equal(afterQueued.status, 'running', 'a queued marker cannot regress a running job');
    const afterBadId = readJob(badJobId.jobId)!;
    assert.equal(afterBadId.status, 'running', 'a mismatched-jobId marker is not applied');
    assert.notEqual(afterBadId.status, 'succeeded');
    // The valid marker still recovers the job.
    assert.ok(recovered.includes(`${good.jobId}:succeeded`), 'valid marker still recovers');
    assert.equal(readJob(good.jobId)?.status, 'succeeded');
    assert.equal(readJob(good.jobId)?.exitCode, 0);
  } finally {
    // Clean up the still-live fixture jobs (never cancel: their pid is our own
    // process, so a cancel would attempt a kill of the test runner).
    for (const j of [badStatus, queuedStatus, badJobId]) {
      try {
        updateJob(j.jobId, { status: 'failed', endedAt: new Date().toISOString() });
      } catch {
        /* best effort */
      }
    }
    try {
      cancelJob(good.jobId);
    } catch {
      /* best effort */
    }
  }
});

// ---------------------------------------------------------------------------
// T1E: Contract V2 feature flag + initial persistence (scheduler-only). The
// scheduler PREPARES contract data for the JobStore; the supervisor (out of
// scope here) reads it back by jobId. Nothing here runs acceptance or changes
// the V1 execution path: flag off (or a non-'1' value) leaves the V1 record
// untouched even when an explicit contract was supplied.
// ---------------------------------------------------------------------------

const LEGACY_CONTRACT_BASE = {
  scope: { readGlobs: [], writeFiles: [], forbiddenGlobs: [] },
  writePolicy: 'workspace_legacy',
  acceptance: [],
  admission: { resourceClass: 'light', priority: 0 },
} as const;

function explicitContract(over: Partial<TaskContractV2> = {}): TaskContractV2 {
  return {
    schemaVersion: 2,
    ...LEGACY_CONTRACT_BASE,
    budget: { maxRuntimeMinutes: 120, reportOnlyAfterMinutes: 120 },
    reporting: {},
    ...over,
  } as TaskContractV2;
}

function isContractShape(v: unknown): v is TaskContractV2 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === 2 &&
    typeof o.writePolicy === 'string' &&
    typeof o.scope === 'object' &&
    o.scope !== null &&
    typeof o.budget === 'object' &&
    o.budget !== null &&
    Array.isArray(o.acceptance) &&
    typeof o.reporting === 'object' &&
    o.reporting !== null &&
    typeof o.admission === 'object' &&
    o.admission !== null
  );
}

const CONTRACT_FLAG = 'ORCHESTRATOR_CONTRACT_V2';
const savedContractFlag = process.env[CONTRACT_FLAG];

// T1E env discipline: every test snapshots the flag first and restores it in a
// finally, so no scheduling/deferred supervisor of a later test ever observes a
// stale value.
function withContractFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[CONTRACT_FLAG];
  else process.env[CONTRACT_FLAG] = value;
}

test('T1E flag off + legacy: no contract, not_requested, empty gates', () => {
  withContractFlag(undefined);
  try {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
    try {
      const stored = readJob(job.jobId)!;
      assert.equal(stored.contract, undefined, 'no contract synthesized');
      assert.equal(stored.acceptanceStatus, 'not_requested', 'flag off never requests acceptance');
      assert.deepEqual(stored.gateResults, [], 'empty gate array persisted');
      assert.equal(stored.workerStatus, 'queued');
      const view = getStatus(job.jobId);
      assert.equal(view.acceptanceStatus, 'not_requested');
      assert.deepEqual(view.gateResults, []);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E flag off + explicit contract: persisted internally but never executed (not_requested)', () => {
  withContractFlag(undefined);
  const work = deliverableWork('t1e-off-explicit-work');
  const dp = path.join(work, 'report.md');
  const c = explicitContract({ reporting: { deliverablePath: dp } });
  try {
    const { job } = startJob(
      fakeParams({ workFolder: work, taskType: 'research', deliverablePath: dp, contract: c, extraEnv: fakeEnv() }),
    );
    try {
      const stored = readJob(job.jobId)!;
      assert.deepEqual(stored.contract, c, 'explicit contract persisted for later observation');
      assert.equal(stored.acceptanceStatus, 'not_requested', 'flag off never requests acceptance');
      assert.deepEqual(stored.gateResults, [], 'empty gate array persisted');
      assert.equal(stored.workerStatus, 'queued');
      const view = getStatus(job.jobId);
      assert.equal(view.acceptanceStatus, 'not_requested', 'flag off stays not_requested');
      assert.deepEqual(view.gateResults, []);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E flag on + legacy: full workspace_legacy contract synthesized, pending', () => {
  withContractFlag('1');
  const work = deliverableWork('t1e-on-legacy-work');
  try {
    const { job } = startJob(fakeParams({ workFolder: work, extraEnv: fakeEnv() }));
    try {
      const stored = readJob(job.jobId)!;
      assert.ok(stored.contract, 'contract synthesized');
      assert.equal(stored.contract?.schemaVersion, 2);
      assert.equal(stored.contract?.writePolicy, 'workspace_legacy');
      assert.deepEqual(stored.contract?.scope, { readGlobs: [], writeFiles: [], forbiddenGlobs: [] });
      assert.equal(stored.contract?.budget.maxRuntimeMinutes, 120);
      assert.equal(stored.contract?.budget.reportOnlyAfterMinutes, 120);
      assert.deepEqual(stored.contract?.acceptance, []);
      assert.deepEqual(stored.contract?.admission, { resourceClass: 'light', priority: 0 });
      assert.equal(stored.contract?.reporting.deliverablePath, undefined);
      assert.equal(stored.workerStatus, 'queued');
      assert.equal(stored.acceptanceStatus, 'pending');
      assert.deepEqual(stored.gateResults, []);
      const view = getStatus(job.jobId);
      assert.equal(view.acceptanceStatus, 'pending');
      assert.equal(view.workerStatus, 'queued');
      assert.equal(view.contractSchemaVersion, 2);
      assert.deepEqual(view.gateResults, []);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E flag on + explicit contract: same object persisted, pending', () => {
  withContractFlag('1');
  const work = deliverableWork('t1e-on-explicit-work');
  const dp = path.join(work, 'report.md');
  const c = explicitContract({ reporting: { deliverablePath: dp } });
  try {
    const { job } = startJob(
      fakeParams({ workFolder: work, taskType: 'research', deliverablePath: dp, contract: c, extraEnv: fakeEnv() }),
    );
    try {
      const stored = readJob(job.jobId)!;
      assert.deepEqual(stored.contract, c, 'the exact explicit contract is persisted');
      assert.equal(stored.workerStatus, 'queued');
      assert.equal(stored.acceptanceStatus, 'pending');
      assert.deepEqual(stored.gateResults, []);
      const view = getStatus(job.jobId);
      assert.equal(view.acceptanceStatus, 'pending');
      assert.equal(view.contractSchemaVersion, 2);
      assert.ok(isContractShape(stored.contract), 'persisted contract shape');
      assert.equal(stored.contract?.reporting.deliverablePath, dp);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E reply inherits the parent contract when the flag is on', () => {
  withContractFlag('1');
  const work = deliverableWork('t1e-reply-on-work');
  const dp = path.join(work, 'report.md');
  const c = explicitContract({ reporting: { deliverablePath: dp } });
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    workFolder: work,
    taskType: 'research',
    deliverablePath: dp,
    contract: c,
    workerStatus: 'needs_attention',
    acceptanceStatus: 'pending',
    gateResults: [],
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  try {
    const reply = replyJob(base.jobId, 'resume');
    try {
      assert.equal(reply.job.contractSchemaVersion, 2, 'reply view reports the inherited contract schema');
      const stored = readJob(reply.job.jobId)!;
      assert.deepEqual(stored.contract, c, 'reply inherits the exact parent contract');
      assert.equal(stored.workerStatus, 'queued');
      assert.equal(stored.acceptanceStatus, 'pending');
      assert.deepEqual(stored.gateResults, []);
      const view = getStatus(reply.job.jobId);
      assert.equal(view.acceptanceStatus, 'pending');
      assert.equal(view.contractSchemaVersion, 2);
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withContractFlag(savedContractFlag);
  }
});

test('T1E reply without a parent contract stays not_requested even with the flag on', () => {
  withContractFlag('1');
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    workFolder: rt,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  try {
    const reply = replyJob(base.jobId, 'resume');
    try {
      const stored = readJob(reply.job.jobId)!;
      assert.equal(stored.contract, undefined, 'no contract synthesized for a contract-less reply');
      assert.equal(stored.acceptanceStatus, 'not_requested');
      assert.deepEqual(stored.gateResults, []);
      assert.equal(stored.workerStatus, 'queued');
      const view = getStatus(reply.job.jobId);
      assert.equal(view.acceptanceStatus, 'not_requested');
      assert.deepEqual(view.gateResults, []);
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withContractFlag(savedContractFlag);
  }
});

test('T1E flag off + reply to a contracted parent: contract persisted but not_requested', () => {
  withContractFlag(undefined);
  const work = deliverableWork('t1e-reply-off-work');
  const dp = path.join(work, 'report.md');
  const c = explicitContract({ reporting: { deliverablePath: dp } });
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    workFolder: work,
    taskType: 'research',
    deliverablePath: dp,
    contract: c,
    workerStatus: 'needs_attention',
    acceptanceStatus: 'pending',
    gateResults: [],
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  try {
    const reply = replyJob(base.jobId, 'resume');
    try {
      const stored = readJob(reply.job.jobId)!;
      assert.deepEqual(stored.contract, c, 'flag off still persists the inherited contract internally');
      assert.equal(stored.acceptanceStatus, 'not_requested', 'flag off means not_requested');
      assert.deepEqual(stored.gateResults, []);
      assert.equal(stored.workerStatus, 'queued');
      const view = getStatus(reply.job.jobId);
      assert.equal(view.acceptanceStatus, 'not_requested');
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withContractFlag(savedContractFlag);
  }
});

// ---------------------------------------------------------------------------
// T1E-E2A supervisor acceptance gate — final-state closure.
//
// A job started with an explicit contract + acceptanceStatus 'pending' runs the
// acceptance gate when the worker exits 0. The supervisor never re-reads the
// feature flag (ORCHESTRATOR_CONTRACT_V2 is irrelevant here — the contract +
// pending status on the record IS the decision). Gate results are driven by
// test/fake-acceptance.mjs.
// ---------------------------------------------------------------------------

const FAKE_ACCEPTANCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fake-acceptance.mjs',
);

// A pending-contract job that runs the real worker (exit 0) then the gates.
function acceptanceJob(
  name: string,
  gateArgvs: string[][],
  over: { workerExit?: number; runSeconds?: string } = {},
): { job: ReturnType<typeof startJob>['job']; work: string } {
  const work = deliverableWork(name);
  const contract = explicitContract({
    acceptance: gateArgvs.map((argv, i) => ({
      id: `g${i + 1}`,
      argv,
      cwdRelative: '.',
      timeoutSeconds: 20,
      required: i === 0,
      outputMaxChars: 5000,
    })),
  });
  const job = startJob(
    fakeParams({
      workFolder: work,
      contract,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_RUN_SECONDS: over.runSeconds ?? '1',
        FAKE_CLAUDE_EXIT_CODE: String(over.workerExit ?? 0),
      }),
    }),
  ).job;
  assert.equal(readJob(job.jobId)!.acceptanceStatus, 'pending', 'start persists the pending acceptance request');
  return { job, work };
}

// Gate argv for an acceptance command that exits with the given code.
function gateArgv(exit: number): string[] {
  return [process.execPath, FAKE_ACCEPTANCE, '--exit', String(exit)];
}

test('T1E-E2A worker exit0 + required gate exit1 => acceptance fail, overall failed/acceptance_failed', async () => {
  withContractFlag('1');
  try {
    const { job } = acceptanceJob('e2a-required-fail', [gateArgv(1)]);
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'acceptance_failed');
      assert.equal(final.workerStatus, 'succeeded', 'worker truth kept on the record');
      assert.equal(final.acceptanceStatus, 'fail');
      assert.equal(final.exitCode, 0, 'the worker itself exited 0');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.workerStatus, 'succeeded');
      assert.equal(stored.acceptanceStatus, 'fail');
      assert.equal(stored.substatus, 'acceptance_failed');
      assert.ok(Array.isArray(stored.gateResults), 'internal GateResult[] persisted');
      assert.equal(stored.gateResults!.length, 1);
      assert.equal(stored.gateResults![0].id, 'g1');
      assert.equal(stored.gateResults![0].exitCode, 1);
      assert.equal(stored.gateResults![0].required, true);
      assert.ok(fs.existsSync(doneFilePath(job.jobId)), 'done marker written');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A required gate pass => overall succeeded, acceptance pass', async () => {
  withContractFlag('1');
  try {
    const { job } = acceptanceJob('e2a-required-pass', [gateArgv(0)]);
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'succeeded');
      assert.equal(final.substatus, null);
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'pass');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.acceptanceStatus, 'pass');
      assert.equal(stored.substatus, null);
      assert.equal(stored.gateResults!.length, 1);
      assert.equal(stored.gateResults![0].exitCode, 0);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A optional gate fail => acceptance pass, overall succeeded', async () => {
  withContractFlag('1');
  try {
    const { job } = acceptanceJob('e2a-optional-fail', [gateArgv(0), gateArgv(1)]);
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'succeeded', 'optional failure never fails the summary');
      assert.equal(final.substatus, null);
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'pass');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.gateResults!.length, 2, 'both gates ran and were recorded');
      assert.equal(stored.gateResults![0].exitCode, 0, 'first (required) gate passed');
      assert.equal(stored.gateResults![0].required, true, 'first gate is the required one');
      assert.equal(stored.gateResults![1].exitCode, 1, 'second (optional) gate failed');
      assert.equal(stored.gateResults![1].required, false);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A required gate prevented => blocked, overall failed/acceptance_blocked', async () => {
  withContractFlag('1');
  try {
    const work = deliverableWork('e2a-prevented');
    // A required gate whose cwd escapes workFolder is prevented by the runner
    // precondition guard (never executed, never thrown).
    const contract = explicitContract({
      acceptance: [
        {
          id: 'g1',
          argv: [process.execPath, FAKE_ACCEPTANCE, '--exit', '0'],
          cwdRelative: 'missing-subdir', // nonexistent in workFolder -> prevented
          timeoutSeconds: 20,
          required: true,
          outputMaxChars: 5000,
        },
      ],
    });
    const { job } = startJob(
      fakeParams({ workFolder: work, contract, extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }) }),
    );
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'acceptance_blocked');
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'blocked');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.acceptanceStatus, 'blocked');
      assert.equal(stored.gateResults![0].prevented, true);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A worker fail never runs the gate (blocked, original failure semantics)', async () => {
  withContractFlag('1');
  try {
    const { job } = acceptanceJob('e2a-worker-fail', [gateArgv(0)], { workerExit: 1 });
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'exit_1', 'worker failure keeps its own substatus');
      assert.equal(final.workerStatus, 'failed', 'workerStatus saves the true worker outcome');
      assert.equal(final.acceptanceStatus, 'blocked', 'pending acceptance that never ran is blocked');
      const stored = readJob(job.jobId)!;
      assert.deepEqual(stored.gateResults, [], 'no gate ever ran');
      assert.equal(stored.workerStatus, 'failed');
      assert.equal(stored.acceptanceStatus, 'blocked');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A needs_attention never runs the gate and never flips pending', async () => {
  withContractFlag('1');
  try {
    const work = deliverableWork('e2a-needs-attention');
    const contract = explicitContract({
      acceptance: [
        {
          id: 'g1',
          argv: [process.execPath, FAKE_ACCEPTANCE, '--exit', '0'],
          cwdRelative: '.',
          timeoutSeconds: 20,
          required: true,
          outputMaxChars: 5000,
        },
      ],
    });
    // Fake worker exits 3 and supervisor maps it to needs_attention.
    const { job } = startJob(
      fakeParams({
        workFolder: work,
        contract,
        extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '3' }),
      }),
    );
    try {
      const final = await waitForFinalized(job.jobId, 15000);
      assert.equal(final.status, 'needs_attention', 'blocked worker reports needs_attention');
      const finalView = getStatus(job.jobId);
      assert.equal(finalView.workerStatus, 'needs_attention', 'workerStatus saves the true outcome');
      assert.equal(finalView.acceptanceStatus, 'pending', 'pending is untouched — the gate waits for a reply');
      const stored = readJob(job.jobId)!;
      assert.deepEqual(stored.gateResults, [], 'no gate ran');
      assert.equal(stored.acceptanceStatus, 'pending');
      // The user resolves the approval: atomically update the parent job's
      // extraEnv so the resumed worker exits 0 (no attention request), leaving
      // status/acceptanceStatus/gateResults untouched. The reply inherits this
      // updated extraEnv (scheduler mirrors base.extraEnv onto reply records).
      updateJob(job.jobId, { extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '0' }) });
      // A reply resumes the pending contract: worker runs again and now the gate
      // is executed to completion.
      const reply = replyJob(job.jobId, 'resume');
      try {
        const rf = await waitForJob(reply.job.jobId, 30);
        assert.equal(rf.status, 'succeeded', 'resumed worker + passing gate succeeds');
        assert.equal(rf.acceptanceStatus, 'pass');
      } finally {
        cancelJob(reply.job.jobId);
      }
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2A pending contract never exposes overall succeeded mid-gate (write order)', async () => {
  withContractFlag('1');
  try {
    const work = deliverableWork('e2a-write-order');
    const contract = explicitContract({
      acceptance: [
        {
          id: 'g1',
          argv: [process.execPath, FAKE_ACCEPTANCE, '--exit', '1'],
          cwdRelative: '.',
          timeoutSeconds: 20,
          required: true,
          outputMaxChars: 5000,
        },
      ],
    });
    const { job } = startJob(
      fakeParams({
        workFolder: work,
        contract,
        extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
      }),
    );
    try {
      let sawSucceeded = false;
      let finalized = false;
      // Poll the raw record until the supervisor has persisted workerStatus
      // (the gate has started). Between that moment and the terminal write the
      // overall status must never read `succeeded`.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !finalized) {
        const stored = readJob(job.jobId);
        if (stored) {
          if (stored.workerStatus === 'succeeded') {
            if (stored.status === 'succeeded') sawSucceeded = true;
            if (isTerminal(stored.status)) finalized = true;
          }
        }
        await sleep(10);
      }
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'acceptance_failed');
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'fail');
      const terminal = readJob(job.jobId)!;
      assert.ok(terminal.endedAt !== null, 'terminal write landed');
      assert.equal(sawSucceeded, false, 'workerStatus=succeeded never raced an overall succeeded');
      assert.ok(terminal.gateResults && terminal.gateResults.length === 1);
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

// ---------------------------------------------------------------------------
// T1E-E2B supervisor review-manifest forced closure.
//
// A read_only_report contract permits the worker exactly ONE workspace write:
// the contract's own deliverable (reporting.deliverablePath). The supervisor
// snapshots the workspace before the worker spawns, diffs it after the worker
// exits (before any acceptance command), and any other added/changed/removed
// file is a review violation that fails the job closed. The worker writes via
// the fake-claude write hook (FAKE_CLAUDE_WRITE_RELATIVE resolved against the
// workFolder = the worker cwd); the test body never writes the target itself.
// ---------------------------------------------------------------------------

// A pending read_only_report job whose worker writes ONE relative path via the
// fake-claude hook. Writes exactly `relative` (default '' = no write), exits 0.
// The pending-acceptance assertion is conditional: with the flag OFF the
// scheduler never requests acceptance, so the job is 'not_requested' — the
// exact state test (d) must observe.
//
// Writes from the WORKER via the fake-claude hook are real: the hook
// (FAKE_CLAUDE_WRITE_RELATIVE / FAKE_CLAUDE_WRITE_CONTENT, resolved against
// the worker cwd = the work folder) writes the file in the spawn→close window,
// exactly like a real worker touching the workspace during its run. The test
// body never writes the target itself (except test (d)'s pre-written
// deliverable, which is the old-path setup).
function reviewJob(
  name: string,
  relative: string,
  over: { workerExit?: number; content?: string; expectPending?: boolean; prewriteDeliverable?: string } = {},
): { job: ReturnType<typeof startJob>['job']; work: string; dp: string } {
  const work = deliverableWork(name);
  const dp = path.join(work, 'report.md');
  if (over.prewriteDeliverable !== undefined) {
    fs.writeFileSync(dp, over.prewriteDeliverable, 'utf8');
  }
  const acceptance: Array<{ id: string; argv: string[]; cwdRelative: string; timeoutSeconds: number; required: boolean; outputMaxChars: number }> = [
    {
      id: 'g1',
      argv: gateArgv(0),
      cwdRelative: '.',
      timeoutSeconds: 20,
      required: true,
      outputMaxChars: 5000,
    },
  ];
  const contract = explicitContract({
    writePolicy: 'read_only_report',
    reporting: { deliverablePath: dp },
    acceptance,
  });
  const extraEnv: Record<string, string> = fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' });
  if (relative) {
    extraEnv.FAKE_CLAUDE_WRITE_RELATIVE = relative;
    extraEnv.FAKE_CLAUDE_WRITE_CONTENT = over.content ?? 'fake-worker-write';
  }
  const job = startJob(
    fakeParams({ workFolder: work, contract, extraEnv, taskType: 'analysis', deliverablePath: dp }),
  ).job;
  const expectPending = over.expectPending ?? true;
  assert.equal(
    readJob(job.jobId)!.acceptanceStatus,
    expectPending ? 'pending' : 'not_requested',
    expectPending ? 'start persists the pending acceptance request' : 'flag off never requests acceptance',
  );
  return { job, work, dp };
}

test('T1E-E2B deliverable-only write: review clean, normal gate runs, overall succeeded', async () => {
  withContractFlag('1');
  try {
    // The fake worker itself writes the deliverable (report.md) inside the
    // spawn→close window. A clean audit must ignore the deliverable, run every
    // gate, and succeed.
    const { job, work, dp } = reviewJob('e2b-deliverable-only', 'report.md', { content: 'fake-report' });
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'succeeded');
      assert.equal(final.substatus, null);
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'pass');
      assert.equal(final.failureDetail, undefined, 'no failure detail on a clean review');
      // The worker wrote the deliverable inside the spawn→close window; the
      // actual inspection found it, so it is never marked missing (neither by
      // the clean audit nor by any unconditional overwrite).
      assert.notEqual(final.missingDeliverable, true, 'the written deliverable is never marked missing');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.acceptanceStatus, 'pass');
      assert.equal(stored.gateResults!.length, 1, 'only the normal acceptance gate ran');
      assert.equal(stored.gateResults![0].id, 'g1');
      assert.equal(stored.gateResults![0].exitCode, 0);
      assert.ok(stored.gateResults!.every((x) => x.errorCode === undefined), 'no synthetic review gate on a clean review');
      assert.equal(stored.substatus, null);
      // The deliverable itself was written by the worker and diff-ignored.
      assert.ok(fs.existsSync(dp), 'the deliverable itself was written');
      assert.equal(fs.readFileSync(dp, 'utf8'), 'fake-report', 'the deliverable content is the worker write');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2B extra write => review violation: acceptance skipped, overall failed/review_write_violation', async () => {
  withContractFlag('1');
  try {
    // The fake worker itself writes 'second.txt' inside the spawn→close
    // window — a non-deliverable workspace write. The audit must catch it as a
    // violation, skip the acceptance gates, and fail.
    const { job, work } = reviewJob('e2b-extra-write', 'second.txt');
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'review_write_violation');
      assert.equal(final.workerStatus, 'succeeded', 'worker truth saved despite the violation');
      assert.equal(final.acceptanceStatus, 'fail');
      assert.equal(final.exitCode, 0, 'the worker itself exited 0');
      assert.equal(final.failureDetail, 'review write violation');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.workerStatus, 'succeeded');
      assert.equal(stored.acceptanceStatus, 'fail');
      assert.equal(stored.substatus, 'review_write_violation');
      assert.equal(stored.gateResults!.length, 1, 'the ONLY gate is the synthetic review gate');
      const g = stored.gateResults![0];
      assert.equal(g.id, 'review-write-policy');
      assert.equal(g.required, true);
      assert.equal(g.exitCode, null);
      assert.equal(g.timedOut, false);
      assert.equal(g.prevented, false);
      assert.equal(g.error, 1);
      assert.equal(g.errorCode, 'ERR_REVIEW_WRITE_VIOLATION');
      assert.equal(g.stdoutSummary, '');
      assert.ok(g.stderrSummary.includes('added: 1: second.txt'), 'names the violating path');
      assert.ok(g.stderrSummary.length <= 1000, 'summary stays bounded');
      assert.equal(g.stdoutPreview, '');
      assert.equal(g.stderrPreview, '');
      assert.ok(fs.existsSync(path.join(work, 'second.txt')), 'the violating write landed (proven on disk)');
      // The acceptance commands never ran: only the synthetic review gate exists.
      assert.ok(!stored.gateResults!.some((x) => x.id === 'g1'), 'no acceptance gate ran');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2B BASELINE.md write (contract-scoped file) is still a violation', async () => {
  withContractFlag('1');
  try {
    const { job, work } = reviewJob('e2b-baseline-write', 'BASELINE.md');
    try {
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'failed');
      assert.equal(final.substatus, 'review_write_violation');
      assert.equal(final.workerStatus, 'succeeded');
      assert.equal(final.acceptanceStatus, 'fail');
      const stored = readJob(job.jobId)!;
      assert.equal(stored.gateResults!.length, 1);
      assert.equal(stored.gateResults![0].id, 'review-write-policy');
      assert.equal(stored.gateResults![0].errorCode, 'ERR_REVIEW_WRITE_VIOLATION');
      assert.ok(stored.gateResults![0].stderrSummary.includes('added: 1: BASELINE.md'));
      assert.ok(fs.existsSync(path.join(work, 'BASELINE.md')), 'the violating write landed (proven on disk)');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

test('T1E-E2B flag off + read_only_report contract: old path, no audit, no synthetic gate', async () => {
  withContractFlag(undefined);
  try {
    // Flag off: the test body pre-writes a valid deliverable (report.md) to
    // satisfy the existing deliverable requirement, and the fake worker writes
    // 'second.txt'. With the flag off the scheduler never requests acceptance;
    // the review audit (triggered by contract + pending) never runs, so the
    // old path succeeds and no synthetic gate exists — even with a workspace
    // write.
    const { job, work, dp } = reviewJob('e2b-flag-off', 'second.txt', {
      expectPending: false,
      prewriteDeliverable: 'pre-written',
    });
    try {
      assert.equal(fs.readFileSync(dp, 'utf8'), 'pre-written', "the test's pre-written deliverable is untouched");
      const final = await waitForJob(job.jobId, 30);
      assert.equal(final.status, 'succeeded', 'flag off never audits — old path succeeds');
      assert.equal(final.substatus, null);
      assert.equal(final.acceptanceStatus, 'not_requested', 'flag off never requests acceptance');
      // The legacy path runs no gate, but the worker's true outcome is still
      // persisted before the terminal write (the job's own status remains the
      // authoritative outcome on the legacy path).
      assert.equal(final.workerStatus, 'succeeded', 'worker truth persisted on the legacy path too');
      // The pre-written deliverable exists and was actually inspected: it is
      // never fabricated as missing by the absent audit / review policy.
      assert.notEqual(final.missingDeliverable, true, 'an existing deliverable is never marked missing');
      const stored = readJob(job.jobId)!;
      assert.deepEqual(stored.gateResults, [], 'no gate, no synthetic review gate');
      assert.equal(stored.acceptanceStatus, 'not_requested');
      assert.ok(fs.existsSync(path.join(work, 'second.txt')), 'the extra write landed untouched');
    } finally {
      cancelJob(job.jobId);
    }
  } finally {
    withContractFlag(savedContractFlag);
  }
});

// ---------------------------------------------------------------------------
// Wave 3B: reply preflight. Flag-gated; off keeps the legacy reply byte-for-
// byte identical (proven by the older reply tests above still passing with the
// flag absent). On, a Claude session transcript over the threshold rejects
// synchronously with the fixed code prefix new_start_required unless
// allowLargeResume; a deepseek-harness job rejects with
// fresh_turn_authorization_required unless allowFreshTurn (which then runs a
// fresh bounded turn with a NEW session id, never a parent-session resume).
// Every test snapshots and restores both env flags.
// ---------------------------------------------------------------------------

const REPLY_FLAG = 'ORCHESTRATOR_REPLY_PREFLIGHT';
const savedReplyFlag = process.env[REPLY_FLAG];
const MAX_BYTES_FLAG = 'ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES';
const savedMaxBytesFlag = process.env[MAX_BYTES_FLAG];

function withReplyFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[REPLY_FLAG];
  else process.env[REPLY_FLAG] = value;
}
function withMaxBytes(value: string | undefined): void {
  if (value === undefined) delete process.env[MAX_BYTES_FLAG];
  else process.env[MAX_BYTES_FLAG] = value;
}

// Writes a transcript fixture of the requested size at the exact path the
// scheduler preflight reads: <home>/.claude/projects/<munged workFolder>/<sessionId>.jsonl
function writeTranscriptFixture(home: string, workFolder: string, sessionId: string, bytes: number): string {
  const munged = workFolder.replace(/[^a-zA-Z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', munged);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x61)); // 0x61 = 'a'
  return p;
}

// A needs_attention fixture job whose transcript the scheduler will stat. The
// workFolder must exist (the supervisor may touch it) and the job must be
// terminal-ish enough for replyJob to reach the preflight without killing a
// live worker. needs_attention with no pid is safe.
function preflightFixture(sessionId: string, over: Partial<Job> = {}): Job {
  const work = deliverableWork(`wave3b-${Math.random().toString(36).slice(2, 8)}`);
  const base = makeRecoveryJob('needs_attention', {
    substatus: 'permission_request',
    workFolder: work,
    sessionId,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }),
    ...over,
  });
  atomicWriteJson(jobFilePath(base.jobId), base);
  return base;
}

// SHA-256 of a file's bytes (no-base64 helper for byte-identity assertions).
function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

test('Wave3B harness reply default fail-fast with flag OFF: no new job, parent job/session/PID untouched, no kill/dir side effect', () => {
  // The deepseek-harness capability gate is unconditional — it must fire even
  // with ORCHESTRATOR_REPLY_PREFLIGHT unset. The base has NO pid, so a kill
  // path would have nothing to act on; the strongest no-side-effect proof is
  // that the throw happens before the reply record exists and the parent's
  // JSON stays byte-identical (hash before == hash after).
  withReplyFlag(undefined);
  try {
    const base = preflightFixture(`ses-${Math.random().toString(36).slice(2, 10)}`, {
      workerBackend: 'deepseek-harness',
    });
    const beforeHash = sha256File(jobFilePath(base.jobId));
    const beforeCount = listJobsView(1000).length;
    assert.throws(
      () => replyJob(base.jobId, 'resume harness', { allowFreshTurn: false }),
      (e: Error) => e.message.startsWith('fresh_turn_authorization_required'),
      'harness reply must fail fast with the fixed prefix even with the flag off',
    );
    const after = readJob(base.jobId)!;
    assert.equal(after.sessionId, base.sessionId, 'parent session id unchanged');
    assert.equal(after.pid, null, 'parent pid untouched');
    assert.equal(after.status, 'needs_attention', 'parent status untouched');
    assert.equal(after.replyMode, undefined, 'parent never gains a replyMode');
    assert.equal(sha256File(jobFilePath(base.jobId)), beforeHash, 'parent job JSON byte-identical');
    assert.equal(listJobsView(1000).length, beforeCount, 'no reply job is created');
  } finally {
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B harness reply with allowFreshTurn runs a NEW session fresh_turn turn, never a resume', () => {
  withReplyFlag(undefined);
  try {
    const base = preflightFixture(`ses-${Math.random().toString(36).slice(2, 10)}`, {
      workerBackend: 'deepseek-harness',
    });
    const reply = replyJob(base.jobId, 'resume harness', { allowFreshTurn: true });
    try {
      assert.equal(reply.job.kind, 'reply');
      assert.equal(reply.job.replyToJobId, base.jobId, 'lineage via replyToJobId');
      assert.equal(reply.job.replyMode, 'fresh_turn', 'allowFreshTurn => fresh_turn mode');
      assert.notEqual(reply.job.sessionId, base.sessionId, 'fresh_turn uses a NEW session id');
      assert.ok(
        reply.warnings.some((w) => w.includes('NOT resumed')),
        'the warning explicitly says the parent session is not resumed',
      );
      const stored = readJob(reply.job.jobId)!;
      assert.equal(stored.replyMode, 'fresh_turn', 'replyMode persisted');
      assert.notEqual(stored.sessionId, base.sessionId, 'stored session id is new');
      assert.ok(
        stored.prompt.includes('新的独立轮次') && !stored.prompt.includes('续接已保存的 Claude 会话'),
        'harness prompt carries the fresh-turn block, never a resume claim',
      );
      // The parent job is never modified by the fresh-turn reply.
      const parent = readJob(base.jobId)!;
      assert.equal(parent.sessionId, base.sessionId);
      assert.equal(parent.pid, null);
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B harness start job carries an accurate backend capability block, user prompt verbatim', () => {
  const work = deliverableWork('harness-start-exec');
  const { job } = startJob(
    fakeParams({ workFolder: work, workerBackend: 'deepseek-harness', extraEnv: fakeEnv() }),
  );
  try {
    const stored = readJob(job.jobId)!;
    assert.equal(stored.workerBackend, 'deepseek-harness');
    // The harness start prompt must state the real capability boundary.
    assert.ok(stored.prompt.includes('新的独立轮次'), 'harness start prompt carries the fresh-turn block');
    assert.ok(
      stored.prompt.includes('历史会话的衔接'),
      'harness start prompt states there is no session resume',
    );
    assert.ok(
      stored.prompt.includes('单次有界任务'),
      'harness start prompt states the bounded single-task capability',
    );
    // The user's own prompt text is preserved verbatim, exactly once.
    const occurrences = stored.prompt.split('fake task').length - 1;
    assert.equal(occurrences, 1, 'user prompt appears exactly once, verbatim');
  } finally {
    cancelJob(job.jobId);
  }
});

test('Wave3B flag off: legacy reply untouched (no preflight, no replyMode)', async () => {
  withReplyFlag(undefined);
  try {
    const base = preflightFixture(`ses-${Math.random().toString(36).slice(2, 10)}`);
    try {
      const reply = replyJob(base.jobId, 'legacy narrow');
      assert.equal(reply.job.kind, 'reply');
      assert.equal(reply.job.replyToJobId, base.jobId);
      assert.equal(reply.job.sessionId, base.sessionId, 'legacy reply keeps the parent session id');
      assert.equal(reply.job.replyMode, null, 'flag off => public replyMode is null');
      const stored = readJob(reply.job.jobId)!;
      assert.equal(stored.replyMode, undefined, 'flag off => no replyMode persisted');
      const prompt = stored.prompt;
      assert.ok(prompt.includes(base.sessionId) === false, 'legacy prompt has no execution block');
    } finally {
      cancelJob(base.jobId);
    }
  } finally {
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B claude transcript over threshold rejects with new_start_required before any side effect', async () => {
  withReplyFlag('1');
  // 4.2 MiB > the 2 MiB default threshold.
  const size = 4.2 * 1024 * 1024;
  const savedHome = process.env.USERPROFILE || process.env.HOME;
  const tmpHome = path.join(os.tmpdir(), `orc-wave3b-home-${process.pid}-${Date.now()}`);
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  if (process.env.HOME) delete process.env.HOME;
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    writeTranscriptFixture(tmpHome, base.workFolder, sessionId, size);
    const before = listJobsView(1000).length;
    assert.throws(
      () => replyJob(base.jobId, 'resume big'),
      (e: Error) => e.message.startsWith('new_start_required'),
      'denied reply must throw with the fixed new_start_required prefix',
    );
    const after = listJobsView(1000).length;
    assert.equal(after, before, 'no reply job is created on a denied reply');
    // The base job is still the only record and was never modified.
    const still = readJob(base.jobId)!;
    assert.equal(still.status, 'needs_attention');
    assert.equal(still.endedAt, null);
  } finally {
    cancelJob(base.jobId);
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B allowLargeResume lets an over-threshold Claude reply resume with a warning', async () => {
  withReplyFlag('1');
  const size = 4.2 * 1024 * 1024;
  const tmpHome = path.join(os.tmpdir(), `orc-wave3b-home2-${process.pid}-${Date.now()}`);
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  if (process.env.HOME) delete process.env.HOME;
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    writeTranscriptFixture(tmpHome, base.workFolder, sessionId, size);
    const reply = replyJob(base.jobId, 'resume big', { allowLargeResume: true });
    try {
      assert.equal(reply.job.kind, 'reply');
      assert.equal(reply.job.replyMode, 'resume_session', 'explicit allow => resume_session mode');
      assert.equal(reply.job.sessionId, base.sessionId, 'resume_session keeps the parent session id');
      assert.ok(
        reply.warnings.some((w) => w.includes('allowLargeResume')),
        'an explicit override surfaces a safe warning (bytes/threshold only)',
      );
      const stored = readJob(reply.job.jobId)!;
      assert.equal(stored.replyMode, 'resume_session');
      assert.ok(stored.prompt.includes('续接已保存的 Claude 会话'), 'claude resume prompt carries the resume execution block');
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B under-threshold Claude reply still flows through preflight and gets replyMode=resume_session', async () => {
  withReplyFlag('1');
  const tmpHome = path.join(os.tmpdir(), `orc-wave3b-home3-${process.pid}-${Date.now()}`);
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  if (process.env.HOME) delete process.env.HOME;
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    writeTranscriptFixture(tmpHome, base.workFolder, sessionId, 1024);
    const reply = replyJob(base.jobId, 'resume small');
    try {
      assert.equal(reply.job.replyMode, 'resume_session');
      assert.equal(reply.job.sessionId, base.sessionId);
      assert.ok(!reply.warnings.some((w) => w.includes('allowLargeResume')), 'no override warning under threshold');
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B missing transcript counts as 0 bytes and resumes normally', async () => {
  withReplyFlag('1');
  try {
    const base = preflightFixture(`ses-${Math.random().toString(36).slice(2, 10)}`);
    try {
      // No fixture written: stat fails => 0 bytes => under threshold.
      const reply = replyJob(base.jobId, 'resume no transcript');
      try {
        assert.equal(reply.job.replyMode, 'resume_session');
        assert.equal(reply.job.sessionId, base.sessionId);
      } finally {
        cancelJob(reply.job.jobId);
      }
    } finally {
      cancelJob(base.jobId);
    }
  } finally {
    withReplyFlag(savedReplyFlag);
  }
});

test('Wave3B threshold env override: a transcript under the raised cap is allowed', async () => {
  withReplyFlag('1');
  withMaxBytes((5 * 1024 * 1024).toString());
  const size = 4.2 * 1024 * 1024;
  const tmpHome = path.join(os.tmpdir(), `orc-wave3b-home4-${process.pid}-${Date.now()}`);
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  if (process.env.HOME) delete process.env.HOME;
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    writeTranscriptFixture(tmpHome, base.workFolder, sessionId, size);
    const reply = replyJob(base.jobId, 'resume raised cap');
    try {
      assert.equal(reply.job.replyMode, 'resume_session', 'raised threshold lets the same transcript through');
      assert.equal(reply.job.sessionId, base.sessionId);
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    withMaxBytes(savedMaxBytesFlag);
    withReplyFlag(savedReplyFlag);
  }
});

// ---------------------------------------------------------------------------
// Wave 5A2b1: reply supersede via the session index. Retention on, the
// supersede scan calls indexedJobIdsForSession + readJob verification instead
// of the legacy listJobs(1000) window — an old in-flight reply beyond that
// window is still found and superseded. Flag off keeps the legacy scan.
// All fixtures are on-disk jobs (hook writes, no real Claude spawned).
// The retention and reply flags are snapshotted and restored around every
// test, exactly like the Wave3B block.
// ---------------------------------------------------------------------------

const RETENTION_FLAG = 'ORCHESTRATOR_RETENTION_V2';
const savedRetentionFlag = process.env[RETENTION_FLAG];

function withRetentionFlag(value: string | undefined): void {
  if (value === undefined) delete process.env[RETENTION_FLAG];
  else process.env[RETENTION_FLAG] = value;
}

// Seeds N job files directly (bypasses the index mirror on purpose) so the
// index stays stale until an explicit rebuild.
function seedJobsOnDisk(count: number): Job[] {
  const jobs: Job[] = [];
  for (let i = 0; i < count; i++) {
    const j = makeRecoveryJob('running', {
      sessionId: `ses-other-${Math.random().toString(36).slice(2, 8)}`,
      workFolder: deliverableWork('supersede-decoy'),
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(j.jobId), j);
    jobs.push(j);
  }
  return jobs;
}

// Ordering facts: listJobs(1000) sorts by startedAt DESC and truncates to
// 1000, so once 1000+ jobs with NEWER startedAt than the target exist, the
// target cannot appear in the legacy window. The session index is keyed by
// sessionId and is not size-limited, so it still reaches the target.
function assertOutOfLegacyWindow(targetId: string, targetStartedAt: string, olderCount: number): void {
  const windowed = listJobsView(1000);
  assert.equal(windowed.length, 1000, 'the legacy window is exactly 1000 jobs');
  assert.ok(!windowed.some((v) => v.jobId === targetId), 'old reply is outside the legacy listJobs(1000) window');
  const all = windowed.map((v) => v.startedAt);
  const sorted = [...all].sort();
  assert.deepEqual(all, sorted.reverse(), 'the legacy window is the 1000 newest startedAt jobs');
  assert.ok(all.every((t) => t > targetStartedAt), `all ${olderCount} window jobs are newer than the target`);
}

test('Wave5A2b1 flag on: index-supersede finds an old in-flight reply beyond the listJobs(1000) window', () => {
  withRetentionFlag('1');
  withReplyFlag('1'); // resume_session keeps the parent session (supersede applies)
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  // The decoys are written AFTER the target reply in jobs/ mtime terms is not
  // guaranteed by the FS, but listJobs(1000) orders by startedAt desc — the
  // decoys are all NEWER, so a supersede scan limited to listJobs(1000) could
  // not see the old reply; only the session index can.
  const base = preflightFixture(sessionId, { workFolder: deliverableWork(`supersede-base-${Math.random().toString(36).slice(2, 8)}`) });
  try {
    const oldReply = makeRecoveryJob('running', {
      sessionId,
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(oldReply.jobId), oldReply);
    // The old reply must be far OLDER than the decoys in startedAt so it falls
    // outside the listJobs(1000) window (the 1000 newest by startedAt). Rewrite
    // it to 1h ago; the decoys keep their default (now) timestamps.
    oldReply.startedAt = new Date(Date.now() - 3_600_000).toISOString();
    atomicWriteJson(jobFilePath(oldReply.jobId), oldReply);
    seedJobsOnDisk(1010);
    const storedOld = readJob(oldReply.jobId)!;
    assert.equal(storedOld.status, 'running', 'old reply is in-flight before supersede');

    // The index mirror never saw the fixtures (direct writes): rebuild so the
    // session index covers every job file.
    invalidateJobIndexForTests();
    const rebuilt = rebuildJobIndexNow();
    assert.ok(rebuilt && rebuilt.indexed >= 1012, `rebuild indexed ${rebuilt?.indexed} jobs`);

    assertOutOfLegacyWindow(oldReply.jobId, oldReply.startedAt, 1010);

    const reply = replyJob(base.jobId, 'supersede through the index');
    try {
      assert.equal(reply.job.sessionId, sessionId, 'reply resumes the same session');
      assert.equal(readJob(oldReply.jobId)!.status, 'cancelled', 'index supersede cancelled the out-of-window in-flight reply');
      assert.match(reply.warnings.join('\n'), new RegExp(`superseded in-flight reply ${oldReply.jobId}`), 'supersede warning surfaced');
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withReplyFlag(savedReplyFlag);
    withRetentionFlag(savedRetentionFlag);
    invalidateJobIndexForTests();
  }
});

test('Wave5A2b1 flag on: stale/foreign/terminal index entries are never killed or rewritten', () => {
  withRetentionFlag('1');
  withReplyFlag('1');
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    const sameSessionReply = makeRecoveryJob('running', {
      sessionId,
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(sameSessionReply.jobId), sameSessionReply);
    // A terminal same-session reply must NOT be resurrected or touched.
    const terminalReply = makeRecoveryJob('succeeded', {
      sessionId,
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'succeeded',
      endedAt: new Date().toISOString(),
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(terminalReply.jobId), terminalReply);
    // A foreign-session reply (same shape, different session) must not be hit.
    const foreignReply = makeRecoveryJob('running', {
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(foreignReply.jobId), foreignReply);
    // A non-reply job on the same session must not be hit.
    const sameSessionStart = makeRecoveryJob('running', {
      sessionId,
      kind: 'start',
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(sameSessionStart.jobId), sameSessionStart);

    invalidateJobIndexForTests();
    const rebuilt = rebuildJobIndexNow();
    assert.ok(rebuilt && rebuilt.indexed >= 5, `rebuild indexed ${rebuilt?.indexed} jobs`);
    // Simulate index entries whose backing job files vanished (deleted) — a
    // stale id must be silently skipped, never acted on. Append a dangling id
    // by writing then deleting a job's JSON before the reply.
    const ghost = makeRecoveryJob('running', {
      sessionId,
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(ghost.jobId), ghost);
    invalidateJobIndexForTests();
    rebuildJobIndexNow();
    fs.unlinkSync(jobFilePath(ghost.jobId)); // job deleted; the index still lists it

    const reply = replyJob(base.jobId, 'supersede only verified entries');
    try {
      assert.equal(readJob(sameSessionReply.jobId)!.status, 'cancelled', 'verified same-session in-flight reply superseded');
      assert.equal(readJob(terminalReply.jobId)!.status, 'succeeded', 'terminal reply untouched');
      assert.equal(readJob(foreignReply.jobId)!.status, 'running', 'foreign-session reply untouched');
      assert.equal(readJob(sameSessionStart.jobId)!.status, 'running', 'same-session start job untouched');
      assert.equal(readJob(ghost.jobId), null, 'deleted job stays deleted');
      const warn = reply.warnings.join('\n');
      assert.ok(warn.includes(sameSessionReply.jobId), 'superseded warning names the verified reply');
      assert.ok(!warn.includes(terminalReply.jobId) && !warn.includes(foreignReply.jobId) && !warn.includes(sameSessionStart.jobId), 'no spurious supersede warnings');
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withReplyFlag(savedReplyFlag);
    withRetentionFlag(savedRetentionFlag);
    invalidateJobIndexForTests();
  }
});

test('Wave5A2b1 flag off: reply supersede still walks the legacy listJobs(1000) scan', () => {
  withRetentionFlag(undefined);
  withReplyFlag('1');
  const sessionId = `ses-${Math.random().toString(36).slice(2, 10)}`;
  const base = preflightFixture(sessionId);
  try {
    const oldReply = makeRecoveryJob('running', {
      sessionId,
      kind: 'reply',
      replyToJobId: base.jobId,
      status: 'running',
      workFolder: base.workFolder,
      pid: null,
      claudeCli: FAKE_CLAUDE,
      claudePrefix: [process.execPath],
      extraEnv: fakeEnv(),
    });
    atomicWriteJson(jobFilePath(oldReply.jobId), oldReply);
    // Flag off: no index directory may ever exist (checked AFTER the reply,
    // which spawns the fake supervisor with a transient working dir; only the
    // runtime jobs tree is inspected here).
    const reply = replyJob(base.jobId, 'legacy supersede');
    try {
      assert.equal(readJob(oldReply.jobId)!.status, 'cancelled', 'legacy scan superseded the in-flight reply');
      assert.match(reply.warnings.join('\n'), new RegExp(`superseded in-flight reply ${oldReply.jobId}`));
    } finally {
      cancelJob(reply.job.jobId);
    }
  } finally {
    cancelJob(base.jobId);
    withReplyFlag(savedReplyFlag);
    withRetentionFlag(savedRetentionFlag);
  }
});

// ---------------------------------------------------------------------------
// Retired receipt protocol: output text has no automatic lifecycle authority.
const LD_MARKER = 'LEADER_DECISION_REQUIRED_JSON:';
const ldReceipt = (reason: string, evidence: string, decisionNeeded: string): string =>
  LD_MARKER + JSON.stringify({ schemaVersion: 1, reason, evidence, decisionNeeded });

test('retired receipt text never changes a successful worker lifecycle', async () => {
  for (const output of [ldReceipt('example', 'evidence', 'decision'), LD_MARKER + ' {broken', ldReceipt(' ', 'e', 'd')]) {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RESULT_TEXT: output }) }));
    const final = await waitForJob(job.jobId, 60);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.substatus, null);
    assert.equal(final.workerStatus, 'succeeded');
    assert.equal(final.leaderDecision, undefined);
    assert.equal(readJob(job.jobId)!.leaderDecision, undefined);
    assert.ok(final.hasReport);
    assert.ok(fs.readFileSync(final.reportPath, 'utf8').includes(output));
  }
});

test('retired receipt text does not mask an original non-zero failure', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '1', FAKE_CLAUDE_RESULT_TEXT: ldReceipt('r', 'e', 'd') }) }));
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'failed');
  assert.equal(final.substatus, 'exit_1');
  assert.equal(final.leaderDecision, undefined);
});

test('legacy receipt records remain readable and are not inherited by replies', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 60);
  // Seed a historical fixture directly; production terminal monotonicity must
  // continue rejecting attempts to rewrite a completed job with updateJob.
  atomicWriteJson(jobFilePath(job.jobId), { ...readJob(job.jobId)!, status: 'failed', substatus: 'leader_decision_required', leaderDecision: { schemaVersion: 1, reason: 'legacy', evidence: 'e', decisionNeeded: 'd' } });
  assert.equal(getStatus(job.jobId).leaderDecision?.reason, 'legacy');
  const watched = await watchJob(job.jobId, { timeoutSeconds: 1 });
  assert.equal(watched.leaderDecision?.reason, 'legacy');
  const reply = replyJob(job.jobId, 'continue authorized fixture');
  try {
    assert.equal(reply.job.leaderDecision, undefined);
    assert.equal(readJob(reply.job.jobId)!.leaderDecision, undefined);
  } finally { cancelJob(reply.job.jobId); }
});
