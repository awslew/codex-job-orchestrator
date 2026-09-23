import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  WORKER_BACKENDS,
  isWorkerBackend,
  REPLY_MODES,
  DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES,
  replyTranscriptMaxBytes,
  ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES,
  BACKEND_CAPABILITIES,
  evaluateReplyPreflight,
  type ReplyPreflight,
} from '../src/backend-policy.js';

// ---------------------------------------------------------------------------
// Fixed capability matrix (single source of truth).
// ---------------------------------------------------------------------------

test('claude backend supports cancel/attention/live/resume with resume_session replies', () => {
  const c = BACKEND_CAPABILITIES.claude;
  assert.equal(c.supportsCancel, true);
  assert.equal(c.supportsAttention, true);
  assert.equal(c.supportsLiveEvents, true);
  assert.equal(c.supportsSessionResume, true);
  assert.equal(c.replyMode, 'resume_session');
});

test('deepseek-harness backend: cancel only, fresh_turn replies', () => {
  const h = BACKEND_CAPABILITIES['deepseek-harness'];
  assert.equal(h.supportsCancel, true);
  assert.equal(h.supportsAttention, false);
  assert.equal(h.supportsLiveEvents, false);
  assert.equal(h.supportsSessionResume, false);
  assert.equal(h.replyMode, 'fresh_turn');
});

test('capability matrix covers exactly the two known backends', () => {
  assert.deepEqual(WORKER_BACKENDS, ['claude', 'deepseek-harness']);
  assert.deepEqual(REPLY_MODES, ['resume_session', 'fresh_turn']);
  assert.deepEqual(Object.keys(BACKEND_CAPABILITIES).sort(), ['claude', 'deepseek-harness']);
  for (const b of WORKER_BACKENDS) assert.equal(isWorkerBackend(b), true);
  assert.equal(isWorkerBackend('gpt'), false);
  assert.equal(isWorkerBackend(42), false);
  assert.equal(isWorkerBackend(undefined), false);
});

// ---------------------------------------------------------------------------
// Transcript threshold: default / override / invalid values.
// ---------------------------------------------------------------------------

test('reply transcript threshold defaults to 2 MiB and reads a positive-integer env override', () => {
  assert.equal(DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(replyTranscriptMaxBytes({}), DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES);
  assert.equal(
    replyTranscriptMaxBytes({ [ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES]: '1048576' }),
    1048576,
  );
  assert.equal(replyTranscriptMaxBytes({ [ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES]: '1' }), 1);
});

test('invalid threshold values fall back to the default', () => {
  for (const bad of ['0', '-5', '1.5', 'abc', ' 2097152 ', 'NaN', 'Infinity', '']) {
    assert.equal(
      replyTranscriptMaxBytes({ [ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES]: bad }),
      DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES,
      `env=${JSON.stringify(bad)} must fall back to default`,
    );
  }
});

// ---------------------------------------------------------------------------
// The four reply decisions.
// ---------------------------------------------------------------------------

test('claude: under threshold resumes without any override', () => {
  const r = evaluateReplyPreflight('claude', 1024);
  assert.equal(r.status, 'allowed');
  assert.equal(r.allowed, true);
  assert.equal(r.replyMode, 'resume_session');
  assert.equal(r.code, undefined);
});

test('claude: over threshold is denied new_start_required unless allowLargeResume', () => {
  const denied = evaluateReplyPreflight('claude', DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES + 1);
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'new_start_required');
  assert.equal(denied.replyMode, undefined);
  const allowed = evaluateReplyPreflight('claude', DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES + 1, {
    allowLargeResume: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.replyMode, 'resume_session');
});

test('deepseek-harness: denied fresh_turn_authorization_required unless allowFreshTurn', () => {
  const denied = evaluateReplyPreflight('deepseek-harness', 10);
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'fresh_turn_authorization_required');
  assert.equal(denied.replyMode, undefined);
  const allowed = evaluateReplyPreflight('deepseek-harness', 10, { allowFreshTurn: true });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.replyMode, 'fresh_turn');
});

test('threshold equality and custom threshold boundary', () => {
  const at = evaluateReplyPreflight('claude', DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES);
  assert.equal(at.allowed, true, 'exactly at threshold is allowed');
  const custom = evaluateReplyPreflight('claude', 10, { maxBytes: 10 });
  assert.equal(custom.allowed, true);
  assert.equal(custom.threshold, 10);
  const over = evaluateReplyPreflight('claude', 11, { maxBytes: 10 });
  assert.equal(over.allowed, false);
  assert.equal(over.code, 'new_start_required');
});

// ---------------------------------------------------------------------------
// Safe metadata only: no paths, no prompts, fixed codes.
// ---------------------------------------------------------------------------

test('preflight results carry only fixed codes and safe metadata', () => {
  const denied = evaluateReplyPreflight('claude', 5 * 1024 * 1024);
  assert.deepEqual(denied, {
    status: 'denied',
    allowed: false,
    code: 'new_start_required',
    backend: 'claude',
    bytes: 5 * 1024 * 1024,
    threshold: DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES,
    allowLargeResume: false,
    allowFreshTurn: false,
    thresholdOverridden: false,
  });
  assert.ok(!JSON.stringify(denied).includes('/'), 'no path-like value');
  const allowed = evaluateReplyPreflight('deepseek-harness', 7, { allowFreshTurn: true });
  assert.deepEqual(allowed, {
    status: 'allowed',
    allowed: true,
    replyMode: 'fresh_turn',
    backend: 'deepseek-harness',
    bytes: 7,
    threshold: DEFAULT_REPLY_TRANSCRIPT_MAX_BYTES,
    allowLargeResume: false,
    allowFreshTurn: true,
    thresholdOverridden: false,
  });
});

test('thresholdOverridden is true only for an explicit maxBytes override', () => {
  const r: ReplyPreflight = evaluateReplyPreflight('claude', 0, { maxBytes: 2 * 1024 * 1024 });
  assert.equal(r.thresholdOverridden, true);
  assert.equal(r.threshold, 2 * 1024 * 1024);
});

// The module must stay pure: no fs or process import may sneak in.
test('backend-policy module has no fs/process side-effect imports', () => {
  const source = fs.readFileSync(new URL('../src/backend-policy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:fs['"]/, 'must not import node:fs');
  assert.doesNotMatch(source, /from ['"]node:process['"]/, 'must not import node:process');
  assert.doesNotMatch(source, /from ['"]node:child_process['"]/, 'must not spawn processes');
});
