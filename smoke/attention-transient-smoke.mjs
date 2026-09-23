// Local fake-permission smoke for the real-world transient fix (Stage 1):
// Auto mode can emit a permission/control signal and then auto-allow and
// continue. Such a transient event must NOT wake the leader with
// needs_attention — the job must run to succeeded with no attentionDetail.
//
// Uses the fake claude (test/fake-claude.mjs) in TRANSIENT mode so no real
// proxy is contacted.
//
// Run after `npm run build`:  node smoke/attention-transient-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// These helpers are side-effect free when imported. They provide the same
// fail-closed PID identity and exact-root guards used by attention-smoke.
import {
  boundedRemoveRuntime,
  buildAncestorPidSet,
  collectRecordedPidCandidates,
  evaluatePidCandidate,
  isSafeRuntimeRoot,
  waitForDead,
} from './attention-smoke.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return norm(path.resolve(process.argv[1])) === norm(path.resolve(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

async function main() {
  const ownPid = process.pid;
  const runStartedAtMs = Date.now();
  const rt = path.join(os.tmpdir(), `orc-attn-smoke-${ownPid}-${Date.now()}`);
  const isSafeRoot = () => isSafeRuntimeRoot(rt, ownPid, os.tmpdir(), ROOT);
  const fake = path.join(ROOT, 'test', 'fake-claude.mjs');

  let failures = 0;
  let thrownMsg = null;
  let cleanupSummary = null;
  let killTreeFn = null;
  let isAliveFn = null;
  let queryProcessStartTimeFn = null;

  async function cleanup() {
    const summary = {
      ok: true,
      reason: null,
      rootBasename: path.basename(rt),
      rootRemoved: false,
      recordedCount: 0,
      verifiedCount: 0,
      skippedCount: 0,
      deadCount: 0,
      killedCount: 0,
      stillAliveCount: 0,
    };
    if (!isSafeRoot()) {
      summary.ok = false;
      summary.reason = 'guard-refused';
      console.warn(`ATTENTION_TRANSIENT_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
      return summary;
    }

    const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
    summary.recordedCount = candidates.length;
    const recordedPids = [...new Set(candidates.map((candidate) => candidate.pid))];
    if (recordedPids.length > 0 && typeof isAliveFn !== 'function') {
      summary.ok = false;
      summary.reason = 'liveness-unavailable';
      return summary;
    }

    const aliveCandidates = candidates.filter((candidate) => {
      try {
        return isAliveFn(candidate.pid);
      } catch {
        return false;
      }
    });
    summary.deadCount = candidates.length - aliveCandidates.length;

    let ancestorPids = new Set();
    if (aliveCandidates.length > 0) {
      try {
        ancestorPids = buildAncestorPidSet();
      } catch {
        // An unavailable ancestor chain is treated as an empty chain; the
        // remaining identity checks still fail closed.
      }
    }
    const verifiedPids = new Set();
    for (const candidate of aliveCandidates) {
      const verdict = evaluatePidCandidate(candidate.pid, {
        ownPid,
        ancestorPids,
        runStartedAtMs,
        osStartTimeFn: queryProcessStartTimeFn,
        clockToleranceMs: 5000,
      });
      if (verdict.ok) verifiedPids.add(candidate.pid);
      else summary.skippedCount += 1;
    }
    summary.verifiedCount = verifiedPids.size;

    let killFailed = false;
    for (const pid of verifiedPids) {
      try {
        killTreeFn(pid);
        summary.killedCount += 1;
      } catch {
        killFailed = true;
      }
    }

    const stillAlive = await waitForDead(recordedPids, {
      attempts: 20,
      stepMs: 250,
      isAliveFn,
    });
    summary.stillAliveCount = stillAlive.length;
    if (stillAlive.length > 0) {
      summary.ok = false;
      summary.reason = 'still-alive';
      console.warn(`ATTENTION_TRANSIENT_SMOKE: ${stillAlive.length} recorded process(es) still alive after bounded wait`);
      return summary;
    }
    if (killFailed) {
      summary.ok = false;
      summary.reason = 'kill-failed';
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
      console.warn(`ATTENTION_TRANSIENT_SMOKE: cleanup incomplete (${removed.reason})`);
    }
    return summary;
  }

  try {
    if (!isSafeRoot()) throw new Error(`ATTENTION_TRANSIENT_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    fs.mkdirSync(rt, { recursive: true });
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.ORCHESTRATOR_WORKDIR = path.join(rt, 'work');
    process.env.OPEN_LIVE_VIEW = '0';
    process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '800';

    const { startJob, watchJob, getRenderedStatus } = await import('../dist/scheduler.js');
    const work = path.join(rt, 'work');
    fs.mkdirSync(work, { recursive: true });
    const permPath = path.join(work, 'probe.txt');
    const { killTree, isAlive } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    killTreeFn = killTree;
    isAliveFn = isAlive;
    queryProcessStartTimeFn = queryProcessStartTime;

    const { job } = startJob({
      prompt: 'attention transient smoke',
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: fake,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TRANSIENT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Bash',
        FAKE_CLAUDE_PERM_PATH: permPath,
        FAKE_CLAUDE_RUN_SECONDS: '1',
      },
    });
    console.log(`JOB ${job.jobId} started ${new Date().toISOString()}`);

    const view = await watchJob(job.jobId, { timeoutSeconds: 60 });
    console.log(`watch status=${view.status} wakeReason=${view.wakeReason}`);
    const ok =
      view.status === 'succeeded' &&
      view.wakeReason === 'terminal' &&
      !('attentionDetail' in view) &&
      !('attention' in view) &&
      !JSON.stringify(view).includes('needs_attention');
    if (!ok) {
      failures += 1;
      console.error('ATTENTION_TRANSIENT_FAIL: transient permission must not wake needs_attention');
    }

    const status = getRenderedStatus(job.jobId, { lines: 3, stderrLines: 1 });
    console.log(`final status=${status.status} attentionDetail=${status.attentionDetail ? 'PRESENT' : 'absent'}`);
    if (status.status !== 'succeeded' || status.attentionDetail) {
      failures += 1;
      console.error('ATTENTION_TRANSIENT_FAIL: final state must be succeeded with no attentionDetail');
    }
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    try {
      cleanupSummary = await cleanup();
    } catch (err) {
      console.warn(`ATTENTION_TRANSIENT_SMOKE: cleanup threw (${err?.message ?? String(err)})`);
      cleanupSummary = {
        ok: false,
        reason: 'cleanup-threw',
        rootBasename: path.basename(rt),
        rootRemoved: false,
        recordedCount: 0,
        verifiedCount: 0,
        skippedCount: 0,
        deadCount: 0,
        killedCount: 0,
        stillAliveCount: 0,
      };
    }
  }

  if (failures === 0 && cleanupSummary?.ok) {
    console.log('ATTENTION_TRANSIENT_OK');
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary?.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(
      thrownMsg
        ? `ATTENTION_TRANSIENT_FAIL — ${thrownMsg}${cleanupNote}`
        : `ATTENTION_TRANSIENT_FAIL (${failures} assertion(s) failed)${cleanupNote}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
