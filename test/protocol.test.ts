// End-to-end MCP protocol test: spawn the compiled server and drive it over
// stdio with newline-delimited JSON-RPC. Uses the fake claude (via
// CLAUDE_CLI_NAME / CLAUDE_CLI_PREFIX env) so no real proxy is contacted.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnBackground } from '../src/proc.js';
import { setFallbackMsForTest, closeJobEventBrokerForTest } from '../src/job-events.js';
import { DEFAULT_WORKER_ALLOW, DEFAULT_WORKER_DENY } from '../src/config.js';

const rt = path.join(os.tmpdir(), `orc-proto-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
// Short permission-confirm window so the detached supervisors spawned by the
// protocol-test server promote a genuine block to needs_attention quickly.
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';
// Deterministic spawns: no anti-burst start jitter in tests (mirrors
// test/watch.test.ts so the attention confirm window is not spent on jitter).
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';
const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');
// Hermetic worker policy: this suite asserts on the start/reply warnings[] the
// server returns, and the server reports a warning whenever the whitelist file
// cannot supply a policy on its own (missing file, or a deny list that misses
// built-in baseline rules — the baseline is ALWAYS unioned in). A fixture that
// already carries the whole baseline plus an allow array is therefore the only
// shape that produces no warning, and it makes those assertions independent of
// whether the machine running the tests happens to have
// ~/.claude/worker-whitelist.json (a fresh clone does not).
const WHITELIST_FIXTURE = path.join(rt, 'worker-whitelist.json');
fs.writeFileSync(
  WHITELIST_FIXTURE,
  `${JSON.stringify(
    {
      permissions: {
        defaultMode: 'bypassPermissions',
        allow: [...DEFAULT_WORKER_ALLOW, 'Bash(git status)'],
        deny: [...DEFAULT_WORKER_DENY],
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

setFallbackMsForTest(50);
after(() => closeJobEventBrokerForTest());

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message: string };
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
}

function rpc(proc: ChildProcess, payload: Record<string, unknown>, timeoutMs = 20000): Promise<RpcMessage> {
  return new Promise((resolve, reject) => {
    const id = payload.id as number;
    const timer = setTimeout(() => {
      proc.stdout!.off('data', onData);
      reject(new Error(`rpc timeout for id=${id}`));
    }, timeoutMs);
    const onData = (buf: Buffer): void => {
      const text = buf.toString('utf8');
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        let o: RpcMessage;
        try {
          o = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (o.id === id) {
          clearTimeout(timer);
          proc.stdout!.off('data', onData);
          resolve(o);
          return;
        }
      }
    };
    proc.stdout!.on('data', onData);
    proc.stdin!.write(`${JSON.stringify(payload)}\n`);
  });
}

async function startServer(envOverrides: Record<string, string> = {}): Promise<ChildProcess> {
  const env = {
    ...process.env,
    ORCHESTRATOR_RUNTIME: rt,
    OPEN_LIVE_VIEW: '0',
    ORCHESTRATOR_ATTENTION_CONFIRM_MS: '300',
    ORCHESTRATOR_WHITELIST_PATH: WHITELIST_FIXTURE,
    CLAUDE_CLI_NAME: FAKE_CLAUDE,
    CLAUDE_CLI_PREFIX: process.execPath,
    FAKE_CLAUDE_RUN_SECONDS: '1',
    FAKE_CLAUDE_EXIT_CODE: '0',
    ...envOverrides,
  };
  // Background test server: on Windows it must not pop a console window
  // (spawnBackground sets windowsHide there).
  const proc = spawnBackground(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    proc.stderr!.on('data', (d) => process.stderr.write(`[server] ${d}`));
    proc.on('error', reject);
    resolve();
  });
  return proc;
}

function killServer(proc: ChildProcess): void {
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
}

async function initProtocol(proc: ChildProcess): Promise<void> {
  const init = await rpc(proc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'orc-test', version: '1.0.0' },
    },
  });
  assert.ok(init.result, 'initialize should return a result');
  proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}

test('MCP handshake + tools/list exposes the eight tools', async () => {
  const proc = await startServer();
  try {
    const init = await rpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'orc-test', version: '1.0.0' },
      },
    });
    assert.ok(init.result, 'initialize should return a result');

    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const list = await rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const startDescription = (list.result as { tools: Array<{ name: string; description: string }> })
      .tools.find((tool) => tool.name === 'claude_code_start')!.description;
    // Mandatory delegation: the leader dispatches implementation work by
    // default and never waits for a separate user authorization. The removed
    // "optional delegation only on an explicit current-task request" framing
    // must not come back.
    assert.match(startDescription, /Mandatory delegation/);
    assert.match(startDescription, /Delegation is the default path and needs no separate user authorization/);
    assert.doesNotMatch(startDescription, /only when the user explicitly requests delegation/);
    // Per-item dispatch is still mandatory: independent items are started
    // back-to-back, never batched into a wave.
    assert.doesNotMatch(startDescription, /independent items default to a wave/);
    // Mandatory delegation restores the evidence-only report contract: the
    // worker's research/analysis report is evidence for the leader's decision,
    // never the decision itself (the optional-delegation era had dropped this
    // in favour of "answer the authorized question").
    assert.match(startDescription, /reports are evidence-only/);
    assert.match(startDescription, /a worker never decides for the leader/);
    const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, [
      'claude_code_cancel',
      'claude_code_health',
      'claude_code_list',
      'claude_code_reply',
      'claude_code_retention_preview',
      'claude_code_start',
      'claude_code_status',
      'claude_code_wait',
      'claude_code_watch',
    ]);
  } finally {
    killServer(proc);
  }
});

test('claude_code_start rejects relative workFolder over the wire', async () => {
  const proc = await startServer();
  try {
    await rpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const call = await rpc(proc, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'x', workFolder: 'relative/path' } },
    });
    const result = call.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /absolute/);
  } finally {
    killServer(proc);
  }
});

test('full start -> wait round trip through the MCP boundary', async () => {
  const proc = await startServer();
  try {
    await rpc(proc, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
    });
    proc.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true);
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: { jobId: string; port: number; permissionMode: string; status: string } };
    assert.ok(parsed.job.jobId);
    assert.equal(parsed.job.port, 15721);
    assert.equal(parsed.job.permissionMode, 'bypassPermissions');

    const wait = await rpc(proc, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'claude_code_wait', arguments: { jobId: parsed.job.jobId, waitSeconds: 60 } },
    });
    const waitResult = wait.result as { content?: Array<{ text: string }> };
    const waited = JSON.parse(waitResult.content?.[0]?.text ?? '{}') as { status: string };
    assert.equal(waited.status, 'succeeded');
  } finally {
    killServer(proc);
  }
});

test('claude_code_watch round trip: start then a single watch reaches succeeded', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const startResult = start.result as { content?: Array<{ text: string }> };
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: { jobId: string } };
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 60 } },
      },
      20000,
    );
    const watchResult = watch.result as { content?: Array<{ text: string }> };
    const watched = JSON.parse(watchResult.content?.[0]?.text ?? '{}') as {
      status: string;
      wakeReason: string;
      jobId: string;
    };
    assert.equal(watched.status, 'succeeded');
    assert.equal(watched.wakeReason, 'terminal');
    assert.equal(watched.jobId, parsed.job.jobId);
  } finally {
    killServer(proc);
  }
});

test('claude_code_watch rejects out-of-range timeoutSeconds', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const call = await rpc(proc, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'claude_code_watch', arguments: { jobId: 'x', timeoutSeconds: 999999 } },
    });
    const result = call.result as { isError?: boolean } | undefined;
    assert.ok(call.error !== undefined || result?.isError === true, 'out-of-range timeout must be rejected');
  } finally {
    killServer(proc);
  }
});

test('aborting a watch over the wire does not cancel the job; re-attach completes', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: { jobId: string };
    };
    // Fire a watch and cancel it with the standard MCP cancellation notification.
    proc.stdin!.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 60 } },
      })}\n`,
    );
    await new Promise((r) => setTimeout(r, 400));
    proc.stdin!.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 11 } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 300));
    // The abort must not cancel the job.
    const status = await rpc(proc, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'claude_code_status', arguments: { jobId: parsed.job.jobId } },
    });
    const st = JSON.parse((status.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
    };
    assert.notEqual(st.status, 'cancelled', 'client abort must not cancel the job');
    // Re-attach: a fresh watch sees the job through to success.
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 60 } },
      },
      20000,
    );
    const watched = JSON.parse((watch.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
    };
    assert.equal(watched.status, 'succeeded');
  } finally {
    killServer(proc);
  }
});

test('needs_attention wakes the watch over the wire', async () => {
  const proc = await startServer({ FAKE_CLAUDE_USER_PROMPT: '1', FAKE_CLAUDE_RUN_SECONDS: '10' });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 20,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: { jobId: string };
    };
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 30 } },
      },
      20000,
    );
    const watched = JSON.parse((watch.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
      wakeReason: string;
      attention?: string;
    };
    assert.equal(watched.status, 'needs_attention');
    assert.equal(watched.wakeReason, 'needs_attention');
    assert.ok(watched.attention && watched.attention.length > 0, 'attention hint present');
  } finally {
    killServer(proc);
  }
});

test('needs_attention watch over the wire carries structured attentionDetail; status echoes the same requestId', async () => {
  const proc = await startServer({
    FAKE_CLAUDE_USER_PROMPT: '1',
    FAKE_CLAUDE_PERM_TOOL: 'Read',
    FAKE_CLAUDE_PERM_PATH: path.join(rt, 'secrets.json'),
    FAKE_CLAUDE_RUN_SECONDS: '10',
  });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: { jobId: string };
    };
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 30 } },
      },
      20000,
    );
    const watched = JSON.parse((watch.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
      wakeReason: string;
      attentionDetail?: {
        tool: string;
        action: string;
        path: string | null;
        risk: string;
        requestId: string;
        requestIdSource: string;
        at: string;
        message: string;
      };
    };
    assert.equal(watched.status, 'needs_attention');
    assert.equal(watched.wakeReason, 'needs_attention');
    assert.ok(watched.attentionDetail, 'wire watch carries structured attention');
    assert.equal(watched.attentionDetail!.tool, 'Read');
    assert.equal(watched.attentionDetail!.action, 'read');
    assert.equal(watched.attentionDetail!.path, 'secrets.json');
    assert.equal(watched.attentionDetail!.risk, 'low');
    assert.equal(watched.attentionDetail!.requestId, 'fake-prompt-1');
    assert.equal(watched.attentionDetail!.requestIdSource, 'upstream');
    const wireRaw = JSON.stringify(watched);
    assert.ok(!wireRaw.includes('Do you want to proceed'), 'wire watch never leaks the raw prompt');
    assert.ok(!wireRaw.includes(path.join(rt, 'secrets.json')), 'wire watch never leaks the full path');

    // status over the wire echoes the same requestId summary.
    const status = await rpc(proc, {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'claude_code_status', arguments: { jobId: parsed.job.jobId } },
    });
    const st = JSON.parse((status.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
      attentionDetail?: { requestId: string; tool: string; path: string | null };
    };
    assert.equal(st.status, 'needs_attention');
    assert.ok(st.attentionDetail, 'status over the wire carries attentionDetail');
    assert.equal(st.attentionDetail!.requestId, 'fake-prompt-1');
    assert.equal(st.attentionDetail!.tool, 'Read');
    assert.equal(st.attentionDetail!.path, 'secrets.json');
  } finally {
    killServer(proc);
  }
});

test('sticky needs_attention remains visible over the wire after result output and exit 0', async () => {
  // Deterministic handshake gate (per-test dir, never shared): the test creates
  // the gate AFTER the watch has confirmed needs_attention with the right
  // detail, so the fixture's result+exit0 can never race the confirmation.
  const gateDir = path.join(rt, 'gates', `proto-sticky-${process.pid}`);
  const gate = path.join(gateDir, 'gate');
  fs.mkdirSync(gateDir, { recursive: true });
  const proc = await startServer({
    FAKE_CLAUDE_USER_PROMPT: '1',
    FAKE_CLAUDE_PERM_SELF_RECOVER: '1',
    FAKE_CLAUDE_SELF_RECOVER_GATE: gate,
    FAKE_CLAUDE_PERM_TOOL: 'Read',
    FAKE_CLAUDE_PERM_PATH: path.join(rt, 'sticky-secrets.json'),
    FAKE_CLAUDE_RUN_SECONDS: '10',
  });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 43,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'sticky fake task', workFolder: rt, profile: 'auto' } },
    });
    const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: { jobId: string };
    };
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 30 } },
      },
      20000,
    );
    const watched = JSON.parse((watch.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
      wakeReason: string;
      attentionDetail?: { requestId: string; tool: string; path: string | null };
    };
    assert.equal(watched.status, 'needs_attention');
    assert.equal(watched.wakeReason, 'needs_attention');
    assert.equal(watched.attentionDetail?.requestId, 'fake-prompt-1');

    // Release the fixture: its result+exit0 now happens strictly after the
    // confirmed needs_attention above, so no suite-load race can flip this.
    fs.writeFileSync(gate, 'go', 'utf8');

    // Wait for the detached worker to close, then verify that exit 0 cannot
    // resolve the confirmed attention episode implicitly. Polling avoids making
    // the assertion depend on a short wall-clock fixture when the protocol
    // suite is under load.
    let st: {
      status?: string;
      endedAt?: string | null;
      attentionDetail?: { requestId: string; tool: string; path: string | null };
    } = {};
    const deadline = Date.now() + 20000;
    do {
      const status = await rpc(proc, {
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: { name: 'claude_code_status', arguments: { jobId: parsed.job.jobId } },
      });
      st = JSON.parse((status.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as typeof st;
      if (st.endedAt) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(st.endedAt, 'sticky job must eventually record worker close');
    assert.equal(st.status, 'needs_attention');
    assert.equal(st.attentionDetail?.requestId, 'fake-prompt-1');
    assert.equal(st.attentionDetail?.tool, 'Read');
    assert.equal(st.attentionDetail?.path, 'sticky-secrets.json');
  } finally {
    killServer(proc);
    fs.rmSync(gateDir, { recursive: true, force: true });
  }
});

test('claude_code_reply to a needs_attention job exposes a non-authorizing response audit over the wire', async () => {
  const proc = await startServer({
    FAKE_CLAUDE_USER_PROMPT: '1',
    FAKE_CLAUDE_PERM_TOOL: 'Read',
    FAKE_CLAUDE_PERM_PATH: path.join(rt, 'secrets.json'),
    FAKE_CLAUDE_RUN_SECONDS: '10',
  });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 60,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: { jobId: string };
    };
    const watch = await rpc(
      proc,
      {
        jsonrpc: '2.0',
        id: 61,
        method: 'tools/call',
        params: { name: 'claude_code_watch', arguments: { jobId: parsed.job.jobId, timeoutSeconds: 30 } },
      },
      20000,
    );
    const watched = JSON.parse((watch.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
    };
    assert.equal(watched.status, 'needs_attention');

    const reply = await rpc(proc, {
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: { name: 'claude_code_reply', arguments: { jobId: parsed.job.jobId, prompt: 'narrow fix' } },
    });
    const replyResult = JSON.parse((reply.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      job: {
        jobId: string;
        attentionResponseAudit?: {
          kind: string;
          effect: string;
          authorization: boolean;
          attention: { requestId: string; tool: string } | null;
        };
      };
    };
    assert.ok(replyResult.job.jobId, 'reply job created');
    assert.ok(replyResult.job.attentionResponseAudit, 'reply job carries the audit over the wire');
    assert.equal(replyResult.job.attentionResponseAudit!.kind, 'leader_reply_submitted');
    assert.equal(replyResult.job.attentionResponseAudit!.effect, 'resume_requested');
    assert.equal(replyResult.job.attentionResponseAudit!.authorization, false);
    assert.equal(replyResult.job.attentionResponseAudit!.attention?.requestId, 'fake-prompt-1');
    assert.equal(replyResult.job.attentionResponseAudit!.attention?.tool, 'Read');
    assert.ok(
      !JSON.stringify(replyResult.job.attentionResponseAudit).includes('narrow fix'),
      'audit must not contain the reply prompt over the wire',
    );

    // status over the wire exposes the same non-authorizing audit.
    const status = await rpc(proc, {
      jsonrpc: '2.0',
      id: 63,
      method: 'tools/call',
      params: { name: 'claude_code_status', arguments: { jobId: replyResult.job.jobId } },
    });
    const st = JSON.parse((status.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      attentionResponseAudit?: { authorization: boolean };
    };
    assert.equal(st.attentionResponseAudit?.authorization, false);
  } finally {
    killServer(proc);
  }
});

test('claude_code_health reports version, capabilities and reloadRequired over the wire', async () => {
  // Isolate this test's runtime dir: every other protocol test spawns a server
  // into the shared `rt` and force-kills it, which (correctly) leaves stale
  // registry residue. For the health assertions we need a registry with ONLY
  // this test's own server instance so registryStale is provably false.
  const isolated = path.join(os.tmpdir(), `orc-proto-health-${process.pid}-${Date.now()}`);
  fs.mkdirSync(isolated, { recursive: true });
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: isolated });
  try {
    await initProtocol(proc);
    const call = await rpc(proc, {
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/call',
      params: { name: 'claude_code_health', arguments: {} },
    });
    const result = call.result as { content?: Array<{ text: string }> };
    const h = JSON.parse(result.content?.[0]?.text ?? '{}') as {
      version: string;
      reloadRequired: boolean;
      diagnostic: string;
      capabilities: { tools: string[]; structuredAttentionDetail: boolean; responseAudit: boolean };
      loaded: { buildHash: string; buildFingerprint: string };
      disk: { buildHash: string; buildFingerprint: string };
      duplicateInstanceSuspected: boolean;
      registryStale: boolean;
      registry: {
        enabled: boolean;
        recorded: boolean;
        instanceCount: number;
        liveCount: number;
        staleCount: number;
        heartbeatMs: number;
        staleAfterMs: number;
      };
      diagnostics: Array<{ code: string; severity: string; detail: string }>;
    };
    assert.equal(h.version, '1.0.0');
    assert.equal(typeof h.reloadRequired, 'boolean');
    assert.equal(h.reloadRequired, false, 'no rebuild during this test process');
    assert.equal(h.diagnostic, 'healthy/current');
    assert.ok(h.capabilities.tools.includes('claude_code_watch'), 'watch tool is a registered capability');
    assert.ok(h.capabilities.tools.includes('claude_code_health'));
    assert.equal(h.capabilities.structuredAttentionDetail, true);
    assert.equal(h.capabilities.responseAudit, true);
    assert.equal(h.loaded.buildHash.length, 64, 'legacy entry hash is a SHA-256 hex');
    assert.equal(h.disk.buildHash, h.loaded.buildHash);
    assert.equal(h.loaded.buildFingerprint.length, 64, 'full-build fingerprint is a SHA-256 hex');
    assert.equal(h.disk.buildFingerprint, h.loaded.buildFingerprint);
    // Stage 5 registry: the spawned server registers itself, so its own record
    // is present, identity-live, and fresh (never duplicate/stale on its own).
    assert.equal(h.duplicateInstanceSuspected, false);
    assert.equal(h.registryStale, false);
    assert.equal(h.registry.enabled, true, 'instance registry is enabled in the server process');
    assert.equal(h.registry.recorded, true, 'the server registered its own instance');
    assert.equal(h.registry.instanceCount, 1);
    assert.equal(h.registry.liveCount, 1);
    assert.equal(h.registry.staleCount, 0);
    assert.ok(h.registry.heartbeatMs > 0 && h.registry.staleAfterMs > 0, 'heartbeat/stale thresholds are surfaced');
    assert.ok(Array.isArray(h.diagnostics), 'structured diagnostics array is present');
    assert.ok(!h.diagnostics.some((d) => d.code === 'duplicate_instance_suspected' || d.code === 'registry_stale'));
    const raw = JSON.stringify(h);
    assert.ok(!raw.includes('PROXY_MANAGED'), 'health must not leak a token');
  } finally {
    killServer(proc);
  }
});

test('claude_code_health schema description lists the three emitted diagnostic codes', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 80, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; description: string }> }).tools;
    const health = tools.find((t) => t.name === 'claude_code_health');
    assert.ok(health, 'claude_code_health is listed');
    const desc = health?.description ?? '';
    assert.ok(desc.includes('healthy/current'), 'describes healthy/current');
    assert.ok(desc.includes('reload_required'), 'describes reload_required');
    assert.ok(desc.includes('hash_unavailable'), 'describes hash_unavailable');
    assert.ok(desc.includes('reloadRequired'), 'explains reloadRequired semantics');
    assert.ok(desc.includes('Never returns prompts'), 'description stays leak-safe');
  } finally {
    killServer(proc);
  }
});

test('claude_code_start advertises optional taskType enum and deliverablePath; existing fields remain', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, any>; description: string }> }).tools;
    const start = tools.find((t) => t.name === 'claude_code_start');
    assert.ok(start, 'claude_code_start is listed');
    const schema = start!.inputSchema;
    assert.equal(schema.type, 'object');
    const props = schema.properties as Record<string, any>;
    // Existing fields remain.
    for (const k of ['prompt', 'workFolder', 'profile', 'parallelism', 'maxRuntimeMinutes']) {
      assert.ok(props[k], `existing field ${k} remains`);
    }
    // New optional taskType enum + deliverablePath.
    assert.equal(props.taskType.type, 'string');
    assert.deepEqual(props.taskType.enum, ['execution', 'research', 'analysis']);
    assert.equal(props.deliverablePath.type, 'string');
    // workerBackend is advertised with the harness adapter named by probe, not
    // any pinned version slug.
    assert.equal(props.workerBackend.type, 'string');
    assert.deepEqual(props.workerBackend.enum, ['claude', 'deepseek-harness']);
    const wbDesc = props.workerBackend.description ?? '';
    assert.ok(!wbDesc.includes('rc8'), 'no pinned version slug in the workerBackend description');
    // Required stays the historical minimal set; the new fields are optional.
    assert.deepEqual(schema.required, ['prompt', 'workFolder']);
  } finally {
    killServer(proc);
  }
});

test('claude_code_start schema advertises an optional strict contract declaring every TaskContractV2 field', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 91, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, any> }> }).tools;
    const start = tools.find((t) => t.name === 'claude_code_start');
    assert.ok(start, 'claude_code_start is listed');
    const schema = start!.inputSchema;
    assert.equal(schema.type, 'object');
    assert.ok(schema.required && !schema.required.includes('contract'), 'contract must be optional');
    const props = schema.properties as Record<string, any>;
    assert.ok(props.contract, 'contract property is advertised');
    const c = props.contract;
    assert.equal(c.type, 'object');
    // Strictly declares every TaskContractV2 field, top-level and nested.
    for (const k of ['schemaVersion', 'scope', 'writePolicy', 'budget', 'acceptance', 'reporting', 'admission']) {
      assert.ok(c.properties[k], `contract declares ${k}`);
    }
    assert.deepEqual(c.properties.writePolicy.enum, ['read_only_report', 'listed_writes', 'workspace_legacy']);
    assert.equal(c.properties.schemaVersion.const, 2);
    for (const k of ['readGlobs', 'writeFiles', 'forbiddenGlobs']) {
      assert.ok(c.properties.scope.properties[k], `scope declares ${k}`);
    }
    assert.equal(c.properties.budget.properties.maxRuntimeMinutes.type, 'integer');
    assert.ok(c.properties.acceptance.items, 'acceptance is an array of command specs');
    for (const k of ['id', 'argv', 'cwdRelative', 'timeoutSeconds', 'required', 'outputMaxChars']) {
      assert.ok(c.properties.acceptance.items.properties[k], `acceptance item declares ${k}`);
    }
    assert.equal(c.properties.admission.properties.resourceClass.type, 'string');
    assert.ok(c.additionalProperties === false, 'contract object is strict at the top level');
  } finally {
    killServer(proc);
  }
});

test('Wave3B claude_code_reply schema advertises two optional preflight overrides; description names both backends and the unconditional harness gate', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 92, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, any>; title: string; description: string }> }).tools;
    const reply = tools.find((t) => t.name === 'claude_code_reply');
    assert.ok(reply, 'claude_code_reply is listed');
    const schema = reply!.inputSchema;
    assert.equal(schema.type, 'object');
    const props = schema.properties as Record<string, any>;
    assert.ok(props.jobId, 'jobId remains');
    assert.ok(props.prompt, 'prompt remains');
    assert.deepEqual(schema.required, ['jobId', 'prompt'], 'the new overrides are optional');
    assert.equal(props.allowLargeResume.type, 'boolean', 'allowLargeResume is an optional boolean');
    assert.equal(props.allowFreshTurn.type, 'boolean', 'allowFreshTurn is an optional boolean');
    const desc = reply!.description;
    // The harness gate must be described as unconditional — never gated by a
    // feature flag.
    assert.ok(desc.includes('does NOT depend on any feature flag'), 'reply description says the harness gate is flag-independent');
    assert.ok(desc.includes('fresh_turn_authorization_required'), 'reply description names the fixed harness prefix');
    assert.ok(desc.includes('new_start_required'), 'reply description names the fixed claude prefix');
    assert.ok(
      !desc.includes('only when ORCHESTRATOR_REPLY_PREFLIGHT') && !desc.includes('When ORCHESTRATOR_REPLY_PREFLIGHT'),
      'reply description no longer scopes the harness gate behind the flag',
    );
    const title = reply!.title;
    assert.ok(
      !title.includes('saved Claude session'),
      'reply title no longer generically claims a saved Claude session',
    );
    assert.ok(title.toLowerCase().includes('resume') || title.toLowerCase().includes('independent'),
      'reply title names the dual nature (resume or independent turn)');
    const freshDesc = props.allowFreshTurn.description ?? '';
    assert.ok(
      freshDesc.includes('NOT resumed'),
      'allowFreshTurn description states the parent session is NOT resumed',
    );
  } finally {
    killServer(proc);
  }
});

test('Wave3B claude_code_reply denies an over-threshold Claude resume with the fixed code over the wire', async () => {
  // Isolate this test's home so the transcript fixture lands where the server
  // process (which inherits this process's env) will stat it.
  const tmpHome = path.join(os.tmpdir(), `orc-wave3b-proto-${process.pid}-${Date.now()}`);
  const prevUser = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = tmpHome;
  if (process.env.HOME) delete process.env.HOME;
  try {
    const proc = await startServer({ ORCHESTRATOR_REPLY_PREFLIGHT: '1' });
    try {
      await initProtocol(proc);
      // A needs_attention job with a huge transcript. The start itself needs a
      // real job first (the fake claude will block on the permission tool), so
      // we reuse the existing needs_attention wire pattern.
      const start = await rpc(proc, {
        jsonrpc: '2.0',
        id: 93,
        method: 'tools/call',
        params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
      });
      const parsed = JSON.parse((start.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
        job: { jobId: string; sessionId: string };
      };
      // Write a >2 MiB transcript for this job's session at the preflight path.
      const munged = rt.replace(/[^a-zA-Z0-9]/g, '-');
      const tdir = path.join(tmpHome, '.claude', 'projects', munged);
      fs.mkdirSync(tdir, { recursive: true });
      fs.writeFileSync(path.join(tdir, `${parsed.job.sessionId}.jsonl`), Buffer.alloc(4.2 * 1024 * 1024, 0x61));

      const reply = await rpc(proc, {
        jsonrpc: '2.0',
        id: 94,
        method: 'tools/call',
        params: { name: 'claude_code_reply', arguments: { jobId: parsed.job.jobId, prompt: 'narrow fix' } },
      });
      const replyResult = reply.result as { isError?: boolean; content?: Array<{ text: string }> };
      assert.equal(replyResult.isError, true, 'an over-threshold reply must be rejected');
      assert.match(
        replyResult.content?.[0]?.text ?? '',
        /^new_start_required/,
        'the fixed new_start_required prefix reaches the wire',
      );
      // The job list must be unchanged (no reply job was created). The shared
      // server runtime accumulates jobs from earlier tests in this file —
      // including successful reply jobs from other tests — so the assertion is
      // scoped to THIS test's base job: no reply job was created as its child,
      // and the base job's record is untouched.
      const list = await rpc(proc, { jsonrpc: '2.0', id: 95, method: 'tools/call', params: { name: 'claude_code_list', arguments: {} } });
      const listResult = JSON.parse((list.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '[]') as Array<{
        jobId: string;
        kind: string;
        status: string;
        replyToJobId?: string | null;
      }>;
      const baseRecord = listResult.find((j) => j.jobId === parsed.job.jobId);
      assert.ok(baseRecord, 'the base job is still listed');
      assert.ok(
        baseRecord.status === 'needs_attention' || baseRecord.status === 'queued' || baseRecord.status === 'running',
        'the denied reply never modifies the base job (still non-terminal)',
      );
      assert.ok(
        listResult.every((j) => j.kind !== 'reply' || j.replyToJobId !== parsed.job.jobId),
        'the denied call created no reply job for this base job',
      );
    } finally {
      killServer(proc);
    }
  } finally {
    if (prevUser === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUser;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

test('Wave3B claude_code_reply allowFreshTurn wire path runs a deepseek-harness reply as a new session', async () => {
  const fakeDsh = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-deepseek.mjs');
  const proc = await startServer({
    ORCHESTRATOR_REPLY_PREFLIGHT: '1',
    DEEPSEEK_HARNESS_ROOT: path.dirname(fakeDsh),
    DEEPSEEK_HARNESS_RUNNER: fakeDsh,
    DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1',
    FAKE_DSH_RESULT: 'DSH_DONE',
  });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 96,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', workerBackend: 'deepseek-harness' },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'harness start must be accepted');
    const started = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: { jobId: string; sessionId: string } };

    const wait = await rpc(proc, {
      jsonrpc: '2.0',
      id: 97,
      method: 'tools/call',
      params: { name: 'claude_code_wait', arguments: { jobId: started.job.jobId, waitSeconds: 60 } },
    });
    const waited = JSON.parse((wait.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as {
      status: string;
    };
    assert.equal(waited.status, 'succeeded');

    // Denied without the override.
    const denied = await rpc(proc, {
      jsonrpc: '2.0',
      id: 98,
      method: 'tools/call',
      params: { name: 'claude_code_reply', arguments: { jobId: started.job.jobId, prompt: 'follow up' } },
    });
    const deniedResult = denied.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.equal(deniedResult.isError, true);
    assert.match(
      deniedResult.content?.[0]?.text ?? '',
      /^fresh_turn_authorization_required/,
      'a harness reply without the override is denied with the fixed prefix',
    );

    // Allowed with allowFreshTurn: new session id, fresh_turn replyMode.
    const allowed = await rpc(proc, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tools/call',
      params: {
        name: 'claude_code_reply',
        arguments: { jobId: started.job.jobId, prompt: 'follow up', allowFreshTurn: true },
      },
    });
    const allowedResult = allowed.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(allowedResult.isError, true, 'allowFreshTurn must be accepted');
    const replied = JSON.parse(allowedResult.content?.[0]?.text ?? '{}') as {
      job: { jobId: string; sessionId: string; replyMode: string; replyToJobId: string };
      warnings: string[];
    };
    assert.equal(replied.job.replyMode, 'fresh_turn');
    assert.equal(replied.job.replyToJobId, started.job.jobId);
    assert.notEqual(replied.job.sessionId, started.job.sessionId, 'fresh_turn uses a NEW session id');
    assert.ok(
      replied.warnings.some((w) => w.includes('NOT resumed')),
      'the wire warning states the parent session is not resumed',
    );
  } finally {
    killServer(proc);
  }
});

test('Wave3B harness reply stays fail-fast over the wire with the flag OFF (no allowFreshTurn)', async () => {
  // The capability gate is unconditional: ORCHESTRATOR_REPLY_PREFLIGHT is NOT
  // set in this server process, yet a harness reply must still be denied with
  // the fixed prefix, and no reply job may be created.
  const fakeDsh = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-deepseek.mjs');
  const proc = await startServer({
    DEEPSEEK_HARNESS_ROOT: path.dirname(fakeDsh),
    DEEPSEEK_HARNESS_RUNNER: fakeDsh,
    DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1',
    FAKE_DSH_RESULT: 'DSH_DONE',
  });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 110,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', workerBackend: 'deepseek-harness' },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'harness start must be accepted');
    const started = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: { jobId: string } };
    const wait = await rpc(proc, {
      jsonrpc: '2.0',
      id: 111,
      method: 'tools/call',
      params: { name: 'claude_code_wait', arguments: { jobId: started.job.jobId, waitSeconds: 60 } },
    });
    assert.equal(
      (JSON.parse((wait.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '{}') as { status: string }).status,
      'succeeded',
    );

    const denied = await rpc(proc, {
      jsonrpc: '2.0',
      id: 112,
      method: 'tools/call',
      params: { name: 'claude_code_reply', arguments: { jobId: started.job.jobId, prompt: 'follow up' } },
    });
    const deniedResult = denied.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.equal(deniedResult.isError, true, 'harness reply denied even with the flag off');
    assert.match(
      deniedResult.content?.[0]?.text ?? '',
      /^fresh_turn_authorization_required/,
      'the fixed prefix reaches the wire with the flag off',
    );
    const list = await rpc(proc, { jsonrpc: '2.0', id: 113, method: 'tools/call', params: { name: 'claude_code_list', arguments: {} } });
    const listResult = JSON.parse((list.result as { content?: Array<{ text: string }> }).content?.[0]?.text ?? '[]') as Array<{
      jobId: string;
      kind: string;
      replyToJobId?: string | null;
    }>;
    assert.ok(
      listResult.every((j) => j.kind !== 'reply' || j.replyToJobId !== started.job.jobId),
      'the denied call created no reply job for this base job',
    );
  } finally {
    killServer(proc);
  }
});

test('Wave3B claude_code_watch schema/description advertise workerBackend and replyMode', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 114, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, any>; description: string }> }).tools;
    const watch = tools.find((t) => t.name === 'claude_code_watch');
    assert.ok(watch, 'claude_code_watch is listed');
    assert.ok(watch!.inputSchema.properties.jobId, 'watch schema keeps jobId');
    const desc = watch!.description;
    assert.ok(desc.includes('replyMode'), 'watch description advertises replyMode');
    assert.ok(desc.includes('workerBackend'), 'watch description advertises workerBackend');
    assert.ok(desc.includes('resume_session') && desc.includes('fresh_turn'), 'watch description names both reply modes');
    assert.ok(
      desc.includes('null') && desc.toLowerCase().includes('never went through reply preflight'),
      'watch description explains the legacy replyMode null default',
    );
  } finally {
    killServer(proc);
  }
});

test('Wave3B tool descriptions never pin a version slug and never generically claim a saved session', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 115, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; title: string; description: string }> }).tools;
    const all = tools
      .map((t) => `${t.title}\n${t.description}`)
      .join('\n');
    assert.ok(!all.includes('rc8'), 'no tool description or title pins the rc8 slug');
    // The reply tool is the only one that may mention "saved session", and only
    // in the Claude-resume sense; a generic claim on the whole reply tool is
    // what the contract forbids.
    const replyTool = tools.find((t) => t.name === 'claude_code_reply');
    const replyText = `${replyTool?.title ?? ''}\n${replyTool?.description ?? ''}`;
    assert.ok(
      !replyText.includes('Resume a saved Claude session'),
      'reply title does not generically claim a saved Claude session',
    );
  } finally {
    killServer(proc);
  }
});

/** Minimal fully-valid v2 contract for wire calls (mirrors contracts-v2 tests). */
function validContract(workFolder: string): Record<string, unknown> {
  return {
    schemaVersion: 2,
    writePolicy: 'listed_writes',
    scope: { readGlobs: ['src/**/*.ts'], writeFiles: ['docs/*.md'], forbiddenGlobs: ['secrets/**'] },
    budget: { maxRuntimeMinutes: 60, reportOnlyAfterMinutes: 15 },
    acceptance: [
      {
        id: 'unit-tests',
        argv: ['node', '--test', 'test/*.test.js'],
        cwdRelative: '.',
        timeoutSeconds: 300,
        required: true,
        outputMaxChars: 10000,
      },
    ],
    reporting: { deliverablePath: path.join(workFolder, 'docs', 'report.md') },
    admission: { resourceClass: 'light', priority: 1 },
  };
}

test('claude_code_start accepts a legal contract and the public view exposes only safe mirrors', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', contract: validContract(rt) },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'a legal contract must be accepted');
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: Record<string, unknown>; warnings: unknown[] };
    assert.ok(parsed.job.jobId, 'job created');
    assert.deepEqual(parsed.warnings, []);

    const wait = await rpc(proc, {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: { name: 'claude_code_wait', arguments: { jobId: parsed.job.jobId, waitSeconds: 60 } },
    });
    const waitResult = wait.result as { content?: Array<{ text: string }> };
    const waited = JSON.parse(waitResult.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    assert.equal(waited.status, 'succeeded');

    // T1D mirrors are exposed with safe normalized defaults (workerStatus falls
    // back to the lifecycle status; acceptanceStatus is 'not_requested' and
    // contractSchemaVersion is 2 because the scheduler now persists the
    // contract — T1E persistence landed).
    assert.equal(waited.workerStatus, 'succeeded');
    assert.equal(waited.acceptanceStatus, 'not_requested');
    assert.deepEqual(waited.gateResults, []);
    assert.equal(waited.contractSchemaVersion, 2);
    // Flag-defaults are safe by default: budget/reporting features report
    // 'not_requested'/null until a budget state is actually provisioned.
    assert.equal(waited.budgetStatus, 'not_requested');
    assert.equal(waited.budgetViolation, null);
    assert.equal(waited.reportCompleteness, null);
    assert.equal(waited.metrics, null);

    // No sensitive key or marker ever reaches the wire.
    const wireRaw = JSON.stringify(waited);
    assert.ok(!wireRaw.includes('writePolicy'), 'contract body (writePolicy) must never be exposed');
    assert.ok(!wireRaw.includes('prompt'), 'prompt must never be exposed');
    assert.ok(!wireRaw.includes('stdoutPreview') && !wireRaw.includes('stderrPreview'), 'raw output previews must never be exposed');
    assert.ok(!wireRaw.includes('SECRET-ARGV-TOKEN'), 'acceptance argv must never be exposed');
    assert.ok(!wireRaw.includes('budgetConfigPath') && !wireRaw.includes('budgetStatePath'), 'budget path mirrors must never be exposed');
    assert.ok(!wireRaw.includes('fake task'), 'the stored prompt text must never be exposed');
  } finally {
    killServer(proc);
  }
});

test('claude_code_start rejects a contract with an obviously unknown top-level field', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: {
          prompt: 'fake task',
          workFolder: rt,
          profile: 'auto',
          contract: { ...validContract(rt), totallyBogusField: true },
        },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.equal(startResult.isError, true, 'an unknown contract field must be rejected');
    const msg = startResult.content?.[0]?.text ?? '';
    assert.ok(msg.includes('totallyBogusField'), `rejection names the unknown field (got: ${msg})`);
  } finally {
    killServer(proc);
  }
});

test('claude_code_start still accepts the legacy call (no contract) with old-job public defaults', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: { name: 'claude_code_start', arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto' } },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'the legacy start call must still be accepted');
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: { jobId: string; status: string; workerStatus: string; acceptanceStatus: string; gateResults: unknown[]; contractSchemaVersion: number | null } };
    assert.ok(parsed.job.jobId, 'job created');
    // Start view is a race between the scheduler's read-back (status=workerStatus='queued'
    // — the record is created with an explicit workerStatus mirror) and the supervisor's
    // synchronous promote (status='running', workerStatus still 'queued' until it rewrites).
    // All three combos are valid; 'queued' status with 'running' workerStatus is impossible.
    const s = parsed.job.status;
    const w = parsed.job.workerStatus;
    assert.ok(
      (s === 'queued' && w === 'queued') || (s === 'running' && (w === 'queued' || w === 'running')),
      `start view status/workerStatus consistent (got status=${s} workerStatus=${w})`,
    );
    assert.equal(parsed.job.acceptanceStatus, 'not_requested', 'no contract => acceptance not requested');
    assert.deepEqual(parsed.job.gateResults, [], 'no contract => no gate results');
    assert.equal(parsed.job.contractSchemaVersion, null, 'no contract => schema version null');
  } finally {
    killServer(proc);
  }
});

// ---- Wave 4B2c: desiredWorkerConcurrency + internalAgentParallelism ----

test('Wave4B2c start schema advertises desiredWorkerConcurrency and internalAgentParallelism with per-worker semantics', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 104, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; inputSchema: Record<string, any>; description: string }> }).tools;
    const start = tools.find((t) => t.name === 'claude_code_start');
    assert.ok(start, 'claude_code_start is listed');
    const schema = start!.inputSchema;
    assert.equal(schema.type, 'object');
    const props = schema.properties as Record<string, any>;
    // New Wave4B2c fields are advertised.
    assert.equal(props.desiredWorkerConcurrency.type, 'integer');
    assert.equal(props.desiredWorkerConcurrency.minimum, 1);
    assert.equal(props.desiredWorkerConcurrency.maximum, 64);
    assert.equal(props.internalAgentParallelism.type, 'string');
    assert.deepEqual(props.internalAgentParallelism.enum, ['auto', '1', '2', '3', '4']);
    assert.ok(props.parallelism, 'legacy parallelism alias remains advertised');
    // Required stays the historical minimal set; the new fields are optional.
    assert.deepEqual(schema.required, ['prompt', 'workFolder']);
    // Descriptions must state per-worker vs leader semantics and drop the old
    // hard "never push to 4" constraint.
    const desc = start!.description;
    assert.ok(!desc.includes('never push to 4'), 'the hard 4-worker cap wording is gone');
    assert.ok(!desc.includes('more than 4 workers split sequentially'), 'the sequential wave-split hard cap wording is gone');
    assert.ok(desc.toLowerCase().includes('desiredworkerconcurrency'), 'start description mentions desiredWorkerConcurrency');
    assert.ok(desc.toLowerCase().includes('queues') || desc.toLowerCase().includes('queue'),
      'start description keeps structured queue semantics for oversized waves');
    const iad = props.internalAgentParallelism.description ?? '';
    assert.ok(iad.toLowerCase().includes('worker') || iad.toLowerCase().includes('parallelism'), 'internalAgentParallelism is described');
    const d = props.desiredWorkerConcurrency.description ?? '';
    assert.ok(d.toLowerCase().includes('concurrent'), 'desiredWorkerConcurrency is described as a concurrency target');
  } finally {
    killServer(proc);
  }
});

test('Wave4B2c start rejects out-of-range desiredWorkerConcurrency (0/65/1.5) over the wire', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    for (const [badId, badValue] of [
      [105, 0],
      [106, 65],
      [107, 1.5],
    ] as const) {
      const call = await rpc(proc, {
        jsonrpc: '2.0',
        id: badId,
        method: 'tools/call',
        params: {
          name: 'claude_code_start',
          arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', desiredWorkerConcurrency: badValue },
        },
      });
      const result = call.result as { isError?: boolean } | undefined;
      assert.ok(call.error !== undefined || result?.isError === true, `desiredWorkerConcurrency=${String(badValue)} must be rejected`);
    }
  } finally {
    killServer(proc);
  }
});

test('Wave4B2c start with desired=8 and admission control ON mirrors the desired and the public queue fields', async () => {
  const proc = await startServer({ ORCHESTRATOR_ADMISSION_CONTROL: '1' });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 108,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', desiredWorkerConcurrency: 8 },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'a desired=8 start must be accepted');
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: Record<string, unknown>; warnings: unknown[] };
    assert.ok(parsed.job.jobId, 'job created');
    assert.equal(parsed.job.desiredWorkerConcurrency, 8, 'explicit desired mirrors on the start view');
    // Wave4B1 public admission mirrors must all be present (and none may leak
    // lease identity/paths).
    for (const k of ['admissionState', 'queueReason', 'queueMs', 'activeWorkers', 'queuedWorkers', 'resourceLimit', 'internalAgentParallelism']) {
      assert.ok(k in parsed.job, `public admission field ${k} is mirrored on the start view`);
    }
    const wireRaw = JSON.stringify(parsed);
    assert.ok(!wireRaw.includes('pidStartedAt'), 'pidStartedAt must never reach the wire');
    assert.ok(!wireRaw.includes('ownerPid'), 'ownerPid must never reach the wire');
  } finally {
    killServer(proc);
  }
});

test('Wave4B2c internalAgentParallelism alone and legacy parallelism alone both work and mirror each other', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    // internalAgentParallelism alone.
    const call = await rpc(proc, {
      jsonrpc: '2.0',
      id: 109,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', internalAgentParallelism: '3' },
      },
    });
    const callResult = call.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(callResult.isError, true, 'internalAgentParallelism alone must be accepted');
    const parsed = JSON.parse(callResult.content?.[0]?.text ?? '{}') as { job: Record<string, unknown> };
    assert.equal(parsed.job.internalAgentParallelism, '3', 'the primary name mirrors on the start view');
    assert.equal(parsed.job.parallelism, '3', 'the legacy alias mirrors the resolved value');
    // Legacy parallelism alone.
    const call2 = await rpc(proc, {
      jsonrpc: '2.0',
      id: 110,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', parallelism: '2' },
      },
    });
    const call2Result = call2.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(call2Result.isError, true, 'legacy parallelism must still be accepted');
    const parsed2 = JSON.parse(call2Result.content?.[0]?.text ?? '{}') as { job: Record<string, unknown> };
    assert.equal(parsed2.job.parallelism, '2', 'the legacy alias still drives the job');
    assert.equal(parsed2.job.internalAgentParallelism, '2', 'internalAgentParallelism mirrors the legacy value');
  } finally {
    killServer(proc);
  }
});

test('Wave4B2c both names equal is accepted; both names different is rejected with the fixed message', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    // Equal values -> accepted.
    const same = await rpc(proc, {
      jsonrpc: '2.0',
      id: 111,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', parallelism: '2', internalAgentParallelism: '2' },
      },
    });
    const sameResult = same.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(sameResult.isError, true, 'equal parallelism values must be accepted');
    const sameParsed = JSON.parse(sameResult.content?.[0]?.text ?? '{}') as { job: Record<string, unknown> };
    assert.equal(sameParsed.job.internalAgentParallelism, '2', 'the resolved value applies when both names agree');
    // Different values -> fixed invalid params rejection.
    const diff = await rpc(proc, {
      jsonrpc: '2.0',
      id: 112,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: { prompt: 'fake task', workFolder: rt, profile: 'auto', parallelism: 'auto', internalAgentParallelism: '3' },
      },
    });
    const diffResult = diff.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.equal(diffResult.isError, true, 'conflicting parallelism values must be rejected');
    assert.match(
      diffResult.content?.[0]?.text ?? '',
      /parallelism and internalAgentParallelism/,
      'the rejection names the conflicting fields with the fixed message',
    );
  } finally {
    killServer(proc);
  }
});

test('Wave4B2c desired worker concurrency and internal parallelism are independent (admission ON)', async () => {
  const proc = await startServer({ ORCHESTRATOR_ADMISSION_CONTROL: '1' });
  try {
    await initProtocol(proc);
    const start = await rpc(proc, {
      jsonrpc: '2.0',
      id: 113,
      method: 'tools/call',
      params: {
        name: 'claude_code_start',
        arguments: {
          prompt: 'fake task',
          workFolder: rt,
          profile: 'auto',
          desiredWorkerConcurrency: 4,
          internalAgentParallelism: '2',
        },
      },
    });
    const startResult = start.result as { isError?: boolean; content?: Array<{ text: string }> };
    assert.notEqual(startResult.isError, true, 'desired + internalAgentParallelism together must be accepted');
    const parsed = JSON.parse(startResult.content?.[0]?.text ?? '{}') as { job: Record<string, unknown> };
    assert.equal(parsed.job.desiredWorkerConcurrency, 4, 'the leader-level desired survives untouched');
    assert.equal(parsed.job.internalAgentParallelism, '2', 'the per-worker parallelism survives untouched');
  } finally {
    killServer(proc);
  }
});


// ---------------------------------------------------------------------------
// Wave 5B2: claude_code_retention_preview - read-only retention dry-run.
// ---------------------------------------------------------------------------

/** One fixed TTL override param (integer days in [1,365]) - the OTHER TTL
 *  overrides are covered by the same zod bounds; a single pair plus the
 *  boundary tests below prove the wiring without re-asserting every field. */
const TTL_OVERRIDE: ReadonlyArray<[string, number]> = [
  ['staleRegistryTtlDays', 90],
];

function retentionManifest(root: string, ignoredPid?: number): string {
  // Deterministic content manifest of every regular file under the root:
  // rel -> sha256|size. mtime is intentionally excluded: the preview server's
  // own instance-registry heartbeat rewrites registry/instances/<self>.json
  // while it runs, so content+size is the stable zero-change evidence for
  // "the TOOL mutates nothing". When ignoredPid is given, the one dynamic
  // self-heartbeat file (registry/instances/*.json whose JSON.pid ===
  // ignoredPid) is skipped; every other path still contributes its content
  // hash + size, and a file whose JSON does not parse is never ignored.
  const walk = (dir: string, base: string, out: string[]): void => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, rel, out);
      else if (e.isFile()) {
        const st = fs.statSync(abs);
        if (ignoredPid !== undefined && base === 'registry/instances' && e.name.endsWith('.json')) {
          let pid: unknown;
          try {
            pid = (JSON.parse(fs.readFileSync(abs, 'utf8')) as { pid?: unknown }).pid;
          } catch {
            pid = undefined; /* parse failure: never ignored */
          }
          if (pid === ignoredPid) continue;
        }
        out.push(`${rel}=${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}:${st.size}`);
      }
    }
  };
  const lines: string[] = [];
  walk(root, '', lines);
  lines.sort();
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

function retentionRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-retention-wire-'));
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
  return dir;
}

function retentionJobRecord(jobId: string, status: string, endedAt: string | null): string {
  return JSON.stringify({
    jobId,
    sessionId: `s-${jobId}`,
    kind: 'start',
    replyToJobId: null,
    profile: 'auto',
    port: 15721,
    permissionMode: 'auto',
    parallelism: 'auto',
    workFolder: `wf-${jobId}`,
    maxRuntimeMinutes: 120,
    pid: null,
    supervisorPid: null,
    status,
    substatus: null,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt,
    lastActivityAt: '2026-08-01T00:00:00.000Z',
    exitCode: null,
    logPath: 'ignored',
    stderrLogPath: 'ignored',
    reportPath: 'ignored',
    prompt: `SECRET-PROMPT-${jobId}`,
    lastOutputAt: null,
  });
}

function retentionRegistryRecord(instanceId: string, pid: number, hbAgeMs: number): string {
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  return JSON.stringify({
    schemaVersion: 1,
    instanceId,
    pid,
    hostPid: null,
    processStartedAt: old,
    serverStartedAt: old,
    entry: 'index.js',
    buildFingerprint: 'fp',
    lastHeartbeatAt: new Date(Date.now() - hbAgeMs).toISOString(),
    version: '1.0.0',
  });
}

function retentionMkfile(dir: string, rel: string, content: string, ageMs: number): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  fs.utimesSync(abs, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
}

/** Runtime with a deterministic candidate set (sorted by (action, relativePath)):
 *  archive_claim_candidate c1.recover, archive_registry r1, archive_settings_candidate s1,
 *  truncate_log_candidate l1.log + l1.stderr.log. Plus keeps: fresh l2.log, live registry h1. */
function seedRetentionRuntime(root: string): void {
  const D = 24 * 60 * 60 * 1000;
  retentionMkfile(root, 'jobs/l1.json', retentionJobRecord('l1', 'succeeded', new Date(Date.now() - 20 * D).toISOString()), 20 * D);
  retentionMkfile(root, 'logs/l1.log', 'log content', 20 * D);
  retentionMkfile(root, 'logs/l1.stderr.log', 'err', 20 * D);
  retentionMkfile(root, 'jobs/l2.json', retentionJobRecord('l2', 'succeeded', new Date(Date.now() - 20 * D).toISOString()), 20 * D);
  retentionMkfile(root, 'logs/l2.log', 'fresh log', D); // fresh: keep
  retentionMkfile(root, 'jobs/s1.json', retentionJobRecord('s1', 'failed', new Date(Date.now() - 20 * D).toISOString()), 20 * D);
  retentionMkfile(root, 'settings/s1.json', '{}', 20 * D);
  retentionMkfile(root, 'jobs/c1.json', retentionJobRecord('c1', 'failed', new Date(Date.now() - 20 * D).toISOString()), 20 * D);
  retentionMkfile(root, 'claims/c1.recover.json', '{}', 20 * D);
  retentionMkfile(root, 'registry/instances/r1.json', retentionRegistryRecord('r1', 912001, 10 * D), 400 * D);
  // Live registry record (pid not alive): keep by identity rules.
  retentionMkfile(root, 'registry/instances/h1.json', retentionRegistryRecord('h1', 912002, 5000), 400 * D);
  // Out-of-scope content that must never surface: report body + secret prompt.
  retentionMkfile(root, 'reports/l1.json', '{"secret":"report body"}', 20 * D);
  retentionMkfile(root, 'reports/l1.md', 'report markdown', 20 * D);
}

interface PreviewItem {
  relativePath: string;
  action: string;
  kind: string;
  fixedReason: string;
  ageMs: number | null;
  bytes: number;
  jobId?: string;
}

interface PreviewResult {
  enabled: boolean;
  dryRun: boolean;
  items: PreviewItem[];
  nextCursor: string | null;
  candidateCount: number;
  returnedCount: number;
  limit: number;
  totals: { counts: Record<string, number>; bytes: Record<string, number> };
}

function previewResult(proc: ChildProcess, id: number, args: Record<string, unknown>): Promise<PreviewResult> {
  return rpc(proc, {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'claude_code_retention_preview', arguments: args },
  }).then((call) => {
    const res = call.result as { isError?: boolean; content?: Array<{ type: string; text: string }> };
    if (res?.isError) throw new Error(`preview rejected: ${res.content?.[0]?.text ?? 'unknown'}`);
    assert.ok(res?.content?.[0]?.text, 'preview must return text');
    return JSON.parse(res.content[0].text) as PreviewResult;
  });
}

test('Wave5B2 tools/list exposes claude_code_retention_preview with a read-only description', async () => {
  const proc = await startServer();
  try {
    await initProtocol(proc);
    const list = await rpc(proc, { jsonrpc: '2.0', id: 200, method: 'tools/list', params: {} });
    const tools = (list.result as { tools: Array<{ name: string; description: string; inputSchema: Record<string, any> }> }).tools;
    const prev = tools.find((t) => t.name === 'claude_code_retention_preview');
    assert.ok(prev, 'claude_code_retention_preview is listed');
    const desc = prev!.description.toLowerCase();
    assert.ok(desc.includes('dry-run'), 'description names a dry-run');
    assert.ok(desc.includes('read-only'), 'description names read-only');
    assert.ok(desc.includes('never mutates'), 'description states never mutates');
    assert.ok(!desc.includes(' apply '), 'description must not advertise an apply capability');
    assert.ok(!desc.includes('apply/'), 'description must not advertise an apply capability');
    assert.ok(!desc.includes('delet'), 'description must not advertise a delete capability');
    assert.ok(!desc.includes('cleanup'), 'description must not advertise a cleanup capability');
    const schema = prev!.inputSchema;
    const props = schema.properties as Record<string, any>;
    assert.equal(props.limit.type, 'integer');
    assert.equal(props.limit.minimum, 1);
    assert.equal(props.limit.maximum, 500);
    assert.equal(props.cursor.type, 'string', 'cursor is a non-negative integer STRING');
    assert.equal(props.includeKeep.type, 'boolean');
    for (const k of [
      'succeededLogTtlDays',
      'failedLogTtlDays',
      'needsAttentionLogTtlDays',
      'terminalClaimSettingsTtlDays',
      'staleRegistryTtlDays',
    ]) {
      assert.ok(props[k], `TTL override ${k} is declared`);
      assert.equal(props[k].type, 'integer');
      assert.equal(props[k].minimum, 1);
      assert.equal(props[k].maximum, 365);
    }
    assert.ok(!(schema.required ?? []).includes('limit'), 'limit is optional');
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 retention flag OFF: no runtime scan, zeroed totals, no mutation', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '0' });
  try {
    await initProtocol(proc);
    // The running server's own registry heartbeat file is dynamic; pin it by
    // pid so the manifest stays a stable zero-change witness for preview.
    const manifestBefore = retentionManifest(root, proc.pid);
    const r = await previewResult(proc, 201, {});
    assert.equal(r.enabled, false, 'flag off -> enabled:false');
    assert.equal(r.dryRun, true, 'always a dry run');
    assert.deepEqual(r.items, [], 'flag off -> no items');
    assert.equal(r.nextCursor, null);
    assert.equal(r.candidateCount, 0);
    assert.equal(r.returnedCount, 0);
    assert.equal(r.limit, 200, 'default limit');
    for (const action of ['archive_registry', 'truncate_log_candidate', 'archive_claim_candidate', 'archive_settings_candidate', 'keep', 'skip']) {
      assert.equal(r.totals.counts[action], 0, `${action} count is 0`);
      assert.equal(r.totals.bytes[action], 0, `${action} bytes are 0`);
    }
    const manifestAfter = retentionManifest(root, proc.pid);
    assert.equal(manifestAfter, manifestBefore, 'flag off must not touch the runtime tree');
    // The server itself must also not have created anything (no ensureRuntimeDirs).
    assert.deepEqual(fs.readdirSync(root), ['jobs', 'logs', 'reports', 'settings', 'claims', 'registry'].sort(), 'no directories beyond the seeded tree');
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 retention flag ON: only the four candidate actions by default', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    const r = await previewResult(proc, 202, {});
    assert.equal(r.enabled, true);
    assert.equal(r.dryRun, true);
    const actions = r.items.map((i) => i.action);
    assert.deepEqual(new Set(actions), new Set(['archive_claim_candidate', 'archive_registry', 'archive_settings_candidate', 'truncate_log_candidate']), 'only the four candidate actions, no keeps');
    const paths = r.items.map((i) => i.relativePath).sort();
    assert.deepEqual(paths, [
      'claims/c1.recover.json',
      'registry/instances/r1.json',
      'settings/s1.json',
      'logs/l1.log',
      'logs/l1.stderr.log',
    ].sort(), 'exactly the four candidate files');
    // The deterministic planner order is (action, relativePath): assert the
    // action sequence is sorted rather than hard-coding the sort.
    const actionSeq = r.items.map((i) => i.action);
    assert.deepEqual(actionSeq, [...actionSeq].sort(), 'items arrive in deterministic (action) order');
    assert.equal(r.nextCursor, null, 'one page covers every candidate');
    assert.equal(r.candidateCount, 5);
    assert.equal(r.returnedCount, 5);
    assert.equal(r.totals.counts.archive_registry, 1, 'totals reflect the FULL plan');
    assert.equal(r.totals.counts.truncate_log_candidate, 2);
    assert.equal(r.totals.counts.archive_claim_candidate, 1);
    assert.equal(r.totals.counts.archive_settings_candidate, 1);
    assert.equal(r.totals.counts.keep, 3, 'keeps are counted in totals even when not returned (fresh log, live h1, server self heartbeat)');
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 includeKeep=true returns keep/skip items alongside candidates', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    const r = await previewResult(proc, 203, { includeKeep: true });
    assert.equal(r.enabled, true);
    const actions = r.items.map((i) => i.action);
    assert.ok(actions.includes('keep'), 'keeps are included when includeKeep=true');
    const keepPaths = r.items.filter((i) => i.action === 'keep').map((i) => i.relativePath);
    assert.ok(keepPaths.includes('logs/l2.log'), 'fresh log keep is listed');
    assert.ok(keepPaths.includes('registry/instances/h1.json'), 'live registry keep is listed');
    // Only the known fixed set of actions is ever emitted.
    for (const i of r.items) {
      assert.ok(['archive_registry', 'truncate_log_candidate', 'archive_claim_candidate', 'archive_settings_candidate', 'keep', 'skip'].includes(i.action), `unknown action ${i.action}`);
    }
    // candidateCount counts only the five candidates; keeps ride along in items.
    assert.equal(r.candidateCount, 5, 'candidateCount does not include the keeps');
    assert.equal(r.returnedCount, 8, 'includeKeep returns all 5 candidates plus all 3 keeps');
    assert.equal(r.items.length, 8, 'one page covers all 8 items');
    // The running server's own instance-registry heartbeat (pid === proc.pid)
    // is a live record, so it surfaces as a third keep.
    const instancesDir = path.join(root, 'registry', 'instances');
    const selfName = fs.readdirSync(instancesDir)
      .filter((f) => f.endsWith('.json'))
      .find((f) => {
        let pid: unknown;
        try {
          pid = (JSON.parse(fs.readFileSync(path.join(instancesDir, f), 'utf8')) as { pid?: unknown }).pid;
        } catch {
          pid = undefined;
        }
        return pid === proc.pid;
      });
    assert.ok(selfName, 'server self-heartbeat registry file exists');
    assert.ok(keepPaths.includes(`registry/instances/${selfName}`), 'the server self heartbeat is classified as a keep');
    assert.equal(r.totals.counts.keep, 3, 'totals count all three keeps');
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 pagination: three pages reconstruct the full candidate list with no duplication', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    // Snapshot each page INDEPENDENTLY — ageMs is now-relative, so comparing
    // pages across separate calls must ignore ageMs; only identity fields
    // (relativePath/action/kind/fixedReason/bytes/jobId) must line up.
    const snapshot = (r: PreviewResult): Array<Omit<PreviewItem, 'ageMs'>> =>
      r.items.map((i) => {
        const { ageMs, ...rest } = i;
        void ageMs;
        return rest;
      });
    const first = await previewResult(proc, 205, { limit: 2 });
    assert.equal(first.returnedCount, 2);
    assert.equal(first.nextCursor, '2');
    assert.equal(first.candidateCount, 5, 'candidateCount is page-independent');
    const second = await previewResult(proc, 206, { limit: 2, cursor: '2' });
    assert.equal(second.nextCursor, '4');
    const third = await previewResult(proc, 207, { limit: 2, cursor: '4' });
    assert.equal(third.nextCursor, null, 'no nextCursor past the last candidate');
    const assembled = [...snapshot(first), ...snapshot(second), ...snapshot(third)];
    // The full ordered candidate set, sorted by (action, relativePath).
    const expected = [
      { relativePath: 'claims/c1.recover.json', kind: 'claim', action: 'archive_claim_candidate', fixedReason: 'terminal_failed', bytes: 2, jobId: 'c1' },
      { relativePath: 'registry/instances/r1.json', kind: 'registry', action: 'archive_registry', fixedReason: 'pid_not_found', bytes: 262 },
      { relativePath: 'settings/s1.json', kind: 'settings', action: 'archive_settings_candidate', fixedReason: 'terminal_failed', bytes: 2, jobId: 's1' },
      { relativePath: 'logs/l1.log', kind: 'log', action: 'truncate_log_candidate', fixedReason: 'terminal_succeeded', bytes: 11, jobId: 'l1' },
      { relativePath: 'logs/l1.stderr.log', kind: 'stderr_log', action: 'truncate_log_candidate', fixedReason: 'terminal_succeeded', bytes: 3, jobId: 'l1' },
    ];
    assert.deepEqual(assembled, expected, 'assembled pages match the full ordered candidate list');
    assert.equal(new Set(assembled.map((i) => i.relativePath)).size, assembled.length, 'no duplicate paths across pages');
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 TTL overrides are accepted and change the plan', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    // staleRegistryTtlDays=90: r1's heartbeat is only 10d stale, so it stops
    // being a candidate. totals is the complete plan computed WITH the
    // override applied, not the pre-override plan.
    const r = await previewResult(proc, 208, { staleRegistryTtlDays: 90 });
    assert.equal(r.enabled, true);
    const paths = r.items.map((i) => i.relativePath);
    assert.ok(!paths.includes('registry/instances/r1.json'), '90d TTL excludes the 10d-stale record');
    assert.ok(paths.includes('logs/l1.log'), 'log candidates remain');
    assert.equal(r.candidateCount, 4, 'candidateCount reflects the overridden plan');
    assert.equal(r.totals.counts.archive_registry, 0, 'totals are the complete plan after the override');
    assert.equal(r.totals.counts.truncate_log_candidate, 2);
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 TTL override boundary and invalid limit/cursor are rejected over the wire', async () => {
  const proc = await startServer({ ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    for (const [id, args] of [
      [209, { limit: 0 }],
      [210, { limit: 501 }],
      [211, { limit: 1.5 }],
      [212, { staleRegistryTtlDays: 0 }],
      [213, { staleRegistryTtlDays: 366 }],
    ] as const) {
      const call = await rpc(proc, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'claude_code_retention_preview', arguments: { ...args } },
      });
      const result = call.result as { isError?: boolean } | undefined;
      assert.ok(call.error !== undefined || result?.isError === true, `args ${JSON.stringify(args)} must be rejected`);
    }
    // Boundary values are accepted: limit 1/500, TTL 1/365.
    const ok = await previewResult(proc, 214, { limit: 500, staleRegistryTtlDays: 1, succeededLogTtlDays: 365 });
    assert.equal(ok.enabled, true);
    assert.equal(ok.limit, 500);
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 invalid cursor is a fixed error; valid cursors work', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    for (const [id, bad] of [
      [215, 'x'],
      [216, '1.5'],
      [217, '-1'],
      [218, '1e3'],
    ] as const) {
      const call = await rpc(proc, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'claude_code_retention_preview', arguments: { cursor: bad } },
      });
      const result = call.result as { isError?: boolean; content?: Array<{ text: string }> } | undefined;
      assert.ok(call.error !== undefined || result?.isError === true, `cursor ${bad} must be rejected`);
      const text = call.error?.message ?? result?.content?.[0]?.text ?? '';
      assert.ok(text.includes('invalid cursor'), `cursor ${bad} must carry the fixed invalid-cursor error`);
    }
    // Cursor "0" is legal and identical to omitting it. ageMs is now-relative,
    // so normalize it away for the equality, then assert it per item.
    const normalize = (r: PreviewResult): Array<Omit<PreviewItem, 'ageMs'>> =>
      r.items.map((i) => {
        const { ageMs, ...rest } = i;
        void ageMs;
        return rest;
      });
    const at0 = await previewResult(proc, 219, { cursor: '0' });
    const noCursor = await previewResult(proc, 220, {});
    assert.deepEqual(normalize(at0), normalize(noCursor), 'cursor 0 equals no cursor');
    for (const i of [...at0.items, ...noCursor.items]) {
      assert.ok(i.ageMs !== null && Number.isInteger(i.ageMs) && i.ageMs >= 0, `ageMs must be a non-negative integer, got ${i.ageMs}`);
    }
    // A cursor past the end yields an empty page with nextCursor null.
    const past = await previewResult(proc, 221, { cursor: '999' });
    assert.deepEqual(past.items, [], 'cursor past the end is an empty page');
    assert.equal(past.nextCursor, null);
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 output never leaks runtime root, PIDs, heartbeats, prompts, env or file content', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    const r = await previewResult(proc, 222, { includeKeep: true });
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(root), 'absolute runtime root must never leak');
    assert.ok(!serialized.includes('912001') && !serialized.includes('912002'), 'PIDs must never leak');
    assert.ok(!serialized.includes('lastHeartbeatAt'), 'heartbeat records must never leak');
    assert.ok(!serialized.includes('SECRET-PROMPT'), 'prompt content must never leak');
    assert.ok(!serialized.includes('report body') && !serialized.includes('report markdown'), 'report bodies must never be read');
    assert.ok(!serialized.includes('ORCHESTRATOR_RETENTION_V2'), 'env values must never leak');
    assert.ok(!serialized.includes('log content'), 'file content must never leak');
    for (const i of r.items) {
      assert.ok(!i.relativePath.startsWith('/') && !i.relativePath.includes('\\') && !i.relativePath.includes('..'), `unsafe relativePath ${i.relativePath}`);
      assert.ok(i.relativePath.startsWith('logs/') || i.relativePath.startsWith('settings/') || i.relativePath.startsWith('claims/') || i.relativePath.startsWith('registry/'), `out-of-scope relativePath ${i.relativePath}`);
    }
  } finally {
    killServer(proc);
  }
});

test('Wave5B2 tool calls leave the runtime tree byte-identical and create no files', async () => {
  const root = retentionRoot();
  seedRetentionRuntime(root);
  const listingBefore = fs.readdirSync(root).sort();
  const proc = await startServer({ ORCHESTRATOR_RUNTIME: root, ORCHESTRATOR_RETENTION_V2: '1' });
  try {
    await initProtocol(proc);
    // The server's own self-heartbeat registry file is the one file it
    // rewrites while running; pin it by pid so the manifest is a stable
    // zero-change witness across the preview calls below.
    const manifestBefore = retentionManifest(root, proc.pid);
    await previewResult(proc, 223, {});
    await previewResult(proc, 224, { includeKeep: true, limit: 2 });
    await previewResult(proc, 225, { cursor: '1', staleRegistryTtlDays: 30 });
    const manifestAfter = retentionManifest(root, proc.pid);
    assert.equal(manifestAfter, manifestBefore, 'runtime tree changed after preview calls');
    assert.deepEqual(fs.readdirSync(root).sort(), listingBefore, 'no new top-level entries after preview calls');
    const serverEnvCheck = await rpc(proc, {
      jsonrpc: '2.0',
      id: 226,
      method: 'tools/call',
      params: { name: 'claude_code_health', arguments: {} },
    });
    const health = serverEnvCheck.result as { content?: Array<{ text: string }> };
    const healthText = JSON.stringify(health);
    assert.ok(healthText.includes('claude_code_retention_preview'), 'health capabilities list the new tool automatically');
  } finally {
    killServer(proc);
  }
});
