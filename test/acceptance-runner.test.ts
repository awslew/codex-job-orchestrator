// Acceptance runner tests: pass, exit 1, timeout, spawn error, output
// truncation, cwd out-of-bounds, required/optional, abort signal, and the
// allowlisted gate environment. Uses the shared fake fixture pattern with
// process.execPath so the child behaves identically on every platform.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGateEnv,
  summarizeOutput,
  runAcceptanceCommands,
  type AcceptanceCommandLike,
  type GateResult,
} from '../src/acceptance-runner.js';

const WORK_FOLDER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test');
const FAKE_ACCEPTANCE = path.join(WORK_FOLDER, 'fake-acceptance.mjs');

function gate(over: Partial<AcceptanceCommandLike> & { id: string }): AcceptanceCommandLike {
  return {
    argv: [process.execPath, FAKE_ACCEPTANCE],
    cwdRelative: '.',
    ...over,
  };
}

test('runAcceptanceCommands: pass gate', async () => {
  const summary = await runAcceptanceCommands([gate({ id: 'pass' })], { workFolder: WORK_FOLDER });
  assert.equal(summary.acceptanceStatus, 'pass');
  const result = summary.gates['pass'];
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.required, false);
  assert.match(result.stdoutSummary, /^passed$/);
  assert.ok(result.durationMs >= 0);
  assert.ok(new Date(result.startedAt).getTime() <= new Date(result.endedAt).getTime());
});

test('runAcceptanceCommands: required exit 1 fails the summary', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'fail', argv: [process.execPath, FAKE_ACCEPTANCE, '--exit', '1'], required: true })],
    { workFolder: WORK_FOLDER },
  );
  assert.equal(summary.acceptanceStatus, 'fail');
  assert.equal(summary.gates['fail'].exitCode, 1);
  assert.equal(summary.gates['fail'].timedOut, false);
});

test('runAcceptanceCommands: optional exit 1 is recorded but stays pass', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'opt-fail', argv: [process.execPath, FAKE_ACCEPTANCE, '--exit', '1'], required: false })],
    { workFolder: WORK_FOLDER },
  );
  assert.equal(summary.acceptanceStatus, 'pass');
  assert.equal(summary.gates['opt-fail'].exitCode, 1);
});

test('runAcceptanceCommands: required timeout kills and fails the gate', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'slow', timeoutSeconds: 1, argv: [process.execPath, FAKE_ACCEPTANCE, '--sleep', '30'], required: true })],
    { workFolder: WORK_FOLDER },
  );
  assert.equal(summary.acceptanceStatus, 'fail');
  const result = summary.gates['slow'];
  assert.equal(result.timedOut, true);
  assert.equal(result.required, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.durationMs >= 1000);
});

test('runAcceptanceCommands: spawn error is structured, not thrown', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'nope', argv: [WORK_FOLDER + '\\definitely-missing-executable-xyz'], required: true })],
    { workFolder: WORK_FOLDER },
  );
  const result = summary.gates['nope'];
  assert.equal(result.error, 1);
  assert.equal(result.errorCode, 'ENOENT');
  assert.match(result.errorMessage ?? '', /ENOENT/i);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(summary.acceptanceStatus, 'fail');
});

test('runAcceptanceCommands: outputs are tail-truncated and marked', async () => {
  const summary = await runAcceptanceCommands(
    [
      gate({
        id: 'trunc',
        argv: [process.execPath, FAKE_ACCEPTANCE, '--spew', '5000'],
        outputMaxChars: 256,
      }),
    ],
    { workFolder: WORK_FOLDER },
  );
  const result = summary.gates['trunc'];
  assert.ok(result.stdoutSummary.startsWith('…[truncated]'));
  assert.ok(result.stdoutSummary.length <= 256);
  assert.ok(result.stdoutSummary.endsWith(']'));
  assert.equal(result.stderrPreview, summarizeOutput('x'.repeat(5000), 256, Number.MAX_SAFE_INTEGER));
});

test('runAcceptanceCommands: cwd outside workFolder blocks the summary', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'escape', cwdRelative: '..', required: true })],
    { workFolder: WORK_FOLDER },
  );
  const result = summary.gates['escape'];
  assert.equal(result.error, 1);
  assert.equal(result.errorCode, 'ERR_INVALID_CWD');
  assert.match(result.errorMessage ?? '', /outside workFolder/);
  assert.equal(result.prevented, true);
  assert.equal(result.exitCode, null);
  assert.equal(summary.acceptanceStatus, 'blocked');
});

test('runAcceptanceCommands: missing cwd is prevented and blocks the summary', async () => {
  const missing = path.join(WORK_FOLDER, 'no-such-acceptance-dir');
  const summary = await runAcceptanceCommands(
    [gate({ id: 'missing-cwd', cwdRelative: 'no-such-acceptance-dir', required: true })],
    { workFolder: WORK_FOLDER },
  );
  const result = summary.gates['missing-cwd'];
  assert.equal(result.error, 1);
  assert.equal(result.errorCode, 'ERR_INVALID_CWD');
  assert.equal(result.prevented, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  // The command must never have spawned: the fixture is absent from the
  // nonexistent directory and would otherwise fail with a spawn error.
  assert.equal(result.stdoutSummary, '');
  assert.equal(result.stderrSummary, `cwd resolves outside workFolder: ${missing}`);
  assert.equal(summary.acceptanceStatus, 'blocked');
});

test('runAcceptanceCommands: gates run sequentially in order', async () => {
  const summary = await runAcceptanceCommands(
    [
      gate({ id: 'first', argv: [process.execPath, FAKE_ACCEPTANCE, '--mark', 'first.txt'] }),
      gate({ id: 'second', argv: [process.execPath, FAKE_ACCEPTANCE, '--mark', 'second.txt'] }),
    ],
    { workFolder: WORK_FOLDER },
  );
  assert.equal(summary.acceptanceStatus, 'pass');
  // Each gate read the other's marker, so both had run before either finished.
  assert.match(summary.gates['first'].stdoutSummary, /second\.txt/);
  assert.match(summary.gates['second'].stdoutSummary, /first\.txt/);
});

test('runAcceptanceCommands: optional timeout stays pass but is recorded', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'opt-slow', timeoutSeconds: 1, argv: [process.execPath, FAKE_ACCEPTANCE, '--sleep', '30'], required: false })],
    { workFolder: WORK_FOLDER },
  );
  assert.equal(summary.acceptanceStatus, 'pass');
  assert.equal(summary.gates['opt-slow'].timedOut, true);
  assert.notEqual(summary.gates['opt-slow'].exitCode, 0);
});

test('runAcceptanceCommands: optional spawn error stays pass but is recorded', async () => {
  const summary = await runAcceptanceCommands(
    [gate({ id: 'opt-nope', argv: [WORK_FOLDER + '\\definitely-missing-executable-xyz'], required: false })],
    { workFolder: WORK_FOLDER },
  );
  const result = summary.gates['opt-nope'];
  assert.equal(result.error, 1);
  assert.equal(result.errorCode, 'ENOENT');
  assert.match(result.errorMessage ?? '', /ENOENT/i);
  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, false);
  assert.equal(summary.acceptanceStatus, 'pass');
});

test('runAcceptanceCommands: required gate aborted before start is blocked', async () => {
  const controller = new AbortController();
  controller.abort();
  const summary = await runAcceptanceCommands(
    [gate({ id: 'pre-abort', required: true })],
    { workFolder: WORK_FOLDER, signal: controller.signal },
  );
  const result = summary.gates['pre-abort'];
  assert.equal(result.prevented, true);
  assert.equal(result.errorCode, 'ERR_ABORTED');
  assert.equal(result.exitCode, null);
  assert.equal(summary.acceptanceStatus, 'blocked');
});

test('runAcceptanceCommands: abort signal kills the running gate', async () => {
  const controller = new AbortController();
  const promise = runAcceptanceCommands(
    [gate({ id: 'abort', timeoutSeconds: 30, argv: [process.execPath, FAKE_ACCEPTANCE, '--sleep', '30'] })],
    { workFolder: WORK_FOLDER, signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 400);
  const summary = await promise;
  const result = summary.gates['abort'];
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test('buildGateEnv: only allowlisted keys, NODE_OPTIONS requires explicit source', () => {
  const env = buildGateEnv({
    PATH: '/usr/bin',
    Path: 'C:\\Windows\\System32',
    NODE_OPTIONS: '--max-old-space-size=512',
    SECRET_TOKEN: 'hunter2',
    HOME: '/home/u',
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.Path, 'C:\\Windows\\System32');
  assert.equal(env.NODE_OPTIONS, '--max-old-space-size=512');
  assert.equal(env.SECRET_TOKEN, undefined);
  assert.equal(env.HOME, undefined);
  // NODE_OPTIONS is dropped when the caller did not explicitly provide it.
  assert.equal(buildGateEnv(process.env).NODE_OPTIONS, undefined);
});

test('buildGateEnv: custom allowKeys are honored', () => {
  const env = buildGateEnv({ PATH: '/a', CUSTOM: 'yes' }, ['PATH', 'CUSTOM']);
  assert.equal(env.PATH, '/a');
  assert.equal(env.CUSTOM, 'yes');
});

test('summarizeOutput: within limit is verbatim; beyond limit is tail-truncated', () => {
  assert.equal(summarizeOutput('hello', 100), 'hello');
  const truncated = summarizeOutput('a'.repeat(5000), 64);
  assert.ok(truncated.startsWith('…[truncated]'));
  assert.equal(truncated.length, 64);
  // Tail slice: the final character of the source survives.
  assert.equal(truncated.endsWith('a'), true);
});
