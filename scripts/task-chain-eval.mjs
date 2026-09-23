#!/usr/bin/env node
// task-chain-eval.mjs — 任务链优化的离线评估记录/汇总工具（Task B 交付物）。
//
// 保留的手动离线工具；旧任务链计划已废止，本脚本不授权委派或自动采样。
//  - 只读用户**明确提供**的 JSONL 样本文件；不扫描全局日志/凭据、不访问网络、
//    不与生产 metrics/flags 耦合。
//  - 每条记录是 schemaVersion=1 的一个任务链样本；字段可空性遵循计划：
//    * codexUsage、externalCostUsd：缺省/null = **未知**（绝不当作 0 参与覆盖率）；
//    * 覆盖率 = 样本中该字段非 null 的比例。
//  - backend 表示执行员工：mode=pure_astra（纯 Astra、无员工）→ backend 必须为 'none'；
//    mode=mixed → backend ∈ claude/deepseek-harness/luna。纯 Astra 账不得归到不存在的员工。
//  - codexUsageUnit：记录者显式给出的非空单位字符串（如 tokens/credits/quota_percent），
//    脚本不锁定 tokens、不做单位转换。codexUsage 仅在 全部样本使用同一明确单位 且
//    attribution=isolated 时输出聚合/比较；否则该指标输出 n/a（口径不一致）与原因。
//    * tokens 是原始 token 量，不是跨模型套餐消耗；
//    * quota_percent 只有在无并发、同一计费窗口且分母不变时才由记录者标 isolated，
//      否则 codexUsage 记 null；未知单位/归因不算 0，仍计入覆盖率。
//  - 不输出任何配对因果"节省百分比"；仅输出描述性汇总。
//  - 退出码：0=输入合法且已处理；1=输入不合法（明示行号、原因）或发生 I/O 错误。
//  - 默认 stdout 只输出 JSON，不自动写文件。
//
// CLI：node scripts/task-chain-eval.mjs <显式样本.jsonl>

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const SCHEMA_VERSION = 1;
const FIELD_LIMITS = {
  taskId: 128,
  taskType: 64,
  backend: 32,
  mode: 16,
  codexUsageUnit: 32,
};
const BACKENDS = ['claude', 'deepseek-harness', 'luna']; // mode=mixed 时的可选员工
const PURE_ASTRA_BACKEND = 'none'; // mode=pure_astra 时：无员工
const MODES = ['pure_astra', 'mixed'];
const ATTRIBUTION_ISOLATED = 'isolated';
const EVAL_METRIC = 'codexUsage';

/**
 * 单行校验：返回 { ok, errors?: string[] }；不在行内做未知→0 的归零。
 */
export function validateRow(obj, line) {
  const errors = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return { ok: false, errors: [`${line}: 记录不是 JSON 对象`] };
  }
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`${line}: schemaVersion 必须为 ${SCHEMA_VERSION}，实际 ${JSON.stringify(obj.schemaVersion)}`);
  }
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const v = obj[field];
    if (v === undefined || v === null) continue; // null = 合法"未知"（仅部分字段允许，各行有专用校验兜底）
    if (typeof v !== 'string') {
      errors.push(`${line}: ${field} 必须是字符串`);
    } else if (v.length > max) {
      errors.push(`${line}: ${field} 超过长度上限 ${max}`);
    }
  }
  if (typeof obj.taskId !== 'string' || obj.taskId.length === 0) errors.push(`${line}: taskId 必须是非空字符串`);
  if (typeof obj.taskType !== 'string' || obj.taskType.length === 0) errors.push(`${line}: taskType 必须是非空字符串`);
  if (typeof obj.mode !== 'string' || !MODES.includes(obj.mode)) {
    errors.push(`${line}: mode 必须是 ${MODES.join('/')}，实际 ${JSON.stringify(obj.mode)}`);
  }
  if (typeof obj.backend !== 'string' || obj.backend.length === 0) {
    errors.push(`${line}: backend 必须是非空字符串`);
  } else if (obj.mode === 'pure_astra') {
    if (obj.backend !== PURE_ASTRA_BACKEND) {
      errors.push(`${line}: mode=pure_astra 的 backend 必须为 'none'（纯 Astra 无员工），实际 ${JSON.stringify(obj.backend)}`);
    }
  } else if (obj.mode === 'mixed') {
    if (!BACKENDS.includes(obj.backend)) {
      errors.push(`${line}: mode=mixed 的 backend 必须为 ${BACKENDS.join('/')}，实际 ${JSON.stringify(obj.backend)}`);
    }
  }
  if (typeof obj.accepted !== 'boolean') errors.push(`${line}: accepted 必须是布尔值`);
  if (typeof obj.elapsedSeconds !== 'number' || !Number.isFinite(obj.elapsedSeconds) || obj.elapsedSeconds < 0) {
    errors.push(`${line}: elapsedSeconds 必须是非负数`);
  }
  for (const f of ['repairCount', 'leaderInterventions']) {
    if (!Number.isInteger(obj[f]) || obj[f] < 0) errors.push(`${line}: ${f} 必须是非负整数`);
  }
  for (const f of [EVAL_METRIC, 'externalCostUsd']) {
    const v = obj[f];
    if (v !== null && v !== undefined) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) errors.push(`${line}: ${f} 必须是非负数或 null`);
    }
  }
  // 单位：显式时必须是非空字符串（任意明确单位都合法，脚本不做换算/锁定 tokens）；
  // 未知（缺省/null）= 合法"未知"，不归零。
  const u = obj.codexUsageUnit;
  if (u !== null && u !== undefined) {
    if (typeof u !== 'string' || u.length === 0) {
      errors.push(`${line}: codexUsageUnit 必须是非空字符串（如 tokens/credits/quota_percent）或 null`);
    } else if (u.length > FIELD_LIMITS.codexUsageUnit) {
      errors.push(`${line}: codexUsageUnit 超过长度上限 ${FIELD_LIMITS.codexUsageUnit}`);
    }
  }
  // 归因：只接受 'isolated' 或未知（null/undefined）。记录者无法保证单任务归因时标 null，
  // 不用"估计"等值冒充。
  if (obj.attribution !== null && obj.attribution !== undefined && obj.attribution !== ATTRIBUTION_ISOLATED) {
    errors.push(`${line}: attribution 只接受 '${ATTRIBUTION_ISOLATED}' 或 null（账户并发估计不得冒充单任务归因）`);
  }
  return errors.length === 0 ? { ok: true, errors: [] } : { ok: false, errors };
}

/**
 * 单行解析 + 校验；返回 { ok, record?, issue?, error? }
 * issue = 结构合法但不可归因（口径未知/非 isolated），不中断处理；
 * error = 语法/必填/类型错误（整条作废，输入非法 → 退出码 1）。
 */
export function parseRow(line, lineNo) {
  if (typeof line !== 'string' || line.trim() === '') return { ok: true, record: null };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { ok: false, record: null, error: `第 ${lineNo} 行不是合法 JSON` };
  }
  const v = validateRow(parsed, lineNo);
  if (!v.ok) return { ok: false, record: null, error: v.errors.join('；') };
  const record = { ...parsed };
  // 未知缺省统一为 null：未知不是 0，参与覆盖率分母但不进聚合数值
  for (const f of [EVAL_METRIC, 'externalCostUsd', 'codexUsageUnit', 'attribution']) {
    if (record[f] === undefined) record[f] = null;
  }
  const issues = [];
  const metricGiven = record[EVAL_METRIC] !== null;
  if (metricGiven) {
    if (record.codexUsageUnit === null) {
      issues.push(`第 ${lineNo} 行：codexUsage 有值但单位未知（缺省/null）→ 只计覆盖率，不进入聚合/比较`);
    }
    if (record.attribution !== ATTRIBUTION_ISOLATED) {
      issues.push(`第 ${lineNo} 行：codexUsage 有值但 attribution 非 '${ATTRIBUTION_ISOLATED}' → 只计覆盖率，不进入聚合/比较`);
    }
  }
  return { ok: true, record, issues };
}

function isAttributable(r) {
  return (
    r.codexUsage !== null &&
    typeof r.codexUsageUnit === 'string' &&
    r.codexUsageUnit.length > 0 &&
    r.attribution === ATTRIBUTION_ISOLATED
  );
}

function aggregate(rows) {
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.taskType}||${r.mode}`;
    if (!byKey.has(key)) byKey.set(key, { taskType: r.taskType, mode: r.mode, rows: [] });
    byKey.get(key).rows.push(r);
  }
  const result = { totalRows: rows.length, groups: [] };
  const metric = EVAL_METRIC;
  for (const g of byKey.values()) {
    const { rows: gr, taskType, mode } = g;
    const n = gr.length;
    const accepted = gr.filter((r) => r.accepted).length;
    const firstPass = gr.filter((r) => r.accepted && r.repairCount === 0).length;
    const metricCovered = gr.filter((r) => r[metric] !== null).length;
    const costCovered = gr.filter((r) => r.externalCostUsd !== null).length;
    const attrRows = gr.filter((r) => isAttributable(r));
    const units = new Set(attrRows.map((r) => r.codexUsageUnit));
    // 组内可比：全部样本可归因（显式同一单位 + isolated）且单位只有一种
    const groupComparable = n > 0 && attrRows.length === n && units.size === 1;
    const codexUsageTotal = groupComparable ? attrRows.reduce((s, r) => s + r[metric], 0) : null;
    const unit = groupComparable ? [...units][0] : null;
    const repairable = gr.reduce((s, r) => s + r.repairCount, 0);
    const interv = gr.reduce((s, r) => s + r.leaderInterventions, 0);
    result.groups.push({
      taskType,
      mode,
      samples: n,
      accepted,
      acceptanceRate: n === 0 ? null : accepted / n,
      firstPass,
      firstPassRate: n === 0 ? null : firstPass / n,
      totalRepairs: repairable,
      repairsPerSample: n === 0 ? null : repairable / n,
      totalLeaderInterventions: interv,
      interventionsPerSample: n === 0 ? null : interv / n,
      elapsedSecondsTotal: gr.reduce((s, r) => s + r.elapsedSeconds, 0),
      elapsedSecondsMean: n === 0 ? null : gr.reduce((s, r) => s + r.elapsedSeconds, 0) / n,
      [`${metric}Coverage`]: metricCovered,
      externalCostUsdCoverage: costCovered,
      [`${metric}Total`]: codexUsageTotal,
      [`${metric}Unit`]: unit,
      attribution: groupComparable ? ATTRIBUTION_ISOLATED : null,
      [`${metric}Comparable`]: groupComparable,
      externalCostUsdSum: costCovered === 0 ? null : gr.reduce((s, r) => s + r.externalCostUsd, 0),
    });
  }
  return result;
}

export function summarize(rows) {
  const clean = rows.filter((r) => r !== null && r !== undefined);
  const agg = aggregate(clean);
  const attrRows = clean.filter((r) => isAttributable(r));
  const units = new Set(attrRows.map((r) => r.codexUsageUnit));
  const globallyComparable = clean.length > 0 && attrRows.length === clean.length && units.size === 1;
  let message;
  if (globallyComparable) {
    message = `全部样本单位一致（${[...units][0]}）且 attribution=isolated → 可归因；总用量见 codexUsageTotal。`;
  } else if (attrRows.length === 0) {
    message = `codexUsage 无任何可归因样本（0/${clean.length}）：单位未知或 attribution 非 isolated 的样本不算 0、不参与聚合（覆盖率仍保留）。`;
  } else {
    message = `codexUsage 不满足全局聚合条件：可归因样本 ${attrRows.length}/${clean.length}、单位口径 ${units.size} 种（需全部显式同一单位且 attribution=isolated）；不生成汇总总量。`;
  }
  return {
    ...agg,
    analysis: {
      metricUnit: globallyComparable ? [...units][0] : null,
      attribution: globallyComparable ? ATTRIBUTION_ISOLATED : null,
      metricComparable: globallyComparable,
      message,
      firstPassNote:
        '首轮通过 = accepted && repairCount===0：描述性计数，不是盲测因果结论（无对照基线，不输出节省百分比）。',
      pairedSamplingNote:
        '节省率的可信评估需同起点/同验收对照采样；方法见 MIGRATION.md「同起点同验收采样」，未配对样本一律不输出节省率。',
      source: 'synthetic-explicit',
    },
  };
}

export function evaluateFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { exitCode: 1, output: { error: `无法读取文件 ${filePath}: ${err.message}` } };
  }
  const issues = [];
  const rows = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseRow(lines[i], i + 1);
    if (parsed.ok && parsed.record) {
      rows.push(parsed.record);
      if (parsed.issues && parsed.issues.length) issues.push(...parsed.issues);
    } else if (!parsed.ok) {
      errors.push(parsed.error);
    }
  }
  if (errors.length > 0) {
    return { exitCode: 1, output: { error: `输入不合法（${errors.length} 处）`, detail: errors } };
  }
  if (rows.length === 0) {
    return { exitCode: 1, output: { error: '输入中没有有效数据行' } };
  }
  const summary = summarize(rows);
  const output = { inputFile: filePath, summary, issues };
  return { exitCode: 0, output };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    process.stderr.write('用法: node scripts/task-chain-eval.mjs <显式样本.jsonl>\n');
    process.exit(2);
  }
  const { exitCode, output } = evaluateFile(argv[0]);
  if (exitCode !== 0) {
    // 输入错误（含行号）明示
    if (output.error) process.stderr.write(`错误: ${output.error}\n`);
    if (output.detail) output.detail.forEach((d) => process.stderr.write(`  - ${d}\n`));
    process.exit(1);
  }
  fs.writeSync(1, `${JSON.stringify(output, null, 2)}\n`);
}

// 仅当作为脚本直接运行（非被 import）时执行 CLI；用 pathToFileURL 保证 Windows 路径格式一致
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
