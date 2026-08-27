/**
 * Loop detection from events.jsonl (SPEC §1 #9, §5).
 * Pure logic — no pi imports.
 */

import type { EventRecord } from "./events.ts";
import { normalizeCommand } from "./fingerprint.ts";

export interface LoopInfo {
  cmd: string;
  failures: number;
  lastExit: number | null;
}

/**
 * Failing-command streaks per fingerprint-normalized command for a session.
 * SPEC §1 #9 calls these "streaks": the count of failures since the LAST
 * SUCCESSFUL run of that same fingerprint — a success (ok=true) resets the
 * streak, a failure of a different command does not. This mirrors
 * loops.streaks() on the Python side exactly (same store, same arithmetic).
 */
export function failedAttempts(events: EventRecord[], session: string): Map<string, LoopInfo> {
  const map = new Map<string, LoopInfo>();
  for (const e of events) {
    if (e.kind !== "tool_result" || e.session !== session) continue;
    if (e.cmd === null) continue;
    const cmd = normalizeCommand(e.cmd); // defensive: storage should be normalized
    if (e.ok === true) {
      map.delete(cmd); // success resets the streak
      continue;
    }
    if (e.ok !== false) continue; // ok=null (unknown) → ignored, streak untouched
    const cur = map.get(cmd) ?? { cmd, failures: 0, lastExit: null };
    cur.failures += 1;
    if (e.exit !== null) cur.lastExit = e.exit;
    map.set(cmd, cur);
  }
  return map;
}

/**
 * Block when prior failures >= loop_block_after - 1 (3rd default attempt).
 * The max(1, …) clamp mirrors loops.block_threshold() on the Python side:
 * loop_block_after=1 must never block a command with zero prior failures.
 */
export function shouldBlockLoop(priorFailures: number, loopBlockAfter: number): boolean {
  return priorFailures >= Math.max(1, loopBlockAfter - 1);
}

/** FROZEN block reason format (SPEC §5). */
export function loopBlockReason(cmd: string, priorFailures: number): string {
  return (
    `guard: '${cmd}' already failed ${priorFailures} times this session — do not re-run unchanged; ` +
    `change approach or read the error. ` +
    `(Raise loop_block_after in .agent-guard/config.json to override.)`
  );
}

/** Commands currently in a failing loop (would be blocked on next attempt). */
export function openLoopsFromMap(map: Map<string, LoopInfo>, loopBlockAfter: number): LoopInfo[] {
  const out: LoopInfo[] = [];
  for (const info of map.values()) {
    if (shouldBlockLoop(info.failures, loopBlockAfter)) out.push(info);
  }
  out.sort((a, b) => b.failures - a.failures || a.cmd.localeCompare(b.cmd));
  return out;
}

/** Same, computed from raw events (disk path). */
export function openLoops(events: EventRecord[], session: string, loopBlockAfter: number): LoopInfo[] {
  return openLoopsFromMap(failedAttempts(events, session), loopBlockAfter);
}
