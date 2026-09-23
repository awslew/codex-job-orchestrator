// test/admission-supervisor-lease.test.ts
// Wave4B2b1: supervisor-side admission lease lifecycle component.
//
// Every scenario runs against a real AdmissionManager on a temp runtimeRoot
// with an injected clock and a clock-advancing (no-real-wait) sleep — nothing
// here waits on the real 5s ownership timeout or the 20s heartbeat interval.
//
// Coverage: transfer window (owner_mismatch then success), lease_not_found
// then creation, ownership timeout, bad-lease/invalid-job-id fail-fast,
// heartbeat TTL refresh, duplicate start = single timer, owner mismatch never
// releases someone else's lease, stop archives to released/, double-stop
// idempotency, and public-result sanitization (no runtimeRoot / PID identity /
// paths / env).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AdmissionManager } from '../src/admission.js';
import {
  AdmissionSupervisorLease,
  type AdmissionLeaseLifecycleOptions,
} from '../src/admission-supervisor-lease.js';

// ---------- helpers ----------

let tmpSeq = 0;
function tmpRoot(): string {
  tmpSeq += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `asl-test-${process.pid}-${tmpSeq}-`));
}

const POLICY = {
  desiredWorkerConcurrency: 8,
  hardSafetyCeiling: 8,
  maxHeavyWorkers: 2,
  memoryReserveMb: 0,
};

interface Fixture {
  manager: AdmissionManager;
  root: string;
  clock: { now: number };
  /** Options shared by all components in the fixture (clock + advancing sleep). */
  base: Omit<AdmissionLeaseLifecycleOptions, 'jobId' | 'owner'>;
}

function makeFixture(): Fixture {
  const root = tmpRoot();
  const clock = { now: 1_000 };
  const manager = new AdmissionManager({ runtimeRoot: root, now: () => clock.now });
  const base: Omit<AdmissionLeaseLifecycleOptions, 'jobId' | 'owner'> = {
    runtimeRoot: root,
    manager,
    now: () => clock.now,
    // Each poll iteration advances the injected clock by the poll step, so
    // timeout loops terminate without any real wait.
    sleep: async () => {
      clock.now += 5;
    },
  };
  return { manager, root, clock, base };
}

function component(
  fixture: Fixture,
  jobId: string,
  pid: number,
  pidStartedAt: number,
  over: Partial<Omit<AdmissionLeaseLifecycleOptions, 'jobId' | 'owner'>> = {},
): AdmissionSupervisorLease {
  return new AdmissionSupervisorLease({ ...fixture.base, ...over, jobId, owner: { pid, pidStartedAt } });
}

/** Simulate the leader: acquire a lease for the given owner identity. */
function acquireFor(fixture: Fixture, jobId: string, pid: number, pidStartedAt: number): void {
  const res = fixture.manager.acquireAdmissionLease(
    POLICY,
    { jobId, resourceClass: 'light', backend: 'deepseek', profile: 'auto', workFolder: path.join(fixture.root, 'wf'), pid, pidStartedAt },
    Number.POSITIVE_INFINITY,
  );
  assert.equal(res.ok, true);
}

function readLeaseFile(root: string, jobId: string): Record<string, unknown> | null {
  const p = path.join(root, 'admission', 'leases', `${jobId}.json`);
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>) : null;
}

function listDir(root: string, sub: string): string[] {
  const p = path.join(root, 'admission', sub);
  return fs.existsSync(p) ? fs.readdirSync(p).sort() : [];
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ownedResult(jobId: string, heartbeatAt: number, expiresAt: number) {
  return { ok: true, state: 'owned' as const, reason: null, jobId, heartbeatAt, expiresAt };
}

function failedResult(jobId: string, reason: string) {
  return { ok: false, state: 'failed' as const, reason, jobId, heartbeatAt: null, expiresAt: null };
}

function stoppedResult(jobId: string, reason: string) {
  return { ok: false, state: 'stopped' as const, reason, jobId, heartbeatAt: null, expiresAt: null };
}

/** Counts heartbeatLease calls so a duplicate timer is observable. */
class CountingManager {
  heartbeats = 0;
  constructor(private readonly inner: AdmissionManager) {}
  heartbeatLease(owner: { jobId: string; pid: number; pidStartedAt: number }) {
    this.heartbeats += 1;
    return this.inner.heartbeatLease(owner);
  }
  releaseLease(owner: { jobId: string; pid: number; pidStartedAt: number }) {
    return this.inner.releaseLease(owner);
  }
}

// ---------- waitForOwnership ----------

test('asl: owner_mismatch during transfer window, then ownership is won', async () => {
  const f = makeFixture();
  const JOB = 'job-xfer', OLD_PID = 111, OLD_START = 55, NEW_PID = 222, NEW_START = 99;
  acquireFor(f, JOB, OLD_PID, OLD_START);

  let transferred = false;
  const c = component(f, JOB, NEW_PID, NEW_START, {
    // The leader lands the transfer mid-wait (before the 1500 deadline).
    sleep: async () => {
      f.clock.now += 5;
      if (f.clock.now >= 1490 && !transferred) {
        transferred = true;
        const r = f.manager.transferLeaseOwner(
          { jobId: JOB, pid: OLD_PID, pidStartedAt: OLD_START },
          { jobId: JOB, pid: NEW_PID, pidStartedAt: NEW_START },
        );
        assert.equal(r.ok, true);
      }
    },
  });

  const res = await c.waitForOwnership(500, 5);
  assert.deepEqual(res, ownedResult(JOB, 1490, 1490 + 60_000));
  assert.equal(c.stateValue, 'owned');
  assert.equal(transferred, true);
});

test('asl: lease_not_found then the leader creates the lease — owned', async () => {
  const f = makeFixture();
  const JOB = 'job-created', PID = 333, START = 77;

  let created = false;
  const c = component(f, JOB, PID, START, {
    sleep: async () => {
      f.clock.now += 5;
      if (f.clock.now >= 1500 && !created) {
        created = true;
        acquireFor(f, JOB, PID, START);
      }
    },
  });

  const res = await c.waitForOwnership(1000, 5);
  assert.deepEqual(res, ownedResult(JOB, 1500, 1500 + 60_000));
  assert.equal(c.stateValue, 'owned');
  assert.equal(created, true);
});

test('asl: no lease ever lands — fixed ownership_timeout, never silent success', async () => {
  const f = makeFixture();
  const JOB = 'job-ghost', PID = 444, START = 88;
  const c = component(f, JOB, PID, START);

  const res = await c.waitForOwnership(500, 5);
  assert.deepEqual(res, failedResult(JOB, 'ownership_timeout'));
  assert.equal(c.stateValue, 'failed');
  // Nothing was created, moved or deleted by the failed wait.
  assert.deepEqual(listDir(f.root, 'leases'), []);
  assert.deepEqual(listDir(f.root, 'released'), []);
  // A failed lifecycle can never release anyone's lease.
  assert.deepEqual(await c.stopAndRelease(), stoppedResult(JOB, 'already_stopped'));
  assert.equal(c.stateValue, 'stopped');
});

test('asl: bad lease file and invalid job id fail fast as fixed failures', async () => {
  const f = makeFixture();
  const JOB = 'job-corrupt', PID = 555, START = 11;
  fs.writeFileSync(path.join(f.root, 'admission', 'leases', `${JOB}.json`), 'garbage');
  const c = component(f, JOB, PID, START);

  const res = await c.waitForOwnership(500, 5);
  assert.deepEqual(res, failedResult(JOB, 'bad_lease_file'));
  assert.equal(c.stateValue, 'failed');
  // The corrupt file is never touched (no deletion, no move).
  assert.equal(fs.readFileSync(path.join(f.root, 'admission', 'leases', `${JOB}.json`), 'utf8'), 'garbage');

  // invalid_job_id fails immediately too — no retries, no timeout wait.
  const bad = component(f, '../escape', PID, START);
  assert.deepEqual(await bad.waitForOwnership(500, 5), failedResult('../escape', 'invalid_job_id'));
  assert.equal(bad.stateValue, 'failed');
});

// ---------- heartbeat ----------

test('asl: heartbeat refreshes TTL on the lease and reports no error', async (t) => {
  const f = makeFixture();
  const JOB = 'job-hb', PID = 666, START = 22;
  acquireFor(f, JOB, PID, START);
  const c = component(f, JOB, PID, START);
  // Guarantee the timer is always cleared, even if an assertion fails first.
  t.after(async () => {
    await c.stopAndRelease();
  });

  assert.equal(await c.waitForOwnership(100, 5).then((r) => r.ok), true);
  // Advance the injected clock so the interval ticks are observable.
  f.clock.now = 2_000_000;
  const before = readLeaseFile(f.root, JOB) as { heartbeatAt: number; expiresAt: number };

  assert.equal(c.startHeartbeat(10), true, 'heartbeat starts once owned');
  await realSleep(40);
  const after = readLeaseFile(f.root, JOB) as { heartbeatAt: number; expiresAt: number };
  assert.ok(after.heartbeatAt > before.heartbeatAt, 'heartbeatAt advanced');
  assert.ok(after.expiresAt > before.expiresAt, 'expiresAt advanced with the TTL');
  assert.equal(c.lastError, null, 'healthy heartbeats leave no error');

  assert.deepEqual(await c.stopAndRelease(), stoppedResult(JOB, 'released'));
});

test('asl: duplicate start is refused and exactly one timer ever exists', async (t) => {
  const f = makeFixture();
  const JOB = 'job-dup', PID = 777, START = 33;
  acquireFor(f, JOB, PID, START);
  const counting = new CountingManager(f.manager);
  const c = component(f, JOB, PID, START, { manager: counting as unknown as AdmissionManager });
  t.after(async () => {
    await c.stopAndRelease();
  });

  assert.equal(c.startHeartbeat(10), false, 'no heartbeat before ownership');
  assert.equal(await c.waitForOwnership(100, 5).then((r) => r.ok), true);

  assert.equal(c.startHeartbeat(10), true);
  await realSleep(120);
  const firstTicks = counting.heartbeats;
  assert.ok(firstTicks >= 4, `single timer is ticking (${firstTicks} ticks)`);

  assert.equal(c.startHeartbeat(10), false, 'duplicate start is refused — no second timer');
  const afterDup = counting.heartbeats;
  await realSleep(120);
  const secondTicks = counting.heartbeats - afterDup;
  // One timer in ~120ms ≈ the first window's rate; a second timer would
  // roughly double the tick count.
  assert.ok(secondTicks <= firstTicks + 4, `heartbeat rate did not double (first=${firstTicks}, second=${secondTicks})`);
  assert.equal(c.lastError, null);

  assert.deepEqual(await c.stopAndRelease(), stoppedResult(JOB, 'released'));
  const afterStop = counting.heartbeats;
  await realSleep(120);
  assert.equal(counting.heartbeats, afterStop, 'stop clears the timer — nothing ticks after stop');
});

// ---------- stopAndRelease ----------

test('asl: owner mismatch never releases someone else’s lease', async () => {
  const f = makeFixture();
  const JOB = 'job-mine', MY_PID = 888, MY_START = 44, THIRD_PID = 999, THIRD_START = 66;
  acquireFor(f, JOB, MY_PID, MY_START);
  const c = component(f, JOB, MY_PID, MY_START);

  // The leader re-transfers the lease to another worker before our stop lands.
  const tr = f.manager.transferLeaseOwner(
    { jobId: JOB, pid: MY_PID, pidStartedAt: MY_START },
    { jobId: JOB, pid: THIRD_PID, pidStartedAt: THIRD_START },
  );
  assert.equal(tr.ok, true);

  const res = await c.stopAndRelease();
  assert.deepEqual(res, stoppedResult(JOB, 'owner_mismatch'));
  // The lease stays exactly where it is, owned by the third party — no
  // deletion, no archival, nothing touched.
  const lease = readLeaseFile(f.root, JOB) as { pid: number; pidStartedAt: number };
  assert.equal(lease.pid, THIRD_PID);
  assert.equal(lease.pidStartedAt, THIRD_START);
  assert.deepEqual(listDir(f.root, 'leases'), [JOB + '.json']);
  assert.deepEqual(listDir(f.root, 'released'), []);

  // The lease still works for its true owner.
  const hb = f.manager.heartbeatLease({ jobId: JOB, pid: THIRD_PID, pidStartedAt: THIRD_START });
  assert.equal(hb.ok, true);
});

test('asl: stop archives the lease to released/ and is idempotent', async () => {
  const f = makeFixture();
  const JOB = 'job-stop', PID = 1000, START = 50;
  acquireFor(f, JOB, PID, START);
  const c = component(f, JOB, PID, START);
  assert.equal(await c.waitForOwnership(100, 5).then((r) => r.ok), true);

  const first = await c.stopAndRelease();
  assert.deepEqual(first, stoppedResult(JOB, 'released'));
  assert.deepEqual(listDir(f.root, 'leases'), []);
  assert.deepEqual(listDir(f.root, 'released'), [JOB + '.json']);
  const archived = JSON.parse(fs.readFileSync(path.join(f.root, 'admission', 'released', `${JOB}.json`), 'utf8')) as { pid: number };
  assert.equal(archived.pid, PID, 'lease content preserved in released/');
  assert.equal(c.stateValue, 'stopped');

  // Second stop is idempotent: already_stopped, nothing moves again.
  const second = await c.stopAndRelease();
  assert.deepEqual(second, stoppedResult(JOB, 'already_stopped'));
  assert.deepEqual(listDir(f.root, 'released'), [JOB + '.json']);
  assert.equal(c.stateValue, 'stopped');
});

// ---------- output sanitization ----------

test('asl: public results expose only ok/state/reason/jobId/heartbeatAt/expiresAt', async () => {
  const f = makeFixture();
  const JOB = 'job-secret', PID = 7777, START = 123_456_789;
  acquireFor(f, JOB, PID, START);
  const c = component(f, JOB, PID, START);

  assert.equal(c.stateValue, 'uninitialized');
  const waitRes = await c.waitForOwnership(100, 5);
  assert.equal(c.stateValue, 'owned');
  assert.equal(c.startHeartbeat(10), true);
  const stopRes = await c.stopAndRelease();
  assert.equal(c.stateValue, 'stopped');

  const payload = JSON.stringify([waitRes, stopRes]);
  // Fixed result shape only.
  for (const res of [waitRes, stopRes]) {
    assert.deepEqual(Object.keys(res).sort(), ['expiresAt', 'heartbeatAt', 'jobId', 'ok', 'reason', 'state']);
  }
  // Nothing sensitive: no root path, temp prefix, internal field names
  // (workFolder / pidStartedAt / runtimeRoot), or the process identity.
  for (const sensitive of [
    f.root,
    'asl-test-',
    'workFolder',
    'pidStartedAt',
    'runtimeRoot',
    String(PID),
    String(START),
  ]) {
    assert.ok(!payload.includes(sensitive), `result leaks "${sensitive}"`);
  }
});
