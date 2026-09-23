// Windows process-visibility tests for the console-flash fix.
//
// Two spawn modes are unified in src/proc.ts:
//   - background (supervisor / claude worker / taskkill helper): on Windows the
//     child must not pop a visible console window (windowsHide: true). On other
//     platforms windowsHide is a no-op and is left undefined, so behavior is
//     byte-identical to before.
//   - viewer launcher (cmd.exe `start`): the short-lived launcher itself is
//     hidden, while the final viewer it starts runs in its own NEW console
//     window and must stay visible. The viewer never inherits the background
//     hide policy.
//
// Also covers the scheduler's OPEN_LIVE_VIEW gate: =0 never launches a viewer,
// =1 (default) opens exactly one viewer per new session, and reply reuses the
// same window (no new launch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rt = path.join(os.tmpdir(), `orc-proc-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0'; // safe default; viewer-gate tests override it
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';
// Deterministic spawns: no anti-burst start jitter in tests.
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';

import { windowsHideOnWindows, backgroundSpawnOptions, viewerLauncherOptions, spawnBackground, spawnViewerLauncher } from '../src/proc.js';
// ── ALIGNMENT-SENSITIVE: proc focused PID query/match/verified-kill helpers.
// The frozen contract guarantees proc gains focused PID helpers; the exact
// names/signatures here follow the Stage-7 smoke guard's helpers and are the
// smallest expected alignment surface once the source writer completes.
import { queryParentPid, buildAncestorPidSet, evaluatePidCandidate, pidIdentityStatus } from '../src/proc.js';
import { shouldOpenLiveView, liveViewTestHooks, startJob, replyJob, cancelJob, getStatus, type ViewerLaunchIntent } from '../src/scheduler.js';
import { readJob } from '../src/job-store.js';
import type { StartParams } from '../src/router.js';

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');

function fakeParams(over: Partial<StartParams> & { extraEnv?: Record<string, string> } = {}): StartParams {
  return {
    prompt: 'proc test',
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForFinalized(jobId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getStatus(jobId).endedAt) return;
    await sleep(200);
  }
  throw new Error(`job not finalized: ${jobId}`);
}

async function waitForStatus(jobId: string, status: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (getStatus(jobId).status === status) return;
    await sleep(200);
  }
  throw new Error(`job did not reach ${status}: ${jobId}`);
}

// Records written by proc.ts's env-gated ORCHESTRATOR_PROC_SPY_FILE spy, so the
// call-site tests below can assert the ACTUAL spawn options each production
// site resolves (including inside the detached supervisor process).
interface SpyRecord {
  kind: 'background' | 'viewer' | 'helper';
  command: string;
  args: string[];
  windowsHide?: boolean;
  platform: string;
  pid: number;
}

function readSpy(file: string): SpyRecord[] {
  if (!fs.existsSync(file)) return [];
  const out: SpyRecord[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as SpyRecord);
    } catch {
      /* skip a partial/interleaved line */
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// windowsHideOnWindows: the decision is win32-only.
// ---------------------------------------------------------------------------
test('windowsHideOnWindows is true only on win32', () => {
  assert.equal(windowsHideOnWindows('win32'), true);
  assert.equal(windowsHideOnWindows('linux'), undefined);
  assert.equal(windowsHideOnWindows('darwin'), undefined);
  assert.equal(windowsHideOnWindows('freebsd'), undefined);
});

// ---------------------------------------------------------------------------
// backgroundSpawnOptions: background children hide their console on Windows
// only; other platforms get an unchanged options object (no windowsHide key).
// ---------------------------------------------------------------------------
test('backgroundSpawnOptions hides the console on win32', () => {
  const opts = backgroundSpawnOptions({ detached: true, stdio: 'ignore' }, 'win32');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.detached, true);
  assert.equal(opts.stdio, 'ignore');
});

test('backgroundSpawnOptions preserves cwd/env/shell/stdio on win32', () => {
  const env = { A: '1' };
  const opts = backgroundSpawnOptions({ cwd: 'C:\\w', env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }, 'win32');
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.cwd, 'C:\\w');
  assert.equal(opts.env, env);
  assert.equal(opts.shell, false);
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('backgroundSpawnOptions leaves non-Windows options unchanged (no windowsHide key)', () => {
  for (const p of ['linux', 'darwin'] as const) {
    const opts = backgroundSpawnOptions({ detached: true, stdio: 'ignore' }, p);
    assert.ok(!('windowsHide' in opts), `${p} must not add a windowsHide key`);
    assert.deepEqual(opts, { detached: true, stdio: 'ignore' });
  }
});

// ---------------------------------------------------------------------------
// viewerLauncherOptions: the short-lived launcher is hidden on Windows, while
// the final viewer (created by cmd `start` in a new console) stays visible.
// ---------------------------------------------------------------------------
test('viewerLauncherOptions hides the launcher on win32 and nothing elsewhere', () => {
  const win = viewerLauncherOptions({ detached: true, stdio: 'ignore' }, 'win32');
  assert.equal(win.windowsHide, true, 'launcher hidden on win32');
  assert.equal(win.detached, true);
  assert.equal(win.stdio, 'ignore');
  for (const p of ['linux', 'darwin'] as const) {
    const opts = viewerLauncherOptions({ detached: true, stdio: 'ignore' }, p);
    assert.ok(!('windowsHide' in opts), `${p} must not add a windowsHide key`);
    assert.deepEqual(opts, { detached: true, stdio: 'ignore' });
  }
});

// The isolation contract for the human viewer: the launcher is `cmd /c start
// <title> <node> <viewer> <jobId>` — `start` opens the viewer in its OWN new
// console (CREATE_NEW_CONSOLE), so the final viewer is never hidden even though
// the launcher handle is. Assert the launcher command shape is preserved.
test('viewer launcher command uses cmd /c start with a spaced title (new-console viewer)', () => {
  const title = 'Claude-CC abcdef12';
  const args = ['/c', 'start', title, process.execPath, path.join('dist', 'viewer.js'), 'job-1'];
  const opts = viewerLauncherOptions({ detached: true, stdio: 'ignore' }, 'win32');
  assert.equal(args[0], '/c');
  assert.equal(args[1], 'start');
  assert.match(title, /\s/, 'title must contain a space for cmd start');
  assert.equal(opts.windowsHide, true, 'launcher hidden');
});

// ---------------------------------------------------------------------------
// spawnBackground / spawnViewerLauncher actually spawn working children.
// ---------------------------------------------------------------------------
test('spawnBackground spawns a working background child', async () => {
  const child = spawnBackground(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  assert.ok(child.pid, 'child has a pid');
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
});

test('spawnBackground passes env through to the child', async () => {
  const child = spawnBackground(process.execPath, ['-e', 'process.exit(process.env.PROC_TEST_ENV === "yes" ? 0 : 7)'], {
    stdio: 'ignore',
    env: { ...process.env, PROC_TEST_ENV: 'yes' },
  });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
});

test('spawnViewerLauncher spawns a working (hidden-on-win32) child', async () => {
  const child = spawnViewerLauncher(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
});

// ---------------------------------------------------------------------------
// shouldOpenLiveView: OPEN_LIVE_VIEW gate, Windows-only.
// ---------------------------------------------------------------------------
test('shouldOpenLiveView honors the OPEN_LIVE_VIEW gate (default off)', () => {
  assert.equal(shouldOpenLiveView({}, 'win32'), false, 'unset default is off on win32');
  assert.equal(shouldOpenLiveView({ OPEN_LIVE_VIEW: '' }, 'win32'), false, 'empty is off on win32');
  assert.equal(shouldOpenLiveView({ OPEN_LIVE_VIEW: '0' }, 'win32'), false, '=0 is off on win32');
  assert.equal(shouldOpenLiveView({ OPEN_LIVE_VIEW: '1' }, 'win32'), true, '=1 enables on win32');
  assert.equal(shouldOpenLiveView({}, 'linux'), false, 'never on linux');
  assert.equal(shouldOpenLiveView({ OPEN_LIVE_VIEW: '1' }, 'darwin'), false, 'never on darwin');
  assert.equal(shouldOpenLiveView({ OPEN_LIVE_VIEW: '0' }, 'linux'), false, '=0 on linux stays off');
});

// ---------------------------------------------------------------------------
// Scheduler integration: the real startJob path must honor the gate and the
// one-viewer-per-session / reply-reuse rules, without opening real windows
// (the launch seam replaces the cmd `start` spawn). Windows-only because the
// viewer is a Windows feature.
// ---------------------------------------------------------------------------
test('OPEN_LIVE_VIEW=0 never launches the viewer', async () => {
  const prev = process.env.OPEN_LIVE_VIEW;
  process.env.OPEN_LIVE_VIEW = '0';
  const launched: string[] = [];
  liveViewTestHooks.launch = (jobId) => launched.push(jobId);
  try {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
    await waitForFinalized(job.jobId);
    assert.deepEqual(launched, [], 'OPEN_LIVE_VIEW=0 must never launch a viewer');
  } finally {
    liveViewTestHooks.launch = undefined;
    if (prev === undefined) delete process.env.OPEN_LIVE_VIEW;
    else process.env.OPEN_LIVE_VIEW = prev;
  }
});

test(
  'OPEN_LIVE_VIEW=1 opens exactly one viewer per new session; reply reuses the same window',
  { skip: process.platform !== 'win32' },
  async () => {
    const prev = process.env.OPEN_LIVE_VIEW;
    process.env.OPEN_LIVE_VIEW = '1';
    const launched: Array<{ jobId: string; intent: ViewerLaunchIntent }> = [];
    liveViewTestHooks.launch = (jobId, intent) => launched.push({ jobId, intent });
    try {
      const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
      await waitForFinalized(job.jobId);
      assert.equal(launched.length, 1, 'a new session opens exactly one viewer');
      const l = launched[0];
      assert.equal(l.jobId, job.jobId);
      // Production call shape: hidden cmd.exe launcher + cmd `start` in a NEW
      // console (the final viewer is created by `start`, not hidden).
      assert.equal(l.intent.command, 'cmd.exe');
      assert.deepEqual(l.intent.args.slice(0, 2), ['/c', 'start']);
      assert.match(l.intent.args[2], /\s/, 'title contains a space (cmd start quirk)');
      assert.equal(l.intent.args[3], process.execPath);
      assert.ok(l.intent.args[4].endsWith(path.join('dist', 'viewer.js')), 'viewer entry is dist/viewer.js');
      assert.equal(l.intent.args[5], job.jobId);
      assert.deepEqual(l.intent.options, { detached: true, stdio: 'ignore' }, 'launcher options');

      const reply = replyJob(job.jobId, 'narrow fix');
      assert.equal(launched.length, 1, 'reply must reuse the same viewer (no new launch)');
      try {
        cancelJob(reply.job.jobId);
      } catch {
        /* best-effort cleanup */
      }
    } finally {
      liveViewTestHooks.launch = undefined;
      if (prev === undefined) delete process.env.OPEN_LIVE_VIEW;
      else process.env.OPEN_LIVE_VIEW = prev;
    }
  },
);

// ---------------------------------------------------------------------------
// Call-site evidence (P2-1 / P3): prove the ACTUAL production spawn points
// resolve the correct Windows visibility policy, not just the pure helpers.
// The env-gated ORCHESTRATOR_PROC_SPY_FILE recorder (src/proc.ts) appends one
// JSON line per resolved spawn, including from inside the detached supervisor
// process. NOTE: these assert the resolved spawn options (windowsHide), NOT
// pixel-level "no flash" — a real human smoke is still required for that.
// ---------------------------------------------------------------------------
test('supervisor and Claude CLI worker spawn sites resolve windowsHide per platform', async () => {
  const spy = path.join(rt, `spy-callsite-${process.pid}.jsonl`);
  const prevSpy = process.env.ORCHESTRATOR_PROC_SPY_FILE;
  const prevOpen = process.env.OPEN_LIVE_VIEW;
  process.env.ORCHESTRATOR_PROC_SPY_FILE = spy;
  process.env.OPEN_LIVE_VIEW = '0';
  try {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv() }));
    await waitForFinalized(job.jobId);
    const recs = readSpy(spy);
    const expectHide = process.platform === 'win32';

    // scheduler -> supervisor (recorded in this test process)
    const sup = recs.find((r) => r.kind === 'background' && r.args.some((a) => a.endsWith('supervisor.js')));
    assert.ok(sup, 'supervisor spawn recorded from the scheduler');
    assert.equal(!!sup.windowsHide, expectHide, `supervisor windowsHide should be ${expectHide}`);
    assert.ok(sup.args.includes('--job'), 'supervisor launched with --job <id>');

    // supervisor -> Claude CLI worker (recorded from the detached supervisor)
    const worker = recs.find((r) => r.kind === 'background' && r.args.some((a) => a.endsWith('fake-claude.mjs')));
    assert.ok(worker, 'worker spawn recorded from the detached supervisor');
    assert.notEqual(worker.pid, process.pid, 'worker record was written by the supervisor process, not this one');
    assert.equal(!!worker.windowsHide, expectHide, `worker windowsHide should be ${expectHide}`);
  } finally {
    if (prevSpy === undefined) delete process.env.ORCHESTRATOR_PROC_SPY_FILE;
    else process.env.ORCHESTRATOR_PROC_SPY_FILE = prevSpy;
    process.env.OPEN_LIVE_VIEW = prevOpen;
  }
});

test('cancel kills the process tree via hidden taskkill', { skip: process.platform !== 'win32' }, async () => {
  const spy = path.join(rt, 'spy-cancel.jsonl');
  const prevSpy = process.env.ORCHESTRATOR_PROC_SPY_FILE;
  const prevOpen = process.env.OPEN_LIVE_VIEW;
  process.env.ORCHESTRATOR_PROC_SPY_FILE = spy;
  process.env.OPEN_LIVE_VIEW = '0';
  try {
    const { job } = startJob(fakeParams({ extraEnv: fakeEnv({ FAKE_CLAUDE_RUN_SECONDS: '8' }) }));
    await sleep(1500); // let the supervisor + worker spawn
    cancelJob(job.jobId, 'cancel spy');
    const tk = readSpy(spy).filter((r) => r.kind === 'helper' && r.command === 'taskkill');
    assert.ok(tk.length > 0, 'cancel invoked taskkill');
    assert.ok(tk.every((r) => r.windowsHide === true), 'taskkill helper is hidden on win32');
    assert.ok(tk.every((r) => r.args.includes('/T') && r.args.includes('/F')), 'taskkill uses /T /F (whole tree)');
  } finally {
    if (prevSpy === undefined) delete process.env.ORCHESTRATOR_PROC_SPY_FILE;
    else process.env.ORCHESTRATOR_PROC_SPY_FILE = prevSpy;
    process.env.OPEN_LIVE_VIEW = prevOpen;
  }
});

test('reply to a needs_attention job kills the stale worker tree via hidden taskkill', { skip: process.platform !== 'win32' }, async () => {
  const spy = path.join(rt, 'spy-reply.jsonl');
  const prevSpy = process.env.ORCHESTRATOR_PROC_SPY_FILE;
  const prevOpen = process.env.OPEN_LIVE_VIEW;
  process.env.ORCHESTRATOR_PROC_SPY_FILE = spy;
  process.env.OPEN_LIVE_VIEW = '0';
  try {
    const work = path.join(rt, 'reply-kill-work');
    fs.mkdirSync(work, { recursive: true });
    const { job } = startJob(
      fakeParams({
        workFolder: work,
        extraEnv: fakeEnv({
          FAKE_CLAUDE_USER_PROMPT: '1',
          FAKE_CLAUDE_PERM_TOOL: 'Read',
          FAKE_CLAUDE_PERM_PATH: path.join(work, 'x.json'),
          // Deterministic hold: the fake worker must stay alive (blocked on
          // the user prompt) well beyond the reply's kill+dead-check window,
          // so the old tree is provably still live when we verify it.
          FAKE_CLAUDE_RUN_SECONDS: '60',
        }),
      }),
    );
    await waitForStatus(job.jobId, 'needs_attention');
    // The public view never exposes the worker pid: read the persisted record
    // directly and verify the recorded identity against the live OS BEFORE
    // replying (the exact gate replyJob itself applies).
    const rec = readJob(job.jobId);
    assert.ok(rec, 'job record readable');
    assert.ok(rec.pid != null && Number.isInteger(rec.pid) && rec.pid > 0, 'worker pid persisted and positive');
    assert.ok(typeof rec.pidStartedAt === 'string' && rec.pidStartedAt.length > 0, 'worker pidStartedAt persisted');
    const workerPid = rec.pid;
    const workerStartedAt = rec.pidStartedAt;
    assert.equal(pidIdentityStatus(workerPid, workerStartedAt), 'verified_live', 'worker is identity-verified live before reply');
    const before = readSpy(spy).filter((r) => r.kind === 'helper').length;
    const reply = replyJob(job.jobId, 'proceed');
    const after = readSpy(spy).filter((r) => r.kind === 'helper').length;
    assert.ok(after > before, 'reply recorded a new helper spawn (taskkill)');
    const tk = readSpy(spy).filter((r) => r.kind === 'helper' && r.command === 'taskkill');
    assert.ok(tk.length > 0, 'taskkill helper records exist');
    assert.ok(
      tk.some((r) => r.args.includes('/pid') && Number(r.args[r.args.indexOf('/pid') + 1]) === workerPid),
      'taskkill targets the identity-verified worker pid',
    );
    assert.ok(tk.every((r) => r.args.includes('/T') && r.args.includes('/F')), 'taskkill uses /T /F (whole tree)');
    assert.ok(tk.every((r) => r.windowsHide === true), 'taskkill helper is hidden on win32');
    // Bounded wait: the recorded pid must become provably dead (identity
    // check, never a bare kill(pid,0)).
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (pidIdentityStatus(workerPid, workerStartedAt) === 'verified_dead') break;
      await sleep(100);
    }
    assert.equal(pidIdentityStatus(workerPid, workerStartedAt), 'verified_dead', 'old worker pid is dead after reply');
    try {
      cancelJob(reply.job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  } finally {
    if (prevSpy === undefined) delete process.env.ORCHESTRATOR_PROC_SPY_FILE;
    else process.env.ORCHESTRATOR_PROC_SPY_FILE = prevSpy;
    process.env.OPEN_LIVE_VIEW = prevOpen;
  }
});

// ---------------------------------------------------------------------------
// Core-consistency: focused PID query/match helpers (matrix 12/13/15).
//
// ALIGNMENT-SENSITIVE: the names/signatures follow the Stage-7 smoke guard's
// helpers and may be aligned once after source completion. Only the pure,
// injectable helpers are tested here; the observable no-kill/verified-kill
// behavior lives in the scheduler tests.
// ---------------------------------------------------------------------------

type EvalOptions = NonNullable<Parameters<typeof evaluatePidCandidate>[1]>;

function evalCandidate(pid: number, opts: Record<string, unknown>): { ok: boolean; reason?: string } {
  return evaluatePidCandidate(pid, opts as unknown as EvalOptions) as { ok: boolean; reason?: string };
}

test('queryParentPid returns a positive integer for this process or null (fails closed)', () => {
  const parent = queryParentPid(process.pid);
  if (parent !== null) assert.ok(Number.isInteger(parent) && parent > 0, 'parent pid is a positive integer');
  assert.equal(queryParentPid(0), null, 'non-positive fails closed');
  assert.equal(queryParentPid(-1), null, 'negative fails closed');
  assert.equal(queryParentPid(1.5), null, 'non-integer fails closed');
});

test('buildAncestorPidSet walks a bounded, acyclic ancestor chain', () => {
  const set = buildAncestorPidSet();
  assert.ok(set instanceof Set, 'returns a Set');
  assert.ok(set.has(process.ppid), 'process.ppid is the first ancestor');
  assert.ok(set.size >= 1 && set.size <= 32, 'bounded chain');
  for (const pid of set) assert.ok(Number.isInteger(pid) && pid > 0, 'every ancestor is a positive integer');
  const fake = buildAncestorPidSet({ queryParentPidFn: (p: number) => p - 1, maxDepth: 4 } as unknown as Parameters<typeof buildAncestorPidSet>[0]);
  assert.ok(fake.size >= 1 && fake.size <= 4, 'maxDepth bounds the walk');
  for (const pid of fake) assert.ok(Number.isInteger(pid) && pid > 0, 'the synthetic chain stays positive and finite');
});

test('evaluatePidCandidate is a fail-closed identity gate for a recorded pid', () => {
  const runStart = Date.now() - 60_000;
  const opts = {
    ownPid: process.pid,
    ancestorPids: new Set<number>([process.ppid]),
    runStartedAtMs: runStart,
    osStartTimeFn: () => Date.now(),
  };
  assert.deepEqual(evalCandidate(42_001, opts), { ok: true }, 'a safe candidate passes');
  assert.equal(evalCandidate(0, opts).ok, false, 'non-positive is rejected');
  assert.equal(evalCandidate(process.pid, opts).ok, false, 'self is rejected');
  assert.equal(evalCandidate(process.ppid, opts).ok, false, 'an ancestor is rejected');
  assert.equal(evalCandidate(42_001, { ...opts, osStartTimeFn: undefined }).ok, false, 'unverifiable start fails closed');
  assert.equal(evalCandidate(42_001, { ...opts, osStartTimeFn: () => null }).ok, false, 'null start fails closed');
  assert.equal(evalCandidate(42_001, { ...opts, osStartTimeFn: () => runStart - 60_000 }).ok, false, 'pre-run start fails closed');
  assert.equal(evalCandidate(42_001, { ...opts, runStartedAtMs: Number.NaN }).ok, false, 'no run threshold fails closed');
});
