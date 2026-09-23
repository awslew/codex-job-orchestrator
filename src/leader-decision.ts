// RETIRED 2026-09-07: standalone historical parser only; not called by the
// supervisor or scheduler. Receipt text cannot change a running job status.
// 困难上交回执（leader-decision receipt）解析 —— 纯函数模块，无 I/O。
//
// 冻结协议（领导 2026-09-07 定稿）：员工最终回执采用唯一标记
// `LEADER_DECISION_REQUIRED_JSON:` 后接单行 JSON 对象。对象只接受
// schemaVersion: 1，并要求非空字符串 reason/evidence/decisionNeeded
// （每字段 ≤ MAX_FIELD_CHARS）。只解释本 job 的最终 worker 输出/最终报告；
// 标记嵌在代码块（``` fenced / ~~~）或引述（以 > 开头）中的文本不得认作
// 实际上交回执。字段永不当作命令执行。多个真实标记 = 协议错误。
// 解析失败的分级结果见 LeaderDecisionScan 的 kind；本模块只分类，
// 状态降级与持久化由 supervisor 决定。

export const LEADER_DECISION_MARKER = 'LEADER_DECISION_REQUIRED_JSON:';
export const LEADER_DECISION_SCHEMA_VERSION = 1;
/** 每字段合理长度上限（冻结接口：~2000 字符）。 */
export const LEADER_DECISION_MAX_FIELD_CHARS = 2000;

export interface LeaderDecisionRecord {
  schemaVersion: 1;
  reason: string;
  evidence: string;
  decisionNeeded: string;
}

export type LeaderDecisionScan =
  | { kind: 'ok'; record: LeaderDecisionRecord; markerCount: number }
  | { kind: 'no_marker' }
  | { kind: 'invalid_json' }
  | { kind: 'wrong_schema' }
  | { kind: 'empty_field' }
  | { kind: 'overlong_field'; field: string; length: number }
  | { kind: 'duplicate_marker' };

// ---------------------------------------------------------------------------
// 文本区域分类：只扫描"正文"行。成对围栏（``` 或 ~~~）之内的所有行、
// 以及块引述行（以 '>' 开头）全部跳过 —— 它们可能是代码示例/文档引文，
// 不是实际上交回执。
// ---------------------------------------------------------------------------
type Region = 'body' | 'fence';

function scanLineRegions(text: string): Array<{ body: string; fence: boolean }> {
  const out: Array<{ body: string; fence: boolean }> = [];
  const lines = text.split('\n');
  let fenceMarker: string | null = null; // '```' 或 '~~~'
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const fenceMatch = /^\s*(```+|~~~+)\s*$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] === '`' ? '`' : '~';
      if (fenceMarker === null) {
        fenceMarker = marker; // 进入围栏
        continue;
      }
      fenceMarker = null; // 围栏闭合
      continue;
    }
    if (fenceMarker !== null) {
      out.push({ body: '', fence: true });
      continue;
    }
    // 非围栏行：块引述与围栏同等跳过（引述内嵌代码也可能含示例标记）
    if (/^\s*>\s?/.test(line)) {
      out.push({ body: '', fence: true });
      continue;
    }
    out.push({ body: line, fence: false });
  }
  return out;
}

// 行内、首个标记之后的额外真实标记数。回执 JSON 的字段值（如 evidence 里的
// 文件路径/说明）可以合法包含标记文本 —— 那只是数据，不是第二个回执；只有
// JSON 字符串字面量之外的再次出现（同行第二条回执）才算重复。用 indexOf +
// 字符游标而非正则 exec，避免替换串语义歧义。
function extraRealMarkers(body: string, from: number): number {
  const markerLen = LEADER_DECISION_MARKER.length;
  let n = 0;
  let inString = false;
  let i = from;
  while (i < body.length) {
    const ch = body[i];
    if (inString) {
      if (ch === '\\') {
        i++; // 跳过被转义字符
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (body.startsWith(LEADER_DECISION_MARKER, i)) {
      n++;
      i += markerLen - 1;
    }
    i++;
  }
  return n;
}

// 统计所有正文行的真实标记：每行首个出现视为回执锚点（标记是保留令牌，
// 出现在最终文本即算回执尝试）；锚点之后字符串字面量外的再次出现才是重复。
function scanRegions(
  regions: Array<{ body: string; fence: boolean }>,
): { count: number; lineIndex: number; at: number } {
  let count = 0;
  let lineIndex = -1;
  let at = -1;
  for (let i = 0; i < regions.length; i++) {
    if (regions[i].fence) continue;
    const body = regions[i].body;
    const first = body.indexOf(LEADER_DECISION_MARKER);
    if (first < 0) continue;
    if (count === 0) {
      lineIndex = i;
      at = first;
    }
    count += 1 + extraRealMarkers(body, first + LEADER_DECISION_MARKER.length);
  }
  return { count, lineIndex, at };
}

/**
 * 解析单段最终 worker 输出。只接受正文行中的单行 JSON：
 *   - 恰好一个真实标记，且其后在本行内存在 JSON（其余同行文本忽略）；
 *   - schemaVersion===1；reason/evidence/decisionNeeded 为非空字符串
 *     （trim 后），各 ≤ MAX_FIELD_CHARS；
 *   - 多个真实标记（跨行或同行多次出现）→ duplicate_marker；
 *   - 标记出现但 JSON 非法/字段不合规 → 对应的明确协议错误 kind，
 *     绝不返回 ok。
 */
export function scanLeaderDecision(text: string): LeaderDecisionScan {
  if (typeof text !== 'string' || text.length === 0) return { kind: 'no_marker' };
  const regions = scanLineRegions(text);
  const scan = scanRegions(regions);
  if (scan.count === 0) return { kind: 'no_marker' };
  if (scan.count > 1) return { kind: 'duplicate_marker' };

  // 单标记：JSON 是标记后同行剩余内容。严格按"单行 JSON 对象"解释 ——
  // 整个剩余内容必须恰好是一个可解析的 JSON（不做首 '}' 截断：字段值里
  // 可能合法包含 '}'，截断会误伤）；剩余为空或尾部带非 JSON 杂文本一律
  // invalid_json（显式协议错误，原最终报告保留，绝不静默成功）。
  const line = regions[scan.lineIndex].body;
  const markerAt = scan.at;
  const jsonCandidate = line.slice(markerAt + LEADER_DECISION_MARKER.length).trim();
  if (jsonCandidate.length === 0) return { kind: 'invalid_json' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonCandidate);
  } catch {
    return { kind: 'invalid_json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'wrong_schema' };
  const o = parsed as Record<string, unknown>;
  if (o.schemaVersion !== LEADER_DECISION_SCHEMA_VERSION) return { kind: 'wrong_schema' };
  for (const field of ['reason', 'evidence', 'decisionNeeded'] as const) {
    const v = o[field];
    if (typeof v !== 'string' || v.trim().length === 0) return { kind: 'empty_field' };
    if (v.length > LEADER_DECISION_MAX_FIELD_CHARS) {
      return { kind: 'overlong_field', field, length: v.length };
    }
  }
  return {
    kind: 'ok',
    markerCount: 1,
    record: {
      schemaVersion: LEADER_DECISION_SCHEMA_VERSION,
      reason: (o.reason as string).trim(),
      evidence: (o.evidence as string).trim(),
      decisionNeeded: (o.decisionNeeded as string).trim(),
    },
  };
}

/** 结构化协议错误命名（供 substatus/失败原因复用，无 I/O、无执行）。 */
export function leaderDecisionProtocolErrorKind(scan: LeaderDecisionScan): string {
  switch (scan.kind) {
    case 'ok':
    case 'no_marker':
      return '';
    case 'invalid_json':
      return 'leader_decision_invalid_json';
    case 'wrong_schema':
      return 'leader_decision_wrong_schema';
    case 'empty_field':
      return 'leader_decision_empty_field';
    case 'overlong_field':
      return `leader_decision_overlong_${scan.field}`;
    case 'duplicate_marker':
      return 'leader_decision_duplicate_marker';
  }
}
