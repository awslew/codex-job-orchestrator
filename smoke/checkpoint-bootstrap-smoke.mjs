// Stage 6 checkpoint-bootstrap smoke: REAL subprocess contention evidence.
//
// The 214/214 unit + integration tests prove the claims / bootstrap-checkpoint
// primitives with injected clocks and fake inspectors; this smoke adds what they
// cannot: genuine multi-process races and real OS process identity on the
// compiled dist, in an isolated temp runtime that never touches the real
// runtime/logs. It spawns real `node dist/supervisor.js --job <id>` children and
// real independent recovery-client processes, uses the fake claude worker
// (test/fake-claude.mjs), and observes ONLY the ORCHESTRATOR_PROC_SPY_FILE event
// log and normalized job JSON — no raw worker logs are ever read.
//
// Run after `npm run build`:  node smoke/checkpoint-bootstrap-smoke.mjs
//
// Scenarios:
//   A  two real supervisors race one O_EXCL supervisor claim -> exactly 1 worker
//   B  a live-owner supervisor claim blocks a 2nd supervisor (0 workers added)
//   C1 ack-before-spawn cutpoint (job preset + real dead-owner claim) is NOT
//      auto-replayed by recoverJobs (ambiguous_worker, no spawn)
//   C2 a worker_spawned orphan (real supervisor tree force-killed) is NOT
//      auto-replayed (orphan_worker_lost, no new spawn)
//   C3 a dead-owner supervisor claim is taken over by a fresh supervisor exactly
//      once (single worker, job completes)
//   D  two independent recoverJobs processes race one resumable job -> final
//      persisted state monotonic, recover claim owner-released, at most one
//      worker ever spawned
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude.mjs');
const SUPERVISOR_ENTRY = path.join(ROOT, 'dist', 'supervisor.js');

const rt = path.join(os.tmpdir(), `orc-checkpoint-bootstrap-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
const spyFile = path.join(rt, 'proc-spy.jsonl');

// Point everything at the isolated temp runtime BEFORE importing the compiled
// dist modules (config reads ORCHESTRATOR_RUNTIME lazily on every call).
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.ORCHESTRATOR_PROC_SPY_FILE = spyFile;
process.env.OPEN_LIVE_VIEW = '0';
// Recovery never needs the bootstrap grace window here: every resumable job in
// this smoke is meant to be decided immediately.
process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS = '0';
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '1';

const { recoverJobs } = await import('../dist/scheduler.js');
const {
  atomicWriteJson,
  jobFilePath,
  readJob,
  isTerminal,
  newJobId,
  newSessionId,
  logFilePath,
  stderrLogFilePath,
  reportFilePath,
} = await import('../dist/job-store.js');
const { newBootstrap, claimFilePath } = await import('../dist/recovery.js');
const { killTree, isAlive } = await import('../dist/proc.js');
const { ensureRuntimeDirs } = await import('../dist/config.js');

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  ok: ${name}`);
    return;
  }
  failures += 1;
  console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// Child-process helpers: every child gets a strict 25s timeout and its pid is
// tracked so the final `finally` can never leave a stray process behind.
// ---------------------------------------------------------------------------
const trackedPids = new Set();

function runChild(cmd, args, { timeoutMs = 25000, env } = {}) {
  return new Promise((resolve) => {
    const cp = spawn(cmd, args, {
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    trackedPids.add(cp.pid);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        killTree(cp.pid);
      } catch {
        /* best effort */
      }
    }, timeoutMs);
    cp.stdout.on('data', (d) => {
      out += String(d);
    });
    cp.stderr.on('data', (d) => {
      err += String(d);
    });
    cp.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: `${err}${String(e)}` });
    });
    cp.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: out, stderr: err });
    });
  });
}

const runSupervisor = (jobId) => runChild(process.execPath, [SUPERVISOR_ENTRY, '--job', jobId]);

// ---------------------------------------------------------------------------
// Job fixtures: a legal, complete `job_persisted` job that the real supervisor
// can boot (fake claude worker configured per scenario).
// ---------------------------------------------------------------------------
function makeJob({ runSeconds = 2, exitCode = 0 } = {}) {
  const jobId = newJobId();
  const sessionId = newSessionId();
  const startedAt = nowIso();
  return {
    jobId,
    sessionId,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'auto',
    parallelism: '1',
    workFolder: rt,
    maxRuntimeMinutes: 30,
    pid: null,
    supervisorPid: null,
    status: 'queued',
    substatus: null,
    startedAt,
    endedAt: null,
    lastActivityAt: startedAt,
    exitCode: null,
    logPath: logFilePath(jobId),
    stderrLogPath: stderrLogFilePath(jobId),
    reportPath: reportFilePath(jobId),
    prompt: 'stage6 checkpoint-bootstrap smoke',
    claudeCli: FAKE,
    claudePrefix: [process.execPath],
    extraEnv: { FAKE_CLAUDE_RUN_SECONDS: String(runSeconds), FAKE_CLAUDE_EXIT_CODE: String(exitCode) },
    lastOutputAt: startedAt,
    bootstrap: newBootstrap('job_persisted', startedAt),
  };
}

function writeJob(job) {
  ensureRuntimeDirs();
  atomicWriteJson(jobFilePath(job.jobId), job);
  return job;
}

// ---------------------------------------------------------------------------
// Proc-spy readers: the ONLY process-level evidence this smoke consumes.
// ---------------------------------------------------------------------------
function readSpy() {
  try {
    if (!fs.existsSync(spyFile)) return [];
    return fs
      .readFileSync(spyFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// A Claude worker spawn is the fake claude behind a --session-id flag.
function workerSpawnsFor(spy, sessionId) {
  return spy.filter(
    (e) =>
      e.kind === 'background' &&
      e.args &&
      e.args[0] === FAKE &&
      e.args.includes('--session-id') &&
      e.args[e.args.indexOf('--session-id') + 1] === sessionId,
  );
}

// A supervisor spawn recorded from inside a recovery client (dist/scheduler.js
// spawnSupervisor), addressed by --job <jobId>.
function supervisorSpawnsFor(spy, jobId) {
  return spy.filter(
    (e) => e.kind === 'background' && e.args && e.args[0] === SUPERVISOR_ENTRY && e.args[1] === '--job' && e.args[2] === jobId,
  );
}

async function waitForJob(jobId, pred, { timeoutMs = 20000, desc = '' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const j = readJob(jobId);
    if (j && pred(j)) return j;
    await sleep(50);
  }
  return readJob(jobId);
}

// Bounded fixture cleanup wait. Check every 100ms for at most 10s; callers may
// issue one more killTree pass for the remaining pids and then use the same
// helper with a shorter 5s budget.
async function waitForPidsDead(pids, { timeoutMs = 10000, stepMs = 100 } = {}) {
  const alive = new Set((pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0));
  const deadline = Date.now() + timeoutMs;
  while (alive.size > 0) {
    for (const pid of alive) {
      let running = false;
      try {
        running = isAlive(pid);
      } catch {
        // An inability to prove death is conservatively treated as alive.
        running = true;
      }
      if (!running) alive.delete(pid);
    }
    if (alive.size === 0 || Date.now() >= deadline) break;
    await sleep(Math.min(stepMs, Math.max(0, deadline - Date.now())));
  }
  return [...alive];
}

// ---------------------------------------------------------------------------
// Scenario A: two real supervisors race one O_EXCL supervisor claim.
// ---------------------------------------------------------------------------
async function scenarioA() {
  console.log('SCENARIO A: two supervisors race one O_EXCL supervisor claim');
  const job = writeJob(makeJob({ runSeconds: 2, exitCode: 0 }));
  const results = await Promise.all([runSupervisor(job.jobId), runSupervisor(job.jobId)]);
  const terminal = await waitForJob(job.jobId, (j) => isTerminal(j.status), { desc: 'job terminal' });
  const workers = workerSpawnsFor(readSpy(), job.sessionId);

  check('A: both supervisors exited 0', results.every((r) => r.code === 0), `codes=${results.map((r) => r.code).join(',')}`);
  check('A: exactly one Claude worker spawned', workers.length === 1, `workers=${workers.length}`);
  check('A: job succeeded', terminal?.status === 'succeeded', `status=${terminal?.status}`);
  check('A: bootstrap reached worker_spawned', terminal?.bootstrap?.stage === 'worker_spawned', `stage=${terminal?.bootstrap?.stage}`);
  check('A: supervisor claim released after terminal', !fs.existsSync(claimFilePath(job.jobId, 'supervisor')), 'claim still present');
}

// ---------------------------------------------------------------------------
// Scenario B: a live-owner supervisor claim blocks a second supervisor.
// ---------------------------------------------------------------------------
async function scenarioB() {
  console.log('SCENARIO B: live-owner claim blocks a second supervisor');
  const job = writeJob(makeJob({ runSeconds: 30, exitCode: 0 }));
  const s1 = runSupervisor(job.jobId);
  const spawned = await waitForJob(job.jobId, (j) => j.bootstrap?.stage === 'worker_spawned', { desc: 'S1 worker spawned' });
  check('B: first supervisor reached worker_spawned', spawned?.bootstrap?.stage === 'worker_spawned', `stage=${spawned?.bootstrap?.stage}`);

  const s2 = await runSupervisor(job.jobId);
  check('B: second supervisor exited 0 (claim held)', s2.code === 0, `code=${s2.code} stderr=${s2.stderr.slice(-200)}`);
  await sleep(300);
  const workers = workerSpawnsFor(readSpy(), job.sessionId);
  check('B: still exactly one worker (second added none)', workers.length === 1, `workers=${workers.length}`);
  const cur = readJob(job.jobId);
  check('B: job still running under the live owner', cur?.status === 'running', `status=${cur?.status}`);

  // Tear down the live owner + worker tree.
  if (cur?.supervisorPid) killTree(cur.supervisorPid);
  if (cur?.pid) killTree(cur.pid);
  await s1;
}

// ---------------------------------------------------------------------------
// Scenario C1: ack-before-spawn cutpoint is NOT auto-replayed.
//
// A real helper child mirrors the supervisor's exact ack (O_EXCL supervisor
// claim + guarded supervisor_acknowledged write) then dies WITHOUT releasing the
// claim and WITHOUT spawning a worker — the ambiguous window where a worker MAY
// have been spawned. recoverJobs must mark it failed (unacknowledged_worker)
// and never replay it.
// ---------------------------------------------------------------------------
async function scenarioC1() {
  console.log('SCENARIO C1: ack-before-spawn cutpoint is not auto-replayed');
  const job = writeJob(makeJob({ runSeconds: 30, exitCode: 0 }));
  const recoveryUrl = pathToFileURL(path.join(ROOT, 'dist', 'recovery.js')).href;
  const storeUrl = pathToFileURL(path.join(ROOT, 'dist', 'job-store.js')).href;
  const script = `
import crypto from 'node:crypto';
import { acquireClaim, productionInspector } from ${JSON.stringify(recoveryUrl)};
import { updateJobIf, readJob, isTerminal, isValidBootstrap } from ${JSON.stringify(storeUrl)};
const jobId = ${JSON.stringify(job.jobId)};
const acq = acquireClaim({ jobId, kind: 'supervisor', ownerId: crypto.randomUUID(), now: () => Date.now(), leaseMs: 8*3600*1000, inspector: productionInspector() });
if (acq.status !== 'acquired') { process.stdout.write(JSON.stringify({ step: 'claim', status: acq.status })); process.exit(3); }
const j = readJob(jobId);
const acked = updateJobIf(jobId, (c) =>
  !isTerminal(c.status) && c.status !== 'cancelled' &&
  (!isValidBootstrap(c.bootstrap) || c.bootstrap.stage === 'job_persisted'),
  { status: 'running', substatus: null, lastActivityAt: new Date().toISOString(), pid: null, supervisorPid: process.pid,
    bootstrap: { stage: 'supervisor_acknowledged', bootstrapId: j.bootstrap.bootstrapId, updatedAt: new Date().toISOString() } });
if (!acked) { process.stdout.write(JSON.stringify({ step: 'ack', acked: false })); process.exit(4); }
process.stdout.write(JSON.stringify({ step: 'acked', pid: process.pid }));
process.exitCode = 0;
`;
  const h = await runChild(process.execPath, ['--input-type=module', '--eval', script]);
  check('C1: helper acked with a real claim then died', h.code === 0, `code=${h.code} out=${h.stdout.slice(0, 160)}`);

  const rep = recoverJobs();
  const entry = rep.recovered.find((r) => r.startsWith(job.jobId));
  const cur = readJob(job.jobId);
  const workers = workerSpawnsFor(readSpy(), job.sessionId);
  check('C1: recovered entry is failed_unacknowledged_worker', entry?.endsWith(':failed_unacknowledged_worker') === true, `entry=${entry}`);
  check('C1: diagnostics include ambiguous_worker', rep.diagnostics.includes(`${job.jobId}:ambiguous_worker`), JSON.stringify(rep.diagnostics));
  check('C1: job status failed', cur?.status === 'failed', `status=${cur?.status}`);
  check('C1: substatus unacknowledged_worker', cur?.substatus === 'unacknowledged_worker', `substatus=${cur?.substatus}`);
  check('C1: no worker was replayed', workers.length === 0, `workers=${workers.length}`);
  check('C1: no recover claim was created', !fs.existsSync(claimFilePath(job.jobId, 'recover')), 'recover claim present');
}

// ---------------------------------------------------------------------------
// Scenario C2: a worker_spawned orphan is NOT auto-replayed.
// ---------------------------------------------------------------------------
async function scenarioC2() {
  console.log('SCENARIO C2: worker_spawned orphan is not auto-replayed');
  const job = writeJob(makeJob({ runSeconds: 30, exitCode: 0 }));
  const s1 = runSupervisor(job.jobId);
  const spawned = await waitForJob(job.jobId, (j) => j.bootstrap?.stage === 'worker_spawned', { desc: 'worker spawned' });
  check('C2: reached worker_spawned', spawned?.bootstrap?.stage === 'worker_spawned', `stage=${spawned?.bootstrap?.stage}`);

  // Force-kill the supervisor first so it cannot finalize, then the worker tree.
  const cur0 = readJob(job.jobId);
  const supervisorPid = Number.isInteger(cur0?.supervisorPid) && cur0.supervisorPid > 0 ? cur0.supervisorPid : null;
  const workerPid = Number.isInteger(cur0?.pid) && cur0.pid > 0 ? cur0.pid : null;
  if (!supervisorPid || !workerPid) {
    failures += 1;
    console.error(`C2: fixture setup failure — supervisorPid=${supervisorPid ?? 'missing'}, workerPid=${workerPid ?? 'missing'}`);
    return;
  }
  killTree(supervisorPid);
  killTree(workerPid);

  let stillAlive = await waitForPidsDead([supervisorPid, workerPid], { timeoutMs: 10000, stepMs: 100 });
  if (stillAlive.length > 0) {
    for (const pid of stillAlive) killTree(pid);
    stillAlive = await waitForPidsDead(stillAlive, { timeoutMs: 5000, stepMs: 100 });
  }
  if (stillAlive.length > 0) {
    failures += 1;
    console.error(`C2: fixture setup failure — supervisorPid=${supervisorPid}, workerPid=${workerPid}, stillAlive=${stillAlive.join(',')}`);
    return;
  }
  await s1;

  const rep = recoverJobs();
  const entry = rep.recovered.find((r) => r.startsWith(job.jobId));
  const cur = readJob(job.jobId);
  const workers = workerSpawnsFor(readSpy(), job.sessionId);
  check('C2: recovered entry is failed_interrupted', entry?.endsWith(':failed_interrupted') === true, `entry=${entry}`);
  check('C2: diagnostics include orphan_worker_lost', rep.diagnostics.includes(`${job.jobId}:orphan_worker_lost`), JSON.stringify(rep.diagnostics));
  check('C2: job status failed', cur?.status === 'failed', `status=${cur?.status}`);
  check('C2: substatus interrupted (MCP restart)', cur?.substatus === 'interrupted (MCP restart)', `substatus=${cur?.substatus}`);
  check('C2: no worker was replayed', workers.length === 1, `workers=${workers.length}`);
}

// ---------------------------------------------------------------------------
// Scenario C3: a dead-owner supervisor claim is taken over exactly once.
// ---------------------------------------------------------------------------
async function scenarioC3() {
  console.log('SCENARIO C3: dead-owner claim takeover happens at most once');
  const job = writeJob(makeJob({ runSeconds: 2, exitCode: 0 }));
  const recoveryUrl = pathToFileURL(path.join(ROOT, 'dist', 'recovery.js')).href;
  const script = `
import crypto from 'node:crypto';
import { acquireClaim, productionInspector } from ${JSON.stringify(recoveryUrl)};
const jobId = ${JSON.stringify(job.jobId)};
const acq = acquireClaim({ jobId, kind: 'supervisor', ownerId: crypto.randomUUID(), now: () => Date.now(), leaseMs: 8*3600*1000, inspector: productionInspector() });
process.stdout.write(JSON.stringify({ status: acq.status, pid: process.pid }));
process.exitCode = 0;
`;
  const h = await runChild(process.execPath, ['--input-type=module', '--eval', script]);
  const helper = (() => {
    try {
      return JSON.parse(h.stdout);
    } catch {
      return null;
    }
  })();
  check('C3: dead-owner claim left by a real child', helper?.status === 'acquired', `out=${h.stdout.slice(0, 160)}`);
  check('C3: supervisor claim file exists with the dead owner', fs.existsSync(claimFilePath(job.jobId, 'supervisor')), 'no claim file');

  const s2 = await runSupervisor(job.jobId);
  check('C3: takeover supervisor exited 0', s2.code === 0, `code=${s2.code} stderr=${s2.stderr.slice(-200)}`);
  const terminal = await waitForJob(job.jobId, (j) => isTerminal(j.status), { desc: 'job terminal' });
  const workers = workerSpawnsFor(readSpy(), job.sessionId);
  check('C3: exactly one worker spawned', workers.length === 1, `workers=${workers.length}`);
  check('C3: job succeeded after takeover', terminal?.status === 'succeeded', `status=${terminal?.status}`);
  check('C3: claim released after completion', !fs.existsSync(claimFilePath(job.jobId, 'supervisor')), 'claim still present');
}

// ---------------------------------------------------------------------------
// Scenario D: two independent recoverJobs processes race one resumable job.
// ---------------------------------------------------------------------------
async function scenarioD() {
  console.log('SCENARIO D: two independent recoverJobs race one resumable job');
  const job = writeJob(makeJob({ runSeconds: 2, exitCode: 0 }));
  const schedulerUrl = pathToFileURL(path.join(ROOT, 'dist', 'scheduler.js')).href;
  const script = `import { recoverJobs } from ${JSON.stringify(schedulerUrl)}; const r = recoverJobs(); process.stdout.write(JSON.stringify(r)); process.exitCode = 0;`;

  const [c1, c2] = await Promise.all([
    runChild(process.execPath, ['--input-type=module', '--eval', script]),
    runChild(process.execPath, ['--input-type=module', '--eval', script]),
  ]);
  check('D: both recovery clients exited 0', c1.code === 0 && c2.code === 0, `codes=${c1.code},${c2.code}`);
  const rep1 = (() => {
    try {
      return JSON.parse(c1.stdout);
    } catch {
      return null;
    }
  })();
  const rep2 = (() => {
    try {
      return JSON.parse(c2.stdout);
    } catch {
      return null;
    }
  })();
  check('D: both reports parsed', !!rep1 && !!rep2, `c1out=${c1.stdout.slice(0, 200)} c2out=${c2.stdout.slice(0, 200)}`);

  // The O_EXCL recover claim is the single-recoverer arbiter; the supervisor
  // claim is the at-most-once backstop. Depending on the release/ack window a
  // loser MAY briefly acquire and spawn a second supervisor that is then blocked
  // by the live supervisor claim — so supervisor spawns can be 1 or 2, but a
  // Claude worker is NEVER spawned twice. Assert both facts explicitly.
  const spawnedTotal = (rep1?.spawned ?? 0) + (rep2?.spawned ?? 0);
  check('D: at least one client resumed the job', spawnedTotal >= 1, `spawnedTotal=${spawnedTotal}`);
  check('D: never more than two supervisor spawns (claim backstop)', spawnedTotal <= 2, `spawnedTotal=${spawnedTotal}`);

  const terminal = await waitForJob(job.jobId, (j) => isTerminal(j.status), { timeoutMs: 25000, desc: 'D job terminal' });
  // The detached supervisor writes the terminal status, then releases its claim
  // and exits in the same close handler — give it a beat so the "claim gone"
  // assertion observes the post-release state, not the in-flight window.
  const claimGoneDeadline = Date.now() + 5000;
  while (Date.now() < claimGoneDeadline && fs.existsSync(claimFilePath(job.jobId, 'supervisor'))) {
    await sleep(50);
  }
  const spy = readSpy();
  const workers = workerSpawnsFor(spy, job.sessionId);
  const supers = supervisorSpawnsFor(spy, job.jobId);
  check('D: exactly one worker spawned total', workers.length === 1, `workers=${workers.length}`);
  check('D: job succeeded', terminal?.status === 'succeeded', `status=${terminal?.status}`);
  check('D: final bootstrap worker_spawned (monotonic)', terminal?.bootstrap?.stage === 'worker_spawned', `stage=${terminal?.bootstrap?.stage}`);
  check('D: endedAt set (monotonic terminal)', !!terminal?.endedAt, `endedAt=${terminal?.endedAt}`);
  check('D: recover claim owner-released', !fs.existsSync(claimFilePath(job.jobId, 'recover')), 'recover claim present');
  check('D: supervisor claim released after terminal', !fs.existsSync(claimFilePath(job.jobId, 'supervisor')), 'supervisor claim present');
  check('D: supervisor process spawns <= 2', supers.length <= 2, `supers=${supers.length}`);
}

// ---------------------------------------------------------------------------
// Cleanup: kill every tracked child plus any job-recorded detached supervisor /
// worker, then remove ONLY this smoke's temp runtime.
// ---------------------------------------------------------------------------
function cleanup() {
  for (const pid of trackedPids) {
    try {
      killTree(pid);
    } catch {
      /* best effort */
    }
  }
  const jobsDirPath = path.join(rt, 'jobs');
  try {
    if (fs.existsSync(jobsDirPath)) {
      for (const f of fs.readdirSync(jobsDirPath)) {
        if (!f.endsWith('.json') || f.endsWith('.done.json')) continue;
        try {
          const j = JSON.parse(fs.readFileSync(path.join(jobsDirPath, f), 'utf8'));
          if (j.pid) killTree(j.pid);
          if (j.supervisorPid) killTree(j.supervisorPid);
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
  try {
    fs.rmSync(rt, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

try {
  await scenarioA();
  await scenarioB();
  await scenarioC1();
  await scenarioC2();
  await scenarioC3();
  await scenarioD();

  if (failures === 0) {
    console.log('CHECKPOINT_BOOTSTRAP_SMOKE_OK');
    process.exitCode = 0;
  } else {
    console.error(`CHECKPOINT_BOOTSTRAP_SMOKE_FAIL (${failures} assertion(s) failed)`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`CHECKPOINT_BOOTSTRAP_SMOKE_FAIL — ${err && err.stack ? err.stack : String(err)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
