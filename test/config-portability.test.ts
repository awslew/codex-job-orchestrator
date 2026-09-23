// Portability contract tests.
//
// Before this refactor the Anthropic endpoint, the model ids, the worker
// whitelist path, the read-guard hook and the worker MCP config were all
// hard-coded to the author's machine, with no environment override at all: a
// fresh clone could not run a single Claude worker. These tests pin the new
// contract — most importantly "unset means do not inject".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  anthropicRoute,
  modelOverride,
  whitelistPath,
  readGuardHookPath,
  hermeticMcpConfig,
  DEFAULT_WORKER_ALLOW,
} from '../src/config.js';

const ROUTE_KEYS = [
  'ORCHESTRATOR_ANTHROPIC_BASE_URL',
  'ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN',
  'ORCHESTRATOR_MODEL_HAIKU',
  'ORCHESTRATOR_MODEL_HAIKU_NAME',
  'ORCHESTRATOR_WHITELIST_PATH',
  'ORCHESTRATOR_READ_GUARD_HOOK',
  'ORCHESTRATOR_HERMETIC_MCP',
] as const;

/** Run `fn` with the given environment overrides, always restoring afterwards. */
function withEnv<T>(vars: Partial<Record<(typeof ROUTE_KEYS)[number], string | undefined>>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const key of ROUTE_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('unset endpoint injects nothing so the worker keeps its own credentials', () => {
  withEnv({}, () => {
    assert.deepEqual(anthropicRoute(15721), {});
  });
});

test("endpoint 'local' opts back into the legacy local-proxy routing", () => {
  withEnv({ ORCHESTRATOR_ANTHROPIC_BASE_URL: 'local' }, () => {
    assert.deepEqual(anthropicRoute(15721), {
      baseUrl: 'http://127.0.0.1:15721',
      authToken: 'PROXY_MANAGED',
    });
  });
});

test('explicit endpoint is used verbatim and the token is optional', () => {
  withEnv({ ORCHESTRATOR_ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic' }, () => {
    assert.deepEqual(anthropicRoute(15721), { baseUrl: 'https://example.invalid/anthropic' });
  });
  withEnv(
    {
      ORCHESTRATOR_ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic',
      ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN: 'token-placeholder',
    },
    () => {
      assert.deepEqual(anthropicRoute(15721), {
        baseUrl: 'https://example.invalid/anthropic',
        authToken: 'token-placeholder',
      });
    }
  );
});

test('blank endpoint is treated as unset rather than as an empty URL', () => {
  withEnv({ ORCHESTRATOR_ANTHROPIC_BASE_URL: '   ' }, () => {
    assert.deepEqual(anthropicRoute(15721), {});
  });
});

test('model overrides are injected only when configured', () => {
  withEnv({}, () => {
    assert.deepEqual(modelOverride('HAIKU'), {});
    assert.deepEqual(modelOverride('SONNET'), {});
    assert.deepEqual(modelOverride('OPUS'), {});
  });
  withEnv(
    { ORCHESTRATOR_MODEL_HAIKU: 'my-haiku', ORCHESTRATOR_MODEL_HAIKU_NAME: 'vendor/alias' },
    () => {
      assert.deepEqual(modelOverride('HAIKU'), { model: 'my-haiku', alias: 'vendor/alias' });
      // The other kinds stay untouched — a partially configured map must not
      // inherit the configured kind's values.
      assert.deepEqual(modelOverride('OPUS'), {});
    }
  );
});

test('whitelist path prefers the explicit override', () => {
  withEnv({ ORCHESTRATOR_WHITELIST_PATH: '/tmp/does-not-need-to-exist.json' }, () => {
    assert.equal(whitelistPath(), '/tmp/does-not-need-to-exist.json');
  });
});

test('read-guard hook is optional: off, missing and blank all mean "do not inject"', () => {
  withEnv({ ORCHESTRATOR_READ_GUARD_HOOK: 'off' }, () => {
    assert.equal(readGuardHookPath(), undefined);
  });
  withEnv({ ORCHESTRATOR_READ_GUARD_HOOK: path.join(os.tmpdir(), 'no-such-read-guard.cjs') }, () => {
    assert.equal(readGuardHookPath(), undefined, 'a non-existent hook must not be injected');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-guard-'));
  const hook = path.join(dir, 'read-guard.cjs');
  fs.writeFileSync(hook, '// noop\n');
  withEnv({ ORCHESTRATOR_READ_GUARD_HOOK: hook }, () => {
    assert.equal(readGuardHookPath(), hook);
  });
});

test('worker MCP config is optional and honours the explicit override', () => {
  withEnv({ ORCHESTRATOR_HERMETIC_MCP: path.join(os.tmpdir(), 'no-such-mcp.json') }, () => {
    assert.equal(hermeticMcpConfig(), undefined, 'a missing override must not be injected');
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermetic-'));
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(cfg, '{}\n');
  withEnv({ ORCHESTRATOR_HERMETIC_MCP: cfg }, () => {
    assert.equal(hermeticMcpConfig(), cfg);
  });
});

test('the built-in fallback allow list is conservative and non-empty', () => {
  assert.ok(DEFAULT_WORKER_ALLOW.length > 0, 'a fresh install must not approve nothing');
  assert.ok(DEFAULT_WORKER_ALLOW.includes('Read'));
  for (const rule of DEFAULT_WORKER_ALLOW) {
    assert.ok(!rule.startsWith('Bash('), `${rule} must not grant shell execution by default`);
  }
});
