// Stage 5 instance-registry / heartbeat / process-identity tests.
//
// Covers: per-instance record writes that never corrupt each other, heartbeat
// advance + stale self detection, crash-residue vs live-instance classification,
// PID-reuse (identity mismatch) detection, conservative degradation on any
// identity failure, clock-skew handling, corrupt/invalid records, and the
// Windows-hardened atomic write being reused for registry files. All tests use
// an isolated ORCHESTRATOR_RUNTIME and an injectable clock + inspector — no
// real waiting, no real PID reuse.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const rt = path.join(os.tmpdir(), `orc-registry-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;

import {
  registerInstance,
  snapshotRegistry,
  queryProcessStartTime,
  instanceFilePath,
  parseWmicCreationDate,
  type InstanceRecord,
  type ProcessInspector,
  type RegistryStaleReason,
  type RegistrySnapshot,
} from '../src/registry.js';
import { instancesDir } from '../src/config.js';
import { atomicWriteJson, atomicWriteTestHooks, type AtomicWriteTestHooks } from '../src/job-store.js';

// Each test starts from an empty registry dir so records never leak across
// tests (they share the same ORCHESTRATOR_RUNTIME).
beforeEach(() => {
  try {
    fs.rmSync(instancesDir(), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

const NOW = 1_700_000_000_000; // fixed "now" for most tests

function makeRecord(over: Partial<InstanceRecord> & { instanceId: string; pid: number }): InstanceRecord {
  return {
    schemaVersion: 1,
    processStartedAt: new Date(NOW - 60_000).toISOString(),
    serverStartedAt: new Date(NOW - 60_000).toISOString(),
    entry: 'index.js',
    buildFingerprint: 'a'.repeat(64),
    lastHeartbeatAt: new Date(NOW).toISOString(),
    version: '1.0.0',
    ...over,
  } as InstanceRecord;
}

function writeRecord(rec: InstanceRecord): void {
  fs.mkdirSync(instancesDir(), { recursive: true });
  atomicWriteJson(instanceFilePath(rec.instanceId), rec);
}

function makeInspector(alive: Set<number>, starts: Map<number, number>): ProcessInspector {
  return {
    exists: (pid) => alive.has(pid),
    startTime: (pid) => starts.get(pid) ?? null,
  };
}

function snap(over: {
  instanceId?: string | null;
  now?: number;
  inspector?: ProcessInspector;
} = {}): RegistrySnapshot {
  return snapshotRegistry({
    instanceId: over.instanceId ?? null,
    now: over.now ?? NOW,
    heartbeatMs: 10_000,
    staleAfterMs: 30_000,
    inspector: over.inspector ?? makeInspector(new Set(), new Map()),
  });
}

function staleKeys(s: RegistrySnapshot): RegistryStaleReason[] {
  return Object.entries(s.staleReasons).flatMap(([k, v]) => Array(v ?? 0).fill(k as RegistryStaleReason));
}

function tmpLeftovers(): string[] {
  if (!fs.existsSync(instancesDir())) return [];
  return fs.readdirSync(instancesDir()).filter((f) => f.includes('.tmp'));
}

function withHooks(hooks: Partial<AtomicWriteTestHooks>, fn: () => void): void {
  const prev: AtomicWriteTestHooks = { ...atomicWriteTestHooks };
  Object.assign(atomicWriteTestHooks, hooks, { sleep: hooks.sleep ?? (() => {}) });
  try {
    fn();
  } finally {
    atomicWriteTestHooks.beforeRename = prev.beforeRename;
    atomicWriteTestHooks.beforeUnlink = prev.beforeUnlink;
    atomicWriteTestHooks.sleep = prev.sleep;
  }
}

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

// ---------------------------------------------------------------------------
// registerInstance / heartbeat / unregister
// ---------------------------------------------------------------------------

test('registerInstance writes a record and heartbeat advances lastHeartbeatAt; unregister removes it', () => {
  let clock = NOW;
  const h = registerInstance({
    entry: 'index.js',
    buildFingerprint: 'b'.repeat(64),
    version: '1.0.0',
    now: () => clock,
  });
  try {
    const f = instanceFilePath(h.instanceId);
    assert.ok(fs.existsSync(f), 'initial record written');
    const rec = JSON.parse(fs.readFileSync(f, 'utf8')) as InstanceRecord;
    assert.equal(rec.instanceId, h.instanceId);
    assert.equal(rec.pid, process.pid);
    assert.equal(rec.entry, 'index.js');
    assert.equal(rec.lastHeartbeatAt, new Date(NOW).toISOString());
    assert.ok(!JSON.stringify(rec).includes(process.env.ORCHESTRATOR_RUNTIME ?? ''), 'no full runtime path stored');

    clock = NOW + 15_000;
    h.beat();
    const after = JSON.parse(fs.readFileSync(f, 'utf8')) as InstanceRecord;
    assert.equal(after.lastHeartbeatAt, new Date(NOW + 15_000).toISOString());
  } finally {
    h.unregister();
  }
  assert.ok(!fs.existsSync(instanceFilePath(h.instanceId)), 'unregister removes the record');
  assert.deepEqual(tmpLeftovers(), []);
});

test('concurrent instances write their own records without corrupting each other', () => {
  const a = registerInstance({ entry: 'index.js', buildFingerprint: 'a'.repeat(64), version: '1.0.0' });
  const b = registerInstance({ entry: 'index.js', buildFingerprint: 'b'.repeat(64), version: '1.0.0' });
  try {
    assert.notEqual(a.instanceId, b.instanceId);
    for (let i = 0; i < 5; i++) {
      a.beat();
      b.beat();
    }
    const ra = JSON.parse(fs.readFileSync(instanceFilePath(a.instanceId), 'utf8')) as InstanceRecord;
    const rb = JSON.parse(fs.readFileSync(instanceFilePath(b.instanceId), 'utf8')) as InstanceRecord;
    assert.equal(ra.instanceId, a.instanceId);
    assert.equal(rb.instanceId, b.instanceId);
    assert.equal(ra.buildFingerprint, 'a'.repeat(64));
    assert.equal(rb.buildFingerprint, 'b'.repeat(64));
  } finally {
    a.unregister();
    b.unregister();
  }
  assert.deepEqual(tmpLeftovers(), []);
});

test('heartbeat write failure is surfaced as self heartbeat_timeout, never crashes', () => {
  let clock = NOW;
  const h = registerInstance({
    entry: 'index.js',
    buildFingerprint: 'c'.repeat(64),
    version: '1.0.0',
    now: () => clock,
  });
  try {
    // Force every rename to fail transiently -> the heartbeat write cannot land.
    withHooks(
      { beforeRename: () => { throw errWithCode('EPERM'); } },
      () => {
        clock = NOW + 120_000;
        assert.doesNotThrow(() => h.beat(), 'a failed heartbeat must not throw');
      },
    );
    const s = snap({ instanceId: h.instanceId, now: NOW + 120_000 });
    assert.equal(s.registryStale, true, 'self stale heartbeat must flag registry_stale');
    assert.ok(staleKeys(s).includes('heartbeat_timeout'));
    assert.equal(s.liveCount, 1, 'self still counts as identity-live even when heartbeat is stale');
    assert.equal(s.duplicateInstanceSuspected, false);
  } finally {
    h.unregister();
  }
});

test('registry writes reuse the Windows EPERM/EBUSY bounded retry', () => {
  withHooks(
    {
      beforeRename: (attempt) => {
        if (attempt <= 2) throw errWithCode('EPERM');
      },
    },
    () => {
      const h = registerInstance({ entry: 'index.js', buildFingerprint: 'd'.repeat(64), version: '1.0.0' });
      try {
        const rec = JSON.parse(fs.readFileSync(instanceFilePath(h.instanceId), 'utf8')) as InstanceRecord;
        assert.equal(rec.entry, 'index.js');
      } finally {
        h.unregister();
      }
    },
  );
  assert.deepEqual(tmpLeftovers(), []);
});

// ---------------------------------------------------------------------------
// snapshotRegistry classification
// ---------------------------------------------------------------------------

test('missing registry dir -> empty snapshot with no error and no dir created', () => {
  const s = snap({});
  assert.equal(s.enabled, true);
  assert.equal(s.instanceCount, 0);
  assert.equal(s.staleCount, 0);
  assert.equal(s.duplicateInstanceSuspected, false);
  assert.equal(s.registryStale, false);
  assert.equal(s.error, null);
  assert.equal(fs.existsSync(instancesDir()), false, 'snapshot must not create the registry dir');
});

test('corrupt and invalid records are stale, never live', () => {
  fs.mkdirSync(instancesDir(), { recursive: true });
  fs.writeFileSync(instanceFilePath('corrupt-1'), '{not json', 'utf8');
  writeRecord({ ...makeRecord({ instanceId: 'invalid-1', pid: 9999 }), lastHeartbeatAt: undefined as unknown as string });
  const s = snap({});
  assert.equal(s.instanceCount, 2);
  assert.equal(s.staleCount, 2);
  const keys = staleKeys(s);
  assert.ok(keys.includes('corrupt'));
  assert.ok(keys.includes('invalid'));
  assert.equal(s.duplicateInstanceSuspected, false);
  assert.equal(s.registryStale, true);
});

test('pid not found -> stale pid_not_found, not live, not duplicate', () => {
  const dead = makeRecord({ instanceId: 'dead-1', pid: 42_001 });
  writeRecord(dead);
  const s = snap({ inspector: makeInspector(new Set(), new Map()) });
  assert.equal(s.staleCount, 1);
  assert.ok(staleKeys(s).includes('pid_not_found'));
  assert.equal(s.liveCount, 0);
  assert.equal(s.duplicateInstanceSuspected, false);
});

test('PID reuse: pid alive but creation time mismatches the record -> identity_mismatch, not healthy', () => {
  const reused = makeRecord({ instanceId: 'reused-1', pid: 42_002 });
  writeRecord(reused);
  // Record claims the process started at NOW-60s; the OS says that pid actually
  // started at NOW-10s -> the pid was reused by a different process.
  const s = snap({ inspector: makeInspector(new Set([42_002]), new Map([[42_002, NOW - 10_000]])) });
  assert.equal(s.staleCount, 1);
  assert.ok(staleKeys(s).includes('identity_mismatch'));
  assert.equal(s.liveCount, 0);
  assert.equal(s.duplicateInstanceSuspected, false);
  assert.equal(s.registryStale, true);
});

test('identity unverified (startTime unreadable) is conservative unknown/stale', () => {
  writeRecord(makeRecord({ instanceId: 'unver-1', pid: 42_003 }));
  const s = snap({ inspector: makeInspector(new Set([42_003]), new Map()) }); // startTime -> null
  assert.equal(s.staleCount, 1);
  assert.ok(staleKeys(s).includes('identity_unverified'));
  assert.equal(s.liveCount, 0, 'unverifiable identity must never count as healthy/live');
  assert.equal(s.registryStale, true);
});

test('two identity-verified live instances -> duplicate_instance_suspected', () => {
  const now = NOW;
  writeRecord(makeRecord({ instanceId: 'live-a', pid: 1001, processStartedAt: new Date(now - 50_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'live-b', pid: 1002, processStartedAt: new Date(now - 30_000).toISOString() }));
  const alive = new Set([1001, 1002]);
  const starts = new Map<number, number>([[1001, now - 50_000], [1002, now - 30_000]]);
  const s = snap({ inspector: makeInspector(alive, starts) });
  assert.equal(s.liveCount, 2);
  assert.equal(s.staleCount, 0);
  assert.equal(s.duplicateInstanceSuspected, true);
  assert.equal(s.registryStale, false);
});

test('two live instances under the SAME hostPid are NOT duplicates (multi-window setup)', () => {
  const now = NOW;
  writeRecord(makeRecord({ instanceId: 'host-a1', pid: 1001, hostPid: 7777, processStartedAt: new Date(now - 50_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'host-a2', pid: 1002, hostPid: 7777, processStartedAt: new Date(now - 30_000).toISOString() }));
  const alive = new Set([1001, 1002]);
  const starts = new Map<number, number>([[1001, now - 50_000], [1002, now - 30_000]]);
  const s = snap({ inspector: makeInspector(alive, starts) });
  assert.equal(s.liveCount, 2);
  assert.equal(s.duplicateInstanceSuspected, false, 'two windows of one host are not duplicates');
  assert.equal(s.registryStale, false);
});

test('two live instances under DIFFERENT hostPids ARE duplicates', () => {
  const now = NOW;
  writeRecord(makeRecord({ instanceId: 'host-b1', pid: 1001, hostPid: 7777, processStartedAt: new Date(now - 50_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'host-b2', pid: 1002, hostPid: 8888, processStartedAt: new Date(now - 30_000).toISOString() }));
  const alive = new Set([1001, 1002]);
  const starts = new Map<number, number>([[1001, now - 50_000], [1002, now - 30_000]]);
  const s = snap({ inspector: makeInspector(alive, starts) });
  assert.equal(s.liveCount, 2);
  assert.equal(s.duplicateInstanceSuspected, true, 'different hosts sharing one runtime are duplicates');
});

test('legacy records (no hostPid) group by their own PID; mixed host+legacy still duplicates', () => {
  const now = NOW;
  // Same-host pair + one legacy record without hostPid -> the legacy record
  // forms its own pid group, so the cross-host guard must still fire.
  writeRecord(makeRecord({ instanceId: 'host-c1', pid: 1001, hostPid: 7777, processStartedAt: new Date(now - 50_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'host-c2', pid: 1002, hostPid: 7777, processStartedAt: new Date(now - 40_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'legacy-d', pid: 1003, processStartedAt: new Date(now - 30_000).toISOString() }));
  const alive = new Set([1001, 1002, 1003]);
  const starts = new Map<number, number>([[1001, now - 50_000], [1002, now - 40_000], [1003, now - 30_000]]);
  const s = snap({ inspector: makeInspector(alive, starts) });
  assert.equal(s.liveCount, 3);
  assert.equal(s.duplicateInstanceSuspected, true, 'same-host pair is fine, legacy record is a second host group');
});

test('stale residue never counts as a duplicate', () => {
  const now = NOW;
  // One genuinely live instance + one dead/crashed residue.
  writeRecord(makeRecord({ instanceId: 'live-c', pid: 2001, processStartedAt: new Date(now - 50_000).toISOString() }));
  writeRecord(makeRecord({ instanceId: 'residue-d', pid: 2002 }));
  const s = snap({
    inspector: makeInspector(new Set([2001]), new Map([[2001, now - 50_000]])),
  });
  assert.equal(s.liveCount, 1, 'residue must not be live');
  assert.equal(s.staleCount, 1);
  assert.equal(s.duplicateInstanceSuspected, false, 'a stale residue must not trigger duplicate');
  assert.equal(s.registryStale, true);
});

test('self record counts as live; future heartbeat (clock skew) is not stale', () => {
  const h = registerInstance({ entry: 'index.js', buildFingerprint: 'e'.repeat(64), version: '1.0.0' });
  try {
    // Inject a future heartbeat directly into the record to simulate clock skew.
    const f = instanceFilePath(h.instanceId);
    const rec = JSON.parse(fs.readFileSync(f, 'utf8')) as InstanceRecord;
    rec.lastHeartbeatAt = new Date(NOW + 60_000).toISOString(); // 1 min in the future
    atomicWriteJson(f, rec);
    const s = snap({ instanceId: h.instanceId, now: NOW });
    assert.equal(s.recorded, true);
    assert.equal(s.liveCount, 1, 'self is live');
    assert.equal(s.staleCount, 0, 'a future heartbeat is fresh, not stale');
    assert.equal(s.registryStale, false);
  } finally {
    h.unregister();
  }
});

test('duplicate + stale coexist: self stale heartbeat AND another live instance', () => {
  const h = registerInstance({
    entry: 'index.js',
    buildFingerprint: 'g'.repeat(64),
    version: '1.0.0',
    now: () => NOW,
  });
  try {
    // Age the self record's heartbeat well past the stale threshold.
    const f = instanceFilePath(h.instanceId);
    const selfRec = JSON.parse(fs.readFileSync(f, 'utf8')) as InstanceRecord;
    selfRec.lastHeartbeatAt = new Date(NOW - 120_000).toISOString();
    atomicWriteJson(f, selfRec);
    // A second, genuinely-live instance (fresh heartbeat, identity verified).
    writeRecord(
      makeRecord({
        instanceId: 'live-f',
        pid: 3001,
        processStartedAt: new Date(NOW - 50_000).toISOString(),
      }),
    );
    const s = snap({
      instanceId: h.instanceId,
      now: NOW,
      inspector: makeInspector(new Set([3001]), new Map([[3001, NOW - 50_000]])),
    });
    assert.equal(s.recorded, true);
    assert.equal(s.liveCount, 2, 'self + verified live second instance');
    assert.equal(s.staleCount, 1, 'self heartbeat timeout');
    assert.ok(staleKeys(s).includes('heartbeat_timeout'));
    assert.equal(s.duplicateInstanceSuspected, true, 'duplicate and stale can coexist');
    assert.equal(s.registryStale, true);
  } finally {
    h.unregister();
  }
});

test('instanceId must be unique per process (non-colliding)', () => {
  const a = registerInstance({ entry: 'index.js', buildFingerprint: 'f'.repeat(64), version: '1.0.0' });
  const b = registerInstance({ entry: 'index.js', buildFingerprint: 'f'.repeat(64), version: '1.0.0' });
  try {
    assert.notEqual(a.instanceId, b.instanceId);
  } finally {
    a.unregister();
    b.unregister();
  }
});

// ---------------------------------------------------------------------------
// Real-OS process identity sanity (tolerant: skips when the platform cannot
// report a creation time, e.g. wmic absent).
// ---------------------------------------------------------------------------

test('queryProcessStartTime of the current process is either null or close to Date.now()-uptime', () => {
  const t = queryProcessStartTime(process.pid);
  if (t === null) {
    // Platform/OS cannot report it here; that is a valid conservative fallback.
    return;
  }
  const expected = Date.now() - process.uptime() * 1000;
  assert.ok(
    Math.abs(t - expected) < 60_000,
    `queried start ${t} should be within 60s of ${expected} (PID identity sanity)`,
  );
});

// ---------------------------------------------------------------------------
// parseWmicCreationDate: sign-aware UTC offset conversion (Stage 5 P2 fix).
// wmic reports LOCAL wall-clock time + a signed UTC offset; UTC = local -
// offset, so a negative offset must be ADDED back. Malformed input and a
// missing offset are conservative null (identity degrades to unknown/stale).
// ---------------------------------------------------------------------------

test('parseWmicCreationDate: +480 positive offset -> local minus 480 min (UTC+8)', () => {
  // Local 2026-08-13 12:30:00 at UTC+8 -> UTC 04:30:00 the same day.
  const t = parseWmicCreationDate('CreationDate=20260813123000.000000+480');
  assert.equal(t, Date.UTC(2026, 7, 13, 4, 30, 0, 0));
});

test('parseWmicCreationDate: -300 negative offset -> local plus 300 min (UTC-5)', () => {
  // Local 2026-08-13 12:30:00 at UTC-5 -> UTC 17:30:00 the same day.
  const t = parseWmicCreationDate('CreationDate=20260813123000.000000-300');
  assert.equal(t, Date.UTC(2026, 7, 13, 17, 30, 0, 0));
});

test('parseWmicCreationDate: +000 and -000 are both zero offsets (UTC)', () => {
  const expected = Date.UTC(2026, 7, 13, 12, 30, 0, 0);
  assert.equal(parseWmicCreationDate('CreationDate=20260813123000.000000+000'), expected);
  assert.equal(parseWmicCreationDate('CreationDate=20260813123000.000000-000'), expected);
});

test('parseWmicCreationDate: HHMM offset variant is sign-aware too', () => {
  // "+0800" (HHMM) == +480 minutes; "-0500" == -300 minutes.
  assert.equal(
    parseWmicCreationDate('CreationDate=20260813123000.000000+0800'),
    Date.UTC(2026, 7, 13, 4, 30, 0, 0),
  );
  assert.equal(
    parseWmicCreationDate('CreationDate=20260813123000.000000-0500'),
    Date.UTC(2026, 7, 13, 17, 30, 0, 0),
  );
});

test('parseWmicCreationDate: malformed input is conservatively null', () => {
  assert.equal(parseWmicCreationDate('garbage'), null);
  assert.equal(parseWmicCreationDate('CreationDate=notadate'), null);
  assert.equal(parseWmicCreationDate('CreationDate=2026-08-13 12:30:00'), null);
});

test('parseWmicCreationDate: missing offset is conservatively null (no local->UTC conversion)', () => {
  assert.equal(parseWmicCreationDate('CreationDate=20260813123000.000000'), null);
});
