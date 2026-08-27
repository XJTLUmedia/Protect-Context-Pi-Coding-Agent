/**
 * Journal (.agent-guard/journal.jsonl) — decisions/corrections/risks/notes
 * (SPEC §1 #6 #7, §2). No pi imports.
 */

import { appendJsonl, journalPath, readJsonl } from "./store.ts";

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

export function appendJournal(
  cwd: string,
  entry: { type: JournalType; text: string; tags?: string[] },
): JournalEntry {
  const full: JournalEntry = {
    ts: new Date().toISOString(),
    type: entry.type,
    text: entry.text.trim().slice(0, TEXT_CAP),
    tags: entry.tags ?? [],
  };
  appendJsonl(journalPath(cwd), full);
  return full;
}

export function readJournal(cwd: string): JournalEntry[] {
  return readJsonl<JournalEntry>(journalPath(cwd));
}

/** Most recent corrections, newest first. */
export function recentCorrections(journal: JournalEntry[], n: number): JournalEntry[] {
  return journal
    .filter((e) => e.type === "correction")
    .slice(-n)
    .reverse();
}
