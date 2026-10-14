/**
 * Journal (.agent-guard/journal.jsonl) — decisions/corrections/risks/notes
 * (SPEC §1 #6 #7, §2). No pi imports.
 */

import { appendJsonl, journalPath, readJsonl } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

export type JournalType = "decision" | "correction" | "risk" | "note";

export interface JournalEntry {
  ts: string;
  type: JournalType;
  text: string;
  tags: string[];
}

export function isJournalType(v: unknown): v is JournalType {
  return v === "decision" || v === "correction" || v === "risk" || v === "note";
}

/** Free-text cap (chars): journal text is re-injected into briefs (goal #12). */
export const TEXT_CAP = 500;
export const TAG_COUNT_CAP = 8;
export const TAG_TEXT_CAP = 40;

/** Replace terminal/control formatting, collapse whitespace and bound output. */
export function sanitizeJournalText(value: unknown, cap = TEXT_CAP): string {
  return normalizeOneLine(value, cap);
}

/** Clean, deduplicate and bound tags before they reach storage or a brief. */
export function sanitizeTags(tags: unknown): string[] {
  const clean: string[] = [];
  const seen = new Set<string>();
  const candidates = Array.isArray(tags) ? tags : typeof tags === "string" ? [tags] : [];
  for (const tag of candidates) {
    const value = sanitizeJournalText(tag, TAG_TEXT_CAP);
    if (value !== "" && !seen.has(value)) {
      clean.push(value);
      seen.add(value);
    }
    if (clean.length >= TAG_COUNT_CAP) break;
  }
  return clean;
}

/** Preserve a required provenance tag even when caller tags fill the cap. */
export function tagsWithRequired(
  tags: unknown,
  required: string,
): string[] {
  const requiredClean = sanitizeJournalText(required, TAG_TEXT_CAP);
  if (requiredClean === "") throw new Error("required journal tag must not be blank");
  const clean = sanitizeTags(tags).filter((tag) => tag !== requiredClean);
  return [...clean.slice(0, TAG_COUNT_CAP - 1), requiredClean];
}

export function appendJournal(
  cwd: string,
  entry: { type: JournalType; text: string; tags?: string[] },
): JournalEntry {
  const cleanText = sanitizeJournalText(entry.text);
  if (cleanText === "") throw new Error("journal text must not be blank");
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    type: entry.type,
    text: cleanText,
    tags: sanitizeTags(entry.tags),
  };
  appendJsonl(journalPath(cwd), full);
  return full;
}

export function readJournal(cwd: string): JournalEntry[] {
  return readJsonl<JournalEntry>(journalPath(cwd));
}

/** Most recent trusted entries of one type, newest first. Model-authored
 * entries carry the reserved `agent` provenance tag and are never re-injected. */
export function recentTrustedEntries(
  journal: JournalEntry[],
  type: "decision" | "correction",
  n: number,
): JournalEntry[] {
  return journal
    .filter((e) => e.type === type && !sanitizeTags(e.tags).includes("agent"))
    .slice(-n)
    .reverse();
}

/** Most recent trusted corrections, newest first. */
export function recentCorrections(journal: JournalEntry[], n: number): JournalEntry[] {
  return recentTrustedEntries(journal, "correction", n);
}

/** Most recent trusted decisions, newest first. */
export function recentDecisions(journal: JournalEntry[], n: number): JournalEntry[] {
  return recentTrustedEntries(journal, "decision", n);
}
