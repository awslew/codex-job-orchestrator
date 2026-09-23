// Stage 2A response-audit smoke (fake only, no real approval). Verifies that
// replying to a needs_attention job records a sanitized, non-authorizing
// attentionResponseAudit on the NEW reply job, and that status exposes the
// same refined audit. Pure observability: nothing here authorizes anything.
//
// Run after `npm run build`:  node smoke/stage2a-response-audit-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const fake = path.resolve(HERE, '..', 'test', 'fake-claude.mjs');

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
      stillAlivePids: [],
    };
    if (!isSafeRoot()) {
      summary.ok = false;
      summary.reason = 'guard-refused';
      console.warn(`STAGE2A_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
      return summary;
    }
    const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
    summary.recordedCount = candidates.length;
    const recordedPids = [...new Set(candidates.map((candidate) => candidate.pid))];
    if (recordedPids.length > 0 && (typeof isAliveFn !== 'function' || typeof killTreeFn !== 'function')) {
      summary.ok = false;
      summary.reason = 'process-helper-unavailable';
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
        // Empty ancestor evidence keeps evaluatePidCandidate fail-closed.
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
    const stillAlive = await waitForDead(recordedPids, { attempts: 60, stepMs: 250, isAliveFn });
    const sanitizedStillAlivePids = stillAlive.filter((pid) => Number.isInteger(pid) && pid > 0);
    summary.stillAlivePids = sanitizedStillAlivePids;
    summary.stillAliveCount = stillAlive.length;
    if (stillAlive.length > 0) {
      summary.ok = false;
      summary.reason = 'still-alive';
      console.warn(
        `STAGE2A_SMOKE: ${sanitizedStillAlivePids.length} recorded process(es) still alive after bounded wait; pids=${JSON.stringify(sanitizedStillAlivePids)}`,
      );
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
      console.warn(`STAGE2A_SMOKE: cleanup incomplete (${removed.reason})`);
    }
    return summary;
  }

  try {
    if (!isSafeRoot()) throw new Error(`STAGE2A_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    fs.mkdirSync(rt, { recursive: true });
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.ORCHESTRATOR_WORKDIR = path.join(rt, 'work');
    process.env.OPEN_LIVE_VIEW = '0';
    process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '800';

    const { startJob, watchJob, replyJob, getStatus } = await import('../dist/scheduler.js');
    const { isAlive, killTree } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    isAliveFn = isAlive;
    killTreeFn = killTree;
    queryProcessStartTimeFn = queryProcessStartTime;

    const work = path.join(rt, 'work');
    fs.mkdirSync(work, { recursive: true });
    const { job } = startJob({
      prompt: 'stage2a smoke',
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: fake,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_CLAUDE_USER_PROMPT: '1',
        FAKE_CLAUDE_PERM_TOOL: 'Edit',
        FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.ts'),
        FAKE_CLAUDE_RUN_SECONDS: '10',
      },
    });
    console.log(`JOB ${job.jobId} started ${new Date().toISOString()}`);

    const view = await watchJob(job.jobId, { timeoutSeconds: 60 });
    console.log(`watch status=${view.status} wakeReason=${view.wakeReason}`);
    if (view.status !== 'needs_attention') {
      failures += 1;
      console.error('STAGE2A_FAIL: expected needs_attention before reply');
    }

    if (failures === 0) {
      const reply = replyJob(job.jobId, 'narrow fix');
      console.log(`reply job ${reply.job.jobId}`);
      const audit = reply.job.attentionResponseAudit;
      console.log('attentionResponseAudit:', JSON.stringify(audit, null, 2));
      const ok =
        !!audit &&
        audit.kind === 'leader_reply_submitted' &&
        audit.effect === 'resume_requested' &&
        audit.authorization === false &&
        !!audit.attention &&
        audit.attention.tool === 'Edit' &&
        !JSON.stringify(audit).includes('narrow fix') &&
        !JSON.stringify(audit).includes('PROXY_MANAGED');
      if (!ok) {
        failures += 1;
        console.error('STAGE2A_FAIL: audit assertion failed');
      }
      const status = getStatus(reply.job.jobId);
      if (!status.attentionResponseAudit || status.attentionResponseAudit.authorization !== false) {
        failures += 1;
        console.error('STAGE2A_FAIL: status must expose the non-authorizing audit');
      } else {
        console.log('status exposes audit: OK');
      }
    }
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    try {
      cleanupSummary = await cleanup();
    } catch (err) {
      console.warn(`STAGE2A_SMOKE: cleanup threw (${err?.message ?? String(err)})`);
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
        stillAlivePids: [],
      };
    }
  }

  if (failures === 0 && cleanupSummary?.ok) {
    console.log('STAGE2A_OK');
    process.exitCode = 0;
  } else {
    const cleanupNote =
      cleanupSummary?.reason === 'still-alive'
        ? ` (cleanup: still-alive; pids=${JSON.stringify(cleanupSummary.stillAlivePids ?? [])})`
        : cleanupSummary?.reason
          ? ` (cleanup: ${cleanupSummary.reason})`
          : '';
    console.error(
      thrownMsg
        ? `STAGE2A_FAIL — ${thrownMsg}${cleanupNote}`
        : `STAGE2A_FAIL (${failures} assertion(s) failed)${cleanupNote}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
