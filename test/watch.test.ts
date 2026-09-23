// Integration tests for claude_code_watch through the real scheduler +
// detached supervisor, driven by the fake claude (test/fake-claude.mjs) so
// nothing hits a real proxy. Covers start -> watch terminal transitions,
// needs_attention wake, abort/timeout semantics, re-attach, multi-watcher, and
// reply-follow. Runtime state is isolated per test-file process.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rt = path.join(os.tmpdir(), `orc-watch-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0';
// Short permission-confirm window so the detached supervisors used here promote
// a genuine block to needs_attention quickly (transient events still resolve
// because their stdout continuation cancels the candidate before this fires).
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';
// Deterministic spawns: no anti-burst start jitter in tests.
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';

import {
  startJob,
  watchJob,
  getStatus,
  getRenderedStatus,
  waitForJob,
  cancelJob,
  replyJob,
  listJobsView,
  watchTestHooks,
} from '../src/scheduler.js';
import { jobFilePath } from '../src/job-store.js';
import { setFallbackMsForTest, closeJobEventBrokerForTest, brokerDiagnostics } from '../src/job-events.js';
import { isAlive as procIsAlive } from '../src/proc.js';
import type { StartParams } from '../src/router.js';

setFallbackMsForTest(50);
after(async () => {
  const resolvedRt = path.resolve(rt);
  const resolvedTmp = path.resolve(os.tmpdir());
  const safeRuntime =
    path.dirname(resolvedRt) === resolvedTmp && path.basename(resolvedRt).startsWith(`orc-watch-${process.pid}-`);
  const deadline = Date.now() + 15000;
  let quietSince: number | null = null;
  let lastRoundErrors: string[] = [];

  while (Date.now() < deadline) {
    if (fs.existsSync(resolvedRt)) {
      quietSince = null;
      const roundErrors: string[] = [];
      closeJobEventBrokerForTest();

      let jobs: ReturnType<typeof listJobsView> = [];
      try {
        // rt is unique to this test-file process; listJobsView reads only the
        // scheduler's currently configured runtime root.
        jobs = listJobsView(100);
      } catch (error) {
        roundErrors.push(`list jobs failed: ${String(error)}`);
      }
      for (const job of jobs) {
        try {
          await cleanupJob(job.jobId, 'watch file teardown');
        } catch (error) {
          roundErrors.push(`${job.jobId}: ${String(error)}`);
        }
      }

      closeJobEventBrokerForTest();
      if (!safeRuntime) {
        roundErrors.push(`refused runtime removal outside exact temp scope: ${resolvedRt}`);
      } else {
        try {
          fs.rmSync(resolvedRt, { recursive: true, force: true });
        } catch (error) {
          roundErrors.push(`runtime removal failed: ${String(error)}`);
        }
      }
      lastRoundErrors = roundErrors;
    }

    if (!fs.existsSync(resolvedRt)) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= 2000) break;
    } else {
      quietSince = null;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(100, remaining));
  }

  const finalRtExists = fs.existsSync(resolvedRt);
  const quietMs = quietSince === null ? 0 : Math.max(0, Date.now() - quietSince);
  if (Date.now() >= deadline || finalRtExists || quietMs < 2000) {
    closeJobEventBrokerForTest();
    const diagnostics = brokerDiagnostics();
    assert.fail(
      `watch file teardown deadline: rtExists=${finalRtExists}; quietMs=${quietMs}; ` +
        `lastRoundErrors=${lastRoundErrors.join(' | ') || 'none'}; ` +
        `broker=${JSON.stringify(diagnostics)}`,
    );
  }

  closeJobEventBrokerForTest();
  const diagnostics = brokerDiagnostics();
  assert.equal(diagnostics.subscribers, 0, 'file teardown leaves no broker subscribers');
  assert.equal(diagnostics.watcher, false, 'file teardown leaves no broker watcher');
  assert.equal(diagnostics.fallback, false, 'file teardown leaves no broker fallback');
  assert.equal(fs.existsSync(resolvedRt), false, `runtime must be gone after quiet period: ${resolvedRt}`);
});

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');

function fakeParams(over: Partial<StartParams> & { extraEnv?: Record<string, string> } = {}): StartParams {
  return {
    prompt: 'watch fake task',
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForEnded(jobId: string, timeoutMs = 20000): Promise<ReturnType<typeof getStatus>> {
  const deadline = Date.now() + timeoutMs;
  let status = getStatus(jobId);
  while (!status.endedAt && Date.now() < deadline) {
    await sleep(100);
    status = getStatus(jobId);
  }
  return status;
}

type CleanupStatus = ReturnType<typeof getStatus> & {
  pid?: number | null;
  supervisorPid?: number | null;
};

async function cleanupJob(jobId: string, reason: string): Promise<void> {
  let before: CleanupStatus | null = null;
  let statusError: unknown = null;
  try {
    // Keep the status read immediately before cancellation; current public
    // views omit PIDs, so the raw record is only a compatibility fallback.
    before = getStatus(jobId) as CleanupStatus;
  } catch (error) {
    statusError = error;
  }

  let raw: { pid?: unknown; supervisorPid?: unknown } = {};
  let rawError: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(jobFilePath(jobId), 'utf8')) as { pid?: unknown; supervisorPid?: unknown };
  } catch (error) {
    rawError = error;
  }

  const toPid = (preferred: unknown, fallback: unknown): number | null => {
    const value = preferred ?? fallback;
    return Number.isInteger(value) && (value as number) > 0 ? (value as number) : null;
  };
  const pids = [
    { name: 'pid', pid: toPid(before?.pid, raw.pid) },
    { name: 'supervisorPid', pid: toPid(before?.supervisorPid, raw.supervisorPid) },
  ].filter((entry): entry is { name: string; pid: number } => entry.pid !== null);

  let cancelError: unknown = null;
  try {
    await cancelJob(jobId, reason);
  } catch (error) {
    cancelError = error;
  }

  const deadline = Date.now() + 5000;
  let alive = pids.filter(({ pid }) => procIsAlive(pid));
  while (alive.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    alive = pids.filter(({ pid }) => procIsAlive(pid));
  }

  const diagnostics = brokerDiagnostics();
  const failures: string[] = [];
  if (statusError) failures.push(`getStatus before cancel failed: ${String(statusError)}`);
  if (rawError) failures.push(`PID record read failed: ${String(rawError)}`);
  if (cancelError) failures.push(`cancelJob failed: ${String(cancelError)}`);
  if (alive.length > 0) {
    failures.push(`PID exit timeout after 5000ms: ${alive.map(({ name, pid }) => `${name}=${pid}`).join(', ')}`);
  }
  if (diagnostics.subscribers !== 0) failures.push(`broker subscribers=${diagnostics.subscribers}`);
  if (diagnostics.watcher !== false) failures.push(`broker watcher=${diagnostics.watcher}`);
  if (diagnostics.fallback !== false) failures.push(`broker fallback=${diagnostics.fallback}`);

  assert.equal(failures.length, 0, `cleanup failed for ${jobId}: ${failures.join('; ')}`);
}

test('start then a single watch reaches succeeded with no running return', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const t0 = Date.now();
  const v = await watchJob(job.jobId, { timeoutSeconds: 60 });
  const elapsed = Date.now() - t0;
  assert.equal(v.wakeReason, 'terminal');
  assert.equal(v.status, 'succeeded');
  assert.equal(v.jobId, job.jobId);
  assert.ok(elapsed < 20000, `watch took ${elapsed}ms`);
  assert.ok(v.hasReport, 'succeeded job has a report');
  assert.ok(v.reportPath.length > 0);
  const raw = JSON.stringify(v);
  assert.ok(!raw.includes('watch fake task'), 'no prompt leak');
  assert.equal(brokerDiagnostics().subscribers, 0);
});

test('watch wakes once on failed', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_EXIT_CODE: '1' }) }));
  const v = await watchJob(job.jobId, { timeoutSeconds: 60 });
  assert.equal(v.status, 'failed');
  assert.equal(v.substatus, 'exit_1');
});

test('watch wakes on cancel without cancelling any other job', async (t) => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '8' }) }));
  t.after(() => cleanupJob(job.jobId, 'watch test cleanup: cancel'));
  const p = watchJob(job.jobId, { timeoutSeconds: 30 });
  await sleep(600); // let the supervisor spawn
  cancelJob(job.jobId, 'watch test cancel');
  const v = await p;
  assert.equal(v.status, 'cancelled');
  assert.equal(v.substatus, 'watch test cancel');
});

test('watch wakes on needs_attention while the worker is still alive', async (t) => {
  const { job } = startJob(
    fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_USER_PROMPT: '1', FAKE_CLAUDE_RUN_SECONDS: '10' }) }),
  );
  t.after(() => cleanupJob(job.jobId, 'watch test cleanup: needs_attention alive'));
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.wakeReason, 'needs_attention');
  assert.equal(v.status, 'needs_attention');
  assert.ok(v.attention && v.attention.length > 0, 'attention hint present');
  // The worker is still alive (no done marker) and the job is NOT cancelled.
  const st = getStatus(job.jobId);
  assert.ok(['needs_attention', 'succeeded'].includes(st.status));
  await waitForJob(job.jobId, 30);
});

test('needs_attention watch carries a structured, sanitized attentionDetail; status shares the same requestId', async (t) => {
  const work = path.join(rt, 'watch-attention-work');
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
  t.after(() => cleanupJob(job.jobId, 'watch test cleanup: structured needs_attention'));
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.wakeReason, 'needs_attention');
  assert.equal(v.status, 'needs_attention');
  assert.ok(v.attentionDetail, 'structured attention present on the watch result');
  const det = v.attentionDetail!;
  assert.equal(det.tool, 'Bash');
  assert.equal(det.action, 'delete');
  assert.equal(det.path, 'probe.txt', 'path is work-folder-relative, never the full path');
  assert.equal(det.risk, 'high');
  assert.equal(det.requestId, 'fake-prompt-1');
  assert.equal(det.requestIdSource, 'upstream');
  assert.ok(det.at.length > 0);
  assert.ok(det.message.length > 0 && det.message.length <= 200);
  assert.ok(!det.message.includes('Do you want to proceed'), 'message never leaks the raw prompt');

  // status carries the same requestId summary while the job is still in
  // needs_attention, and its rendered progress stays prompt-free.
  const st = getRenderedStatus(job.jobId, { lines: 3, stderrLines: 1 });
  assert.equal(st.status, 'needs_attention');
  assert.ok(st.attentionDetail, 'status carries attentionDetail');
  assert.equal(st.attentionDetail?.requestId, det.requestId);
  assert.equal(st.attentionDetail?.tool, 'Bash');
  assert.equal(st.attentionDetail?.path, 'probe.txt');
  assert.ok(!st.progress.includes('Do you want to proceed'), 'rendered progress never leaks the prompt');
  assert.ok(!st.progress.includes(permPath), 'rendered progress never leaks the full path');

  await waitForJob(job.jobId, 30);
});

test('confirmed attention stays sticky after later result output and exit 0', async (t) => {
  const work = path.join(rt, 'watch-sticky-exit0-work');
  fs.mkdirSync(work, { recursive: true });
  // Deterministic handshake gate (per-test dir, never shared): the test creates
  // the gate file AFTER the watch has confirmed needs_attention with the right
  // detail, so the fixture's result+exit0 can never race the confirmation.
  const gateDir = path.join(rt, `gates`, `watch-sticky-exit0-${process.pid}`);
  const gate = path.join(gateDir, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_SELF_RECOVER: '1',
        FAKE_CLAUDE_SELF_RECOVER_GATE: gate,
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'probe.txt'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  t.after(() => cleanupJob(job.jobId, 'watch test cleanup: sticky exit 0'));
  try {
    const watched = await watchJob(job.jobId, { timeoutSeconds: 30 });
    assert.equal(watched.status, 'needs_attention');
    assert.equal(watched.wakeReason, 'needs_attention');
    assert.equal(watched.attentionDetail?.requestId, 'fake-prompt-1');
    assert.equal(watched.attentionDetail?.tool, 'Bash');

    // The fixture is now blocked on the gate: only OUR write releases its
    // result event, so exit 0 happens strictly after the confirmation.
    fs.writeFileSync(gate, 'go', 'utf8');

    // Wait for the detached worker to close, then verify that exit 0 cannot
    // resolve the confirmed attention episode implicitly.
    let final = await waitForEnded(job.jobId);
    assert.equal(final.status, 'needs_attention');
    assert.equal(final.exitCode, 0);
    assert.equal(final.attentionDetail?.requestId, 'fake-prompt-1');
    assert.equal(final.attentionDetail?.tool, 'Bash');
    const jobJson = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as {
      attentionLog?: Array<{ requestId: string }>;
    };
    assert.ok((jobJson.attentionLog ?? []).some((e) => e.requestId === 'fake-prompt-1'), 'attentionLog retains fake-prompt-1');
  } finally {
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
});

test('confirmed attention stays sticky after exit 1', async () => {
  const work = path.join(rt, 'watch-sticky-exit1-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_EXIT_CODE: '1',
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  const watched = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(watched.status, 'needs_attention');
  assert.equal(watched.wakeReason, 'needs_attention');
  assert.equal(watched.attentionDetail?.requestId, 'fake-prompt-1');

  const final = await waitForEnded(job.jobId);
  assert.equal(final.status, 'needs_attention');
  assert.equal(final.exitCode, 1);
  assert.equal(final.attentionDetail?.requestId, 'fake-prompt-1');
  assert.equal(final.attentionDetail?.tool, 'Edit');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup; job is already terminal or needs_attention */
  }
});

test('delayed watch re-read observes confirmed sticky attention exactly once', async () => {
  const work = path.join(rt, 'watch-sticky-reread-work');
  fs.mkdirSync(work, { recursive: true });
  let delayed = false;
  watchTestHooks.beforeRecheck = () => {
    if (delayed) return;
    delayed = true;
    // The supervisor is detached, so it can publish needs_attention while the
    // scheduler's synchronous check/subscribe re-read is intentionally delayed.
    const until = Date.now() + 650;
    while (Date.now() < until) {
      // deterministic test-only delay
    }
  };
  try {
    const { job } = startJob(
      fakeParams({
        workFolder: work,
        extraEnv: fakeEnv({
          FAKE_CLAUDE_USER_PROMPT: '1',
          FAKE_CLAUDE_PERM_TOOL: 'Read',
          FAKE_CLAUDE_PERM_PATH: path.join(work, 'config.json'),
          FAKE_CLAUDE_RUN_SECONDS: '10',
        }),
      }),
    );
    const watched = await watchJob(job.jobId, { timeoutSeconds: 30 });
    assert.equal(delayed, true);
    assert.equal(watched.status, 'needs_attention');
    assert.equal(watched.wakeReason, 'needs_attention');
    assert.equal(watched.attentionDetail?.requestId, 'fake-prompt-1');
    assert.equal(watched.attentionDetail?.tool, 'Read');
  } finally {
    delete watchTestHooks.beforeRecheck;
  }
});

test('a transient permission event that Auto auto-resolves does NOT wake needs_attention', async () => {
  const work = path.join(rt, 'watch-transient-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TRANSIENT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'probe.txt'),
        FAKE_CLAUDE_RUN_SECONDS: '1',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 60 });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.wakeReason, 'terminal');
  assert.ok(!('attentionDetail' in v), 'no attentionDetail on an auto-resolved job');
  assert.ok(!('attention' in v), 'no attention hint on an auto-resolved job');
  const st = getStatus(job.jobId);
  assert.equal(st.status, 'succeeded');
  assert.ok(!('attentionDetail' in st), 'status has no attentionDetail on an auto-resolved job');
  const raw = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as { attentionLog?: unknown[] };
  assert.equal(raw.attentionLog, undefined, 'a transient event never creates a persisted attention episode');
});

test('local requestId is generated once, persisted, and stable across watch/status', async () => {
  const work = path.join(rt, 'watch-local-id-work');
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
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  assert.ok(v.attentionDetail, 'structured attention present');
  const id = v.attentionDetail!.requestId;
  assert.ok(id.startsWith('local-'), `expected a local id, got ${id}`);
  assert.equal(v.attentionDetail!.requestIdSource, 'local');
  assert.equal(v.attentionDetail!.tool, 'Edit');

  // status echoes the SAME local id (never regenerated per view).
  const st = getRenderedStatus(job.jobId, { lines: 1, stderrLines: 0 });
  assert.equal(st.status, 'needs_attention');
  assert.equal(st.attentionDetail?.requestId, id);

  // the id is persisted in the job JSON's attentionLog.
  const jobJson = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as {
    attentionLog: Array<{ requestId: string; requestIdSource: string }>;
  };
  const last = jobJson.attentionLog[jobJson.attentionLog.length - 1];
  assert.equal(last.requestId, id);
  assert.equal(last.requestIdSource, 'local');

  await waitForJob(job.jobId, 30);
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup; job is already terminal or needs_attention */
  }
});

test('stderrLines:0 suppresses all raw stderr/meta lines even when stderr content exists', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 30);
  // Sanity: the fixture really wrote stderr/meta (supervisor banners), so the
  // zero case below is meaningful rather than vacuously empty.
  const withErr = getRenderedStatus(job.jobId, { lines: 0, stderrLines: 1 }).progress;
  assert.ok(/\[(meta|stderr)\]/.test(withErr), 'fixture must produce stderr content for the zero case to be meaningful');
  // Regression: JS slice(-0) === slice(0), so stderrLines:0 used to return the
  // WHOLE stderr tail (supervisor metadata / raw banners). It must now return
  // none of it while positive counts keep working.
  const zero = getRenderedStatus(job.jobId, { lines: 0, stderrLines: 0 }).progress;
  assert.ok(!zero.includes('[meta]') && !zero.includes('[stderr]'), 'stderrLines:0 must suppress all stderr/meta lines');
});

test('a generic stderr marker does not downgrade a structured pending attention', async () => {
  const work = path.join(rt, 'watch-stderr-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_STDERR_MARKER: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'probe.txt'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention');
  assert.ok(v.attentionDetail, 'structured attention present');
  assert.equal(v.attentionDetail!.tool, 'Bash', 'structured tool must survive a generic echo');
  assert.equal(v.attentionDetail!.action, 'delete');
  assert.equal(v.attentionDetail!.path, 'probe.txt');
  assert.equal(v.attentionDetail!.risk, 'high');
  await waitForJob(job.jobId, 30);
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('a second distinct upstream requestId is recorded separately, never merged', async () => {
  const work = path.join(rt, 'watch-iso-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_SECOND_ID: 'fake-prompt-2',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  await waitForJob(job.jobId, 30); // returns once needs_attention is published
  assert.equal(getStatus(job.jobId).status, 'needs_attention');
  // Let the second upstream request arrive (~1.2s) and be confirmed (~+0.3s).
  await sleep(2200);
  const jobJson = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as {
    attentionLog: Array<{ requestId: string; tool: string }>;
  };
  const ids = jobJson.attentionLog.map((e) => e.requestId);
  assert.ok(ids.includes('fake-prompt-1'), 'first request id recorded');
  assert.ok(ids.includes('fake-prompt-2'), 'second request id recorded separately');
  assert.equal(ids[ids.length - 1], 'fake-prompt-2', 'latest entry is the second request, not a merged first');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('consecutive local-only permission episodes persist sanitized local summaries, never a generic/unknown block', async () => {
  const work = path.join(rt, 'watch-local-episodes-work');
  fs.mkdirSync(work, { recursive: true });
  const permPath = path.join(work, 'x.ts');
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_NO_ID: '1',
        FAKE_CLAUDE_PERM_SECOND_LOCAL: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: permPath,
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  await waitForJob(job.jobId, 30); // episode 1 confirmed
  assert.equal(getStatus(job.jobId).status, 'needs_attention');
  // Self-recovery at ~1s closes episode 1; episode 2 confirms at ~2.3s. We do
  // NOT require the second episode to have landed: the stable contract holds for
  // whatever legitimate local summary(ies) were persisted.
  await sleep(3200);
  const jobJson = JSON.parse(fs.readFileSync(jobFilePath(job.jobId), 'utf8')) as {
    attentionLog?: Array<{
      requestId: string;
      requestIdSource: string;
      tool: string;
      action: string;
      path: string | null;
      risk: string;
      message: string;
      authorization?: unknown;
    }>;
  };
  const log = jobJson.attentionLog ?? [];
  assert.ok(log.length >= 1, 'at least one legitimate local summary was persisted');
  const serialized = JSON.stringify(log);
  for (const e of log) {
    assert.equal(e.requestIdSource, 'local', 'fixture is local-only: every entry is a local summary, never relabeled');
    assert.ok(
      typeof e.requestId === 'string' && e.requestId.startsWith('local-') && e.requestId.length > 'local-'.length,
      'each entry has a nonempty local-* requestId',
    );
    assert.ok(
      typeof e.tool === 'string' && e.tool.length > 0 && e.tool.length <= 80 && e.tool !== 'unknown',
      'tool is a bounded, non-unknown token (no generic/unknown blocking entry)',
    );
    assert.ok(
      typeof e.action === 'string' && e.action.length > 0 && e.action.length <= 80 && e.action !== 'unknown',
      'action is a bounded, non-unknown token (no generic/unknown blocking entry)',
    );
    assert.ok(
      e.path === null || (typeof e.path === 'string' && e.path.length > 0 && e.path.length <= 160),
      'path is a bounded sanitized form (never the full absolute path)',
    );
    assert.ok(['low', 'medium', 'high', 'unknown'].includes(e.risk), 'risk is a bounded level');
    assert.ok(typeof e.message === 'string' && e.message.length > 0 && e.message.length <= 200, 'message is a bounded hint');
    assert.ok(e.authorization === undefined || e.authorization === false, 'a persisted entry never authorizes');
  }
  // Serialized summaries never carry the full prompt/token/raw path payload.
  assert.ok(!serialized.includes('Do you want to proceed'), 'summaries never leak the raw prompt tail');
  assert.ok(!serialized.includes('Claude needs your permission'), 'summaries never leak the raw prompt');
  assert.ok(!serialized.includes(permPath), 'summaries never leak the full absolute path');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('a brief text banner does not cancel a still-blocked pending attention', async () => {
  const work = path.join(rt, 'watch-banner-work');
  fs.mkdirSync(work, { recursive: true });
  const { job } = startJob(
    fakeParams({
      workFolder: work,
      extraEnv: fakeEnv({
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_BANNER: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Read',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'config.json'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      }),
    }),
  );
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.equal(v.status, 'needs_attention', 'a text banner must not cancel the pending block');
  assert.equal(v.attentionDetail?.tool, 'Read');
  await waitForJob(job.jobId, 30);
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup */
  }
});

test('aborting a watch leaves the job running and a later watch re-attaches', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '2' }) }));
  const ac = new AbortController();
  const p1 = watchJob(job.jobId, { signal: ac.signal, timeoutSeconds: 60 });
  ac.abort();
  const v1 = await p1;
  assert.equal(v1.wakeReason, 'watch_cancelled');
  assert.equal(v1.status, 'watch_cancelled');
  const st = getStatus(job.jobId);
  assert.notEqual(st.status, 'cancelled', 'abort must not cancel the job');
  const v2 = await watchJob(job.jobId, { timeoutSeconds: 60 });
  assert.equal(v2.status, 'succeeded');
});

test('watch timeout leaves the job running to completion', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '10' }) }));
  const v1 = await watchJob(job.jobId, { timeoutSeconds: 1 });
  assert.equal(v1.wakeReason, 'watch_timeout');
  assert.equal(v1.status, 'watch_timeout');
  const st = getStatus(job.jobId);
  assert.notEqual(st.status, 'cancelled', 'watch timeout must not cancel the job');
  const v2 = await watchJob(job.jobId, { timeoutSeconds: 60 });
  assert.equal(v2.status, 'succeeded');
});

test('watch on an already-finished job returns immediately', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 30);
  const t0 = Date.now();
  const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
  assert.ok(Date.now() - t0 < 2000, 'immediate return on a terminal job');
  assert.equal(v.status, 'succeeded');
  assert.equal(v.wakeReason, 'terminal');
});

test('watch on an unknown jobId fails fast', async () => {
  const t0 = Date.now();
  const v = await watchJob('definitely-missing', { timeoutSeconds: 30 });
  assert.ok(Date.now() - t0 < 1000, 'not-found must be fast');
  assert.equal(v.status, 'not_found');
});

test('two simultaneous watches both wake once and leave no listeners', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '1' }) }));
  const p1 = watchJob(job.jobId, { timeoutSeconds: 60 });
  const p2 = watchJob(job.jobId, { timeoutSeconds: 60 });
  const [v1, v2] = await Promise.all([p1, p2]);
  assert.equal(v1.status, 'succeeded');
  assert.equal(v2.status, 'succeeded');
  assert.equal(brokerDiagnostics().subscribers, 0);
  assert.equal(brokerDiagnostics().watcher, false);
});

test('after a reply, watch follows the new reply job', async () => {
  const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  await waitForJob(job.jobId, 30);
  const { job: reply } = replyJob(job.jobId, 'narrow fix');
  const v = await watchJob(reply.jobId, { timeoutSeconds: 60 });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.jobId, reply.jobId);
});

test('watch view exposes workerBackend and replyMode with legacy default behavior', async () => {
  // Explicit harness backend start: workerBackend is present in the watch view.
  // The harness fixture env mirrors protocol.test.ts so the one-shot runner
  // succeeds and the watch view reaches 'succeeded'.
  const fakeDsh = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-deepseek.mjs');
  const harnessEnv = {
    ...fakeEnv(),
    DEEPSEEK_HARNESS_ROOT: path.dirname(fakeDsh),
    DEEPSEEK_HARNESS_RUNNER: fakeDsh,
    DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1',
    FAKE_DSH_RESULT: 'DSH_DONE',
  };
  const { job } = startJob(fakeParams({ workerBackend: 'deepseek-harness', extraEnv: harnessEnv }));
  const v = await watchJob(job.jobId, { timeoutSeconds: 60 });
  assert.equal(v.status, 'succeeded');
  assert.equal(v.workerBackend, 'deepseek-harness', 'watch result carries the explicit backend');
  assert.equal(v.replyMode, null, 'a plain start never went through reply preflight => replyMode null');
  try {
    cancelJob(job.jobId);
  } catch {
    /* best-effort cleanup; already terminal */
  }

  // Legacy default (no workerBackend on the wire): the field is ABSENT from the
  // watch result — not materialized as undefined — while replyMode stays null.
  const { job: job2 } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  const v2 = await watchJob(job2.jobId, { timeoutSeconds: 60 });
  assert.equal(v2.status, 'succeeded');
  assert.equal(v2.workerBackend, undefined, 'legacy default jobs omit workerBackend');
  assert.equal('workerBackend' in v2, false, 'legacy watch result has no workerBackend key at all');
  assert.equal(v2.replyMode, null, 'legacy watch result still carries replyMode:null');
  try {
    cancelJob(job2.jobId);
  } catch {
    /* best-effort cleanup; already terminal */
  }
});
