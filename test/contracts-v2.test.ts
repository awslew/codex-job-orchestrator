// Pure unit tests for the v2 task contract model (T1A): validation of a legal
// contract, every invalid class, Windows path semantics, and the three legacy
// mappings. No I/O, no runtime coupling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  CONTRACT_V2_SCHEMA_VERSION,
  validateTaskContractV2,
  buildLegacyContract,
  type TaskContractV2,
} from '../src/contracts-v2.js';

const workFolder = process.platform === 'win32' ? 'C:\\projects\\app' : '/projects/app';
const upOne = path.dirname(workFolder);

/** Minimal fully-valid v2 contract; tests mutate the copy they need. */
function validContract(): Record<string, unknown> {
  return {
    schemaVersion: CONTRACT_V2_SCHEMA_VERSION,
    writePolicy: 'listed_writes',
    scope: { readGlobs: ['src/**/*.ts'], writeFiles: ['docs/*.md'], forbiddenGlobs: ['secrets/**'] },
    budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 15 },
    acceptance: [
      {
        id: 'unit-tests',
        argv: ['node', '--test', 'test/*.test.js'],
        cwdRelative: '.',
        timeoutSeconds: 300,
        required: true,
        outputMaxChars: 10000,
      },
    ],
    reporting: { deliverablePath: path.join(workFolder, 'docs', 'report.md') },
    admission: { resourceClass: 'light', priority: 1 },
  };
}

test('CONTRACT_V2_SCHEMA_VERSION is 2', () => {
  assert.equal(CONTRACT_V2_SCHEMA_VERSION, 2);
});

test('a legal contract validates with a typed value and no errors', () => {
  const r = validateTaskContractV2(validContract(), workFolder);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.schemaVersion, 2);
  assert.equal(r.value.writePolicy, 'listed_writes');
  assert.equal(r.value.budget.maxRuntimeMinutes, 60);
  assert.equal(r.value.budget.reportOnlyAfterMinutes, 15);
  assert.equal(r.value.acceptance.length, 1);
  assert.equal(r.value.admission.resourceClass, 'light');
});

test('non-object input is rejected', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    const r = validateTaskContractV2(bad, workFolder);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.length > 0);
  }
});

test('schemaVersion other than 2 is rejected', () => {
  const c = validContract();
  c.schemaVersion = 1;
  const r = validateTaskContractV2(c, workFolder);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('schemaVersion')));
});

test('unknown fields are rejected at every level', () => {
  const c = validContract();
  c.extraTop = 1;
  (c.budget as Record<string, unknown>).budgetExtra = 1;
  (c.acceptance as unknown[])[0] = { ...(c.acceptance as Record<string, unknown>[])[0], extraArg: 1 };
  (c.reporting as Record<string, unknown>).extraReport = 1;
  (c.admission as Record<string, unknown>).extraAdmit = 1;
  const r = validateTaskContractV2(c, workFolder);
  assert.equal(r.ok, false);
  if (!r.ok) {
    for (const e of ['unknown top-level field', 'unknown budget field', 'unknown acceptance[0] field', 'unknown reporting field', 'unknown admission field']) {
      assert.ok(r.errors.some((x) => x.includes(e)), `missing error: ${e}`);
    }
  }
});

test('scope must be an object with readGlobs, writeFiles and forbiddenGlobs arrays', () => {
  const base = validContract();
  const cases: [unknown, string][] = [
    ['src/*.ts', 'must be an object'],
    [[], 'must be an object'],
    [{}, 'readGlobs is required'],
    [{ readGlobs: ['ok/**'] }, 'writeFiles is required'],
    [{ readGlobs: ['ok/**'], writeFiles: ['ok/**'] }, 'forbiddenGlobs is required'],
    [{ readGlobs: [123], writeFiles: [], forbiddenGlobs: [] }, 'must be a non-empty string'],
    [{ readGlobs: [''], writeFiles: [], forbiddenGlobs: [] }, 'must be a non-empty string'],
    [{ readGlobs: ['src/**\0/*.ts'], writeFiles: [], forbiddenGlobs: [] }, 'must not contain NUL'],
    [{ readGlobs: [path.join(workFolder, 'src', '*.ts')], writeFiles: [], forbiddenGlobs: [] }, 'must be a relative path'],
    [{ readGlobs: ['../other/**/*.ts'], writeFiles: [], forbiddenGlobs: [] }, 'must not escape workFolder'],
    [{ readGlobs: ['ok/**'], writeFiles: ['ok/**'], forbiddenGlobs: ['ok/**'], extraScope: 1 }, 'unknown scope field'],
  ];
  for (const [scope, msg] of cases) {
    const c = { ...base, scope };
    const r = validateTaskContractV2(c, workFolder);
    assert.equal(r.ok, false, `scope ${JSON.stringify(scope)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('scope') && e.includes(msg)), `${JSON.stringify(r.errors)} for ${JSON.stringify(scope)}`);
  }
});

test('scope.writeFiles and scope.forbiddenGlobs follow the same glob rules as readGlobs', () => {
  for (const field of ['writeFiles', 'forbiddenGlobs']) {
    const c = { ...validContract(), scope: { ...(validContract().scope as Record<string, unknown>), [field]: ['../escape/**'] } };
    const r = validateTaskContractV2(c, workFolder);
    assert.equal(r.ok, false, field);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes(`scope.${field}`) && e.includes('escape')), String(r.errors));
  }
});

test('writePolicy must be one of the three values', () => {
  for (const wp of ['read_only_report', 'listed_writes', 'workspace_legacy']) {
    assert.equal(validateTaskContractV2({ ...validContract(), writePolicy: wp }, workFolder).ok, true);
  }
  for (const wp of [undefined, 'read-write', 'read_only', 42]) {
    const r = validateTaskContractV2({ ...validContract(), writePolicy: wp }, workFolder);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('writePolicy')));
  }
});

test('acceptance entry validates every strict field', () => {
  const patch = (mut: (e: Record<string, unknown>) => void) => {
    const c = validContract();
    const e0 = (c.acceptance as Record<string, unknown>[])[0];
    mut(e0);
    return validateTaskContractV2(c, workFolder);
  };

  assert.equal(patch((e) => (e.id = 'a')).ok, true);
  const badIds = ['', 'a'.repeat(65), 'a b', 'a/b', 'a*b', 'a?b', 42, null];
  for (const id of badIds) {
    const r = patch((e) => (e.id = id as string));
    assert.equal(r.ok, false, `id ${String(id)}`);
    if (!r.ok) assert.ok(r.errors.some((x) => x.includes('id')), String(r.errors));
  }

  assert.equal(patch((e) => (e.argv = ['npm', 'test'])).ok, true);
  for (const argv of [[], ['', 'x'], ['x', 'y\0z'], 'node', [42]]) {
    const r = patch((e) => (e.argv = argv as string[]));
    assert.equal(r.ok, false, `argv ${JSON.stringify(argv)}`);
    if (!r.ok) assert.ok(r.errors.some((x) => x.includes('argv')), String(r.errors));
  }

  assert.equal(patch((e) => (e.cwdRelative = 'test')).ok, true);
  for (const cwd of [upOne, path.join(workFolder, '..', 'x'), 'C:\\', '/abs', '']) {
    const r = patch((e) => (e.cwdRelative = cwd));
    assert.equal(r.ok, false, `cwdRelative ${cwd}`);
    if (!r.ok) assert.ok(r.errors.some((x) => x.includes('cwdRelative')), String(r.errors));
  }

  for (const t of [1, 3600]) assert.equal(patch((e) => (e.timeoutSeconds = t)).ok, true);
  for (const t of [0, -1, 3601, 1.5, '300', null]) {
    const r = patch((e) => (e.timeoutSeconds = t as number));
    assert.equal(r.ok, false, `timeoutSeconds ${String(t)}`);
    if (!r.ok) assert.ok(r.errors.some((x) => x.includes('timeoutSeconds')), String(r.errors));
  }

  assert.equal(patch((e) => (e.required = true)).ok, true);
  const r1 = patch((e) => (e.required = 1 as unknown as boolean));
  assert.equal(r1.ok, false);

  for (const n of [100, 50000]) assert.equal(patch((e) => (e.outputMaxChars = n)).ok, true);
  for (const n of [99, 50001, 1000.5, '100', -1, null]) {
    const r = patch((e) => (e.outputMaxChars = n as number));
    assert.equal(r.ok, false, `outputMaxChars ${String(n)}`);
    if (!r.ok) assert.ok(r.errors.some((x) => x.includes('outputMaxChars')), String(r.errors));
  }

  const missing = { ...(validContract().acceptance as Record<string, unknown>[])[0] } as Record<string, unknown>;
  delete missing.cwdRelative;
  const c2 = validContract();
  c2.acceptance = [missing];
  const r2 = validateTaskContractV2(c2, workFolder);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(r2.errors.some((x) => x.includes('cwdRelative')), String(r2.errors));

  const c3 = validContract();
  c3.acceptance = 'not-an-array';
  const r3 = validateTaskContractV2(c3, workFolder);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.ok(r3.errors.some((x) => x.includes('acceptance must be an array')), String(r3.errors));
});

test('reporting.deliverablePath must be absolute, inside workFolder, and .md', () => {
  // Absent deliverablePath is legal: reporting may omit it.
  assert.equal(validateTaskContractV2({ ...validContract(), reporting: {} }, workFolder).ok, true);

  const cases: [unknown, string][] = [
    ['docs/report.md', 'absolute'],
    [path.join(upOne, 'report.md'), 'inside workFolder'],
    [path.join(workFolder, 'report.txt'), 'end with .md'],
    [42, 'non-empty string'],
    ['', 'non-empty string'],
    [{}, 'non-empty string'],
  ];
  for (const [deliverablePath, msg] of cases) {
    const c = validContract();
    (c.reporting as Record<string, unknown>).deliverablePath = deliverablePath;
    const r = validateTaskContractV2(c, workFolder);
    assert.equal(r.ok, false, `deliverablePath ${String(deliverablePath)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes(msg)), `${JSON.stringify(r.errors)} for ${String(deliverablePath)}`);
  }
});

test('budget requires positive integers and reportOnlyAfterMinutes <= maxRuntimeMinutes', () => {
  for (const max of [1, 1000000]) {
    assert.equal(validateTaskContractV2({ ...validContract(), budget: { maxRuntimeMinutes: max } }, workFolder).ok, true);
  }
  for (const max of [0, -1, 1.5, '60', null, undefined]) {
    const r = validateTaskContractV2({ ...validContract(), budget: { maxRuntimeMinutes: max as number } }, workFolder);
    assert.equal(r.ok, false, `max ${String(max)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('maxRuntimeMinutes')), String(r.errors));
  }
  assert.equal(
    validateTaskContractV2({ ...validContract(), budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 60 } }, workFolder).ok,
    true,
  );
  for (const ro of [61, -1, 1.5, '10']) {
    const r = validateTaskContractV2({ ...validContract(), budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: ro as number } }, workFolder);
    assert.equal(r.ok, false, `ro ${String(ro)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('reportOnlyAfterMinutes')), String(r.errors));
  }
});

test('budget wave-2 fields: legal full set validates with typed values', () => {
  const c = validContract();
  (c.budget as Record<string, unknown>) = {
    maxRuntimeMinutes: 60,
    reportOnlyAfterMinutes: 30,
    maxFilesRead: 200,
    maxSourceLines: 50000,
    maxToolCalls: 500,
    maxBashCommands: 100,
    explorationMinutes: 15,
    maxTranscriptBytes: 4194304,
    onExceeded: 'report_partial',
  };
  const r = validateTaskContractV2(c, workFolder);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.value.budget.maxFilesRead, 200);
  assert.equal(r.value.budget.maxSourceLines, 50000);
  assert.equal(r.value.budget.maxToolCalls, 500);
  assert.equal(r.value.budget.maxBashCommands, 100);
  assert.equal(r.value.budget.explorationMinutes, 15);
  assert.equal(r.value.budget.maxTranscriptBytes, 4194304);
  assert.equal(r.value.budget.onExceeded, 'report_partial');
  // onExceeded 'fail' is legal too, and a single wave-2 field alongside the required max is legal.
  assert.equal(
    validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 10, maxFilesRead: 5, onExceeded: 'fail' } },
      workFolder,
    ).ok,
    true,
  );
});

test('budget wave-2 fields: every invalid class is rejected', () => {
  const patch = (mut: (b: Record<string, unknown>) => void) => {
    const c = validContract();
    const b = c.budget as Record<string, unknown>;
    mut(b);
    return validateTaskContractV2(c, workFolder);
  };
  const badInts = [0, -1, 1.5, '50', null];
  for (const field of ['maxFilesRead', 'maxSourceLines', 'maxToolCalls', 'maxBashCommands', 'maxTranscriptBytes']) {
    for (const v of badInts) {
      const r = patch((b) => (b[field] = v));
      assert.equal(r.ok, false, `${field} ${String(v)}`);
      if (!r.ok) assert.ok(r.errors.some((e) => e.includes(field)), String(r.errors));
    }
  }
  for (const v of [-1, 1.5, '15', null]) {
    const r = patch((b) => (b.explorationMinutes = v));
    assert.equal(r.ok, false, `explorationMinutes ${String(v)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('explorationMinutes')), String(r.errors));
  }
  for (const v of ['report', 'fail_now', 'REPORT_PARTIAL', '', 1, null]) {
    const r = patch((b) => (b.onExceeded = v));
    assert.equal(r.ok, false, `onExceeded ${String(v)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('onExceeded')), String(r.errors));
  }
});

test('budget explorationMinutes must not exceed maxRuntimeMinutes nor reportOnlyAfterMinutes', () => {
  assert.equal(
    validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 60, explorationMinutes: 0 } },
      workFolder,
    ).ok,
    true,
  );
  assert.equal(
    validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 60, explorationMinutes: 60 } },
      workFolder,
    ).ok,
    true,
  );
  const noRo = validateTaskContractV2(
    { ...validContract(), budget: { maxRuntimeMinutes: 60, explorationMinutes: 45 } },
    workFolder,
  );
  assert.equal(noRo.ok, true);
  for (const exp of [61, 120]) {
    const r = validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 60, explorationMinutes: exp } },
      workFolder,
    );
    assert.equal(r.ok, false, `exp ${exp}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('maxRuntimeMinutes')), String(r.errors));
  }
  assert.equal(
    validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 30, explorationMinutes: 30 } },
      workFolder,
    ).ok,
    true,
  );
  for (const exp of [31, 60]) {
    const r = validateTaskContractV2(
      { ...validContract(), budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 30, explorationMinutes: exp } },
      workFolder,
    );
    assert.equal(r.ok, false, `exp ${exp}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('reportOnlyAfterMinutes')), String(r.errors));
  }
});

test('admission validates resourceClass and priority', () => {
  for (const rc of ['light', 'build', 'heavy']) {
    assert.equal(validateTaskContractV2({ ...validContract(), admission: { resourceClass: rc, priority: 0 } }, workFolder).ok, true);
  }
  for (const rc of ['big', 42, undefined]) {
    const r = validateTaskContractV2({ ...validContract(), admission: { resourceClass: rc as 'light', priority: 0 } }, workFolder);
    assert.equal(r.ok, false, `resourceClass ${String(rc)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('resourceClass')), String(r.errors));
  }
  for (const p of [0, 3]) assert.equal(validateTaskContractV2({ ...validContract(), admission: { resourceClass: 'light', priority: p } }, workFolder).ok, true);
  for (const p of [-1, 4, 1.5, '1', null]) {
    const r = validateTaskContractV2({ ...validContract(), admission: { resourceClass: 'light', priority: p as number } }, workFolder);
    assert.equal(r.ok, false, `priority ${String(p)}`);
    if (!r.ok) assert.ok(r.errors.some((e) => e.includes('priority')), String(r.errors));
  }
});

test('all violations are collected, not just the first', () => {
  const c = {
    schemaVersion: 9,
    scope: { readGlobs: [], writeFiles: ['../escape/**'], forbiddenGlobs: [] },
    writePolicy: 'nope',
    writeFiles: 'nope',
    budget: { maxRuntimeMinutes: -1, reportOnlyAfterMinutes: 10 },
    acceptance: [{ id: '', argv: [], timeoutSeconds: 9999, required: 'x', outputMaxChars: 1 }],
    reporting: { deliverablePath: 'rel.md' },
    admission: { resourceClass: 'nope', priority: 9 },
  };
  const r = validateTaskContractV2(c, workFolder);
  assert.equal(r.ok, false);
  if (!r.ok) {
    for (const needle of [
      'schemaVersion',
      'scope.writeFiles[0]',
      'writePolicy',
      'writeFiles',
      'maxRuntimeMinutes',
      'reportOnlyAfterMinutes',
      'acceptance[0].id',
      'acceptance[0].argv',
      'acceptance[0].timeoutSeconds',
      'acceptance[0].required',
      'acceptance[0].outputMaxChars',
      'deliverablePath',
      'resourceClass',
      'priority',
    ]) {
      assert.ok(r.errors.some((e) => e.includes(needle)), `missing ${needle} in ${JSON.stringify(r.errors)}`);
    }
    assert.ok(r.errors.length >= 15, `expected >=15 errors, got ${r.errors.length}`);
  }
});

test('Windows path semantics: drive-letter paths are case-insensitive', () => {
  const winRoot = 'C:\\PROJECTS\\App';
  const inside = 'C:\\projects\\app\\src\\file.md';
  const outside = 'D:\\other\\file.md';
  const esc = 'C:\\projects\\app2\\file.md'; // sibling dir, must NOT be inside
  const c = validContract();
  c.scope = { readGlobs: [], writeFiles: ['src/**/*.ts'], forbiddenGlobs: [] };
  c.reporting = { deliverablePath: inside };
  const r = validateTaskContractV2(c, winRoot);
  if (!r.ok) assert.fail(JSON.stringify(r.errors));

  for (const bad of [outside, esc]) {
    const c2 = { ...validContract(), reporting: { deliverablePath: bad } };
    const r2 = validateTaskContractV2(c2, winRoot);
    assert.equal(r2.ok, false, bad);
    if (!r2.ok) assert.ok(r2.errors.some((e) => e.includes('inside workFolder')), String(r2.errors));
  }

  // A non-string deliverablePath value (invalid) is rejected.
  const c3 = { ...validContract(), reporting: { deliverablePath: 42 } };
  const r3 = validateTaskContractV2(c3, winRoot);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.ok(r3.errors.some((e) => e.includes('deliverablePath')), String(r3.errors));

  const slash = 'C:/PROJECTS/App/src/file.md';
  const r5 = validateTaskContractV2({ ...validContract(), reporting: { deliverablePath: slash } }, winRoot);
  if (!r5.ok) assert.fail(JSON.stringify(r5.errors));
  // Windows-style absolute scope glob must be rejected as non-relative.
  const r4 = validateTaskContractV2(
    { ...validContract(), scope: { readGlobs: [], writeFiles: ['C:\\projects\\app\\src\\*.ts'], forbiddenGlobs: [] } },
    winRoot,
  );
  assert.equal(r4.ok, false);
  if (!r4.ok) assert.ok(r4.errors.some((e) => e.includes('scope.writeFiles') && e.includes('relative')), String(r4.errors));
});

test('POSIX paths stay case-sensitive and absolute', () => {
  const posixRoot = '/work/app';
  const c = validContract();
  c.scope = { readGlobs: [], writeFiles: ['src/**/*.ts'], forbiddenGlobs: [] };
  c.reporting = { deliverablePath: '/WORK/APP/REPORT.MD' };
  const r = validateTaskContractV2(c, posixRoot);
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.errors.some((e) => e.includes('inside workFolder')), String(r.errors));

  const r2 = validateTaskContractV2(
    { ...validContract(), scope: { readGlobs: [], writeFiles: ['/work/app/src/*.ts'], forbiddenGlobs: [] } },
    posixRoot,
  );
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.ok(r2.errors.some((e) => e.includes('relative')), String(r2.errors));
});

test('buildLegacyContract fills conservative wave-2 budget defaults', () => {
  const c = buildLegacyContract({ taskType: 'execution', workFolder });
  assert.equal(c.budget.maxFilesRead, 200);
  assert.equal(c.budget.maxSourceLines, 50000);
  assert.equal(c.budget.maxToolCalls, 500);
  assert.equal(c.budget.maxBashCommands, 100);
  assert.equal(c.budget.explorationMinutes, 15);
  assert.equal(c.budget.maxTranscriptBytes, 4194304);
  assert.equal(c.budget.onExceeded, 'report_partial');
  assert.deepEqual(
    validateTaskContractV2(c as TaskContractV2, workFolder),
    { ok: true, value: c },
  );
  // explorationMinutes is clamped to maxRuntimeMinutes when the runtime is shorter.
  const short = buildLegacyContract({ taskType: 'execution', workFolder, maxRuntimeMinutes: 5 });
  assert.equal(short.budget.explorationMinutes, 5);
  assert.deepEqual(
    validateTaskContractV2(short as TaskContractV2, workFolder),
    { ok: true, value: short },
  );
});

test('buildLegacyContract maps execution to workspace_legacy', () => {
  const c = buildLegacyContract({ taskType: 'execution', workFolder });
  assert.equal(c.schemaVersion, CONTRACT_V2_SCHEMA_VERSION);
  assert.equal(c.writePolicy, 'workspace_legacy');
  assert.deepEqual(c.scope, { readGlobs: [], writeFiles: [], forbiddenGlobs: [] });
  assert.equal(c.acceptance.length, 0);
  assert.equal(c.budget.maxRuntimeMinutes, 120);
  assert.equal(c.budget.reportOnlyAfterMinutes, 120);
  assert.equal(c.admission.resourceClass, 'light');
  assert.equal(c.admission.priority, 0);
  assert.equal('deliverablePath' in c.reporting, false);
});

test('buildLegacyContract maps research and analysis to read_only_report only when a deliverablePath is given', () => {
  for (const taskType of ['research', 'analysis']) {
    const withDeliverable = buildLegacyContract({
      taskType,
      deliverablePath: path.join(workFolder, 'report.md'),
      workFolder,
    });
    assert.equal(withDeliverable.writePolicy, 'read_only_report', taskType);

    const withoutDeliverable = buildLegacyContract({ taskType, workFolder });
    assert.equal(withoutDeliverable.writePolicy, 'workspace_legacy', taskType);
  }
});

test('buildLegacyContract maps unknown task types to workspace_legacy', () => {
  const c = buildLegacyContract({ taskType: 'summarize', workFolder });
  assert.equal(c.writePolicy, 'workspace_legacy');
});

test('buildLegacyContract passes deliverablePath and maxRuntimeMinutes through', () => {
  const c = buildLegacyContract({
    taskType: 'research',
    deliverablePath: path.join(workFolder, 'report.md'),
    workFolder,
    maxRuntimeMinutes: 45,
  });
  assert.equal(c.writePolicy, 'read_only_report');
  assert.equal(c.budget.maxRuntimeMinutes, 45);
  assert.equal(c.budget.reportOnlyAfterMinutes, 45);
  assert.equal(c.reporting.deliverablePath, path.join(workFolder, 'report.md'));
  assert.deepEqual(
    validateTaskContractV2(c as TaskContractV2, workFolder),
    { ok: true, value: c },
  );
});
