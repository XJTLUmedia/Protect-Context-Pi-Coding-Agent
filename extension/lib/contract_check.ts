/**
 * guard_contract_check — deterministic checklist over a change summary
 * (SPEC §5). Heuristic keyword coverage per constraint; no LLM. No pi imports.
 */

import type { Contract } from "./defaults.ts";

/**
 * Keyword coverage per constraint id (lowercased substring matching against
 * the supplied summary).
 */
export const CONSTRAINT_KEYWORDS: Record<string, string[]> = {
  "01-obey-instructions": ["instruct", "constraint", "owner", "ask instead", "conflict"],
  "02-evidence-before-success": ["evidence", "verif", "ev-", "proof", "test run"],
  "03-stay-in-scope": ["scope", "unrelated", "refactor", "only file", "in scope"],
  "04-orient-first": ["read", "orient", "convention", "familiar", "reviewed"],
  "05-simplest-correct": ["simple", "test", "behavior", "minimal"],
  "06-journal-decisions": ["journal", "decision", "noted", "recorded"],
  "07-log-corrections": ["correction", "tag", "corrected", "feedback"],
  "08-keep-diffs-reviewable": ["diff", "lines", "split", "small", "reviewable"],
  "09-no-identical-retries": ["retry", "failing", "approach", "loop", "changed strategy"],
  "10-preflight-env": ["preflight", "tool", "version", "env", "sandbox"],
  "11-batch-operations": ["batch", "permission", "prompt", "grouped"],
  "12-budget-context": ["budget", "context", "digest", "head", "tail", "targeted"],
};

export interface ChecklistItem {
  id: string;
  addressed: boolean;
}

const CHECKLIST_IDS_MAX = 24;

function compactIds(items: ChecklistItem[]): string {
  const ids = items.slice(0, CHECKLIST_IDS_MAX).map((item) => String(item.id).slice(0, 2));
  const omitted = items.length - ids.length;
  return `${ids.length > 0 ? ids.join(" ") : "(none)"}${omitted > 0 ? ` +${omitted} more` : ""}`;
}

/** Mark each constraint addressed/unclear from the summary text. */
export function checkContractSummary(summary: string, contract: Contract): ChecklistItem[] {
  const hay = summary.toLowerCase();
  return contract.constraints.map((c) => {
    const keywords = CONSTRAINT_KEYWORDS[c.id] ?? [];
    return { id: c.id, addressed: keywords.some((k) => hay.includes(k)) };
  });
}

/** Compact rendering: addressed ids grouped, unclear ids grouped, then a Nudge. */
export function renderChecklist(items: ChecklistItem[]): string {
  const addressed = items.filter((i) => i.addressed);
  const unclear = items.filter((i) => !i.addressed);
  const lines: string[] = [];
  lines.push(`addressed: ${compactIds(addressed)}`);
  lines.push(`unclear: ${compactIds(unclear)}`);
  lines.push(
    unclear.length > 0
      ? `Nudge: resolve unclear constraints (guard_contract list) or state why they don't apply.`
      : `Nudge: all constraints addressed — verify before claiming success.`,
  );
  return lines.join("\n");
}
