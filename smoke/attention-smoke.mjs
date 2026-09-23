// Stage 7 structured-attention smoke: a focused, repeatable matrix over the
// already-implemented structured-attention behavior, driven by the fake claude
// (test/fake-claude.mjs) so no real proxy is contacted. Each scenario uses an
// ISOLATED temp runtime and its own work dir; the smoke cleans up exactly its
// own jobs/processes/runtime artifacts and never touches the global runtime,
// logs, or any process outside this run.
//
// Matrix (asserts public persisted/job behavior, not implementation):
//   S1  stdout banner-only              -> succeeded, never needs_attention
//   S2  stderr banner-only              -> succeeded, never needs_attention
//   S3  slow normal (>5s)               -> succeeded, no false attention
//   S4  structured control_request      -> needs_attention with sanitized
//                                          structured detail; reply audit
//                                          authorization=false
//   S5a duplicate same requestId        -> published exactly once
//   S5b two distinct requestIds         -> stay distinct, never merged
//   S6  structured transient            -> auto-resolves to succeeded
//   S7  resume/banner-only on a reply   -> no local/unknown attention synthesized
//
// Evidence sanitization: every serialized public view / watch result / audit we
// surface must never contain the stored prompt, a token/key, the raw structured
// payload, the full command line, or env values/keys. Raw worker logs (which
// legitimately contain the fake's banner text) are never read as evidence and
// never printed.
//
// Windows cleanup (Stage 7 fix): the old cleanup() ran only in a `finally` that
// was never reached because every exit path called process.exit(), which does
// NOT execute finally blocks. The smoke now exits naturally via process.exitCode
// so the finally always runs, and cleanup is async with an exact-root guard, a
// bounded wait for this run's recorded PIDs to die, and a bounded retry delete.
//
// PID-safe smoke guard (bootstrap): cleanup refuses to kill anything it cannot
// prove is this run's own worker. Before ANY killTree, a recorded pid must pass
// a fail-closed identity gate: a positive integer, not this process, not in the
// current ancestor chain, and with an OS-reported start time that is verifiable
// and >= this run's start threshold (conservative clock tolerance). Candidates
// are enumerated ONLY from this run's isolated rt/jobs — old residue siblings
// are never scanned or deleted. ORCHESTRATOR_SMOKE_DRY_RUN=1 makes cleanup
// non-destructive: zero killTree calls; the exact validated rt root is removed
// only when no recorded process remains alive, otherwise cleanup reports nonzero
// and leaves it for audit. Import-order isolation: the dist modules that read
// runtime/config are imported only AFTER ORCHESTRATOR_RUNTIME (and the isolated
// workdir variable) are set, so every runtime path resolves inside this run's rt.
//
// The pure guard/cleanup helpers are exported so a later standalone test file
// can exercise them without triggering the full smoke (the smoke body runs only
// when this file is the entry point).
//
// Run after `npm run build`:  node smoke/attention-smoke.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FAKE = path.join(ROOT, 'test', 'fake-claude.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Case-insensitive normalized absolute path (Windows drive letters / separators).
const norm = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);

// True only when this file is the entry point (node smoke/attention-smoke.mjs).
// Importing the module for tests must NOT run the smoke body.
function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const self = path.resolve(fileURLToPath(import.meta.url));
    const arg = path.resolve(process.argv[1]);
    return norm(arg) === norm(self);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Pure cleanup / root-guard helpers (exported for a later test file; importing
// this module has no side effects: no temp runtime, no dist imports, no env).
// ---------------------------------------------------------------------------

// Exact-root validation for this smoke run's isolated temp runtime. A candidate
// is deletable only if it is a DIRECT child of the OS temp dir, its basename is
// `orc-attn-smoke-<ownPid>-<digits>` with the embedded pid equal to ownPid, and
// it is neither the temp root, nor the project root, nor the project runtime
// dir. Any mismatch -> false (never delete).
export function isSafeRuntimeRoot(candidate, ownPid, tmpDir = os.tmpdir(), projectRoot = ROOT) {
  if (typeof candidate !== 'string' || candidate.length === 0) return false;
  if (!Number.isInteger(ownPid) || ownPid <= 0) return false;
  const root = path.resolve(candidate);
  const tmp = path.resolve(tmpDir);
  const proj = path.resolve(projectRoot);
  const runtime = path.join(proj, 'runtime');
  if (norm(root) === norm(tmp)) return false; // never the temp root itself
  if (norm(path.dirname(root)) !== norm(tmp)) return false; // must be a direct child of temp
  if (norm(root) === norm(proj) || norm(root) === norm(runtime)) return false; // never project/runtime root
  const m = /^orc-attn-smoke-(\d+)-\d+$/.exec(path.basename(root));
  if (!m) return false; // must match our exact naming pattern
  return Number(m[1]) === ownPid; // embedded pid must be THIS run's pid
}

// Enumerate ONLY job records inside this run's isolated rt/jobs and collect the
// positive-integer pid / supervisorPid values those records reference, WITH the
// identity evidence available from each record (which field, jobId, job-record
// startedAt, bootstrap updatedAt). Never scans anything outside the given jobs
// dir; returns an empty array on any read/parse error. The job-record startedAt
// is evidence only — it is never trusted as OS process identity (PID reuse); the
// kill gate uses the OS-reported start time instead.
export function collectRecordedPidCandidates(jobsDir) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(jobsDir);
  } catch {
    return out;
  }
  for (const f of names) {
    if (!f.endsWith('.json') || f.endsWith('.done.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8'));
    } catch {
      continue;
    }
    if (rec == null || typeof rec !== 'object') continue;
    const jobId = typeof rec.jobId === 'string' ? rec.jobId : null;
    const recordStartedAt = typeof rec.startedAt === 'string' ? rec.startedAt : null;
    const bootstrapUpdatedAt =
      rec.bootstrap && typeof rec.bootstrap === 'object' && typeof rec.bootstrap.updatedAt === 'string'
        ? rec.bootstrap.updatedAt
        : null;
    for (const key of ['pid', 'supervisorPid']) {
      const v = rec[key];
      if (typeof v === 'number' && Number.isInteger(v) && v > 0) {
        out.push({ pid: v, key, jobId, recordStartedAt, bootstrapUpdatedAt });
      }
    }
  }
  return out;
}

// Legacy flat view: the distinct positive-integer pids recorded in this jobs dir
// (used by the standalone cleanup test seam). Deduplicated; never scans outside
// the given dir.
export function collectRecordedPids(jobsDir) {
  return [...new Set(collectRecordedPidCandidates(jobsDir).map((c) => c.pid))];
}

// Smoke-local parent-pid query used ONLY to build the ancestor chain for the kill
// gate. Returns the parent PID number or null (fails closed). Never inspects
// command lines, env, or keys — the same conservative scope as the registry's
// process-start query.
export function queryParentPid(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const r = spawnSync('wmic', ['process', 'where', `ProcessId=${pid}`, 'get', 'ParentProcessId', '/value'], {
        windowsHide: true,
        timeout: 3000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0) return null;
      const m = /ParentProcessId=(\d+)/.exec(r.stdout ?? '');
      return m ? Number(m[1]) : null;
    }
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = stat.lastIndexOf(')');
      if (close < 0) return null;
      const rest = stat.slice(close + 1).trim().split(/\s+/);
      const v = Number(rest[1]); // field 4 (ppid) => index 4 - 3 = 1
      return Number.isFinite(v) ? v : null;
    }
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      windowsHide: true,
      timeout: 3000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) return null;
    const v = Number((r.stdout ?? '').trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

// Ancestor pid set of THIS process (process.ppid, then walk up, bounded). Used
// by the kill gate so we never kill our own parent/shell if a recorded pid was
// reused by an ancestor. Best-effort: if a hop is unreadable we stop; the gate
// only rejects pids actually found in the chain ("when available").
export function buildAncestorPidSet({ queryParentPidFn, maxDepth = 16 } = {}) {
  const q = queryParentPidFn ?? queryParentPid;
  const set = new Set();
  let cur = typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : null;
  if (cur == null) {
    try {
      cur = q(process.pid);
    } catch {
      return set;
    }
  }
  for (let i = 0; i < maxDepth && cur != null; i++) {
    if (set.has(cur)) break;
    set.add(cur);
    if (cur <= 1) break;
    try {
      cur = q(cur);
    } catch {
      break;
    }
  }
  return set;
}

// Fail-closed identity gate for a recorded pid BEFORE any real kill. Returns
// { ok: true } only when the pid is a positive integer, is not this process, is
// not in the current ancestor chain, and its OS-reported start time is
// verifiable and >= runStartedAtMs - clockToleranceMs (conservative clock
// tolerance). Any unknown/mismatch => { ok: false, reason } and the candidate is
// skipped with a warning, never killed. osStartTimeFn is injectable for tests;
// the default (no function) fails closed.
export function evaluatePidCandidate(pid, opts = {}) {
  const { ownPid, ancestorPids = [], runStartedAtMs, osStartTimeFn, clockToleranceMs = 5000 } = opts;
  if (!Number.isInteger(pid) || pid <= 0) return { ok: false, reason: 'non-positive' };
  if (Number.isInteger(ownPid) && pid === ownPid) return { ok: false, reason: 'self' };
  const ancestors = ancestorPids instanceof Set ? ancestorPids : new Set(Array.isArray(ancestorPids) ? ancestorPids : []);
  if (ancestors.has(pid)) return { ok: false, reason: 'ancestor' };
  if (!Number.isFinite(runStartedAtMs)) return { ok: false, reason: 'no-run-threshold' };
  if (typeof osStartTimeFn !== 'function') return { ok: false, reason: 'unverifiable-start' };
  let osStart = null;
  try {
    osStart = osStartTimeFn(pid);
  } catch {
    osStart = null;
  }
  if (osStart === null) return { ok: false, reason: 'unverifiable-start' };
  if (osStart < runStartedAtMs - clockToleranceMs) return { ok: false, reason: 'pre-run' };
  return { ok: true };
}

// Bounded wait for PIDs to become dead. Budget: attempts x stepMs, default
// 20 x 250ms = 5s max. isAliveFn is injectable for tests (default mirrors
// proc.ts isAlive). Returns the pids still alive after the budget.
export async function waitForDead(pids, { attempts = 20, stepMs = 250, isAliveFn } = {}) {
  const alive = new Set((pids ?? []).filter((p) => Number.isInteger(p) && p > 0));
  const check =
    isAliveFn ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e && e.code) === 'EPERM';
      }
    });
  for (let i = 0; i < attempts && alive.size > 0; i++) {
    for (const pid of alive) {
      try {
        if (!check(pid)) alive.delete(pid);
      } catch {
        alive.delete(pid);
      }
    }
    if (alive.size > 0 && i < attempts - 1) await sleep(stepMs);
  }
  return [...alive];
}

// Delete ONLY a validated exact runtime root with bounded Windows retry.
// Revalidates the target before EVERY attempt. Total wait is finite:
// attempts x (rmSync internal maxRetries x retryDelay + retryDelayMs).
export async function boundedRemoveRuntime(
  candidate,
  ownPid,
  tmpDir = os.tmpdir(),
  projectRoot = ROOT,
  { attempts = 5, retryDelayMs = 250, rmRetries = 3, rmRetryDelayMs = 250 } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (!isSafeRuntimeRoot(candidate, ownPid, tmpDir, projectRoot)) return { ok: false, reason: 'guard-refused' };
    try {
      if (!fs.existsSync(candidate)) return { ok: true }; // already gone
    } catch {
      return { ok: false, reason: 'stat-failed' };
    }
    try {
      fs.rmSync(candidate, { recursive: true, force: true, maxRetries: rmRetries, retryDelay: rmRetryDelayMs });
      try {
        if (!fs.existsSync(candidate)) return { ok: true };
      } catch {
        return { ok: true }; // vanished mid-check
      }
    } catch {
      /* transient lock (EBUSY/EPERM); retry after delay */
    }
    if (attempt < attempts - 1) await sleep(retryDelayMs);
  }
  return { ok: false, reason: 'remove-failed' };
}

// ---------------------------------------------------------------------------
// Smoke body. Runs ONLY when this file is the entry point so a test file can
// import the exported helpers above without executing any scenario.
// ---------------------------------------------------------------------------
async function main() {
  // Import-order isolation: capture this run's identity and create the isolated
  // temp runtime BEFORE any dist import, so config (which reads
  // ORCHESTRATOR_RUNTIME lazily at call time) and every module that derives
  // runtime paths resolve inside this exact rt — never the global runtime.
  const runStartedAtMs = Date.now(); // workers can only spawn after this instant
  const processStartedAtMs = Date.now() - process.uptime() * 1000; // this node's OS-ish start
  const ownPid = process.pid;
  const isDryRun = process.env.ORCHESTRATOR_SMOKE_DRY_RUN === '1';
  if (!Number.isFinite(processStartedAtMs) || processStartedAtMs > runStartedAtMs) {
    throw new Error('ATTENTION_SMOKE: process identity clock anomaly');
  }

  // Fresh exact runtime root: a direct child of os.tmpdir(), named
  // orc-attn-smoke-<ownPid>-<digits> so the existing guard owns it uniquely.
  const rt = path.join(os.tmpdir(), `orc-attn-smoke-${ownPid}-${Date.now()}`);
  if (!isSafeRuntimeRoot(rt, ownPid)) {
    throw new Error(`ATTENTION_SMOKE: refused unsafe runtime root ${path.basename(rt)}`);
  }
  fs.mkdirSync(rt, { recursive: true });
  if (!isSafeRuntimeRoot(rt, ownPid)) {
    try {
      fs.rmSync(rt, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* best effort: only our own freshly-created exact root */
    }
    throw new Error(`ATTENTION_SMOKE: runtime root failed revalidation ${path.basename(rt)}`);
  }

  // Isolated workdir variable: points work under this run's rt. Not read by dist
  // today; set before the import anyway so any runtime/config reader is fully
  // contained here.
  const workRoot = path.join(rt, 'work');
  process.env.ORCHESTRATOR_RUNTIME = rt;
  process.env.ORCHESTRATOR_WORKDIR = workRoot;
  process.env.OPEN_LIVE_VIEW = '0';
  // Short confirm window so a genuinely blocked structured signal is promoted to
  // needs_attention quickly, while a transient signal (result well before this) is
  // never promoted.
  process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '500';

  // Dynamic import AFTER env setup: these dist modules read runtime/config.
  const { startJob, getStatus, getRenderedStatus, watchJob, replyJob, cancelJob } = await import('../dist/scheduler.js');
  const { readJob, atomicWriteJson, jobFilePath, logFilePath, stderrLogFilePath, reportFilePath, newJobId, newSessionId } = await import('../dist/job-store.js');
  const { newBootstrap } = await import('../dist/recovery.js');
  const { killTree, isAlive } = await import('../dist/proc.js');
  const { queryProcessStartTime } = await import('../dist/registry.js');

  const nowIso = () => new Date().toISOString();

  async function poll(pred, { timeoutMs = 10000, stepMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = pred();
      if (last) return last;
      await sleep(stepMs);
    }
    return last;
  }

  let failures = 0;
  function check(name, cond, detail = '') {
    if (cond) {
      console.log(`  ok: ${name}`);
      return;
    }
    failures += 1;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Evidence sanitization (requirement 8). Anything we serialize to the console
  // or treat as "output evidence" must not contain: the stored prompt, auth
  // token values / env keys, the raw structured payload wrapper or event types,
  // the full command line, or env values. getStatus/getRenderedStatus raw
  // worker-log tails are never used as evidence; only sanitized public views are.
  // -------------------------------------------------------------------------
  const FORBIDDEN = [
    'PROXY_MANAGED',        // auth token value written into the job settings
    'ANTHROPIC_',           // env key prefix
    '"permission"',         // raw structured payload wrapper
    'control_request',      // raw structured event type
    'userPrompt',           // raw upstream event type
    'rm ',                  // full permission command fragment
    '--session-id',         // command-line flag (full argv must never surface)
    '--add-dir',            // command-line flag
    '--permission-mode',    // command-line flag
    '--output-format',      // command-line flag
    'claude=',              // supervisor "claude=<cmd>" banner prefix
    'FAKE_MODE',            // env key
    'FAKE_CLAUDE_',         // env key prefix
    'FAKE_REQUEST_ID',      // env key
    'CLAUDE_CLI_PREFIX',    // env key
    'ORCHESTRATOR_',        // env key prefix
    'OPEN_LIVE_VIEW',       // env key
    '"authorization":true', // a reply/audit must never authorize
  ];

  function assertCleanEvidence(label, evidenceList, prompts) {
    for (let i = 0; i < evidenceList.length; i++) {
      const ev = evidenceList[i];
      if (ev === undefined || ev === null) continue;
      const raw = typeof ev === 'string' ? ev : JSON.stringify(ev);
      const hit =
        FORBIDDEN.find((m) => raw.includes(m)) ??
        prompts.find((p) => p && raw.includes(p));
      check(`${label} evidence#${i + 1}: sanitized`, hit === undefined, hit ? `contains ${JSON.stringify(hit)}` : '');
    }
  }

  // The sanitized rendered status tail (never the raw worker logs). stderrLines 0
  // keeps the supervisor's own "claude=<full argv>" meta banner out of evidence.
  function renderedStatus(jobId) {
    return getRenderedStatus(jobId, { lines: 3, stderrLines: 0 });
  }

  // -------------------------------------------------------------------------
  // Cleanup: enumerate ONLY this run's recorded job/supervisor PIDs from the
  // validated rt/jobs, apply the fail-closed identity gate, then (normal mode)
  // killTree ONLY the identity-verified pids, bounded-wait, and delete ONLY the
  // validated exact rt root with bounded Windows retry. Dry-run
  // (ORCHESTRATOR_SMOKE_DRY_RUN=1) performs ZERO killTree calls: it reports only
  // safe counts, removes the root only when no recorded process remains alive,
  // and otherwise reports nonzero and leaves the root for audit. Never
  // broad-kills, never scans/deletes siblings or the global runtime. The
  // returned summary exposes only safe basename/counts and whether the root was
  // removed — no raw pids, paths, commands, env, or payloads.
  // -------------------------------------------------------------------------
  const PID_IDENTITY_TOLERANCE_MS = 5000;
  const REMOVE_OPTS = { attempts: 5, retryDelayMs: 250, rmRetries: 3, rmRetryDelayMs: 250 };
  const sanitizePids = (pids) => [...new Set((pids ?? []).filter((pid) => Number.isInteger(pid) && pid > 0))];

  async function cleanup() {
    const summary = {
      ok: true,
      reason: null,
      dryRun: isDryRun,
      rootBasename: path.basename(rt),
      rootRemoved: false,
      recordedCount: 0,
      verifiedCount: 0,
      skippedCount: 0,
      deadCount: 0,
      killedCount: 0,
      stillAliveCount: 0,
      stillAlivePids: [],
    };
    if (!isSafeRuntimeRoot(rt, ownPid)) {
      console.warn(`ATTENTION_SMOKE: cleanup refused unsafe runtime root ${summary.rootBasename}`);
      summary.ok = false;
      summary.reason = 'guard-refused';
      return summary;
    }

    const candidates = collectRecordedPidCandidates(path.join(rt, 'jobs'));
    summary.recordedCount = candidates.length;
    const recordedAll = [...new Set(candidates.map((c) => c.pid))];

    // Read-only liveness pre-filter: only LIVE candidates need an identity gate
    // (a dead pid cannot be killed and is never a target). No kill here.
    const aliveCandidates = candidates.filter((c) => {
      try {
        return isAlive(c.pid);
      } catch {
        return false;
      }
    });
    summary.deadCount = candidates.length - aliveCandidates.length;

    // Fail-closed identity gate over the live candidates.
    const verifiedPids = new Set();
    const rejectedByReason = new Map();
    if (aliveCandidates.length > 0) {
      let ancestorPids = new Set();
      try {
        ancestorPids = buildAncestorPidSet();
      } catch {
        /* fail closed: an empty ancestor set only skips the ancestor check */
      }
      for (const c of aliveCandidates) {
        const verdict = evaluatePidCandidate(c.pid, {
          ownPid,
          ancestorPids,
          runStartedAtMs,
          osStartTimeFn: queryProcessStartTime,
          clockToleranceMs: PID_IDENTITY_TOLERANCE_MS,
        });
        if (verdict.ok) verifiedPids.add(c.pid);
        else rejectedByReason.set(verdict.reason, (rejectedByReason.get(verdict.reason) ?? 0) + 1);
      }
    }
    summary.verifiedCount = verifiedPids.size;
    summary.skippedCount = aliveCandidates.length - verifiedPids.size;
    for (const [reason, n] of rejectedByReason) {
      console.warn(`ATTENTION_SMOKE: skipped ${n} live kill candidate(s): ${reason}`);
    }

    if (isDryRun) {
      // Non-destructive: zero killTree calls. Report only safe counts. Remove the
      // exact validated root ONLY when no recorded process remains alive;
      // otherwise report nonzero and leave the root for audit.
      const stillAlive = await waitForDead(recordedAll, { attempts: 1, stepMs: 0, isAliveFn: isAlive });
      const sanitizedStillAlivePids = sanitizePids(stillAlive);
      summary.stillAlivePids = sanitizedStillAlivePids;
      summary.stillAliveCount = sanitizedStillAlivePids.length;
      if (sanitizedStillAlivePids.length > 0) {
        summary.ok = false;
        summary.reason = 'recorded-process-still-alive';
        console.warn(
          `ATTENTION_SMOKE: dry-run leaves runtime root for audit (${summary.stillAliveCount} recorded process(es) alive, no kill attempted); pids=${JSON.stringify(sanitizedStillAlivePids)}`,
        );
        return summary;
      }
      const res = await boundedRemoveRuntime(rt, ownPid, os.tmpdir(), ROOT, REMOVE_OPTS);
      summary.rootRemoved = res.ok;
      if (!res.ok) {
        summary.ok = false;
        summary.reason = res.reason;
        console.warn(`ATTENTION_SMOKE: dry-run cleanup incomplete for ${summary.rootBasename} (${res.reason})`);
      }
      return summary;
    }

    // Normal mode: kill ONLY identity-verified pids, bounded-wait, then remove
    // the exact root. A still-alive recorded pid (verified survivor or skipped
    // candidate) leaves a nonzero summary and a warning; removal is still
    // attempted with the existing bounded retry.
    const killList = [...verifiedPids];
    for (const pid of killList) {
      try {
        killTree(pid);
        summary.killedCount += 1;
      } catch {
        /* best effort */
      }
    }
    const stillAlive = await waitForDead(recordedAll, { attempts: 60, stepMs: 250, isAliveFn: isAlive });
    const sanitizedStillAlivePids = sanitizePids(stillAlive);
    summary.stillAlivePids = sanitizedStillAlivePids;
    summary.stillAliveCount = sanitizedStillAlivePids.length;
    if (sanitizedStillAlivePids.length > 0) {
      summary.ok = false;
      summary.reason = 'still-alive';
      console.warn(
        `ATTENTION_SMOKE: ${summary.stillAliveCount} recorded process(es) still alive after bounded wait; pids=${JSON.stringify(sanitizedStillAlivePids)}`,
      );
    }
    const res = await boundedRemoveRuntime(rt, ownPid, os.tmpdir(), ROOT, REMOVE_OPTS);
    summary.rootRemoved = res.ok;
    if (!res.ok) {
      summary.ok = false;
      summary.reason = res.reason;
      console.warn(`ATTENTION_SMOKE: cleanup incomplete for ${summary.rootBasename} (${res.reason})`);
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // S1/S2: banner-only output (plain text on stdout/stderr, never a structured
  // request) must finish succeeded and never enter needs_attention.
  // -------------------------------------------------------------------------
  async function scenarioS1() {
    console.log('SCENARIO S1: stdout banner-only does not enter needs_attention');
    const work = path.join(rt, 'work-s1');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: stdout banner';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_MODE: 'banner_stdout_success' },
    });
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S1: succeeded', v.status === 'succeeded', `status=${v.status}`);
    check('S1: wakeReason terminal', v.wakeReason === 'terminal', v.wakeReason);
    check('S1: no attentionDetail on watch', v.attentionDetail == null);
    const st = getStatus(job.jobId);
    check('S1: status succeeded', st.status === 'succeeded', st.status);
    check('S1: no attentionDetail on status', st.attentionDetail === undefined);
    const stored = readJob(job.jobId);
    check('S1: no attentionLog persisted', !stored?.attentionLog || stored.attentionLog.length === 0);
    // Only the watch view is evidence; getStatus/getRenderedStatus of a banner job
    // would surface the raw banner text (the fake's own worker output), so those
    // raw tails are never serialized as evidence.
    assertCleanEvidence('S1', [v], [prompt]);
  }

  async function scenarioS2() {
    console.log('SCENARIO S2: stderr banner-only does not enter needs_attention');
    const work = path.join(rt, 'work-s2');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: stderr banner';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_MODE: 'banner_stderr_success' },
    });
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S2: succeeded', v.status === 'succeeded', `status=${v.status}`);
    check('S2: wakeReason terminal', v.wakeReason === 'terminal', v.wakeReason);
    check('S2: no attentionDetail on watch', v.attentionDetail == null);
    const st = getStatus(job.jobId);
    check('S2: status succeeded', st.status === 'succeeded', st.status);
    check('S2: no attentionDetail on status', st.attentionDetail === undefined);
    const stored = readJob(job.jobId);
    check('S2: no attentionLog persisted', !stored?.attentionLog || stored.attentionLog.length === 0);
    assertCleanEvidence('S2', [v], [prompt]);
  }

  // -------------------------------------------------------------------------
  // S3: a genuinely slow (>5s) ordinary job must run to succeeded with no false
  // attention, even well past the confirm window.
  // -------------------------------------------------------------------------
  async function scenarioS3() {
    console.log('SCENARIO S3: slow normal >5s succeeds without false attention');
    const work = path.join(rt, 'work-s3');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: slow normal';
    const t0 = Date.now();
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_MODE: 'slow_normal_success', FAKE_CLAUDE_SLOW_SECONDS: '6' },
    });
    await poll(() => getStatus(job.jobId).status === 'running');
    // Comfortably past the 500ms confirm window, well before the 6s result.
    await sleep(1200);
    const mid = getStatus(job.jobId);
    check('S3: still running past the confirm window', mid.status === 'running', `status=${mid.status}`);
    check('S3: no premature attention while working', mid.attentionDetail === undefined);
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S3: succeeded', v.status === 'succeeded', `status=${v.status}`);
    check('S3: wakeReason terminal', v.wakeReason === 'terminal', v.wakeReason);
    check('S3: no attentionDetail on success', v.attentionDetail == null);
    check('S3: genuinely >5s', Date.now() - t0 >= 5000, `${Date.now() - t0}ms`);
    const stored = readJob(job.jobId);
    check('S3: no attentionLog persisted', !stored?.attentionLog || stored.attentionLog.length === 0);
    assertCleanEvidence('S3', [v, renderedStatus(job.jobId)], [prompt]);
  }

  // -------------------------------------------------------------------------
  // S4: a genuine structured control_request reaches needs_attention with a
  // sanitized structured detail, and a leader reply records a non-authorizing
  // response audit (authorization=false).
  // -------------------------------------------------------------------------
  async function scenarioS4() {
    console.log('SCENARIO S4: structured control_request reaches needs_attention + audit authorization=false');
    const work = path.join(rt, 'work-s4');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: structured control';
    const replyPrompt = 'stage7 smoke: resume the blocked session';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_MODE: 'structured_control_once',
        FAKE_REQUEST_ID: 'req-ctrl-1',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '15',
      },
    });
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S4: needs_attention', v.status === 'needs_attention', `status=${v.status}`);
    check('S4: wakeReason needs_attention', v.wakeReason === 'needs_attention', v.wakeReason);
    const d = v.attentionDetail;
    check('S4: attentionDetail present', !!d);
    check('S4: upstream requestId preserved', d?.requestId === 'req-ctrl-1', `requestId=${d?.requestId}`);
    check('S4: requestIdSource upstream', d?.requestIdSource === 'upstream', `source=${d?.requestIdSource}`);
    check('S4: tool Read', d?.tool === 'Read', `tool=${d?.tool}`);
    check('S4: action read', d?.action === 'read', `action=${d?.action}`);
    check('S4: sanitized relative path', d?.path === 'probe.txt', `path=${d?.path}`);
    check('S4: risk low', d?.risk === 'low', `risk=${d?.risk}`);

    const st = getStatus(job.jobId);
    check('S4: status needs_attention', st.status === 'needs_attention', st.status);
    check('S4: status echoes the same requestId', st.attentionDetail?.requestId === 'req-ctrl-1');
    const stored = readJob(job.jobId);
    check('S4: one published attention entry', stored?.attentionLog?.length === 1, `len=${stored?.attentionLog?.length}`);
    check('S4: persisted entry upstream', stored?.attentionLog?.[0]?.requestIdSource === 'upstream');

    // Leader reply -> non-authorizing observability audit on the NEW reply job.
    const reply = replyJob(job.jobId, replyPrompt);
    const audit = readJob(reply.job.jobId)?.attentionResponseAudit;
    check('S4: reply recorded a response audit', !!audit);
    check('S4: audit authorization=false', audit?.authorization === false, `authorization=${audit?.authorization}`);
    check('S4: audit effect resume_requested', audit?.effect === 'resume_requested', `effect=${audit?.effect}`);
    check('S4: audit snapshots the upstream id', audit?.attention?.requestId === 'req-ctrl-1', `id=${audit?.attention?.requestId}`);
    check('S4: audit tool Read', audit?.attention?.tool === 'Read');
    check('S4: audit action read', audit?.attention?.action === 'read');
    check('S4: audit path probe.txt', audit?.attention?.path === 'probe.txt');

    assertCleanEvidence('S4', [v, renderedStatus(job.jobId), reply.job, audit], [prompt, replyPrompt]);

    try {
      cancelJob(reply.job.jobId);
    } catch {
      /* best-effort cleanup */
    }
    try {
      cancelJob(job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }

  // -------------------------------------------------------------------------
  // S5a: the same upstream requestId reported twice publishes exactly once.
  // -------------------------------------------------------------------------
  async function scenarioS5a() {
    console.log('SCENARIO S5a: duplicate same requestId publishes once');
    const work = path.join(rt, 'work-s5a');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: duplicate id';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_MODE: 'structured_permission_duplicate',
        FAKE_REQUEST_ID: 'req-dup-1',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '15',
      },
    });
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S5a: needs_attention', v.status === 'needs_attention', `status=${v.status}`);
    check('S5a: requestId preserved', v.attentionDetail?.requestId === 'req-dup-1', `id=${v.attentionDetail?.requestId}`);
    const stored = readJob(job.jobId);
    const log = stored?.attentionLog ?? [];
    check('S5a: duplicated id collapses to one entry', log.length === 1, `len=${log.length}`);
    check('S5a: entry upstream', log[0]?.requestIdSource === 'upstream');
    check('S5a: entry tool Read', log[0]?.tool === 'Read');
    assertCleanEvidence('S5a', [v, renderedStatus(job.jobId)], [prompt]);
    try {
      cancelJob(job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }

  // -------------------------------------------------------------------------
  // S5b: two distinct upstream requestIds stay distinct in the attentionLog and
  // are never merged, even across episodes.
  // -------------------------------------------------------------------------
  async function scenarioS5b() {
    console.log('SCENARIO S5b: two distinct requestIds stay distinct');
    const work = path.join(rt, 'work-s5b');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: two ids';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_MODE: 'structured_two_ids',
        FAKE_REQUEST_ID: 'req-a',
        FAKE_REQUEST_ID_2: 'req-b',
        FAKE_CLAUDE_STRUCTURED_PATH: 'probe.txt',
        FAKE_CLAUDE_RUN_SECONDS: '5',
      },
    });
    const log = await poll(() => {
      const l = readJob(job.jobId)?.attentionLog ?? [];
      return l.length >= 2 ? l : null;
    }, { timeoutMs: 10000 });
    check('S5b: two distinct episodes recorded', !!log && log.length >= 2, `len=${log?.length}`);
    const ids = (log ?? []).map((e) => e.requestId);
    check('S5b: first upstream id preserved', ids.includes('req-a'), JSON.stringify(ids));
    check('S5b: second upstream id preserved', ids.includes('req-b'), JSON.stringify(ids));
    check('S5b: ids stay distinct, never merged', new Set(ids).size === 2, JSON.stringify(ids));
    check('S5b: both episodes upstream', (log ?? []).every((e) => e.requestIdSource === 'upstream'));
    check('S5b: first episode published first', ids[0] === 'req-a', JSON.stringify(ids));
    // The public status view reflects the latest distinct episode (req-b).
    const st = getStatus(job.jobId);
    check('S5b: status shows the latest distinct id', st.attentionDetail?.requestId === 'req-b', `id=${st.attentionDetail?.requestId}`);
    assertCleanEvidence('S5b', [renderedStatus(job.jobId)], [prompt]);
    try {
      cancelJob(job.jobId);
    } catch {
      /* best-effort cleanup */
    }
  }

  // -------------------------------------------------------------------------
  // S6: a structured transient request auto-resolves normally — the leader is
  // never woken and no attention is persisted.
  // -------------------------------------------------------------------------
  async function scenarioS6() {
    console.log('SCENARIO S6: structured transient auto-resolves normally');
    const work = path.join(rt, 'work-s6');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: transient';
    const { job } = startJob({
      prompt,
      workFolder: work,
      profile: 'auto',
      parallelism: 'auto',
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: {
        FAKE_MODE: 'structured_transient_success',
        FAKE_REQUEST_ID: 'req-transient',
        FAKE_CLAUDE_TRANSIENT_SECONDS: '0.1',
      },
    });
    const v = await watchJob(job.jobId, { timeoutSeconds: 30 });
    check('S6: succeeded', v.status === 'succeeded', `status=${v.status}`);
    check('S6: wakeReason terminal', v.wakeReason === 'terminal', v.wakeReason);
    check('S6: no attentionDetail on watch', v.attentionDetail == null);
    const st = getStatus(job.jobId);
    check('S6: no attentionDetail on status', st.attentionDetail === undefined);
    const stored = readJob(job.jobId);
    check('S6: no attentionLog persisted', !stored?.attentionLog || stored.attentionLog.length === 0);
    assertCleanEvidence('S6', [v, renderedStatus(job.jobId)], [prompt]);
  }

  // -------------------------------------------------------------------------
  // S7: resuming a needs_attention job whose worker only emits banner/normal
  // output must NOT synthesize a new local/unknown attention; the reply succeeds
  // and the audit snapshots the existing upstream id with authorization=false.
  // -------------------------------------------------------------------------
  async function scenarioS7() {
    console.log('SCENARIO S7: resume/banner-only does not synthesize a local/unknown attention');
    const work = path.join(rt, 'work-s7');
    fs.mkdirSync(work, { recursive: true });
    const prompt = 'stage7 smoke: resume base';
    const replyPrompt = 'stage7 smoke: resume the task';

    const baseJobId = newJobId();
    const startedAt = nowIso();
    const base = {
      jobId: baseJobId,
      sessionId: newSessionId(),
      kind: 'start',
      replyToJobId: null,
      profile: 'auto',
      port: 15721,
      permissionMode: 'auto',
      parallelism: '1',
      workFolder: work,
      maxRuntimeMinutes: 30,
      pid: null,
      supervisorPid: null,
      status: 'needs_attention',
      substatus: 'permission_request',
      startedAt,
      endedAt: null,
      lastActivityAt: startedAt,
      exitCode: null,
      logPath: logFilePath(baseJobId),
      stderrLogPath: stderrLogFilePath(baseJobId),
      reportPath: reportFilePath(baseJobId),
      prompt,
      claudeCli: FAKE,
      claudePrefix: [process.execPath],
      extraEnv: { FAKE_MODE: 'resume_banner_success', FAKE_CLAUDE_RUN_SECONDS: '2' },
      lastOutputAt: startedAt,
      attentionLog: [
        {
          requestId: 'upstream-resume-1',
          requestIdSource: 'upstream',
          tool: 'Read',
          action: 'read',
          path: 'probe.txt',
          risk: 'low',
          at: startedAt,
          message: 'needs approval',
        },
      ],
      bootstrap: newBootstrap('worker_spawned', startedAt),
    };
    atomicWriteJson(jobFilePath(baseJobId), base);

    const reply = replyJob(baseJobId, replyPrompt);
    check('S7: reply recorded a response audit', !!reply.job.attentionResponseAudit);
    check('S7: audit authorization=false', reply.job.attentionResponseAudit?.authorization === false);

    const v = await watchJob(reply.job.jobId, { timeoutSeconds: 30 });
    check('S7: reply succeeded', v.status === 'succeeded', `status=${v.status}`);
    check('S7: wakeReason terminal', v.wakeReason === 'terminal', v.wakeReason);
    check('S7: no attentionDetail on reply watch', v.attentionDetail == null);
    const st = getStatus(reply.job.jobId);
    check('S7: reply status succeeded', st.status === 'succeeded', st.status);
    check('S7: no attentionDetail on reply status', st.attentionDetail === undefined);
    const stored = readJob(reply.job.jobId);
    check('S7: no attentionLog on the reply', !stored?.attentionLog || stored.attentionLog.length === 0);
    const audit = stored?.attentionResponseAudit;
    check('S7: audit snapshots the existing upstream id, never a new local one', audit?.attention?.requestId === 'upstream-resume-1', `id=${audit?.attention?.requestId}`);
    check('S7: audit keeps upstream source', audit?.attention?.requestIdSource === 'upstream');
    check('S7: audit tool Read', audit?.attention?.tool === 'Read');
    check('S7: audit path probe.txt', audit?.attention?.path === 'probe.txt');
    check('S7: audit authorization=false', audit?.authorization === false);
    const rendered = renderedStatus(reply.job.jobId);
    check('S7: rendered tail never shows the permission banner', !rendered.progress.includes('Do you want to proceed') && !rendered.progress.includes('rm '));
    assertCleanEvidence('S7', [v, reply.job, rendered, audit], [prompt, replyPrompt]);

    try {
      cancelJob(reply.job.jobId);
    } catch {
      /* best-effort cleanup */
    }
    try {
      cancelJob(baseJobId);
    } catch {
      /* best-effort cleanup */
    }
  }

  let thrownMsg = null;
  let cleanupSummary = null;
  try {
    await scenarioS1();
    await scenarioS2();
    await scenarioS3();
    await scenarioS4();
    await scenarioS5a();
    await scenarioS5b();
    await scenarioS6();
    await scenarioS7();
  } catch (err) {
    thrownMsg = err && err.message ? String(err.message).slice(0, 300) : String(err);
    failures += 1;
  } finally {
    try {
      cleanupSummary = await cleanup();
    } catch (err) {
      console.warn('ATTENTION_SMOKE: cleanup threw');
      cleanupSummary = {
        ok: false,
        reason: 'cleanup-threw',
        dryRun: isDryRun,
        rootBasename: path.basename(rt),
        rootRemoved: false,
        recordedCount: 0,
        verifiedCount: 0,
        skippedCount: 0,
        deadCount: 0,
        killedCount: 0,
        stillAliveCount: 0,
        stillAlivePids: [],
      };
    }
  }

  const clean = failures === 0 && cleanupSummary.ok;
  const cleanupStillAlivePids = sanitizePids(cleanupSummary?.stillAlivePids);
  const cleanupPidNote = cleanupStillAlivePids.length > 0 ? `; pids=${JSON.stringify(cleanupStillAlivePids)}` : '';
  if (isDryRun) {
    if (clean) {
      console.log(
        `ATTENTION_SMOKE_DRY_RUN_OK recorded=${cleanupSummary.recordedCount} verified=${cleanupSummary.verifiedCount} skipped=${cleanupSummary.skippedCount} dead=${cleanupSummary.deadCount} killed=0 alive=${cleanupSummary.stillAliveCount} rootRemoved=${cleanupSummary.rootRemoved}`,
      );
      process.exitCode = 0;
    } else {
      const cleanupNote = cleanupSummary.reason ? ` (cleanup: ${cleanupSummary.reason})` : '';
      console.error(
        `ATTENTION_SMOKE_DRY_RUN_FAIL assertions=${failures} recorded=${cleanupSummary.recordedCount} verified=${cleanupSummary.verifiedCount} skipped=${cleanupSummary.skippedCount} dead=${cleanupSummary.deadCount} killed=0 alive=${cleanupSummary.stillAliveCount} rootRemoved=${cleanupSummary.rootRemoved}${thrownMsg ? ` — ${thrownMsg}` : ''}${cleanupNote}${cleanupPidNote}`,
      );
      process.exitCode = 1;
    }
  } else if (failures === 0 && cleanupSummary.ok) {
    console.log('ATTENTION_SMOKE_OK');
    process.exitCode = 0;
  } else {
    console.error(
      thrownMsg
        ? `ATTENTION_SMOKE_FAIL — ${thrownMsg}${cleanupPidNote}`
        : `ATTENTION_SMOKE_FAIL (${failures} assertion(s) failed)${cleanupPidNote}`,
    );
    process.exitCode = 1;
  }
}

if (isMainModule()) {
  await main();
}
