/**
 * Compact pre-agent brief (SPEC §5 before_agent_start) and digest helper.
 * Pure logic — no pi imports.
 */

import { createHash } from "node:crypto";
import type { Constraint } from "./defaults.ts";
import type { LoopInfo } from "./loops.ts";
import { normalizeOneLine, trunc } from "./text.ts";

export function sha1Hex(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex");
}

export interface BriefInput {
  contract: Constraint[];
  /** Most recent trusted decisions, newest first (already sliced). */
  decisions?: Array<{ type: string; text: string; tags: string[] }>;
  /** Most recent corrections, newest first (already sliced). */
  corrections: Array<{ type: string; text: string; tags: string[] }>;
  loops: LoopInfo[];
  lastEvidence: { id: string; exit: number; cmd: string; ms: number | null } | null;
}

export const BRIEF_MAX_CONTRACT_LINES = 12;
export const BRIEF_MAX_DECISIONS = 3;
export const BRIEF_MAX_CORRECTIONS = 3;
export const BRIEF_MAX_LOOPS = 2;
/** Command display cap (chars) — matches Python's cmd[:60] discipline. */
export const CMD_DISPLAY_MAX = 60;

/** One-line cap for brief snippets: collapse whitespace, then truncate with an
 *  ellipsis. Model-supplied text must never bloat the re-injected brief (goal #12). */
export function truncLine(s: unknown, max = 200): string {
  // Normalize before applying the display ellipsis. The normalizer gets a
  // generous pre-cap so trunc(), rather than an invisible hard slice, marks
  // ordinary overlong text.
  return trunc(normalizeOneLine(s, Math.max(max + 1, 10_000)), max);
}

function isTrustedOwnerConstraint(c: Constraint): boolean {
  return c.source === "owner" || c.source === "user";
}

/**
 * Select the constraints that can enter the frozen 12-line brief cap.
 *
 * Authority is more important than append order: newest explicit owner/user
 * constraints come first, then the frozen seed contract, and only then other
 * (including agent-authored) entries. Consequently an agent entry can never
 * crowd a seed constraint out of the brief. Stable source indexes break ties
 * when the day-only `added` field is identical.
 */
export function selectBriefConstraints(contract: Constraint[]): Constraint[] {
  const indexed = contract.map((constraint, index) => ({ constraint, index }));
  const owners = indexed
    .filter(({ constraint }) => isTrustedOwnerConstraint(constraint))
    .sort(
      (a, b) =>
        String(b.constraint.added ?? "").localeCompare(String(a.constraint.added ?? "")) || b.index - a.index,
    );
  const seeds = indexed.filter(({ constraint }) => constraint.source === "seed");
  const others = indexed.filter(
    ({ constraint }) => constraint.source !== "seed" && !isTrustedOwnerConstraint(constraint),
  );
  return [...owners, ...seeds, ...others]
    .slice(0, BRIEF_MAX_CONTRACT_LINES)
    .map(({ constraint }) => constraint);
}

function appendJournalSection(
  lines: string[],
  heading: "decisions:" | "corrections:",
  entries: Array<{ text: string; tags: string[] }>,
  cap: number,
): void {
  if (entries.length === 0) return;
  lines.push(heading);
  for (const entry of entries.slice(0, cap)) {
    const safeTags = [...new Set((Array.isArray(entry.tags) ? entry.tags : []).map((tag) => truncLine(tag, 40)).filter(Boolean))]
      .slice(0, 8);
    const tags = safeTags.length > 0 ? ` [${safeTags.join(",")}]` : "";
    lines.push(`- ${truncLine(entry.text)}${tags}`);
  }
}

/** Build the compact brief: contract (≤12 lines), ≤3 trusted decisions,
 *  ≤3 trusted corrections, ≤2 loops, and last evidence. */
export function buildBrief(input: BriefInput): string {
  const lines: string[] = [];

  const contractLines = selectBriefConstraints(input.contract);
  if (contractLines.length > 0) {
    lines.push("contract:");
    for (const c of contractLines) {
      // Provenance: seed constraints are the frozen defaults; anything else is
      // tagged with its source so agent-written constraints are visible as such.
      const source = truncLine(c.source, 40);
      const src = source && source !== "seed" ? ` [${source}]` : "";
      lines.push(`${truncLine(c.id, 80) || "(missing-id)"}${src}: ${truncLine(c.text)}`);
    }
    const hidden = input.contract.length - contractLines.length;
    if (hidden > 0) {
      // Never silently drop owner-added constraints: announce the overflow so
      // the model knows constraints exist beyond the injected 12 (goal #1).
      lines.push(`+${hidden} more constraints hidden — run /guard-contract list`);
    }
  }

  appendJournalSection(lines, "decisions:", input.decisions ?? [], BRIEF_MAX_DECISIONS);
  appendJournalSection(lines, "corrections:", input.corrections, BRIEF_MAX_CORRECTIONS);

  if (input.loops.length > 0) {
    lines.push("loops:");
    for (const l of input.loops.slice(0, BRIEF_MAX_LOOPS)) {
      lines.push(`- '${truncLine(l.cmd, CMD_DISPLAY_MAX)}' failed ${l.failures}x`);
    }
  }

  if (input.lastEvidence) {
    const ms = input.lastEvidence.ms === null ? "" : ` ${(input.lastEvidence.ms / 1000).toFixed(1)}s`;
    lines.push(
      `last verify: ${truncLine(input.lastEvidence.id, 40)} exit=${input.lastEvidence.exit} '${truncLine(input.lastEvidence.cmd, CMD_DISPLAY_MAX)}'${ms}`,
    );
  }

  return lines.join("\n");
}
