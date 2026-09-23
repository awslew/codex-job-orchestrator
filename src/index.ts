// Claude Code Async Orchestrator — MCP server entry point.
//
// Exposes nine small, stable tools:
//   claude_code_start   launch a detached job, return within 10s
//   claude_code_status  compact status + short progress tail
//   claude_code_wait    long-poll up to 240s (single call < 300s boundary)
//   claude_code_watch   event-driven wait; suspended until terminal/attention
//   claude_code_reply   resume a saved session with a narrow instruction
//   claude_code_cancel  terminate only the target job
//   claude_code_list    compact metadata for restart recovery
//   claude_code_health  read-only health/version/reload diagnostics
//   claude_code_retention_preview  read-only retention dry-run preview
//
// On startup it recovers in-flight jobs from the job store.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  startJob,
  getStatus,
  getRenderedStatus,
  waitForJob,
  watchJob,
  replyJob,
  cancelJob,
  listJobsView,
  recoverJobs,
  startAdmissionPump,
  shutdownActiveJobs,
} from './scheduler.js';
import type { Profile, Parallelism, TaskType } from './router.js';
import { CONTRACT_V2_SCHEMA_VERSION } from './contracts-v2.js';
import { WAIT_MAX_SECONDS, WATCH_MIN_SECONDS, WATCH_MAX_SECONDS, distDir, runtimeRoot, registryHeartbeatMs, registryStaleAfterMs, retentionV2Enabled } from './config.js';
import { computeHealth, packageVersion, sha256File, computeBuildFingerprint } from './health.js';
import {
  registerInstance,
  snapshotRegistry,
  defaultInspector,
  type RegistryHandle,
  type RegistrySnapshot,
} from './registry.js';
import { planRetention, defaultRetentionPolicy, type RetentionPlanItem } from './retention.js';

// Startup fingerprint: the SHA-256 of the entry THIS process actually loaded
// (legacy field) plus a deterministic root hash over the whole production dist
// module set, both captured at module load (before any on-disk rebuild could
// change them), plus the process identity and the single-source version.
const ENTRY_PATH = fileURLToPath(import.meta.url);
const STARTED_AT = Date.now();
const LOADED_BUILD_HASH = sha256File(ENTRY_PATH);
const LOADED_BUILD_FINGERPRINT = computeBuildFingerprint(distDir());
const SERVER_VERSION = packageVersion();

// Stage 5 instance registry: register THIS process before the server is ready
// and start the heartbeat. If registration fails we must NOT let health claim a
// healthy registry — the failure is recorded and surfaced. The heartbeat is
// unref'd and never holds the process open; normal shutdown best-effort
// unregisters (crash residue is handled by stale/identity detection).
let registryHandle: RegistryHandle | null = null;
let registryRegisterError: string | null = null;
try {
  registryHandle = registerInstance({
    entry: path.basename(ENTRY_PATH),
    buildFingerprint: LOADED_BUILD_FINGERPRINT,
    version: SERVER_VERSION,
    serverStartedAt: STARTED_AT,
  });
} catch (e) {
  registryRegisterError = String(e);
  process.stderr.write(`instance registry registration failed: ${String(e)}\n`);
}
process.on('exit', () => {
  try {
    registryHandle?.unregister();
  } catch {
    /* best effort; crash residue is covered by stale/identity detection */
  }
});

// Graceful-shutdown reaping: on SIGINT/SIGTERM, tree-kill the supervisor and
// worker processes this instance spawned (ownership-verified inside
// shutdownActiveJobs — other instances' jobs are never touched), so a manual
// restart does not leak detached trees. Hard kills on Windows bypass signals;
// recovery remains the primary safety net for those.
let shutdownReaped = false;
for (const sig of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) {
  process.on(sig, () => {
    if (shutdownReaped) return;
    shutdownReaped = true;
    try {
      const diagnostics = shutdownActiveJobs();
      if (diagnostics.length > 0) {
        process.stderr.write(`shutdownActiveJobs: ${diagnostics.join('; ')}\n`);
      }
    } catch (e) {
      process.stderr.write(`shutdownActiveJobs failed: ${String(e)}\n`);
    }
    process.exit(1);
  });
}

// Build the registry snapshot for a health call. Never mutates anything.
function currentRegistrySnapshot(): RegistrySnapshot {
  return snapshotRegistry({
    instanceId: registryHandle?.instanceId ?? null,
    now: Date.now(),
    heartbeatMs: registryHeartbeatMs(),
    staleAfterMs: registryStaleAfterMs(),
    inspector: defaultInspector,
  });
}

// Wave 4B2c: resolve the per-worker parallelism directive. internalAgentParallelism
// is the primary name; legacy `parallelism` is an alias. Both provided with
// different values is a fixed invalid-arguments error (identical values are
// accepted); the resolved value flows to startJob.parallelism only.
function resolveInternalAgentParallelism(params: { parallelism?: unknown; internalAgentParallelism?: unknown }): Parallelism | undefined {
  const { parallelism, internalAgentParallelism } = params;
  if (
    parallelism !== undefined &&
    internalAgentParallelism !== undefined &&
    parallelism !== internalAgentParallelism
  ) {
    throw new Error('invalid params: parallelism and internalAgentParallelism must agree when both are provided');
  }
  return (internalAgentParallelism ?? parallelism) as Parallelism | undefined;
}

const server = new McpServer({
  name: 'claude-code-orchestrator',
  version: SERVER_VERSION,
});

// Record the tools actually registered by THIS process so claude_code_health can
// prove capabilities from in-process facts — never by reading disk source. The
// SDK's internal tools/list handler uses its own registry, so shadowing
// registerTool here only adds observability; it changes nothing about the wire.
const registeredTools: string[] = [];
const serverRegisterTool = server.registerTool.bind(server);
server.registerTool = ((name: unknown, ...args: unknown[]): unknown => {
  registeredTools.push(String(name));
  return (serverRegisterTool as (...rest: unknown[]) => unknown)(name, ...args);
}) as never;

interface StartArgs {
  prompt: string;
  workFolder: string;
  profile?: string;
  parallelism?: string;
  internalAgentParallelism?: string;
  desiredWorkerConcurrency?: number;
  maxRuntimeMinutes?: number;
  taskType?: string;
  deliverablePath?: string;
  contract?: unknown;
}
interface IdArgs {
  jobId: string;
}
interface WaitArgs extends IdArgs {
  waitSeconds?: number;
}
interface WatchArgs extends IdArgs {
  timeoutSeconds?: number;
}
interface ReplyArgs extends IdArgs {
  prompt: string;
  // Wave 3B reply preflight overrides. allowFreshTurn is honored for BOTH
  // backends regardless of the flag (the harness gate is unconditional);
  // allowLargeResume only applies to Claude under ORCHESTRATOR_REPLY_PREFLIGHT=1.
  allowLargeResume?: boolean;
  allowFreshTurn?: boolean;
}
interface CancelArgs extends IdArgs {
  reason?: string;
}
interface ListArgs {
  limit?: number;
}

server.registerTool(
  'claude_code_start',
  {
    title: 'Start an async worker job',
    description:
      'Mandatory delegation: the calling model acts as the leader and owns requirements, design, decisions, acceptance and all user-facing reporting; implementation, investigation, reading and testing are dispatched to worker jobs through this tool instead of being performed in the leader session. Delegation is the default path and needs no separate user authorization — installed tools and historical rules neither authorize nor restrict it. The leader consumes only the compact worker summary; conclusions, recommendations and plans remain the leader\'s own work, and conclusions produced by a worker are inputs only, never the leader\'s decision. Acceptance is performed from the worker\'s compact summary (status, deliverable path/hash, gate results), not by re-reading the full diff or logs in the leader session. Validate params, then launch a detached Claude or DeepSeek Harness worker job in the background and return within 10s with jobId + sessionId + routing. ' +
      'Manage with claude_code_status / claude_code_wait / claude_code_reply / claude_code_cancel / claude_code_list. ' +
      'Backend capability contract: workerBackend=deepseek-harness has supportsAttention=false, supportsLiveEvents=false, supportsSessionResume=false; its fresh_turn is an independent bounded turn and must never be called a resume. ' +
      'Profiles: auto = 15721 + permission-mode bypassPermissions (implementation default; Auto Mode permission classifier removed on 2026-08-26 per user decision — the classifier timed out through the DeepSeek route and blocked already-approved work). There is NO sandbox in this profile: the worker runs as your OS user and may execute commands, read/write files and reach the network. Deny rules are evaluated first and win over allow; the effective deny list is the UNION of the built-in baseline (bulk deletes, network egress, credential stores, env/printenv, system dirs) and the rules in your whitelist file — a config file can raise that bar but never lower it — and they are literal string-prefix matches, a guard against accidents rather than an enforced boundary. The start response reports in warnings[] whenever the baseline had to be unioned or the allow list fell back. workFolder is only validated as "absolute path that exists": there is no root allowlist, so the caller must choose it deliberately; ' +
      'review = 15721 + permission-mode plan (read-only); normal = 15721 + permission-mode acceptEdits (manual control / failure fallback only). ' +
      'Optional taskType=execution (default) | research | analysis: research/analysis produce exactly ONE primary artifact, a Markdown report written to the leader-provided absolute deliverablePath (inside workFolder, .md, not equal to workFolder), which the supervisor verifies with SHA-256 before publishing the terminal status. Research/analysis reports are evidence-only (facts, constraints, option pros/cons) and must distinguish evidence from inference; conclusions, recommendations and plans remain the leader\'s own work, and a worker never decides for the leader. On the review profile this combination is handled automatically: the scheduler switches the job to permission-mode default and grants a single-file write allowance for deliverablePath only (plan mode would deadlock the report write); every other write still escalates. ' +
      'execution (and omitted taskType) is the existing behavior and rejects a supplied deliverablePath to keep the contract unambiguous. ' +
      'The auto profile intentionally runs bypassPermissions (no permission classifier; every tool call proceeds without model-backed approval). Deny rules still take precedence and hard-block their matching actions (git push / shutdown/format / C:/Windows & C:/Program Files writes from your whitelist; the built-in default deny list — bulk deletes, network egress, credential stores, env/printenv — whenever the whitelist file is missing or unusable), but they are literal prefix matches only and can be bypassed by other spellings, scripts or npx — do not treat them as a sandbox. This is the 2026-08-26 user decision: the permission classifier is removed on every launch path. ' +
      'Admission contract: desiredWorkerConcurrency may exceed 4 up to the schema maximum 64; the controller has no fixed limit of 4, and queueing is represented only by structured admission reasons. ' +
      'Because delegation is the default path, keep file ownership and build/runtime resources separate across concurrent worker jobs; serialize dependencies and shared resources. For independent items, start jobs back-to-back and watch each job separately; a file set has exactly one writer. Backend operation details live in the repository docs and describe how worker jobs run, not whether to delegate.',
    inputSchema: {
      prompt: z.string().min(1).describe('The task prompt. The scheduler wraps it in a bounded task protocol without rewriting it.'),
      workFolder: z.string().describe('Absolute path to the job working directory. Relative paths are rejected.'),
      profile: z.string().optional().describe('Routing profile: auto (default) | review | normal. Invalid values are rejected by the scheduler.'),
      parallelism: z.string().optional().describe("Legacy alias of internalAgentParallelism (kept for backward compatibility). auto (default) or 1-4; controls the parallelism directive INSIDE a single worker. Must equal internalAgentParallelism when both are supplied."),
      internalAgentParallelism: z.enum(['auto', '1', '2', '3', '4']).optional().describe("Per-worker internal sub-agent parallelism: auto (default) or 1-4. This is the single worker's OWN parallelism directive — it is independent of desiredWorkerConcurrency (how many workers the leader wants concurrently). Old clients keep using the legacy `parallelism` alias."),
      desiredWorkerConcurrency: z.number().int().min(1).max(64).optional().describe("Optional explicit leader-level target for how many workers run concurrently for this job (1-64). Passed to the admission controller as the job's desired worker concurrency; it never mixes with parallelism/internalAgentParallelism (which stay per-worker-internal). Without an explicit value the policy default applies. When admission control is enabled, the actual start may still wait in the queue behind structured limits (hard safety ceiling, heavy/resource-class caps, memory reserve, derived-space conflicts with other build/heavy jobs) — those are the ONLY reasons an explicit desired target is not met immediately; it is never capped to a fixed low default."),
      maxRuntimeMinutes: z.number().int().min(30).max(180).optional().describe('Hard runtime cap in minutes. Default 120. Range 30-180.'),
      taskType: z.enum(['execution', 'research', 'analysis']).optional().describe('Task kind: execution (default) | research | analysis. research/analysis require a deliverablePath; omitted means execution (existing behavior).'),
      deliverablePath: z.string().optional().describe('Absolute path to the single Markdown report artifact for research/analysis. Must be an absolute path inside workFolder, name a .md file case-insensitively, and not equal workFolder. Required for research/analysis; rejected for execution.'),
      workerBackend: z.enum(['claude', 'deepseek-harness']).optional().describe('Worker adapter: claude (default, backward-compatible) or deepseek-harness (local DeepSeek Harness headless adapter).'),
      contract: z
        .object({
          schemaVersion: z.literal(CONTRACT_V2_SCHEMA_VERSION).describe(`Task contract schema version. Must be ${CONTRACT_V2_SCHEMA_VERSION}.`),
          scope: z
            .object({
              readGlobs: z.array(z.string()).describe('Read-file globs; every entry must stay inside workFolder.'),
              writeFiles: z.array(z.string()).describe('Write-file globs; every entry must stay inside workFolder.'),
              forbiddenGlobs: z.array(z.string()).describe('Forbidden-file globs; every entry must stay inside workFolder.'),
            })
            .describe('Task file scope.'),
          writePolicy: z.enum(['read_only_report', 'listed_writes', 'workspace_legacy']).describe('Write policy.'),
          budget: z
            .object({
              maxRuntimeMinutes: z.number().int().positive().describe('Positive integer minutes the job may run before it is force-stopped.'),
              reportOnlyAfterMinutes: z.number().int().min(0).optional().describe('Optional: only report (no live streaming) after this many minutes; 0 = immediately.'),
              maxFilesRead: z.number().int().positive().optional().describe('Optional: positive integer cap on distinct files read.'),
              maxSourceLines: z.number().int().positive().optional().describe('Optional: positive integer cap on source lines read.'),
              maxToolCalls: z.number().int().positive().optional().describe('Optional: positive integer cap on agent tool calls.'),
              maxBashCommands: z.number().int().positive().optional().describe('Optional: positive integer cap on bash commands run.'),
              explorationMinutes: z.number().int().min(0).optional().describe('Optional: non-negative integer exploration minutes; must not exceed maxRuntimeMinutes nor reportOnlyAfterMinutes.'),
              maxTranscriptBytes: z.number().int().positive().optional().describe('Optional: positive integer cap on transcript bytes captured.'),
              onExceeded: z.enum(['report_partial', 'fail']).optional().describe('Optional: behavior when a budget is exceeded.'),
            })
            .strict()
            .describe('Runtime budget.'),
          acceptance: z
            .array(
              z
                .object({
                  id: z.string().describe('1-64 chars from [A-Za-z0-9._-].'),
                  argv: z.array(z.string()).describe('Non-empty; every entry a non-empty string without NUL.'),
                  cwdRelative: z.string().describe('Relative path that must resolve inside workFolder.'),
                  timeoutSeconds: z.number().int().min(1).max(3600).describe('Integer seconds in [1, 3600].'),
                  required: z.boolean().describe('Whether this gate is required.'),
                  outputMaxChars: z.number().int().min(100).max(50000).describe('Integer chars in [100, 50000].'),
                })
                .strict(),
            )
            .describe('Acceptance gate commands.'),
          reporting: z
            .object({
              deliverablePath: z.string().optional().describe('When present: absolute .md path inside workFolder.'),
            })
            .strict()
            .describe('Deliverable reporting.'),
          admission: z
            .object({
              resourceClass: z.enum(['light', 'build', 'heavy']).describe('Resource class.'),
              priority: z.number().int().min(0).max(3).describe('Integer in [0, 3].'),
            })
            .strict()
            .describe('Admission policy.'),
        })
        .strict()
        .optional()
        .describe(
          `Optional v2 task contract (schemaVersion ${CONTRACT_V2_SCHEMA_VERSION}), strictly declaring every TaskContractV2 field. ` +
            'Strict validation runs in the scheduler (unknown top-level fields or invalid nested values are rejected before the job is created). ' +
            'Omitted keeps the existing behavior unchanged. The contract body is never exposed in any public job view — public output only reports contractSchemaVersion (and workerStatus/acceptanceStatus/gateResults mirrors). ' +
            'When the flags are enabled, the public views (status/list/watch) include compact metrics, budget, and report completeness — never prompt, env values, raw commands, or absolute paths.',
        ),
    },
  } as any,
  async (params: any) => {
    try {
      // Wave 4B2c: internalAgentParallelism is the primary name for the
      // per-worker parallelism directive; legacy `parallelism` stays as an
      // alias. Both provided with different values -> fixed invalid arguments
      // (identical values are fine). The resolved value goes to startJob as
      // parallelism; desiredWorkerConcurrency is passed separately and is
      // never mixed with it.
      const resolvedParallelism: Parallelism | undefined = resolveInternalAgentParallelism(params);
      const { job, warnings } = startJob({
        prompt: params.prompt,
        workFolder: params.workFolder,
        profile: params.profile as Profile | undefined,
        parallelism: resolvedParallelism,
        desiredWorkerConcurrency: params.desiredWorkerConcurrency,
        maxRuntimeMinutes: params.maxRuntimeMinutes,
        taskType: params.taskType as TaskType | undefined,
        deliverablePath: params.deliverablePath,
        workerBackend: params.workerBackend,
        contract: params.contract,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ job, warnings }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_status',
  {
    title: 'Get job status',
    description:
      "Return compact status for a job: queued|running|needs_attention|succeeded|failed|cancelled, elapsed time, last activity, idleSeconds (seconds since the worker's last real output; advisory for stall detection), a short RENDERED progress tail (assistant text / tool calls / result / meta), and the report path. Never returns the full log or the stored prompt. For needs_attention, also returns a sanitized structured attention summary (attentionDetail: requestId/tool/action/path/risk/at/message) so the leader sees what needs approval without extra calls; it never contains the full prompt, raw log, token, or diff. raw=true returns the raw stdout-log tail instead (debug only).",
    inputSchema: {
      jobId: z.string().min(1).describe('Job id returned by claude_code_start.'),
      progressLines: z.number().int().min(1).max(20).optional().describe('Rendered readable lines from the recent log tail. Default 3.'),
      raw: z.boolean().optional().describe('Return the raw stdout log tail instead of the rendered view (debug only).'),
    },
  } as any,
  async (params: any) => {
    try {
      const view = params.raw
        ? getStatus(params.jobId, 400)
        : getRenderedStatus(params.jobId, { lines: params.progressLines ?? 3 });
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_wait',
  {
    title: 'Wait for a job to finish or change state',
    description:
      'Long-poll a job until it reaches a terminal state (succeeded/failed/cancelled) or needs_attention, or until waitSeconds elapse (default 240, max 240). A single call never exceeds the 300s caller boundary. This is a fallback/recovery tool; the event-driven claude_code_watch is the default wait. When woken with the job still running, re-enter wait/watch immediately and SILENTLY — no user-facing narration between polls (heartbeat messages burn context for zero value).',
    inputSchema: {
      jobId: z.string().min(1).describe('Job id returned by claude_code_start.'),
      waitSeconds: z.number().int().min(1).max(WAIT_MAX_SECONDS).optional().describe('Polling budget in seconds. Default 240, max 240.'),
    },
  } as any,
  async (params: any) => {
    try {
      const view = await waitForJob(params.jobId, params.waitSeconds);
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_watch',
  {
    title: 'Watch a job until it finishes or needs attention',
    description:
      'Event-driven wait (default/max 14400s) that stays suspended until the job reaches succeeded/failed/cancelled/needs_attention, or a watch-level outcome occurs (timeout / client abort / not-found / internal-error). Never returns `running` while the job is running, so it costs zero model turns. Aborting or disconnecting the watch does NOT cancel the job or change its state; re-attach later with another watch on the same jobId (use claude_code_list/status once to confirm, then watch again). Returns a compact view only: jobId/status/wakeReason/substatus/elapsedSeconds/idleSeconds/reportPath/hasReport/replyMode, plus workerBackend/taskType/deliverablePath/deliverableHash/missingDeliverable when the job has them (replyMode is always present: null when the job never went through reply preflight, otherwise the executed mode: resume_session or fresh_turn). On needs_attention it additionally carries attentionDetail — a sanitized structured summary (requestId/tool/action/path/risk/at/message) so the leader sees what needs approval directly; never prompts, raw logs, tokens, or diffs. ' +
      'The needs_attention wake and attentionDetail are emitted only by a backend that supports that capability; deepseek-harness has supportsAttention=false and supportsLiveEvents=false and emits neither attention nor live events. ' +
      'For jobs already started, prefer event-driven watch to repeated status polling. Choose a wait duration that permits timely user updates. A watch only observes an existing job and never starts work: dispatch new work with a separate claude_code_start call.',
    inputSchema: {
      jobId: z.string().min(1).describe('Job id returned by claude_code_start.'),
      timeoutSeconds: z.number().int().min(WATCH_MIN_SECONDS).max(WATCH_MAX_SECONDS).optional().describe('Watch budget in seconds. Default 14400 (4h), max 14400.'),
    },
  } as any,
  (async (params: any, extra: any) => {
    try {
      const view = await watchJob(params.jobId, {
        timeoutSeconds: params.timeoutSeconds,
        signal: extra?.signal,
      });
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  }) as any,
);

server.registerTool(
  'claude_code_reply',
  {
    title: 'Reply to a job (Claude resume or a new independent harness turn)',
    description:
      'Continue a job. For a Claude-backend job this resumes its saved session (long context stays in Claude, not in Codex); for a deepseek-harness job the reply is ALWAYS a new independent bounded turn with a new session — the one-shot adapter never resumes a session. Returns a new reply jobId immediately; poll it with claude_code_watch. Rejected while the referenced job is still running. If the job is blocked on a permission request, the stale waiting process is terminated before resuming. When the referenced job was needs_attention, the reply job carries an optional sanitized response audit (attentionResponseAudit: kind/recordedAt/attention/effect/authorization=false) for observability only — a reply resumes the session and never authorizes an action. ' +
      'Reply preflight is capability-based and does NOT depend on any feature flag: a deepseek-harness reply is rejected with the fixed error prefix fresh_turn_authorization_required UNLESS allowFreshTurn=true is passed (the reply then runs as a NEW independent session with replyMode=fresh_turn — it is NOT a resume of the parent session, and nothing on the parent job/session/PID is touched before this gate runs). For a Claude session whose transcript exceeds the threshold (default 2 MiB, override ORCHESTRATOR_REPLY_TRANSCRIPT_MAX_BYTES; gated by ORCHESTRATOR_REPLY_PREFLIGHT=1), the reply is rejected with new_start_required (start a new job, or pass allowLargeResume=true to resume anyway). The reply mode is never fabricated: fresh_turn replies never claim session continuity.',
    inputSchema: {
      jobId: z.string().min(1).describe('Existing job id whose session to resume.'),
      prompt: z.string().min(1).describe('Narrow follow-up instruction (e.g. a fix request).'),
      allowLargeResume: z.boolean().optional().describe('Override: allow resuming a Claude session whose transcript exceeds the preflight threshold.'),
      allowFreshTurn: z.boolean().optional().describe('Override: allow a fresh bounded turn reply for a one-shot backend (deepseek-harness). The parent session is NOT resumed.'),
    },
  } as any,
  async (params: any) => {
    try {
      const { job, warnings } = replyJob(params.jobId, params.prompt, {
        allowLargeResume: params.allowLargeResume,
        allowFreshTurn: params.allowFreshTurn,
      });
      return { content: [{ type: 'text', text: JSON.stringify({ job, warnings }, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_cancel',
  {
    title: 'Cancel a job',
    description:
      'Terminate only the target job (kills its process tree), records status=cancelled with an optional reason, and leaves logs/report auditable. Other jobs are unaffected.',
    inputSchema: {
      jobId: z.string().min(1).describe('Job id to cancel.'),
      reason: z.string().optional().describe('Optional reason recorded in the job metadata.'),
    },
  } as any,
  async (params: any) => {
    try {
      const view = cancelJob(params.jobId, params.reason);
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_list',
  {
    title: 'List recent jobs',
    description:
      'Compact metadata for recent jobs (newest first), for recovery after an MCP or app restart. Never returns prompts, tokens, or full logs.',
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional().describe('Max entries to return. Default 20.'),
    },
  } as any,
  async (params: any) => {
    try {
      const jobs = listJobsView(params.limit ?? 20);
      return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

server.registerTool(
  'claude_code_health',
  {
    title: 'Health, version and reload diagnostics (read-only)',
    description:
      'Read-only health for the current MCP process: version (package.json single source), build fingerprint (loaded vs on-disk deterministic hash over the whole production dist module set, so a change to ANY dependency module triggers reload_required; legacy entry-only buildHash kept for reference), instance identity (pid/startedAt/uptimeSec/entry basename), capabilities actually registered by THIS process (tools incl. watch, structured attentionDetail, response audit, and the registered claude_code_retention_preview capability), runtime job counts and runtime dir basename, runtime.jobIndex (enabled/consistency/dirty/indexSize/jobFileCount/rebuildScheduled), registry.recorded, and reloadRequired + diagnostic. diagnostic is one of healthy/current | reload_required | hash_unavailable: healthy/current when both fingerprints are available and equal (reloadRequired=false); reload_required when both are available and differ (reloadRequired=true); hash_unavailable when either the loaded or the on-disk module set is unreadable/empty — conservative, reloadRequired=true, re-check after rebuild+reload. Stage 5 adds the instance registry: duplicate_instance_suspected (>=2 identity-verified live instances spanning >=2 DIFFERENT host PIDs in this runtime scope; instances of one host — Codex Desktop spawns one MCP instance per session window under the same app-server PID — are a normal multi-window setup and are NOT counted as duplicates) and registry_stale (heartbeat timeout / pid not found / PID-reuse identity mismatch / corrupt record) are now REAL diagnostics exposed via the registry section, the duplicateInstanceSuspected/registryStale booleans and the structured diagnostics[] array; stale residue never counts as a duplicate and no instance is ever auto-killed. If reloadRequired is true, reload/restart the claude_orchestrator MCP to pick up the on-disk build. Never returns prompts, tokens, raw logs, diffs, env values, keys, or the full command line.',
    inputSchema: {},
  } as any,
  (async () => {
    try {
      const view = computeHealth({
        entryPath: ENTRY_PATH,
        loadedBuildHash: LOADED_BUILD_HASH,
        loadedBuildFingerprint: LOADED_BUILD_FINGERPRINT,
        startedAt: STARTED_AT,
        registeredTools,
        version: SERVER_VERSION,
        registry: currentRegistrySnapshot(),
      });
      if (registryRegisterError) {
        view.notes.push(`instance registry registration failed: ${registryRegisterError}`);
      }
      return { content: [{ type: 'text', text: JSON.stringify(view, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  }) as any,
);

// Wave 5B2: read-only retention dry-run preview. There is deliberately NO
// apply/delete/cleanup tool: the planner's actions are never executed here.
// The tool is a pure read-only projection: it scans the EXISTING runtime root
// (no mkdir, no writes, no renames, no truncate/unlink/chmod, no symlink
// following), runs planRetention with the default policy (TTL overrides are
// optional, each clamped to [1h, 365d] by boundPolicy), and returns only the
// sanitized relative-path plan items — never the absolute runtime root, PIDs,
// heartbeats, prompts, env, tokens or file contents. It never reads job/report
// bodies (the planner's fixed scope excludes reports/ and job metadata).
//
// Behavior contract (Wave 5B2):
//   - ORCHESTRATOR_RETENTION_V2 off -> no runtime scan at all; the result is
//     { enabled:false, dryRun:true, items:[], nextCursor:null, totals with
//     every action count/bytes at 0 }.
//   - flag on -> items are the deterministic (action, relativePath)-sorted
//     plan restricted to the four candidate actions
//     (archive_registry/truncate_log_candidate/archive_claim_candidate/
//     archive_settings_candidate); keep/skip items are included ONLY when
//     includeKeep=true. totals are the FULL plan totals as returned by
//     planRetention with the TTL overrides applied; candidateCount is the total
//     number of the four candidate actions in the FULL plan (independent of
//     includeKeep and of pagination), and returnedCount/limit summarize this
//     page.
//   - cursor is a decimal offset into the full candidate item list;
//     invalid cursors are a fixed invalid-arguments error. Items are sliced
//     [cursor, cursor+limit); nextCursor is the next offset as a string, or
//     null when the last item of the page is the last candidate.
function emptyRetentionTotals(): Record<string, number> {
  const t: Record<string, number> = {};
  for (const a of ['archive_registry', 'truncate_log_candidate', 'archive_claim_candidate', 'archive_settings_candidate', 'keep', 'skip']) {
    t[a] = 0;
  }
  return t;
}

function retentionPreview(params: {
  limit?: number;
  cursor?: string;
  includeKeep?: boolean;
  succeededLogTtlDays?: number;
  failedLogTtlDays?: number;
  needsAttentionLogTtlDays?: number;
  terminalClaimSettingsTtlDays?: number;
  staleRegistryTtlDays?: number;
}): Record<string, unknown> {
  if (!retentionV2Enabled()) {
    return {
      enabled: false,
      dryRun: true,
      items: [],
      nextCursor: null,
      candidateCount: 0,
      returnedCount: 0,
      limit: params.limit ?? 200,
      totals: { counts: emptyRetentionTotals(), bytes: emptyRetentionTotals() },
    };
  }
  const base = defaultRetentionPolicy();
  const day = 24 * 60 * 60 * 1000;
  const policy = {
    succeededLogTtlMs: (params.succeededLogTtlDays ?? base.succeededLogTtlMs / day) * day,
    failedLogTtlMs: (params.failedLogTtlDays ?? base.failedLogTtlMs / day) * day,
    needsAttentionLogTtlMs: (params.needsAttentionLogTtlDays ?? base.needsAttentionLogTtlMs / day) * day,
    terminalClaimSettingsTtlMs: (params.terminalClaimSettingsTtlDays ?? base.terminalClaimSettingsTtlMs / day) * day,
    staleRegistryTtlMs: (params.staleRegistryTtlDays ?? base.staleRegistryTtlMs / day) * day,
  };
  const plan = planRetention({
    runtimeRoot: runtimeRoot(),
    now: Date.now(),
    policy,
    pidInspector: defaultInspector,
    overrides: { instanceId: registryHandle?.instanceId ?? null, heartbeatMs: 10_000, staleAfterMs: 30_000, identityToleranceMs: 5000 },
  });
  const CANDIDATE: ReadonlySet<string> = new Set([
    'archive_registry',
    'truncate_log_candidate',
    'archive_claim_candidate',
    'archive_settings_candidate',
  ]);
  const selected: RetentionPlanItem[] = [];
  let candidateCount = 0;
  for (const item of plan.items) {
    if (CANDIDATE.has(item.action)) {
      candidateCount += 1;
      selected.push(item);
    } else if (params.includeKeep === true) {
      selected.push(item);
    }
  }
  const limit = params.limit ?? 200;
  const offset = params.cursor === undefined ? 0 : parseInt(params.cursor, 10);
  const page = selected.slice(offset, offset + limit);
  const nextCursor = offset + page.length < selected.length ? String(offset + page.length) : null;
  return {
    enabled: true,
    dryRun: true,
    items: page,
    nextCursor,
    candidateCount,
    returnedCount: page.length,
    limit,
    totals: plan.totals,
  };
}

const RETENTION_TTL_DAY_FIELDS: ReadonlyArray<[string, string]> = [
  ['succeededLogTtlDays', 'TTL for succeeded-job logs in days (default 7).'],
  ['failedLogTtlDays', 'TTL for failed/cancelled-job logs in days (default 30).'],
  ['needsAttentionLogTtlDays', 'TTL for needs_attention-job logs in days (default 30).'],
  ['terminalClaimSettingsTtlDays', 'TTL for terminal jobs\' claims and settings in days (default 14).'],
  ['staleRegistryTtlDays', 'Continuous-stale TTL for registry records in days (default 1).'],
];

server.registerTool(
  'claude_code_retention_preview',
  {
    title: 'Preview retention candidates (read-only dry run)',
    description:
      'Read-only retention dry-run: scans the runtime root and returns plan data. Never mutates anything: it makes zero filesystem changes, and the scan follows no symlinks/reparse points. ' +
      'Each item is sanitized: relativePath (root-relative, forward slashes, never absolute), kind, action, fixedReason, ageMs, bytes, and jobId for job-scoped items. The response never contains the absolute runtime root, PIDs, heartbeats, prompts, env values, tokens, or file contents; job/report bodies are never read. ' +
      'Defaults (when ORCHESTRATOR_RETENTION_V2 is on): items contain only the four candidate actions (archive_registry, truncate_log_candidate, archive_claim_candidate, archive_settings_candidate); pass includeKeep=true to also list keep/skip items. totals are the full-plan totals (after any TTL overrides); candidateCount is the total count of the four candidate actions in the full plan, independent of includeKeep and pagination; returnedCount is the number of items on this page. ' +
      'Pagination: cursor is a decimal offset into the full candidate list; the page is sliced [cursor, cursor+limit); nextCursor is the next offset or null at the end. An invalid cursor is rejected. ' +
      'When ORCHESTRATOR_RETENTION_V2 is off, the runtime is NOT scanned: the result is { enabled:false, dryRun:true, items:[], nextCursor:null, totals with every action at 0 }. ' +
      'TTL overrides are optional integers in days, each clamped to [1h, 365d].',
    inputSchema: {
      limit: z.number().int().min(1).max(500).optional().describe('Max items to return. Default 200, range 1-500.'),
      cursor: z.string().optional().describe('Decimal offset (non-negative integer string) into the selected list (the four candidate actions, plus keep/skip when includeKeep=true). Omit to start at 0.'),
      includeKeep: z.boolean().optional().describe('When true, also include keep/skip items; default false (candidate actions only). Does not change candidateCount or totals, which always describe the full plan.'),
      ...Object.fromEntries(
        RETENTION_TTL_DAY_FIELDS.map(([k, d]) => [k, z.number().int().min(1).max(365).optional().describe(d)]),
      ),
    },
  } as any,
  async (params: any) => {
    try {
      if (params.cursor !== undefined && !/^[0-9]+$/.test(String(params.cursor))) {
        return { isError: true, content: [{ type: 'text', text: `invalid cursor: expected a non-negative integer offset, got "${String(params.cursor)}"` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(retentionPreview(params), null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
    }
  },
);

try {
} catch (e) {
  // Recovery must never prevent the server from coming up. stderr is safe;
  // the MCP server's stdout is the transport and must stay pure JSON-RPC.
  process.stderr.write(`recoverJobs failed: ${String(e)}\n`);
}
// Wave 4B2c startup wiring: the admission pump runs after recovery so that
// admission_wait jobs left by a previous process are candidates for the very
// first pass. startAdmissionPump is itself flag-gated and idempotent: with
// admission control off it returns without creating any poller.
startAdmissionPump();

const transport = new StdioServerTransport();
await server.connect(transport);
