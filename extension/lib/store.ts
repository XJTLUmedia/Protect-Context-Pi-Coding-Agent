/**
 * Store access for `.agent-guard/` (SPEC §2).
 * Node builtins only. lib modules stay free of pi imports.
 *
 * Appends are serialized by the best-effort store lock below (SPEC §2 asks
 * for locking on `.agent-guard/.lock` in BOTH implementations) and are single
 * O_APPEND line writes, so a lost race never corrupts data.
 */

import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  existsSync,
  renameSync,
  writeFileSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export const STORE_DIR_NAME = ".agent-guard";

export function storeDir(cwd: string): string {
  return join(cwd, STORE_DIR_NAME);
}

export function ensureStore(cwd: string): string {
  const dir = storeDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(cwd: string): string {
  return join(storeDir(cwd), "config.json");
}
export function contractPath(cwd: string): string {
  return join(storeDir(cwd), "contract.json");
}
export function journalPath(cwd: string): string {
  return join(storeDir(cwd), "journal.jsonl");
}
export function eventsPath(cwd: string): string {
  return join(storeDir(cwd), "events.jsonl");
}
export function verifyRunsPath(cwd: string): string {
  return join(storeDir(cwd), "verify_runs.jsonl");
}
export function statePath(cwd: string): string {
  return join(storeDir(cwd), "state.json");
}

// ---------------------------------------------------------------------------
// Best-effort store lock (SPEC §2: both implementations serialize appends on
// the same `.agent-guard/.lock` file).
//
// Node exposes no flock syscall and the extension must keep zero npm
// dependencies, so the TypeScript side implements the lock as an
// exclusive-create (`wx`) lockfile: a holder removes `.lock` in a finally; a
// lock that cannot be acquired within LOCK_TIMEOUT_MS is presumed stale
// (crashed holder) or foreign (the Python side keeps its flock file on disk
// after releasing) and is broken best-effort rather than wedging the session.
// Appends themselves are single O_APPEND line writes, atomic for these small
// records on POSIX local filesystems, so a lost race never corrupts data.

const LOCK_TIMEOUT_MS = 500;
const LOCK_RETRY_MS = 10;

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  try {
    Atomics.wait(sleepBuffer, 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait fallback when Atomics.wait is unavailable on this thread
    }
  }
}

/** Run `fn` while holding the best-effort store lock for directory `dir`. */
export function withStoreLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lockFile = join(dir, ".lock");
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | null = null;
  for (;;) {
    try {
      fd = openSync(lockFile, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        try {
          unlinkSync(lockFile); // break stale/foreign lock, best-effort
        } catch {
          // lost a race with another breaker; proceed unlocked
        }
        try {
          fd = openSync(lockFile, "wx");
        } catch {
          fd = null;
        }
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort
      }
      try {
        unlinkSync(lockFile);
      } catch {
        // best-effort
      }
    }
  }
}

/** Append one JSON record as a single O_APPEND line write. The caller must
 *  already hold the store lock (see withStoreLock). */
export function appendJsonlLocked(file: string, record: unknown): void {
  appendFileSync(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Append one JSON record under the best-effort store lock (SPEC §2). */
export function appendJsonl(file: string, record: unknown): void {
  withStoreLock(dirname(file), () => appendJsonlLocked(file, record));
}

interface StatLike {
  mtimeMs: number;
  size: number;
}

function statOf(file: string): StatLike | null {
  try {
    const st = statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** Cheap change-detection stamp for a file ("mtimeMs:size"), or null when it
 *  does not exist. readJsonl caches the parse by the same signal; this lets
 *  callers also memoize higher-level derived state (e.g. the per-session
 *  evidence slice) so hot paths stay O(1) without re-reading the ledger. */
export function fileStamp(file: string): string | null {
  const st = statOf(file);
  return st ? `${st.mtimeMs}:${st.size}` : null;
}

const jsonlCache = new Map<string, { mtimeMs: number; size: number; data: unknown[] }>();

/** Read a JSONL file into records; missing file → []. Results cached by mtime+size. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const st = statOf(file);
  if (!st) return [];
  const cached = jsonlCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data as T[];
  }
  const data: unknown[] = [];
  const text = readFileSync(file, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      data.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed lines; the ledger stays readable.
    }
  }
  jsonlCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data as T[];
}

export function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Atomic-ish JSON write: unique tmp file + rename. Creates parent dirs.
 *  Unique per-write tmp name avoids clobbering a concurrent writer's tmp. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// state.json (SPEC §2)

export interface GuardState {
  current_session: { id: string; started: string; git_head: string | null };
  brief_digest: string | null;
  notify_watermarks: { ctx_pct: number; diff_lines: number; diff_files: number };
  /** Opaque passthrough on the Python side; the extension stores digests here
   *  (e.g. the orientation digest) alongside numeric counters. */
  counters: Record<string, number | string>;
}

export function defaultState(sessionId: string, gitHead: string | null): GuardState {
  return {
    current_session: { id: sessionId, started: new Date().toISOString(), git_head: gitHead },
    brief_digest: null,
    notify_watermarks: { ctx_pct: 0, diff_lines: 0, diff_files: 0 },
    counters: {},
  };
}

export function loadState(cwd: string): GuardState | null {
  return readJson<GuardState>(statePath(cwd));
}

export function saveState(cwd: string, state: GuardState): void {
  writeJson(statePath(cwd), state);
}
