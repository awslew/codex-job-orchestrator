// Live, human-readable viewer for orchestrator jobs. Opened by the scheduler
// (cmd /c start) in its own console window when a job starts; follows the
// session chain so `reply` jobs on the same session stream into the same
// window.
//
// It tails the job's stdout log (stream-json events) and stderr log (meta
// banners / errors) by byte-offset polling while the job is active
// (queued/running/needs_attention). Once a job reaches a terminal status
// (succeeded/failed/cancelled) the final state + report are printed ONCE and
// the terminal policy decides what happens next:
//   - close:          the run loop returns immediately (window closes).
//   - persist_static: the viewer stops polling entirely and waits on an
//                     fs.watch of the jobs directory (event-driven, no
//                     setInterval/setTimeout). When an event shows a NEW job
//                     in the same session, the watch is closed and the active
//                     polling loop is resumed on the same window. Unrelated
//                     events re-arm the watch. A failed watch falls back to a
//                     fixed error message and stays static forever — it never
//                     degrades back to periodic polling.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  jobsDir,
  logFilePath,
  stderrLogFilePath,
  reportFilePath,
  readJob,
  listJobs,
  isTerminal,
  type Job,
  type JobStatus,
} from './job-store.js';
import { LineParser, parseLine } from './parser.js';
import { renderEvent, renderToolUse } from './render.js';

const POLL_ACTIVE_MS = 500;

// ORCHESTRATOR_VIEWER_TERMINAL_POLICY: 'close' | 'persist_static'.
// unset / '' / anything else => 'persist_static' (safe default: the final
// conclusion is never yanked away from a human reader).
export type ViewerTerminalPolicy = 'close' | 'persist_static';

export function parseTerminalPolicy(
  env: Record<string, string | undefined> = process.env,
): ViewerTerminalPolicy {
  return env.ORCHESTRATOR_VIEWER_TERMINAL_POLICY === 'close' ? 'close' : 'persist_static';
}

export interface TerminalSnapshot {
  status: JobStatus;
  substatus: string | null;
  runSec: number;
  reportExists: boolean;
  reportPath: string;
  reportPreview: string;
  reportTruncated: boolean;
}

// Pure: builds the one-time terminal print for a job. Report text is capped
// at REPORT_CAP chars; reportTruncated tells whether anything was cut.
export const REPORT_CAP = 3000;
export function buildTerminalSnapshot(job: Job, fsStat: (f: string) => { size: number } | null, fsRead: (f: string) => string): TerminalSnapshot {
  const endMs = job.endedAt ? new Date(job.endedAt).getTime() : Date.now();
  const runSec = Math.max(0, Math.round((endMs - new Date(job.startedAt).getTime()) / 1000));
  const reportPath = reportFilePath(job.jobId);
  const stat = fsStat(reportPath);
  let reportPreview = '';
  let reportTruncated = false;
  if (stat) {
    try {
      const text = fsRead(reportPath);
      reportPreview = text.slice(0, REPORT_CAP);
      reportTruncated = text.length > REPORT_CAP;
    } catch {
      // Unreadable report: the terminal state is still printed, preview omitted.
    }
  }
  return {
    status: job.status,
    substatus: job.substatus,
    runSec,
    reportExists: stat !== null,
    reportPath,
    reportPreview,
    reportTruncated,
  };
}

export function renderTerminalSnapshot(s: TerminalSnapshot, baseJob: Job): string {
  const status = `${s.status}${s.substatus ? ` (${s.substatus})` : ''}`;
  const lines: string[] = [];
  lines.push(`\n◉ 最终状态: ${status}  用时 ${s.runSec}s`);
  if (s.reportExists && s.reportPath) {
    lines.push(`报告: ${s.reportPath}`);
    lines.push(`──── 报告摘要 ────\n${s.reportPreview}${s.reportTruncated ? '\n… [已截断，完整见报告文件]' : ''}`);
  }
  void baseJob;
  lines.push('\n窗口保持打开以接收续跑；可手动关闭。');
  return lines.join('\n');
}

// Static watch result of the terminal persist phase.
export interface StaticWatchResult {
  /** Newest job in the SAME session observed after a watch event; null => keep waiting. */
  switchToJobId: string | null;
}

// Event-driven wait for a NEW same-session job (reply chain) after the
// current job reached a terminal state. Wrapped in a promise for tests; the
// production loop drives it through a raw fs.FSWatcher (see persistStatic).
export function buildStaticWatch(
  sessionId: string,
  watchFactory: (
    dir: string,
    listener: (eventType: string, filename: string | null) => void,
  ) => { close: () => void },
  listSessionJobs: (sessionId: string) => Job[],
): Promise<StaticWatchResult> {
  return new Promise<StaticWatchResult>((resolve) => {
    let done = false;
    const finish = (r: StaticWatchResult): void => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let w: { close: () => void };
    try {
      // Recursive is unavailable on Windows, so only the jobs dir itself is
      // watched — but jobs are added by atomicWriteJson (tmp file + rename),
      // which always fires a rename event in the directory.
      const watcher = watchFactory(jobsDir(), () => {
        if (done) return;
        // Any event (add/rename/change of any file) re-checks the session
        // chain; unrelated events simply re-arm the watch.
        const newest = listSessionJobs(sessionId)[0];
        if (newest) {
          // Close the watch BEFORE emitting the resolution: the pending
          // promise resolves synchronously, so consumers never race an
          // already-fired event against a still-open watcher.
          try {
            w.close();
          } catch {
            // Closing an already-finished watcher is a no-op on Windows.
          }
          finish({ switchToJobId: newest.jobId });
        }
      });
      w = watcher;
    } catch {
      // Watch setup failure: fixed error message, then the promise never
      // resolves — the viewer stays static without falling back to polling.
      console.error('viewer: 无法监听 jobs 目录（fs.watch 失败），保持静态显示；可手动关闭窗口。');
      return;
    }
  });
}

export interface ViewCounters {
  poll: number;
  logRead: number;
  stderrRead: number;
  jobRead: number;
  listCalls: number;
}

// One pass of the ACTIVE loop (queued/running/needs_attention): follow the
// session chain, drain both cursors, print any status change. Returns false
// once the current job reached a terminal state (the caller then switches on
// terminal policy). Counters are the test-observable probe for "no more
// polling/reading happens while static".
export function runActiveTick(
  state: {
    currentJobId: string;
    sessionId: string;
    out: { file: string; offset: number };
    err: { file: string; offset: number };
    parser: { feed(chunk: string): string[] };
    lastShownStatus: string | null;
    lastTerminalJobId: string | null;
  },
  deps: {
    list: (sessionId: string) => Job[];
    read: (jobId: string) => Job | null;
    poll: (c: { file: string; offset: number }) => string;
    log: (msg: string) => void;
    counters: ViewCounters;
  },
): { terminal: boolean } {
  const c = deps.counters;
  c.poll += 1;

  const chain = deps.list(state.sessionId);
  c.listCalls += 1;
  const newest = chain[0];
  if (newest && newest.jobId !== state.currentJobId) {
    state.currentJobId = newest.jobId;
    state.out = { file: logFilePath(newest.jobId), offset: 0 };
    state.err = { file: stderrLogFilePath(newest.jobId), offset: 0 };
    const job = deps.read(newest.jobId);
    c.jobRead += 1;
    deps.log(`\n────────── 续跑 job ${newest.jobId}（同会话）──────────`);
    if (job) printBanner(job);
  }

  const out = deps.poll(state.out);
  if (out) {
    c.logRead += 1;
    for (const line of state.parser.feed(out)) printEvent(parseLine(line));
  }
  const err = deps.poll(state.err);
  if (err) {
    c.stderrRead += 1;
    for (const line of err.split('\n')) printStderrLine(line);
  }

  const cur = deps.read(state.currentJobId);
  if (cur) {
    c.jobRead += 1;
    if (cur.status !== state.lastShownStatus) {
      state.lastShownStatus = cur.status;
      if (cur.status === 'needs_attention') {
        deps.log('🚨 需要审批（needs_attention）——sol 可用 claude_code_reply 注入答复');
      } else if (cur.status !== 'running' && cur.status !== 'queued') {
        deps.log(`状态: ${cur.status}${cur.substatus ? ` (${cur.substatus})` : ''}`);
      }
    }
    if (isTerminal(cur.status) && state.lastTerminalJobId !== cur.jobId) {
      state.lastTerminalJobId = cur.jobId;
      deps.log(renderTerminalSnapshot(buildTerminalSnapshot(cur, statOrNull, readText), cur));
    }
  }
  return { terminal: !!(cur && isTerminal(cur.status)) };
}

// Production I/O for runActiveTick (tests inject their own).
function statOrNull(f: string): { size: number } | null {
  try {
    return fs.statSync(f);
  } catch {
    return null;
  }
}
function readText(f: string): string {
  return fs.readFileSync(f, 'utf8');
}

interface Cursor {
  file: string;
  offset: number;
}

function makeCursor(file: string): Cursor {
  return { file, offset: 0 };
}

// Read bytes appended since the cursor and advance it. Missing file / no new
// data => ''.
function pollCursor(c: Cursor): string {
  let size = 0;
  try {
    size = fs.statSync(c.file).size;
  } catch {
    return '';
  }
  if (size <= c.offset) return '';
  const len = size - c.offset;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(c.file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, c.offset);
  } finally {
    fs.closeSync(fd);
  }
  c.offset = size;
  return buf.toString('utf8');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function printBanner(job: Job, extra?: string): void {
  console.log('\n━━━━━ Claude Code 打工人 ━━━━━');
  console.log(`job ${job.jobId}  session ${job.sessionId}  profile=${job.profile}  port=${job.port}  mode=${job.permissionMode}`);
  console.log(`工作目录: ${job.workFolder}  kind=${job.kind}${extra ? `  ${extra}` : ''}`);
}

function printEvent(ev: ReturnType<typeof parseLine>): void {
  if (ev.type === 'assistant') {
    if (ev.text) console.log(ev.text);
    for (const tu of ev.toolUses) console.log(renderToolUse(tu));
    return;
  }
  const r = renderEvent(ev);
  if (r) console.log(r);
}

function printStderrLine(line: string): void {
  const t = line.trim();
  if (!t) return;
  console.log(t.startsWith('=====') ? t : `[stderr] ${line.replace(/\n$/, '')}`);
}

// Newest-first jobs sharing a session, so the viewer can follow the reply chain.
function chainJobs(sessionId: string): Job[] {
  return listJobs(1000)
    .filter((j) => j.sessionId === sessionId)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

const terminalDeps = {
  list: chainJobs,
  read: readJob,
  poll: pollCursor,
  log: (msg: string): void => console.log(msg),
  counters: { poll: 0, logRead: 0, stderrRead: 0, jobRead: 0, listCalls: 0 },
};

async function runActiveLoop(jobId: string, sessionId: string, policy: ViewerTerminalPolicy): Promise<void> {
  const state = {
    currentJobId: jobId,
    sessionId,
    out: makeCursor(logFilePath(jobId)),
    err: makeCursor(stderrLogFilePath(jobId)),
    parser: new LineParser(),
    lastShownStatus: null as string | null,
    lastTerminalJobId: null as string | null,
  };
  for (;;) {
    const { terminal } = runActiveTick(state, terminalDeps);
    if (terminal) {
      if (policy === 'close') return;
      await persistStatic(state.sessionId);
      return;
    }
    await sleep(POLL_ACTIVE_MS);
  }
}

// Terminal persist phase: event-driven (fs.watch), NO periodic polling. On a
// same-session reply job the active loop resumes from the beginning (fresh
// cursors/parser, terminal prints only once per job).
async function persistStatic(sessionId: string): Promise<void> {
  const result = await buildStaticWatch(
    sessionId,
    (dir, listener) => fs.watch(dir, listener),
    (sid) => chainJobs(sid),
  );
  if (result.switchToJobId) {
    const job = readJob(result.switchToJobId);
    if (job) {
      await runActiveLoop(result.switchToJobId, job.sessionId, parseTerminalPolicy());
      return;
    }
  }
  // No switch requested (watch failed): stay static forever.
}

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('usage: node viewer.js <jobId>');
    process.exit(1);
  }
  const first = readJob(jobId);
  if (!first) {
    console.error(`job not found: ${jobId}`);
    process.exit(1);
  }
  const policy = parseTerminalPolicy();
  printBanner(first);
  await runActiveLoop(jobId, first.sessionId, policy);
  // close policy: the run loop returned, so the window exits naturally.
}

// main-entry guard: importing this module for tests must NOT run anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`viewer fatal: ${String(err)}`);
    process.exit(1);
  });
}
