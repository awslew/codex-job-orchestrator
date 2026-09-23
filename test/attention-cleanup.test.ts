// Stage 7 Windows cleanup test fixture (test-only). Imports the pure root-guard
// and bounded-cleanup helpers exported from smoke/attention-smoke.mjs and
// exercises them WITHOUT running the full eight-scenario smoke: importing the
// smoke is side-effect free (its body runs only when it is the entry point).
//
// Focused cases:
//   C1  exact owned runtime root passes the guard; temp-root / project-root /
//       project-runtime-root / wrong-prefix / wrong-embedded-pid /
//       sibling-descendant tricks and path traversal all refuse without deletion.
//   C2  boundedRemove removes exactly one valid runtime root; unrelated sibling
//       roots are untouched.
//   C3  simulated assertion-failure and thrown-exception runs still await
//       cleanup and remove the run root (try/catch/finally orchestration seam).
//   C4  a real child Node process (cwd inside rt/work-x) recorded by its actual
//       pid is killed, bounded-waited until dead, then the root is removed; an
//       unrecorded bystander survives (no broad kill).
//   C5  a non-owned old-residue sibling whose basename embeds another pid is
//       never deleted or inspected as a cleanup target.
//   C6  invalid / malformed / corrupt job records never become kill candidates;
//       only validated positive-integer pid/supervisorPid are candidates.
//   C7  deletion failure is finite, observable (remove-failed), and does not
//       escalate to broad cleanup (deterministic injected remover, no OS locks).
//   C8  every case creates and removes only its own uniquely-named temp files
//       and processes (withBase + after sweep). The two real old-residue paths
//       from the global runtime are never encoded or touched.
//
// PID/delete safety is proven per case: the guard is asserted before any
// boundedRemove, killTree is fed ONLY the recorded pids from this run's rt/jobs,
// waitForDead bounds the reap, and every temp base is unique to this process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { killTree, isAlive } from '../src/proc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SMOKE_URL = pathToFileURL(path.resolve(HERE, '..', '..', 'smoke', 'attention-smoke.mjs')).href;
const OWN_PID = process.pid;

interface SmokeHelpers {
  isSafeRuntimeRoot(candidate: unknown, ownPid: number, tmpDir?: string, projectRoot?: string): boolean;
  collectRecordedPids(jobsDir: string): number[];
  waitForDead(
    pids: number[],
    opts?: { attempts?: number; stepMs?: number; isAliveFn?: (pid: number) => boolean },
  ): Promise<number[]>;
  boundedRemoveRuntime(
    candidate: string,
    ownPid: number,
    tmpDir?: string,
    projectRoot?: string,
    opts?: { attempts?: number; retryDelayMs?: number; rmRetries?: number; rmRetryDelayMs?: number },
  ): Promise<{ ok: boolean; reason?: string }>;
}

let smoke: SmokeHelpers;
before(async () => {
  smoke = (await import(SMOKE_URL)) as unknown as SmokeHelpers;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Exact smoke naming: orc-attn-smoke-<pid>-<digits>.
const rtName = (pid: number, tag: number): string => `orc-attn-smoke-${pid}-${tag}`;

// Isolated project root (with its own runtime dir) used to prove the
// project-root / project-runtime-root guard rejections.
function makeProject(base: string): string {
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, 'runtime'), { recursive: true });
  return proj;
}

// Unique per-run temp base under os.tmpdir(). Every test creates and removes
// only its own base; the finally is best-effort so a cleanup hiccup never masks
// the assertion result.
let baseSeq = 0;
async function withBase<T>(fn: (base: string) => Promise<T>): Promise<T> {
  baseSeq += 1;
  const base = path.join(
    os.tmpdir(),
    `orc-attn-cleanup-${OWN_PID}-${Date.now()}-${baseSeq}-${Math.random().toString(36).slice(2, 8)}`,
  );
  fs.mkdirSync(base, { recursive: true });
  try {
    return await fn(base);
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best effort */
    }
  }
}

// Defense-in-depth: sweep only this run's uniquely-named temp bases (own-pid
// prefix) in case a test crashed before its finally. Never touches the global
// runtime, logs, or any other temp namespace.
after(() => {
  try {
    const prefix = `orc-attn-cleanup-${OWN_PID}-`;
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith(prefix)) {
        try {
          fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          /* best effort */
        }
      }
    }
  } catch {
    /* best effort */
  }
});

async function pollAlive(pid: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isAlive(pid)) return;
    await sleep(25);
  }
  throw new Error(`child pid ${pid} never became alive`);
}

interface CleanupResult {
  ok: boolean;
  reason?: string;
  stillAlive: number[];
}

// Mirrors the smoke's cleanup(): guard the exact root, kill ONLY this run's
// recorded job/supervisor pids, bounded-wait until dead, then remove ONLY the
// validated root with bounded Windows retry. Uses the exported smoke seam plus
// the project's own proc.ts killTree/isAlive.
async function seamCleanup(rt: string, ownPid: number, tmpDir: string, proj: string): Promise<CleanupResult> {
  if (!smoke.isSafeRuntimeRoot(rt, ownPid, tmpDir, proj)) {
    return { ok: false, reason: 'guard-refused', stillAlive: [] };
  }
  const recorded = smoke.collectRecordedPids(path.join(rt, 'jobs'));
  for (const pid of recorded) killTree(pid);
  const stillAlive = await smoke.waitForDead(recorded, { attempts: 50, stepMs: 100, isAliveFn: isAlive });
  const res = await smoke.boundedRemoveRuntime(rt, ownPid, tmpDir, proj);
  return { ok: res.ok, reason: res.reason, stillAlive };
}

// ---------------------------------------------------------------------------

test('C1 guard: exact owned runtime root passes; temp/project/wrong-pid/prefix/traversal refuse without deletion', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);
    const tag = 101010;

    // Exact own runtime root (direct child of the temp base, own pid embedded).
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, rtName(OWN_PID, tag)), OWN_PID, base, proj), true);

    // os.tmpdir() root itself and the passed temp root itself.
    assert.equal(smoke.isSafeRuntimeRoot(os.tmpdir(), OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(base, OWN_PID, base, proj), false);

    // Project root and project runtime root.
    assert.equal(smoke.isSafeRuntimeRoot(proj, OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(path.join(proj, 'runtime'), OWN_PID, base, proj), false);

    // Wrong prefix variants.
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, `orc-attn-${OWN_PID}-${tag}`), OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, `attn-smoke-${OWN_PID}-${tag}`), OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, `orc-attn-smokeX-${OWN_PID}-${tag}`), OWN_PID, base, proj), false);

    // Wrong embedded pid.
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, rtName(OWN_PID + 1, tag)), OWN_PID, base, proj), false);

    // Non-numeric trailing token.
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, `orc-attn-smoke-${OWN_PID}-abc`), OWN_PID, base, proj), false);

    // Sibling and descendant tricks.
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, 'some-other-dir'), OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, rtName(OWN_PID, 202020), 'child'), OWN_PID, base, proj), false);

    // Path traversal that would escape the temp base.
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, '..', 'escape-a'), OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(path.join(base, rtName(OWN_PID, 303030), '..', '..', 'escape-b'), OWN_PID, base, proj), false);

    // Non-strings / empty.
    assert.equal(smoke.isSafeRuntimeRoot('', OWN_PID, base, proj), false);
    assert.equal(smoke.isSafeRuntimeRoot(null, OWN_PID, base, proj), false);

    // "fail without deletion": an existing invalid candidate is refused by
    // boundedRemoveRuntime before any filesystem mutation, and its contents live.
    const decoy = path.join(base, rtName(OWN_PID + 999, 1));
    fs.mkdirSync(decoy, { recursive: true });
    fs.writeFileSync(path.join(decoy, 'keep.txt'), 'x');
    const refused = await smoke.boundedRemoveRuntime(decoy, OWN_PID, base, proj, { attempts: 2, retryDelayMs: 10 });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'guard-refused');
    assert.ok(fs.existsSync(decoy));
    assert.equal(fs.readFileSync(path.join(decoy, 'keep.txt'), 'utf8'), 'x');
  });
});

test('C2 boundedRemove success removes exactly one valid runtime root and leaves sibling roots untouched', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);

    const owned = path.join(base, rtName(OWN_PID, 20240813));
    fs.mkdirSync(owned, { recursive: true });
    fs.writeFileSync(path.join(owned, 'job.json'), '{}');

    const sibling = path.join(base, 'unrelated-sibling');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'data.txt'), 'keep');

    const otherOwned = path.join(base, rtName(OWN_PID + 777, 4242));
    fs.mkdirSync(otherOwned, { recursive: true });
    fs.writeFileSync(path.join(otherOwned, 'data.txt'), 'keep');

    const res = await smoke.boundedRemoveRuntime(owned, OWN_PID, base, proj);
    assert.equal(res.ok, true, `reason=${res.reason}`);
    assert.ok(!fs.existsSync(owned), 'owned root removed');

    assert.ok(fs.existsSync(sibling), 'unrelated sibling untouched');
    assert.equal(fs.readFileSync(path.join(sibling, 'data.txt'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(otherOwned), 'other-owned root untouched');
    assert.equal(fs.readFileSync(path.join(otherOwned, 'data.txt'), 'utf8'), 'keep');

    // Already-gone path is a success, not an error.
    const again = await smoke.boundedRemoveRuntime(owned, OWN_PID, base, proj);
    assert.equal(again.ok, true);
  });
});

test('C3 simulated assertion-failure and thrown-exception runs still await cleanup and remove the run root', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);

    let rtSeq = 0;
    const runSeam = async (body: (check: (name: string, cond: boolean) => void) => Promise<void>) => {
      rtSeq += 1;
      const rt = path.join(base, rtName(OWN_PID, 900000 + rtSeq));
      fs.mkdirSync(rt, { recursive: true });
      fs.mkdirSync(path.join(rt, 'jobs'), { recursive: true });
      let failures = 0;
      let threw: Error | null = null;
      let cleanup: CleanupResult | null = null;
      const check = (_name: string, cond: boolean): void => {
        if (!cond) failures += 1; // mirrors the smoke's check()
      };
      try {
        await body(check);
      } catch (e) {
        threw = e instanceof Error ? e : new Error(String(e));
      } finally {
        cleanup = await seamCleanup(rt, OWN_PID, base, proj);
      }
      return { rt, failures, threw, cleanup: cleanup! };
    };

    // (a) assertion-failure: scenarios complete but assertions fail (failures>0,
    //     the smoke would set exitCode=1). No throw — the finally must clean up.
    const a = await runSeam(async (check) => {
      check('scenario S1 assertion', Date.now() < 0); // always false at runtime, not a TS constant
      check('scenario S4 assertion', Math.random() > 2); // always false at runtime, not a TS constant
    });
    assert.equal(a.threw, null);
    assert.ok(a.failures > 0, 'simulated failed assertions');
    assert.equal(a.cleanup.ok, true, `reason=${a.cleanup.reason}`);
    assert.ok(!fs.existsSync(a.rt), 'run root removed after assertion-failure');

    // (b) thrown-exception: a scenario throws; catch + finally still clean up.
    const b = await runSeam(async () => {
      throw new Error('simulated scenario exception');
    });
    assert.ok(b.threw instanceof Error);
    assert.equal(b.cleanup.ok, true, `reason=${b.cleanup.reason}`);
    assert.ok(!fs.existsSync(b.rt), 'run root removed after thrown exception');
  });
});

test('C4 cleanup kills only the recorded child, bounded-waits until dead, then removes the root', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);
    const rt = path.join(base, rtName(OWN_PID, 404040));
    const workX = path.join(rt, 'work-x');
    fs.mkdirSync(workX, { recursive: true });
    fs.mkdirSync(path.join(rt, 'jobs'), { recursive: true });

    // Recorded child: cwd inside rt/work-x.
    const recorded = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: workX,
      stdio: 'ignore',
      windowsHide: true,
    });
    // Unrecorded bystander: lives OUTSIDE rt (so removing rt is never blocked
    // by it) and must survive cleanup — proving we never broad-kill.
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: base,
      stdio: 'ignore',
      windowsHide: true,
    });

    const recPid = recorded.pid;
    const byPid = bystander.pid;
    if (recPid == null || byPid == null) {
      if (recorded.pid) {
        try { killTree(recorded.pid); } catch { /* best effort */ }
      }
      if (bystander.pid) {
        try { killTree(bystander.pid); } catch { /* best effort */ }
      }
      throw new Error('spawn returned no pid');
    }

    try {
      await pollAlive(recPid);
      await pollAlive(byPid);

      // Write ONLY this run's isolated job record with the recorded child's pid.
      fs.writeFileSync(
        path.join(rt, 'jobs', 'case4.json'),
        JSON.stringify({ jobId: 'case4', pid: recPid, supervisorPid: recPid }),
      );
      assert.deepEqual(smoke.collectRecordedPids(path.join(rt, 'jobs')), [recPid]);

      const res = await seamCleanup(rt, OWN_PID, base, proj);
      assert.equal(res.ok, true, `reason=${res.reason}`);
      assert.deepEqual(res.stillAlive, [], 'recorded child bounded-waited until dead');

      assert.equal(isAlive(recPid), false, 'recorded child killed');
      assert.ok(!fs.existsSync(rt), 'root removed');
      assert.equal(isAlive(byPid), true, 'unrecorded bystander never killed');
    } finally {
      // Reap BOTH children (the bystander is still alive and must be killed by
      // us) so the outer withBase finally can remove the base on Windows.
      if (byPid) {
        try { killTree(byPid); } catch { /* best effort */ }
      }
      if (recPid && isAlive(recPid)) {
        try { killTree(recPid); } catch { /* best effort */ }
      }
      try {
        await smoke.waitForDead([byPid, recPid], { attempts: 30, stepMs: 100, isAliveFn: isAlive });
      } catch {
        /* best effort */
      }
    }
  });
});

test('C5 non-owned old-residue sibling whose basename embeds another pid is never deleted or inspected', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);
    const otherPid = OWN_PID + 555555;
    const rt = path.join(base, rtName(OWN_PID, 505050));
    const residue = path.join(base, rtName(otherPid, 606060));
    fs.mkdirSync(rt, { recursive: true });
    fs.mkdirSync(path.join(rt, 'jobs'), { recursive: true });
    fs.mkdirSync(residue, { recursive: true });
    fs.writeFileSync(path.join(residue, 'old-residue.txt'), 'residue');

    // The residue is not a cleanup target for THIS run.
    assert.equal(smoke.isSafeRuntimeRoot(residue, OWN_PID, base, proj), false);
    // boundedRemove refuses before any filesystem mutation.
    const refused = await smoke.boundedRemoveRuntime(residue, OWN_PID, base, proj);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, 'guard-refused');

    // Cleaning this run's own root leaves the residue byte-for-byte intact.
    const res = await seamCleanup(rt, OWN_PID, base, proj);
    assert.equal(res.ok, true, `reason=${res.reason}`);
    assert.ok(!fs.existsSync(rt));
    assert.ok(fs.existsSync(residue), 'residue still present');
    assert.equal(fs.readFileSync(path.join(residue, 'old-residue.txt'), 'utf8'), 'residue');
  });
});

test('C6 invalid/malformed/corrupt job records never become kill candidates', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);

    // Root A: only malformed/corrupt records -> zero candidates -> cleanup kills
    // nothing and still removes the root.
    const rtA = path.join(base, rtName(OWN_PID, 606060));
    const jobsA = path.join(rtA, 'jobs');
    fs.mkdirSync(jobsA, { recursive: true });
    fs.writeFileSync(path.join(jobsA, 'neg.json'), JSON.stringify({ pid: -5, supervisorPid: -1 }));
    fs.writeFileSync(path.join(jobsA, 'zero.json'), JSON.stringify({ pid: 0 }));
    fs.writeFileSync(path.join(jobsA, 'float.json'), JSON.stringify({ pid: 3.14 }));
    fs.writeFileSync(path.join(jobsA, 'str.json'), JSON.stringify({ pid: '123', supervisorPid: '456' }));
    fs.writeFileSync(path.join(jobsA, 'null.json'), JSON.stringify({ pid: null }));
    fs.writeFileSync(path.join(jobsA, 'array.json'), JSON.stringify([1, 2, 3]));
    fs.writeFileSync(path.join(jobsA, 'bad-json.json'), '{ not valid json ');
    fs.writeFileSync(path.join(jobsA, 'empty.json'), '');
    fs.writeFileSync(path.join(jobsA, 'done.job.done.json'), JSON.stringify({ pid: 424242 }));
    fs.writeFileSync(path.join(jobsA, 'notes.txt'), 'not a record');

    assert.deepEqual(smoke.collectRecordedPids(jobsA), []);

    const cleanA = await seamCleanup(rtA, OWN_PID, base, proj);
    assert.equal(cleanA.ok, true, `reason=${cleanA.reason}`);
    assert.deepEqual(cleanA.stillAlive, []);
    assert.ok(!fs.existsSync(rtA), 'root removed; no kill attempted');

    // Root B: mixed records. Only the validated positive-integer pid is a
    // candidate; everything malformed is ignored. Boundary check only — the
    // sentinel pid is far too large to be a real process and is never killed.
    const rtB = path.join(base, rtName(OWN_PID, 606061));
    const jobsB = path.join(rtB, 'jobs');
    fs.mkdirSync(jobsB, { recursive: true });
    fs.writeFileSync(path.join(jobsB, 'malformed.json'), JSON.stringify({ pid: -1, supervisorPid: 'x' }));
    fs.writeFileSync(path.join(jobsB, 'valid-sentinel.json'), JSON.stringify({ pid: 2147483647, supervisorPid: 2147483647 }));

    assert.deepEqual(smoke.collectRecordedPids(jobsB), [2147483647]);

    // Remove root B WITHOUT any kill step (boundedRemoveRuntime never touches pids).
    const cleanB = await smoke.boundedRemoveRuntime(rtB, OWN_PID, base, proj);
    assert.equal(cleanB.ok, true, `reason=${cleanB.reason}`);
    assert.ok(!fs.existsSync(rtB));
  });
});

// ---------------------------------------------------------------------------
// Deterministic bounded-remove seam (C7 only). smoke.boundedRemoveRuntime itself
// exposes no injectable remover, so this mirrors its exact bounded-retry contract
// (guard revalidated before every attempt, already-gone fast path, catch-and-
// retry on transient EBUSY/EPERM, finite attempts) with the delete injected. The
// success path continues to use the smoke's real remover.
// ---------------------------------------------------------------------------
type RemoveFn = (candidate: string) => void;

async function boundedRemoveWithRemover(
  candidate: string,
  ownPid: number,
  tmpDir: string,
  proj: string,
  remover: RemoveFn,
  opts: { attempts?: number; retryDelayMs?: number } = {},
): Promise<{ ok: boolean; reason?: string; attempts: number }> {
  const attempts = opts.attempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 250;
  let attemptsUsed = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    attemptsUsed += 1;
    if (!smoke.isSafeRuntimeRoot(candidate, ownPid, tmpDir, proj)) {
      return { ok: false, reason: 'guard-refused', attempts: attemptsUsed };
    }
    try {
      if (!fs.existsSync(candidate)) return { ok: true, attempts: attemptsUsed }; // already gone
    } catch {
      return { ok: false, reason: 'stat-failed', attempts: attemptsUsed };
    }
    try {
      remover(candidate);
      try {
        if (!fs.existsSync(candidate)) return { ok: true, attempts: attemptsUsed };
      } catch {
        return { ok: true, attempts: attemptsUsed }; // vanished mid-check
      }
    } catch {
      /* transient lock (EBUSY/EPERM); retry after delay */
    }
    if (attempt < attempts - 1) await sleep(retryDelayMs);
  }
  return { ok: false, reason: 'remove-failed', attempts: attemptsUsed };
}

test('C7 deletion failure path is finite, observable (remove-failed), and never escalates to broad cleanup', async () => {
  await withBase(async (base) => {
    const proj = makeProject(base);
    const rt = path.join(base, rtName(OWN_PID, 707070));
    fs.mkdirSync(rt, { recursive: true });
    fs.writeFileSync(path.join(rt, 'payload.txt'), 'x');
    const sibling = path.join(base, 'unrelated-sibling');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'data.txt'), 'keep');

    // Deterministic failure path: an injected remover that ALWAYS throws the
    // transient-lock errors (EBUSY/EPERM) the smoke's bounded retry exists for.
    // No cwd/file-lock or ACL/platform behavior is relied on, so the outcome is
    // reproducible on every host.
    const attempts = 4;
    const retryDelayMs = 10;
    for (const code of ['EBUSY', 'EPERM'] as const) {
      let removeCalls = 0;
      const failingRemover: RemoveFn = () => {
        removeCalls += 1;
        const err = new Error(`simulated ${code}`) as NodeJS.ErrnoException;
        err.code = code;
        throw err;
      };

      const t0 = Date.now();
      const res = await boundedRemoveWithRemover(rt, OWN_PID, base, proj, failingRemover, { attempts, retryDelayMs });
      const elapsed = Date.now() - t0;

      assert.equal(res.ok, false, `removal must fail under an always-throwing remover (${code})`);
      assert.equal(res.reason, 'remove-failed');
      assert.equal(res.attempts, attempts, 'bounded retry budget exhausted exactly');
      assert.equal(removeCalls, attempts, `remover invoked once per attempt (${code})`);
      assert.ok(elapsed < 5000, `finite: bounded to ${elapsed}ms`);
      assert.ok(fs.existsSync(rt), 'blocked target not deleted');
      assert.ok(fs.existsSync(sibling), 'unrelated sibling untouched');
      assert.equal(fs.readFileSync(path.join(sibling, 'data.txt'), 'utf8'), 'keep');
    }

    // Preserved success path: the smoke's own bounded remover (real fs.rmSync)
    // removes the same exact validated root cleanly, so the real cleanup
    // functionality remains covered.
    const success = await smoke.boundedRemoveRuntime(rt, OWN_PID, base, proj);
    assert.equal(success.ok, true, `reason=${success.reason}`);
    assert.ok(!fs.existsSync(rt), 'real remover removes the root');
  });
});
