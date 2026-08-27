import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContract, addConstraint, removeConstraint, contractLines, nextConstraintId } from "../lib/contract.ts";
import { checkContractSummary, renderChecklist } from "../lib/contract_check.ts";
import { DEFAULT_CONTRACT } from "../lib/defaults.ts";

function tmpStore(): string {
  return mkdtempSync(join(tmpdir(), "pc-contract-"));
}

test("contract: load seeds contract.json with the 12 frozen constraints", () => {
  const dir = tmpStore();
  try {
    const contract = loadContract(dir);
    assert.equal(contract.constraints.length, 12);
    assert.equal(contract.constraints[0]?.id, "01-obey-instructions");
    assert.equal(
      contract.constraints[1]?.text,
      "Never claim success without citing a fresh verification run (evidence id or pasted output) for the exact claim.",
    );
    assert.ok(existsSync(join(dir, ".agent-guard", "contract.json")));
    // Second load reads the same file (idempotent seed).
    assert.deepEqual(loadContract(dir), contract);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: add/remove CRUD roundtrip", () => {
  const dir = tmpStore();
  try {
    const added = addConstraint(dir, "Never deploy on Fridays");
    assert.equal(added.id, "13");
    assert.equal(added.source, "agent");
    const raw = JSON.parse(readFileSync(join(dir, ".agent-guard", "contract.json"), "utf8"));
    assert.equal(raw.constraints.length, 13);
    assert.equal(nextConstraintId(raw.constraints), "14");
    assert.ok(removeConstraint(dir, "13"));
    assert.equal(removeConstraint(dir, "13"), false, "removing twice fails cleanly");
    assert.equal(loadContract(dir).constraints.length, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: corrupt file falls back to defaults WITHOUT overwriting", () => {
  const dir = tmpStore();
  try {
    const file = join(dir, ".agent-guard", "contract.json");
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    const corrupt = '{"version":1,"constraints":[{"id":"13-my-rule","tex'; // truncated JSON
    writeFileSync(file, corrupt, "utf8");
    const contract = loadContract(dir);
    assert.equal(contract.constraints.length, 12, "in-memory defaults served");
    assert.equal(readFileSync(file, "utf8"), corrupt, "user file must not be clobbered");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: add caps free-text at 500 chars (brief re-injection budget)", () => {
  const dir = tmpStore();
  try {
    const added = addConstraint(dir, "x".repeat(900));
    assert.equal(added.text.length, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract: one compact line per constraint", () => {
  const lines = contractLines(DEFAULT_CONTRACT);
  assert.equal(lines.length, 12);
  assert.ok(lines[0]?.startsWith("01-obey-instructions: Obey the owner's"));
});

test("contract_check: heuristic marks addressed vs unclear", () => {
  const summary =
    "Added a test for the new behavior; kept the diff small and split commits; " +
    "ran the verification run for evidence; recorded the decision in the journal.";
  const items = checkContractSummary(summary, DEFAULT_CONTRACT);
  const addressed = items.filter((i) => i.addressed).map((i) => i.id.slice(0, 2));
  const unclear = items.filter((i) => !i.addressed).map((i) => i.id.slice(0, 2));
  assert.ok(addressed.includes("02"), "evidence keyword hit");
  assert.ok(addressed.includes("05"), "test keyword hit");
  assert.ok(addressed.includes("06"), "journal keyword hit");
  assert.ok(!addressed.includes("01"), "no instruction keywords");
  assert.ok(unclear.includes("01"));
  const rendered = renderChecklist(items);
  assert.ok(rendered.startsWith("addressed:"));
  assert.ok(rendered.includes("unclear: 01"));
  assert.ok(rendered.trimEnd().split("\n").pop()?.startsWith("Nudge:"));
});

test("contract_check: empty summary marks everything unclear with a Nudge", () => {
  const rendered = renderChecklist(checkContractSummary("", DEFAULT_CONTRACT));
  assert.ok(rendered.includes("addressed: (none)"));
  assert.ok(rendered.includes("unclear: 01 02 03 04 05 06 07 08 09 10 11 12"));
  assert.ok(rendered.includes("Nudge:"));
});
