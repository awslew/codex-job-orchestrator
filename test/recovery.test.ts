// Stage 6 recovery-claim + bootstrap-checkpoint tests (public recovery.ts API).
//
// Covers: real O_EXCL claim acquisition (same-path concurrency across processes
// yields exactly one winner), owner-matched release, the claim-arbitration
// predicates (live / verified-dead / stale / blocks), safe stealing of dead /
// identity-mismatch / corrupt / invalid claims, conservative refusal to displace
// a possibly-alive supervisor or an identity-verified live owner, lease-expiry
// as a bounded backstop only for the UNVERIFIABLE case, bounded EPERM/EBUSY
// retry on both the O_EXCL open and the steal rename, and the bootstrap
// checkpoint helpers. All tests use an isolated ORCHESTRATOR_RUNTIME and an
// injectable clock + inspector — no real PID reuse, no real waiting, no real
// runtime touched; the temporary runtime is removed at the end of the file.
//
// Timer/handle discipline: every API under test is synchronous (acquireClaim,
// releaseClaim, readClaim, the claim predicates, the bootstrap helpers). The
// only async is the cross-process O_EXCL race test, whose children exit
// explicitly and are awaited; nothing here installs an interval.
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rt = path.join(os.tmpdir(), `orc-recovery-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;

import {
  BOOTSTRAP_STAGES,
  newBootstrap,
  isBootstrapStage,
  isValidBootstrap,
  CLAIM_SCHEMA_VERSION,
  claimFilePath,
  isValidClaim,
  readClaim,
  claimOwnerLive,
  claimOwnerVerifiedDead,
  claimIsStale,
  claimBlocksAcquisition,
  acquireClaim,
  releaseClaim,
  claimTestHooks,
  type ClaimKind,
  type ClaimTestHooks,
  type RecoveryClaim,
  type AcquireResult,
} from '../src/recovery.js';
import type { ProcessInspector } from '../src/registry.js';
import { claimsDir } from '../src/config.js';

const NOW = 1_700_000_000_000; // fixed "now" for most tests
const LEASE_MS = 60_000;

beforeEach(() => {
  // acquireClaim does NOT create the claims dir itself (production calls
  // ensureRuntimeDirs); tests must prepare it and start from an empty dir.
  fs.mkdirSync(claimsDir(), { recursive: true });
  for (const f of fs.readdirSync(claimsDir())) {
    fs.rmSync(path.join(claimsDir(), f), { recursive: true, force: true });
  }
});

after(() => {
  try {
    fs.rmSync(rt, { recursive: true, force: true });
  } catch {
    /* best effort: temp dir cleanup must never fail the run */
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeClaim(over: Partial<RecoveryClaim> = {}): RecoveryClaim {
  return {
    schemaVersion: 1,
    kind: 'recover',
    jobId: 'job-claim',
    ownerId: 'owner-a',
    ownerPid: 42_001,
    ownerStartedAt: new Date(NOW - 60_000).toISOString(),
    acquiredAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + LEASE_MS).toISOString(),
    ...over,
  } as RecoveryClaim;
}

function makeInspector(alive: Set<number>, starts: Map<number, number>): ProcessInspector {
  return {
    exists: (pid) => alive.has(pid),
    startTime: (pid) => starts.get(pid) ?? null,
  };
}

const NO_INSPECTOR = makeInspector(new Set(), new Map());

function writeClaim(claim: RecoveryClaim, kind: ClaimKind): void {
  fs.mkdirSync(claimsDir(), { recursive: true });
  fs.writeFileSync(claimFilePath(claim.jobId, kind), JSON.stringify(claim, null, 2), 'utf8');
}

function claimFiles(): string[] {
  if (!fs.existsSync(claimsDir())) return [];
  return fs.readdirSync(claimsDir());
}

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

// Runs fn with fault-injection hooks installed, then restores the previous
// hooks. node:test runs tests in a file sequentially, so the shared hooks
// object is safe as long as every test restores it. Sleep is stubbed to a noop
// so bounded retries never actually wait.
function withClaimHooks<T>(hooks: Partial<ClaimTestHooks>, fn: () => T): T {
  const prev: ClaimTestHooks = { ...claimTestHooks };
  Object.assign(claimTestHooks, hooks, { sleep: hooks.sleep ?? (() => {}) });
  try {
    return fn();
  } finally {
    claimTestHooks.beforeOpen = prev.beforeOpen;
    claimTestHooks.beforeRename = prev.beforeRename;
    claimTestHooks.sleep = prev.sleep;
  }
}

function acquire(
  jobId: string,
  kind: ClaimKind,
  ownerId: string,
  over: Partial<{ now: () => number; inspector: ProcessInspector; leaseMs: number }> = {},
): AcquireResult {
  return acquireClaim({
    jobId,
    kind,
    ownerId,
    now: over.now ?? (() => NOW),
    leaseMs: over.leaseMs ?? LEASE_MS,
    inspector: over.inspector ?? NO_INSPECTOR,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap checkpoint helpers
// ---------------------------------------------------------------------------

test('BOOTSTRAP_STAGES is the documented monotonic progression; isBootstrapStage validates', () => {
  assert.deepEqual(BOOTSTRAP_STAGES, ['job_persisted', 'supervisor_acknowledged', 'worker_spawned']);
  for (const s of BOOTSTRAP_STAGES) assert.equal(isBootstrapStage(s), true);
  assert.equal(isBootstrapStage('job_persisted'), true);
  assert.equal(isBootstrapStage('worker_spawned'), true);
  assert.equal(isBootstrapStage('not_a_stage'), false);
  assert.equal(isBootstrapStage(''), false);
  assert.equal(isBootstrapStage(null), false);
  assert.equal(isBootstrapStage(undefined), false);
});

test('newBootstrap stamps a fresh id per resume and serializes only whitelisted fields', () => {
  const at = '2026-08-13T00:00:00.000Z';
  const a = newBootstrap('job_persisted', at);
  const b = newBootstrap('supervisor_acknowledged', at);
  assert.deepEqual(Object.keys(a).sort(), ['bootstrapId', 'stage', 'updatedAt'], 'no sensitive fields');
  assert.equal(a.stage, 'job_persisted');
  assert.equal(a.updatedAt, at);
  assert.ok(a.bootstrapId.length > 0);
  assert.notEqual(a.bootstrapId, b.bootstrapId, 'each bootstrap attempt stamps a fresh id');
});

test('isValidBootstrap accepts well-formed checkpoints and rejects malformed ones', () => {
  assert.equal(isValidBootstrap({ stage: 'worker_spawned', bootstrapId: 'id', updatedAt: 't' }), true);
  assert.equal(isValidBootstrap({ stage: 'job_persisted', bootstrapId: 'id', updatedAt: 't' }), true);
  assert.equal(isValidBootstrap(null), false);
  assert.equal(isValidBootstrap(undefined), false);
  assert.equal(isValidBootstrap('x'), false);
  assert.equal(isValidBootstrap({}), false);
  assert.equal(isValidBootstrap({ stage: 'job_persisted', bootstrapId: 'id' }), false, 'missing updatedAt');
  assert.equal(isValidBootstrap({ stage: 'not_a_stage', bootstrapId: 'id', updatedAt: 't' }), false);
  assert.equal(isValidBootstrap({ stage: 'job_persisted', bootstrapId: 5, updatedAt: 't' }), false);
  assert.equal(
    isValidBootstrap({ stage: 'job_persisted', bootstrapId: 'id', updatedAt: 't', extra: 1 }),
    true,
    'extra fields do not invalidate a stored checkpoint',
  );
});

// ---------------------------------------------------------------------------
// Claim validity / reads
// ---------------------------------------------------------------------------

test('isValidClaim accepts a full claim and rejects malformed ones', () => {
  assert.equal(isValidClaim(makeClaim()), true);
  assert.equal(isValidClaim(null), false);
  assert.equal(isValidClaim({}), false);
  assert.equal(
    isValidClaim({ schemaVersion: 2, kind: 'recover', jobId: 'j', ownerId: 'o', ownerPid: 1, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 'e' }),
    false,
    'wrong schemaVersion',
  );
  assert.equal(
    isValidClaim({ schemaVersion: 1, kind: 'bogus', jobId: 'j', ownerId: 'o', ownerPid: 1, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 'e' }),
    false,
    'wrong kind',
  );
  assert.equal(
    isValidClaim({ schemaVersion: 1, kind: 'recover', jobId: '', ownerId: 'o', ownerPid: 1, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 'e' }),
    false,
    'empty jobId',
  );
  assert.equal(
    isValidClaim({ schemaVersion: 1, kind: 'recover', jobId: 'j', ownerId: 'o', ownerPid: -1, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 'e' }),
    false,
    'non-positive pid',
  );
  assert.equal(
    isValidClaim({ schemaVersion: 1, kind: 'recover', jobId: 'j', ownerId: 'o', ownerPid: 1.5, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 'e' }),
    false,
    'non-integer pid',
  );
  assert.equal(
    isValidClaim({ schemaVersion: 1, kind: 'recover', jobId: 'j', ownerId: 'o', ownerPid: 1, ownerStartedAt: 's', acquiredAt: 'a', expiresAt: 123 }),
    false,
    'non-string timestamp',
  );
});

test('readClaim: missing, corrupt, and schema-invalid files all read as null; a valid claim reads back', () => {
  assert.equal(readClaim('rd-missing', 'recover'), null);
  fs.writeFileSync(claimFilePath('rd-corrupt', 'recover'), '{not json', 'utf8');
  assert.equal(readClaim('rd-corrupt', 'recover'), null);
  fs.writeFileSync(claimFilePath('rd-invalid', 'recover'), JSON.stringify({ schemaVersion: 1 }), 'utf8');
  assert.equal(readClaim('rd-invalid', 'recover'), null);
  const claim = makeClaim({ jobId: 'rd-valid' });
  writeClaim(claim, 'recover');
  assert.deepEqual(readClaim('rd-valid', 'recover'), claim);
});

// ---------------------------------------------------------------------------
// Claim-arbitration predicates (pure, injectable inspector)
// ---------------------------------------------------------------------------

test('claimOwnerLive: only an identity-matching process is live; our own claim is trivially live', () => {
  const match = makeClaim({ ownerPid: 42_001 });
  assert.equal(claimOwnerLive(match, makeInspector(new Set([42_001]), new Map([[42_001, NOW - 60_000]])), 5000), true);
  assert.equal(claimOwnerLive(match, makeInspector(new Set(), new Map()), 5000), false, 'dead pid is not live');
  const reused = makeClaim({ ownerPid: 42_003, ownerStartedAt: new Date(NOW - 60_000).toISOString() });
  assert.equal(claimOwnerLive(reused, makeInspector(new Set([42_003]), new Map([[42_003, NOW - 10_000]])), 5000), false, 'PID reused');
  assert.equal(claimOwnerLive(match, makeInspector(new Set([42_001]), new Map()), 5000), false, 'unverifiable start time is never live');
  assert.equal(claimOwnerLive(makeClaim({ ownerPid: process.pid }), NO_INSPECTOR, 5000), true, 'our own claim is live');
});

test('claimOwnerVerifiedDead: dead pid or identity mismatch is provably gone; unverifiable is not', () => {
  assert.equal(claimOwnerVerifiedDead(null, NO_INSPECTOR, 5000), true, 'no claim -> nothing to protect');
  assert.equal(claimOwnerVerifiedDead({ ...makeClaim(), ownerId: undefined } as unknown as RecoveryClaim, NO_INSPECTOR, 5000), true, 'invalid claim cannot be a live owner');
  assert.equal(claimOwnerVerifiedDead(makeClaim({ ownerPid: 42_001 }), makeInspector(new Set(), new Map()), 5000), true, 'dead pid');
  assert.equal(
    claimOwnerVerifiedDead(
      makeClaim({ ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString() }),
      makeInspector(new Set([42_001]), new Map([[42_001, NOW - 10_000]])),
      5000,
    ),
    true,
    'PID reused (start time mismatch)',
  );
  assert.equal(claimOwnerVerifiedDead(makeClaim({ ownerPid: 42_001 }), makeInspector(new Set([42_001]), new Map()), 5000), false, 'exists but unverifiable -> possibly alive');
  assert.equal(
    claimOwnerVerifiedDead(
      makeClaim({ ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString() }),
      makeInspector(new Set([42_001]), new Map([[42_001, NOW - 60_000]])),
      5000,
    ),
    false,
    'identity-verified live',
  );
  assert.equal(claimOwnerVerifiedDead(makeClaim({ ownerPid: process.pid }), NO_INSPECTOR, 5000), false, 'our own claim is live');
});

test('claimIsStale: corrupt/dead are stale; a verified-live owner is never stale; lease is only the unverifiable backstop', () => {
  assert.equal(claimIsStale(null, NO_INSPECTOR, NOW, 5000), true);
  assert.equal(claimIsStale(makeClaim({ ownerPid: 42_001 }), makeInspector(new Set(), new Map()), NOW, 5000), true, 'dead pid');
  const liveExpired = makeClaim({ ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString() });
  assert.equal(
    claimIsStale(liveExpired, makeInspector(new Set([42_001]), new Map([[42_001, NOW - 60_000]])), NOW + 10_000_000, 5000),
    false,
    'verified-live owner is never stale even far past the lease',
  );
  const unver = makeClaim({ ownerPid: 42_001 });
  assert.equal(claimIsStale(unver, makeInspector(new Set([42_001]), new Map()), NOW, 5000), false, 'unverifiable + fresh lease -> not stale');
  assert.equal(claimIsStale(unver, makeInspector(new Set([42_001]), new Map()), NOW + 2 * LEASE_MS, 5000), true, 'unverifiable + expired lease -> stale');
});

test('claimBlocksAcquisition: corrupt/dead never block; unverifiable supervisor always blocks; recover uses the lease backstop', () => {
  assert.equal(claimBlocksAcquisition(null, 'recover', NO_INSPECTOR, NOW, 5000), false, 'corrupt/missing -> stealable');
  assert.equal(claimBlocksAcquisition(makeClaim({ ownerPid: 42_001 }), 'recover', makeInspector(new Set(), new Map()), NOW, 5000), false, 'dead owner -> stealable');
  assert.equal(claimBlocksAcquisition(makeClaim({ ownerPid: 42_001 }), 'supervisor', makeInspector(new Set(), new Map()), NOW, 5000), false, 'dead supervisor is stealable too');
  const unver = makeClaim({ ownerPid: 42_001 });
  assert.equal(
    claimBlocksAcquisition(unver, 'supervisor', makeInspector(new Set([42_001]), new Map()), NOW + 2 * LEASE_MS, 5000),
    true,
    'possibly-alive supervisor blocks forever',
  );
  assert.equal(claimBlocksAcquisition(unver, 'recover', makeInspector(new Set([42_001]), new Map()), NOW, 5000), true, 'unverifiable recover + fresh lease blocks');
  assert.equal(claimBlocksAcquisition(unver, 'recover', makeInspector(new Set([42_001]), new Map()), NOW + 2 * LEASE_MS, 5000), false, 'unverifiable recover + expired lease stealable');
  const live = makeClaim({ ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString() });
  assert.equal(
    claimBlocksAcquisition(live, 'recover', makeInspector(new Set([42_001]), new Map([[42_001, NOW - 60_000]])), NOW + 2 * LEASE_MS, 5000),
    true,
    'verified-live owner blocks even past the lease',
  );
});

// ---------------------------------------------------------------------------
// acquireClaim end-to-end
// ---------------------------------------------------------------------------

test('acquireClaim: a fresh O_EXCL acquire writes a valid, whitelisted claim', () => {
  const jobId = 'acq-fresh';
  assert.equal(acquire(jobId, 'recover', 'owner-new').status, 'acquired');
  const raw = fs.readFileSync(claimFilePath(jobId, 'recover'), 'utf8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['acquiredAt', 'expiresAt', 'jobId', 'kind', 'ownerId', 'ownerPid', 'ownerStartedAt', 'schemaVersion'],
    'claim serializes exactly the whitelisted fields',
  );
  assert.equal(parsed.schemaVersion, CLAIM_SCHEMA_VERSION);
  assert.equal(parsed.kind, 'recover');
  assert.equal(parsed.jobId, jobId);
  assert.equal(parsed.ownerId, 'owner-new');
  assert.equal(parsed.ownerPid, process.pid);
  assert.equal(isValidClaim(parsed), true);
  assert.ok(!raw.includes(rt), 'claim must not embed the runtime path');
});

test('acquireClaim: a second call against a live owner returns held and leaves the claim untouched', () => {
  const jobId = 'acq-held';
  assert.equal(acquire(jobId, 'recover', 'owner-a').status, 'acquired');
  const r = acquire(jobId, 'recover', 'owner-b');
  assert.equal(r.status, 'held', 'an active owner must block');
  if (r.status === 'held') {
    assert.ok(r.existing, 'a held result always carries the existing claim');
    assert.equal(r.existing.ownerId, 'owner-a');
  }
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-a', 'the claim file is the arbiter, not an in-memory map');
});

test('acquireClaim: recover and supervisor claims for the same job are independent files', () => {
  const jobId = 'acq-kinds';
  assert.equal(acquire(jobId, 'recover', 'o-r').status, 'acquired');
  assert.equal(acquire(jobId, 'supervisor', 'o-s').status, 'acquired');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'o-r');
  assert.equal(readClaim(jobId, 'supervisor')?.ownerId, 'o-s');
});

test('acquireClaim: a dead owner claim is safely stolen and replaced', () => {
  const jobId = 'acq-steal-dead';
  writeClaim(makeClaim({ jobId, kind: 'recover', ownerId: 'dead-owner', ownerPid: 42_001 }), 'recover');
  const r = acquire(jobId, 'recover', 'new-owner');
  assert.equal(r.status, 'acquired', 'a dead owner must not block');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'new-owner');
  assert.deepEqual(claimFiles().filter((f) => f.includes('.stale')), [], 'tombstones are cleaned up best-effort');
});

test('acquireClaim: an identity-mismatch owner (PID reused) is safely stolen', () => {
  const jobId = 'acq-steal-reused';
  writeClaim(
    makeClaim({ jobId, kind: 'recover', ownerId: 'old-owner', ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString() }),
    'recover',
  );
  const r = acquire(jobId, 'recover', 'new-owner', {
    inspector: makeInspector(new Set([42_001]), new Map([[42_001, NOW - 10_000]])),
  });
  assert.equal(r.status, 'acquired');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'new-owner');
});

test('acquireClaim: unverifiable-but-fresh recover claim blocks (conservative, no double spawn)', () => {
  const jobId = 'acq-unver-fresh';
  writeClaim(makeClaim({ jobId, kind: 'recover', ownerId: 'mystery', ownerPid: 42_001 }), 'recover');
  const r = acquire(jobId, 'recover', 'new-owner', {
    inspector: makeInspector(new Set([42_001]), new Map()), // exists but start time unreadable
  });
  assert.equal(r.status, 'held', 'cannot prove the owner dead -> must back off while the lease is fresh');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'mystery');
});

test('acquireClaim: unverifiable recover claim past its lease is stolen (bounded backstop)', () => {
  const jobId = 'acq-unver-expired';
  writeClaim(
    makeClaim({ jobId, kind: 'recover', ownerId: 'mystery', ownerPid: 42_001, expiresAt: new Date(NOW - 1).toISOString() }),
    'recover',
  );
  const r = acquire(jobId, 'recover', 'new-owner', {
    inspector: makeInspector(new Set([42_001]), new Map()),
  });
  assert.equal(r.status, 'acquired', 'a crashed recoverer must not block recovery forever');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'new-owner');
});

test('acquireClaim: a verified-live owner is never displaced even after the lease expires', () => {
  const jobId = 'acq-live-expired';
  writeClaim(
    makeClaim({ jobId, kind: 'recover', ownerId: 'live-owner', ownerPid: 42_001, ownerStartedAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW - 1).toISOString() }),
    'recover',
  );
  const r = acquire(jobId, 'recover', 'new-owner', {
    inspector: makeInspector(new Set([42_001]), new Map([[42_001, NOW - 60_000]])),
  });
  assert.equal(r.status, 'held', 'displacing a live owner would permit a double spawn');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'live-owner');
});

test('acquireClaim: a possibly-alive supervisor is never stolen, even expired (conservative)', () => {
  const jobId = 'acq-sup-unver';
  writeClaim(
    makeClaim({ jobId, kind: 'supervisor', ownerId: 'sup', ownerPid: 42_001, expiresAt: new Date(NOW - 1).toISOString() }),
    'supervisor',
  );
  const r = acquire(jobId, 'supervisor', 'new-owner', {
    inspector: makeInspector(new Set([42_001]), new Map()),
  });
  assert.equal(r.status, 'held', 'an unverifiable supervisor must never be displaced');
  assert.equal(readClaim(jobId, 'supervisor')?.ownerId, 'sup');
});

test('acquireClaim: a corrupt claim file is replaced by a fresh valid one', () => {
  const jobId = 'acq-corrupt';
  fs.writeFileSync(claimFilePath(jobId, 'recover'), '{not json', 'utf8');
  assert.equal(readClaim(jobId, 'recover'), null, 'corrupt file reads as absent');
  // Age the target beyond the mtime grace so the production aged-path runs: a
  // FRESH corrupt target would block through grace (authoritative P1 behavior).
  const aged = new Date(NOW - 3600_000);
  fs.utimesSync(claimFilePath(jobId, 'recover'), aged, aged);
  const r = acquire(jobId, 'recover', 'new-owner');
  assert.equal(r.status, 'acquired');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'new-owner');
});

test('acquireClaim: a schema-invalid claim is treated as corrupt and replaced', () => {
  const jobId = 'acq-invalid';
  fs.writeFileSync(claimFilePath(jobId, 'recover'), JSON.stringify({ schemaVersion: 1, kind: 'recover', jobId }), 'utf8');
  assert.equal(isValidClaim(JSON.parse(fs.readFileSync(claimFilePath(jobId, 'recover'), 'utf8'))), false);
  // Age the target beyond the mtime grace so the production aged-path runs: a
  // FRESH schema-invalid target would block through grace (authoritative P1
  // behavior), so recovery is exercised on the aged crash residue instead.
  const aged = new Date(NOW - 3600_000);
  fs.utimesSync(claimFilePath(jobId, 'recover'), aged, aged);
  const r = acquire(jobId, 'recover', 'new-owner');
  assert.equal(r.status, 'acquired');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'new-owner');
});

// ---------------------------------------------------------------------------
// Cross-process O_EXCL race
// ---------------------------------------------------------------------------

// Compiled layout: dist-test/test/recovery.test.js -> dist-test/src/recovery.js.
const RECOVERY_MODULE_URL = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'recovery.js'),
).href;

function claimChildScript(jobId: string, kind: ClaimKind): string {
  return `
import crypto from 'node:crypto';
import { acquireClaim, readClaim } from ${JSON.stringify(RECOVERY_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
const kind = ${JSON.stringify(kind)};
// Report any existing claim's owner as identity-live so the loser deterministically
// sees 'held': only the true O_EXCL winner can report 'acquired'.
const inspector = {
  exists: () => true,
  startTime: (pid) => {
    const c = readClaim(jobId, kind);
    return c && c.ownerPid === pid ? Date.parse(c.ownerStartedAt) : null;
  },
};
const r = acquireClaim({
  jobId,
  kind,
  ownerId: crypto.randomUUID(),
  now: () => Date.now(),
  leaseMs: 60000,
  inspector,
});
process.stdout.write(JSON.stringify({ status: r.status }));
process.exit(0);
`;
}

async function runClaimChild(jobId: string, kind: ClaimKind): Promise<{ status: string }> {
  // A temp .mjs sidesteps any -e quoting issues; removed in finally.
  const scriptFile = path.join(rt, `claim-${jobId}-${kind}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(scriptFile, claimChildScript(jobId, kind), 'utf8');
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const cp = spawn(process.execPath, [scriptFile], {
        env: { ...process.env, ORCHESTRATOR_RUNTIME: rt },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        cp.kill();
        reject(new Error(`claim child timed out (stderr: ${err || 'none'})`));
      }, 15_000);
      cp.stdout.on('data', (d) => {
        out += String(d);
      });
      cp.stderr.on('data', (d) => {
        err += String(d);
      });
      cp.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      cp.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`claim child exited ${code}: ${err}`));
      });
    });
    return JSON.parse(stdout) as { status: string };
  } finally {
    try {
      fs.unlinkSync(scriptFile);
    } catch {
      /* best effort */
    }
  }
}

test('acquireClaim: two processes racing the same claimPath -> exactly one acquired', async () => {
  const jobId = `acq-race-${process.pid}-${Date.now()}`;
  const [ra, rb] = await Promise.all([runClaimChild(jobId, 'recover'), runClaimChild(jobId, 'recover')]);
  const statuses = [ra.status, rb.status];
  assert.equal(
    statuses.filter((s) => s === 'acquired').length,
    1,
    `exactly one racer acquires the claim, got ${JSON.stringify(statuses)}`,
  );
  assert.ok(readClaim(jobId, 'recover'), 'the winner leaves a claim on disk');
});

// ---------------------------------------------------------------------------
// releaseClaim
// ---------------------------------------------------------------------------

test('releaseClaim: only the matching owner can release; a full cycle leaves no residue', () => {
  const jobId = 'rel-owner';
  assert.equal(acquire(jobId, 'recover', 'owner-a').status, 'acquired');
  assert.equal(releaseClaim(jobId, 'recover', 'owner-b'), false, 'a different owner is refused');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-a', 'claim survives a refused release');
  assert.equal(releaseClaim(jobId, 'recover', 'owner-a'), true);
  assert.equal(readClaim(jobId, 'recover'), null);
  assert.deepEqual(claimFiles(), [], 'acquire + release leaves the claims dir empty');
});

test('releaseClaim: missing claim is false; a corrupt claim has no owner to protect and is removed', () => {
  assert.equal(releaseClaim('rel-missing', 'recover', 'x'), false);
  fs.writeFileSync(claimFilePath('rel-corrupt', 'recover'), '{not json', 'utf8');
  assert.equal(releaseClaim('rel-corrupt', 'recover', 'x'), true);
  assert.equal(readClaim('rel-corrupt', 'recover'), null);
});

// ---------------------------------------------------------------------------
// Bounded EPERM/EBUSY retry (injectable claimTestHooks)
// ---------------------------------------------------------------------------

test('EPERM on the O_EXCL open is retried a bounded number of times then acquires', () => {
  const jobId = 'retry-open-ep';
  let attempts = 0;
  const r = withClaimHooks(
    {
      beforeOpen: () => {
        attempts += 1;
        if (attempts <= 2) throw errWithCode('EPERM');
      },
    },
    () => acquire(jobId, 'recover', 'owner-r'),
  );
  assert.equal(r.status, 'acquired');
  assert.equal(attempts, 3, 'two transient failures then success');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-r');
});

test('EBUSY on the O_EXCL open is retried then acquires', () => {
  const jobId = 'retry-open-eb';
  let attempts = 0;
  const r = withClaimHooks(
    {
      beforeOpen: () => {
        attempts += 1;
        if (attempts === 1) throw errWithCode('EBUSY');
      },
    },
    () => acquire(jobId, 'recover', 'owner-r'),
  );
  assert.equal(r.status, 'acquired');
  assert.equal(attempts, 2);
});

test('persistent EPERM on the open is bounded (6 attempts) and then rethrows', () => {
  const jobId = 'retry-open-throw';
  let attempts = 0;
  assert.throws(
    () =>
      withClaimHooks(
        {
          beforeOpen: () => {
            attempts += 1;
            throw errWithCode('EPERM');
          },
        },
        () => acquire(jobId, 'recover', 'owner-r'),
      ),
    (e: NodeJS.ErrnoException) => e.code === 'EPERM',
  );
  assert.equal(attempts, 6);
});

test('EPERM on the steal rename is retried then the stale claim is taken', () => {
  const jobId = 'retry-rename-ep';
  writeClaim(makeClaim({ jobId, kind: 'recover', ownerPid: 42_001 }), 'recover');
  let renames = 0;
  const r = withClaimHooks(
    {
      beforeRename: () => {
        renames += 1;
        if (renames === 1) throw errWithCode('EPERM');
      },
    },
    () => acquire(jobId, 'recover', 'owner-r'),
  );
  assert.equal(r.status, 'acquired');
  assert.equal(renames, 2, 'one transient rename failure then success');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-r');
});

test('persistent EPERM on the steal rename is bounded (steal attempts capped at 2) and returns held', () => {
  const jobId = 'retry-rename-throw';
  writeClaim(makeClaim({ jobId, kind: 'recover', ownerPid: 42_001 }), 'recover');
  let renames = 0;
  const r = withClaimHooks(
    {
      beforeRename: () => {
        renames += 1;
        throw errWithCode('EPERM');
      },
    },
    () => acquire(jobId, 'recover', 'owner-r'),
  );
  assert.equal(r.status, 'held', 'rename retries are bounded, never throw');
  assert.equal(renames, 2);
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-a', 'the original claim survives an exhausted steal');
});

// ---------------------------------------------------------------------------
// Core-consistency: empty/partial-write grace + one-winner stale recovery
// (matrix 10).
//
// ALIGNMENT-SENSITIVE: the grace window is assumed to guard PARTIAL-WRITE
// markers (the atomic-write `.tmp` file), not the claim target itself (a
// corrupt target is still replaced immediately, per the pre-existing
// corrupt-claim test). A fresh marker blocks; an aged marker is abandoned.
// ---------------------------------------------------------------------------

function acquireClaimRealNow(
  jobId: string,
  kind: ClaimKind,
  ownerId: string,
): AcquireResult {
  return acquireClaim({
    jobId,
    kind,
    ownerId,
    now: Date.now,
    leaseMs: LEASE_MS,
    inspector: NO_INSPECTOR,
  });
}

function partialWriteMarker(jobId: string, kind: ClaimKind): string {
  return claimFilePath(jobId, kind) + '.123.1.abc.tmp';
}

test('a fresh partial-write marker (.tmp) blocks claim acquisition during grace', () => {
  const jobId = 'grace-fresh';
  // An in-flight atomic write: the claim target is absent; only its tmp exists.
  fs.writeFileSync(partialWriteMarker(jobId, 'recover'), `{"schemaVersion":1,"kind":"recover","jobId":"${jobId}`, 'utf8');
  const r = acquireClaimRealNow(jobId, 'recover', 'owner-g');
  assert.equal(r.status, 'held', 'a fresh partial write must block during grace');
  assert.equal(readClaim(jobId, 'recover'), null, 'no claim is created while blocked');
});

test('an aged partial-write marker is treated as abandoned and yields exactly one holder', () => {
  const jobId = 'grace-aged';
  const tmp = partialWriteMarker(jobId, 'recover');
  fs.writeFileSync(tmp, `{"schemaVersion":1,"kind":"recover","jobId":"${jobId}`, 'utf8');
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(tmp, past, past);
  const r = acquireClaimRealNow(jobId, 'recover', 'owner-g');
  assert.equal(r.status, 'acquired', 'an abandoned partial write is recoverable');
  assert.equal(readClaim(jobId, 'recover')?.ownerId, 'owner-g');
  assert.ok(!fs.existsSync(tmp), 'the abandoned tmp marker is cleaned up');
});

function staleClaimChildScript(jobId: string, kind: ClaimKind, deadPids: number[]): string {
  return `
import crypto from 'node:crypto';
import { acquireClaim, readClaim } from ${JSON.stringify(RECOVERY_MODULE_URL)};
const jobId = ${JSON.stringify(jobId)};
const kind = ${JSON.stringify(kind)};
const dead = ${JSON.stringify(deadPids)};
const inspector = {
  exists: (pid) => !dead.includes(pid),
  startTime: (pid) => {
    const c = readClaim(jobId, kind);
    return c && c.ownerPid === pid ? Date.parse(c.ownerStartedAt) : null;
  },
};
const r = acquireClaim({ jobId, kind, ownerId: crypto.randomUUID(), now: () => Date.now(), leaseMs: 60000, inspector });
process.stdout.write(JSON.stringify({ status: r.status }));
process.exit(0);
`;
}

async function runStaleClaimChild(jobId: string, kind: ClaimKind, deadPids: number[]): Promise<{ status: string }> {
  const scriptFile = path.join(rt, `stale-${jobId}-${kind}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(scriptFile, staleClaimChildScript(jobId, kind, deadPids), 'utf8');
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const cp = spawn(process.execPath, [scriptFile], {
        env: { ...process.env, ORCHESTRATOR_RUNTIME: rt },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        cp.kill();
        reject(new Error(`stale claim child timed out (stderr: ${err || 'none'})`));
      }, 15_000);
      cp.stdout.on('data', (d) => {
        out += String(d);
      });
      cp.stderr.on('data', (d) => {
        err += String(d);
      });
      cp.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      cp.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out.trim());
        else reject(new Error(`stale claim child exited ${code}: ${err}`));
      });
    });
    return JSON.parse(stdout) as { status: string };
  } finally {
    try {
      fs.unlinkSync(scriptFile);
    } catch {
      /* best effort */
    }
  }
}

test('two processes racing a stale (dead-owner) recover claim -> exactly one winner', async () => {
  const jobId = `stale-race-${process.pid}-${Date.now()}`;
  const deadPid = 999_999;
  writeClaim(makeClaim({ jobId, kind: 'recover', ownerId: 'dead-owner', ownerPid: deadPid }), 'recover');
  const [ra, rb] = await Promise.all([
    runStaleClaimChild(jobId, 'recover', [deadPid]),
    runStaleClaimChild(jobId, 'recover', [deadPid]),
  ]);
  const statuses = [ra.status, rb.status];
  assert.equal(
    statuses.filter((s) => s === 'acquired').length,
    1,
    `exactly one stale recovery wins, got ${JSON.stringify(statuses)}`,
  );
  const final = readClaim(jobId, 'recover');
  assert.ok(final, 'the winner leaves a claim on disk');
  assert.notEqual(final!.ownerId, 'dead-owner', 'the stale claim is replaced');
});

test('P1 regression: a fresh empty/partial claim target blocks during mtime grace; once aged, exactly one winner', async () => {
  const jobId = `p1-partial-${process.pid}-${Date.now()}`;
  const target = claimFilePath(jobId, 'recover');
  // A partial (truncated) claim target with NO .tmp marker — an interrupted
  // write landed directly on the target. A fresh mtime is inside the grace
  // window: acquisition must block (held) and the target must not be stolen.
  fs.writeFileSync(target, `{"schemaVersion":1,"kind":"recover","jobId":"${jobId}`, 'utf8');
  const before = fs.readFileSync(target, 'utf8');

  const fresh = acquireClaimRealNow(jobId, 'recover', 'owner-fresh');
  assert.equal(fresh.status, 'held', 'a fresh empty/partial claim must block during grace');
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'the partial target is not renamed/stolen');
  assert.equal(readClaim(jobId, 'recover'), null, 'no valid claim is created while blocked');

  // Age the SAME target beyond grace: two contenders must yield exactly one
  // acquired/stolen owner and never a double-holder.
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(target, past, past);
  const [ra, rb] = await Promise.all([
    runStaleClaimChild(jobId, 'recover', []),
    runStaleClaimChild(jobId, 'recover', []),
  ]);
  const statuses = [ra.status, rb.status];
  assert.equal(
    statuses.filter((s) => s === 'acquired').length,
    1,
    `exactly one contender takes the aged partial target, got ${JSON.stringify(statuses)}`,
  );
  const final = readClaim(jobId, 'recover');
  assert.ok(final && isValidClaim(final), 'a single valid owner claim remains (no double-holder)');
});
