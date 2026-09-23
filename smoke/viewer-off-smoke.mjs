// Viewer-off smoke (ONE real auto job): proves OPEN_LIVE_VIEW=0 disables the
// live-viewer launch on the production scheduler path. No fake worker — the
// supervisor spawns the real `claude` CLI (production default). The job is
// minimal / read-only / deterministic (expected <180s): it reads a fixture
// package.json in an isolated work dir and returns the fixed marker
// VIEWER_OFF_REAL_OK, which must appear in the persisted report / public view.
//
// Viewer-off evidence — production seams ONLY, nothing in production is
// modified, and no unrelated windows / process command lines are enumerated:
//   - shouldOpenLiveView() must be false for this env+platform.
//   - liveViewTestHooks.launch (the scheduler's injectable spawn audit) must
//     never fire: with OPEN_LIVE_VIEW=0, maybeOpenLiveView returns before any
//     launch intent is built. Installing the hook is also a fail-safe: if the
//     gate were ever open, the hook would intercept the launch and the smoke
//     would FAIL instead of opening a real window.
//   - ORCHESTRATOR_PROC_SPY_FILE (proc.ts env-gated spawn audit) must contain
//     no `"kind":"viewer"` line across the whole tree (scheduler + detached
//     supervisor), so no viewer spawn was attempted anywhere in this run.
//   - Residual (honest boundary): whether a GUI window is physically present on
//     the desktop is NOT asserted — window enumeration is explicitly out of
//     scope; the seams above are authoritative for "no launch attempted".
//
// Assertion matrix (one real auto job, asserted on public persisted state):
//   A1 routing    profile=auto permissionMode=auto port=15721 kind=start
//   A2 single job listJobs() returns exactly 1 record in the isolated rt
//   A3 terminal   status=succeeded exitCode=0 substatus=null
//   A4 marker     report exists and contains VIEWER_OFF_REAL_OK
//   A5 no attn    no attentionLog persisted, no needs_attention,
//                 attentionDetail absent from the public view
//   A6 elapsed    runningSeconds < 180 and wall-clock < 180s
//   A7 viewer-off shouldOpenLiveView()=false, launch hook 0 calls, spy 0 viewer
//                 spawn lines
//   A8 read-only  work fixture package.json byte-identical after the job
//
// Isolation/cleanup: fresh exact runtime root `orc-attn-smoke-<ownPid>-<digits>`
// under os.tmpdir() (the attention-smoke root-guard naming is reused so the
// battle-tested isSafeRuntimeRoot / boundedRemoveRuntime guards can be imported
// verbatim), plus one isolated work dir under it. ORCHESTRATOR_RUNTIME and
// OPEN_LIVE_VIEW are set BEFORE any dist import. Cleanup enumerates ONLY this
// run's recorded worker/supervisor pids from rt/jobs, kills only identity-
// verified live pids (fail-closed gate), bounded-waits, then deletes only the
// validated exact rt. Never scans/kills/deletes siblings, the global runtime,
// or old residue.
//
// Run after `npm run build`:  node smoke/viewer-off-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reuse the attention-smoke exported safe helpers. Importing that module has no
// side effects (no temp runtime, no dist import, no env writes), and its
// isSafeRuntimeRoot / boundedRemoveRuntime are the battle-tested exact-root
// guards this run reuses verbatim.
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

// Case-insensitive normalized absolute path (Windows drive letters / separators).
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

const VIEWER_OFF_MARKER = 'VIEWER_OFF_REAL_OK';
// The real worker's task: minimal, read-only, deterministic. It must read the
// fixture package.json in its CWD (the isolated work dir) and emit the marker.
const VIEWER_OFF_PROMPT =
  '只读冒烟任务：用只读方式读取当前工作目录下的 package.json（只读，禁止修改、创建或删除任何文件），' +
  `然后用一行准确输出标记：${VIEWER_OFF_MARKER}。不要附加解释，不要输出其他内容。`;

// True only when this file is the entry point (node smoke/viewer-off-smoke.mjs).
// Importing the module must NOT run the smoke body.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = path.resolve(fileURLToPath(import.meta.url));
    const arg = path.resolve(process.argv[1]);
    return norm(arg) === norm(self);
  } catch {
    return false;
  }
}

async function main() {
  // Identity + isolation capture BEFORE any dist import.
  const runStartedAtMs = Date.now(); // workers can only spawn after this instant
  const ownPid = process.pid;

  // Fresh exact runtime root: a direct child of os.tmpdir(), named with the
  // attention-smoke guard pattern so the imported guard owns it uniquely.
  const rt = path.join(os.tmpdir(), `orc-attn-smoke-${ownPid}-${Date.now()}`);
  const workRoot = path.join(rt, 'work');
  const spyPath = path.join(rt, 'proc-spy.jsonl');

  let failures = 0;
  let thrownMsg = null;
  let cleanupSummary = { ok: false, reason: 'cleanup-not-run' };
  // Process helpers imported inside the try (block-scoped there) are re-exposed
  // through function-scope lets so the cleanup in `finally` can reach them.
  let killTreeFn = null;
  let isAliveFn = null;
  let queryProcessStartTimeFn = null;

  try {
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`VIEWER_OFF_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    }
    fs.mkdirSync(rt, { recursive: true });
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      throw new Error(`VIEWER_OFF_SMOKE: runtime root failed revalidation ${path.basename(rt)}`);
    }

    // One isolated work folder, a direct child of rt (so removing rt removes it).
    if (norm(path.dirname(workRoot)) !== norm(rt)) {
      throw new Error('VIEWER_OFF_SMOKE: workRoot must be a direct child of rt');
    }
    fs.mkdirSync(workRoot, { recursive: true });

    // Import-order isolation: point runtime/work at this run and disable the live
    // viewer BEFORE dynamically importing any dist module, so every runtime path
    // and the viewer gate resolve inside this exact run.
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.ORCHESTRATOR_WORKDIR = workRoot;
    process.env.OPEN_LIVE_VIEW = '0';
    process.env.ORCHESTRATOR_PROC_SPY_FILE = spyPath;

    // Dynamic import AFTER env setup: these dist modules read runtime/config.
    const { startJob, waitForJob, shouldOpenLiveView, liveViewTestHooks } = await import('../dist/scheduler.js');
    const { readJob, listJobs, reportFilePath } = await import('../dist/job-store.js');
    const { killTree, isAlive } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    killTreeFn = killTree;
    isAliveFn = isAlive;
    queryProcessStartTimeFn = queryProcessStartTime;

    function check(name, cond, detail = '') {
      if (cond) {
        console.log(`  ok: ${name}`);
        return;
      }
      failures += 1;
      console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
    }

    // Viewer-off injectable spawn audit: installed BEFORE startJob. Production
    // never sets this; the smoke does, so a launch attempt is observable without
    // opening a window. It must never fire under OPEN_LIVE_VIEW=0.
    const viewerLaunchAttempts = [];
    liveViewTestHooks.launch = (jobId, intent) => {
      viewerLaunchAttempts.push({ jobId, intent });
    };

    // Fixture the real job must read (kept under rt; cleaned up with the root).
    const fixture = JSON.stringify({ name: 'viewer-off-smoke-fixture', version: '1.0.0' }, null, 2) + '\n';
    fs.writeFileSync(path.join(workRoot, 'package.json'), fixture, 'utf8');

    // Exactly ONE real auto job through the production scheduler path. No fake
    // worker (claudeCli is the production default), no reply/review/normal job.
    const t0 = Date.now();
    const { job } = startJob({
      prompt: VIEWER_OFF_PROMPT,
      workFolder: workRoot,
      profile: 'auto',
      parallelism: '1',
      maxRuntimeMinutes: 30,
    });

    // A1 routing / permission mode.
    check('A1: profile auto', job.profile === 'auto', `profile=${job.profile}`);
    check('A1: permissionMode auto', job.permissionMode === 'auto', `permissionMode=${job.permissionMode}`);
    check('A1: port 15721', job.port === 15721, `port=${job.port}`);
    check('A1: kind start (no reply/review/normal)', job.kind === 'start', `kind=${job.kind}`);
    check('A1: parallelism 1', job.parallelism === '1', `parallelism=${job.parallelism}`);

    // Wait for the terminal state (bounded; fails on needs_attention too).
    const view = await waitForJob(job.jobId, 180);
    const wallMs = Date.now() - t0;

    // A3 terminal succeeded + exit 0.
    check('A3: status succeeded', view.status === 'succeeded', `status=${view.status}`);
    check('A3: exitCode 0', view.exitCode === 0, `exitCode=${view.exitCode}`);

    // A2 exactly one job record created in the isolated rt.
    const all = listJobs(1000);
    check('A2: exactly one job record', all.length === 1, `count=${all.length}`);
    check('A2: record is the started job', all[0]?.jobId === job.jobId, `jobId=${all[0]?.jobId}`);

    // A6 elapsed < 180s (public runningSeconds and wall-clock).
    check(
      'A6: runningSeconds < 180',
      view.runningSeconds !== null && view.runningSeconds < 180,
      `runningSeconds=${view.runningSeconds}`,
    );
    check('A6: wall-clock < 180s', wallMs < 180_000, `${wallMs}ms`);

    // A4 marker present in report / public evidence.
    const reportPath = reportFilePath(job.jobId);
    const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
    check('A4: hasReport', view.hasReport === true, `hasReport=${view.hasReport}`);
    check('A4: report contains VIEWER_OFF_REAL_OK', report.includes(VIEWER_OFF_MARKER));

    // A5 no needs_attention / attentionLog.
    const stored = readJob(job.jobId);
    check('A5: stored status succeeded', stored?.status === 'succeeded', `status=${stored?.status}`);
    check('A5: stored exitCode 0', stored?.exitCode === 0, `exitCode=${stored?.exitCode}`);
    check('A5: substatus null', stored?.substatus === null, `substatus=${stored?.substatus}`);
    check(
      'A5: no attentionLog persisted',
      !stored?.attentionLog || stored.attentionLog.length === 0,
      `attentionLog=${stored?.attentionLog?.length}`,
    );
    check('A5: no attentionDetail on public view', view.attentionDetail === undefined);

    // Isolation / read-only: the work fixture must be byte-identical after the
    // job, and the job's workFolder must be the isolated work root.
    const fixtureAfter = fs.existsSync(path.join(workRoot, 'package.json'))
      ? fs.readFileSync(path.join(workRoot, 'package.json'), 'utf8')
      : null;
    check('A8: work fixture unchanged (job read-only)', fixtureAfter === fixture);
    check('A8: job workFolder is the isolated work root', stored?.workFolder === workRoot);

    // A7 viewer-off evidence.
    check('A7: shouldOpenLiveView() false for this env+platform', shouldOpenLiveView() === false);
    check(
      'A7: scheduler launch audit fired 0 times',
      viewerLaunchAttempts.length === 0,
      `calls=${viewerLaunchAttempts.length}`,
    );
    let viewerSpawnLines = 0;
    try {
      const lines = fs.readFileSync(spyPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          if (JSON.parse(line)?.kind === 'viewer') viewerSpawnLines += 1;
        } catch {
          /* unparsable audit line: ignore */
        }
      }
    } catch {
      /* spy file missing => zero viewer spawns recorded */
    }
    check('A7: proc-spy has 0 viewer-kind spawn lines (whole tree)', viewerSpawnLines === 0, `viewer=${viewerSpawnLines}`);

    // Safe evidence summary (counts only; never raw pids / paths / commands /
    // logs / env / keys / report contents).
    console.log(
      `viewer-off evidence: launch-hook-calls=${viewerLaunchAttempts.length} spy-viewer-lines=${viewerSpawnLines}`,
    );
    console.log(
      'viewer-off residual: no GUI window enumeration (out of scope); the seams above are authoritative for no-launch',
    );
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    // Cleanup ALWAYS runs (no process.exit anywhere; exit is set via process.exitCode).
    try {
      cleanupSummary = await cleanup({ killTree: killTreeFn, isAlive: isAliveFn, queryProcessStartTime: queryProcessStartTimeFn });
    } catch (err) {
      console.warn('VIEWER_OFF_SMOKE: cleanup threw');
      cleanupSummary = {
        ok: false,
        reason: 'cleanup-threw',
        rootBasename: path.basename(rt),
        rootRemoved: false,
        recordedCount: 0,
        killedCount: 0,
        skippedCount: 0,
        stillAliveCount: 0,
      };
    }
  }

  const clean = failures === 0 && cleanupSummary.ok;
  if (clean) {
    console.log(
      `VIEWER_OFF_SMOKE_OK recorded=${cleanupSummary.recordedCount} killed=${cleanupSummary.killedCount} skipped=${cleanupSummary.skippedCount} alive=${cleanupSummary.stillAliveCount} rootRemoved=${cleanupSummary.rootRemoved}`,
    );
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(
      thrownMsg
        ? `VIEWER_OFF_SMOKE_FAIL — ${thrownMsg}${cleanupNote}`
        : `VIEWER_OFF_SMOKE_FAIL (${failures} assertion(s) failed)${cleanupNote}`,
    );
    process.exitCode = 1;
  }

  // -------------------------------------------------------------------------
  // Cleanup: enumerate ONLY this run's recorded job/supervisor pids from the
  // validated rt/jobs, apply the fail-closed identity gate, killTree ONLY the
  // identity-verified pids, bounded-wait, then delete ONLY the validated exact
  // rt (the work root is a direct child). Never broad-kills, never scans/deletes
  // siblings or the global runtime. Returns a summary exposing only safe
  // basename/counts — no raw pids, paths, commands, env, or payloads.
  // -------------------------------------------------------------------------
  async function cleanup({ killTree: killTreeFn, isAlive: isAliveFn, queryProcessStartTime: queryStartTimeFn }) {
    const PID_IDENTITY_TOLERANCE_MS = 5000;
    const REMOVE_OPTS = { attempts: 5, retryDelayMs: 250, rmRetries: 3, rmRetryDelayMs: 250 };
    const summary = {
      ok: true,
      reason: null,
      rootBasename: path.basename(rt),
      rootRemoved: false,
      recordedCount: 0,
      killedCount: 0,
      skippedCount: 0,
      stillAliveCount: 0,
    };
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      console.warn(`VIEWER_OFF_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
      summary.ok = false;
      summary.reason = 'guard-refused';
      return summary;
    }

    const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
    summary.recordedCount = candidates.length;

    // Read-only liveness pre-filter: only LIVE candidates need an identity gate.
    const aliveCandidates = candidates.filter((c) => {
      try {
        return isAliveFn(c.pid);
      } catch {
        return false;
      }
    });

    // Fail-closed identity gate over the live candidates (kills only what this
    // run can prove is its own worker/supervisor).
    const verified = new Set();
    if (aliveCandidates.length > 0) {
      let ancestorPids = new Set();
      try {
        ancestorPids = buildAncestorPidSet();
      } catch {
        /* fail closed: an empty ancestor set only skips the ancestor check */
      }
      for (const c of aliveCandidates) {
        const verdict = evaluatePidCandidate(c.pid, {
          ownPid,
          ancestorPids,
          runStartedAtMs,
          osStartTimeFn: queryStartTimeFn,
          clockToleranceMs: PID_IDENTITY_TOLERANCE_MS,
        });
        if (verdict.ok) verified.add(c.pid);
      }
    }
    summary.skippedCount = aliveCandidates.length - verified.size;

    const killList = [...verified];
    for (const p of killList) {
      try {
        killTreeFn(p);
        summary.killedCount += 1;
      } catch {
        /* best effort */
      }
    }
    if (killList.length > 0) {
      await waitForDead(killList, { attempts: 20, stepMs: 250, isAliveFn: isAliveFn });
    }
    const stillAlive = await waitForDead(candidates.map((c) => c.pid), { attempts: 1, stepMs: 0, isAliveFn: isAliveFn });
    summary.stillAliveCount = stillAlive.length;
    if (stillAlive.length > 0) {
      summary.ok = false;
      summary.reason = 'still-alive';
      console.warn(`VIEWER_OFF_SMOKE: ${summary.stillAliveCount} recorded process(es) still alive after bounded wait`);
    }

    const res = await boundedRemoveRuntime(rt, ownPid, os.tmpdir(), ROOT, REMOVE_OPTS);
    summary.rootRemoved = res.ok;
    if (!res.ok) {
      summary.ok = false;
      summary.reason = res.reason;
      console.warn(`VIEWER_OFF_SMOKE: cleanup incomplete for ${summary.rootBasename} (${res.reason})`);
    }
    return summary;
  }
}

if (isMainModule()) {
  await main();
}
