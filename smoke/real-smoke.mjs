// Real routing smoke tests (spend a few real proxy tokens, all low-risk local
// tasks). Runs review (15721+plan, read-only), normal (15721+acceptEdits,
// create+test+cleanup in a temp dir), and auto (15721+auto, no-op). Each must
// finish with status=succeeded and the per-job settings file must show the
// expected routed base URL.
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
      throw new Error(`REAL_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    }
    fs.mkdirSync(rt, { recursive: true });
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`REAL_SMOKE: runtime root failed revalidation ${path.basename(rt)}`);
    }
    process.env.ORCHESTRATOR_RUNTIME = rt;

    const { startJob, getStatus } = await import('../dist/scheduler.js');
    const { settingsFilePath } = await import('../dist/job-store.js');
    const { killTree, isAlive } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    killTreeFn = killTree;
    isAliveFn = isAlive;
    queryProcessStartTimeFn = queryProcessStartTime;

    // This smoke verifies the routed local-port path, so opt into it explicitly.
    // The default contract is "unset = inject no endpoint at all" (a fresh
    // install then inherits the Claude CLI's own credentials), which is right
    // for users but is not what the routing assertions below are checking.
    if (!process.env.ORCHESTRATOR_ANTHROPIC_BASE_URL) {
      process.env.ORCHESTRATOR_ANTHROPIC_BASE_URL = 'local';
      console.log('[real-smoke] ORCHESTRATOR_ANTHROPIC_BASE_URL=local (routing assertions enabled)');
    }

    async function run(name, params, timeoutMs = 480_000) {
      const t0 = Date.now();
      const { job } = startJob(params);
      console.log(`\n=== ${name} ===`);
      console.log(`routing: profile=${job.profile} port=${job.port} permissionMode=${job.permissionMode} parallelism=${job.parallelism}`);
      console.log(`start returned in ${Date.now() - t0}ms (jobId=${job.jobId})`);

      // settings file must be written by the supervisor with the routed port
      const sp = settingsFilePath(job.jobId);
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(sp) && Date.now() < deadline) await sleep(200);
      const base = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')).env?.ANTHROPIC_BASE_URL : 'MISSING';
      console.log(`per-job settings ANTHROPIC_BASE_URL = ${base}`);

      const end = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < end) {
        last = getStatus(job.jobId);
        if (['succeeded', 'failed', 'cancelled', 'needs_attention'].includes(last.status)) break;
        await sleep(5000);
      }
      console.log(`final: status=${last.status} substatus=${last.substatus} exitCode=${last.exitCode} runningSeconds=${last.runningSeconds}`);
      if (last.hasReport) {
        const r = fs.readFileSync(last.reportPath, 'utf8').slice(0, 1200);
        console.log('report excerpt:\n' + r);
      }
      if (last.status !== 'succeeded') throw new Error(`${name}: expected succeeded, got ${last.status}`);
      return { job, base };
    }

    // 1. review: read-only, plan mode on 15721. Must not modify any file.
    const reviewTarget = ROOT; // orchestrator project dir
    const review = await run('REVIEW (15721+plan, read-only)', {
      prompt:
        '只读审查任务：请用中文简短回答——(1) 列出本目录 src 下有哪些 TypeScript 源文件；(2) 指出 package.json 里的依赖名与版本。只读检查，禁止修改、创建或删除任何文件。',
      workFolder: reviewTarget,
      profile: 'review',
    });
    if (!review.base.includes('15721')) throw new Error('review must route to 15721');

    // 2. normal: acceptEdits on 15721; create+test+cleanup a file in a temp dir.
    const normDir = path.join(rt, 'normal-work');
    fs.mkdirSync(normDir, { recursive: true });
    const normal = await run('NORMAL (15721+acceptEdits, create/test/cleanup)', {
      prompt:
        '在临时工作目录中完成小任务：(1) 创建文件 probe.txt 并写入内容 "hello-orchestrator"；(2) 读取该文件并确认内容；(3) 删除该文件。完成后用中文简短回答 DONE 以及每一步的结果。',
      workFolder: normDir,
      profile: 'normal',
    });
    if (!normal.base.includes('15721')) throw new Error('normal must route to 15721');
    const leftover = fs.existsSync(path.join(normDir, 'probe.txt'));
    console.log('probe.txt cleaned up:', !leftover);
    if (leftover) throw new Error('normal smoke: probe.txt was not cleaned up');

    // 3. auto: no-op, low risk, 15721 + permission-mode auto.
    const auto = await run('AUTO (15721+auto, no-op)', {
      prompt: '不要修改、创建或删除任何文件。仅用中文回复一个词：OK。',
      workFolder: rt,
      profile: 'auto',
    });
    if (!auto.base.includes('15721')) throw new Error('auto must route to 15721');

    console.log('\nALL_SMOKES_OK');
    console.log('runtime dir:', rt);
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
      console.warn(`REAL_SMOKE: cleanup threw: ${err?.message ?? String(err)}`);
    }
  }

  if (failures === 0 && cleanupSummary.ok) {
    console.log(`REAL_SMOKE_CLEANUP_OK rootRemoved=${cleanupSummary.rootRemoved}`);
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(thrownMsg ? `REAL_SMOKE_FAIL — ${thrownMsg}${cleanupNote}` : `REAL_SMOKE_FAIL${cleanupNote}`);
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
