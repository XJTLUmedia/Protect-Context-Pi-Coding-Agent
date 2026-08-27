/**
 * Evidence ledger (.agent-guard/verify_runs.jsonl) formatting (SPEC §1 #2, §2).
 * Pure logic — no pi imports; command execution lives in index.ts.
 */

import { appendJsonl, readJsonl, verifyRunsPath } from "./store.ts";
import { CMD_DISPLAY_MAX, truncLine } from "./brief.ts";

export interface VerifyRun {
  id: string;
  ts: string;
  session: string;
  cmd: string;
  exit: number;
  ok: boolean;
  digest: string;
  ms: number;
}

/** FROZEN digest rule: last ≤2000 chars of combined stdout+stderr. */
export function digestOf(stdout: string, stderr: string): string {
  return `${stdout}${stderr}`.slice(-2000);
}

// Timeout clamps (mirrors verify._clamp_timeout on the Python side): a
// model-supplied timeout_s can never wedge the session.
export const TIMEOUT_MIN_S = 1;
export const TIMEOUT_MAX_S = 900;
export const TIMEOUT_DEFAULT_S = 180;

/** Clamp a timeout to [TIMEOUT_MIN_S, TIMEOUT_MAX_S]; non-finite input falls
 *  back to the default. Fractions are truncated to whole seconds. */
export function clampTimeoutS(v: number | null | undefined): number {
  const t = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : TIMEOUT_DEFAULT_S;
  return Math.max(TIMEOUT_MIN_S, Math.min(TIMEOUT_MAX_S, t));
}

/** Next evidence id "ev-NNNN" based on the max existing suffix. */
export function nextEvidenceId(runs: VerifyRun[]): string {
  let max = 0;
  for (const r of runs) {
    const m = r.id.match(/^ev-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `ev-${String(max + 1).padStart(4, "0")}`;
}

export function readVerifyRuns(cwd: string): VerifyRun[] {
  return readJsonl<VerifyRun>(verifyRunsPath(cwd));
}

export function appendVerifyRun(cwd: string, run: VerifyRun): void {
  appendJsonl(verifyRunsPath(cwd), run);
}

export function formatMs(ms: number | null): string {
  if (ms === null) return "?s";
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One compact evidence line: `ev-0002 exit=0 'npm test' 3.2s`. The command
 *  is truncated (goal #12) — never inject an unbounded one-liner. */
export function formatVerifyLine(run: VerifyRun): string {
  return `${run.id} exit=${run.exit} '${truncLine(run.cmd, CMD_DISPLAY_MAX)}' ${formatMs(run.ms)}`;
}

export function runsForSession(runs: VerifyRun[], session: string): VerifyRun[] {
  return runs.filter((r) => r.session === session);
}
