import { test } from "node:test";
import assert from "node:assert/strict";
import { renderWidget } from "../lib/widget.ts";

test("widget: matches the frozen single-line format", () => {
  assert.equal(
    renderWidget({ diffLines: 123, diffFiles: 4, loops: 1, evidence: 2, ctxPct: 41.4 }),
    "PC Δ+123L/4f 1loop ev2 ctx41%",
  );
});

test("widget: zero state and unknown context pct", () => {
  assert.equal(
    renderWidget({ diffLines: 0, diffFiles: 0, loops: 0, evidence: 0, ctxPct: null }),
    "PC Δ+0L/0f 0loop ev0 ctx0%",
  );
});

test("widget: rounds context percent", () => {
  const w = renderWidget({ diffLines: 5, diffFiles: 1, loops: 0, evidence: 3, ctxPct: 66.6 });
  assert.equal(w, "PC Δ+5L/1f 0loop ev3 ctx67%");
});

test("widget: unavailable and lower-bound diff states are explicit", () => {
  assert.equal(
    renderWidget({ diffLines: 0, diffFiles: 0, diffAvailable: false, loops: 0, evidence: 0, ctxPct: null }),
    "PC Δ? 0loop ev0 ctx0%",
  );
  assert.equal(
    renderWidget({ diffLines: 800, diffFiles: 3, diffLowerBound: true, loops: 0, evidence: 0, ctxPct: 10 }),
    "PC Δ≥800L/3f 0loop ev0 ctx10%",
  );
});
