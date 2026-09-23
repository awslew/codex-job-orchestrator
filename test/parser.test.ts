// Unit tests for the shared incremental line-buffer parser. The critical case:
// a single stream-json event split across arbitrary chunk boundaries must be
// reassembled without loss — the old supervisor parser dropped exactly these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  LineParser,
  parseLine,
  sanitizePermission,
  genericAttentionSummary,
  toAttentionSnapshot,
  type AttentionSnapshot,
  type AttentionSummary,
} from '../src/parser.js';

const ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] },
});

test('a JSON event split in the middle of a chunk is reassembled without loss', () => {
  const p = new LineParser();
  const mid = Math.floor(ASSISTANT.length / 2);
  // First half has no newline -> nothing complete yet.
  assert.deepEqual(p.feed(ASSISTANT.slice(0, mid)), []);
  const lines = p.feed(ASSISTANT.slice(mid) + '\n');
  assert.equal(lines.length, 1);
  const ev = parseLine(lines[0]);
  assert.equal(ev.type, 'assistant');
  assert.ok(ev.type === 'assistant');
  assert.equal(ev.text, 'hello world');
});

test('an event fed one character at a time is still reassembled once', () => {
  const p = new LineParser();
  let lines: string[] = [];
  for (let i = 0; i < ASSISTANT.length; i++) lines.push(...p.feed(ASSISTANT[i]));
  lines.push(...p.feed('\n'));
  lines.push(...p.flush());
  const assistants = lines.map(parseLine).filter((e) => e.type === 'assistant');
  assert.equal(assistants.length, 1);
});

test('raw non-JSON lines interleaved with JSON events are preserved, not dropped', () => {
  const p = new LineParser();
  const lines = p.feed(`plain log line\n${ASSISTANT}\n`);
  assert.equal(lines.length, 2);
  assert.equal(parseLine(lines[0]).type, 'raw');
  assert.equal(parseLine(lines[1]).type, 'assistant');
});

test('flush returns a trailing partial line and clears the buffer', () => {
  const p = new LineParser();
  p.feed('{"type":"result","result":"partial'); // no newline, JSON incomplete
  const flushed = p.flush();
  assert.equal(flushed.length, 1, 'the partial line must not be dropped');
  // An incomplete JSON line can't be parsed; it is surfaced as `raw` (never
  // silently discarded). Mid-stream, the next feed completes it — see the
  // chunk-split tests. flush only runs at end-of-stream.
  assert.equal(parseLine(flushed[0]).type, 'raw');
  assert.equal(p.flush().length, 0);
});

test('empty lines and empty feeds are handled without throwing', () => {
  const p = new LineParser();
  assert.deepEqual(p.feed(''), []);
  assert.deepEqual(p.feed('\n'), ['']);
  assert.deepEqual(p.flush(), []);
});

test('tool_use blocks are extracted, inputs truncated for display', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'doing…' },
        { type: 'tool_use', name: 'Bash', input: { command: 'x'.repeat(500) } },
      ],
    },
  });
  const ev = parseLine(line);
  assert.equal(ev.type, 'assistant');
  assert.ok(ev.type === 'assistant');
  assert.equal(ev.text, 'doing…');
  assert.equal(ev.toolUses.length, 1);
  assert.equal(ev.toolUses[0].name, 'Bash');
  assert.ok(ev.toolUses[0].input.length <= 200, 'tool input must be truncated');
});

test('result events carry the final result string', () => {
  const ev = parseLine(JSON.stringify({ type: 'result', subtype: 'success', result: 'DONE' }));
  assert.equal(ev.type, 'result');
  assert.ok(ev.type === 'result' && ev.result === 'DONE');
});

test('userPrompt events are surfaced', () => {
  const ev = parseLine(JSON.stringify({ type: 'userPrompt', prompt: 'Approval needed' }));
  assert.equal(ev.type, 'userPrompt');
});

// ---------------------------------------------------------------------------
// Permission attention sanitizer (Stage 1).
// ---------------------------------------------------------------------------

const AT = '2026-08-12T00:00:00.000Z';

test('Bash permission event -> structured tool/action/path/risk/requestId', () => {
  const s = sanitizePermission(
    {
      id: 'up-bash',
      prompt: 'Claude needs your permission to use Bash.\nCommand: rm C:\\work\\probe.txt\nDo you want to proceed?',
      data: { permissionMode: 'auto' },
    },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.tool, 'Bash');
  assert.equal(s.action, 'delete');
  assert.equal(s.path, path.join('probe.txt'));
  assert.equal(s.risk, 'high');
  assert.equal(s.requestId, 'up-bash');
  assert.equal(s.requestIdSource, 'upstream');
  assert.equal(s.at, AT);
  assert.ok(s.message.length > 0);
  assert.ok(!s.message.includes('Do you want to proceed'), 'prompt text must not leak into message');
});

test('Read permission event -> structured tool/action/path/risk', () => {
  const s = sanitizePermission(
    { id: 'up-read', prompt: 'Claude needs your permission to use Read.\nPath: C:\\work\\config.json', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.tool, 'Read');
  assert.equal(s.action, 'read');
  assert.equal(s.path, 'config.json');
  assert.equal(s.risk, 'low');
});

test('Edit permission event -> structured tool/action/path/risk', () => {
  const s = sanitizePermission(
    { id: 'up-edit', prompt: 'Claude needs your permission to use Edit.\nPath: C:\\work\\app.ts', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.tool, 'Edit');
  assert.equal(s.action, 'edit');
  assert.equal(s.path, 'app.ts');
  assert.equal(s.risk, 'medium');
});

test('Agent permission event -> structured tool/action/risk, no path', () => {
  const s = sanitizePermission(
    { id: 'up-agent', prompt: 'Claude needs your permission to use Agent. Do you want to proceed?', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.tool, 'Agent');
  assert.equal(s.action, 'spawn');
  assert.equal(s.path, null);
  assert.equal(s.risk, 'medium');
});

test('requestId: upstream id stable across events; local ids are unique and marked local', () => {
  const a1 = sanitizePermission({ id: 'same-id', prompt: 'x' }, { at: AT });
  const a2 = sanitizePermission({ id: 'same-id', prompt: 'x' }, { at: AT });
  assert.equal(a1.requestId, 'same-id');
  assert.equal(a2.requestId, 'same-id');
  assert.equal(a1.requestIdSource, 'upstream');
  const b1 = sanitizePermission({ prompt: 'x' }, { at: AT });
  const b2 = sanitizePermission({ prompt: 'x' }, { at: AT });
  assert.equal(b1.requestIdSource, 'local');
  assert.equal(b2.requestIdSource, 'local');
  assert.notEqual(b1.requestId, b2.requestId, 'different requests get different local ids');
  assert.ok(b1.requestId.startsWith('local-'));
  assert.ok(b1.requestId.length <= 64, 'local requestId is length-bounded');
});

test('home absolute paths, tokens and prompt text are never leaked; path becomes basename', () => {
  const s = sanitizePermission(
    {
      id: 'up-home',
      prompt: 'Claude needs your permission to use Read.\nPath: C:\\Users\\testuser\\.ssh\\id_rsa\nToken: sk-secret-123\nDo you want to proceed?',
      data: {},
    },
    { workFolder: 'C:\\work', at: AT },
  );
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('C:\\Users'), 'home full path must not leak');
  assert.ok(!raw.includes('sk-secret-123'), 'secret token must not leak');
  assert.ok(!raw.includes('Do you want to proceed'), 'prompt text must not leak');
  assert.ok(!raw.includes('Token:'), 'prompt label must not leak');
  assert.equal(s.path, 'id_rsa', 'outside the work folder only the basename is shown');
});

test('paths inside the work folder are returned work-folder-relative', () => {
  const s = sanitizePermission(
    { id: 'up-rel', prompt: 'Claude needs your permission to use Edit.\nPath: C:\\work\\src\\deep\\file.ts', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.path, path.join('src', 'deep', 'file.ts'));
});

test('unknown / non-whitelisted tools degrade to unknown with a safe generic message', () => {
  const s = sanitizePermission(
    { id: 'up-unk', prompt: 'Claude needs your permission to use TotallyUnknownTool.\nPath: C:\\work\\sub\\file.txt', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.equal(s.tool, 'unknown');
  assert.equal(s.path, path.join('sub', 'file.txt'));
  assert.ok(s.message.includes('需要审批'));
  assert.ok(s.message.length <= 200);
});

test('malformed / absent permission degrades to unknown + safe generic message, never raw payload', () => {
  const s = sanitizePermission(undefined, { at: AT });
  assert.equal(s.tool, 'unknown');
  assert.equal(s.action, 'unknown');
  assert.equal(s.path, null);
  assert.equal(s.risk, 'unknown');
  assert.equal(s.requestIdSource, 'local');
  assert.ok(s.message.length > 0);
  assert.ok(!JSON.stringify(s).includes('undefined'));

  const g = genericAttentionSummary({ at: AT });
  assert.equal(g.tool, 'unknown');
  assert.equal(g.action, 'unknown');
  assert.equal(g.risk, 'unknown');
  assert.equal(g.path, null);
  assert.ok(g.requestId.startsWith('local-'));
});

test('requestId length is bounded even for a malicious upstream id', () => {
  const s = sanitizePermission({ id: 'x'.repeat(500), prompt: '' }, { at: AT });
  assert.ok(s.requestId.length <= 80);
  assert.equal(s.requestIdSource, 'upstream');
});

test('parseLine surfaces structured permission fields on userPrompt events', () => {
  const ev = parseLine(
    JSON.stringify({ type: 'userPrompt', id: 'up-1', prompt: 'Approval needed', data: { permissionMode: 'auto' } }),
  );
  assert.equal(ev.type, 'userPrompt');
  assert.ok(ev.type === 'userPrompt');
  assert.equal(ev.permission?.id, 'up-1');
  assert.equal(ev.permission?.prompt, 'Approval needed');
});

test('a realistic userPrompt line flows end-to-end into a sanitized summary', () => {
  const line = JSON.stringify({
    type: 'userPrompt',
    id: 'fake-prompt-1',
    prompt: 'Claude needs your permission to use Bash.\nCommand: rm C:\\work\\probe.txt\nDo you want to proceed?',
    data: { permissionMode: 'auto' },
  });
  const ev = parseLine(line);
  assert.ok(ev.type === 'userPrompt' && ev.permission);
  const s: AttentionSummary = sanitizePermission(ev.permission, { workFolder: 'C:\\work', at: AT });
  assert.equal(s.tool, 'Bash');
  assert.equal(s.action, 'delete');
  assert.equal(s.path, 'probe.txt');
  assert.equal(s.risk, 'high');
  assert.equal(s.requestId, 'fake-prompt-1');
  assert.equal(s.requestIdSource, 'upstream');
});

test('path sanitization without a workFolder never leaks absolute/home prefixes', () => {
  // Windows absolute path, no workFolder -> basename only, no home prefix.
  const s1 = sanitizePermission(
    { id: 'u1', prompt: 'Claude needs your permission to use Read.\nPath: C:\\Users\\testuser\\.ssh\\id_rsa', data: {} },
    { at: AT },
  );
  assert.equal(s1.path, 'id_rsa');
  const raw1 = JSON.stringify(s1);
  assert.ok(!raw1.includes('C:\\Users'), 'Windows home prefix must not leak');
  assert.ok(!raw1.includes('testuser'), 'username must not leak');

  // POSIX absolute path, no workFolder -> basename only.
  const s2 = sanitizePermission(
    { id: 'u2', prompt: 'Claude needs your permission to use Read.\nPath: /etc/shadow', data: {} },
    { at: AT },
  );
  assert.equal(s2.path, 'shadow');
  assert.ok(!JSON.stringify(s2).includes('/etc'), 'POSIX absolute prefix must not leak');

  // Tilde path, no workFolder -> basename only.
  const s3 = sanitizePermission(
    { id: 'u3', prompt: 'Claude needs your permission to use Read.\nPath: ~/private/notes.txt', data: {} },
    { at: AT },
  );
  assert.equal(s3.path, 'notes.txt');

  // A relative token is already minimal and is kept as-is.
  const s4 = sanitizePermission(
    { id: 'u4', prompt: 'Claude needs your permission to use Edit.\nPath: probe.txt', data: {} },
    { at: AT },
  );
  assert.equal(s4.path, 'probe.txt');
});

test('an empty/invalid workFolder still collapses absolute paths to basename', () => {
  const s = sanitizePermission(
    { id: 'u5', prompt: 'Claude needs your permission to use Read.\nPath: C:\\Users\\testuser\\.env', data: {} },
    { workFolder: '', at: AT },
  );
  assert.equal(s.path, '.env');
  const raw = JSON.stringify(s);
  assert.ok(!raw.includes('C:\\Users'), 'Windows home prefix must not leak');
  assert.ok(!raw.includes('testuser'), 'username must not leak');
});

// ---------------------------------------------------------------------------
// Structured permission/control events (control_request / permission_request).
// ---------------------------------------------------------------------------

test('top-level structured control_request surfaces upstream requestId + permission/tool/action/path/risk', () => {
  const ev = parseLine(
    JSON.stringify({
      type: 'control_request',
      requestId: 'ctrl-001',
      tool: 'Bash',
      action: 'run',
      path: 'C:\\work\\scripts\\deploy.sh',
    }),
  );
  assert.equal(ev.type, 'userPrompt');
  assert.ok(ev.type === 'userPrompt' && ev.permission);
  assert.equal(ev.permission.id, 'ctrl-001');
  const s = sanitizePermission(ev.permission, { workFolder: 'C:\\work', at: AT });
  assert.equal(s.requestId, 'ctrl-001');
  assert.equal(s.requestIdSource, 'upstream');
  assert.equal(s.tool, 'Bash');
  assert.equal(s.action, 'run');
  assert.equal(s.path, path.join('scripts', 'deploy.sh'));
  assert.equal(s.risk, 'medium');
  assert.equal(s.at, AT);
  assert.ok(s.message.includes('需要审批'));
});

test('structured permission_request carries nested permission/toolUse metadata through wrappers', () => {
  const ev = parseLine(
    JSON.stringify({
      type: 'permission_request',
      requestId: 'perm-042',
      request: {
        permission: { tool: 'Read', input: { file_path: 'C:\\work\\config.json' } },
        details: { action: 'read' },
      },
    }),
  );
  assert.ok(ev.type === 'userPrompt' && ev.permission);
  const s = sanitizePermission(ev.permission, { workFolder: 'C:\\work', at: AT });
  assert.equal(s.requestId, 'perm-042');
  assert.equal(s.requestIdSource, 'upstream');
  assert.equal(s.tool, 'Read');
  assert.equal(s.action, 'read');
  assert.equal(s.path, 'config.json');
  assert.equal(s.risk, 'low');
});

test('nested permission/tool metadata descends supported conservative wrappers (data/payload/toolUse name)', () => {
  const ev = parseLine(
    JSON.stringify({
      type: 'permission_request',
      requestId: 'nest-7',
      request: {
        permission: {
          data: {
            payload: {
              toolUse: { name: 'Edit', input: { path: 'C:\\work\\src\\app.ts' } },
              operation: 'edit',
            },
          },
        },
      },
    }),
  );
  assert.ok(ev.type === 'userPrompt' && ev.permission);
  const s = sanitizePermission(ev.permission, { workFolder: 'C:\\work', at: AT });
  assert.equal(s.requestId, 'nest-7');
  assert.equal(s.requestIdSource, 'upstream');
  assert.equal(s.tool, 'Edit');
  assert.equal(s.action, 'edit');
  assert.equal(s.path, path.join('src', 'app.ts'));
  assert.equal(s.risk, 'medium');
});

test('two different upstream requestIds remain distinct across control_request events', () => {
  const ev1 = parseLine(
    JSON.stringify({
      type: 'control_request',
      requestId: 'cr-111',
      request: { permission: { tool: 'Read', action: 'read', path: 'C:\\work\\a.txt' } },
    }),
  );
  const ev2 = parseLine(
    JSON.stringify({
      type: 'control_request',
      requestId: 'cr-222',
      request: { permission: { tool: 'Read', action: 'read', path: 'C:\\work\\b.txt' } },
    }),
  );
  assert.ok(ev1.type === 'userPrompt' && ev1.permission);
  assert.ok(ev2.type === 'userPrompt' && ev2.permission);
  const s1 = sanitizePermission(ev1.permission, { workFolder: 'C:\\work', at: AT });
  const s2 = sanitizePermission(ev2.permission, { workFolder: 'C:\\work', at: AT });
  assert.notEqual(s1.requestId, s2.requestId);
  assert.equal(s1.requestId, 'cr-111');
  assert.equal(s2.requestId, 'cr-222');
  assert.equal(s1.requestIdSource, 'upstream');
  assert.equal(s2.requestIdSource, 'upstream');
});

test('structured events without an upstream requestId fall back to distinct local ids', () => {
  const ev1 = parseLine(
    JSON.stringify({
      type: 'control_request',
      request: { permission: { tool: 'Read', action: 'read', path: 'a.txt' } },
    }),
  );
  const ev2 = parseLine(
    JSON.stringify({
      type: 'control_request',
      request: { permission: { tool: 'Read', action: 'read', path: 'b.txt' } },
    }),
  );
  assert.ok(ev1.type === 'userPrompt' && ev1.permission);
  assert.ok(ev2.type === 'userPrompt' && ev2.permission);
  const s1 = sanitizePermission(ev1.permission, { at: AT });
  const s2 = sanitizePermission(ev2.permission, { at: AT });
  assert.equal(s1.requestIdSource, 'local');
  assert.equal(s2.requestIdSource, 'local');
  assert.notEqual(s1.requestId, s2.requestId);
  assert.ok(s1.requestId.startsWith('local-'));
});

test('ordinary banner/text-only JSON or non-structured text does not parse as permission', () => {
  const textEv = parseLine('plain log line: starting server');
  assert.equal(textEv.type, 'raw');

  const noType = parseLine(JSON.stringify({ message: 'banner text only', level: 'info' }));
  assert.equal(noType.type, 'raw');

  const bannerEv = parseLine(JSON.stringify({ type: 'system', subtype: 'banner', message: 'Claude Code 2.0.1' }));
  const bannerIsUserPrompt = bannerEv.type === 'userPrompt';
  assert.equal(bannerEv.type, 'other');
  assert.equal(bannerIsUserPrompt, false);

  const resultEv = parseLine(JSON.stringify({ type: 'result', result: 'ok' }));
  const resultIsUserPrompt = resultEv.type === 'userPrompt';
  assert.equal(resultEv.type, 'result');
  assert.equal(resultIsUserPrompt, false);
});

test('prompt/token/raw payload/full command/env/key-like nested values never reach the sanitized summary', () => {
  const ev = parseLine(
    JSON.stringify({
      type: 'control_request',
      requestId: 'cr-leak',
      prompt: 'Claude needs your permission to use Bash.\nCommand: echo sk-live-leak-999\nDo you want to proceed?',
      request: {
        permission: {
          tool: 'Bash',
          action: 'run',
          input: {
            command: "curl -H 'Authorization: Bearer sk-live-leak-999' https://example.com/api",
            env: { API_KEY: 'sk-env-secret-777', HOME: 'C:\\Users\\testuser' },
            api_key: 'sk-field-secret-888',
            token: 'tok-secret-12345',
            raw: 'raw secret payload sk-raw-leak-555',
            full_command: 'npm publish --registry=https://registry.npmjs.org',
          },
        },
      },
    }),
  );
  assert.ok(ev.type === 'userPrompt' && ev.permission);
  assert.equal(ev.permission.id, 'cr-leak');
  assert.equal(ev.permission.prompt, undefined, 'structured events never surface the raw prompt');

  const s = sanitizePermission(ev.permission, { workFolder: 'C:\\work', at: AT });
  assert.equal(s.requestId, 'cr-leak');
  assert.equal(s.requestIdSource, 'upstream');
  assert.equal(s.tool, 'Bash');
  assert.equal(s.action, 'run');
  assert.equal(s.path, null);

  const raw = JSON.stringify(s);
  for (const secret of [
    'sk-live-leak-999',
    'sk-env-secret-777',
    'sk-field-secret-888',
    'tok-secret-12345',
    'sk-raw-leak-555',
    'Authorization',
    'Bearer',
    'npm publish',
    'registry.npmjs.org',
    'C:\\Users\\testuser',
    'Do you want to proceed',
    'curl',
    'API_KEY',
    'HOME',
  ]) {
    assert.ok(!raw.includes(secret), `sanitized summary must not leak ${secret}`);
  }
});

// ---------------------------------------------------------------------------
// Persisted attention snapshot (frozen 7-field sanitized view).
// ---------------------------------------------------------------------------

test('toAttentionSnapshot contains the seven safe fields and no message/prompt/raw/token', () => {
  const s = sanitizePermission(
    {
      id: 'up-snap',
      prompt: 'Claude needs your permission to use Bash.\nCommand: rm C:\\work\\probe.txt\nDo you want to proceed?',
      data: {},
    },
    { workFolder: 'C:\\work', at: AT },
  );
  assert.ok(s.message.length > 0, 'the summary carries a message hint');
  const snap: AttentionSnapshot = toAttentionSnapshot(s);
  assert.deepEqual(
    Object.keys(snap).sort(),
    ['action', 'at', 'path', 'requestId', 'requestIdSource', 'risk', 'tool'],
    'snapshot is exactly the seven safe fields',
  );
  for (const k of ['message', 'prompt', 'raw', 'token']) {
    assert.ok(!(k in snap), `snapshot must not carry ${k}`);
  }
  assert.equal(snap.requestId, s.requestId);
  assert.equal(snap.requestIdSource, s.requestIdSource);
  assert.equal(snap.tool, s.tool);
  assert.equal(snap.action, s.action);
  assert.equal(snap.path, s.path);
  assert.equal(snap.risk, s.risk);
  assert.equal(snap.at, s.at);
});

test('source mutation after conversion cannot add message to the snapshot', () => {
  const s = sanitizePermission(
    { id: 'up-snap2', prompt: 'Claude needs your permission to use Read.\nPath: C:\\work\\config.json', data: {} },
    { workFolder: 'C:\\work', at: AT },
  );
  const snap = toAttentionSnapshot(s);
  assert.ok(!('message' in snap), 'the converted snapshot starts message-free');
  // The summary is a render-time-only artifact; mutating it after the snapshot
  // is taken must not leak a message (or any raw field) into the snapshot.
  s.message = 'injected after conversion';
  (s as unknown as { prompt?: string }).prompt = 'raw injected prompt';
  assert.ok(!('message' in snap), 'mutating the source cannot add message to the snapshot');
  assert.ok(!('prompt' in snap), 'mutating the source cannot add prompt to the snapshot');
  const raw = JSON.stringify(snap);
  assert.ok(!raw.includes('injected after conversion'), 'snapshot serialization is immune to source mutation');
  assert.ok(!raw.includes('raw injected prompt'), 'snapshot serialization is immune to source mutation');
});
