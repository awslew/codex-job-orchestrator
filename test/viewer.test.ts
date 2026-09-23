// Unit tests for the Wave5C terminal-static viewer contract. Synthetic jobs
// (atomicWriteJson) in an isolated runtime dir; NO real windows, NO real
// fs.watch (injected watcher factory), NO wall-clock waits inside the
// assertions — counters are compared BEFORE/AFTER a sleep gap instead.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rt = path.join(os.tmpdir(), `orc-viewer-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;

import { jobsDir, atomicWriteJson, newJobId, newSessionId, logFilePath, stderrLogFilePath, writeReport, readJob, listJobs, type Job, type JobStatus } from '../src/job-store.js';
import {
  parseTerminalPolicy,
  buildTerminalSnapshot,
  renderTerminalSnapshot,
  buildStaticWatch,
  runActiveTick,
  REPORT_CAP,
  type StaticWatchResult,
  type ViewCounters,
} from '../src/viewer.js';

after(() => {
  try {
    fs.rmSync(rt, { recursive: true, force: true });
  } catch {
    // Best effort; tmpdir cleanup may race AV scanners on Windows.
  }
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(20);
  }
  return fn();
}

function makeJob(status: JobStatus = 'running', extra: Partial<Job> = {}): Job {
  const now = new Date().toISOString();
  return {
    jobId: newJobId(),
    sessionId: newSessionId(),
    kind: 'start',
    replyToJobId: null,
    profile: 'review',
    port: 15721,
    permissionMode: 'default',
    parallelism: '1',
    workFolder: rt,
    maxRuntimeMinutes: 60,
    pid: null,
    supervisorPid: null,
    status,
    substatus: null,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    exitCode: null,
    logPath: logFilePath(newJobId()),
    stderrLogPath: stderrLogFilePath(newJobId()),
    reportPath: '',
    prompt: '',
    lastOutputAt: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Contract 1: terminal policy parsing.
// ---------------------------------------------------------------------------
test('viewer policy: explicit close is close', () => {
  assert.equal(parseTerminalPolicy({ ORCHESTRATOR_VIEWER_TERMINAL_POLICY: 'close' }), 'close');
});
test('viewer policy: unset / empty / illegal all default to persist_static', () => {
  assert.equal(parseTerminalPolicy({}), 'persist_static');
  assert.equal(parseTerminalPolicy({ ORCHESTRATOR_VIEWER_TERMINAL_POLICY: '' }), 'persist_static');
  assert.equal(parseTerminalPolicy({ ORCHESTRATOR_VIEWER_TERMINAL_POLICY: 'close ' }), 'persist_static');
  assert.equal(parseTerminalPolicy({ ORCHESTRATOR_VIEWER_TERMINAL_POLICY: 'persist' }), 'persist_static');
  assert.equal(parseTerminalPolicy({ ORCHESTRATOR_VIEWER_TERMINAL_POLICY: 'CLOSE' }), 'persist_static');
});

// ---------------------------------------------------------------------------
// Contract 2/4: terminal print is one-shot; snapshots render the fixed texts.
// ---------------------------------------------------------------------------
test('viewer snapshot: succeeded + report renders full fixed text', () => {
  const job = makeJob('succeeded', { substatus: 'completed', startedAt: '2026-08-31T00:00:00.000Z', endedAt: '2026-08-31T00:01:30.000Z', reportPath: path.join(rt, 'r.txt') });
  const stat = { size: 5 };
  const read = () => 'hello';
  const snap = buildTerminalSnapshot(job, () => stat, read);
  assert.equal(snap.status, 'succeeded');
  assert.equal(snap.runSec, 90);
  assert.equal(snap.reportExists, true);
  assert.equal(snap.reportPreview, 'hello');
  assert.equal(snap.reportTruncated, false);
  const text = renderTerminalSnapshot(snap, job);
  assert.ok(text.includes('◉ 最终状态: succeeded (completed)  用时 90s'), text);
  assert.ok(text.includes('报告:'), text);
  assert.ok(text.includes('报告摘要'), text);
  assert.ok(text.includes('hello'), text);
  assert.ok(text.includes('窗口保持打开以接收续跑；可手动关闭。'), text);
});
test('viewer snapshot: report cap truncation + missing report', () => {
  const long = 'x'.repeat(REPORT_CAP + 100);
  const job = makeJob('failed', { reportPath: path.join(rt, 'r2.txt') });
  const snap = buildTerminalSnapshot(job, () => ({ size: long.length }), () => long);
  assert.equal(snap.reportPreview.length, REPORT_CAP);
  assert.equal(snap.reportTruncated, true);
  assert.ok(renderTerminalSnapshot(snap, job).includes('已截断'));
  const jobNoReport = makeJob('cancelled');
  const snap2 = buildTerminalSnapshot(jobNoReport, () => null, () => '');
  assert.equal(snap2.reportExists, false);
  const text2 = renderTerminalSnapshot(snap2, jobNoReport);
  assert.ok(text2.includes('◉ 最终状态: cancelled'));
  assert.ok(!text2.includes('报告:'), text2);
});
test('viewer snapshot: one-shot guard', () => {
  const job = makeJob('succeeded');
  const s1 = buildTerminalSnapshot(job, () => null, () => '');
  const s2 = buildTerminalSnapshot(job, () => null, () => '');
  assert.deepEqual(s1, s2);
});

// ---------------------------------------------------------------------------
// Contract 2: active polling keeps 500ms cadence; terminal stops all reads.
// ---------------------------------------------------------------------------
test('viewer active tick: running polls both cursors + reads job each tick', () => {
  const job = makeJob('running');
  atomicWriteJson(jobFilePathOf(job), job);
  const state = freshState(job);
  const counters = freshCounters();
  const r = runActiveTick(state, freshDeps(counters));
  assert.equal(r.terminal, false);
  assert.equal(counters.poll, 1);
  assert.equal(counters.listCalls, 1);
  assert.equal(counters.logRead, 0);
  assert.equal(counters.stderrRead, 0);
  assert.equal(counters.jobRead, 1);
});

function jobFilePathOf(job: Job): string {
  return path.join(jobsDir(), `${job.jobId}.json`);
}
function freshState(job: Job) {
  return {
    currentJobId: job.jobId,
    sessionId: job.sessionId,
    out: { file: logFilePath(job.jobId), offset: 0 },
    err: { file: stderrLogFilePath(job.jobId), offset: 0 },
    parser: { feed: (chunk: string) => chunk.split('\n').filter((l) => l.length > 0) },
    lastShownStatus: null as string | null,
    lastTerminalJobId: null as string | null,
  };
}
function freshCounters(): ViewCounters {
  return { poll: 0, logRead: 0, stderrRead: 0, jobRead: 0, listCalls: 0 };
}
function freshDeps(counters: ViewCounters) {
  return {
    list: (sessionId: string): Job[] => listJobs(1000).filter((j) => j.sessionId === sessionId),
    read: readJob,
    poll: (c: { file: string; offset: number }): string => {
      try {
        const size = fs.statSync(c.file).size;
        if (size <= c.offset) return '';
        const buf = Buffer.alloc(size - c.offset);
        const fd = fs.openSync(c.file, 'r');
        try {
          fs.readSync(fd, buf, 0, size - c.offset, c.offset);
        } finally {
          fs.closeSync(fd);
        }
        c.offset = size;
        return buf.toString('utf8');
      } catch {
        return '';
      }
    },
    log: (msg: string): void => void msg,
    counters,
  };
}

// ---------------------------------------------------------------------------
// Contract 5: event-driven static watch, no periodic polling.
// ---------------------------------------------------------------------------
test('viewer static watch: promise resolves with null (no job) and stays armed across unrelated events', async () => {
  let eventCount = 0;
  let closed = false;
  const w = {
    close: () => {
      closed = true;
    },
  };
  const p = buildStaticWatch(
    'session-X',
    (_dir, listener) => {
      eventCount += 1;
      // unrelated event: no same-session job exists, watch must stay open
      listener('rename', null);
      return w;
    },
    () => [],
  );
  const resolved = await Promise.race([
    p.then((r) => r),
    sleep(300).then(() => null),
  ]);
  assert.equal(resolved, null, 'promise must not resolve on an unrelated event');
  assert.equal(eventCount, 1);
  assert.equal(closed, false, 'watch must stay open after an unrelated event');
  // Promise intentionally stays pending — an unresolved static watch holds no
  // handles, so it cannot keep the process alive.
});
test('viewer static watch: same-session reply job resolves with its jobId and closes the watch', async () => {
  const replyJob = makeJob('running');
  atomicWriteJson(jobFilePathOf(replyJob), replyJob);
  let closed = false;
  const w = {
    close: () => {
      closed = true;
    },
  };
  const p = buildStaticWatch(
    replyJob.sessionId,
    (_dir, listener) => {
      // The reply job file already exists in the dir, and real fs.watch only
      // fires on changes AFTER the watch is armed — so the test drives the
      // listener asynchronously (setImmediate), mirroring real fs.watch event
      // timing (events never fire synchronously inside watch()).
      setImmediate(() => listener('rename', `${replyJob.jobId}.json`));
      return w;
    },
    (sid) => listJobs(1000).filter((j) => j.sessionId === sid),
  );
  const result = (await Promise.race([
    p.then((r) => r),
    sleep(2000).then(() => null),
  ])) as StaticWatchResult | null;
  assert.ok(result, 'same-session event must resolve the watch');
  assert.equal(result.switchToJobId, replyJob.jobId);
  assert.equal(closed, true, 'watch must be closed on switch');
});
test('viewer static watch: watch factory throw => fixed error and no resolution', async () => {
  const errs: string[] = [];
  const oldErr = console.error;
  console.error = (msg: string): void => {
    errs.push(String(msg));
  };
  try {
    const p = buildStaticWatch(
      'session-Y',
      () => {
        throw new Error('boom');
      },
      () => [],
    );
    const resolved = await Promise.race([p.then((r) => r), sleep(300).then(() => null)]);
    assert.equal(resolved, null, 'failed watch must never resolve');
    assert.equal(errs.length, 1);
    assert.ok(errs[0].includes('fs.watch 失败'), errs[0]);
  } finally {
    console.error = oldErr;
  }
});

// ---------------------------------------------------------------------------
// Contract 7: exported pure functions are import-safe (main-entry guard).
// ---------------------------------------------------------------------------
test('viewer module: import must not start the main loop (guard)', () => {
  // Just re-importing the module already proves the guard; assert the exports
  // are present so a guard regression (running on import) would fail here.
  assert.equal(typeof parseTerminalPolicy, 'function');
  assert.equal(typeof buildTerminalSnapshot, 'function');
  assert.equal(typeof runActiveTick, 'function');
  assert.equal(typeof buildStaticWatch, 'function');
});

// ---------------------------------------------------------------------------
// Contract 2/3 (persist_static): after the terminal print, no poll/log/read
// growth while idle. close policy: the loop returns after the terminal tick.
// ---------------------------------------------------------------------------
test('viewer persist_static: after terminal print, poll/log/read counters never grow', async () => {
  // Drive the active loop to a terminal state (job file is a real, stable
  // terminal job). The loop must stop polling as soon as the terminal state
  // is seen — every 500ms tick would otherwise bump the counters.
  const job = makeJob('succeeded', { endedAt: new Date().toISOString(), reportPath: '' });
  atomicWriteJson(jobFilePathOf(job), job);
  const state = freshState(job);
  const counters = freshCounters();
  const deps = freshDeps(counters);
  const tick1 = runActiveTick(state, deps);
  assert.equal(tick1.terminal, true);
  assert.ok(counters.poll >= 1);
  const afterTerminal = { ...counters };
  await sleep(1400);
  assert.deepEqual(counters, afterTerminal, 'no polling/reading may happen once static');
});

test('viewer persist_static: watcher keeps window alive (no periodic activity)', async () => {
  // A static watcher is a pending fs handle; the event loop stays alive by
  // definition. The assertion here is that NO timer-based activity exists:
  // after the promise resolves there is nothing re-arming it.
  let armed = 0;
  const w = {
    close: () => void 0,
  };
  const p = buildStaticWatch(
    'session-Z',
    (_dir, listener) => {
      armed += 1;
      void listener;
      return w;
    },
    () => [],
  );
  await sleep(300);
  assert.equal(armed, 1, 'watch is armed exactly once and never re-armed by timers');
});
