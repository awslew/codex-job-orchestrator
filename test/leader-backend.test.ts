import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/leader.js';

const PROMPT = '按既定方案实现 Wave 3A';

// ---------------------------------------------------------------------------
// Old-call byte compatibility: no execution context must not change output.
// ---------------------------------------------------------------------------

test('no execution context: output stays byte-for-byte identical to the historical prompt', () => {
  const noArg = buildPrompt('auto', PROMPT, '1');
  const undefinedCtx = buildPrompt('auto', PROMPT, '1', undefined);
  assert.equal(undefinedCtx, noArg, 'omitted context must equal omitted 5th arg');
  assert.ok(!noArg.includes('【执行语义】'));
  assert.ok(noArg.includes('【用户需求】'));
  assert.ok(noArg.includes(PROMPT));
  // The historical marker line lands directly before 【用户需求】.
  assert.ok(noArg.includes('【路由】15721+bypass（profile=auto，parallelism=1）\n\n【用户需求】'));
});

test('execution contract with both deliverable and context stays additive', () => {
  const base = buildPrompt('auto', PROMPT, '1');
  const ctx = buildPrompt('auto', PROMPT, '1', undefined, {
    backend: 'claude',
    replyMode: 'resume_session',
  });
  const ctxPlusContract = buildPrompt('auto', PROMPT, '1', {
    taskType: 'research',
    deliverablePath: '/abs/work/report.md',
  }, { backend: 'claude', replyMode: 'resume_session' });
  assert.ok(ctx.includes('【执行语义】'));
  assert.ok(ctxPlusContract.includes('【执行语义】'));
  assert.ok(ctxPlusContract.includes('【交付物契约】'));
  // The injected semantics block must not disturb the historical segments.
  assert.ok(ctxPlusContract.includes(base.slice(0, base.indexOf('【用户需求】'))));
  assert.ok(ctxPlusContract.includes(PROMPT));
});

// ---------------------------------------------------------------------------
// The two context texts.
// ---------------------------------------------------------------------------

test('claude+resume_session states the saved Claude session is resumed', () => {
  const p = buildPrompt('auto', PROMPT, '1', undefined, {
    backend: 'claude',
    replyMode: 'resume_session',
  });
  assert.ok(p.includes('【执行语义】'));
  assert.match(p, /续接已保存的 Claude 会话/);
  // Injected before the user requirement, user text untouched.
  assert.ok(p.indexOf('【执行语义】') < p.lastIndexOf('【用户需求】'));
  assert.ok(p.includes(PROMPT));
});

test('deepseek-harness+fresh_turn declares a new independent turn with no session claims', () => {
  const p = buildPrompt('auto', PROMPT, '1', undefined, {
    backend: 'deepseek-harness',
    replyMode: 'fresh_turn',
  });
  assert.ok(p.includes('【执行语义】'));
  assert.match(p, /新的独立轮次/);
  assert.match(p, /不继承历史会话上下文/);
  // No English phrase resembling "saved session resume".
  assert.doesNotMatch(p, /saved session resume/i);
  // The injected block must not claim any prior session can be recovered.
  const block = p.slice(p.indexOf('【执行语义】'), p.lastIndexOf('【用户需求】'));
  for (const forbidden of ['已保存', '恢复', '可续接', '重用']) {
    assert.ok(!block.includes(forbidden), `block must not claim recoverability: ${forbidden}`);
  }
  assert.ok(p.includes(PROMPT), 'user text preserved');
});

// ---------------------------------------------------------------------------
// Harness must never emit misleading recoverable-session semantics, and the
// user's original text is never changed in either mode.
// ---------------------------------------------------------------------------

test('harness text cannot be switched into a resume-session claim', () => {
  const p = buildPrompt('auto', PROMPT, '1', undefined, {
    backend: 'deepseek-harness',
    replyMode: 'fresh_turn',
  });
  const block = p.slice(p.indexOf('【执行语义】'), p.indexOf('【用户需求】'));
  assert.doesNotMatch(block, /saved session resume/i);
  assert.doesNotMatch(block, /session/i);
  assert.doesNotMatch(block, /resume/i);
  assert.doesNotMatch(block, /saved/i);
});

test('user prompt is preserved verbatim under both execution contexts', () => {
  const user = '  处理：abc & xyz；勿删   ';
  for (const execution of [
    { backend: 'claude', replyMode: 'resume_session' },
    { backend: 'deepseek-harness', replyMode: 'fresh_turn' },
  ] as const) {
    const p = buildPrompt('normal', user, 'auto', undefined, execution);
    assert.ok(p.includes(user.trim()), `verbatim user text (${execution.replyMode})`);
    assert.ok(p.indexOf(user.trim()) > p.indexOf('【用户需求】'));
  }
});

// ---------------------------------------------------------------------------
// No prompt/path leakage.
// ---------------------------------------------------------------------------

test('injected context never carries prompts or paths', () => {
  for (const execution of [
    { backend: 'claude', replyMode: 'resume_session' },
    { backend: 'deepseek-harness', replyMode: 'fresh_turn' },
  ] as const) {
    const p = buildPrompt('auto', PROMPT, '1', undefined, execution);
    assert.ok(!p.includes(execution.backend), 'backend name must not appear in prompt text');
    assert.ok(!p.includes(execution.replyMode), 'reply mode must not appear in prompt text');
    assert.ok(!p.includes('C:\\'), 'no backslash windows path');
    assert.ok(!p.includes('D:\\'), 'no backslash drive path');
    assert.ok(!p.includes('.md'), 'no markdown file path');
  }
});
