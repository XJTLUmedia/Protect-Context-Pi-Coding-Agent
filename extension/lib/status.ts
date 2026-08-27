/**
 * Compact status dashboard shared by /guard-status, /guard-report and the
 * guard_status tool (SPEC §5). Pure formatting — no pi imports.
 */

import type { LoopInfo } from "./loops.ts";
import { CMD_DISPLAY_MAX, truncLine } from "./brief.ts";
import { formatVerifyLine, type VerifyRun } from "./verify.ts";

export interface StatusData {
  session: string;
  gitHead: string | null;
  diffLines: number;
  diffFiles: number;
  loops: LoopInfo[];
  evidenceCount: number;
  contractCount: number;
  lastVerify: VerifyRun | null;
  ctxPct: number | null;
  /** Configured diff thresholds (gatherStatus populates these from config.json,
   *  so the nudge never lies about a tuned threshold). */
  diffWarnLines: number;
  diffHardLines: number;
}

/** Two compact lines + Nudge. */
export function buildStatus(d: StatusData): string {
  const pct = d.ctxPct === null ? "?" : `${Math.round(d.ctxPct)}%`;
  const head = d.gitHead === null ? "norepo" : d.gitHead.slice(0, 8);
  const lines: string[] = [];
  lines.push(
    `PC s=${d.session.slice(0, 8)} git=${head} Δ+${d.diffLines}L/${d.diffFiles}f ` +
      `loops=${d.loops.length} ev=${d.evidenceCount} contract=${d.contractCount} ctx=${pct}`,
  );
  if (d.lastVerify) {
    lines.push(`last verify: ${formatVerifyLine(d.lastVerify)}`);
  } else {
    lines.push("last verify: (none)");
  }
  lines.push(`Nudge: ${statusNudge(d)}`);
  return lines.join("\n");
}

function statusNudge(d: StatusData): string {
  if (d.loops.length > 0) {
    return `change strategy — '${truncLine(d.loops[0]?.cmd ?? "", CMD_DISPLAY_MAX)}' failed ${d.loops[0]?.failures}x; do not re-run unchanged.`;
  }
  if (d.diffLines >= d.diffHardLines) {
    return `diff hit the hard limit (≥ ${d.diffHardLines} lines) — stop and split before continuing.`;
  }
  if (d.diffLines >= d.diffWarnLines) {
    return `diff is large (≥ ${d.diffWarnLines} lines) — split work before continuing.`;
  }
  if (d.lastVerify === null) {
    return "run /guard-verify <cmd> to create evidence before claiming success.";
  }
  return "verify before success claims; keep tool outputs bounded.";
}
