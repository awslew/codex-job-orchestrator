// Incremental line-buffer streaming parser for Claude CLI `--output-format
// stream-json` output. The supervisor, the rendered status tail and the live
// viewer all share this ONE implementation so no second, lossy parser is ever
// introduced (the old inline parser in the supervisor split chunks and
// silently dropped events cut across chunk boundaries).
//
// A single JSON event can be split across arbitrary chunk boundaries, so the
// parser buffers the trailing partial line until a newline arrives. A line
// that is not parseable JSON is surfaced as `raw` rather than discarded, so
// nothing is ever lost.
import path from 'node:path';
import crypto from 'node:crypto';

export type ParsedEvent =
  | { type: 'raw'; raw: string }
  | { type: 'result'; raw: string; result: string }
  | { type: 'assistant'; raw: string; text?: string; toolUses: ToolUse[] }
  | { type: 'userPrompt'; raw: string; permission?: PermissionInfo }
  | { type: 'other'; raw: string; eventType: string };

export interface ToolUse {
  name: string;
  input: string; // string form, truncated for display
}

// ---------------------------------------------------------------------------
// Permission attention (Stage 1 observability).
//
// Upstream `userPrompt` events carry a permission question, and newer builds
// emit the same request as a structured `control_request` / `permission_request`
// event. All three are recognized as genuine permission signals. We extract a
// small, sanitized, structured summary (tool / action / path / risk / requestId)
// so a leader can see WHAT needs approval without ever receiving the raw prompt,
// log text, tokens, or full absolute paths. This is observability ONLY: nothing
// here approves, denies, or alters the upstream auto decision.
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';
export type AttentionRequestIdSource = 'upstream' | 'local';

/** Raw fields a `userPrompt` event may carry (never surfaced directly). */
export interface PermissionInfo {
  /** Upstream request id, when the event provides one. */
  id?: string;
  /** The raw permission-question text. Used only for extraction, never output. */
  prompt?: string;
  /** Optional structured bag (e.g. `{ permissionMode }`); read defensively. */
  data?: unknown;
}

/** Sanitized, leader-safe attention summary. Every field is bounded/sanitized. */
export interface AttentionSummary {
  /** Stable correlation id: upstream id when present, else a local `local-<uuid>`. */
  requestId: string;
  /** Marks whether requestId came from upstream or was generated locally. */
  requestIdSource: AttentionRequestIdSource;
  /** Whitelisted tool name, or 'unknown'. */
  tool: string;
  /** Whitelisted action verb, or 'unknown'. */
  action: string;
  /** Sanitized minimal path (work-folder-relative, else basename), or null. */
  path: string | null;
  /** Conservative risk: low | medium | high | unknown. Never lowered. */
  risk: RiskLevel;
  /** ISO timestamp of when the attention was recorded. */
  at: string;
  /** One-line, bounded, sanitized human hint (never the raw prompt). */
  message: string;
}

/**
 * Persisted snapshot of an attention summary: the same sanitized fields as
 * AttentionSummary MINUS the human message. Snapshots are what get persisted in
 * an attention response audit, so a stored record can never smuggle prompt/raw
 * text; the message stays a render-time-only artifact.
 */
export interface AttentionSnapshot {
  /** Stable correlation id: upstream id when present, else a local `local-<uuid>`. */
  requestId: string;
  /** Marks whether requestId came from upstream or was generated locally. */
  requestIdSource: AttentionRequestIdSource;
  /** Whitelisted tool name, or 'unknown'. */
  tool: string;
  /** Whitelisted action verb, or 'unknown'. */
  action: string;
  /** Sanitized minimal path (work-folder-relative, else basename), or null. */
  path: string | null;
  /** Conservative risk: low | medium | high | unknown. Never lowered. */
  risk: RiskLevel;
  /** ISO timestamp of when the attention was recorded. */
  at: string;
}

/**
 * Explicit field-by-field projection from a summary to its persisted snapshot.
 * Constructed explicitly (never `{ ...summary }`) so a snapshot can never
 * accidentally inherit the message or a future raw field.
 */
export function toAttentionSnapshot(summary: AttentionSummary): AttentionSnapshot {
  return {
    requestId: summary.requestId,
    requestIdSource: summary.requestIdSource,
    tool: summary.tool,
    action: summary.action,
    path: summary.path,
    risk: summary.risk,
    at: summary.at,
  };
}

// Truncate tool inputs for human-readable rendering.
export const TOOL_INPUT_MAX = 120;

export class LineParser {
  private buf = '';

  // Returns the complete lines terminated by '\n' in this chunk. The trailing
  // partial line (no newline yet) is buffered until the next feed or flush().
  feed(chunk: string): string[] {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    return lines;
  }

  // Returns any remaining partial line and clears the buffer.
  flush(): string[] {
    if (!this.buf) return [];
    const lines = [this.buf];
    this.buf = '';
    return lines;
  }
}

export function parseLine(line: string): ParsedEvent {
  const trimmed = line.trim();
  const raw = line;
  if (!trimmed.startsWith('{')) {
    return { type: 'raw', raw };
  }
  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    return { type: 'raw', raw };
  }
  if (!o || typeof o !== 'object' || typeof (o as { type?: unknown }).type !== 'string') {
    return { type: 'raw', raw };
  }
  const eventType = (o as { type: string }).type;
  switch (eventType) {
    case 'result': {
      const result = (o as { result?: unknown }).result;
      if (typeof result === 'string') return { type: 'result', raw, result };
      return { type: 'other', raw, eventType };
    }
    case 'assistant': {
      const content = (o as { message?: { content?: unknown } }).message?.content;
      const texts: string[] = [];
      const toolUses: Array<{ name: string; input: string }> = [];
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || typeof c !== 'object') continue;
          const block = c as { type?: unknown; text?: unknown; name?: unknown; input?: unknown };
          if (block.type === 'text' && typeof block.text === 'string') {
            texts.push(block.text);
          } else if (block.type === 'tool_use' && typeof block.name === 'string') {
            toolUses.push({ name: block.name, input: toolInput(block.input) });
          }
        }
      }
      return {
        type: 'assistant',
        raw,
        text: texts.length ? texts.join('\n') : undefined,
        toolUses,
      };
    }
    case 'userPrompt':
      return { type: 'userPrompt', raw, permission: parsePermissionPayload(o) };
    case 'control_request':
    case 'permission_request':
      return { type: 'userPrompt', raw, permission: parseStructuredPermissionPayload(o) };
    default:
      return { type: 'other', raw, eventType };
  }
}

function toolInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  let s = '';
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = '';
  }
  return s.length > TOOL_INPUT_MAX ? `${s.slice(0, TOOL_INPUT_MAX)}…` : s;
}

// ---------------------------------------------------------------------------
// Permission attention extraction + sanitization.
// ---------------------------------------------------------------------------

const TOOL_WHITELIST = new Set([
  'Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'Agent',
  'Task', 'WebFetch', 'WebSearch', 'Skill', 'View', 'TodoWrite',
  'AskUserQuestion', 'List', 'MultiEdit', 'SendMessage',
]);

const ACTION_WHITELIST = new Set([
  'read', 'write', 'edit', 'delete', 'remove', 'create', 'run', 'execute',
  'list', 'search', 'browse', 'install', 'modify', 'overwrite', 'append',
  'rename', 'move', 'copy', 'send', 'spawn', 'view', 'approve', 'deny',
  'grant', 'revoke', 'cancel', 'download', 'upload',
]);

// Fallback action when a tool name is known but no verb is found in the text.
const TOOL_ACTION_DEFAULTS: Record<string, string> = {
  Bash: 'run', Read: 'read', Edit: 'write', Write: 'write',
  NotebookEdit: 'write', MultiEdit: 'write', Glob: 'search', Grep: 'search',
  WebFetch: 'read', WebSearch: 'search', List: 'list', View: 'read',
  Agent: 'spawn', Task: 'spawn', TodoWrite: 'write', SendMessage: 'send',
  Skill: 'run',
};

const MAX_ID = 80;
const MAX_PATH = 240;
const MAX_REL_PATH = 160;
const MAX_MESSAGE = 200;

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function firstString(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function matchToolName(s: string): string | undefined {
  for (const t of TOOL_WHITELIST) if (t.toLowerCase() === s.toLowerCase()) return t;
  return undefined;
}

// Longest names first so the alternation picks the full name (NotebookEdit over
// Edit, TodoWrite over Write). The look-around excludes tool names that are
// part of a path token (e.g. `\agent\` in a Windows path must not match Agent).
const TOOL_NAME_RE =
  /(?<![\\/\w.-])(?:NotebookEdit|TodoWrite|AskUserQuestion|MultiEdit|SendMessage|WebFetch|WebSearch|Bash|Write|Read|Edit|Glob|Grep|Agent|Task|Skill|View|List)(?![\\/\w-])/i;

function extractTool(permission: PermissionInfo): string {
  const data = asRecord(permission.data);
  const fromData = firstString(data, ['tool', 'toolName', 'name']);
  if (fromData) {
    const hit = matchToolName(fromData);
    if (hit) return hit;
  }
  const prompt = permission.prompt ?? '';
  // "Claude needs your permission to use Bash."
  const use = prompt.match(/needs?\s+(?:your\s+)?permission\s+to\s+use\s+([A-Za-z][A-Za-z0-9]*)/i);
  if (use) {
    const hit = matchToolName(use[1]);
    if (hit) return hit;
  }
  const bare = prompt.match(TOOL_NAME_RE);
  if (bare) return bare[0];
  return 'unknown';
}

const ACTION_VERB_RE: Array<[RegExp, string]> = [
  [/\bdelete\b/i, 'delete'],
  [/\bremove\b/i, 'remove'],
  [/\brm\b/i, 'delete'],
  [/\boverwrite\b/i, 'overwrite'],
  [/\bappend\b/i, 'append'],
  [/\brename\b/i, 'rename'],
  [/\bcreate\b/i, 'create'],
  [/\binstall\b/i, 'install'],
  [/\bdownload\b/i, 'download'],
  [/\bupload\b/i, 'upload'],
  [/\bsend\b/i, 'send'],
  [/\bsearch\b/i, 'search'],
  [/\bexecute\b/i, 'execute'],
  [/\bedit\b/i, 'edit'],
  [/\bwrite\b/i, 'write'],
  [/\bread\b/i, 'read'],
  [/\brun\b/i, 'run'],
  [/\bspawn\b/i, 'spawn'],
  [/\bview\b/i, 'view'],
  [/\blist\b/i, 'list'],
];

function matchActionVerb(text: string): string | undefined {
  for (const [re, action] of ACTION_VERB_RE) if (re.test(text)) return action;
  return undefined;
}

function extractAction(permission: PermissionInfo, tool: string): string {
  const data = asRecord(permission.data);
  const fromData = firstString(data, ['action', 'operation']);
  if (fromData) {
    const a = fromData.toLowerCase();
    if (ACTION_WHITELIST.has(a)) return a;
  }
  const prompt = permission.prompt ?? '';
  const labeled = prompt.match(/(?:action|operation)\s*[:：]\s*([A-Za-z][A-Za-z0-9_-]*)/i);
  if (labeled) {
    const a = labeled[1].toLowerCase();
    if (ACTION_WHITELIST.has(a)) return a;
  }
  const verb = matchActionVerb(prompt);
  if (verb) return verb;
  return TOOL_ACTION_DEFAULTS[tool] ?? 'unknown';
}

function isPathToken(tok: string): boolean {
  if (tok.length < 2) return false;
  if (/^[A-Za-z]:[\\/]/.test(tok)) return true;
  if (tok.startsWith('/') || tok.startsWith('~')) return true;
  return /\.[A-Za-z0-9]{1,5}$/.test(tok);
}

function extractPath(permission: PermissionInfo, workFolder?: string): string | null {
  const candidates: string[] = [];
  const data = asRecord(permission.data);
  const fromData = firstString(data, ['path', 'filePath', 'file_path', 'target']);
  if (fromData) candidates.push(fromData);
  const prompt = permission.prompt ?? '';
  const labeled = prompt.match(/(?:path|file)\s*[:：]\s*([^\s"'`，。;]+)/i);
  if (labeled) candidates.push(labeled[1]);
  const cmd = prompt.match(/(?:command|cmd)\s*[:：]\s*(.+)/i);
  if (cmd) {
    for (const tok of cmd[1].split(/\s+/)) if (isPathToken(tok)) candidates.push(tok);
  }
  const generic = prompt.match(/(?:[A-Za-z]:[\\/][^\s"'`，。;]+|\/(?:[\w.-]+\/)+[\w.-]+|~\/[\w./-]+)/g);
  if (generic) candidates.push(...generic);
  for (const c of candidates) {
    const s = sanitizePath(c, workFolder);
    if (s) return s;
  }
  return null;
}

// Basename that understands both separators (Windows `\` and POSIX `/`) so an
// absolute path never leaks its prefix even when the platform path helpers
// disagree with the path's own syntax.
function safeBasename(p: string): string {
  const norm = p.replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('/'), norm.lastIndexOf('\\'));
  const base = i >= 0 ? norm.slice(i + 1) : norm;
  if (!base || base === '.' || /^[A-Za-z]:$/.test(base)) return '';
  return base;
}

// Never leak a full absolute path. Inside the work folder we return the minimal
// work-folder-relative path; everywhere else (outside it, or when workFolder is
// missing/invalid) we return only the basename — home/用户目录 prefixes must
// never appear. Relative tokens are already minimal and are kept as-is.
function sanitizePath(raw: string, workFolder?: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  p = p.replace(/^["'`([{]+/, '').replace(/["'`)\]}]+$/, '');
  p = p.replace(/[.,;，。]+$/, '');
  if (!p) return null;
  p = clamp(p, MAX_PATH);

  const absolute = path.isAbsolute(p) || p.startsWith('/') || p.startsWith('~');

  if (workFolder && absolute && !p.startsWith('~')) {
    try {
      const abs = path.resolve(p);
      const rel = path.relative(path.resolve(workFolder), abs);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return clamp(rel, MAX_REL_PATH);
      const base = path.basename(abs);
      if (base && base !== '.' && base !== path.sep) return clamp(base, MAX_REL_PATH);
      return null;
    } catch {
      /* fall through to the absolute-prefix guard below */
    }
  }
  // Absolute paths must NEVER be returned in full when we cannot prove they are
  // inside the work folder: leak only the last segment.
  if (absolute) {
    const base = safeBasename(p);
    return base ? clamp(base, MAX_REL_PATH) : null;
  }
  // A relative token is already minimal (e.g. "probe.txt").
  return clamp(p, MAX_REL_PATH);
}

function classifyRisk(tool: string, action: string, prompt: string): RiskLevel {
  const text = `${tool} ${action} ${prompt ?? ''}`.toLowerCase();
  const high =
    /(\bdelete\b|\bremove\b|\brm\b|\boverwrite\b|\bchmod\b|\bchown\b|\bkill\b|\bpush\b|\bpublish\b|\bdeploy\b|\binstall\b|\bsudo\b|\bcurl\b|\bwget\b|\bformat\b|\bwipe\b|\btruncate\b|\bgrant\b|\brevoke\b|\breset\s*--\s*hard|high-?risk|dangerous|critical|sensitive)/.test(
      text,
    );
  if (high) return 'high';
  if (tool === 'Bash' || tool === 'Agent' || tool === 'Task') return 'medium';
  if (
    tool === 'Write' || tool === 'Edit' || tool === 'NotebookEdit' ||
    tool === 'MultiEdit' || tool === 'TodoWrite' || tool === 'SendMessage'
  ) {
    return 'medium';
  }
  if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'List', 'View', 'Skill'].includes(tool)) return 'low';
  return tool === 'unknown' ? 'unknown' : 'medium';
}

function buildMessage(tool: string, action: string, sanitizedPath: string | null): string {
  if (tool === 'unknown' && action === 'unknown' && !sanitizedPath) {
    return '需要审批：权限请求（详情无法解析，已安全降级）';
  }
  const parts: string[] = [tool === 'unknown' ? '未知工具' : tool];
  if (action !== 'unknown') parts.push(action);
  if (sanitizedPath) parts.push(sanitizedPath);
  return clamp(`需要审批：${parts.join(' ')}`, MAX_MESSAGE);
}

function newLocalRequestId(): string {
  return `local-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Structured permission/control events (control_request / permission_request).
//
// Newer upstream builds send approval/control requests as structured events,
// e.g. `{ type: 'control_request', requestId, request: { permission: { tool,
// input, ... } } }` or a `permission_request` carrying a nested `toolUse`. We
// descend ONLY through known wrapper keys (request, permission, tool,
// toolUse/tool_use, input, details, data, payload) and lift ONLY conservative
// known scalars (requestId, tool/toolName, action/operation, path/filePath,
// target, and a tool-use `name`). Arbitrary payloads are never serialized, and
// prompt/token/command/env/key content never enters the parsed representation.
// ---------------------------------------------------------------------------

const STRUCTURED_WRAPPER_KEYS = [
  'request', 'permission', 'tool', 'toolUse', 'tool_use', 'input', 'details', 'data', 'payload',
];
const STRUCTURED_TOOL_KEYS = ['tool', 'toolName'];
const STRUCTURED_ACTION_KEYS = ['action', 'operation'];
const STRUCTURED_PATH_KEYS = ['path', 'filePath', 'file_path', 'target'];

interface StructuredFields {
  requestId?: string;
  tool?: string;
  action?: string;
  path?: string;
}

function collectStructuredFields(root: Record<string, unknown>): StructuredFields {
  const out: StructuredFields = {};
  const seen = new Set<object>();
  const stack: Array<{ node: unknown; nameAuthoritative: boolean }> = [
    { node: root, nameAuthoritative: false },
  ];
  while (stack.length) {
    const { node, nameAuthoritative } = stack.pop()!;
    if (!node || typeof node !== 'object') continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const cur = node as Record<string, unknown>;
    // requestId is only ever the literal `requestId` key (tool-use `id`s are
    // never request ids). Top-level is processed first, so the outermost id wins.
    if (!out.requestId && typeof cur.requestId === 'string' && cur.requestId.trim()) {
      out.requestId = cur.requestId.trim();
    }
    // `name` is authoritative only inside a tool/toolUse/tool_use record.
    if (out.tool === undefined) {
      const t = firstString(
        cur,
        nameAuthoritative ? ['name', ...STRUCTURED_TOOL_KEYS] : STRUCTURED_TOOL_KEYS,
      );
      if (t) out.tool = t;
    }
    if (out.action === undefined) out.action = firstString(cur, STRUCTURED_ACTION_KEYS);
    if (out.path === undefined) out.path = firstString(cur, STRUCTURED_PATH_KEYS);
    for (const k of STRUCTURED_WRAPPER_KEYS) {
      const v = cur[k];
      if (!v || typeof v !== 'object') continue;
      const nextAuthoritative = k === 'tool' || k === 'toolUse' || k === 'tool_use';
      if (Array.isArray(v)) {
        for (const item of v) stack.push({ node: item, nameAuthoritative: nextAuthoritative });
      } else {
        stack.push({ node: v, nameAuthoritative: nextAuthoritative });
      }
    }
  }
  return out;
}

// Parse a genuine structured permission/control event into the SAME sanitized
// PermissionInfo bag a `userPrompt` event produces. The upstream requestId is
// preserved verbatim when present (distinct upstream requestIds stay distinct);
// with none, the caller's existing local-id generation still applies. Ordinary
// text banners never reach this path — they parse as `raw`, not as a structured
// request.
function parseStructuredPermissionPayload(o: unknown): PermissionInfo {
  const fields = collectStructuredFields(asRecord(o));
  const data: Record<string, unknown> = {};
  if (fields.tool !== undefined) data.tool = fields.tool;
  if (fields.action !== undefined) data.action = fields.action;
  if (fields.path !== undefined) data.path = fields.path;
  return { id: fields.requestId, data };
}

export function parsePermissionPayload(o: unknown): PermissionInfo {
  const rec = asRecord(o);
  const id = typeof rec.id === 'string' && rec.id.trim() ? rec.id.trim() : undefined;
  const prompt = typeof rec.prompt === 'string' && rec.prompt.trim() ? rec.prompt.trim() : undefined;
  return { id, prompt, data: rec.data };
}

// Build a sanitized, bounded attention summary from a parsed userPrompt event.
// Unparseable / absent events degrade to the safe generic summary below; we
// NEVER fall back to the raw payload.
export function sanitizePermission(
  permission: PermissionInfo | undefined,
  opts: { workFolder?: string; at: string },
): AttentionSummary {
  const p = permission ?? {};
  const id = typeof p.id === 'string' && p.id.trim() ? clamp(p.id.trim(), MAX_ID) : undefined;
  const prompt = typeof p.prompt === 'string' && p.prompt.trim() ? p.prompt.trim() : '';
  const tool = extractTool(p);
  const action = extractAction(p, tool);
  const sanitizedPath = extractPath(p, opts.workFolder);
  return {
    requestId: id ?? newLocalRequestId(),
    requestIdSource: id ? 'upstream' : 'local',
    tool,
    action,
    path: sanitizedPath,
    risk: classifyRisk(tool, action, prompt),
    at: opts.at,
    message: buildMessage(tool, action, sanitizedPath),
  };
}

// Safe generic summary for a permission signal we could not parse into a
// structured tool/action (e.g. the stderr permission banner or a split chunk).
export function genericAttentionSummary(opts: { at: string }): AttentionSummary {
  return {
    requestId: newLocalRequestId(),
    requestIdSource: 'local',
    tool: 'unknown',
    action: 'unknown',
    path: null,
    risk: 'unknown',
    at: opts.at,
    message: '需要审批：权限请求（详情无法解析，已安全降级）',
  };
}
