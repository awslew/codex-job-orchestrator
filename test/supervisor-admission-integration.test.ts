// Wave 4B2b3 minimal end-to-end test: ONE job started through the real
// scheduler (admission flag on, desired=1) with the fake claude, so the
// detached supervisor runs the real AdmissionSupervisorLease lifecycle:
// waitForOwnership -> startHeartbeat -> (worker succeeds) -> stopAndRelease.
// Assertions cover the supervisor-side contract only: the worker terminal
// status, the job's admissionState released, the lease archived under
// admission/released/ (never left under admission/leases/), and no leftover
// supervisor/worker processes. The controller decision matrix (priority,
// hard ceiling, heavy class, derived-space conflict, spawn/transfer failure)
// lives in the controller suite — not here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rt = path.join(os.tmpdir(), `orc-supadm-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });

// Every env key this file writes (runtime, admission flag, viewer, jitter,
// memory reserve) is captured up front — before anything sets it — and
// restored exactly in the test cleanup (a key that did not exist before the
// suite must be deleted again, never re-set).
const savedEnv: Record<string, string | undefined> = {
  ORCHESTRATOR_RUNTIME: process.env.ORCHESTRATOR_RUNTIME,
  ORCHESTRATOR_ADMISSION_CONTROL: process.env.ORCHESTRATOR_ADMISSION_CONTROL,
  OPEN_LIVE_VIEW: process.env.OPEN_LIVE_VIEW,
  ORCHESTRATOR_START_JITTER_MAX_MS: process.env.ORCHESTRATOR_START_JITTER_MAX_MS,
  ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB: process.env.ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB,
};

process.env.ORCHESTRATOR_RUNTIME = rt;
// Wave 4B2b3 gate: admission control on for the whole test process.
process.env.ORCHESTRATOR_ADMISSION_CONTROL = '1';
// Tests must not pop live-view windows; deterministic spawns.
process.env.OPEN_LIVE_VIEW = '0';
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';
// Pin the admission memory reserve to 0: the policy must not depend on the
// machine's live free memory for this integration run.
process.env.ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB = '0';

import { startJob } from '../src/scheduler.js';
import { readJob } from '../src/job-store.js';
import type { StartParams } from '../src/router.js';

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');

function fakeParams(over: Partial<StartParams> & { desiredWorkerConcurrency?: number | null } = {}): StartParams {
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

function fakeEnv(): Record<string, string> {
  return { FAKE_CLAUDE_RUN_SECONDS: '1', FAKE_CLAUDE_EXIT_CODE: '0' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('flag on: supervisor waits for the transferred lease, heartbeats, worker succeeds, lease released and archived', async (t) => {
  t.after(() => {
    for (const [key, saved] of Object.entries(savedEnv)) {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
    fs.rmSync(rt, { recursive: true, force: true });
  });

  const { job } = startJob(fakeParams({ extraEnv: fakeEnv(), desiredWorkerConcurrency: 1 }));
  assert.equal(job.admissionState, 'active', 'the pump admitted the single candidate immediately');
  assert.equal(job.desiredWorkerConcurrency, 1, 'explicit desired concurrency persisted');

  // The supervisor is already spawned detached; wait for the worker to finish
  // and the supervisor to finalize the job (fake claude exits 0 after 1s).
  const deadline = Date.now() + 15000;
  let record = readJob(job.jobId);
  while (Date.now() < deadline && (!record || !record.endedAt)) {
    await sleep(300);
    record = readJob(job.jobId);
  }
  assert.ok(record, `job record readable: ${job.jobId}`);
  assert.ok(record.endedAt, `job finalized within 15s (status=${record.status})`);
  assert.equal(record.status, 'succeeded', 'fake claude exit 0 -> succeeded');

  // Supervisor-side admission contract: the lease was proven ours, kept alive
  // while the worker ran, and handed back on exit — never left in place.
  assert.equal(record.admissionState, 'released', 'admissionState dropped to released on exit');
  assert.equal(record.activeWorkers, 0, 'no active workers after the worker exited');
  assert.equal(record.substatus, null, 'succeeded carries no substatus');

  const leasesDir = path.join(rt, 'admission', 'leases');
  const releasedDir = path.join(rt, 'admission', 'released');
  assert.equal(fs.existsSync(path.join(leasesDir, `${job.jobId}.json`)), false, 'lease no longer under admission/leases');
  assert.equal(fs.existsSync(path.join(releasedDir, `${job.jobId}.json`)), true, 'lease archived under admission/released');

  // Process hygiene: neither the supervisor nor the worker may survive.
  const supervisorPid = record.supervisorPid;
  if (Number.isInteger(supervisorPid) && (supervisorPid as number) > 0) {
    let alive = true;
    try {
      process.kill(supervisorPid as number, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, 'supervisor process exited');
  }
});
