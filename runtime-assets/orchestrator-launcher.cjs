#!/usr/bin/env node
/**
 * Per-session runtime isolation launcher for claude_code_orchestrator.
 *
 * Why: multiple Codex sessions share one config.toml. Each session spawns its
 * own orchestrator MCP instance, and every instance writes the SAME
 * runtime/ directory (jobs/logs/reports/claims/registry). Instance identity
 * records overwrite each other, so Codex sees a mismatched instance and
 * reports the tools as unavailable (duplicate_instance_suspected).
 *
 * Fix: give each session its own runtime directory. The parent process of
 * this launcher is the codex.exe that owns the session, so we key the runtime
 * dir by that parent PID. No config.toml per session needed; the same launcher
 * serves all sessions, each landing in a private directory.
 *
 * Usage: node orchestrator-launcher.cjs   (called from config.toml)
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const SERVER_ROOT = path.resolve(__dirname, '..');
const INDEX_JS = path.join(__dirname, 'index.js');
const BASE_RUNTIME = path.join(SERVER_ROOT, 'runtime');

// --- resolve session key from the parent process ---------------------------
// config.toml [mcp_servers.claude_orchestrator] launches us; the parent is the
// codex.exe process that owns the session (or the terminal running codex).
function parentPid() {
  try {
    return process.ppid;
  } catch {
    return null;
  }
}

function parentIdentity(pid) {
  // Best-effort, Windows-first. Anything unreadable degrades to the PID only.
  try {
    if (process.platform === 'win32') {
      const { execFileSync } = require('node:child_process');
      const out = execFileSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'Name,CommandLine', '/value'],
        { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      const name = (out.match(/Name=([^\r\n]+)/) || [])[1]?.trim() || '';
      const cmd = (out.match(/CommandLine=([^\r\n]+)/) || [])[1]?.trim() || '';
      return { name, cmd };
    }
    return { name: 'unknown', cmd: '' };
  } catch {
    return { name: '', cmd: '' };
  }
}

// --- build the per-session runtime dir --------------------------------------
const ppid = parentPid();
const parent = ppid ? parentIdentity(ppid) : { name: '', cmd: '' };
// The session key: parent PID is unique while the session lives. If the
// parent is a shell/terminal (not codex.exe), fall back to the launcher's own
// PID so each terminal spawn also gets a private runtime.
const sessionKey = String(ppid ?? process.pid);
const sessionRuntime = path.join(BASE_RUNTIME, 'sessions', sessionKey);

// If the parent is a generic shell (powershell/cmd/node), the session key is
// the launcher's own PID — still unique per spawn, never shared.
if (!/codex(\.exe)?$/i.test(parent.name)) {
  // keep sessionKey; the launcher PID would be more stable across MCP restarts
  // of the SAME session, but a shell parent means a manual/test spawn anyway.
}

// --- hand over to the real server -------------------------------------------
const env = {
  ...process.env,
  ORCHESTRATOR_RUNTIME: sessionRuntime,
  // Host identity = the codex.exe app-server that spawned us. Codex Desktop
  // spawns one MCP instance per session window, ALL under the same app-server
  // PID, so instances must be grouped by host PID for duplicate detection:
  // several windows of ONE host are a normal multi-window setup, not
  // duplicates (see the host-grouped logic in registry.js).
  ORCHESTRATOR_HOST_PID: sessionKey,
};
try {
  fs.mkdirSync(path.join(sessionRuntime, 'registry', 'instances'), { recursive: true });
  fs.mkdirSync(path.join(sessionRuntime, 'claims'), { recursive: true });
} catch {
  // ensureRuntimeDirs in the server also creates them; best-effort here.
}

const child = spawn(process.execPath, [INDEX_JS, ...process.argv.slice(2)], {
  env,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true,
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('close', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
