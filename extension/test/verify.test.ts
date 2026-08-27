import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampTimeoutS,
  digestOf,
  formatVerifyLine,
  nextEvidenceId,
  TIMEOUT_DEFAULT_S,
  TIMEOUT_MAX_S,
  TIMEOUT_MIN_S,
  type VerifyRun,
} from "../lib/verify.ts";

test("verify: timeout clamped to a sane range (mirrors Python _clamp_timeout)", () => {
  assert.equal(clampTimeoutS(10 ** 9), TIMEOUT_MAX_S);
  assert.equal(clampTimeoutS(0), TIMEOUT_MIN_S);
  assert.equal(clampTimeoutS(-5), TIMEOUT_MIN_S);
  assert.equal(clampTimeoutS(180), 180);
  assert.equal(clampTimeoutS(undefined), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(null), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(Number.NaN), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(Number.POSITIVE_INFINITY), TIMEOUT_DEFAULT_S);
  assert.equal(clampTimeoutS(45.9), 45); // truncated to whole seconds
});

test("verify: digest keeps the LAST 2000 chars of stdout+stderr", () => {
  assert.equal(digestOf("abc", "def"), "abcdef");
  const long = "x".repeat(2500);
  assert.equal(digestOf(long, "").length, 2000);
  const combined = "a".repeat(10) + long;
  assert.equal(digestOf("", combined), combined.slice(-2000));
});

test("verify: next evidence id allocates the sequential ev-NNNN", () => {
  const run = (id: string): VerifyRun => ({
    id,
    ts: "t",
    session: "s",
    cmd: "c",
    exit: 0,
    ok: true,
    digest: "",
    ms: 1,
  });
  assert.equal(nextEvidenceId([]), "ev-0001");
  assert.equal(nextEvidenceId([run("ev-0001"), run("ev-0002")]), "ev-0003");
  assert.equal(nextEvidenceId([run("ev-0041")]), "ev-0042");
  // malformed ids are ignored, not crashing the allocation
  assert.equal(nextEvidenceId([run("junk"), run("ev-0007")]), "ev-0008");
});

test("verify: long commands are truncated in compact lines", () => {
  const line = formatVerifyLine({
    id: "ev-0009", ts: "", session: "", cmd: "z".repeat(300), exit: 1, ok: false, digest: "", ms: 5,
  });
  assert.ok(!line.includes("z".repeat(300)), "unbounded cmd leaked into evidence line");
  assert.ok(line.includes("…"), "truncation marker present");
});
