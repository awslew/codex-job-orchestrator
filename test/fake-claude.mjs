#!/usr/bin/env node
// Fake Claude CLI used by orchestrator tests. Mirrors just enough of the
// claude CLI surface the supervisor builds so we can exercise the full
// supervisor lifecycle (spawn, streaming, exit codes, permission markers,
// session resume, long runtimes) without spending real proxy tokens.
//
// Behavior is controlled via env:
//   FAKE_CLAUDE_RUN_SECONDS  how long to stay alive before exiting (default 2)
//   FAKE_CLAUDE_EXIT_CODE    exit code (default 0)
//   FAKE_CLAUDE_USER_PROMPT  "1" to emit a userPrompt stream event (default off)
//   FAKE_CLAUDE_PERM_TOOL    which tool the permission event describes (default Bash)
//   FAKE_CLAUDE_PERM_PATH    path used in the permission prompt (default <cwd>\probe.txt)
//   FAKE_CLAUDE_PERM_TRANSIENT "1" to ALSO emit normal output after the
//                            permission event (auto-resolves -> job succeeds;
//                            default is blocking: only the permission event)
//   FAKE_CLAUDE_PERM_NO_ID   "1" to omit the upstream request id (forces a local id)
//   FAKE_CLAUDE_PERM_STDERR_MARKER "1" to also write a stderr permission banner
//                            AFTER the structured stdout event (tests that a
//                            generic echo does not downgrade the pending summary)
//   FAKE_CLAUDE_PERM_SECOND_ID <id> to emit a SECOND, distinct upstream
//                            userPrompt after ~1.2s (tests requestId isolation)
//   FAKE_CLAUDE_PERM_BANNER   "1" to also emit a plain assistant-text banner
//                            after the permission event (tests a brief banner
//                            does not cancel a still-blocked pending attention)
//   FAKE_CLAUDE_PERM_SELF_RECOVER "1" to emit a result event after ~1s
//                            (conclusive self-recovery: closes a confirmed block)
//   FAKE_CLAUDE_SELF_RECOVER_SECONDS  optional delay for that result event;
//                            defaults to 1s so early/transient fixtures keep
//                            their original timing
//   FAKE_CLAUDE_SELF_RECOVER_GATE <absolute gate path> to handshake the
//                            self-recover result with the test instead of a
//                            fixed sleep: the fake emits the userPrompt, then
//                            WAITS for the gate file to appear (bounded, 20s,
//                            25ms polls), and only then emits the result and
//                            exits 0. The TEST creates the gate; the fake never
//                            creates it. No gate -> the fixed-sleep behavior
//                            above stays unchanged.
//   FAKE_CLAUDE_PERM_SECOND_LOCAL "1" to ALSO emit a second, distinct LOCAL-only
//                            (no upstream id) userPrompt after ~2s (tests that
//                            consecutive local episodes get distinct local ids)
//   FAKE_MODE                "banner_stdout_success" | "banner_stderr_success"
//                            to emit ONE plain-text permission banner to the
//                            given stream (no structured JSON) then exit 0.
//                            "resume_banner_success" to emit a plain-text
//                            permission banner (human stream, never a structured
//                            request) then deterministic normal success/result,
//                            exit 0 (fresh and --resume invocations).
//                            "slow_normal_success" to emit ordinary non-permission
//                            progress immediately, then a deterministic result
//                            after FAKE_CLAUDE_SLOW_SECONDS and exit 0.
//                            OR a structured mode emitting genuine JSON
//                            permission/control events (then stay blocked and
//                            exit after FAKE_CLAUDE_RUN_SECONDS):
//                              structured_control_once          one control_request
//                                (tool Read / action read / relative path)
//                              structured_permission_duplicate  the same
//                                permission_request twice, one upstream id
//                              structured_two_ids              a permission_request
//                                then a control_request with distinct ids
//                              structured_transient_success    a control_request
//                                then a deterministic result after
//                                FAKE_CLAUDE_TRANSIENT_SECONDS (auto-resolves)
//   FAKE_CLAUDE_SLOW_SECONDS  how long FAKE_MODE=slow_normal_success waits before
//                            emitting the result and exiting (default 5.5)
//   FAKE_CLAUDE_TRANSIENT_SECONDS how long FAKE_MODE=structured_transient_success
//                            waits before emitting the auto-resolve result
//                            (default 1)
//   FAKE_REQUEST_ID          upstream requestId for the structured modes
//                            (default req-control-1, or req-a for two_ids)
//   FAKE_REQUEST_ID_2        second upstream requestId for structured_two_ids
//                            (default req-b)
//   FAKE_CLAUDE_WRITE_RELATIVE <relative path> to write a file before any fake
//   FAKE_CLAUDE_RESULT_TEXT  <text> final result event's result string (feeds
//                            isolated supervisor final-output regression tests)
//                            output (test-only hook: the resolved target must
//                            stay inside cwd — Windows case-insensitive, judged
//                            by path segment; absolute paths and ../ escapes are
//                            rejected with a stderr security error and exit 2)
//   FAKE_CLAUDE_WRITE_CONTENT content to write (default 'fake-worker-write')
//   FAKE_CLAUDE_ASSERT_REPORT_SKELETON "1" to require, BEFORE any success
//                            output, that the job's evidence report exists and
//                            carries the evidence-report-v1 schema with a
//                            'skeleton' completeness front matter. The report
//                            is resolved from the same --settings file the
//                            supervisor passes (its directory is the runtime
//                            settings dir, whose sibling 'reports' holds
//                            <jobId>.txt). On any failure a fixed stderr line
//                            is written and the fake exits 23.
//   FAKE_CLAUDE_BUDGET_MODE  "report_only" | "failed" to mutate the job's
//                            <jobId>.budget-state.json (same settings dir)
//                            before any output, as the real budget hook would:
//                            waits up to 2s (50ms polls) for the file to exist,
//                            rewrites budgetState.mode, violationCode
//                            (FAKE_CLAUDE_BUDGET_VIOLATION override, default
//                            tool_calls_exceeded) and lastUpdatedAtMs, written
//                            temp+rename in the same directory. A missing file
//                            that never appears (or an unreadable state) exits
//                            24 after the fixed stderr line.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let sessionId = null;
let resume = false;
let settingsPath = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--session-id') sessionId = args[++i];
  else if (a === '--resume') {
    resume = true;
    sessionId = args[++i];
  } else if (a === '--settings') settingsPath = args[++i];
  else if (a === '--effort' || a === '--permission-mode' || a === '--output-format' || a === '--mcp-config' || a === '--add-dir' || a === '--disallowedTools') i++;
  else if (a === '-p' || a === '--print' || a === '--strict-mcp-config') {
    /* no-op */
  }
}

let baseUrl = 'unset';
let jobId = null;
if (settingsPath && fs.existsSync(settingsPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    baseUrl = parsed.env?.ANTHROPIC_BASE_URL ?? 'unset';
    jobId = typeof parsed.jobId === 'string' && parsed.jobId.length > 0 ? parsed.jobId : null;
  } catch {
    baseUrl = 'unreadable';
  }
}
// The settings payload does not carry the jobId; the supervisor names the file
// <jobId>.settings.json, so the fixtures derive the job id from the filename
// when the payload has none.
if (jobId === null && settingsPath) {
  const base = path.basename(settingsPath);
  if (base.endsWith('.settings.json')) jobId = base.slice(0, -'.settings.json'.length);
}
const settingsDir = settingsPath ? path.dirname(path.resolve(settingsPath)) : null;
const reportPath = () => settingsDir && jobId ? path.join(settingsDir, '..', 'reports', `${jobId}.txt`) : null;
const budgetStatePath = () => settingsDir && jobId ? path.join(settingsDir, `${jobId}.budget-state.json`) : null;

function budgetStateRead(pathStr) {
  try {
    return JSON.parse(fs.readFileSync(pathStr, 'utf8'));
  } catch {
    return null;
  }
}

// Pre-output fixtures derived from --settings (report assertion and budget
// mutation both run BEFORE any fake output so tests observe the supervisor's
// own contract artifacts). Env-driven; the no-env path is byte-identical to
// the old behavior.
if (process.env.FAKE_CLAUDE_ASSERT_REPORT_SKELETON === '1') {
  const target = reportPath();
  let ok = target !== null && jobId !== null && fs.existsSync(target);
  if (ok) {
    try {
      const text = fs.readFileSync(target, 'utf8');
      ok = /^schema: evidence-report-v1$/m.test(text) && /^completeness: skeleton$/m.test(text);
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    process.stderr.write('fake-claude: report skeleton assertion failed\n');
    process.exit(23);
  }
}
if (process.env.FAKE_CLAUDE_BUDGET_MODE === 'report_only' || process.env.FAKE_CLAUDE_BUDGET_MODE === 'failed') {
  const statePath = budgetStatePath();
  let state = null;
  if (statePath && jobId !== null) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      state = budgetStateRead(statePath);
      if (state !== null) break;
      // Wait up to 2s, polling every 50ms, for the supervisor's prepareBudget
      // to write the state file (it lands before the settings file, which is
      // why the settings file already exists at this point).
      setTimeout(() => {}, 50);
    }
  }
  if (state === null || !statePath) {
    process.stderr.write('fake-claude: budget state not found\n');
    process.exit(24);
  }
  try {
    const next = {
      ...state,
      budgetState: {
        ...(state.budgetState ?? {}),
        mode: process.env.FAKE_CLAUDE_BUDGET_MODE,
        violationCode: process.env.FAKE_CLAUDE_BUDGET_VIOLATION || 'tool_calls_exceeded',
        lastUpdatedAtMs: Date.now(),
      },
    };
    const tmp = `${statePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, statePath);
  } catch (err) {
    process.stderr.write('fake-claude: budget state update failed\n');
    process.exit(24);
  }
}
// FAKE_CLAUDE_BUDGET_SIM: drive the REAL injected PreToolUse budget hook
// (budget-hook.js) through the Claude hook JSON protocol, as the real claude
// CLI would. Never fabricates job JSON — the hook, the budget config/state
// files and the supervisor's close-handler are all real production code.
//   "two_bash"        simulate TWO Bash calls in sequence; the first must be
//                     allowed by the hook (empty stdout), the second denied
//                     (budget_denied:bash_commands_exceeded) because the
//                     budget caps maxBashCommands at 1.
//   "runtime_overrun" rewrite THIS job's budget-config.json startedAtMs AND
//                     budget-state.json budgetState.startedAtMs back beyond the
//                     report-only window, then invoke the hook once with a Bash
//                     call: the real hook must deny with
//                     budget_denied:report_only_window (no real waiting).
//                     The state's mode/violationCode/counters are left intact —
//                     only the timestamps are backdated (the hook decides on
//                     budgetState.startedAtMs, not the config's).
// The hook command, config and state paths are parsed from the --settings
// PreToolUse hook the supervisor injected (quoted absolute paths). Evidence
// of both calls (allow/deny and the deny reason) is written to
// <jobId>.budget-hook-sim.json in the settings dir; any anomaly exits 25
// after a fixed stderr line. The no-env path is byte-identical to before.
if (process.env.FAKE_CLAUDE_BUDGET_SIM === 'two_bash' || process.env.FAKE_CLAUDE_BUDGET_SIM === 'runtime_overrun') {
  const simMode = process.env.FAKE_CLAUDE_BUDGET_SIM;
  const failSim = (msg) => {
    process.stderr.write(`fake-claude: budget sim failed: ${msg}\n`);
    process.exit(25);
  };
  if (!settingsPath || !jobId || !settingsDir) failSim('no settings/jobId');
  const hookCommand = (() => {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const chain = parsed.hooks?.PreToolUse;
      if (!Array.isArray(chain) || chain.length !== 1) return null;
      const entry = chain[0];
      if (typeof entry !== 'object' || entry === null) return null;
      const h = Array.isArray(entry.hooks) ? entry.hooks.find((x) => x && x.type === 'command') : null;
      if (!h || typeof h.command !== 'string' || !h.command.startsWith('node ')) return null;
      return h.command;
    } catch {
      return null;
    }
  })();
  if (hookCommand === null) failSim('injected budget hook not found in settings');
  const parts = Array.from(hookCommand.matchAll(/"([^"]+)"/g), (m) => m[1]);
  const [hookEntry, configPath, statePath] = parts;
  if (parts.length !== 3 || !hookEntry || !configPath || !statePath) failSim('cannot parse hook command paths');
  const simStatePath = () => path.join(settingsDir, `${jobId}.budget-hook-sim.json`);
  const bashInput = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const invokeHook = (input) => spawnSync(process.execPath, [hookEntry, '--config', configPath, '--state', statePath], { input, encoding: 'utf8', timeout: 10000 });
  if (simMode === 'two_bash') {
    const first = invokeHook(bashInput('sim call one'));
    if (first.status !== 0 || first.stdout.trim() !== '') failSim(`first Bash not allowed (stdout=${JSON.stringify(first.stdout.slice(0, 80))})`);
    const second = invokeHook(bashInput('sim call two'));
    let denied = null;
    if (second.status !== 0) failSim(`second Bash hook exited ${second.status}`);
    try {
      denied = JSON.parse(second.stdout).hookSpecificOutput?.permissionDecisionReason ?? null;
    } catch {
      denied = null;
    }
    if (!denied) failSim('second Bash was not denied');
    fs.writeFileSync(simStatePath(), JSON.stringify({ calls: [first.stdout, second.stdout], denyReason: denied }, null, 2), 'utf8');
  } else {
    const statePath2 = statePath;
    const deadline = Date.now() + 2000;
    let cfg = null;
    while (Date.now() < deadline) {
      try {
        cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.startedAtMs !== undefined && fs.existsSync(statePath2)) break;
      } catch {
        cfg = null;
      }
      setTimeout(() => {}, 50);
    }
    if (cfg === null || typeof cfg.startedAtMs !== 'number') failSim('budget config not found');
    const budget = cfg.budget ?? {};
    const windowMin = Number(budget.reportOnlyAfterMinutes ?? budget.maxRuntimeMinutes ?? 120);
    if (!Number.isFinite(windowMin) || windowMin <= 0) failSim('invalid budget window');
    const backdated = Date.now() - windowMin * 60_000 - 1000;
    // The hook's window check reads state.budgetState.startedAtMs (the config's
    // own startedAtMs is only persisted in the report skeleton). Backdate both
    // atomically via temp+rename; the state keeps its mode/violationCode/
    // counters — the hook itself must produce report_only_window.
    const backdateJson = (file, pick) => {
      const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const next = pick(raw);
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    };
    try {
      backdateJson(configPath, (raw) => ({ ...raw, startedAtMs: backdated }));
      backdateJson(statePath, (raw) => ({
        ...raw,
        budgetState: {
          ...(raw.budgetState ?? {}),
          startedAtMs: backdated,
          // Keep the state internally consistent: the backdated start precedes
          // the previous last update.
          lastUpdatedAtMs: Math.min(raw.budgetState?.lastUpdatedAtMs ?? backdated, backdated),
        },
      }));
    } catch (err) {
      process.stderr.write('fake-claude: budget sim config rewrite failed\n');
      process.exit(25);
    }
    const verdict = invokeHook(bashInput('sim overrun call'));
    let denied = null;
    if (verdict.status !== 0) failSim(`overrun hook exited ${verdict.status}`);
    try {
      denied = JSON.parse(verdict.stdout).hookSpecificOutput?.permissionDecisionReason ?? null;
    } catch {
      denied = null;
    }
    if (!denied) failSim('overrun Bash was not denied');
    if (!denied.includes('report_only_window')) failSim(`unexpected deny reason: ${denied}`);
    fs.writeFileSync(simStatePath(), JSON.stringify({ calls: [verdict.stdout], denyReason: denied }, null, 2), 'utf8');
  }
}

const runSeconds = Number(process.env.FAKE_CLAUDE_RUN_SECONDS ?? 2);
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? 0);
const emitUserPrompt = process.env.FAKE_CLAUDE_USER_PROMPT === '1';
const permTransient = process.env.FAKE_CLAUDE_PERM_TRANSIENT === '1';
const permNoId = process.env.FAKE_CLAUDE_PERM_NO_ID === '1';
const permTool = process.env.FAKE_CLAUDE_PERM_TOOL ?? 'Bash';
const permPath = process.env.FAKE_CLAUDE_PERM_PATH ?? path.join(process.cwd(), 'probe.txt');
const selfRecoverSeconds = Number(process.env.FAKE_CLAUDE_SELF_RECOVER_SECONDS ?? 1);
const selfRecoverGate = process.env.FAKE_CLAUDE_SELF_RECOVER_GATE;

// FAKE_MODE: banner-only behaviors. Emit ONE permission-looking banner to the
// chosen stream as plain text (no structured JSON), then exit 0.
const fakeMode = process.env.FAKE_MODE ?? '';
const slowMode = fakeMode === 'slow_normal_success';
const slowSeconds = Number(process.env.FAKE_CLAUDE_SLOW_SECONDS ?? 5.5);
const resumeBannerMode = fakeMode === 'resume_banner_success';
const structuredTransientMode = fakeMode === 'structured_transient_success';
const transientSeconds = Number(process.env.FAKE_CLAUDE_TRANSIENT_SECONDS ?? 1);

// Test-only write hook (default off). With FAKE_CLAUDE_WRITE_RELATIVE set,
// resolve it against cwd and write the file BEFORE any fake output is emitted,
// so a test can prove the worker spawned and initialized. The resolved target
// must stay inside cwd: judged via path.relative from cwd (Windows case
// handled by path.relative); absolute paths, '' and ../ escapes are rejected
// (stderr security error, exit 2).
const writeRelative = process.env.FAKE_CLAUDE_WRITE_RELATIVE;
if (writeRelative !== undefined && writeRelative !== '') {
  const cwdAbs = path.resolve(process.cwd());
  const target = path.resolve(cwdAbs, writeRelative);
  const rel = path.relative(cwdAbs, target);
  const within =
    writeRelative !== '' &&
    !path.isAbsolute(writeRelative) &&
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith('..' + path.sep) &&
    !path.isAbsolute(rel);
  if (!within) {
    process.stderr.write(
      `fake-claude: security error: FAKE_CLAUDE_WRITE_RELATIVE ${JSON.stringify(writeRelative)} resolves outside cwd (${cwdAbs}), refusing to write\n`,
    );
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, process.env.FAKE_CLAUDE_WRITE_CONTENT ?? 'fake-worker-write', 'utf8');
}

const isStructuredMode =
  fakeMode === 'structured_control_once' ||
  fakeMode === 'structured_permission_duplicate' ||
  fakeMode === 'structured_two_ids';
if (fakeMode === 'banner_stdout_success' || fakeMode === 'banner_stderr_success') {
  const banner = `Claude needs your permission to use Bash.\nCommand: rm ${permPath}\nDo you want to proceed?`;
  const stream = fakeMode === 'banner_stdout_success' ? process.stdout : process.stderr;
  stream.write(`${banner}\n`);
  process.exit(0);
}

const lines = [
  `FAKE_CLAUDE resume=${resume} session=${sessionId} base=${baseUrl}`,
];

// FAKE_CLAUDE_RESULT_TEXT overrides the final result event's `result` string
// (used by supervisor final-output tests). Default keeps the
// legacy 'DONE' / `RESUMED <session>` text, so a receipt-driven test sets only
// this knob and every other output line stays byte-identical.
const resultTextOverride = process.env.FAKE_CLAUDE_RESULT_TEXT;
const normalOutput = () => {
  lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working…' }] } }));
  lines.push(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_start' } }));
  lines.push(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: resultTextOverride !== undefined ? resultTextOverride : resume ? `RESUMED ${sessionId}` : 'DONE',
      session_id: sessionId,
    }),
  );
};

// FAKE_MODE: structured permission/control events. Emit genuine JSON
// control_request / permission_request lines (the supervisor's structured
// permission parser lifts requestId/tool/action/path from these), then remain
// blocked (no normal output) and exit deterministically like the blocking
// userPrompt fixture. Distinct upstream ids stay distinct; a duplicated event
// with one id is published once (deduped by requestId upstream).
const structuredPermPath = process.env.FAKE_CLAUDE_STRUCTURED_PATH || path.basename(permPath);
const structuredEvent = (type, requestId) => ({
  type,
  requestId,
  permission: { tool: 'Read', action: 'read', path: structuredPermPath },
});
if (isStructuredMode) {
  const firstId = process.env.FAKE_REQUEST_ID || (fakeMode === 'structured_two_ids' ? 'req-a' : 'req-control-1');
  if (fakeMode === 'structured_control_once') {
    lines.push(JSON.stringify(structuredEvent('control_request', firstId)));
  } else if (fakeMode === 'structured_permission_duplicate') {
    const ev = JSON.stringify(structuredEvent('permission_request', firstId));
    lines.push(ev, ev);
  } else {
    lines.push(JSON.stringify(structuredEvent('permission_request', firstId)));
    const secondId = process.env.FAKE_REQUEST_ID_2 || 'req-b';
    setTimeout(() => {
      process.stdout.write(`${JSON.stringify(structuredEvent('control_request', secondId))}\n`);
    }, 1200);
  }
} else if (structuredTransientMode) {
  const transientId = process.env.FAKE_REQUEST_ID || 'req-transient';
  lines.push(JSON.stringify(structuredEvent('control_request', transientId)));
}

if (emitUserPrompt) {
  const permPrompts = {
    Bash: `Claude needs your permission to use Bash.\nCommand: rm ${permPath}\nDo you want to proceed?`,
    Read: `Claude needs your permission to use Read.\nPath: ${permPath}\nDo you want to proceed?`,
    Edit: `Claude needs your permission to use Edit.\nPath: ${permPath}\nDo you want to proceed?`,
    Agent: `Claude needs your permission to use Agent. Do you want to proceed?`,
  };
  const promptEvent = {
    type: 'userPrompt',
    prompt: permPrompts[permTool] ?? permPrompts.Bash,
    data: { permissionMode: 'auto' },
  };
  if (!permNoId) promptEvent.id = 'fake-prompt-1';
  lines.push(JSON.stringify(promptEvent));
  // A plain text banner (not a result/tool_use) must NOT cancel a pending block.
  if (process.env.FAKE_CLAUDE_PERM_BANNER === '1') {
    lines.push(
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'waiting for approval…' }] } }),
    );
  }
  // Transient mode mirrors the real-world case: the permission signal is
  // followed by normal output and the job auto-resolves (succeeds). The default
  // (blocking) mode emits ONLY the permission event so the job genuinely waits.
  if (permTransient && !isStructuredMode) normalOutput();
} else if (!isStructuredMode && !structuredTransientMode) {
  normalOutput();
}

// Mirror real claude: human log line goes to stderr, stdout carries only the
// stream-json events. The orchestrator keeps the two in separate logs.
const [banner, ...jsonEvents] = lines;
if (slowMode) {
  // FAKE_MODE=slow_normal_success: ordinary non-permission progress events go
  // out immediately; the deterministic result follows after
  // FAKE_CLAUDE_SLOW_SECONDS, then exit 0. Reuses normalOutput's exact line
  // shape so the stream stays byte-compatible with the other fake modes.
  process.stderr.write(`${banner}\n`);
  process.stdout.write(`${jsonEvents.slice(0, 2).join('\n')}\n`);
  setTimeout(() => {
    process.stdout.write(`${jsonEvents[2]}\n`);
    process.exit(0);
  }, Math.max(0, slowSeconds * 1000));
} else if (structuredTransientMode) {
  // FAKE_MODE=structured_transient_success: emit the single structured request
  // now; after the configurable delay emit the same deterministic result event
  // the self-recover fixture uses, which auto-resolves the pending structured
  // attention, then exit 0.
  process.stderr.write(`${banner}\n`);
  process.stdout.write(`${jsonEvents.join('\n')}\n`);
  setTimeout(() => {
    process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'resumed', session_id: sessionId })}\n`);
    process.exit(0);
  }, Math.max(0, transientSeconds * 1000));
} else if (resumeBannerMode) {
  // FAKE_MODE=resume_banner_success: a plain-text permission-looking banner on
  // the human stream (never a structured JSON control/permission request),
  // followed by the deterministic normal progress/result, then exit 0. Same
  // output for fresh and --resume invocations.
  process.stderr.write(`Claude needs your permission to use Bash.\nCommand: rm ${permPath}\nDo you want to proceed?\n`);
  process.stdout.write(`${jsonEvents.join('\n')}\n`);
} else {
  process.stderr.write(`${banner}\n`);
  process.stdout.write(`${jsonEvents.join('\n')}\n`);
}
if (emitUserPrompt) {
  // A stderr permission banner AFTER the structured stdout event lets tests
  // verify a generic echo does not downgrade the structured pending summary.
  if (process.env.FAKE_CLAUDE_PERM_STDERR_MARKER === '1') {
    process.stderr.write('Auto mode: approval needed for tool call (will auto-resolve)\n');
  }
  // A second, distinct upstream request lets tests verify requestId isolation:
  // it must be recorded separately, never merged into the first id.
  const secondId = process.env.FAKE_CLAUDE_PERM_SECOND_ID;
  if (secondId) {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          type: 'userPrompt',
          id: secondId,
          prompt: `Claude needs your permission to use Read.\nPath: ${permPath}\nDo you want to proceed?`,
          data: { permissionMode: 'auto' },
        })}\n`,
      );
    }, 1200);
  }
  // Conclusive self-recovery: a result event after ~1s closes a confirmed block.
  const selfRecover =
    process.env.FAKE_CLAUDE_PERM_SELF_RECOVER === '1' || process.env.FAKE_CLAUDE_PERM_SECOND_LOCAL === '1';
  if (selfRecover) {
    const emitResult = () => {
      process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', result: 'resumed', session_id: sessionId })}\n`);
    };
    if (selfRecoverGate) {
      // Explicit gate handshake: wait for the TEST-created gate file (bounded,
      // poll — never busy-spins). The fake must never create the gate itself;
      // on timeout the result still fires so the fixture cannot deadlock the
      // supervisor (the test owns the assertion that the gate appeared).
      const deadline = Date.now() + 20000;
      const check = () => {
        if (fs.existsSync(selfRecoverGate)) {
          // Gate appeared: emit the conclusive result and exit 0 immediately so
          // the test's waitForEnded observes a real worker close (the process
          // must not linger until the runSeconds exit timer).
          emitResult();
          process.exit(exitCode);
        } else if (Date.now() < deadline) {
          setTimeout(check, 25);
        } else {
          // Timeout fallback: the result still fires so the fixture cannot
          // deadlock the supervisor (the test owns the assertion that the gate
          // appeared). Keep the runSeconds exit timer as the eventual close.
          emitResult();
        }
      };
      check();
    } else {
      setTimeout(emitResult, Math.max(0, selfRecoverSeconds * 1000));
    }
  }
  // A second, distinct LOCAL-only request after ~2s: consecutive local episodes
  // must get distinct local ids (never merged with the first episode's id).
  if (process.env.FAKE_CLAUDE_PERM_SECOND_LOCAL === '1') {
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({
          type: 'userPrompt',
          prompt: `Claude needs your permission to use Read.\nPath: ${permPath}\nDo you want to proceed?`,
          data: { permissionMode: 'auto' },
        })}\n`,
      );
    }, 2000);
  }
}
if (!slowMode && !structuredTransientMode) {
  setTimeout(() => process.exit(exitCode), Math.max(0, runSeconds * 1000));
}
// NOTE: the exit timer above never runs for a gated self-recover fixture: the
// gate branch exits the process itself right after flushing the result line, so
// the runSeconds exit timer is just a deadlock backstop for the timeout path.
