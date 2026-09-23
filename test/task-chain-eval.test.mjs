// task-chain-eval.test.mjs — 离线评估小工具的 node:test 覆盖（最小集）。
// 字段/负数/null/不同单位/非 isolated/混合分组/格式错误 各自独立用例。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRow, validateRow, summarize, evaluateFile } from '../scripts/task-chain-eval.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = (over) => ({
  schemaVersion: 1,
  taskId: 't-1',
  taskType: 'implementation',
  mode: 'mixed',
  backend: 'claude',
  accepted: true,
  elapsedSeconds: 100,
  repairCount: 0,
  leaderInterventions: 0,
  codexUsage: null,
  codexUsageUnit: null,
  attribution: null,
  externalCostUsd: null,
  ...over,
});
const ROW = (over) =>
  JSON.stringify({
    schemaVersion: 1,
    taskId: 'a',
    taskType: 'impl',
    mode: 'pure_astra',
    backend: 'none',
    accepted: true,
    elapsedSeconds: 1,
    repairCount: 0,
    leaderInterventions: 0,
    ...over,
  });

describe('parseRow / validateRow', () => {
  it('接受合法行且默认缺省 codexUsage/externalCostUsd 为 null（未知不归零）', () => {
    const p = parseRow(
      JSON.stringify({ schemaVersion: 1, taskId: 'a', taskType: 'impl', mode: 'pure_astra', backend: 'none', accepted: true, elapsedSeconds: 0, repairCount: 1, leaderInterventions: 0 }),
      1,
    );
    assert.equal(p.ok, true);
    assert.equal(p.record.codexUsage, null); // 未知缺省 → null，不归零
    assert.equal(p.record.externalCostUsd, null); // 输入未给 → null（同"未知"语义）
    assert.equal(p.record.codexUsageUnit, null); // 无 codexUsage → 口径字段归一为 null
    assert.equal(p.record.attribution, null);
    assert.equal(p.record.repairCount, 1); // 元数据不变
    assert.equal(p.issues.length, 0); // 缺 metric 的行不算"口径问题"——根本没进聚合，无口径可违
  });

  it('拒绝负数 elapsedSeconds 与负数 repairCount/leaderInterventions', () => {
    const a = validateRow(R({ elapsedSeconds: -1 }), 1);
    assert.equal(a.ok, false);
    assert.match(a.errors[0], /elapsedSeconds 必须是非负数/);
    const b = validateRow(R({ repairCount: -1 }), 1);
    assert.equal(b.ok, false);
    assert.match(b.errors[0], /repairCount 必须是非负整数/);
    const c = validateRow(R({ leaderInterventions: -0.5 }), 1);
    assert.equal(c.ok, false);
    assert.match(c.errors[0], /leaderInterventions 必须是非负整数/);
  });

  it('拒绝非整数/非布尔/超长/未知枚举字段', () => {
    assert.equal(validateRow(R({ repairCount: 1.5 }), 1).ok, false);
    assert.equal(validateRow(R({ accepted: 'true' }), 1).ok, false);
    assert.equal(validateRow(R({ taskType: 'x'.repeat(65) }), 1).ok, false);
    assert.equal(validateRow(R({ mode: 'hybrid' }), 1).ok, false);
    assert.equal(validateRow(R({ backend: 'unknown-backend' }), 1).ok, false);
    assert.equal(validateRow(R({ schemaVersion: 2 }), 1).ok, false);
  });

  it('mode↔backend 联动：pure_astra 只能 none，mixed 只能 claude/deepseek-harness/luna', () => {
    // pure_astra + 真实员工 → 拒绝（纯 Astra 无员工，不得归账到不存在员工）
    for (const b of ['claude', 'deepseek-harness', 'luna']) {
      const a = validateRow(R({ mode: 'pure_astra', backend: b }), 1);
      assert.equal(a.ok, false, `pure_astra+${b} 应拒绝`);
      assert.match(a.errors[0], /mode=pure_astra 的 backend 必须为 'none'/);
    }
    // mixed + none → 拒绝（mixed 必须有员工）
    const b = validateRow(R({ mode: 'mixed', backend: 'none' }), 1);
    assert.equal(b.ok, false);
    assert.match(b.errors[0], /mode=mixed 的 backend 必须为 claude\/deepseek-harness\/luna/);
    // 合法组合全接受
    for (const combo of [
      { mode: 'pure_astra', backend: 'none' },
      { mode: 'mixed', backend: 'claude' },
      { mode: 'mixed', backend: 'deepseek-harness' },
      { mode: 'mixed', backend: 'luna' },
    ]) {
      assert.equal(validateRow(R(combo), 1).ok, true, JSON.stringify(combo));
    }
  });

  it('schemaVersion 缺失/字符串化 null 不被静默当作 0', () => {
    const a = validateRow(R({ codexUsage: '0' }), 1); // 字符串 '0' 不能冒充数值 0
    assert.equal(a.ok, false);
    const b = parseRow('not-json-at-all', 7);
    assert.equal(b.ok, false);
    assert.equal(b.error, '第 7 行不是合法 JSON');
  });

  it('unit 接受任意显式非空字符串（tokens/credits/quota_percent），拒绝空串/非字符串；attribution 仅 isolated', () => {
    // 任意明确单位都合法：脚本不锁定 tokens、不换算
    assert.equal(validateRow(R({ codexUsage: 100, codexUsageUnit: 'tokens', attribution: 'isolated' }), 1).ok, true);
    assert.equal(validateRow(R({ codexUsage: 100, codexUsageUnit: 'credits', attribution: 'isolated' }), 1).ok, true);
    assert.equal(validateRow(R({ codexUsage: 100, codexUsageUnit: 'quota_percent', attribution: 'isolated' }), 1).ok, true);
    // 显式但为空/非字符串 → 拒绝
    const a = validateRow(R({ codexUsage: 100, codexUsageUnit: '' }), 1);
    assert.equal(a.ok, false);
    assert.match(a.errors[0], /codexUsageUnit 必须是非空字符串/);
    assert.equal(validateRow(R({ codexUsage: 100, codexUsageUnit: 42 }), 1).ok, false);
    assert.equal(validateRow(R({ codexUsage: 100, codexUsageUnit: 'x'.repeat(33) }), 1).ok, false); // 超长
    // attribution 只接受 isolated / null
    assert.equal(validateRow(R({ codexUsage: 100, attribution: 'estimated' }), 1).ok, false);
  });
});

describe('summarize 聚合语义', () => {
  it('覆盖样本覆盖率：null 未知不混入 0 也不计入分子分母之外的可归因总量', () => {
    const s = summarize([
      R({ taskId: 'a', codexUsage: null }),
      R({ taskId: 'b', codexUsage: 5000, codexUsageUnit: 'tokens', attribution: 'isolated' }),
    ]);
    const g = s.groups[0];
    assert.equal(s.totalRows, 2);
    assert.equal(g.codexUsageCoverage, 1);
    assert.equal(g.externalCostUsdCoverage, 0);
    assert.equal(g.codexUsageTotal, null); // 未知样本(1/2) → 不聚合总量
    assert.equal(g.codexUsageComparable, false);
  });

  it('口径不一致（unit 混排：显式 tokens 与缺省）→ 不生成 codexUsageTotal，message 明示口径不全', () => {
    // 缺省记录（无 unit/attribution）→ parseRow 归一为 null；显式 tokens+isolated 才进聚合
    const a = parseRow(
      JSON.stringify({ schemaVersion: 1, taskId: 'a', taskType: 'impl', mode: 'pure_astra', backend: 'none', accepted: true, elapsedSeconds: 1, repairCount: 0, leaderInterventions: 0, codexUsage: 100 }),
      1,
    );
    const b = parseRow(
      JSON.stringify({ schemaVersion: 1, taskId: 'b', taskType: 'impl', mode: 'pure_astra', backend: 'none', accepted: true, elapsedSeconds: 1, repairCount: 0, leaderInterventions: 0, codexUsage: 200, codexUsageUnit: 'tokens', attribution: 'isolated' }),
      2,
    );
    const s = summarize([a.record, b.record]);
    const g = s.groups[0];
    assert.equal(a.issues.length, 2); // a 有值但缺显式 unit+attribution → 两条口径未知 issue
    assert.equal(b.issues.length, 0); // b 显式 tokens+isolated → 无 issue
    assert.equal(g.codexUsageTotal, null); // 口径未知行不可归因总量
    assert.equal(s.analysis.metricComparable, false);
    assert.match(s.analysis.message, /聚合条件|归因|口径/);
  });

  it('attribution 非 isolated（未知/估计）→ 不聚合，report message 明示', () => {
    const s = summarize([
      R({ taskId: 'a', codexUsage: 100, codexUsageUnit: 'tokens', attribution: 'estimated' }),
      R({ taskId: 'b', codexUsage: 200, codexUsageUnit: 'tokens', attribution: 'isolated' }),
    ]);
    const g = s.groups[0];
    assert.equal(g.codexUsageComparable, false);
    assert.equal(g.codexUsageTotal, null);
    assert.equal(s.analysis.metricComparable, false);
    assert.match(s.analysis.message, /口径|归因/);
  });

  it('非 tokens 单位（credits）：同组全部同单位+isolated → 可归因聚合并报告该单位', () => {
    const s = summarize([
      R({ taskId: 'a', codexUsage: 100, codexUsageUnit: 'credits', attribution: 'isolated' }),
      R({ taskId: 'b', codexUsage: 200, codexUsageUnit: 'credits', attribution: 'isolated' }),
    ]);
    const g = s.groups[0];
    assert.equal(g.codexUsageTotal, 300);
    assert.equal(g.codexUsageUnit, 'credits'); // 原样报告单位，不做转换
    assert.equal(g.codexUsageComparable, true);
    assert.equal(s.analysis.metricComparable, true);
    assert.equal(s.analysis.metricUnit, 'credits');
  });

  it('单位混排（tokens vs credits）→ 不生成总量，message 明示单位不一致', () => {
    const s = summarize([
      R({ taskId: 'a', codexUsage: 100, codexUsageUnit: 'tokens', attribution: 'isolated' }),
      R({ taskId: 'b', codexUsage: 200, codexUsageUnit: 'credits', attribution: 'isolated' }),
    ]);
    const g = s.groups[0];
    assert.equal(g.codexUsageComparable, false);
    assert.equal(g.codexUsageTotal, null);
    assert.equal(g.codexUsageUnit, null);
    assert.equal(s.analysis.metricComparable, false);
    assert.match(s.analysis.message, /单位口径|同一单位/);
  });

  it('混合分组：按 taskType+mode 拆组，各自计算覆盖率与验收率', () => {
    const s = summarize([
      R({ taskId: 'a', taskType: 'implementation', mode: 'pure_astra', backend: 'none', accepted: true, repairCount: 0 }),
      R({ taskId: 'b', taskType: 'implementation', mode: 'pure_astra', backend: 'none', accepted: false, repairCount: 2 }),
      R({ taskId: 'c', taskType: 'research', mode: 'pure_astra', backend: 'none', accepted: true, repairCount: 1 }),
    ]);
    assert.equal(s.totalRows, 3);
    assert.equal(s.groups.length, 2);
    const impl = s.groups.find((g) => g.taskType === 'implementation');
    assert.equal(impl.samples, 2);
    assert.equal(impl.accepted, 1);
    assert.equal(impl.acceptanceRate, 0.5);
    assert.equal(impl.firstPass, 1); // accepted && repairCount===0
    assert.equal(impl.totalRepairs, 2);
  });

  it('覆盖率样本：cost 已知但 metric 未知时不冒充 cost 聚合', () => {
    const s = summarize([
      R({ taskId: 'a', codexUsage: null, externalCostUsd: 1.2 }),
      R({ taskId: 'b', codexUsage: null, externalCostUsd: 0.8 }),
    ]);
    const g = s.groups[0];
    assert.equal(g.externalCostUsdCoverage, 2);
    assert.equal(g.externalCostUsdSum, 2.0);
    assert.equal(g.codexUsageCoverage, 0);
    assert.equal(g.codexUsageTotal, null);
    assert.equal(s.analysis.metricComparable, false); // 0/2 可归因
  });
});

describe('evaluateFile 端到端', () => {
  function tmp(jsonl) {
    const f = path.join(os.tmpdir(), `tce-${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(f, jsonl);
    return f;
  }

  it('格式错误行 → 非零退出，错误信息带行号', () => {
    const f = tmp(`${ROW({ taskId: 'a' })}\n{broken}\n`);
    const r = evaluateFile(f);
    assert.equal(r.exitCode, 1);
    assert.match(r.output.error, /输入不合法/);
    assert.match(r.output.detail[0], /第 2 行/);
    fs.unlinkSync(f);
  });

  it('合法行数 ≥1 → exitCode 0，输出 summary', () => {
    const f = tmp(`${ROW({ taskId: 'a' })}\n`);
    const r = evaluateFile(f);
    assert.equal(r.exitCode, 0);
    assert.ok(r.output.summary);
    assert.equal(r.output.summary.totalRows, 1);
    fs.unlinkSync(f);
  });

  it('pure_astra 行 backend 非 none → 非零退出，错误带行号与原因', () => {
    const f = tmp(`${ROW({ taskId: 'a' })}\n${ROW({ taskId: 'b', backend: 'claude' })}\n`);
    const r = evaluateFile(f);
    assert.equal(r.exitCode, 1);
    assert.match(r.output.detail[0], /^2: /); // 行号前缀（validateRow 用 `行号: 原因`）
    assert.match(r.output.detail[0], /mode=pure_astra 的 backend 必须为 'none'/);
    fs.unlinkSync(f);
  });

  it('空输入/全空行 → 非零退出并明示', () => {
    const f = tmp('\n\n');
    const r = evaluateFile(f);
    assert.equal(r.exitCode, 1);
    assert.match(r.output.error, /没有有效数据行/);
    fs.unlinkSync(f);
  });

  it('不存在的文件 → 非零退出含 I/O 错误', () => {
    const r = evaluateFile(path.join(__dirname, 'no-such-file-anywhere.jsonl'));
    assert.equal(r.exitCode, 1);
    assert.match(r.output.error, /无法读取文件/);
  });
});
