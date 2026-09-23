import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRouting, validateStartParams, buildStartDefaults } from '../src/router.js';
import { buildLegacyContract, validateTaskContractV2, type TaskContractV2 } from '../src/contracts-v2.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-router-'));

test('routing truth table: all profiles route to 15721 (single-port, router removed)', () => {
  assert.deepEqual(resolveRouting('auto'), { port: 15721, permissionMode: 'bypassPermissions', label: '15721+bypass' });
  assert.deepEqual(resolveRouting('review'), { port: 15721, permissionMode: 'plan', label: '15721+plan' });
  assert.deepEqual(resolveRouting('normal'), { port: 15721, permissionMode: 'acceptEdits', label: '15721+acceptEdits' });
});

test('default profile is auto (implementation default), parallelism auto, runtime 120', () => {
  const d = buildStartDefaults({ prompt: 'x', workFolder: tmp });
  assert.equal(d.profile, 'auto');
  assert.equal(d.parallelism, 'auto');
  assert.equal(d.maxRuntimeMinutes, 120);
});

test('valid params produce no errors', () => {
  const errs = validateStartParams({ prompt: 'do it', workFolder: tmp, profile: 'auto', parallelism: 'auto', maxRuntimeMinutes: 120 });
  assert.deepEqual(errs, []);
});

test('rejects relative workFolder', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: 'relative/path' });
  assert.ok(errs.some((e) => e.includes('absolute')));
});

test('rejects non-existent workFolder', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: path.join(tmp, 'does-not-exist') });
  assert.ok(errs.some((e) => e.includes('does not exist')));
});

test('rejects empty prompt', () => {
  const errs = validateStartParams({ prompt: '   ', workFolder: tmp });
  assert.ok(errs.some((e) => e.includes('prompt')));
});

test('rejects unknown profile and parallelism', () => {
  const p = validateStartParams({ prompt: 'x', workFolder: tmp, profile: 'banana' as never });
  assert.ok(p.some((e) => e.includes('profile')));
  const q = validateStartParams({ prompt: 'x', workFolder: tmp, parallelism: '9' as never });
  assert.ok(q.some((e) => e.includes('parallelism')));
});

test('rejects out-of-range maxRuntimeMinutes', () => {
  for (const v of [10, 200, 29, 181]) {
    const errs = validateStartParams({ prompt: 'x', workFolder: tmp, maxRuntimeMinutes: v });
    assert.ok(errs.some((e) => e.includes('maxRuntimeMinutes')), `expected rejection for ${v}`);
  }
  for (const v of [30, 120, 180]) {
    const errs = validateStartParams({ prompt: 'x', workFolder: tmp, maxRuntimeMinutes: v });
    assert.deepEqual(errs, []);
  }
});

test('rejects non-integer maxRuntimeMinutes', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, maxRuntimeMinutes: 90.5 });
  assert.ok(errs.some((e) => e.includes('integer')));
});

// ---------------------------------------------------------------------------
// Research/analysis deliverable contract: start validation matrix.
// ---------------------------------------------------------------------------

test('omitted taskType stays execution-compatible (no deliverable required)', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp });
  assert.deepEqual(errs, []);
});

test('explicit execution without a deliverable is accepted', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'execution' });
  assert.deepEqual(errs, []);
});

test('execution with a supplied deliverablePath is rejected', () => {
  const errs = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    taskType: 'execution',
    deliverablePath: path.join(tmp, 'report.md'),
  });
  assert.ok(errs.some((e) => e.includes('only allowed for research/analysis')));
});

test('research and analysis without a deliverablePath are rejected', () => {
  for (const t of ['research', 'analysis'] as const) {
    const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: t });
    assert.ok(errs.some((e) => e.includes('deliverablePath is required')), t);
  }
});

test('invalid taskType is rejected', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'compile' as never });
  assert.ok(errs.some((e) => e.includes('taskType must be one of execution, research, analysis')));
});

test('research rejects a relative deliverablePath', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: 'report.md' });
  assert.ok(errs.some((e) => e.includes('deliverablePath must be an absolute path')));
});

test('research rejects a non-.md deliverablePath', () => {
  const errs = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    taskType: 'research',
    deliverablePath: path.join(tmp, 'report.txt'),
  });
  assert.ok(errs.some((e) => e.includes('must name a .md file')));
});

test('research rejects a deliverablePath equal to workFolder', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: tmp });
  assert.ok(errs.some((e) => e.includes('must not equal workFolder')));
});

test('research rejects sibling-prefix and parent escapes', () => {
  // A sibling whose name is a string-prefix of workFolder is NOT inside it.
  const sibling = path.join(os.tmpdir(), `${path.basename(tmp)}x`, 'report.md');
  const s = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: sibling });
  assert.ok(s.some((e) => e.includes('resolve inside workFolder')), 'sibling-prefix escape');
  // A path directly above workFolder.
  const parent = path.join(os.tmpdir(), 'report.md');
  const p = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: parent });
  assert.ok(p.some((e) => e.includes('resolve inside workFolder')), 'parent escape');
});

test('research rejects an other-root deliverablePath (portable across volumes)', () => {
  const otherRoot = path.join(path.parse(tmp).root, 'other', 'report.md');
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: otherRoot });
  assert.ok(errs.some((e) => e.includes('resolve inside workFolder')), 'other-root');
});

test('research rejects a different Windows drive deliverablePath', { skip: process.platform !== 'win32' }, () => {
  const root = path.parse(tmp).root; // e.g. "C:\"
  const otherDrive = root[0] === 'Z' ? 'Y:' : 'Z:';
  const dp = `${otherDrive}${path.sep}report.md`;
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, taskType: 'research', deliverablePath: dp });
  assert.ok(
    errs.some((e) => e.includes('resolve inside workFolder') || e.includes('must be an absolute path')),
    'different drive must be rejected',
  );
});

test('a valid absolute .md inside workFolder is accepted for research and analysis', () => {
  const lower = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    taskType: 'research',
    deliverablePath: path.join(tmp, 'report.md'),
  });
  assert.deepEqual(lower, []);
  // Case-insensitive .md extension (Report.MD) and a nested dir are both fine.
  const upper = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    taskType: 'analysis',
    deliverablePath: path.join(tmp, 'sub', 'Report.MD'),
  });
  assert.deepEqual(upper, []);
});

// ---------------------------------------------------------------------------
// TaskContractV2 wiring (T1D-D2A): optional strict validation, pass-through.
// ---------------------------------------------------------------------------

function validContract(): TaskContractV2 {
  return buildLegacyContract({
    taskType: 'execution',
    workFolder: tmp,
    maxRuntimeMinutes: 120,
    deliverablePath: path.join(tmp, 'report.md'),
  });
}

test('omitted contract keeps V1 behavior exactly (no legacy contract synthesized)', () => {
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp });
  assert.deepEqual(errs, []);
  // A valid V2 raw contract stays valid through the strict validator itself.
  const raw = validContract();
  assert.deepEqual(validateTaskContractV2(raw, tmp), { ok: true, value: raw });
});

test('a valid TaskContractV2 is accepted and validated strictly', () => {
  const c = validContract();
  const errs = validateStartParams({ prompt: 'x', workFolder: tmp, contract: c });
  assert.deepEqual(errs, []);
  // Round-trips through the strict validator unchanged.
  const res = validateTaskContractV2(c, tmp);
  assert.equal(res.ok, true);
  assert.deepEqual(res.ok ? res.value : null, c);
});

test('unknown top-level contract fields are rejected', () => {
  // unknown/type assertion bypasses compile-time excess-property checks so the
  // illegal object reaches the runtime validator; TaskContractV2 itself must
  // NOT gain an unknownField member.
  const errs = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    contract: { ...validContract(), unknownField: true } as unknown as TaskContractV2,
  });
  assert.ok(errs.some((e) => e.includes("unknown top-level field 'unknownField'")));
});

test('invalid contract paths inside workFolder are rejected', () => {
  // Absolute scope read glob must be a relative path.
  const absGlob = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    contract: { ...validContract(), scope: { readGlobs: [path.join(tmp, 'src')], writeFiles: [], forbiddenGlobs: [] } },
  });
  assert.ok(absGlob.some((e) => e.includes('must be a relative path, not absolute')));
  // A scope read glob escaping workFolder.
  const escape = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    contract: { ...validContract(), scope: { readGlobs: ['../../etc/passwd'], writeFiles: [], forbiddenGlobs: [] } },
  });
  assert.ok(escape.some((e) => e.includes('must not escape workFolder')));
});

test('invalid contract budget is rejected', () => {
  const errs = validateStartParams({
    prompt: 'x',
    workFolder: tmp,
    contract: { ...validContract(), budget: { maxRuntimeMinutes: -5 } },
  });
  assert.ok(errs.some((e) => e.includes('budget.maxRuntimeMinutes must be a positive integer')));
});

test('contract validation errors never leak prompt, env or argv', () => {
  const secretPrompt = 'SECRET-PROMPT-TOKEN';
  const secretEnv = { SECRET_ENV_KEY: 'SECRET-ENV-VALUE' };
  const secretArgv = ['SECRET-ARGV-TOKEN'];
  const errs = validateStartParams({
    prompt: secretPrompt,
    workFolder: tmp,
    extraEnv: secretEnv,
    contract: { ...validContract(), budget: { maxRuntimeMinutes: -5 } },
  });
  assert.ok(errs.length > 0, 'invalid contract must fail');
  for (const e of errs) {
    assert.ok(!e.includes(secretPrompt), `error leaks prompt: ${e}`);
    assert.ok(!Object.values(secretEnv).some((v) => e.includes(v)), `error leaks env: ${e}`);
    assert.ok(!secretArgv.some((v) => e.includes(v)), `error leaks argv: ${e}`);
  }
});
