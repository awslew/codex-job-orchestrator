// Stage 5 instance-registry smoke. Runs entirely in an ISOLATED runtime dir —
// it never touches the real runtime/registry. It registers a live instance,
// writes controlled "other" records (a verified-live second instance, a stale
// crash residue, a PID-reuse identity mismatch, and a corrupt record), then
// asserts snapshot + computeHealth produce the correct duplicate/stale
// diagnostics while the BUILD diagnostic stays healthy/current. Also verifies
// the full-build fingerprint reload branch is independent of instance state.
//
// Run after `npm run build`:  node smoke/instance-registry-smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  boundedRemoveRuntime,
  buildAncestorPidSet,
  collectRecordedPidCandidates,
  evaluatePidCandidate,
  isSafeRuntimeRoot,
  waitForDead,
} from './attention-smoke.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return norm(path.resolve(process.argv[1])) === norm(path.resolve(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

async function main() {
  const ownPid = process.pid;
  const runStartedAtMs = Date.now();
  const rt = path.join(os.tmpdir(), `orc-attn-smoke-${ownPid}-${Date.now()}`);
  const isSafeRoot = () => isSafeRuntimeRoot(rt, ownPid, os.tmpdir(), ROOT);

  let failures = 0;
  let thrownMsg = null;
  let cleanupSummary = null;
  let killTreeFn = null;
  let isAliveFn = null;
  let queryProcessStartTimeFn = null;
  let self = null;

  async function cleanup() {
    const summary = {
      ok: true,
      reason: null,
      rootBasename: path.basename(rt),
      rootRemoved: false,
      recordedCount: 0,
      verifiedCount: 0,
      skippedCount: 0,
      deadCount: 0,
      killedCount: 0,
      stillAliveCount: 0,
    };
    try {
      self?.unregister();
    } catch {
      summary.ok = false;
      summary.reason = 'unregister-failed';
    } finally {
      self = null;
    }
    if (!isSafeRoot()) {
      summary.ok = false;
      summary.reason = 'guard-refused';
      console.warn(`INSTANCE_REGISTRY_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
      return summary;
    }
    const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
    summary.recordedCount = candidates.length;
    const recordedPids = [...new Set(candidates.map((candidate) => candidate.pid))];
    if (recordedPids.length > 0 && (typeof isAliveFn !== 'function' || typeof killTreeFn !== 'function')) {
      summary.ok = false;
      summary.reason = 'process-helper-unavailable';
      return summary;
    }
    const aliveCandidates = candidates.filter((candidate) => {
      try {
        return isAliveFn(candidate.pid);
      } catch {
        return false;
      }
    });
    summary.deadCount = candidates.length - aliveCandidates.length;
    let ancestorPids = new Set();
    if (aliveCandidates.length > 0) {
      try {
        ancestorPids = buildAncestorPidSet();
      } catch {
        // Empty ancestor evidence keeps evaluatePidCandidate fail-closed.
      }
    }
    const verifiedPids = new Set();
    for (const candidate of aliveCandidates) {
      const verdict = evaluatePidCandidate(candidate.pid, {
        ownPid,
        ancestorPids,
        runStartedAtMs,
        osStartTimeFn: queryProcessStartTimeFn,
        clockToleranceMs: 5000,
      });
      if (verdict.ok) verifiedPids.add(candidate.pid);
      else summary.skippedCount += 1;
    }
    summary.verifiedCount = verifiedPids.size;
    let killFailed = false;
    for (const pid of verifiedPids) {
      try {
        killTreeFn(pid);
        summary.killedCount += 1;
      } catch {
        killFailed = true;
      }
    }
    const stillAlive = await waitForDead(recordedPids, { attempts: 20, stepMs: 250, isAliveFn });
    summary.stillAliveCount = stillAlive.length;
    if (stillAlive.length > 0) {
      summary.ok = false;
      summary.reason = 'still-alive';
      console.warn(`INSTANCE_REGISTRY_SMOKE: ${stillAlive.length} recorded process(es) still alive after bounded wait`);
      return summary;
    }
    if (killFailed) {
      summary.ok = false;
      summary.reason = 'kill-failed';
    }
    const removed = await boundedRemoveRuntime(rt, ownPid, os.tmpdir(), ROOT, {
      attempts: 5,
      retryDelayMs: 250,
      rmRetries: 3,
      rmRetryDelayMs: 250,
    });
    summary.rootRemoved = removed.ok;
    if (!removed.ok) {
      summary.ok = false;
      summary.reason = removed.reason;
      console.warn(`INSTANCE_REGISTRY_SMOKE: cleanup incomplete (${removed.reason})`);
    }
    return summary;
  }

  try {
    if (!isSafeRoot()) throw new Error(`INSTANCE_REGISTRY_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    fs.mkdirSync(rt, { recursive: true });
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.OPEN_LIVE_VIEW = '0';

    const { registerInstance, snapshotRegistry, instanceFilePath } = await import('../dist/registry.js');
    const { computeHealth, computeBuildFingerprint, packageVersion } = await import('../dist/health.js');
    const { distDir } = await import('../dist/config.js');
    const { atomicWriteJson } = await import('../dist/job-store.js');
    const { isAlive, killTree } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    isAliveFn = isAlive;
    killTreeFn = killTree;
    queryProcessStartTimeFn = queryProcessStartTime;

    const T0 = 1_700_000_000_000;
    let clock = T0;

    // 1) Register our own live instance with an injectable clock.
    self = registerInstance({
      entry: 'index.js',
      buildFingerprint: computeBuildFingerprint(distDir()),
      version: packageVersion(),
      now: () => clock,
    });
    if (!fs.existsSync(instanceFilePath(self.instanceId))) {
      failures += 1;
      console.error('REGISTRY_SMOKE_FAIL: own record must exist after registerInstance');
    }

    // 2) Controlled "other" records.
    function rec(instanceId, pid, over = {}) {
      return {
        schemaVersion: 1,
        instanceId,
        pid,
        processStartedAt: new Date(T0 - 60_000).toISOString(),
        serverStartedAt: new Date(T0 - 60_000).toISOString(),
        entry: 'index.js',
        buildFingerprint: 'a'.repeat(64),
        lastHeartbeatAt: new Date(T0).toISOString(),
        version: '1.0.0',
        ...over,
      };
    }
    atomicWriteJson(instanceFilePath('live-other'), rec('live-other', 777, { processStartedAt: new Date(T0 - 60_000).toISOString() }));
    atomicWriteJson(instanceFilePath('residue'), rec('residue', 999));
    atomicWriteJson(instanceFilePath('reuse'), rec('reuse', 888));
    fs.mkdirSync(path.dirname(instanceFilePath('corrupt')), { recursive: true });
    fs.writeFileSync(instanceFilePath('corrupt'), '{definitely not json', 'utf8');

    // 3) Snapshot with an injectable inspector.
    const inspector = {
      exists: (pid) => pid === 777 || pid === 888,
      startTime: (pid) => (pid === 777 ? T0 - 60_000 : pid === 888 ? T0 - 5_000 : null),
    };
    const snapshot = snapshotRegistry({
      instanceId: self.instanceId,
      now: T0 + 1_000,
      heartbeatMs: 10_000,
      staleAfterMs: 30_000,
      inspector,
    });
    const okSnapshot =
      snapshot.recorded === true &&
      snapshot.instanceCount === 5 &&
      snapshot.liveCount === 2 &&
      snapshot.staleCount === 3 &&
      snapshot.duplicateInstanceSuspected === true &&
      snapshot.registryStale === true &&
      snapshot.staleReasons.heartbeat_timeout === undefined &&
      snapshot.staleReasons.pid_not_found === 1 &&
      snapshot.staleReasons.identity_mismatch === 1 &&
      snapshot.staleReasons.corrupt === 1;
    console.log('snapshot:', JSON.stringify(snapshot, null, 2));
    if (!okSnapshot) {
      failures += 1;
      console.error('REGISTRY_SMOKE_FAIL: snapshot classification assertion failed');
    }

    // 4) Health integration: duplicate + stale coexist with a healthy build.
    const entry = path.resolve(HERE, '..', 'dist', 'index.js');
    const health = computeHealth({
      entryPath: entry,
      loadedBuildHash: 'x'.repeat(64),
      loadedBuildFingerprint: computeBuildFingerprint(distDir()),
      startedAt: Date.now(),
      registeredTools: ['claude_code_health', 'claude_code_watch', 'claude_code_status', 'claude_code_reply'],
      version: packageVersion(),
      registry: snapshot,
    });
    const codes = health.diagnostics.map((diagnostic) => diagnostic.code).sort();
    const okHealth =
      health.diagnostic === 'healthy/current' &&
      health.reloadRequired === false &&
      health.duplicateInstanceSuspected === true &&
      health.registryStale === true &&
      codes.includes('duplicate_instance_suspected') &&
      codes.includes('registry_stale') &&
      !JSON.stringify(health).includes(rt) &&
      !JSON.stringify(health).includes('PROXY_MANAGED');
    console.log('health.diagnostics:', JSON.stringify(health.diagnostics, null, 2));
    if (!okHealth) {
      failures += 1;
      console.error('REGISTRY_SMOKE_FAIL: health integration assertion failed');
    }

    // 5) Explicitly unregister; finally repeats this idempotently if an earlier
    // assertion or exception interrupts the scenario.
    const selfInstanceId = self.instanceId;
    self.unregister();
    self = null;
    if (fs.existsSync(instanceFilePath(selfInstanceId))) {
      failures += 1;
      console.error('REGISTRY_SMOKE_FAIL: unregister must remove our own record');
    }
    for (const id of ['live-other', 'residue', 'reuse', 'corrupt']) {
      try {
        fs.unlinkSync(instanceFilePath(id));
      } catch {
        // Isolated temp-dir cleanup; the final exact-root removal is authoritative.
      }
    }
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    try {
      cleanupSummary = await cleanup();
    } catch (err) {
      console.warn(`INSTANCE_REGISTRY_SMOKE: cleanup threw (${err?.message ?? String(err)})`);
      cleanupSummary = {
        ok: false,
        reason: 'cleanup-threw',
        rootBasename: path.basename(rt),
        rootRemoved: false,
        recordedCount: 0,
        verifiedCount: 0,
        skippedCount: 0,
        deadCount: 0,
        killedCount: 0,
        stillAliveCount: 0,
      };
    }
  }

  if (failures === 0 && cleanupSummary?.ok) {
    console.log('INSTANCE_REGISTRY_SMOKE_OK');
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary?.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(
      thrownMsg
        ? `INSTANCE_REGISTRY_SMOKE_FAIL — ${thrownMsg}${cleanupNote}`
        : `INSTANCE_REGISTRY_SMOKE_FAIL (${failures} assertion(s) failed)${cleanupNote}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
