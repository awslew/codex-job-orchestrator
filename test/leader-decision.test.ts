// Pure parser tests for the frozen leader-decision handoff receipt
// (2026-09-07 protocol). No I/O, no process spawns: scanLeaderDecision is a
// pure leaf module, so the whole matrix is deterministic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEADER_DECISION_MARKER,
  LEADER_DECISION_MAX_FIELD_CHARS,
  scanLeaderDecision,
  leaderDecisionProtocolErrorKind,
  type LeaderDecisionScan,
} from '../src/leader-decision.js';

const ok = (record: { reason: string; evidence: string; decisionNeeded: string }): string =>
  `${LEADER_DECISION_MARKER}${JSON.stringify({
    schemaVersion: 1,
    reason: record.reason,
    evidence: record.evidence,
    decisionNeeded: record.decisionNeeded,
  })}`;

test('no marker -> no_marker (legacy final text unchanged)', () => {
  for (const text of ['', 'plain success', '状态：成功\n变更摘要：…', 'DONE']) {
    const s = scanLeaderDecision(text);
    assert.equal(s.kind, 'no_marker', JSON.stringify(text));
  }
});

test('valid single-line receipt -> ok with trimmed record', () => {
  const line = ok({
    reason: '  超出职责边界  ',
    evidence: 'path/to/report.md',
    decisionNeeded: '是否批准方案',
  });
  const s = scanLeaderDecision(`已完成任务。\n${line}\n后续说明。`);
  assert.equal(s.kind, 'ok');
  if (s.kind !== 'ok') return;
  assert.equal(s.markerCount, 1);
  assert.equal(s.record.reason, '超出职责边界');
  assert.equal(s.record.evidence, 'path/to/report.md');
  assert.equal(s.record.decisionNeeded, '是否批准方案');
});

test('marker embedded in a fenced code block or blockquote is NOT a receipt', () => {
  const receipt = ok({ reason: 'r', evidence: 'e', decisionNeeded: 'd' });
  const fenced = `实现完成。\n\`\`\`\n${receipt}\n\`\`\`\n`;
  assert.equal(scanLeaderDecision(fenced).kind, 'no_marker', 'fenced receipt must be ignored');
  const quoted = `> ${receipt}\n`;
  assert.equal(scanLeaderDecision(quoted).kind, 'no_marker', 'quoted receipt must be ignored');
});

test('multiple real markers -> duplicate_marker', () => {
  const one = ok({ reason: 'r', evidence: 'e', decisionNeeded: 'd' });
  const s = scanLeaderDecision(`${one}\n${one}`);
  assert.equal(s.kind, 'duplicate_marker');
  assert.equal(leaderDecisionProtocolErrorKind(s), 'leader_decision_duplicate_marker');
});

test('marker with malformed JSON -> invalid_json, never success', () => {
  const bad = [
    `${LEADER_DECISION_MARKER} not-json`,
    `${LEADER_DECISION_MARKER} {"schemaVersion":1,`, // truncated
    `${LEADER_DECISION_MARKER}`, // empty remainder
    `${LEADER_DECISION_MARKER} {"schemaVersion":1,"reason":"r"} trailing`, // trailing text
  ];
  for (const line of bad) {
    const s = scanLeaderDecision(line);
    assert.equal(s.kind, 'invalid_json', JSON.stringify(line));
    assert.equal(leaderDecisionProtocolErrorKind(s), 'leader_decision_invalid_json');
  }
});

test('wrong schemaVersion / non-object -> wrong_schema', () => {
  const s0 = scanLeaderDecision(
    `${LEADER_DECISION_MARKER}${JSON.stringify({ schemaVersion: 2, reason: 'r', evidence: 'e', decisionNeeded: 'd' })}`,
  );
  assert.equal(s0.kind, 'wrong_schema');
  const s1 = scanLeaderDecision(`${LEADER_DECISION_MARKER}[1,2,3]`);
  assert.equal(s1.kind, 'wrong_schema');
});

test('empty/whitespace field -> empty_field', () => {
  const mk = (field: string, value: string): string =>
    `${LEADER_DECISION_MARKER}${JSON.stringify({ schemaVersion: 1, reason: 'r', evidence: 'e', decisionNeeded: 'd', [field]: value })}`;
  for (const field of ['reason', 'evidence', 'decisionNeeded'] as const) {
    for (const value of ['', '   ']) {
      const s = scanLeaderDecision(mk(field, value));
      assert.equal(s.kind, 'empty_field', `${field}=${JSON.stringify(value)}`);
    }
  }
  const s = scanLeaderDecision(mk('reason', ''));
  assert.equal(leaderDecisionProtocolErrorKind(s), 'leader_decision_empty_field');
});

test('overlong field -> overlong_field with field name', () => {
  const long = 'x'.repeat(LEADER_DECISION_MAX_FIELD_CHARS + 1);
  const line = `${LEADER_DECISION_MARKER}${JSON.stringify({ schemaVersion: 1, reason: long, evidence: 'e', decisionNeeded: 'd' })}`;
  const s = scanLeaderDecision(line);
  assert.equal(s.kind, 'overlong_field');
  if (s.kind !== 'overlong_field') return;
  assert.equal(s.field, 'reason');
  assert.equal(s.length, long.length);
  assert.equal(leaderDecisionProtocolErrorKind(s), 'leader_decision_overlong_reason');
  // A field exactly at the cap is valid.
  const atCap = `${LEADER_DECISION_MARKER}${JSON.stringify({ schemaVersion: 1, reason: 'x'.repeat(LEADER_DECISION_MAX_FIELD_CHARS), evidence: 'e', decisionNeeded: 'd' })}`;
  assert.equal(scanLeaderDecision(atCap).kind, 'ok');
});

test('JSON string escaping in the result field is not a second marker', () => {
  // A receipt whose evidence contains a JSON-escaped marker must still parse
  // as a single marker (indexOf counting is per literal occurrence on the
  // final text line, and the JSON string holds no literal marker).
  const evidence = `docs/a.md\n${LEADER_DECISION_MARKER}`;
  const line = `${LEADER_DECISION_MARKER}${JSON.stringify({ schemaVersion: 1, reason: 'r', evidence, decisionNeeded: 'd' })}`;
  const s = scanLeaderDecision(line);
  assert.equal(s.kind, 'ok');
});

test('non-string input is defensive no_marker', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(scanLeaderDecision(undefined as any).kind, 'no_marker');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.equal(scanLeaderDecision(null as any).kind, 'no_marker');
});
