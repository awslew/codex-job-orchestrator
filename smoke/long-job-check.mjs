// Proves a job stays queryable well past the 300s Codex tool boundary using the
// fake claude (no real tokens). Runs ~5.5 minutes. Polls status at intervals
// and prints samples; the job must still be running at t>=300s and succeed at
// the end. This is the "long task does not get lost" acceptance check.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSafeRuntimeRoot,
  collectRecordedPidCandidates,
  buildAncestorPidSet,
  evaluatePidCandidate,
  waitForDead,
  boundedRemoveRuntime,
} from './attention-smoke.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = path.resolve(fileURLToPath(import.meta.url));
    return norm(path.resolve(process.argv[1])) === norm(self);
  } catch {
    return false;
  }
}

async function main() {
  const runStartedAtMs = Date.now();
  const ownPid = process.pid;
  const rt = path.join(os.tmpdir(), `orc-attn-smoke-${ownPid}-${Date.now()}`);
  let failures = 0;
  let thrownMsg = null;
  let cleanupSummary = { ok: false, reason: 'cleanup-not-run' };
  let killTreeFn = null;
  let isAliveFn = null;
  let queryProcessStartTimeFn = null;

  try {
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`LONG_JOB_CHECK: refused unsafe runtime root ${path.basename(rt)}`);
    }
    fs.mkdirSync(rt, { recursive: true });
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`LONG_JOB_CHECK: runtime root failed revalidation ${path.basename(rt)}`);
    }
    process.env.ORCHESTRATOR_RUNTIME = rt;

    const { startJob, getStatus, waitForJob } = await import('../dist/scheduler.js');
    const { killTree, isAlive } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    killTreeFn = killTree;
    isAliveFn = isAlive;
    queryProcessStartTimeFn = queryProcessStartTime;

    const { job } = startJob({
      prompt: 'long fake job',
      workFolder: rt,
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_CLAUDE_RUN_SECONDS: '320', FAKE_CLAUDE_EXIT_CODE: '0' },
    });
    console.log(`JOB ${job.jobId} started ${new Date().toISOString()}`);

    let t = 0;
    while (true) {
      const st = getStatus(job.jobId);
      console.log(`t=~${t}s status=${st.status} runningSeconds=${st.runningSeconds} substatus=${st.substatus}`);
      if (['succeeded', 'failed', 'cancelled'].includes(st.status)) break;
      await sleep(60_000);
      t += 60;
      if (t > 400) {
        console.log('took too long; aborting check');
        break;
      }
    }
    const final = await waitForJob(job.jobId, 60);
    console.log(`FINAL status=${final.status} runningSeconds=${final.runningSeconds} reportExists=${final.hasReport}`);
    const ok = final.status === 'succeeded' && (final.runningSeconds ?? 0) > 300;
    console.log(ok ? 'LONG_OK' : 'LONG_FAIL');
    if (!ok) throw new Error(`long job acceptance failed: status=${final.status} runningSeconds=${final.runningSeconds}`);
  } catch (err) {
    failures += 1;
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
  } finally {
    try {
      cleanupSummary = await cleanupRun({
        rt,
        ownPid,
        runStartedAtMs,
        killTree: killTreeFn,
        isAlive: isAliveFn,
        queryProcessStartTime: queryProcessStartTimeFn,
      });
    } catch (err) {
      failures += 1;
      cleanupSummary = { ok: false, reason: 'cleanup-threw' };
      console.warn(`LONG_JOB_CHECK: cleanup threw: ${err?.message ?? String(err)}`);
    }
  }

  if (failures === 0 && cleanupSummary.ok) {
    console.log(`LONG_JOB_CHECK_CLEANUP_OK rootRemoved=${cleanupSummary.rootRemoved}`);
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(thrownMsg ? `LONG_JOB_CHECK_FAIL — ${thrownMsg}${cleanupNote}` : `LONG_JOB_CHECK_FAIL${cleanupNote}`);
    process.exitCode = 1;
  }
}

async function cleanupRun({ rt, ownPid, runStartedAtMs, killTree: killTreeFn, isAlive: isAliveFn, queryProcessStartTime: queryStartTimeFn }) {
  const summary = { ok: true, reason: null, rootRemoved: false, recordedCount: 0, killedCount: 0, skippedCount: 0, stillAliveCount: 0 };
  const isAliveSafe = isAliveFn ?? ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  });
  if (!isSafeRuntimeRoot(rt, ownPid)) {
    summary.ok = false;
    summary.reason = 'guard-refused';
    return summary;
  }

  const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
  summary.recordedCount = candidates.length;
  const aliveCandidates = candidates.filter((candidate) => {
    try {
      return isAliveSafe(candidate.pid);
    } catch {
      return false;
    }
  });
  const verified = new Set();
  if (aliveCandidates.length > 0 && typeof killTreeFn === 'function' && typeof queryStartTimeFn === 'function') {
    let ancestorPids = new Set();
    try {
      ancestorPids = buildAncestorPidSet();
    } catch {
      /* identity gate remains fail-closed */
    }
    for (const candidate of aliveCandidates) {
      const verdict = evaluatePidCandidate(candidate.pid, {
        ownPid,
        ancestorPids,
        runStartedAtMs,
        osStartTimeFn: queryStartTimeFn,
        clockToleranceMs: 5000,
      });
      if (verdict.ok) verified.add(candidate.pid);
    }
  }
  summary.skippedCount = aliveCandidates.length - verified.size;
  if (aliveCandidates.length > 0 && verified.size === 0) {
    summary.ok = false;
    summary.reason = 'unverified-live-process';
  }
  for (const pid of verified) {
    try {
      killTreeFn(pid);
      summary.killedCount += 1;
    } catch {
      /* bounded liveness check below reports any process that remains */
    }
  }
  const stillAlive = await waitForDead(candidates.map((candidate) => candidate.pid), {
    attempts: 20,
    stepMs: 250,
    isAliveFn: isAliveSafe,
  });
  summary.stillAliveCount = stillAlive.length;
  if (stillAlive.length > 0) {
    summary.ok = false;
    summary.reason = 'still-alive';
  }
  const removed = await boundedRemoveRuntime(rt, ownPid, os.tmpdir(), ROOT, {
    attempts: 5,
    retryDelayMs: 250,
    rmRetries: 3,
    rmRetryDelayMs: 250,
  });
  summary.rootRemoved = removed.ok;
  if (!removed.ok) {
    summary.ok = false;
    summary.reason = removed.reason;
  }
  return summary;
}

if (isMainModule()) {
  await main();
}
