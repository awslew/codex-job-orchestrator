#!/usr/bin/env node
// Wave 6 T6B2: one bounded entry point for all smoke checks.
//
// Usage:
//   node scripts/run-smoke-suite.mjs --mode=gate
//   node scripts/run-smoke-suite.mjs --mode=offline-all
//   node scripts/run-smoke-suite.mjs --mode=all
//
// Every manifest item is represented in the final JSON summary. Selected
// smoke processes run one at a time so each isolated runtime owns its own
// resources; the process lifecycle itself is fully asynchronous and has a
// hard per-item deadline.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_TAIL_BYTES = 64 * 1024;
const MAX_FAILURE_TAIL_CHARS = 2048;
const VALID_MODES = new Set(['gate', 'offline-all', 'all']);
const SUMMARY_PREFIX = 'SMOKE_SUITE_SUMMARY_JSON:';

const SKIP_NOT_SELECTED = 'skipped: mode does not select this smoke category';
const SKIP_LIVE_GUARD = 'skipped: live smoke requires --mode=all and ORCHESTRATOR_ALLOW_LIVE_SMOKE=1';

const smoke = (id, script, category, timeoutMs, marker) =>
  Object.freeze({ id, script, category, timeoutMs, marker });

export const SMOKE_MANIFEST = Object.freeze([
  smoke('attention-smoke', 'attention-smoke.mjs', 'gate_offline', 300_000, 'ATTENTION_SMOKE_OK'),
  smoke('attention-transient', 'attention-transient-smoke.mjs', 'gate_offline', 300_000, 'ATTENTION_TRANSIENT_OK'),
  smoke('checkpoint-bootstrap', 'checkpoint-bootstrap-smoke.mjs', 'gate_offline', 300_000, 'CHECKPOINT_BOOTSTRAP_SMOKE_OK'),
  smoke('health', 'health-smoke.mjs', 'gate_offline', 180_000, 'HEALTH_SMOKE_OK'),
  smoke('instance-registry', 'instance-registry-smoke.mjs', 'gate_offline', 180_000, 'INSTANCE_REGISTRY_SMOKE_OK'),
  smoke('stage2a-response-audit', 'stage2a-response-audit-smoke.mjs', 'gate_offline', 300_000, 'STAGE2A_OK'),
  smoke('long-job-check', 'long-job-check.mjs', 'extended_offline', 600_000, 'LONG_OK'),
  smoke('watch-long', 'watch-long-smoke.mjs', 'extended_offline', 600_000, 'WATCH_LONG_OK'),
  smoke('real-smoke', 'real-smoke.mjs', 'live', 600_000, 'ALL_SMOKES_OK'),
  smoke('viewer-off', 'viewer-off-smoke.mjs', 'live', 600_000, 'VIEWER_OFF_SMOKE_OK'),
]);

class TailBuffer {
  #chunks = [];
  #bytes = 0;

  append(value) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
    if (chunk.length === 0) return;
    this.#chunks.push(chunk);
    this.#bytes += chunk.length;
    while (this.#bytes > MAX_TAIL_BYTES && this.#chunks.length > 0) {
      const first = this.#chunks[0];
      const excess = this.#bytes - MAX_TAIL_BYTES;
      if (first.length <= excess) {
        this.#chunks.shift();
        this.#bytes -= first.length;
      } else {
        this.#chunks[0] = first.subarray(excess);
        this.#bytes -= excess;
      }
    }
  }

  get byteLength() {
    return this.#bytes;
  }

  text() {
    return Buffer.concat(this.#chunks, this.#bytes).toString('utf8');
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runTaskkill(pid) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let killer;
    try {
      killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => finish(false), 15_000);
    timer.unref?.();
    killer.once('error', () => {
      clearTimeout(timer);
      finish(false);
    });
    killer.once('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

async function terminateTree(child, childClosed) {
  const pid = child.pid;
  if (!pid) return false;
  let killIssued = false;
  if (process.platform === 'win32') {
    killIssued = await runTaskkill(pid);
    if (!killIssued) {
      try {
        killIssued = child.kill();
      } catch {
        killIssued = false;
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
      killIssued = true;
    } catch {
      try {
        killIssued = child.kill('SIGTERM');
      } catch {
        killIssued = false;
      }
    }
  }

  let closed = await Promise.race([childClosed.then(() => true), delay(5_000).then(() => false)]);
  if (!closed) {
    if (process.platform === 'win32') {
      await runTaskkill(pid);
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // The child may have exited between the two checks.
        }
      }
    }
    closed = await Promise.race([childClosed.then(() => true), delay(5_000).then(() => false)]);
  }
  return killIssued && closed;
}

function cleanupFailure(output) {
  return /(?:cleanup|rootRemoved)\s*[:=][^\r\n]*(?:false|fail|incomplete|error)/i.test(output) ||
    /cleanup[^\r\n]*(?:refused|incomplete|failed)/i.test(output);
}

function selectedFor(item, mode, liveAllowed) {
  if (item.category === 'gate_offline') return true;
  if (item.category === 'extended_offline') return mode !== 'gate';
  return mode === 'all' && liveAllowed;
}

function skippedReason(item, mode, liveAllowed) {
  if (item.category === 'live') {
    return mode === 'all' && !liveAllowed ? SKIP_LIVE_GUARD : SKIP_NOT_SELECTED;
  }
  return SKIP_NOT_SELECTED;
}

export function parseMode(args = process.argv.slice(2)) {
  let mode = 'gate';
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--mode' && args[i + 1]) {
      mode = args[++i];
    } else if (arg.startsWith('--mode=')) {
      mode = arg.slice('--mode='.length);
    }
  }
  return mode;
}

export async function runSmoke(item) {
  const startedAt = Date.now();
  const scriptPath = path.join(ROOT, 'smoke', item.script);
  const stdoutTail = new TailBuffer();
  const stderrTail = new TailBuffer();
  let child;
  try {
    child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORCHESTRATOR_SMOKE_ITEM: item.id },
    });
  } catch (error) {
    return {
      id: item.id,
      category: item.category,
      status: 'failed',
      durationMs: Date.now() - startedAt,
      exitCode: null,
      reason: `spawn_error:${error instanceof Error ? error.message : String(error)}`,
      failureTail: '',
    };
  }

  child.stdout?.on('data', (chunk) => stdoutTail.append(chunk));
  child.stderr?.on('data', (chunk) => stderrTail.append(chunk));

  let closeValue;
  let closeResolver;
  const childClosed = new Promise((resolve) => {
    closeResolver = resolve;
  });
  child.once('close', (code, signal) => {
    closeValue = { code, signal };
    closeResolver(closeValue);
  });

  let timedOut = false;
  let cleanupOk = true;
  let terminationPromise = null;
  let timeoutResolve;
  const timeoutFired = new Promise((resolve) => {
    timeoutResolve = resolve;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    terminationPromise = terminateTree(child, childClosed).then((ok) => {
      cleanupOk = ok;
      return ok;
    }).finally(() => timeoutResolve());
  }, item.timeoutMs);
  timer.unref?.();

  let spawnError = null;
  let spawnErrorResolve;
  const spawnErrorPromise = new Promise((resolve) => {
    spawnErrorResolve = resolve;
  });
  child.once('error', (error) => {
    spawnError = error;
    spawnErrorResolve(error);
  });
  const firstOutcome = await Promise.race([
    childClosed.then(() => 'closed'),
    spawnErrorPromise.then(() => 'error'),
    timeoutFired.then(() => 'timeout'),
  ]);
  if (firstOutcome === 'error' && !closeValue) {
    await Promise.race([childClosed, delay(250)]);
  }
  if (terminationPromise) await terminationPromise;
  clearTimeout(timer);
  if (firstOutcome === 'timeout' && !closeValue) {
    await Promise.race([childClosed, delay(1_000)]);
  }

  const close = closeValue ?? { code: null, signal: null };
  const output = `${stdoutTail.text()}\n${stderrTail.text()}`;
  const markerSeen = output.includes(item.marker);
  const durationMs = Date.now() - startedAt;
  let status = 'passed';
  let reason = 'ok';
  if (timedOut) {
    status = 'timeout';
    reason = cleanupOk ? 'timeout' : 'timeout_cleanup_failed';
  } else if (spawnError) {
    status = 'failed';
    reason = `spawn_error:${spawnError.message}`;
  } else if (close.code !== 0) {
    status = 'failed';
    reason = close.code === null ? `signal:${close.signal ?? 'unknown'}` : `exit_code:${close.code}`;
  } else if (cleanupFailure(output)) {
    status = 'failed';
    reason = 'cleanup_failure';
  } else if (!markerSeen) {
    status = 'failed';
    reason = 'missing_success_marker';
  }

  // Keep the stream-size facts in process memory only. A bounded output tail is
  // emitted solely for failed/timeout items to keep the summary actionable
  // without duplicating it in the human-readable table below.
  void stdoutTail.byteLength;
  void stderrTail.byteLength;
  const result = {
    id: item.id,
    category: item.category,
    status,
    durationMs,
    exitCode: close.code,
    reason,
  };
  if (status === 'failed' || status === 'timeout') {
    result.failureTail = output.slice(-MAX_FAILURE_TAIL_CHARS);
  }
  return result;
}

function printTable(items) {
  console.log('SMOKE SUITE');
  console.log('| id | category | status | durationMs | exitCode | reason |');
  console.log('|---|---|---:|---:|---:|---|');
  for (const item of items) {
    const reason = String(item.reason ?? '').replace(/[\r\n|]+/g, ' ').slice(0, 200);
    console.log(`| ${item.id} | ${item.category} | ${item.status} | ${item.durationMs} | ${String(item.exitCode)} | ${reason} |`);
  }
}

export async function runSmokeSuite(mode) {
  const liveAllowed = process.env.ORCHESTRATOR_ALLOW_LIVE_SMOKE === '1';
  const results = [];
  for (const item of SMOKE_MANIFEST) {
    if (!selectedFor(item, mode, liveAllowed)) {
      results.push({
        id: item.id,
        category: item.category,
        status: 'skipped',
        durationMs: 0,
        exitCode: null,
        reason: skippedReason(item, mode, liveAllowed),
      });
      continue;
    }
    console.log(`[${item.id}] starting (timeout=${item.timeoutMs}ms)`);
    const result = await runSmoke(item);
    results.push(result);
    console.log(`[${item.id}] ${result.status} duration=${result.durationMs}ms exitCode=${String(result.exitCode)} reason=${result.reason}`);
  }

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode,
    liveAllowed,
    items: results,
  };
  console.log(`${SUMMARY_PREFIX}${JSON.stringify(summary)}`);
  printTable(results);
  const failed = results.some((result) => result.status !== 'passed' && result.status !== 'skipped');
  process.exitCode = failed ? 1 : 0;
  return { summary, failed };
}

export async function main(args = process.argv.slice(2)) {
  const mode = parseMode(args);
  if (!VALID_MODES.has(mode)) {
    console.error('usage: node scripts/run-smoke-suite.mjs --mode=gate|offline-all|all');
    process.exitCode = 2;
    return null;
  }
  return runSmokeSuite(mode);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    return path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) await main();
