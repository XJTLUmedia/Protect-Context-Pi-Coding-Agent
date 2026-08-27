import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bashExitFromResult, toolCallEvent, toolResultEvent } from "../lib/events.ts";
import { digestOf, nextEvidenceId, formatVerifyLine, readVerifyRuns, appendVerifyRun } from "../lib/verify.ts";
import { appendJsonl, appendJsonlLocked, ensureStore, readJsonl, withStoreLock } from "../lib/store.ts";
import { DEFAULT_CONFIG, DEFAULT_CONTRACT } from "../lib/defaults.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-store-"));
}

test("events: tool_call event has null measures", () => {
  const e = toolCallEvent("s1", "bash");
  assert.equal(e.kind, "tool_call");
  assert.equal(e.ok, null);
  assert.equal(e.ms, null);
  assert.equal(e.out_chars, null);
  assert.equal(e.cmd, null);
  assert.equal(e.exit, null);
});

test("events: bash tool_result carries normalized cmd + exit", () => {
  const e = toolResultEvent("s1", "bash", { ok: false, ms: 12, outChars: 30, cmd: "npm test", exit: 1 });
  assert.equal(e.kind, "tool_result");
  assert.equal(e.ok, false);
  assert.equal(e.cmd, "npm test");
  assert.equal(e.exit, 1);
  const nonBash = toolResultEvent("s1", "read", { ok: true, ms: 1, outChars: 10 });
  assert.equal(nonBash.cmd, null);
  assert.equal(nonBash.exit, null);
});

test("events: exit code parsed from bash error text (last occurrence wins)", () => {
  assert.equal(bashExitFromResult("output...\nCommand exited with code 2"), 2);
  assert.equal(bashExitFromResult("Command exited with code 1\nlater\nCommand exited with code 127"), 127);
  assert.equal(bashExitFromResult("no exit marker here"), null);
});

test("store: best-effort .lock taken around appends and removed after", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "events.jsonl");
    appendJsonl(file, { a: 1 });
    assert.equal(existsSync(join(dir, ".agent-guard", ".lock")), false, "no lingering lock file");
    // Locked variant usable INSIDE withStoreLock (evidence-id allocation pattern)
    const inside = withStoreLock(join(dir, ".agent-guard"), () => {
      appendJsonlLocked(file, { b: 2 });
      return readJsonl(file).length;
    });
    assert.equal(inside, 2);
    assert.equal(existsSync(join(dir, ".agent-guard", ".lock")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: appendJsonl + readJsonl roundtrip with cache invalidation", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "events.jsonl");
    appendJsonl(file, toolCallEvent("s1", "bash"));
    appendJsonl(file, toolResultEvent("s1", "bash", { ok: true, ms: 5, outChars: 1, cmd: "ls", exit: 0 }));
    assert.equal(readJsonl(file).length, 2);
    appendJsonl(file, toolCallEvent("s1", "bash")); // cache must invalidate
    assert.equal(readJsonl(file).length, 3);
    assert.equal(readJsonl(join(dir, ".agent-guard", "missing.jsonl")).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("store: malformed lines are skipped, valid records survive", () => {
  const dir = tmpStore();
  try {
    ensureStore(dir);
    const file = join(dir, ".agent-guard", "journal.jsonl");
    appendFileSync(file, "{\"ts\":\"t\",\"type\":\"note\",\"text\":\"ok\",\"tags\":[]}\n", "utf8");
    appendFileSync(file, "NOT JSON AT ALL\n", "utf8");
    appendFileSync(file, "{\"ts\":\"t2\",\"type\":\"risk\",\"text\":\"ok2\",\"tags\":[]}\n", "utf8");
    assert.equal(readJsonl(file).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify: digest = last ≤2000 chars of combined stdout+stderr", () => {
  assert.equal(digestOf("abc", "def"), "abcdef");
  const big = "x".repeat(2500);
  const d = digestOf(big, "ERR");
  assert.equal(d.length, 2000);
  assert.equal(d.slice(-3), "ERR");
});

test("verify: evidence ids sequence per file", () => {
  assert.equal(nextEvidenceId([]), "ev-0001");
  const dir = tmpStore();
  try {
    ensureStore(dir);
    appendVerifyRun(dir, { id: "ev-0003", ts: "", session: "s", cmd: "x", exit: 0, ok: true, digest: "", ms: 1 });
    assert.equal(nextEvidenceId(readVerifyRuns(dir)), "ev-0004");
    assert.equal(readVerifyRuns(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verify: compact line format", () => {
  assert.equal(
    formatVerifyLine({ id: "ev-0002", ts: "", session: "", cmd: "npm test", exit: 0, ok: true, digest: "", ms: 3200 }),
    "ev-0002 exit=0 'npm test' 3.2s",
  );
});

test("defaults: frozen sizes (pinned shape shared with Python)", () => {
  assert.equal(DEFAULT_CONTRACT.constraints.length, 12);
  assert.equal(DEFAULT_CONTRACT.version, 1);
  assert.equal(Object.keys(DEFAULT_CONFIG).length, 8);
});
