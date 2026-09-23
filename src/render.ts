// Readable rendering shared by the live viewer and the `claude_code_status`
// progress tail. Converts parsed stream-json events into short human-readable
// lines and reads the tail of a job's stdout (events) + stderr (meta banners /
// errors) logs, merged so the "why it ended" info (===== exit / timeout /
// cancelled =====) is visible alongside the assistant's own output.
import fs from 'node:fs';
import { logFilePath, stderrLogFilePath } from './job-store.js';
import { parseLine, type ParsedEvent, type ToolUse } from './parser.js';

export function renderEvent(ev: ParsedEvent): string | null {
  switch (ev.type) {
    case 'assistant':
      // Tool uses are rendered separately (see renderToolUse) so they survive
      // even when the event carries no text block.
      return ev.text ? ev.text : null;
    case 'result':
      return `──── 结果 ────\n${ev.result}`;
    case 'userPrompt':
      return '🚨 需要审批：权限请求（用 claude_code_reply 注入答复）';
    case 'raw':
      return ev.raw;
    default:
      return null;
  }
}

export function renderToolUse(t: ToolUse): string {
  return `⚙ ${t.name}${t.input ? ` ${t.input}` : ''}`;
}

// Read the last `maxBytes` bytes of an append-only log, aligned to a line
// start. Returns '' when the file does not exist or is empty. Exported so the
// supervisor's failure-detail extraction can tail the stdout log without a
// full-file read.
export function readTailBytes(file: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return '';
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // If we started mid-line, drop the first (partial) line.
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function lastLines(text: string, n: number): string[] {
  const lines = text.split('\n');
  // Drop a single trailing empty element from a file ending in '\n'.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  // n <= 0 must mean "no lines": JS slice(-0) === slice(0) would otherwise
  // return the WHOLE array, leaking the entire stderr tail when a caller asks
  // for zero stderr/meta lines.
  if (n <= 0) return [];
  return lines.slice(-n);
}

export interface TailOptions {
  lines?: number; // rendered stdout lines to include
  stderrLines?: number; // raw stderr/meta lines to include
  maxChars?: number; // hard cap on the returned text
}

export function renderedTail(jobId: string, opts: TailOptions = {}): string {
  const lines = opts.lines ?? 3;
  const stderrLines = opts.stderrLines ?? 2;
  const maxChars = opts.maxChars ?? 1200;
  const out: string[] = [];

  // stdout: walk backward from the tail, collecting up to `lines` rendered
  // lines (progress/system events render to nothing and are skipped).
  const tail = readTailBytes(logFilePath(jobId), 200_000);
  let picked = 0;
  for (const line of lastLines(tail, 1000).reverse()) {
    if (picked >= lines) break;
    const ev = parseLine(line);
    if (ev.type === 'assistant') {
      if (ev.text) {
        out.push(ev.text);
        picked++;
      }
      for (const tu of ev.toolUses) {
        out.push(renderToolUse(tu));
        picked++;
      }
    } else {
      const r = renderEvent(ev);
      if (r) {
        out.push(r);
        picked++;
      }
    }
  }
  out.reverse();

  // stderr: last `stderrLines` raw lines, marked [meta] / [stderr].
  const errTail = readTailBytes(stderrLogFilePath(jobId), 50_000);
  for (const l of lastLines(errTail, stderrLines)) {
    const t = l.trim();
    out.push(t.startsWith('=====') ? `[meta] ${l}` : `[stderr] ${l}`);
  }

  const joined = out.join('\n');
  return joined.length > maxChars ? `… ${joined.slice(-maxChars)}` : joined;
}
