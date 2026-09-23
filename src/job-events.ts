// Shared, cross-process job event broker (lives in the MCP server process).
//
// The supervisor is a separate process, so in-process EventEmitters are not a
// valid state source for `claude_code_watch`. The broker instead watches the
// runtime/jobs directory and dispatches per-job events to in-process watchers.
// fs.watch is the primary source; an internal low-frequency fallback (active
// only while subscribers exist) re-checks subscribed jobs so a missed Windows
// fs.watch event can never strand a watch call.
//
// Contract:
//   - at most one fs.watch on the jobs directory, shared by all watchers
//   - dispatch by <jobId>.json and <jobId>.done.json filenames
//   - no subscribers -> directory watcher and fallback timer are closed
//   - watcher error -> close + schedule a rebuild; fallback covers the gap
//   - never cancels a job or changes its state; the broker only observes
import fs from 'node:fs';
import path from 'node:path';
import { jobsDir, ensureRuntimeDirs, WATCH_FALLBACK_MS } from './config.js';

type DirListener = (jobId: string, filename: string | null) => void;

type DirWatcherFactory = (
  dir: string,
  cb: (eventType: string, filename: string | null) => void,
) => fs.FSWatcher | null;

function defaultCreateDirWatcher(
  dir: string,
  cb: (eventType: string, filename: string | null) => void,
): fs.FSWatcher | null {
  try {
    return fs.watch(dir, cb);
  } catch {
    return null; // rely on the fallback
  }
}

// Test seam: tests can force fs.watch creation to fail (fallback-only mode).
export const jobEventTestHooks: { createDirWatcher?: DirWatcherFactory } = {};

export class JobEventBroker {
  private watcher: fs.FSWatcher | null = null;
  private fallback: NodeJS.Timeout | null = null;
  private rebuildTimer: NodeJS.Timeout | null = null;
  private listeners = new Map<string, Set<DirListener>>();

  private get totalSubscribers(): number {
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  /**
   * Subscribe to state-change notifications for a job. Returns an idempotent
   * unsubscribe function. The shared directory watcher + fallback start on the
   * first subscriber and are torn down when the last subscriber leaves.
   */
  subscribe(jobId: string, listener: DirListener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(listener);
    this.ensureStarted();
    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      const s = this.listeners.get(jobId);
      if (s) {
        s.delete(listener);
        if (s.size === 0) this.listeners.delete(jobId);
      }
      if (this.totalSubscribers === 0) this.stopAll();
    };
  }

  private ensureStarted(): void {
    this.ensureDirWatcher();
    if (!this.fallback) {
      this.fallback = setInterval(() => this.checkAll(), fallbackMs);
    }
  }

  private ensureDirWatcher(): void {
    if (this.watcher) return;
    ensureRuntimeDirs();
    const create = jobEventTestHooks.createDirWatcher ?? defaultCreateDirWatcher;
    const watcher = create(jobsDir(), (eventType, filename) => this.onDirEvent(eventType, filename));
    if (!watcher) return; // fallback-only mode
    watcher.on('error', (err) => this.onWatcherError(err));
    this.watcher = watcher;
  }

  private onDirEvent(_eventType: string, filename: string | null): void {
    if (filename) {
      const name = path.basename(String(filename));
      // Match <jobId>.json and <jobId>.done.json; ignore tmp/other files.
      if (name.endsWith('.json')) {
        const dot = name.indexOf('.');
        const base = dot > 0 ? name.slice(0, dot) : name;
        if (this.listeners.has(base)) this.emit(base, name);
      }
      return;
    }
    // Windows fs.watch may deliver a null filename; re-check subscribed jobs.
    this.checkAll();
  }

  private emit(jobId: string, filename: string | null): void {
    const set = this.listeners.get(jobId);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(jobId, filename);
      } catch {
        // a listener error must never break the broker
      }
    }
  }

  private checkAll(): void {
    for (const jobId of [...this.listeners.keys()]) this.emit(jobId, null);
  }

  private onWatcherError(_err: Error): void {
    // Close the broken watcher and schedule a rebuild; the fallback covers the
    // gap until it is re-established.
    try {
      this.watcher?.close();
    } catch {
      /* already broken */
    }
    this.watcher = null;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    if (this.totalSubscribers > 0) {
      this.rebuildTimer = setTimeout(() => {
        this.rebuildTimer = null;
        if (this.totalSubscribers > 0) this.ensureDirWatcher();
      }, WATCHER_REBUILD_MS);
      this.rebuildTimer.unref?.();
    }
  }

  private stopAll(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = null;
    }
    if (this.fallback) {
      clearInterval(this.fallback);
      this.fallback = null;
    }
    if (this.watcher) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  /** Read-only diagnostics (subscriber / watcher / fallback state). */
  diagnostics(): { subscribers: number; watcher: boolean; fallback: boolean } {
    return {
      subscribers: this.totalSubscribers,
      watcher: this.watcher !== null,
      fallback: this.fallback !== null,
    };
  }

  /** Test-only: force the live directory watcher to emit an error. */
  forceWatcherErrorForTest(err?: Error): boolean {
    if (!this.watcher) return false;
    this.watcher.emit('error', err ?? new Error('simulated fs.watch error'));
    return true;
  }

  /** Close everything and drop all subscribers (tests / shutdown). Idempotent. */
  close(): void {
    this.listeners.clear();
    this.stopAll();
  }
}

const WATCHER_REBUILD_MS = 1000;

let fallbackMs = WATCH_FALLBACK_MS;
/** Test seam: override the internal fallback poll interval. */
export function setFallbackMsForTest(ms: number): void {
  fallbackMs = ms;
}

const singleton = new JobEventBroker();
export function getJobEventBroker(): JobEventBroker {
  return singleton;
}

// Diagnostic/test seams (never touch job state).
export function brokerDiagnostics(): { subscribers: number; watcher: boolean; fallback: boolean } {
  return singleton.diagnostics();
}
export function closeJobEventBrokerForTest(): void {
  singleton.close();
}
/** Force the live directory watcher to emit an error (simulate fs.watch instability). */
export function emitWatcherErrorForTest(err?: Error): boolean {
  return singleton.forceWatcherErrorForTest(err);
}
