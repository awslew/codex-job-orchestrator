import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// deepseek-worker contract tests (offline, deterministic).
//
// These test the worker binary directly, exactly the way the supervisor
// launches it (buildCommand: `node deepseek-worker.js --job <id>`, cwd =
// workFolder, env merged with the job's extraEnv, stdio piped). A hard
// wall-clock barrier guards every spawn, so a regression that makes the
// worker linger (Windows conhost pipe handling, missing exit path, ...)
// fails the test instead of hanging the runner.
//
// The full supervisor integration (startJob -> waitForJob) is deliberately
// NOT exercised here: it was found to hang on Windows (worker never emitted
// stream-json and never exited; the supervisor only finalized after its
// 30-minute kill timer). That path stays UNKNOWN until it is root-caused.
// ---------------------------------------------------------------------------

const rt = path.join(os.tmpdir(), `orc-dsh-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0';

const workerEntry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'deepseek-worker.js',
);
assert.ok(fs.existsSync(workerEntry), `worker entry missing; run npm run build:test first: ${workerEntry}`);

// tsc copies TypeScript but not the fixture .mjs; point the child at the
// source fixture exactly as the existing scheduler tests do.
const fakeRunner = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fake-deepseek.mjs',
);
assert.ok(fs.existsSync(fakeRunner), `fake runner missing: ${fakeRunner}`);

function makeJobRecord(extraEnv: Record<string, string>): Record<string, unknown> {
  const jobId = `test-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const now = new Date().toISOString();
  const paths = {
    logPath: path.join(rt, 'logs', `${jobId}.log`),
    stderrLogPath: path.join(rt, 'logs', `${jobId}.stderr.log`),
    reportPath: path.join(rt, 'reports', `${jobId}.txt`),
  };
  for (const p of Object.values(paths)) fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.mkdirSync(path.join(rt, 'jobs'), { recursive: true });
  return {
    jobId,
    sessionId: `session-${jobId}`,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 3000 + (Date.now() % 1000),
    permissionMode: 'default',
    parallelism: '1',
    workFolder: rt,
    maxRuntimeMinutes: 30,
    pid: null,
    supervisorPid: null,
    status: 'running',
    substatus: null,
    startedAt: now,
    endedAt: null,
    lastActivityAt: now,
    exitCode: null,
    ...paths,
    prompt: 'adapter fixture task',
    workerBackend: 'deepseek-harness',
    extraEnv: {
      DEEPSEEK_HARNESS_ROOT: path.dirname(fakeRunner),
      DEEPSEEK_HARNESS_RUNNER: fakeRunner,
      // No bridge env is set, so the bridge stays off and the bare headless
      // profile runs regardless.
      DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1',
      FAKE_DSH_RESULT: 'DSH_DONE',
      ...extraEnv,
    },
  };
}

interface WorkerOutcome {
  code: number | null;
  signal: string | null;
  /** Everything the worker wrote to stdout (the stream-json events). */
  stdout: string;
  /** Everything the worker wrote to stderr (forwarded diagnostics). */
  stderr: string;
}

/**
 * Spawn the worker the way the supervisor does and wait for it with a hard
 * wall-clock barrier. On timeout the child is killed (exact PID) and the
 * outcome reports code=null signal='SIGTERM' so the caller can fail loudly
 * instead of hanging the test runner.
 */
function runWorker(job: Record<string, unknown>, timeoutMs: number): Promise<WorkerOutcome> {
  const jobId = job.jobId as string;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerEntry, '--job', jobId], {
      cwd: rt,
      // The supervisor spawns the worker with the job's extraEnv merged over
      // its own env; the contract test mirrors that exactly (the job record
      // carries DEEPSEEK_HARNESS_DISABLE_BRIDGE=1 so the worker skips the
      // bridge patch and runs the bare headless profile).
      env: { ...process.env, ...(job.extraEnv as Record<string, string>), ORCHESTRATOR_RUNTIME: rt },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGTERM');
        reject(new Error(`worker did not exit within ${timeoutMs}ms (job ${jobId})`));
      });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (err) => settle(() => reject(err)));
    child.once('close', (code, signal) => {
      settle(() => resolve({ code, signal, stdout, stderr }));
    });
  });
}

test('dsh stderr + exit 1 surfaces EXACTLY ONE sanitized result error event (dsh:TURN_ZERO, never the raw message)', async () => {
  const job = makeJobRecord({ FAKE_DSH_TURN_ZERO: '1' });
  const jobId = job.jobId as string;
  fs.writeFileSync(path.join(rt, 'jobs', `${jobId}.json`), JSON.stringify(job), 'utf8');

  const outcome = await runWorker(job, 20_000);

  // Exit code passes through; the harness failure must be attributed to the
  // harness, not to a bare non-zero worker exit.
  assert.equal(outcome.code, 1, `expected exit 1, got ${outcome.code} (stderr: ${outcome.stderr})`);

  // stdout carries exactly ONE stream-json line: the single bounded result
  // error event (the worker's structured failure path emits no assistant
  // echo and no raw harness stderr).
  const lines = outcome.stdout.trim().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 1, `expected exactly 1 stream-json line, got ${lines.length}: ${outcome.stdout}`);

  const event = JSON.parse(lines[0]);
  assert.equal(event.type, 'result');
  assert.equal(event.is_error, true);
  assert.equal(event.result, 'dsh:TURN_ZERO');

  // The raw harness message must never reach the event (or stdout at all);
  // stderr is forwarded as diagnostics only.
  assert.equal(outcome.stdout.includes('no turn completed'), false, 'raw harness message leaked into stdout');
  assert.equal(outcome.stderr.includes('dsh: TURN_ZERO: no turn completed in the run interval'), true);
});

test('worker exit code 0 keeps the normalized success path', async () => {
  const job = makeJobRecord({});
  const jobId = job.jobId as string;
  fs.writeFileSync(path.join(rt, 'jobs', `${jobId}.json`), JSON.stringify(job), 'utf8');

  const outcome = await runWorker(job, 20_000);

  assert.equal(outcome.code, 0, `expected exit 0, got ${outcome.code} (stderr: ${outcome.stderr})`);
  const lines = outcome.stdout.trim().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, `expected 2 stream-json lines, got ${lines.length}: ${outcome.stdout}`);
  const events = lines.map((l) => JSON.parse(l));
  assert.equal(events[0].type, 'assistant');
  assert.equal(events[1].type, 'result');
  assert.equal(events[1].is_error, false);
  assert.equal(events[1].result, 'DSH_DONE');
});

// ---------------------------------------------------------------------------
// Bridge opt-in contract (default off, explicit opt-in, DISABLE wins).
// ---------------------------------------------------------------------------

function makeBridgeRecord(extraEnv: Record<string, string>): Record<string, unknown> {
  // Drops the DISABLE default from makeJobRecord unless the caller explicitly
  // sets it (the opt-in cases must run with the bridge enabled, while the
  // precedence case passes its own DISABLE=1).
  const env = { ...extraEnv, FAKE_DSH_RESULT: 'DSH_DONE' };
  const record = makeJobRecord(env);
  if (!('DEEPSEEK_HARNESS_DISABLE_BRIDGE' in env)) {
    delete (record.extraEnv as Record<string, string>).DEEPSEEK_HARNESS_DISABLE_BRIDGE;
  }
  return record;
}

/**
 * Run a single worker turn in FAKE_DSH_RECORD_PATCH mode and return the
 * recorded `patch=` argument (empty string = --patch was absent).  The fake
 * runner itself is spawned only, never the real harness.
 */
async function recordedPatchArg(job: Record<string, unknown>): Promise<string> {
  const jobId = job.jobId as string;
  fs.writeFileSync(path.join(rt, 'jobs', `${jobId}.json`), JSON.stringify(job), 'utf8');
  const outcome = await runWorker(job, 20_000);
  assert.equal(outcome.code, 0, `expected exit 0, got ${outcome.code} (stderr: ${outcome.stderr})`);
  // The worker wraps the fake's stdout in stream-json events, so the recorded
  // `patch="..."` value arrives as the result event's (JSON-escaped) result.
  const lines = outcome.stdout.trim().split('\n').filter((l) => l.length > 0);
  assert.equal(lines.length, 2, `expected 2 stream-json lines, got ${lines.length}: ${outcome.stdout}`);
  const events = lines.map((l) => JSON.parse(l));
  assert.equal(events[1].type, 'result');
  const recorded = events[1].result as string;
  const match = /^patch=(.*)$/s.exec(recorded);
  assert.ok(match, `fake runner never recorded --patch (stdout: ${outcome.stdout})`);
  return JSON.parse(match[1]) as string;
}

test('bridge is default OFF: a patch file on disk is NOT passed without explicit env', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-dsh-bridge-'));
  const bridge = path.join(root, 'dsh-bridge', 'patch.yml');
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'pipeline: []\n');

  const job = makeBridgeRecord({
    DEEPSEEK_HARNESS_ROOT: root,
    DEEPSEEK_HARNESS_RUNNER: fakeRunner,
    FAKE_DSH_RECORD_PATCH: '1',
  });
  // A patch file exists on disk but the process env never names it, so the
  // harness runs bare (no --patch, no real harness ever started).
  const recorded = await recordedPatchArg(job);
  assert.equal(recorded, '', `expected no --patch, got: ${recorded}`);
});

test('explicit DEEPSEEK_HARNESS_BRIDGE_PATCH is passed as --patch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-dsh-bridge-'));
  const bridge = path.join(root, 'dsh-bridge', 'patch.yml');
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'pipeline: []\n');

  const job = makeBridgeRecord({
    DEEPSEEK_HARNESS_ROOT: root,
    DEEPSEEK_HARNESS_RUNNER: fakeRunner,
    DEEPSEEK_HARNESS_BRIDGE_PATCH: bridge,
    FAKE_DSH_RECORD_PATCH: '1',
  });
  const recorded = await recordedPatchArg(job);
  assert.equal(recorded, bridge, `expected --patch ${bridge}, got: ${recorded}`);
});

test('DEEPSEEK_HARNESS_DISABLE_BRIDGE=1 overrides an explicit BRIDGE_PATCH', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-dsh-bridge-'));
  const bridge = path.join(root, 'dsh-bridge', 'patch.yml');
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'pipeline: []\n');

  const job = makeBridgeRecord({
    DEEPSEEK_HARNESS_ROOT: root,
    DEEPSEEK_HARNESS_RUNNER: fakeRunner,
    DEEPSEEK_HARNESS_BRIDGE_PATCH: bridge,
    DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1',
    FAKE_DSH_RECORD_PATCH: '1',
  });
  const recorded = await recordedPatchArg(job);
  assert.equal(recorded, '', `DISABLE must win over BRIDGE_PATCH, got --patch: ${recorded}`);
});

test('blank DEEPSEEK_HARNESS_BRIDGE_PATCH is treated as absent (no --patch)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-dsh-bridge-'));
  const bridge = path.join(root, 'dsh-bridge', 'patch.yml');
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'pipeline: []\n');

  const job = makeBridgeRecord({
    DEEPSEEK_HARNESS_ROOT: root,
    DEEPSEEK_HARNESS_RUNNER: fakeRunner,
    DEEPSEEK_HARNESS_BRIDGE_PATCH: '   ',
    FAKE_DSH_RECORD_PATCH: '1',
  });
  const recorded = await recordedPatchArg(job);
  assert.equal(recorded, '', `blank BRIDGE_PATCH must be ignored, got --patch: ${recorded}`);
});
