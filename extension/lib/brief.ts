/**
 * Compact pre-agent brief (SPEC §5 before_agent_start) and digest helper.
 * Pure logic — no pi imports.
 */

import { createHash } from "node:crypto";
import type { Constraint } from "./defaults.ts";
import type { LoopInfo } from "./loops.ts";
import { trunc } from "./text.ts";

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

export interface BriefInput {
  contract: Constraint[];
  /** Most recent corrections, newest first (already sliced). */
  corrections: Array<{ type: string; text: string; tags: string[] }>;
  loops: LoopInfo[];
  lastEvidence: { id: string; exit: number; cmd: string; ms: number | null } | null;
}

export const BRIEF_MAX_CONTRACT_LINES = 12;
export const BRIEF_MAX_CORRECTIONS = 3;
export const BRIEF_MAX_LOOPS = 2;
/** Command display cap (chars) — matches Python's cmd[:60] discipline. */
export const CMD_DISPLAY_MAX = 60;

/** One-line cap for brief snippets: collapse whitespace, then truncate with an
 *  ellipsis. Model-supplied text must never bloat the re-injected brief (goal #12). */
export function truncLine(s: string, max = 200): string {
  return trunc(s.replace(/\s+/g, " ").trim(), max);
}

/** Build the compact brief: contract (≤12 lines), ≤3 corrections, ≤2 loops, last evidence. */
export function buildBrief(input: BriefInput): string {
  const lines: string[] = [];

  const contractLines = input.contract.slice(0, BRIEF_MAX_CONTRACT_LINES);
  if (contractLines.length > 0) {
    lines.push("contract:");
    for (const c of contractLines) {
      // Provenance: seed constraints are the frozen defaults; anything else is
      // tagged with its source so agent-written constraints are visible as such.
      const src = c.source && c.source !== "seed" ? ` [${c.source}]` : "";
      lines.push(`${c.id}${src}: ${truncLine(c.text)}`);
    }
    const hidden = input.contract.length - contractLines.length;
    if (hidden > 0) {
      // Never silently drop owner-added constraints: announce the overflow so
      // the model knows constraints exist beyond the injected 12 (goal #1).
      lines.push(`+${hidden} more constraints hidden — run /guard-contract list`);
    }
  }

  if (input.corrections.length > 0) {
    lines.push("corrections:");
    for (const corr of input.corrections.slice(0, BRIEF_MAX_CORRECTIONS)) {
      const tags = corr.tags.length > 0 ? ` [${corr.tags.join(",")}]` : "";
      lines.push(`- ${truncLine(corr.text)}${tags}`);
    }
  }

  if (input.loops.length > 0) {
    lines.push("loops:");
    for (const l of input.loops.slice(0, BRIEF_MAX_LOOPS)) {
      lines.push(`- '${truncLine(l.cmd, CMD_DISPLAY_MAX)}' failed ${l.failures}x`);
    }
  }

  if (input.lastEvidence) {
    const ms = input.lastEvidence.ms === null ? "" : ` ${(input.lastEvidence.ms / 1000).toFixed(1)}s`;
    lines.push(
      `last verify: ${input.lastEvidence.id} exit=${input.lastEvidence.exit} '${truncLine(input.lastEvidence.cmd, CMD_DISPLAY_MAX)}'${ms}`,
    );
  }

  return lines.join("\n");
}
