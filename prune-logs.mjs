#!/usr/bin/env node
// Prune orchestrator runtime logs by retention policy (2026-08-23, user-set):
//   succeeded jobs  -> keep logs 3 days past endedAt
//   failed/cancelled/unknown -> keep logs 7 days
// Covers runtime/logs/*.log and *.stderr.log. Job status is resolved from
// runtime/jobs/<jobId>.json; when the record is gone or unreadable the file's
// mtime is used with the 7-day (conservative) retention.
//
// Usage: node prune-logs.mjs [--dry-run]
// Scope: ONLY orchestrator runtime/logs. Session transcripts (~/.claude/
// projects/**/*.jsonl) are owned by whatever Claude Code maintenance job you
// run — deliberately NOT duplicated here.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dryRun = process.argv.includes('--dry-run');
const here = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(here, 'runtime');
const logsDir = path.join(runtimeDir, 'logs');
const jobsDir = path.join(runtimeDir, 'jobs');

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

function loadJobIndex() {
  const index = new Map();
  let files = [];
  try {
    files = fs.readdirSync(jobsDir);
  } catch {
    return index;
  }
  for (const f of files) {
    if (!f.endsWith('.json') || f.endsWith('.done.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(jobsDir, f), 'utf8'));
      if (j && typeof j.jobId === 'string') {
        index.set(j.jobId, { status: String(j.status ?? ''), endedAt: j.endedAt ?? null });
      }
    } catch {
      /* unreadable records simply fall back to mtime */
    }
  }
  return index;
}

function main() {
  if (!fs.existsSync(logsDir)) {
    console.log(`no logs dir at ${logsDir}; nothing to do`);
    return;
  }
  const jobIndex = loadJobIndex();
  let scanned = 0;
  let deleted = 0;
  let freedBytes = 0;
  const byPolicy = { succeeded: 0, failedish: 0 };

  for (const name of fs.readdirSync(logsDir)) {
    const full = path.join(logsDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    scanned++;
    const jobId = name.split('.')[0];
    const rec = jobIndex.get(jobId);
    const status = rec && rec.status ? rec.status : 'unknown';
    const refMs = rec && rec.endedAt ? Date.parse(rec.endedAt) : NaN;
    const ageFrom = Number.isFinite(refMs) ? refMs : st.mtimeMs;
    const retainDays = status === 'succeeded' ? 3 : 7;
    if (now - ageFrom > retainDays * DAY_MS) {
      deleted++;
      freedBytes += st.size;
      if (status === 'succeeded') byPolicy.succeeded++;
      else byPolicy.failedish++;
      if (!dryRun) {
        try {
          fs.unlinkSync(full);
        } catch (e) {
          deleted--;
          freedBytes -= st.size;
          console.error(`failed to delete ${name}: ${String(e)}`);
        }
      }
    }
  }

  let remainingBytes = 0;
  let remainingFiles = 0;
  for (const name of fs.readdirSync(logsDir)) {
    try {
      remainingFiles++;
      remainingBytes += fs.statSync(path.join(logsDir, name)).size;
    } catch {
      /* raced a delete; ignore */
    }
  }
  const mb = (n) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  console.log(
    `${dryRun ? '[dry-run] ' : ''}scanned=${scanned} deleted=${deleted} ` +
      `freed=${mb(freedBytes)} (succeeded>3d: ${byPolicy.succeeded}, other>7d: ${byPolicy.failedish}) | ` +
      `remaining=${remainingFiles} files ${mb(remainingBytes)}`
  );
}

main();
