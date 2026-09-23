// Stable paths, constants, and directory helpers for the orchestrator.
// Runtime state is kept under SERVER_ROOT/runtime by default; a test may
// redirect it with the ORCHESTRATOR_RUNTIME env var (read lazily so a test
// process can point it at an isolated temp dir before importing modules).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
// In the compiled layout this module lives at <root>/dist (or dist-test/src),
// so the source root is the parent directory.
export const SERVER_ROOT = path.resolve(currentDir, '..');

// The real project root: where package.json and the PRODUCTION dist live. In
// the production layout config.js sits at <root>/dist; in the test layout it
// sits at <root>/dist-test/src (one level deeper), so SERVER_ROOT alone would
// point at dist-test. Resolve by looking for the production dist directory.
export const PROJECT_ROOT = fs.existsSync(path.join(SERVER_ROOT, 'dist'))
  ? SERVER_ROOT
  : path.dirname(SERVER_ROOT);

// Default location of the worker-side MCP config. Kept for backwards
// compatibility; prefer hermeticMcpConfig() below, which honours
// ORCHESTRATOR_HERMETIC_MCP and reports "absent" when no config exists so the
// supervisor can skip injecting --mcp-config entirely.
export const HERMETIC_MCP = path.join(SERVER_ROOT, 'config', 'hermetic-mcp.json');

export function hermeticMcpConfig(): string | undefined {
  const explicit = (process.env.ORCHESTRATOR_HERMETIC_MCP ?? '').trim();
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  return fs.existsSync(HERMETIC_MCP) ? HERMETIC_MCP : undefined;
}

export const DEFAULT_MAX_RUNTIME_MIN = 120;
export const MIN_MAX_RUNTIME_MIN = 30;
export const MAX_MAX_RUNTIME_MIN = 180;
export const WAIT_MAX_SECONDS = 240;
export const WAIT_POLL_MS = 2000;

// claude_code_watch contract. Default and max are both 14400s (4h): this covers
// the 180-minute maxRuntimeMinutes cap (10800s) plus cleanup headroom and is the
// same value the client config sets via `tool_timeout_sec`. Watch only resolves
// on a terminal/needs_attention state or a watch-level outcome (timeout / abort
// / not-found / internal-error); it never returns `running` while a job runs.
export const WATCH_MAX_SECONDS = 14400;
export const WATCH_DEFAULT_SECONDS = WATCH_MAX_SECONDS;
export const WATCH_MIN_SECONDS = 1;
// Internal fallback poll interval for the shared job event broker. Runs only
// while the broker has subscribers; a reliability net for Windows fs.watch, and
// purely internal — it never surfaces `running` to any caller.
export const WATCH_FALLBACK_MS = 15000;

// Single-port routing: every profile resolves to the same local port. The port
// is only injected when ORCHESTRATOR_ANTHROPIC_BASE_URL opts into 'local' — see
// anthropicRoute() below. See router.ts for the profile -> permission-mode map.
export const PORT_REVIEW = 15721;

// Which claude CLI binary to spawn for real jobs. Overridable via env
// (set in config.toml) or per-job for tests.
export function defaultClaudeCli(): string {
  return process.env.CLAUDE_CLI_NAME || 'claude';
}

export function runtimeRoot(): string {
  return process.env.ORCHESTRATOR_RUNTIME || path.join(SERVER_ROOT, 'runtime');
}
export function jobsDir(): string {
  return path.join(runtimeRoot(), 'jobs');
}
export function logsDir(): string {
  return path.join(runtimeRoot(), 'logs');
}
export function settingsDir(): string {
  return path.join(runtimeRoot(), 'settings');
}
export function reportsDir(): string {
  return path.join(runtimeRoot(), 'reports');
}

// Stage 6 single-recoverer claims. One small O_EXCL file per (job, kind) under
// runtime/claims, so concurrent recoverers (multiple MCP instances) never both
// own a job. Not scanned by listJobs/health (separate dir).
export function claimsDir(): string {
  return path.join(runtimeRoot(), 'claims');
}

// Stage 5 instance registry. One JSON file per MCP instance under
// runtime/registry/instances/<instanceId>.json so concurrent processes never
// share a single mutable JSON (no cross-process read-modify-write).
export function registryDir(): string {
  return path.join(runtimeRoot(), 'registry');
}
export function instancesDir(): string {
  return path.join(registryDir(), 'instances');
}

// The production build the MCP server loads. fingerprint.ts hashes this whole
// directory (every regular file, sorted by relative path) so a change to ANY
// production module — not just the entry — triggers reload_required.
export function distDir(): string {
  return path.join(PROJECT_ROOT, 'dist');
}

// Heartbeat cadence / stale threshold for the instance registry. Env
// overridable so tests and smoke can use short windows; production defaults to
// a 10s heartbeat and a 30s stale threshold (3x interval).
export function registryHeartbeatMs(): number {
  const v = Number(process.env.ORCHESTRATOR_REGISTRY_HEARTBEAT_MS);
  if (Number.isFinite(v) && v >= 250) return Math.floor(v);
  return 10_000;
}
export function registryStaleAfterMs(): number {
  const v = Number(process.env.ORCHESTRATOR_REGISTRY_STALE_AFTER_MS);
  if (Number.isFinite(v) && v >= 250) return Math.floor(v);
  return 30_000;
}

export function ensureRuntimeDirs(): void {
  for (const d of [runtimeRoot(), jobsDir(), logsDir(), settingsDir(), reportsDir(), claimsDir()]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Stage 6 recovery tuning. Env-overridable so tests/smoke can use short values.
// bootstrapGraceMs: how long a `queued` job that never spawned a supervisor
// (no supervisorPid, no supervisor claim) may sit before recovery treats the
// bootstrap as never-started and safely resumes it. The supervisor's own
// bootstrap (claim + ack) completes within ~1s of spawn, so a generous grace
// makes "still unclaimed after grace" a reliable never-started signal.
export function bootstrapGraceMs(): number {
  const v = Number(process.env.ORCHESTRATOR_BOOTSTRAP_GRACE_MS);
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  return 15_000;
}
// Lease for the short-lived 'recover' claim (a single recovery pass). Long
// enough that a live recoverer is never displaced mid-pass, short enough that a
// crashed recoverer's residue is bounded.
export function recoveryClaimLeaseMs(): number {
  const v = Number(process.env.ORCHESTRATOR_RECOVERY_CLAIM_LEASE_MS);
  if (Number.isFinite(v) && v >= 250) return Math.floor(v);
  return 60_000;
}

// Wave 4B2a admission-control defaults. All env-overridable; invalid values
// fall back to their documented defaults (never to an implicit cap). The
// flag enables the whole controller; the numeric parsers feed the default
// policy that an explicit per-job setting may override.
export function admissionControlEnabled(): boolean {
  const v = (process.env.ORCHESTRATOR_ADMISSION_CONTROL ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
// Wave 5A2a: JobIndex feature flag. Off by default: job-store keeps its exact
// legacy file layout (no runtime/job-index directory is ever created).
// Read lazily so a test process can flip it per runtime root; only the exact
// on-words enable it (anything else, including invalid values, stays off).
export function retentionV2Enabled(): boolean {
  const v = (process.env.ORCHESTRATOR_RETENTION_V2 ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}
export function desiredWorkerConcurrencyDefault(): number {
  const v = Number(process.env.ORCHESTRATOR_DESIRED_WORKER_CONCURRENCY);
  if (Number.isFinite(v) && v >= 1 && v <= 64) return Math.floor(v);
  return 4;
}
export function admissionHardCeilingDefault(): number {
  const v = Number(process.env.ORCHESTRATOR_ADMISSION_HARD_CEILING);
  if (Number.isFinite(v) && v >= 1 && v <= 64) return Math.floor(v);
  return 8;
}
export function admissionMaxHeavyWorkersDefault(): number {
  const v = Number(process.env.ORCHESTRATOR_ADMISSION_MAX_HEAVY_WORKERS);
  if (Number.isFinite(v) && v >= 1 && v <= 64) return Math.floor(v);
  return 2;
}
export function admissionMemoryReserveMbDefault(): number {
  const v = Number(process.env.ORCHESTRATOR_ADMISSION_MEMORY_RESERVE_MB);
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  return 2048;
}

// ---------------------------------------------------------------------------
// Portable configuration.
//
// Historically the Anthropic endpoint and the model ids were hard-coded to one
// specific local proxy (a loopback URL plus a fixed placeholder token) with no
// environment override at all. On any other machine every Claude worker failed
// immediately. These accessors generalize that: nothing about the endpoint is
// baked into the code any more.
//
// Contract for the endpoint — "unset means do not inject":
//   unset            -> inject nothing; the worker inherits whatever the Claude
//                       CLI itself is configured with (official login, key, ...)
//   'local' | 'auto' -> legacy behavior: http://127.0.0.1:<port> + PROXY_MANAGED
//   <absolute URL>   -> that endpoint, plus ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN
//                       when that is set (omitted entirely when it is empty).
// ---------------------------------------------------------------------------
export interface AnthropicRoute {
  baseUrl?: string;
  authToken?: string;
}

export function anthropicRoute(port: number): AnthropicRoute {
  const raw = (process.env.ORCHESTRATOR_ANTHROPIC_BASE_URL ?? '').trim();
  if (!raw) return {};
  if (raw === 'local' || raw === 'auto') {
    return { baseUrl: `http://127.0.0.1:${port}`, authToken: 'PROXY_MANAGED' };
  }
  const token = (process.env.ORCHESTRATOR_ANTHROPIC_AUTH_TOKEN ?? '').trim();
  return token ? { baseUrl: raw, authToken: token } : { baseUrl: raw };
}

// Model mapping. Unset -> not injected, so the Claude CLI keeps its own model
// defaults instead of being forced onto ids that only exist behind one proxy.
// Each kind takes a visible model id and an optional provider-side alias.
export function modelOverride(kind: 'HAIKU' | 'SONNET' | 'OPUS'): { model?: string; alias?: string } {
  const model = (process.env[`ORCHESTRATOR_MODEL_${kind}`] ?? '').trim();
  const alias = (process.env[`ORCHESTRATOR_MODEL_${kind}_NAME`] ?? '').trim();
  const out: { model?: string; alias?: string } = {};
  if (model) out.model = model;
  if (alias) out.alias = alias;
  return out;
}

// Worker permission whitelist. Previously one hard-coded personal path whose
// absence silently degraded to an EMPTY allow list — every worker tool call
// then hit the approval classifier, which users observe as a hung job.
export function whitelistPath(): string | undefined {
  const explicit = (process.env.ORCHESTRATOR_WHITELIST_PATH ?? '').trim();
  if (explicit) return explicit;
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) return undefined;
  return path.join(home, '.claude', 'worker-whitelist.json');
}

// Conservative allow list used when no whitelist file exists yet, so a fresh
// install stays usable instead of approving nothing. Deliberately narrow: it
// covers reading and editing, never shell execution or network egress.
export const DEFAULT_WORKER_ALLOW = [
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'Glob',
  'Grep',
  'TodoWrite',
];

// Built-in hard-deny floor, injected whenever the whitelist file does not
// supply a usable `deny` list of its own.
//
// Why a floor is mandatory: the default `auto`/`normal` workers run with
// `--permission-mode bypassPermissions` (see router.ts), where `allow` only
// means "do not prompt" — the ONLY rules that actually block a tool call are
// the `deny` ones. A missing whitelist file (the state of every fresh clone)
// therefore used to mean "no policy at all": any command the injected prompt
// asked for ran as the user, with no confirmation and no record. This list is
// that hole's floor.
//
// Design rule — a rule belongs here only when ONE prompt-injected tool call
// would be irreversible (bulk delete / format / shutdown / publish / history
// rewrite), would exfiltrate the machine (network egress tools), or would hand
// over a credential store that no coding task ever needs to read. Everyday work
// (read, edit, build, test, git commit) is deliberately untouched so unattended
// jobs keep running: a denied call is refused deterministically, it never turns
// into a human approval prompt.
//
// Matching semantics: Claude Code matches permission rules against the command
// PREFIX (`Bash(git push)` is exact, `Bash(git push *)` is a prefix rule). A
// rule the CLI cannot resolve is inert — it can never widen permissions.
export const DEFAULT_WORKER_DENY: string[] = [
  // Irreversible local destruction.
  'Bash(rm -rf /*)',
  'Bash(rm -fr /*)',
  'Bash(rm -rf /c/)',
  'Bash(rm -rf /d/)',
  'Bash(rm -rf ~*)',
  'Bash(rm -rf $HOME*)',
  'Bash(rm -rf .)',
  'Bash(format *)',
  'Bash(mkfs*)',
  'Bash(fdisk*)',
  'Bash(diskpart*)',
  'Bash(dd if=*)',
  'Bash(del /f /s /q C:\\*)',
  'Bash(shutdown *)',
  'Bash(reboot)',
  'Bash(reboot *)',
  'Bash(reg delete *)',
  'Bash(:(){ :|:& };:)',
  'Bash(sudo *)',
  // Batch process killing by IMAGE NAME takes unrelated processes down with it
  // (editors, proxies, the orchestrator itself); only exact-PID kills are safe.
  'Bash(taskkill //IM *)',
  'Bash(taskkill /IM *)',

  // Irreversible shared state: remote history, releases, published packages.
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(git -C * push *)',
  'Bash(git reset --hard*)',
  'Bash(git clean -fdx*)',
  'Bash(npm publish*)',
  'Bash(pnpm publish*)',
  'Bash(yarn publish*)',

  // Network egress / remote shells: the exfiltration channel a prompt
  // injection needs to move credentials or private code off the machine.
  'Bash(curl)',
  'Bash(curl *)',
  'Bash(wget)',
  'Bash(wget *)',
  'Bash(powershell *)',
  'Bash(pwsh *)',
  'Bash(cmd /c *)',
  'Bash(ssh *)',
  'Bash(scp *)',
  'Bash(nc *)',
  'Bash(ncat *)',
  'Bash(certutil -urlcache *)',
  'Bash(bitsadmin *)',
  'WebFetch',
  'WebSearch',

  // Credential stores, plus the environment dumps that print every secret the
  // session holds (the worker's own auth token included) into on-disk logs.
  'Bash(env)',
  'Bash(env *)',
  'Bash(printenv)',
  'Bash(printenv *)',
  'Bash(set)',
  'Read(~/.ssh/**)',
  'Write(~/.ssh/**)',
  'Edit(~/.ssh/**)',
  'MultiEdit(~/.ssh/**)',
  'Read(~/.aws/**)',
  'Write(~/.aws/**)',
  'Read(~/.azure/**)',
  'Read(~/.gnupg/**)',
  'Write(~/.gnupg/**)',
  'Read(~/.netrc)',
  'Read(~/.git-credentials)',
  'Read(~/.npmrc)',
  'Write(~/.npmrc)',
  'Edit(~/.npmrc)',
  'Read(~/.docker/config.json)',

  // Operating-system / installed-software directories: never a job's business.
  'Write(C:/Windows/**)',
  'Edit(C:/Windows/**)',
  'MultiEdit(C:/Windows/**)',
  'Write(C:/Program Files/**)',
  'Edit(C:/Program Files/**)',
  'MultiEdit(C:/Program Files/**)',
  'Write(C:/ProgramData/**)',
  'Edit(C:/ProgramData/**)',
  'Write(/etc/**)',
  'Edit(/etc/**)',
  'Write(/usr/**)',
  'Edit(/usr/**)',
  'Write(/System/**)',
  'Edit(/System/**)',

  // Repository-local secrets and git hooks (a written hook is code execution
  // on the NEXT git command). Best effort: these depend on the CLI resolving
  // relative / glob patterns, whereas the rules above are exact.
  'Read(**/.env)',
  'Read(**/.env.local)',
  'Read(**/.env.*.local)',
  'Write(.git/hooks/**)',
  'Edit(.git/hooks/**)',
  'Write(**/.git/hooks/**)',
  'Edit(**/.git/hooks/**)',
];

export interface WorkerDenyResolution {
  /** Never empty: the built-in floor ∪ the file's own rules (deduplicated). */
  deny: string[];
  /** 'floor' = only the built-in floor applies; 'whitelist+floor' = the file's
   *  own rules were added on top of it. */
  source: 'floor' | 'whitelist+floor';
  /** Floor rules the file did NOT already carry (they were added by us). */
  addedByFloor: string[];
  /** File rules that are not part of the floor (the file's own extensions). */
  addedByFile: string[];
}

/**
 * Resolve the deny rules for a worker permission payload.
 *
 * UNION, never "the file wins": the built-in floor is a SECURITY POLICY FLOOR —
 * a configured whitelist may ADD prohibitions on top of it, but must never
 * LOWER it. That is the whole point of an irreducible baseline: whoever writes
 * the config file (the user, a copy-pasted template, or a prompt-injected
 * writer) can tighten the policy but cannot talk the product out of blocking
 * irreversible actions (credential-store reads, bulk deletes, network egress,
 * push/publish).
 *
 * The distinction that matters, and that must not be "fixed" back:
 *   - `allow` — a GRANT. We never widen it on the user's behalf: a file's allow
 *     list, however narrow, is used as written (that rule lives in
 *     writeJobSettings / DEFAULT_WORKER_ALLOW, not here).
 *   - `deny` — a PROHIBITION. Taking the union with the floor only ever removes
 *     capabilities, so it can never contradict the "never grant more than the
 *     user asked for" rule. A file that is a strict subset of the floor —
 *     e.g. the shipped template before it carried the floor rules — is
 *     therefore a config that gets CLOSED UP, not a config that overrides.
 *
 * Order is deterministic: the file's rules verbatim (in file order), then the
 * floor rules the file did not already carry (in floor order). The result is
 * never empty, whatever the input (missing file / invalid JSON / no `deny` key
 * / empty array / wrong types).
 */
export function resolveWorkerDeny(fileDeny: unknown): WorkerDenyResolution {
  // Deduplicated while preserving file order: permission rules are a set, and a
  // file that repeats a rule must not produce a payload that repeats it too.
  const rules = [
    ...new Set(Array.isArray(fileDeny) ? fileDeny.filter((r): r is string => typeof r === 'string' && r.trim().length > 0) : []),
  ];
  const fileSet = new Set(rules);
  const floorSet = new Set(DEFAULT_WORKER_DENY);
  const addedByFloor = DEFAULT_WORKER_DENY.filter((r) => !fileSet.has(r));
  return {
    deny: [...rules, ...addedByFloor],
    source: rules.length > 0 ? 'whitelist+floor' : 'floor',
    addedByFloor,
    addedByFile: rules.filter((r) => !floorSet.has(r)),
  };
}

export type WorkerWhitelistProblem =
  | 'ok'
  | 'no_home_directory'
  | 'file_not_found'
  | 'invalid_json'
  | 'permissions_missing'
  | 'no_usable_deny'
  | 'deny_floor_added'
  | 'allow_not_an_array';

export interface WorkerWhitelistRead {
  /** Resolved whitelist path, or null when no home directory could be used. */
  path: string | null;
  /** The file's `permissions` object when it could be read, else undefined. */
  permissions?: Record<string, unknown>;
  /** True only when a file was read AND carried a `permissions` object. */
  usable: boolean;
  problem: WorkerWhitelistProblem;
  /** Path-free, human-readable sentence: safe for logs, MCP output and health. */
  detail: string;
}

/**
 * Single source of truth for "can the worker whitelist actually be used, and
 * what did we have to substitute?". Every consumer (supervisor payload,
 * scheduler warnings, health notes) asks this instead of re-deriving the
 * answer, so a substitution can never apply silently in one path while another
 * path still reports the file as read.
 *
 * `problem` is 'ok' ONLY when the file was read, carries a permissions object,
 * an array allow list, and a deny list that already covers the whole built-in
 * floor — i.e. when nothing at all was substituted. Any other value means
 * something was substituted or added and the caller is expected to surface it.
 * Priority when several apply: no-deny-list > floor-added > allow-not-an-array
 * (the first is the most consequential; the caller-facing warning is built from
 * the raw facts, not from this code, so no fact is lost there).
 */
export function readWorkerWhitelist(): WorkerWhitelistRead {
  const target = whitelistPath();
  if (!target) {
    return {
      path: null,
      usable: false,
      problem: 'no_home_directory',
      detail: 'worker whitelist path cannot be resolved (no home directory)',
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf-8'));
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    return {
      path: target,
      usable: false,
      problem: missing ? 'file_not_found' : 'invalid_json',
      detail: missing ? 'worker whitelist file not found' : 'worker whitelist unreadable or invalid JSON',
    };
  }
  const permissions = (raw as { permissions?: unknown } | null)?.permissions;
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    return {
      path: target,
      usable: false,
      problem: 'permissions_missing',
      detail: 'worker whitelist has no permissions object',
    };
  }
  const perms = permissions as Record<string, unknown>;
  const allowOk = Array.isArray(perms.allow);
  const resolution = resolveWorkerDeny(perms.deny);
  const problem: WorkerWhitelistProblem =
    resolution.source === 'floor'
      ? 'no_usable_deny'
      : resolution.addedByFloor.length > 0
        ? 'deny_floor_added'
        : allowOk
          ? 'ok'
          : 'allow_not_an_array';
  const detail =
    problem === 'ok'
      ? 'worker whitelist loaded'
      : problem === 'no_usable_deny'
        ? 'worker whitelist carries no usable deny list'
        : problem === 'deny_floor_added'
          ? `deny list misses ${resolution.addedByFloor.length} built-in baseline rule(s)`
          : 'worker whitelist permissions.allow is not an array';
  return { path: target, permissions: perms, usable: true, problem, detail };
}

// Optional read-guard hook. Previously injected unconditionally from a personal
// path with no existence check, so every Read on a new machine produced a
// failing hook. Set ORCHESTRATOR_READ_GUARD_HOOK=off to disable explicitly.
export function readGuardHookPath(): string | undefined {
  const raw = (process.env.ORCHESTRATOR_READ_GUARD_HOOK ?? '').trim();
  if (raw === 'off' || raw === '0' || raw === 'false') return undefined;
  let candidate = raw;
  if (!candidate) {
    const home = process.env.USERPROFILE || process.env.HOME;
    if (!home) return undefined;
    candidate = path.join(home, '.claude', 'cache-sentinel', 'read-guard.cjs');
  }
  return fs.existsSync(candidate) ? candidate : undefined;
}
