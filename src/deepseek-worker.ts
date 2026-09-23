// One bounded DeepSeek Harness worker turn.
//
// The orchestrator supervisor owns the lifecycle and parses the normalized
// stream-json emitted here.  rc8's documented headless runner prints only the
// final assistant text, so this adapter wraps that text in the two conclusive
// Claude-compatible events the shared renderer already understands.  stderr is
// forwarded as diagnostics only; it is never parsed into attention.
import { spawn, type ChildProcess } from 'node:child_process';
import { readJob } from './job-store.js';
import { detectDeepSeekHarness } from './worker-adapter.js';

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
// Tailing bounded stderr capture (see forwardStderr); written only by the
// per-child listeners, read once at exit for a possible dsh failure code.
let captured = '';

function jobIdArg(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf('--job');
  if (index < 0 || !args[index + 1]) throw new Error('deepseek-worker: usage --job <jobId>');
  return args[index + 1];
}

function emitNormalized(text: string, isError: boolean): void {
  const bounded = Buffer.byteLength(text, 'utf8') <= MAX_STDOUT_BYTES
    ? text
    : Buffer.from(text, 'utf8').subarray(0, MAX_STDOUT_BYTES).toString('utf8');
  const content = [{ type: 'text', text: bounded }];
  process.stdout.write(`${JSON.stringify({ type: 'assistant', message: { content } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'result', result: bounded, is_error: isError })}\n`);
}

// Bounded stderr capture: diagnostics are forwarded verbatim to this worker's
// own stderr, and a tailing `dsh: <CODE>:` line (the harness's stable machine
// failure marker) is remembered for structured error emission below.  The
// buffer only has to reach that line; it is never emitted, so 8 KiB is ample.
const MAX_STDERR_BYTES = 8 * 1024;

// The failure code carried by a structured error event: ASCII [A-Za-z0-9_-],
// at most 64 chars.  The human message after the colon is a harness-specific
// string that may leak paths/tokens, so it is NEVER included — only the code
// itself is surfaced.
const DSH_CODE_RE = /^dsh: ([A-Za-z0-9_-]{1,64}):/;

function dshFailureCode(captured: string): string | null {
  let idx = captured.lastIndexOf('dsh: ');
  while (idx >= 0) {
    const eol = captured.indexOf('\n', idx);
    const line = eol < 0 ? captured.slice(idx) : captured.slice(idx, eol);
    const match = DSH_CODE_RE.exec(line.trim());
    if (match) return match[1];
    idx = captured.lastIndexOf('dsh: ', idx - 1);
  }
  return null;
}

function forwardStderr(child: ChildProcess): void {
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    captured = (captured + chunk).slice(-MAX_STDERR_BYTES);
    process.stderr.write(chunk);
  });
}

async function run(): Promise<void> {
  const jobId = jobIdArg();
  const job = readJob(jobId);
  if (!job) throw new Error('deepseek-worker: job not found');
  const probe = detectDeepSeekHarness();
  if (!probe.available || !probe.runner) {
    process.stderr.write(`deepseek-worker: harness unavailable (${probe.reason})\n`);
    process.exitCode = 127;
    return;
  }

  const runnerIsTypeScript = probe.runner.toLowerCase().endsWith('.ts');
  const nodeArgs = runnerIsTypeScript
    ? ['--import', 'tsx/esm', probe.runner]
    : [probe.runner];
  const harnessArgs = ['--profile', 'headless'];
  // The bridge is an explicit opt-in: even when the probe found a local
  // bridge file, --patch is only passed when DEEPSEEK_HARNESS_BRIDGE_PATCH
  // names a path in this process environment.  DEEPSEEK_HARNESS_DISABLE_BRIDGE
  // always wins and keeps the harness fully independent.  Nothing is ever
  // installed or mutated; the harness is never started outside this run.
  const explicitBridge = (process.env.DEEPSEEK_HARNESS_BRIDGE_PATCH || '').trim();
  const bridgeDisabled = process.env.DEEPSEEK_HARNESS_DISABLE_BRIDGE === '1';
  if (!bridgeDisabled && explicitBridge) {
    harnessArgs.push('--patch', explicitBridge);
  }
  harnessArgs.push(job.prompt);

  const child = spawn(process.execPath, [...nodeArgs, ...harnessArgs], {
    cwd: probe.root,
    env: {
      ...process.env,
      DSH_CWD: job.workFolder,
      // The viewer is an orchestrator concern and must stay off for workers.
      OPEN_LIVE_VIEW: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  forwardStderr(child);
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    if (Buffer.byteLength(output, 'utf8') < MAX_STDOUT_BYTES) output += chunk;
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode) => resolve(exitCode ?? 1));
  });
  // Structured failure: on a non-zero harness exit with no error result on
  // stdout, surface EXACTLY ONE bounded normalized result event whose result
  // is only the sanitized `dsh:<CODE>` (the code, never the harness message).
  // The supervisor's extractFailureDetail reads this from the stdout log, so
  // it stays a single machine-recognizable token.  Unknown/unmatched stderr is
  // never structured — it stays diagnostics-only.
  const failed = code !== 0;
  const hadErrorResult = /"is_error":true/.test(output);
  const dshCode = failed && !hadErrorResult ? dshFailureCode(captured) : null;
  if (dshCode) {
    process.stdout.write(`${JSON.stringify({ type: 'result', result: `dsh:${dshCode}`, is_error: true })}\n`);
  } else {
    emitNormalized(output.trim(), failed);
  }
  process.exitCode = code;
}

run().catch((error: unknown) => {
  process.stderr.write(`deepseek-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
