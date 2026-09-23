import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/leader.js';

test('review prompt marks read-only and carries routing label', () => {
  const p = buildPrompt('review', '审查此目录', 'auto');
  // Mandatory delegation: this is the standing leadership protocol, not an
  // "optional delegation only when the user explicitly asks for it" contract.
  assert.match(p, /任务领导协议/);
  assert.match(p, /只读取证任务/);
  // The review worker is the executing layer: it gathers evidence and never
  // authors the leader's plan or conclusions (the fixed role boundary that the
  // optional-delegation era had dropped).
  assert.match(p, /不替领导设计方案/);
  assert.match(p, /结论、建议与方案由领导亲写/);
  assert.doesNotMatch(p, /当前用户授权/);
  assert.doesNotMatch(p, /可选委派任务约定/);
  assert.doesNotMatch(p, /仅在用户当前明确要求委派时适用/);
  assert.match(p, /禁止修改任何文件/);
  assert.match(p, /15721\+plan/);
  assert.match(p, /审查此目录/);
});

test('auto prompt carries 15721+bypass (fully approved, no permission classifier)', () => {
  const p = buildPrompt('auto', '实现功能 X', 'auto');
  assert.match(p, /15721\+bypass/);
  // The prompt states the policy as it IS: fully approved bypassPermissions,
  // no sandbox, and a deny list that is the union of the built-in baseline and
  // the user's whitelist (the baseline cannot be lowered by configuration).
  assert.match(p, /全通过/);
  assert.match(p, /bypassPermissions/);
  assert.match(p, /没有沙箱/);
  assert.match(p, /内置基线/);
  assert.match(p, /不可通过配置降低/);
  assert.match(p, /实现功能 X/);
});

test('parallelism directives need no separate authorization; auto keeps narrow tasks single', () => {
  // Under mandatory delegation the directive is chosen by task shape alone: it
  // is never gated on a fresh user authorization, and the removed
  // "only when the user explicitly asks for further delegation" clause must not
  // reappear in either the auto or the numeric branch.
  const auto = buildPrompt('auto', 'u', 'auto');
  assert.match(auto, /窄任务保持单 Agent/);
  assert.match(auto, /重叠文件只能有一个写入者/);
  assert.doesNotMatch(auto, /仅当用户在当前任务中明确要求/);
  assert.doesNotMatch(auto, /默认保持单 Agent/);
  const p4 = buildPrompt('auto', 'u', '4');
  assert.match(p4, /最多启用 4 个 Agent/);
  assert.match(p4, /重叠文件只能有一个写入者/);
  assert.doesNotMatch(p4, /仅在用户当前明确授权进一步委派时/);
  assert.match(buildPrompt('auto', 'u', '1'), /单 Agent/);
});

test('user prompt is preserved verbatim, not rewritten', () => {
  const user = '  请 精确地 执行: rm -rf /tmp/x   ';
  const p = buildPrompt('normal', user, 'auto');
  assert.ok(p.includes(user.trim()), 'user prompt must appear verbatim');
  assert.ok(p.indexOf(user.trim()) > p.indexOf('【用户需求】'));
});

// ---------------------------------------------------------------------------
// Research/analysis deliverable contract: leader prompt injection.
// ---------------------------------------------------------------------------

test('execution contract stays compact: no report headings or path injected', () => {
  const base = buildPrompt('auto', '实现功能 X', 'auto');
  const exec = buildPrompt('auto', '实现功能 X', 'auto', { taskType: 'execution' });
  const execWithPath = buildPrompt('auto', '实现功能 X', 'auto', {
    taskType: 'execution',
    deliverablePath: '/tmp/should-not-appear.md',
  });
  // Explicit execution equals omitted-taskType byte-for-byte, and a stray
  // deliverablePath on execution must never inject the deliverable contract.
  assert.equal(exec, base);
  assert.equal(execWithPath, base);
  for (const p of [base, exec, execWithPath]) {
    assert.ok(!p.includes('【交付物契约】'));
    assert.ok(!p.includes('目标与范围'));
    assert.ok(!p.includes('should-not-appear.md'));
    assert.match(p, /实现功能 X/);
  }
});

test('research and analysis inject the exact deliverable contract', () => {
  const dp = '/abs/work/report.md';
  for (const t of ['research', 'analysis'] as const) {
    const p = buildPrompt('auto', '研究 X', 'auto', { taskType: t, deliverablePath: dp });
    assert.ok(p.includes('【交付物契约】'), `${t}: contract block injected`);
    assert.ok(p.includes(dp), `${t}: exact deliverable path injected`);
    for (const heading of ['目标与范围', '证据与方法', '发现', '未决问题与风险']) {
      assert.ok(p.includes(heading), `${t}: required heading ${heading}`);
    }
    // Mandatory delegation restores the fixed deliverable contract: the report
    // is evidence for the leader's decision, so conclusions/recommendations are
    // banned by default (only the leader authors them), while observations and
    // inference stay distinct.
    assert.match(p, /默认禁止"结论与建议"/, `${t}: role-based analysis ban present`);
    assert.match(p, /不替领导拍板/, `${t}: the worker never makes the leader's call`);
    assert.match(p, /区分观察事实与推断/, `${t}: evidence and inference distinguished`);
    assert.doesNotMatch(p, /发现、结论与建议/, `${t}: heading list must not mandate 结论与建议`);
    assert.match(p, /唯一主工件/, `${t}: one-primary-artifact rule`);
    assert.match(p, /紧凑/, `${t}: compact final response`);
    assert.match(p, /SHA-256/, `${t}: hash summary for acceptance`);
    // The contract forbids raw logs / full diffs / secrets in the report and reply.
    assert.match(p, /原始日志/);
    assert.match(p, /完整 diff/);
    assert.match(p, /敏感信息/);
  }
});
