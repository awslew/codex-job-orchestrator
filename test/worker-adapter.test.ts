import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectDeepSeekHarness, workerCapabilities, resolveBridgePatch, defaultWorkerBackend } from '../src/worker-adapter.js';

test('DeepSeek Harness probe is read-only and reports the local headless runner contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-probe-'));
  const runner = path.join(root, 'runner.js');
  fs.writeFileSync(runner, '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version: '0.1.0-rc.8' }));
  const before = fs.readdirSync(root).sort();
  const probe = detectDeepSeekHarness({ DEEPSEEK_HARNESS_ROOT: root, DEEPSEEK_HARNESS_RUNNER: runner });
  assert.equal(probe.available, true);
  assert.equal(probe.version, '0.1.0-rc.8');
  assert.equal(probe.reason, 'ok');
  assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('DeepSeek Harness headless capabilities are explicit rather than overstated', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cap-'));
  const runner = path.join(root, 'runner.js');
  fs.writeFileSync(runner, '');
  const caps = workerCapabilities('deepseek-harness', {
    DEEPSEEK_HARNESS_ROOT: root,
    DEEPSEEK_HARNESS_RUNNER: runner,
  });
  assert.equal(caps.available, true);
  assert.equal(caps.supportsCancel, true);
  assert.equal(caps.supportsAttention, false);
  assert.equal(caps.supportsLiveEvents, false);
  assert.equal(caps.supportsSessionResume, false);
});

test('bridgeConfigured is explicit env opt-in, never auto-probe discovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-brg-'));
  const runner = path.join(root, 'runner.js');
  const bridge = path.join(root, 'dsh-bridge', 'patch.yml');
  fs.writeFileSync(runner, '');
  fs.mkdirSync(path.dirname(bridge), { recursive: true });
  fs.writeFileSync(bridge, 'pipeline: []\n');
  const base = { DEEPSEEK_HARNESS_ROOT: root, DEEPSEEK_HARNESS_RUNNER: runner };

  // No env opt-in means the bridge is NOT configured and default runs stay
  // bare.  There is deliberately no on-disk auto-discovery: the bridge plugin
  // is not part of this repo, so a file at any conventional location is
  // ignored unless the env names it explicitly.
  const noEnv = workerCapabilities('deepseek-harness', base);
  assert.equal(noEnv.available, true);
  assert.equal(noEnv.bridgeConfigured, false);
  assert.equal(detectDeepSeekHarness(base).bridgePatch, null, 'no env means no bridge, even when a file exists');
  assert.equal(resolveBridgePatch(base), null);

  // Explicit non-empty BRIDGE_PATCH configures the bridge.
  const env = { ...base, DEEPSEEK_HARNESS_BRIDGE_PATCH: bridge };
  assert.equal(workerCapabilities('deepseek-harness', env).bridgeConfigured, true);
  assert.equal(resolveBridgePatch(env), bridge);

  // DISABLE=1 always wins, even when the env names a file that exists.
  const disabled = { ...env, DEEPSEEK_HARNESS_DISABLE_BRIDGE: '1' };
  assert.equal(workerCapabilities('deepseek-harness', disabled).bridgeConfigured, false);
  assert.equal(resolveBridgePatch(disabled), null);

  // Blank BRIDGE_PATCH is not an opt-in.
  const blank = { ...base, DEEPSEEK_HARNESS_BRIDGE_PATCH: '   ' };
  assert.equal(workerCapabilities('deepseek-harness', blank).bridgeConfigured, false);
  assert.equal(resolveBridgePatch(blank), null);
});

test('legacy/default worker backend remains Claude', () => {
  assert.equal(defaultWorkerBackend({}), 'claude');
  assert.equal(defaultWorkerBackend({ ORCHESTRATOR_DEFAULT_WORKER_BACKEND: 'deepseek-harness' }), 'deepseek-harness');
  assert.equal(defaultWorkerBackend({ ORCHESTRATOR_DEFAULT_WORKER_BACKEND: 'invalid' }), 'claude');
});

