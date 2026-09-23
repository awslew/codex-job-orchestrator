// Security-hardening regression tests for the worker policy (F1 / F3 / F4 of the
// pre-release threat assessment).
//
// F1 — a missing worker whitelist used to produce a permission payload with an
//      ALLOW list and NO deny list. The default `auto` profile runs the worker
//      under --permission-mode bypassPermissions, where `allow` only suppresses
//      prompts: that payload meant "no policy at all". These tests pin the new
//      contract — deny is NEVER empty — and pin the visibility channels that
//      replaced the detached supervisor's discarded stderr.
// F3 — the worker inherited the orchestrator's entire environment, including the
//      gateway credential. The last test here observes the REAL worker process
//      env and proves the credential no longer reaches it while the Claude CLI's
//      own auth contract survives.
// F4 — settings/log files that carry a token or task content are created 0600.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rt = path.join(os.tmpdir(), `orc-wpolicy-${process.pid}-${Date.now()}`);
fs.mkdirSync(rt, { recursive: true });
process.env.ORCHESTRATOR_RUNTIME = rt;
process.env.OPEN_LIVE_VIEW = '0';
process.env.ORCHESTRATOR_START_JITTER_MAX_MS = '0';
process.env.ORCHESTRATOR_ATTENTION_CONFIRM_MS = '300';

import {
  DEFAULT_WORKER_ALLOW,
  DEFAULT_WORKER_DENY,
  readWorkerWhitelist,
  resolveWorkerDeny,
} from '../src/config.js';
import { workerEnv } from '../src/supervisor.js';
import { startJob, waitForJob } from '../src/scheduler.js';
import { settingsFilePath, stderrLogFilePath, readJob } from '../src/job-store.js';
import type { StartParams } from '../src/router.js';

const FAKE_CLAUDE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fake-claude.mjs');

function fakeParams(over: Partial<StartParams> & { extraEnv?: Record<string, string> } = {}): StartParams {
  return {
    prompt: 'fake task',
    workFolder: rt,
    profile: 'auto',
    parallelism: 'auto',
    maxRuntimeMinutes: 120,
    claudeCli: FAKE_CLAUDE,
    claudePrefix: [process.execPath],
    ...over,
  };
}

function fakeEnv(over: Record<string, string> = {}): Record<string, string> {
  return { FAKE_CLAUDE_RUN_SECONDS: '1', FAKE_CLAUDE_EXIT_CODE: '0', ...over };
}

/** Run `fn` with ORCHESTRATOR_WHITELIST_PATH temporarily set (or cleared). */
function withWhitelistPath<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.ORCHESTRATOR_WHITELIST_PATH;
  if (value === undefined) delete process.env.ORCHESTRATOR_WHITELIST_PATH;
  else process.env.ORCHESTRATOR_WHITELIST_PATH = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.ORCHESTRATOR_WHITELIST_PATH;
    else process.env.ORCHESTRATOR_WHITELIST_PATH = saved;
  }
}

function writeWhitelist(name: string, content: string): string {
  const p = path.join(rt, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// ---------------------------------------------------------------------------
// F1: the built-in deny floor
// ---------------------------------------------------------------------------

test('F1: the built-in default deny list is non-empty, unique and covers the irreversible classes', () => {
  assert.ok(DEFAULT_WORKER_DENY.length > 0, 'a fresh clone must not start with an empty deny list');
  assert.equal(new Set(DEFAULT_WORKER_DENY).size, DEFAULT_WORKER_DENY.length, 'no duplicate rules');
  for (const rule of DEFAULT_WORKER_DENY) {
    assert.ok(typeof rule === 'string' && rule.trim().length > 0, `empty rule in DEFAULT_WORKER_DENY`);
  }
  // One representative rule per irreversible class the threat assessment named.
  for (const rule of [
    'Bash(rm -rf /*)', // recursive delete from the root
    'Bash(format *)', // disk format
    'Bash(shutdown *)', // kills every running job
    'Bash(taskkill //IM *)', // batch kill by image name
    'Bash(git push *)', // irreversibly publishes history
    'Bash(npm publish*)', // irreversibly publishes a package
    'Bash(curl *)', // exfiltration channel
    'Bash(wget *)',
    'Bash(powershell *)',
    'WebFetch',
    'WebSearch',
    'Bash(env)', // prints every secret the session holds into on-disk logs
    'Bash(printenv *)',
    'Read(~/.ssh/**)', // credential stores
    'Read(~/.aws/**)',
    'Read(~/.npmrc)',
    'Read(**/.env)',
    'Write(C:/Windows/**)',
    'Write(/etc/**)',
    'Write(.git/hooks/**)', // a written hook is code execution on the next git command
  ]) {
    assert.ok(DEFAULT_WORKER_DENY.includes(rule), `DEFAULT_WORKER_DENY must include ${rule}`);
  }
  // The floor must never grant anything: a deny rule is a rule, never a tool
  // permission entry (defensive: catches a copy/paste of the allow list).
  for (const rule of DEFAULT_WORKER_DENY) {
    assert.ok(!rule.startsWith('Bash(git commit'), `${rule} must not be an allow-shaped rule`);
  }
});

test('F1: resolveWorkerDeny unions the floor into any file list and never returns an empty list', () => {
  for (const missing of [undefined, null, [], ['', '   '], 'nonsense', 42, {}]) {
    const r = resolveWorkerDeny(missing);
    assert.equal(r.source, 'floor', `non-usable deny input ${JSON.stringify(missing)} uses the floor`);
    assert.deepEqual(r.deny, DEFAULT_WORKER_DENY);
    assert.ok(r.deny.length > 0);
    assert.deepEqual(r.addedByFloor, DEFAULT_WORKER_DENY, 'the whole floor was added');
  }

  // The floor is a FLOOR: a file that is a strict subset of it cannot lower the
  // policy. This is the shipped-template case (its own deny list is a subset).
  const subset = ['Bash(git push)', 'Bash(shutdown *)'];
  const sub = resolveWorkerDeny(subset);
  assert.equal(sub.source, 'whitelist+floor');
  for (const rule of DEFAULT_WORKER_DENY) {
    assert.ok(sub.deny.includes(rule), `floor rule ${rule} must survive a subset file deny list`);
  }
  for (const rule of subset) assert.ok(sub.deny.includes(rule), `file rule ${rule} must be kept`);
  assert.equal(sub.addedByFloor.length, DEFAULT_WORKER_DENY.length - 2, 'both file rules are already in the floor');
  for (const rule of subset) assert.ok(!sub.addedByFloor.includes(rule), `${rule} is not a floor addition`);
  assert.equal(new Set(sub.deny).size, sub.deny.length, 'the union is deduplicated');
  assert.deepEqual(sub.deny.slice(0, subset.length), subset, 'file rules keep their position and order');

  // A file may still ADD its own rules, and non-string entries are dropped.
  const custom = ['Bash(whatever *)', 'Read(/secret/**)'];
  const c = resolveWorkerDeny([...custom, 7, null]);
  assert.deepEqual(c.addedByFile, custom);
  assert.deepEqual(c.deny.slice(0, custom.length), custom);
  assert.ok(c.deny.includes('Bash(curl *)'), 'the floor is still there');

  // Even a file deny list that supersets the floor is returned unchanged in
  // content (order: file first, then nothing added).
  const superset = [...DEFAULT_WORKER_DENY, 'Bash(extra *)'];
  const s = resolveWorkerDeny(superset);
  assert.deepEqual(s.addedByFloor, []);
  assert.deepEqual(s.deny, superset);

  // The result must be a copy: mutating it must not poison the module state.
  const floor = resolveWorkerDeny(undefined).deny;
  floor.push('Bash(tampered *)');
  assert.ok(!DEFAULT_WORKER_DENY.includes('Bash(tampered *)'));
});

test('F1: readWorkerWhitelist reports exactly why the fallback is in effect', () => {
  const missing = path.join(rt, 'no-such-whitelist.json');
  withWhitelistPath(missing, () => {
    const s = readWorkerWhitelist();
    assert.equal(s.problem, 'file_not_found');
    assert.equal(s.usable, false);
    assert.equal(s.permissions, undefined);
    assert.equal(s.path, missing);
  });

  withWhitelistPath(writeWhitelist('bad.json', '{ not json'), () => {
    assert.equal(readWorkerWhitelist().problem, 'invalid_json');
  });

  withWhitelistPath(writeWhitelist('no-permissions.json', '{}'), () => {
    assert.equal(readWorkerWhitelist().problem, 'permissions_missing');
  });

  withWhitelistPath(writeWhitelist('empty-deny.json', JSON.stringify({ permissions: { allow: ['Read'], deny: [] } })), () => {
    const s = readWorkerWhitelist();
    assert.equal(s.problem, 'no_usable_deny', 'no deny list at all: the floor is the whole policy');
    assert.equal(s.usable, true, 'the file is readable, only its deny list is unusable');
  });

  // A file whose deny list misses floor rules is closed UP (union), and says so.
  withWhitelistPath(
    writeWhitelist('partial-deny.json', JSON.stringify({ permissions: { allow: ['Read'], deny: ['Bash(git push)'] } })),
    () => {
      const s = readWorkerWhitelist();
      assert.equal(s.problem, 'deny_floor_added');
      assert.match(s.detail, /baseline/);
    },
  );

  withWhitelistPath(writeWhitelist('no-allow.json', JSON.stringify({ permissions: { deny: ['Bash(git push)'] } })), () => {
    assert.equal(readWorkerWhitelist().problem, 'deny_floor_added', 'the deny gap outranks the allow gap');
  });

  // A complete deny list with a broken allow list: only the allow gap is left.
  withWhitelistPath(
    writeWhitelist('bad-allow.json', JSON.stringify({ permissions: { allow: 'Read', deny: [...DEFAULT_WORKER_DENY] } })),
    () => {
      assert.equal(readWorkerWhitelist().problem, 'allow_not_an_array');
    },
  );

  withWhitelistPath(
    writeWhitelist(
      'good.json',
      JSON.stringify({ permissions: { allow: ['Read'], deny: [...DEFAULT_WORKER_DENY, 'Bash(git push)'] } }),
    ),
    () => {
      const s = readWorkerWhitelist();
      assert.equal(s.problem, 'ok', 'a file that already carries the floor needs no substitution');
      assert.equal(s.usable, true);
      assert.deepEqual(s.permissions?.deny, [...DEFAULT_WORKER_DENY, 'Bash(git push)']);
    },
  );
});

// ---------------------------------------------------------------------------
// F3: worker environment
// ---------------------------------------------------------------------------

test('F3: workerEnv strips orchestrator and third-party credentials but keeps the CLI auth contract', () => {
  const env = workerEnv({
    PATH: '/usr/bin',
    HOME: '/home/u',
    // --- must be stripped: our own gateway credential + any secret-shaped key
    ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN: 'placeholder-gateway-token',
    ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN_NAME: 'vendor/alias',
    GITHUB_TOKEN: 'ghp_placeholder',
    NPM_TOKEN: 'npm_placeholder',
    AWS_SECRET_ACCESS_KEY: 'aws_placeholder',
    DEEPSEEK_API_KEY: 'ds_placeholder',
    MY_PASSWORD: 'pw_placeholder',
    DB_CREDENTIALS: 'cred_placeholder',
    // --- must survive: non-secret configuration
    ORCHESTRATOR_WHITELIST_PATH: '/home/u/.claude/worker-whitelist.json',
    ORCHESTRATOR_RUNTIME: '/repo/runtime',
    DEEPSEEK_HARNESS_ROOT: '/opt/dsh',
    CLAUDE_CLI_NAME: 'claude',
    // --- must survive: the Claude CLI's own authentication inputs
    ANTHROPIC_API_KEY: 'sk-ant-placeholder',
    ANTHROPIC_AUTH_TOKEN: 'cli-token-placeholder',
    ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-placeholder',
  });

  for (const stripped of [
    'ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN',
    'ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN_NAME',
    'GITHUB_TOKEN',
    'NPM_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'DEEPSEEK_API_KEY',
    'MY_PASSWORD',
    'DB_CREDENTIALS',
  ]) {
    assert.equal(env[stripped], undefined, `${stripped} must not reach the worker`);
  }
  for (const kept of [
    'PATH',
    'HOME',
    'ORCHESTRATOR_WHITELIST_PATH',
    'ORCHESTRATOR_RUNTIME',
    'DEEPSEEK_HARNESS_ROOT',
    'CLAUDE_CLI_NAME',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
  ]) {
    assert.ok(env[kept] !== undefined, `${kept} must keep reaching the worker`);
  }
  const serialized = JSON.stringify(env);
  assert.ok(!serialized.includes('placeholder-gateway-token'), 'no stripped value may survive anywhere in the env');
});

test('F3: workerEnv drops an orchestrator endpoint that embeds credentials, and lets extraEnv win', () => {
  const withCreds = workerEnv({
    ORCHESTRATOR_ANTHROPIC_BASE_URL: 'https://user:password@gateway.invalid/anthropic',
    OTHER_URL: 'https://user:password@other.invalid/', // not ours: left alone
  });
  assert.equal(withCreds.ORCHESTRATOR_ANTHROPIC_BASE_URL, undefined, 'userinfo credentials are a secret too');
  assert.equal(withCreds.OTHER_URL, 'https://user:password@other.invalid/');

  const explicit = workerEnv({ PATH: '/usr/bin' }, { FAKE_CLAUDE_RUN_SECONDS: '1', RUNTIME_ONLY_KEY: 'explicit' });
  assert.equal(explicit.PATH, '/usr/bin');
  assert.equal(explicit.FAKE_CLAUDE_RUN_SECONDS, '1');
  assert.equal(explicit.RUNTIME_ONLY_KEY, 'explicit', 'extraEnv is an explicit per-job instruction, never inherited state');
});

// ---------------------------------------------------------------------------
// F1 + F3 + F4 end to end, through the real detached supervisor
// ---------------------------------------------------------------------------

// Preloaded (via NODE_OPTIONS) into every node process the job spawns, so the
// test can read the REAL worker environment instead of a simulation.
const ENV_DUMP_PRELOAD = `const fs = require('fs');
const path = require('path');
try {
  fs.appendFileSync(process.env.ORC_TEST_ENV_DUMP, JSON.stringify({
    entry: path.basename(process.argv[1] || ''),
    pid: process.pid,
    orchestratorToken: process.env.ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN || null,
    anthropicKey: process.env.ANTHROPIC_API_KEY || null,
    pathPresent: typeof process.env.PATH === 'string' && process.env.PATH.length > 0,
  }) + '\\n');
} catch {}
`;

test('F1/F3/F4 end-to-end: no whitelist file -> built-in deny floor in the payload, caller warned, worker env sanitized, 0600 files', async (t) => {
  const savedEnv: Record<string, string | undefined> = {
    ORCHESTRATOR_WHITELIST_PATH: process.env.ORCHESTRATOR_WHITELIST_PATH,
    ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN: process.env.ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    ORC_TEST_ENV_DUMP: process.env.ORC_TEST_ENV_DUMP,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const dumpPath = path.join(rt, 'worker-env-dump.ndjson');
  const preloadPath = path.join(rt, 'env-dump-preload.cjs');
  fs.writeFileSync(preloadPath, ENV_DUMP_PRELOAD, 'utf8');
  process.env.ORC_TEST_ENV_DUMP = dumpPath;
  // Forward slashes on purpose: NODE_OPTIONS eats backslashes inside a quoted
  // value (a Windows path would silently become "C:Users<name>..." and node
  // would fail to start every child of this job).
  process.env.NODE_OPTIONS = `--require "${preloadPath.split(path.sep).join('/')}"`;
  // A fresh clone has no whitelist file; the orchestrator's gateway credential
  // lives in the MCP server env block, i.e. exactly here.
  process.env.ORCHESTRATOR_WHITELIST_PATH = path.join(rt, 'absent-whitelist.json');
  process.env.ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN = 'placeholder-gateway-token';
  process.env.ANTHROPIC_API_KEY = 'placeholder-cli-credential';

  const { job, warnings } = startJob(fakeParams({ extraEnv: fakeEnv() }));

  // 1. The caller (leader model) is told, in the tool result it actually reads.
  assert.ok(
    warnings.some((w) => w.includes('worker whitelist unusable') && w.includes('built-in default list')),
    `start warnings must report the fallback: ${JSON.stringify(warnings)}`,
  );

  // 2. The settings payload the worker receives always carries a deny list.
  const settingsPath = settingsFilePath(job.jobId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(settingsPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(settingsPath), 'the supervisor wrote the per-job settings file');
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    permissions?: { allow?: unknown; deny?: unknown };
  };
  assert.ok(settings.permissions, 'permissions block present even without a whitelist file');
  assert.ok(Array.isArray(settings.permissions!.deny), 'deny is an array');
  assert.ok(
    (settings.permissions!.deny as unknown[]).length > 0,
    'F1: deny must NEVER be empty — an empty deny under bypassPermissions is "no policy"',
  );
  assert.deepEqual(settings.permissions!.deny, DEFAULT_WORKER_DENY, 'the built-in floor is what got injected');
  assert.deepEqual(settings.permissions!.allow, DEFAULT_WORKER_ALLOW, 'allow keeps its conservative fallback');

  // 3. The job's own log carries the same notice (the caller can read it even
  //    when it ignores warnings[]).
  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'succeeded', 'the fake worker still completes unattended');
  const stderrLog = fs.readFileSync(stderrLogFilePath(job.jobId), 'utf8');
  assert.match(stderrLog, /worker policy fallback/, 'the fallback is recorded in the job stderr log');
  assert.match(stderrLog, /built-in default list \(\d+ rules\)/);

  // 4. F3: the real worker process did NOT inherit the gateway credential, and
  //    the CLI's own contract variable still reached it.
  const lines = fs
    .readFileSync(dumpPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as { entry: string; orchestratorToken: string | null; anthropicKey: string | null; pathPresent: boolean });
  const worker = lines.find((l) => l.entry === path.basename(FAKE_CLAUDE));
  assert.ok(worker, `the preload ran inside the worker process: ${JSON.stringify(lines)}`);
  assert.equal(worker!.orchestratorToken, null, 'F3: the orchestrator credential must not reach the worker');
  assert.equal(worker!.anthropicKey, 'placeholder-cli-credential', 'the Claude CLI keeps its own credential');
  assert.equal(worker!.pathPresent, true, 'the sanitized env is still a usable process environment');

  // 5. F4: token-bearing runtime files are owner-only on POSIX (mode is inert on
  //    Windows, where this assertion would test nothing).
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600, 'settings file is 0600');
    assert.equal(fs.statSync(stderrLogFilePath(job.jobId)).mode & 0o777, 0o600, 'job log is 0600');
  }
  const record = readJob(job.jobId);
  assert.ok(record?.endedAt, 'the job record was finalized (runtime writes still work)');
});

test('F1 end-to-end: the shipped template whitelist is a strict subset of the floor and is still closed up', async (t) => {
  // This is the path a user follows in the setup guide: copy the template to the
  // default location. Its deny list is a strict subset of the built-in floor, so
  // without the union the template would silently be WEAKER than installing
  // nothing at all. The union must keep every floor rule.
  const templatePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'templates',
    'worker-whitelist.json',
  );
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8')) as {
    permissions: { allow: string[]; deny: string[] };
  };
  const missingFloor = DEFAULT_WORKER_DENY.filter((r) => !template.permissions.deny.includes(r));
  assert.ok(missingFloor.length > 0, 'the premise: the template deny list alone is not the floor');

  const saved = process.env.ORCHESTRATOR_WHITELIST_PATH;
  process.env.ORCHESTRATOR_WHITELIST_PATH = templatePath;
  t.after(() => {
    if (saved === undefined) delete process.env.ORCHESTRATOR_WHITELIST_PATH;
    else process.env.ORCHESTRATOR_WHITELIST_PATH = saved;
  });

  const { job, warnings } = startJob(fakeParams({ extraEnv: fakeEnv() }));
  assert.ok(
    warnings.some((w) => w.includes(`${missingFloor.length} built-in baseline rule(s)`) && w.includes('union-ed')),
    `the caller must be told the baseline was unioned: ${JSON.stringify(warnings)}`,
  );
  assert.ok(
    warnings.some((w) => w.includes('Nothing is broken')),
    'a usable-but-incomplete whitelist gets a note, not an "unusable" alarm',
  );

  const settingsPath = settingsFilePath(job.jobId);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !fs.existsSync(settingsPath)) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    permissions?: { allow?: unknown; deny?: unknown };
  };
  const deny = settings.permissions?.deny as string[];
  for (const rule of DEFAULT_WORKER_DENY) {
    assert.ok(deny.includes(rule), `floor rule ${rule} must be injected even with the template whitelist`);
  }
  for (const rule of template.permissions.deny) {
    assert.ok(deny.includes(rule), `the template's own rule ${rule} must be kept`);
  }
  assert.equal(new Set(deny).size, deny.length, 'the union has no duplicates');
  assert.deepEqual(
    settings.permissions?.allow,
    template.permissions.allow,
    'allow is NOT widened or narrowed by us: the file wins for grants',
  );

  const final = await waitForJob(job.jobId, 60);
  assert.equal(final.status, 'succeeded');
  assert.match(fs.readFileSync(stderrLogFilePath(job.jobId), 'utf8'), /built-in baseline rule\(s\) the file did not carry/);
});
