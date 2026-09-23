// test/admission-controller.test.ts
// Wave 4B2a controller tests: flag/defaults, explicit desired override,
// fixed ordering, structured queue decisions, resource rules inherited from
// AdmissionManager, two-controller single-slot race (in-process + cross-process),
// launch/transfer failure paths, and sanitized public decisions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  AdmissionController,
  admissionControlFlag,
  defaultPolicyFromEnv,
  type AdmissionCandidate,
  type AdmissionDecision,
  type AdmissionFailureCode,
  type LaunchedSupervisor,
} from '../src/admission-controller.js';
import { AdmissionManager, type PidIdentityInspector } from '../src/admission.js';

// ---------- helpers ----------

let tmpSeq = 0;
function tmpRoot(): string {
  tmpSeq += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `admission-controller-test-${process.pid}-${tmpSeq}-`));
  return dir;
}

const FIXED_NOW = Date.now() + 60_000; // future-fixed: leases written under it stay within their 60s TTL for the real clock

/** Inspector where every pid is alive and every pidStartedAt matches. */
const ALIVE_MATCH: PidIdentityInspector = { isAlive: () => true, startedAtMatches: () => true };

/** Supervisor identity returned by launch callbacks. */
const SUP: LaunchedSupervisor = { pid: 5555, pidStartedAt: FIXED_NOW - 10_000 };

function candidate(over: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    jobId: 'job-a',
    desiredWorkerConcurrency: null,
    resourceClass: 'light',
    priority: 0,
    backend: 'deepseek',
    profile: 'auto',
    workFolder: path.join(os.tmpdir(), 'wf-a'),
    queuedAt: '2026-08-30T10:00:00.000Z',
    ...over,
  };
}

function policy(over: Partial<{ desired: number; hard: number; heavy: number; reserve: number }> = {}) {
  return {
    desiredWorkerConcurrency: over.desired ?? 8,
    hardSafetyCeiling: over.hard ?? 8,
    maxHeavyWorkers: over.heavy ?? 2,
    memoryReserveMb: over.reserve ?? 0,
  };
}

interface Harness {
  controller: AdmissionController;
  root: string;
  launches: AdmissionCandidate[];
  terminated: Array<{ candidate: AdmissionCandidate; supervisor: LaunchedSupervisor }>;
}

function makeHarness(over: Partial<{ policy: ReturnType<typeof policy>; now: () => number; freeMemoryMb: number; ownerPid: number; ownerPidStartedAt: number; terminate: (c: AdmissionCandidate, s: LaunchedSupervisor) => void }> = {}): Harness {
  const root = tmpRoot();
  const launches: AdmissionCandidate[] = [];
  const terminated: Array<{ candidate: AdmissionCandidate; supervisor: LaunchedSupervisor }> = [];
  const controller = new AdmissionController({
    runtimeRoot: root,
    policy: over.policy ?? policy(),
    now: over.now ?? (() => FIXED_NOW),
    freeMemoryMb: over.freeMemoryMb,
    ownerPid: over.ownerPid,
    ownerPidStartedAt: over.ownerPidStartedAt,
    launch: (c: AdmissionCandidate) => {
      launches.push(c);
      return { ...SUP };
    },
    terminate: over.terminate ?? ((c: AdmissionCandidate, s: LaunchedSupervisor) => { terminated.push({ candidate: c, supervisor: s }); }),
  });
  return { controller, root, launches, terminated };
}

function listDir(root: string, sub: string): string[] {
  const p = path.join(root, 'admission', sub);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

function liveLeaseOwnerIds(root: string): string[] {
  // Fresh manager on the real clock: leases held by the (fixed, fake) supervisor
  // pid are alive-verifiable by the fake identity and stay live.
  const manager = new AdmissionManager({ runtimeRoot: root, pidIdentity: ALIVE_MATCH });
  return manager.listLiveLeases().map((l) => l.jobId).sort();
}

function decisionOf(decisions: AdmissionDecision[], jobId: string): AdmissionDecision {
  const d = decisions.find((x) => x.jobId === jobId);
  assert.ok(d, `expected decision for ${jobId}`);
  return d as AdmissionDecision;
}

function asPublicLeaseJobIds(root: string): string[] {
  return liveLeaseOwnerIds(root);
}

// ---------- flag + env defaults (config.ts surface) ----------

test('flag: off by default; only 1/true/on/yes (case-insensitive) enable', () => {
  const saved = process.env.ORCHESTRATOR_ADMISSION_CONTROL;
  const set = (v: string | undefined): boolean => {
    if (v === undefined) delete process.env.ORCHESTRATOR_ADMISSION_CONTROL;
    else process.env.ORCHESTRATOR_ADMISSION_CONTROL = v;
    return admissionControlFlag();
  };
  try {
    assert.equal(set(undefined), false);
    for (const on of ['1', 'true', 'TRUE', 'on', 'On', 'yes', 'YES']) assert.equal(set(on), true);
    for (const off of ['', '0', 'false', 'off', 'no', '2', 'anything']) assert.equal(set(off), false);
  } finally {
    if (saved === undefined) delete process.env.ORCHESTRATOR_ADMISSION_CONTROL;
    else process.env.ORCHESTRATOR_ADMISSION_CONTROL = saved;
  }
});

test('policy defaults: documented values; invalid env falls back (no implicit cap)', () => {
  const names = ['ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY', 'ORCHESTRATOR_ADMISSION_HARD_CEILING', 'ORCHESTRATOR_ADMISSION_MAX_HEAVY_WORKERS', 'ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB'] as const;
  const saved = new Map<string, string | undefined>();
  for (const n of names) saved.set(n, process.env[n]);
  const setAll = (v: string | undefined): void => {
    for (const n of names) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  };
  try {
    setAll(undefined);
    let p = defaultPolicyFromEnv();
    assert.deepEqual(p, { desiredWorkerConcurrency: 4, hardSafetyCeiling: 8, maxHeavyWorkers: 2, memoryReserveMb: 2048 });
    // Valid explicit values are honored.
    process.env.ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY = '12';
    process.env.ORCHESTRATOR_ADMISSION_HARD_CEILING = '16';
    process.env.ORCHESTRATOR_ADMISSION_MAX_HEAVY_WORKERS = '3';
    process.env.ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB = '512';
    p = defaultPolicyFromEnv();
    assert.deepEqual(p, { desiredWorkerConcurrency: 12, hardSafetyCeiling: 16, maxHeavyWorkers: 3, memoryReserveMb: 512 });
    // Invalid values fall back per-field to the documented defaults.
    setAll('garbage');
    p = defaultPolicyFromEnv();
    assert.deepEqual(p, { desiredWorkerConcurrency: 4, hardSafetyCeiling: 8, maxHeavyWorkers: 2, memoryReserveMb: 2048 }, 'no implicit cap on invalid input');
    setAll('-3');
    p = defaultPolicyFromEnv();
    assert.deepEqual(p, { desiredWorkerConcurrency: 4, hardSafetyCeiling: 8, maxHeavyWorkers: 2, memoryReserveMb: 2048 });
    setAll('0');
    p = defaultPolicyFromEnv();
    assert.equal(p.desiredWorkerConcurrency, 4, '0 is not a valid desired concurrency');
    setAll('65');
    p = defaultPolicyFromEnv();
    assert.equal(p.desiredWorkerConcurrency, 4, 'above the 1..64 range falls back');
  } finally {
    for (const n of names) {
      const s = saved.get(n);
      if (s === undefined) delete process.env[n];
      else process.env[n] = s;
    }
  }
});

// ---------- explicit desired + defaults ----------

test('explicit desired=8 is not lowered by the default desired=4', () => {
  const { controller } = makeHarness({ policy: policy({ desired: 4, hard: 8 }) });
  const cs = [
    candidate({ jobId: 'j1', desiredWorkerConcurrency: 8 }),
    candidate({ jobId: 'j2', desiredWorkerConcurrency: null }),
    candidate({ jobId: 'j3', desiredWorkerConcurrency: 8 }),
    candidate({ jobId: 'j4', desiredWorkerConcurrency: 8 }),
    candidate({ jobId: 'j5', desiredWorkerConcurrency: 8 }),
  ];
  const ds = controller.pump(cs);
  assert.equal(ds.filter((d) => d.state === 'active').length, 5, '8 slots, 5 explicit-8 candidates => all active');
  assert.equal(decisionOf(ds, 'j2').state, 'active', 'null desired falls back to the policy default (4)');
});

test('20 light candidates with explicit desired=8: exactly 8 active, the rest structured queued', () => {
  const { controller, launches, root } = makeHarness({ policy: policy({ desired: 8, hard: 8 }) });
  const cs = Array.from({ length: 20 }, (_, i) =>
    candidate({ jobId: `j${String(i).padStart(2, '0')}`, desiredWorkerConcurrency: 8, queuedAt: `2026-08-30T10:00:${String(i).padStart(2, '0')}.000Z` }),
  );
  const ds = controller.pump(cs);
  const active = ds.filter((d) => d.state === 'active');
  const queued = ds.filter((d) => d.state === 'queued');
  assert.equal(active.length, 8);
  assert.equal(queued.length, 12);
  assert.equal(launches.length, 8, 'launch runs only for admitted candidates');
  // The 8 earliest queuedAt win (priority is equal here).
  const activeIds = active.map((d) => d.jobId).sort();
  assert.deepEqual(activeIds, Array.from({ length: 8 }, (_, i) => `j${String(i).padStart(2, '0')}`).sort());
  // Queued decisions carry the evaluation's public counts, limit and fixed reason.
  for (const d of queued) {
    assert.equal(d.admittedAt, null);
    assert.equal(d.active, 8);
    assert.equal(d.desired, 8);
    assert.equal(d.resourceLimit, 8);
    assert.equal(d.reason, 'desired_limit');
  }
  // Active decisions carry admittedAt and public counts too.
  for (const d of active) {
    assert.ok(d.admittedAt, 'active decision carries admittedAt');
    assert.equal(d.reason, null);
    assert.equal(d.desired, 8);
  }
  // And exactly 8 leases are held by the supervisor identity.
  assert.equal(liveLeaseOwnerIds(root).length, 8);
});

// ---------- ordering ----------

test('ordering: priority desc, then queuedAt asc, then jobId lexicographic', () => {
  const { controller } = makeHarness({ policy: policy({ desired: 8, hard: 8 }) });
  const cs = [
    candidate({ jobId: 'j-b', priority: 2, queuedAt: '2026-08-30T10:00:02.000Z' }),
    candidate({ jobId: 'j-a', priority: 2, queuedAt: '2026-08-30T10:00:01.000Z' }),
    candidate({ jobId: 'j-c', priority: 3, queuedAt: '2026-08-30T10:00:00.000Z' }),
    candidate({ jobId: 'j-d', priority: 3, queuedAt: '2026-08-30T10:00:02.000Z' }),
    candidate({ jobId: 'j-e', priority: 3, queuedAt: '2026-08-30T10:00:02.000Z' }),
    candidate({ jobId: 'j-f', priority: 0, queuedAt: '2026-08-30T10:00:00.000Z' }),
  ];
  const ds = controller.pump(cs);
  // All 6 are within the 8-slot limit, so state is active — the ordering shows
  // up in the decision sequence itself.
  assert.deepEqual(ds.map((d) => d.jobId), ['j-c', 'j-d', 'j-e', 'j-a', 'j-b', 'j-f']);
});

// ---------- policy limits inherited from AdmissionManager ----------

test('hard ceiling: policy hard=5 caps concurrency (reason hard_safety_ceiling)', () => {
  const { controller } = makeHarness({ policy: policy({ desired: 8, hard: 5 }) });
  const cs = Array.from({ length: 8 }, (_, i) => candidate({ jobId: `j${i}` }));
  const ds = controller.pump(cs);
  assert.equal(ds.filter((d) => d.state === 'active').length, 5);
  const q = ds.find((d) => d.state === 'queued');
  assert.ok(q);
  assert.equal(q.reason, 'hard_safety_ceiling');
});

test('memory reserve: no slots admitted while free memory is below the reserve', () => {
  const { controller, root } = makeHarness({ policy: policy({ reserve: 2048 }), freeMemoryMb: 1024 });
  const ds = controller.pump([candidate({ jobId: 'j1' })]);
  assert.equal(decisionOf(ds, 'j1').state, 'queued');
  assert.equal(decisionOf(ds, 'j1').reason, 'memory_reserve');
  // No lease was written.
  assert.deepEqual(listDir(root, 'leases'), []);
});

test('heavy cap: at most maxHeavyWorkers heavy workers; light slots are unaffected', () => {
  const { controller, root } = makeHarness({ policy: policy({ desired: 8, hard: 8, heavy: 2 }) });
  // Distinct work folders: this test isolates the heavy cap, and the derived
  // space-conflict rule (heavy/build sharing a folder) must not interfere.
  const cs = [
    candidate({ jobId: 'h1', resourceClass: 'heavy', workFolder: path.join(os.tmpdir(), 'wf-h1') }),
    candidate({ jobId: 'h2', resourceClass: 'heavy', workFolder: path.join(os.tmpdir(), 'wf-h2') }),
    candidate({ jobId: 'h3', resourceClass: 'heavy', workFolder: path.join(os.tmpdir(), 'wf-h3') }),
    candidate({ jobId: 'l1', resourceClass: 'light', workFolder: path.join(os.tmpdir(), 'wf-l1') }),
  ];
  const ds = controller.pump(cs);
  assert.equal(decisionOf(ds, 'h1').state, 'active');
  assert.equal(decisionOf(ds, 'h2').state, 'active');
  assert.equal(decisionOf(ds, 'h3').state, 'queued');
  assert.equal(decisionOf(ds, 'h3').reason, 'heavy_limit');
  assert.equal(decisionOf(ds, 'l1').state, 'active');
  // Only the two heavy + one light supervisor leases are live.
  assert.deepEqual(liveLeaseOwnerIds(root), ['h1', 'h2', 'l1']);
});

test('derived space conflict: same canonical workFolder blocks a second build/heavy', () => {
  const { controller } = makeHarness({ policy: policy({ desired: 8, hard: 8 }) });
  const folder = path.join(os.tmpdir(), 'wf-same');
  const ds = controller.pump([
    candidate({ jobId: 'b1', resourceClass: 'build', workFolder: folder }),
    candidate({ jobId: 'b2', resourceClass: 'build', workFolder: folder }),
    candidate({ jobId: 'h1', resourceClass: 'heavy', workFolder: folder }),
    candidate({ jobId: 'l1', resourceClass: 'light', workFolder: folder }),
  ]);
  assert.equal(decisionOf(ds, 'b1').state, 'active');
  assert.equal(decisionOf(ds, 'b2').state, 'queued');
  assert.equal(decisionOf(ds, 'b2').reason, 'derived_space_conflict');
  assert.equal(decisionOf(ds, 'h1').state, 'queued');
  assert.equal(decisionOf(ds, 'h1').reason, 'derived_space_conflict');
  assert.equal(decisionOf(ds, 'l1').state, 'active', 'light candidates share folders freely');
});

// ---------- concurrency: two controllers racing the last slot ----------

test('two controllers sharing one runtimeRoot: only one wins the last slot (in-process)', () => {
  const root = tmpRoot();
  const commonPolicy = policy({ desired: 2, hard: 2 });
  const mk = (): { controller: AdmissionController; launches: AdmissionCandidate[] } => {
    const launches: AdmissionCandidate[] = [];
    const controller = new AdmissionController({
      runtimeRoot: root,
      policy: commonPolicy,
      now: () => FIXED_NOW,
      launch: (c: AdmissionCandidate) => { launches.push(c); return { ...SUP }; },
      terminate: () => { /* no-op */ },
    });
    return { controller, launches };
  };
  const a = mk();
  const b = mk();
  // Fill 1 of 2 slots through a.
  assert.equal(a.controller.pump([candidate({ jobId: 'fill' })]).length, 1);
  assert.equal(a.launches.length, 1);
  // Both race for the last slot against the same runtimeRoot.
  const da = a.controller.pump([candidate({ jobId: 'race-1' })]);
  const db = b.controller.pump([candidate({ jobId: 'race-2' })]);
  const winners = [da[0].state, db[0].state].filter((s) => s === 'active').length;
  assert.equal(winners, 1, 'exactly one controller may activate the last slot');
  assert.equal(a.launches.length + b.launches.length, 2, 'each controller launched only its own winner');
});

test('two controllers racing the last slot across processes: exactly one active', async () => {
  const root = tmpRoot();
  // One slot occupied so the two racers contend for a single free slot.
  const seed = new AdmissionController({
    runtimeRoot: root,
    policy: policy({ desired: 2, hard: 2 }),
    now: () => FIXED_NOW,
    launch: () => ({ ...SUP }),
    terminate: () => { /* no-op */ },
  });
  assert.equal(seed.pump([candidate({ jobId: 'fill' })]).length, 1);

  // The compiled module is at dist-test/src/admission-controller.js; resolve
  // relative to this test file's dir (dist-test/test/).
  const moduleUrl = new URL('../src/admission-controller.js', import.meta.url).href;
  const script = `
    import { AdmissionController } from ${JSON.stringify(moduleUrl)};
    const root = ${JSON.stringify(root)};
    const controller = new AdmissionController({
      runtimeRoot: root,
      policy: { desiredWorkerConcurrency: 2, hardSafetyCeiling: 2, maxHeavyWorkers: 2, memoryReserveMb: 0 },
      now: () => ${FIXED_NOW},
      launch: () => ({ pid: ${process.pid}, pidStartedAt: 1 }),
      terminate: () => {},
    });
    const ds = controller.pump([{
      jobId: 'race', desiredWorkerConcurrency: null, resourceClass: 'light',
      priority: 0, backend: 'deepseek', profile: 'auto',
      workFolder: ${JSON.stringify(path.join(os.tmpdir(), 'wf-race'))},
      queuedAt: '2026-08-30T10:00:00.000Z',
    }]);
    console.log(JSON.stringify(ds[0]));
  `;
  const scriptFile = path.join(root, 'race.mjs');
  fs.writeFileSync(scriptFile, script);
  const run = async (): Promise<AdmissionDecision> => {
    const child = spawn(process.execPath, [scriptFile], {
      env: { ...process.env, ORCHESTRATOR_RUNTIME: root },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timedOut = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => { child.kill(); resolve(true); }, 15_000);
      child.on('exit', () => { clearTimeout(t); resolve(false); });
    });
    assert.equal(timedOut, false, `race child timed out: ${stderr}`);
    return JSON.parse(stdout) as AdmissionDecision;
  };
  const [da, db] = await Promise.all([run(), run()]);
  const winners = [da.state, db.state].filter((s) => s === 'active').length;
  assert.equal(winners, 1, `expected exactly one active, got ${winners}: ${JSON.stringify(da)} / ${JSON.stringify(db)}`);
  const loser = [da, db].find((d) => d.state === 'queued');
  assert.ok(loser, 'one loser expected');
  assert.equal(loser.reason, 'desired_limit');
});

// ---------- failure paths ----------

test('launch failure: lease released, fixed supervisor_spawn_failed, slot freed for the next candidate', () => {
  const { controller, launches, root } = makeHarness();
  let failNext = true;
  const originalLaunch = (controller as unknown as { launch: (c: AdmissionCandidate) => LaunchedSupervisor }).launch;
  (controller as unknown as { launch: (c: AdmissionCandidate) => LaunchedSupervisor }).launch = (c: AdmissionCandidate) => {
    launches.push(c);
    if (failNext) {
      failNext = false;
      throw new Error('spawn boom');
    }
    return { ...SUP };
  };
  try {
    const ds = controller.pump([
      candidate({ jobId: 'boom' }),
      candidate({ jobId: 'ok' }),
    ]);
    const boom = decisionOf(ds, 'boom');
    assert.equal(boom.state, 'failed');
    assert.equal(boom.admittedAt, null);
    assert.equal(boom.reason, 'supervisor_spawn_failed');
    // The failed candidate did not occupy the slot: the next candidate is admitted.
    assert.equal(decisionOf(ds, 'ok').state, 'active');
    assert.ok(decisionOf(ds, 'ok').admittedAt, 'second candidate is genuinely active');
    // And the failed candidate's lease is gone: only the winner holds a live lease.
    assert.deepEqual(liveLeaseOwnerIds(root), ['ok']);
  } finally {
    (controller as unknown as { launch: (c: AdmissionCandidate) => LaunchedSupervisor }).launch = originalLaunch;
  }
});

test('transfer failure: terminate callback invoked, lease released, fixed lease_transfer_failed', () => {
  // The controller holds its acquired lease under this explicit owner identity.
  const ownerPid = 424_242;
  const ownerPidStartedAt = 1_717;
  const { controller, terminated, root } = makeHarness({
    ownerPid,
    ownerPidStartedAt,
    terminate: (c: AdmissionCandidate, s: LaunchedSupervisor) => { terminated.push({ candidate: c, supervisor: s }); },
  });
  // Sabotage the handoff: the lease disappears between acquire and transfer
  // (as if a concurrent sweep archived it), so the controller-to-supervisor
  // transfer inside pump() fails with lease_not_found, and the controller's
  // best-effort release finds nothing left to release — no slot stays occupied.
  const manager = new AdmissionManager({ runtimeRoot: root });
  (controller as unknown as { launch: (c: AdmissionCandidate) => LaunchedSupervisor }).launch = (c: AdmissionCandidate) => {
    const res = manager.releaseLease({ jobId: c.jobId, pid: ownerPid, pidStartedAt: ownerPidStartedAt });
    assert.equal(res.ok, true, 'lease must exist and be held by the controller identity at launch time');
    return { ...SUP };
  };
  const ds = controller.pump([candidate({ jobId: 'j1' })]);
  const d = decisionOf(ds, 'j1');
  assert.equal(d.state, 'failed', 'fixed expression: failure decisions are failed');
  assert.equal(d.admittedAt, null, 'fixed expression: no admittedAt on a failed handoff');
  assert.equal(d.reason, 'lease_transfer_failed');
  assert.equal(terminated.length, 1, 'terminate invoked exactly once');
  assert.equal(terminated[0].candidate.jobId, 'j1');
  assert.deepEqual(terminated[0].supervisor, { ...SUP });
  assert.deepEqual(listDir(root, 'leases'), [], 'failed handoff leaves no lease behind');
});

test('failure codes are the fixed literals (no free-form reasons)', () => {
  const codes: AdmissionFailureCode[] = ['supervisor_spawn_failed', 'lease_transfer_failed'];
  assert.deepEqual(codes, ['supervisor_spawn_failed', 'lease_transfer_failed']);
});

// ---------- sanitization ----------

test('decisions never expose workFolder, pid, pidStartedAt or other internals', () => {
  const { controller } = makeHarness();
  const folder = path.join(os.tmpdir(), 'wf-secret-42');
  const ds = controller.pump([
    candidate({ jobId: 'j1', workFolder: folder }),
    candidate({ jobId: 'j2', workFolder: folder }),
  ]);
  const json = JSON.stringify(ds);
  assert.ok(!json.includes(folder), 'workFolder must not surface in decisions');
  assert.ok(!json.includes(String(5555)), 'supervisor pid must not surface');
  assert.ok(!json.includes(String(FIXED_NOW - 10_000)), 'pidStartedAt must not surface');
  assert.ok(!json.includes('deepseek'), 'backend must not surface');
  for (const d of ds) {
    const keys = Object.keys(d as unknown as Record<string, unknown>);
    assert.ok(!keys.includes('workFolder'), 'no workFolder key');
    assert.ok(!keys.includes('pid'), 'no pid key');
    assert.ok(!keys.includes('pidStartedAt'), 'no pidStartedAt key');
    assert.ok(!keys.includes('backend') && !keys.includes('profile'), 'no backend/profile key');
    assert.deepEqual(keys.sort(), ['active', 'admittedAt', 'desired', 'jobId', 'queued', 'reason', 'resourceLimit', 'state']);
  }
});
