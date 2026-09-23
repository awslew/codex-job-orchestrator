// Health / version / reload-diagnostics smoke (Stage 3, hardened in Stage 5).
// Exercises the built health helper against the real dist entry: loaded
// fingerprint == disk fingerprint -> healthy/current, verifies capability flags,
// the no-leak surface, the new full-build fingerprint semantics (a change to a
// dependency module with an unchanged entry must trigger reload_required), and
// the inert-registry default.
//
// Run after `npm run build`:  node smoke/health-smoke.mjs
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
    if (!isSafeRoot()) {
      summary.ok = false;
      summary.reason = 'guard-refused';
      console.warn(`HEALTH_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
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
      console.warn(`HEALTH_SMOKE: ${stillAlive.length} recorded process(es) still alive after bounded wait`);
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
      console.warn(`HEALTH_SMOKE: cleanup incomplete (${removed.reason})`);
    }
    return summary;
  }

  try {
    if (!isSafeRoot()) throw new Error(`HEALTH_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
    fs.mkdirSync(rt, { recursive: true });
    process.env.ORCHESTRATOR_RUNTIME = rt;
    process.env.ORCHESTRATOR_WORKDIR = path.join(rt, 'work');

    const { computeHealth, computeBuildFingerprint, sha256File, packageVersion } = await import('../dist/health.js');
    const { distDir } = await import('../dist/config.js');
    const { isAlive, killTree } = await import('../dist/proc.js');
    const { queryProcessStartTime } = await import('../dist/registry.js');
    isAliveFn = isAlive;
    killTreeFn = killTree;
    queryProcessStartTimeFn = queryProcessStartTime;

    const entry = path.resolve(HERE, '..', 'dist', 'index.js');
    const loadedHash = sha256File(entry);
    const loadedFp = computeBuildFingerprint(distDir());
    const registered = [
      'claude_code_health',
      'claude_code_watch',
      'claude_code_status',
      'claude_code_reply',
      'claude_code_start',
      'claude_code_wait',
      'claude_code_cancel',
      'claude_code_list',
    ];
    const view = computeHealth({
      entryPath: entry,
      loadedBuildHash: loadedHash,
      loadedBuildFingerprint: loadedFp,
      startedAt: Date.now(),
      registeredTools: registered,
      version: packageVersion(),
    });
    console.log('health:', JSON.stringify(view, null, 2));

    const ok =
      view.reloadRequired === false &&
      view.diagnostic === 'healthy/current' &&
      view.loaded.buildHash === loadedHash &&
      view.disk.buildHash === loadedHash &&
      view.loaded.buildFingerprint === loadedFp &&
      view.disk.buildFingerprint === loadedFp &&
      view.loaded.buildFingerprint.length === 64 &&
      view.capabilities.tools.includes('claude_code_watch') &&
      view.capabilities.structuredAttentionDetail === true &&
      view.capabilities.responseAudit === true &&
      view.duplicateInstanceSuspected === false &&
      view.registryStale === false &&
      view.registry.enabled === false &&
      Array.isArray(view.diagnostics) &&
      !JSON.stringify(view).includes('PROXY_MANAGED') &&
      !JSON.stringify(view).includes('command');
    if (!ok) {
      failures += 1;
      console.error('HEALTH_SMOKE_FAIL: healthy-path assertion failed');
    }

    // Deterministically prove the full-build fingerprint branch: index.js
    // unchanged but a dependency module changed -> reload_required.
    const tmp = path.join(rt, 'dist-fp');
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'index.js'), 'const A = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'scheduler.js'), 'const B = 2;\n', 'utf8');
    const fpBefore = computeBuildFingerprint(tmp);
    if (!fpBefore) {
      failures += 1;
      console.error('HEALTH_SMOKE_FAIL: fingerprint of a readable dir must be non-empty');
    }
    fs.writeFileSync(path.join(tmp, 'scheduler.js'), 'const B = 3;\n', 'utf8');
    const fpAfter = computeBuildFingerprint(tmp);
    if (fpAfter === fpBefore) {
      failures += 1;
      console.error('HEALTH_SMOKE_FAIL: a dependency change with unchanged entry must change the fingerprint');
    }
    if (computeBuildFingerprint(path.join(rt, 'no-such-dir')) !== '') {
      failures += 1;
      console.error('HEALTH_SMOKE_FAIL: unreadable module set must yield an empty fingerprint (hash_unavailable)');
    }
    console.log('full-build fingerprint semantics: OK (dep change triggers, unreadable -> unavailable)');
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    try {
      cleanupSummary = await cleanup();
    } catch (err) {
      console.warn(`HEALTH_SMOKE: cleanup threw (${err?.message ?? String(err)})`);
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
    console.log('HEALTH_SMOKE_OK');
    process.exitCode = 0;
  } else {
    const cleanupNote = cleanupSummary?.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
    console.error(
      thrownMsg
        ? `HEALTH_SMOKE_FAIL — ${thrownMsg}${cleanupNote}`
        : `HEALTH_SMOKE_FAIL (${failures} assertion(s) failed)${cleanupNote}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
