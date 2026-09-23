// Wave 2C / Gate 1: T2C2 budget enforcement + T2C metrics, end-to-end through a
// real detached supervisor, with the fake worker driving the REAL injected
// PreToolUse budget hook (never fabricating job JSON). All assertions read
// real on-disk artifacts (job record, evidence report, settings hook, hook
// stdout sidecar, budget config/state) plus the public views.
//
// Contract flags are set in this file's preamble (not the runtime) because the
// scheduler reads them at startJob call time and the detached supervisor reads
// them in ITS OWN process at run time; setting them on process.env covers both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const rt = path.join(os.tmpdir(), `orc-budget-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0';
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';
// Wave 2C gates under test.
process.env.ORCHESTRATOR_CONTRACT_V2 = '1';
process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT = '1';
process.env.ORCHESTRATOR_METRICS_V2 = '1';

import {
  startJob,
  getStatus,
  waitForJob,
  listJobsView,
} from '../src/scheduler.js';
import {
  atomicWriteJson,
  jobFilePath,
  doneFilePath,
  settingsFilePath,
  logFilePath,
  stderrLogFilePath,
  reportFilePath,
  type Job,
} from '../src/job-store.js';
import type { StartParams } from '../src/router.js';
import type { TaskContractV2 } from '../src/contracts-v2.js';

const FAKE_CLAUDE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fake-claude.mjs',
);
const REPORT = path.join(rt, 'evidence-report.md');

function fakeParams(over: Partial<StartParams> & { extraEnv?: Record<string, string> } = {}): StartParams {
  return {
    prompt: 'fake task',
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function validContract(over: Partial<TaskContractV2> = {}): TaskContractV2 {
  return {
    schemaVersion: 2,
    scope: { readGlobs: [], writeFiles: [], forbiddenGlobs: [] },
    writePolicy: 'workspace_legacy',
    budget: {
      maxRuntimeMinutes: 120,
      reportOnlyAfterMinutes: 120,
      maxBashCommands: 1,
      maxToolCalls: 3,
      maxSourceLines: 1000,
      maxFilesRead: 20,
      onExceeded: 'report_partial',
    },
    acceptance: [],
    reporting: { deliverablePath: REPORT },
    admission: { resourceClass: 'light', priority: 0 },
    ...over,
  } as TaskContractV2;
}

async function waitForFile(p: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) return;
    await sleep(100);
  }
  throw new Error(`file did not appear: ${p}`);
}

async function waitForFinalized(jobId: string, timeoutMs = 20000): Promise<ReturnType<typeof getStatus>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = getStatus(jobId);
    if (s.endedAt) return s;
    await sleep(300);
  }
  throw new Error(`job not finalized: ${jobId}`);
}

// Raw on-disk job record (readJob is internal to job-store; parse the file).
function readJobRaw(jobId: string): Job {
  const p = doneFilePath(jobId);
  const raw = JSON.parse(fs.readFileSync(fs.existsSync(p) ? p : jobFilePath(jobId), 'utf8')) as unknown;
  return raw as Job;
}

// A single job's report (evidence-report-v1 YAML front matter + body).
function readReport(jobId: string): string {
  return fs.readFileSync(reportFilePath(jobId), 'utf8');
}

test('A: maxBashCommands=1 — 2nd Bash denied by real hook, failed/budget_violation, partial report', async () => {
  const { job } = startJob(
    fakeParams({
      extraEnv: fakeEnv({
        FAKE_CLAUDE_BUDGET_SIM: 'two_bash',
        FAKE_CLAUDE_ASSERT_REPORT_SKELETON: '1',
      }),
      contract: validContract(),
    }),
  );
  await waitForFile(settingsFilePath(job.jobId));

  // B (same job): the worker saw the skeleton BEFORE any output; the
  // report-first metric is latched by the supervisor's skeleton write.
  const settings = JSON.parse(fs.readFileSync(settingsFilePath(job.jobId), 'utf8'));
  const hook = settings.hooks?.PreToolUse?.[0]?.hooks?.[0];
  assert.ok(hook, 'injected PreToolUse budget hook present in settings');
  assert.equal(hook.type, 'command');
  assert.match(hook.command, /budget-hook\.js/);

  const final = await waitForFinalized(job.jobId);
  assert.equal(final.status, 'failed');
  assert.equal(final.substatus, 'budget_violation');
  assert.equal(final.budgetViolation, 'bash_commands_exceeded');
  assert.equal(final.budgetStatus, 'failed');
  assert.equal(final.exitCode, 0, 'worker exited 0; budget verdict overrides the outcome');
  assert.equal(final.hasReport, true);
  assert.equal(final.reportCompleteness, 'partial');

  // Report on disk: skeleton was replaced in place by the partial rewrite
  // (completeness 'partial'), with a real body and no evidenceCount inflation.
  const report = readReport(job.jobId);
  assert.match(report, /^schema: evidence-report-v1$/m);
  assert.match(report, /^jobId: /m);
  assert.match(report, /^completeness: partial$/m);
  assert.match(report, /^evidenceCount: 0$/m);
  assert.ok(!/^completeness: skeleton$/m.test(report), 'skeleton completeness replaced');
  assert.match(report, /DONE/, 'report body carries the worker final text');

  // The hook sidecar proves the fake drove the REAL hook: first allow, second
  // deny with the exact fixed deny reason (never the raw command text).
  const sim = JSON.parse(
    fs.readFileSync(path.join(rt, 'settings', `${job.jobId}.budget-hook-sim.json`), 'utf8'),
  ) as { calls: string[]; denyReason: string };
  assert.equal(sim.calls.length, 2);
  assert.equal(sim.calls[0], '', 'first Bash call allowed (empty stdout)');
  assert.match(sim.denyReason, /^denied by job budget hook: budget_denied:bash_commands_exceeded$/);

  // Budget state on disk: report_only with the recorded violation.
  const state = JSON.parse(
    fs.readFileSync(path.join(rt, 'settings', `${job.jobId}.budget-state.json`), 'utf8'),
  ) as { budgetState: { mode: string; violationCode: string } };
  assert.equal(state.budgetState.mode, 'report_only');
  assert.equal(state.budgetState.violationCode, 'bash_commands_exceeded');

  // Public views expose the compact budget mirror (C) — status AND list.
  const listed = listJobsView().find((j) => j.jobId === job.jobId);
  assert.ok(listed, 'job present in listJobsView');
  assert.equal(listed.budgetStatus, 'failed');
  assert.equal(listed.budgetViolation, 'bash_commands_exceeded');
  assert.equal(listed.reportCompleteness, 'partial');
  assert.ok(listed.metrics, 'compact metrics present in list view');
  assert.equal(typeof listed.metrics!.reportFirstWriteMs, 'number');

  // C on the status view too.
  assert.equal(final.budgetStatus, listed.budgetStatus);
  assert.equal(final.budgetViolation, listed.budgetViolation);
  assert.equal(final.reportCompleteness, listed.reportCompleteness);
  assert.deepEqual(final.metrics, listed.metrics);

  // The hook must NOT be invoked by the supervisor's own machinery (that is
  // the worker's job): a successful fake worker leaves NO hook denial in its
  // stdout/stderr logs, and no permission events.
  const stdout = fs.readFileSync(logFilePath(job.jobId), 'utf8');
  const stderr = fs.readFileSync(stderrLogFilePath(job.jobId), 'utf8');
  assert.ok(!stdout.includes('budget_denied'), 'stdout log must stay pure stream-json');
  assert.ok(!stderr.includes('budget_denied'), 'no hook denial in worker stderr');
});

test('D: public views never expose prompt/env values/full commands/absolute paths; report is fixed front matter only', async () => {
  const { job } = startJob(
    fakeParams({
      extraEnv: fakeEnv({ FAKE_CLAUDE_BUDGET_SIM: 'two_bash' }),
      contract: validContract(),
    }),
  );
  const final = await waitForFinalized(job.jobId);
  assert.equal(final.status, 'failed');
  const listed = listJobsView().find((j) => j.jobId === job.jobId);
  assert.ok(listed);

  const serialized = JSON.stringify({ status: final, listed });
  assert.ok(!serialized.includes('fake task'), 'no prompt in public views');
  assert.ok(!serialized.includes('sim call one') && !serialized.includes('sim call two'), 'no hook command text in public views');
  assert.ok(!serialized.includes('PROXY_MANAGED'), 'no auth token in public views');
  assert.ok(!serialized.includes('budget-config.json'), 'no absolute budget config path in public views');
  assert.ok(!serialized.includes('budget-state.json'), 'no absolute budget state path in public views');
  assert.ok(!serialized.includes(`${rt}${path.sep}settings`), 'no absolute settings path in public views');

  // The evidence report contains only fixed front matter + the worker's own
  // final text — never the hook commands (which exist only in the fake's
  // sidecar and the hook's stdin), the prompt, or the settings paths.
  const report = readReport(job.jobId);
  assert.ok(!report.includes('sim call one') && !report.includes('sim call two'), 'report never contains command text');
  assert.ok(!report.includes('fake task'), 'report never contains the prompt');
  assert.ok(!report.includes(rt), 'report never contains absolute runtime paths');
  assert.ok(!report.includes('budget-hook'), 'report never references the hook');
});

test('E: flags off — legacy path keeps budgetStatus=not_requested and metrics=null', async () => {
  // Wave 2C env discipline: snapshot/restore in finally. The scheduler reads
  // the flags at startJob; the detached supervisor reads them in its own
  // process, so the mutation here is confined to this job's supervisor.
  const saved = {
    contract: process.env.ORCHESTRATOR_CONTRACT_V2,
    budget: process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT,
    metrics: process.env.ORCHESTRATOR_METRICS_V2,
  };
  try {
    delete process.env.ORCHESTRATOR_CONTRACT_V2;
    delete process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT;
    delete process.env.ORCHESTRATOR_METRICS_V2;
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
    const final = await waitForJob(job.jobId, 60);
    assert.equal(final.status, 'succeeded');
    assert.equal(final.budgetStatus, 'not_requested');
    assert.equal(final.budgetViolation, null);
    assert.equal(final.reportCompleteness, null);
    assert.equal(final.metrics, null);
    assert.ok(!fs.existsSync(path.join(rt, 'settings', `${job.jobId}.budget-config.json`)), 'no budget config written');
    assert.ok(!fs.existsSync(path.join(rt, 'settings', `${job.jobId}.budget-state.json`)), 'no budget state written');
    // The evidence report path exists only when a report was written (legacy
    // writes the plain report at the same path) — legacy still writes it.
    assert.ok(fs.existsSync(reportFilePath(job.jobId)), 'legacy report still written');
  } finally {
    if (saved.contract === undefined) delete process.env.ORCHESTRATOR_CONTRACT_V2;
    else process.env.ORCHESTRATOR_CONTRACT_V2 = saved.contract;
    if (saved.budget === undefined) delete process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT;
    else process.env.ORCHESTRATOR_BUDGET_ENFORCEMENT = saved.budget;
    if (saved.metrics === undefined) delete process.env.ORCHESTRATOR_METRICS_V2;
    else process.env.ORCHESTRATOR_METRICS_V2 = saved.metrics;
  }
});

test('F: runtime overrun — backdated config drives real hook deny (report_only_window), partial report, no real waiting', async () => {
  const { job } = startJob(
    fakeParams({
      extraEnv: fakeEnv({ FAKE_CLAUDE_BUDGET_SIM: 'runtime_overrun' }),
      contract: validContract({ budget: { maxRuntimeMinutes: 120, reportOnlyAfterMinutes: 5, maxBashCommands: 3 } }),
    }),
  );
  // The fake waits for the supervisor's config+state to exist, backdates the
  // config's startedAtMs beyond the 5-minute report-only window, and invokes
  // the real hook once. All of that plus the full supervisor lifecycle must
  // finish well under the simulated overrun — the elapsed wall time proves no
  // real 5-minute wait happened.
  const t0 = Date.now();
  const final = await waitForFinalized(job.jobId);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 30000, `job finalized in ${elapsedMs}ms, far below the simulated 5-minute window`);

  assert.equal(final.status, 'failed');
  assert.equal(final.substatus, 'budget_violation');
  assert.equal(final.budgetViolation, 'report_only_window');
  assert.equal(final.budgetStatus, 'failed');
  assert.equal(final.hasReport, true);
  assert.equal(final.reportCompleteness, 'partial');
  assert.equal(typeof final.metrics!.reportFirstWriteMs, 'number', 'report-first metric latched');

  const report = readReport(job.jobId);
  assert.match(report, /^completeness: partial$/m);
  assert.match(report, /DONE/, 'report body carries the worker final text');

  // The hook sidecar records the single overrun call with the window reason.
  const sim = JSON.parse(
    fs.readFileSync(path.join(rt, 'settings', `${job.jobId}.budget-hook-sim.json`), 'utf8'),
  ) as { calls: string[]; denyReason: string };
  assert.equal(sim.calls.length, 1);
  assert.match(sim.denyReason, /budget_denied:report_only_window/);

  // Budget state on disk: report_only via the window (no count exceeded).
  const state = JSON.parse(
    fs.readFileSync(path.join(rt, 'settings', `${job.jobId}.budget-state.json`), 'utf8'),
  ) as { budgetState: { mode: string; violationCode?: string; startedAtMs: number } };
  assert.equal(state.budgetState.mode, 'report_only');
  assert.equal(state.budgetState.violationCode, 'report_only_window');
  assert.ok(Date.now() - state.budgetState.startedAtMs > 5 * 60_000, 'state startedAtMs backdated beyond the window');
});

test('real hook unit parity: hook denies a Bash overrun exactly as the production CLI would', async () => {
  // Drive budget-hook.js directly (as the fake does) to pin the exact deny
  // contract the supervisor consumes: fixed short code, no paths/commands.
  const jobId = `parity-${crypto.randomUUID().slice(0, 8)}`;
  const cfgPath = path.join(rt, 'settings', `${jobId}.budget-config.json`);
  const statePath = path.join(rt, 'settings', `${jobId}.budget-state.json`);
  const now = Date.now();
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  atomicWriteJson(cfgPath, {
    jobId,
    workFolder: rt,
    startedAtMs: now,
    budget: validContract().budget,
    reportTargets: [],
  });
  atomicWriteJson(statePath, {
    schemaVersion: 1,
    jobId,
    budgetState: {
      mode: 'active',
      startedAtMs: now,
      toolCalls: 0,
      bashCommands: 0,
      sourceLines: 0,
      uniqueReadFiles: [],
      lastUpdatedAtMs: now,
    },
    reportWrites: 0,
  });
  const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'budget-hook.js');
  const run = (cmd: string) =>
    new Promise<{ stdout: string; status: number }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [entry, '--config', cfgPath, '--state', statePath],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr.on('data', (d: Buffer) => (err += d.toString()));
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout: out, status: code ?? -1 }));
      child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }));
    });
  const first = await run('unit call one');
  assert.equal(first.status, 0);
  assert.equal(first.stdout.trim(), '', 'first Bash allowed: no deny output');
  const second = await run('unit call two');
  assert.equal(second.status, 0);
  const parsed = JSON.parse(second.stdout) as { hookSpecificOutput: { permissionDecisionReason: string } };
  assert.equal(parsed.hookSpecificOutput.permissionDecisionReason, 'denied by job budget hook: budget_denied:bash_commands_exceeded');
});
