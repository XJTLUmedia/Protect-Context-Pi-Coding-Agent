import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendJournal,
  readJournal,
  recentCorrections,
  recentDecisions,
  sanitizeTags,
  tagsWithRequired,
  TAG_COUNT_CAP,
  TAG_TEXT_CAP,
} from "../lib/journal.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-journal-"));
}

test("journal: rejects blank/control-only text", () => {
  const dir = tmpStore();
  try {
    assert.throws(() => appendJournal(dir, { type: "note", text: " \n\t\u0000 " }), /must not be blank/);
    assert.deepEqual(readJournal(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: tags are single-line, deduplicated and bounded", () => {
  const dirty = [" alpha\n beta ", "alpha beta", "", "x".repeat(100), ...Array.from({ length: 20 }, (_, i) => `t${i}`)];
  const clean = sanitizeTags(dirty);
  assert.equal(clean.length, TAG_COUNT_CAP);
  assert.equal(clean[0], "alpha beta");
  assert.equal(clean[1]?.length, TAG_TEXT_CAP);
  assert.equal(new Set(clean).size, clean.length);
  assert.equal(clean.some((tag) => /[\n\r\t]/.test(tag)), false);
  assert.deepEqual(sanitizeTags("agent"), ["agent"], "legacy scalar tag stays one tag, not five characters");
});

test("journal: required agent provenance cannot be crowded out", () => {
  const tags = tagsWithRequired(Array.from({ length: 20 }, (_, i) => `tag-${i}`), "agent");
  assert.equal(tags.length, TAG_COUNT_CAP);
  assert.equal(tags.at(-1), "agent");
  assert.equal(tags.filter((tag) => tag === "agent").length, 1);
});

test("journal: trusted decision/correction selectors exclude agent-tagged entries", () => {
  const journal = [
    { ts: "1", type: "decision" as const, text: "owner old", tags: [] },
    { ts: "2", type: "decision" as const, text: "model decision", tags: ["agent"] },
    { ts: "3", type: "decision" as const, text: "owner new", tags: ["architecture"] },
    { ts: "4", type: "correction" as const, text: "owner correction", tags: [] },
    { ts: "5", type: "correction" as const, text: "model correction", tags: ["agent"] },
  ];
  assert.deepEqual(recentDecisions(journal, 3).map((entry) => entry.text), ["owner new", "owner old"]);
  assert.deepEqual(recentCorrections(journal, 3).map((entry) => entry.text), ["owner correction"]);
});
