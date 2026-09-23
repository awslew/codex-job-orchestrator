#!/usr/bin/env node
// Wave 6 T6B1: bounded, asynchronous test-tier runner.
//
// Usage: node scripts/run-test-tier.mjs <unit|integration|windows|gate>
//
// The runner owns the child-process lifecycle. Each layer is a fresh
// node --test process, runs serially inside that process, and has a hard
// wall-clock budget. Only a bounded tail of each output stream is retained;
// complete test logs are never copied into this runner's output.
// Unit contains 7 files; integration contains 25 files (including the
// attention-stress fixture); Windows contains the proc identity suite.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_TEST = path.join(ROOT, 'dist-test', 'test');
const MAX_TAIL_BYTES = 4 * 1024 * 1024;
const TEST_COUNT_GATE = 333;

const UNIT_FILES = [
  'backend-policy.test.js',
  'budget.test.js',
  'contracts-v2.test.js',
  'job-metrics.test.js',
  'leader-backend.test.js',
  'leader.test.js',
  'parser.test.js',
];

const INTEGRATION_FILES = [
  'acceptance-runner.test.js',
  'admission-controller.test.js',
  'admission-supervisor-lease.test.js',
  'admission.test.js',
  'attention-cleanup.test.js',
  'attention-stress.test.js',
  'budget-hook.test.js',
  'deepseek-worker.test.js',
  'health.test.js',
  'job-events.test.js',
  'job-index.test.js',
  'job-store.test.js',
  'protocol.test.js',
  'recovery.test.js',
  'registry.test.js',
  'retention.test.js',
  'review-policy.test.js',
  'router.test.js',
  'scheduler-admission.test.js',
  'scheduler.test.js',
  'supervisor-admission-integration.test.js',
  'supervisor-budget-metrics.test.js',
  'viewer.test.js',
  'watch.test.js',
  'worker-adapter.test.js',
];

const WINDOWS_FILES = ['proc.test.js'];

export const LAYERS = Object.freeze({
  unit: Object.freeze({ files: UNIT_FILES, timeoutMs: 60_000 }),
  integration: Object.freeze({ files: INTEGRATION_FILES, timeoutMs: 1_200_000 }),
  windows: Object.freeze({ files: WINDOWS_FILES, timeoutMs: 300_000 }),
});

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

const emptyStats = () => ({ tests: 0, pass: 0, fail: 0, skipped: 0, durationMs: null });

function lastTapNumber(output, key) {
  const re = new RegExp(`^[#ℹ] ${key} (\\d+)$`, 'gim');
  let value = null;
  for (const match of output.matchAll(re)) value = Number(match[1]);
  return value ?? 0;
}

export function parseTap(output) {
  const stats = emptyStats();
  stats.tests = lastTapNumber(output, 'tests');
  stats.pass = lastTapNumber(output, 'pass');
  stats.fail = lastTapNumber(output, 'fail');
  stats.skipped = lastTapNumber(output, 'skipped');
  const durations = [...output.matchAll(/^[#ℹ] duration_ms ([\d.]+)$/gim)];
  if (durations.length > 0) stats.durationMs = Number(durations.at(-1)[1]);
  return stats;
}

/**
 * Extract TAP failure blocks from merged child output.
 *
 * For every `not ok <number> - <name>` line, the block continues until the
 * next test point (any other `ok`/`not ok` line at the same or outer
 * indentation; more-indented points belong to an inner subtest) or until a
 * TAP plan/summary line. Only the last 4096 points are scanned so
 * pathological output stays bounded. Without any recognizable failure block
 * the last `maxChars` of the merged output are returned verbatim. When the
 * extracted blocks exceed `maxChars`, the head of the combined block text
 * (which holds the failure names) is retained and `truncated` is set.
 */
export function extractFailureDiagnostics(output, { maxChars = 16000 } = {}) {
  const MAX_POINTS = 4096;
  const text = String(output ?? '');
  const points = [];
  for (const match of text.matchAll(/^[ \t]*([0-9]+)\.\.([0-9]+)\s*$/gm)) {
    points.push({ line: match.index, end: match.index + match[0].length, kind: 'plan' });
  }
  for (const match of text.matchAll(/^# tests[ \t]+\d+\s*$/gm)) {
    points.push({ line: match.index, end: match.index + match[0].length, kind: 'summary' });
  }
  for (const match of text.matchAll(/^( *)(not ok|ok)(?:[ \t]+(\d+))?[ \t]*(?:-)?[ \t]*(.*)$/gm)) {
    if (points.some((p) => p.line < match.index && match.index < p.end)) continue;
    points.push({
      line: match.index,
      end: match.index + match[0].length,
      kind: match[2],
      number: match[3] ? Number(match[3]) : null,
      name: match[4] ?? '',
      indent: match[1].length,
    });
  }
  points.sort((a, b) => a.line - b.line);
  const scanned = points.slice(-MAX_POINTS);
  const failures = [];
  for (let i = 0; i < scanned.length; i++) {
    const p = scanned[i];
    if (p.kind !== 'not ok') continue;
    let end = p.end;
    for (let j = i + 1; j < scanned.length; j++) {
      const q = scanned[j];
      if (q.kind === 'plan' || q.kind === 'summary') {
        end = q.line;
        break;
      }
      if (q.kind === 'ok' || q.kind === 'not ok') {
        if (q.indent > p.indent) continue; // inner subtest: belongs to this block
        end = q.line;
        break;
      }
    }
    failures.push({
      number: p.number,
      name: p.name,
      content: text.slice(p.line, end).replace(/\s+$/, ''),
    });
  }
  const blocks = failures.map((f) => f.content).filter((b) => b.length > 0);
  const joined = blocks.join('\n');
  if (joined.length > 0) {
    return {
      diagnostics: joined.length > maxChars ? joined.slice(0, maxChars) : joined,
      truncated: joined.length > maxChars,
    };
  }
  // No recognizable failure block: fall back to the last maxChars of output.
  return { diagnostics: text.slice(-maxChars), truncated: false };
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

/**
 * Terminate only the process tree belonging to `child`, then wait briefly for
 * its close event. On Windows taskkill is scoped to the exact child PID; on
 * POSIX the child is detached into its own process group before spawn.
 */
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
          // The process may have exited between the two checks.
        }
      }
    }
    closed = await Promise.race([childClosed.then(() => true), delay(5_000).then(() => false)]);
  }
  return killIssued && closed;
}

export async function runCommand(name, argv, { timeoutMs, parseOutput = true } = {}) {
  const startedAt = Date.now();
  const stdoutTail = new TailBuffer();
  const stderrTail = new TailBuffer();
  let child;
  try {
    child = spawn(argv[0], argv.slice(1), {
      cwd: ROOT,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    return {
      name,
      stats: emptyStats(),
      failed: true,
      timedOut: false,
      cleanupOk: true,
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      reason: `spawn_error:${error instanceof Error ? error.message : String(error)}`,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTail: '',
      stderrTail: '',
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
  }, timeoutMs);
  timer.unref?.();

  const spawnError = new Promise((resolve) => {
    child.once('error', (error) => resolve(error));
  });
  const settled = await Promise.race([
    childClosed.then(() => ({ kind: 'close' })),
    spawnError.then((error) => ({ kind: 'error', error })),
    timeoutFired.then(() => ({ kind: 'timeout' })),
  ]);
  if (settled.kind === 'error' && !closeValue) {
    // A failed spawn normally emits close immediately afterwards. Give that
    // close event a short chance so the same lifecycle path is used.
    await Promise.race([childClosed, delay(250)]);
  }
  if (terminationPromise) await terminationPromise;
  clearTimeout(timer);

  const close = closeValue ?? { code: null, signal: null };
  if (settled.kind === 'timeout' && !closeValue) {
    await Promise.race([childClosed, delay(1_000)]);
  }
  const output = parseOutput ? `${stdoutTail.text()}\n${stderrTail.text()}` : '';
  const stats = parseOutput ? parseTap(output) : emptyStats();
  const durationMs = Date.now() - startedAt;
  let reason = null;
  if (timedOut) reason = cleanupOk ? 'timeout' : 'timeout_cleanup_failed';
  else if (settled.kind === 'error') reason = `spawn_error:${settled.error?.message ?? 'unknown'}`;
  else if (close.code !== 0) reason = close.code === null ? `signal:${close.signal ?? 'unknown'}` : `exit_code:${close.code}`;
  else if (stats.fail > 0) reason = `test_failures:${stats.fail}`;

  return {
    name,
    stats,
    failed: reason !== null,
    timedOut,
    cleanupOk,
    exitCode: close.code,
    signal: close.signal,
    durationMs,
    reason,
    stdoutBytes: stdoutTail.byteLength,
    stderrBytes: stderrTail.byteLength,
    stdoutTail: stdoutTail.text(),
    stderrTail: stderrTail.text(),
  };
}

function compiledFiles(files) {
  return files.map((file) => path.join(DIST_TEST, file));
}

function formatLayer(result) {
  const { stats } = result;
  const reason = result.reason ? ` reason=${result.reason}` : '';
  return `[${result.name}] ${result.failed ? 'FAIL' : 'PASS'} duration=${result.durationMs}ms exitCode=${String(result.exitCode)} tests=${stats.tests} pass=${stats.pass} fail=${stats.fail} skipped=${stats.skipped}${reason}`;
}

export async function runLayer(name) {
  const layer = LAYERS[name];
  if (!layer) throw new Error(`unknown test layer: ${name}`);
  const files = compiledFiles(layer.files);
  const argv = [process.execPath, '--test', '--test-concurrency=1', ...files];
  const result = await runCommand(name, argv, { timeoutMs: layer.timeoutMs });
  if (result.failed) {
    const { diagnostics, truncated } = extractFailureDiagnostics(
      `${result.stdoutTail ?? ''}${result.stderrTail ?? ''}`,
    );
    console.log(`[${name}] FAILURE_DIAGNOSTICS_BEGIN${truncated ? ' (truncated)' : ''}`);
    console.log(diagnostics);
    console.log(`[${name}] FAILURE_DIAGNOSTICS_END`);
  }
  return result;
}

async function runSmokeGate() {
  const smokeScript = path.join(ROOT, 'scripts', 'run-smoke-suite.mjs');
  return runCommand('smoke-gate', [process.execPath, smokeScript, '--mode=gate'], {
    // The per-item smoke budgets remain authoritative. This outer ceiling is
    // only a final runaway guard for the six selected gate smoke processes.
    timeoutMs: 1_800_000,
    parseOutput: false,
  });
}

export async function runGate() {
  const results = [];
  for (const name of ['unit', 'integration', 'windows']) {
    const result = await runLayer(name);
    results.push(result);
    console.log(formatLayer(result));
    if (result.failed) {
      console.log(`[gate] ${name} failed; later layers were not started.`);
      process.exitCode = 1;
      return { results, passed: false, tests: results.reduce((n, r) => n + r.stats.tests, 0) };
    }
  }

  const tests = results.reduce((n, result) => n + result.stats.tests, 0);
  if (tests < TEST_COUNT_GATE) {
    console.log(`[gate] test count ${tests} < ${TEST_COUNT_GATE}; smoke gate was not started.`);
    process.exitCode = 1;
    return { results, passed: false, tests };
  }

  const smoke = await runSmokeGate();
  results.push(smoke);
  console.log(formatLayer(smoke));
  if (smoke.failed) {
    console.log('[gate] smoke gate failed.');
    process.exitCode = 1;
    return { results, passed: false, tests };
  }

  console.log(`[gate] unit -> integration -> windows -> smoke gate passed; tests=${tests}`);
  process.exitCode = 0;
  return { results, passed: true, tests };
}

export async function main(args = process.argv.slice(2)) {
  const tier = args[0];
  if (tier === 'gate') return runGate();
  if (tier === 'unit' || tier === 'integration' || tier === 'windows') {
    const result = await runLayer(tier);
    console.log(formatLayer(result));
    process.exitCode = result.failed ? 1 : 0;
    return result;
  }
  console.error('usage: node scripts/run-test-tier.mjs <unit|integration|windows|gate>');
  process.exitCode = 2;
  return null;
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
