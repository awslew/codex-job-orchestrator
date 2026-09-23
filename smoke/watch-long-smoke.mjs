// Long fake-worker smoke for claude_code_watch. Run explicitly (NOT part of the
// fast `npm test`):
//   npm run smoke:watch-long
//
// Proves the watch stays suspended across the 300s caller boundary with NO
// model-visible `running` return, then resolves exactly once with succeeded
// after the fake worker finishes (>= 305s). Also checks the shared broker tears
// down its directory watcher / fallback after the last watcher leaves.
//
// Uses the fake claude (test/fake-claude.mjs) so no real proxy is contacted.
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
  let watchPromise = null;

  try {
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`WATCH_LONG_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    }
    fs.mkdirSync(rt, { recursive: true });
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`WATCH_LONG_SMOKE: runtime root failed revalidation ${path.basename(rt)}`);
    }
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.OPEN_LIVE_VIEW = '0';

    const { startJob, watchJob } = await import('../dist/scheduler.js');
    const { brokerDiagnostics } = await import('../dist/job-events.js');
    const { killTree, isAlive } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    killTreeFn = killTree;
    isAliveFn = isAlive;
    queryProcessStartTimeFn = queryProcessStartTime;

    const RUN_SECONDS = 320; // must be > 300s; acceptance requires >= 305s
    const { job } = startJob({
      prompt: 'watch long fake job',
      workFolder: rt,
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_CLAUDE_RUN_SECONDS: String(RUN_SECONDS), FAKE_CLAUDE_EXIT_CODE: '0' },
    });
    console.log(`JOB ${job.jobId} started ${new Date().toISOString()}`);

    const started = Date.now();
    let resolved = null;
    let resolvedAt = 0;
    watchPromise = watchJob(job.jobId, { timeoutSeconds: 900 }).then((v) => {
      resolved = v;
      resolvedAt = Date.now();
      return v;
    });

    // Sample while the job runs. If the watch ever resolves before ~305s, that is a
    // contract violation (it must not return `running` / any intermediate state).
    const SAMPLE_MS = 60_000;
    let t = 0;
    while (t < RUN_SECONDS - 15) {
      if (resolved) {
        throw new Error(`watch returned early at t=${t}s: ${JSON.stringify(resolved)}`);
      }
      await sleep(SAMPLE_MS);
      t = Math.round((Date.now() - started) / 1000);
      console.log(`t=~${t}s watch still suspended (no running returned)`);
    }

    // The 60s sampling step overshoots the loop's 305s floor, and the fake worker
    // legitimately finishes at RUN_SECONDS (~320s), so a resolution at this point
    // is expected. Only flag it as premature when it happened before the 305s
    // acceptance floor (i.e. before the worker has run the required minimum).
    if (resolved && resolvedAt - started < (RUN_SECONDS - 15) * 1000) {
      throw new Error(
        `watch resolved prematurely at ${Math.round((resolvedAt - started) / 1000)}s: ${JSON.stringify(resolved)}`,
      );
    }

    const final = await watchPromise;
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(
      `WATCH resolved status=${final.status} wakeReason=${final.wakeReason} elapsedSeconds=${final.elapsedSeconds} wall=${elapsed}s`,
    );

    const ok =
      final.status === 'succeeded' &&
      final.wakeReason === 'terminal' &&
      final.jobId === job.jobId &&
      (final.elapsedSeconds ?? 0) >= RUN_SECONDS - 10 &&
      elapsed >= 305;

    const diag = brokerDiagnostics();
    console.log(`broker after watch: subscribers=${diag.subscribers} watcher=${diag.watcher} fallback=${diag.fallback}`);
    const clean = diag.subscribers === 0 && diag.watcher === false && diag.fallback === false;

    console.log(ok && clean ? 'WATCH_LONG_OK' : 'WATCH_LONG_FAIL');
    if (!ok || !clean) throw new Error(`watch acceptance failed: ok=${ok} brokerClean=${clean}`);
  } catch (err) {
    failures += 1;
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
  } finally {
    try {
      if (watchPromise) {
        await Promise.race([watchPromise.catch(() => null), sleep(5000)]);
      }
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
      console.warn(`WATCH_LONG_SMOKE: cleanup threw: ${err?.message ?? String(err)}`);
    }
  }

  if (failures === 0 && cleanupSummary.ok) {
    console.log(`WATCH_LONG_SMOKE_CLEANUP_OK rootRemoved=${cleanupSummary.rootRemoved}`);
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(thrownMsg ? `WATCH_LONG_SMOKE_FAIL — ${thrownMsg}${cleanupNote}` : `WATCH_LONG_SMOKE_FAIL${cleanupNote}`);
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
