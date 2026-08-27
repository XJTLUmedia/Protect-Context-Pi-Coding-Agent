import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig, loadConfig } from "../lib/config.ts";
import { DEFAULT_CONFIG } from "../lib/defaults.ts";

test("config: merge with empty partial yields frozen defaults", () => {
  assert.deepEqual(mergeConfig({}), DEFAULT_CONFIG);
  assert.deepEqual(mergeConfig(null), DEFAULT_CONFIG);
  assert.notEqual(mergeConfig({}), DEFAULT_CONFIG, "returns a copy, not the shared default");
});

test("config: overrides apply, unknown keys ignored, bad types fall back", () => {
  const merged = mergeConfig({
    loop_block_after: 5,
    brief_mode: "always",
    risk_confirm: false,
    preflight_tools: ["git"],
    bogus_key: "ignored",
    diff_warn_lines: "not-a-number",
  });
  assert.equal(merged.loop_block_after, 5);
  assert.equal(merged.brief_mode, "always");
  assert.equal(merged.risk_confirm, false);
  assert.deepEqual(merged.preflight_tools, ["git"]);
  assert.equal(merged.diff_warn_lines, DEFAULT_CONFIG.diff_warn_lines);
  assert.equal((merged as unknown as Record<string, unknown>).bogus_key, undefined);
});

test("config: loadConfig on an empty store dir returns defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-config-"));
  try {
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    const loaded = loadConfig(dir);
    assert.equal(loaded.existed, false);
    assert.deepEqual(loaded.config, DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: loadConfig reads and merges a written config.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-config-"));
  try {
    mkdirSync(join(dir, ".agent-guard"), { recursive: true });
    writeFileSync(
      join(dir, ".agent-guard", "config.json"),
      JSON.stringify({ loop_block_after: 4, ctx_warn_pct: 90 }),
      "utf8",
    );
    const loaded = loadConfig(dir);
    assert.equal(loaded.existed, true);
    assert.equal(loaded.config.loop_block_after, 4);
    assert.equal(loaded.config.ctx_warn_pct, 90);
    assert.equal(loaded.config.diff_warn_lines, DEFAULT_CONFIG.diff_warn_lines);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
