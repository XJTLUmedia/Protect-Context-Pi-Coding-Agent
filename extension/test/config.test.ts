import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeConfig, loadConfig } from "../lib/config.ts";
import { DEFAULT_CONFIG } from "../lib/defaults.ts";
import { storeDir, withStoreLock } from "../lib/store.ts";

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

test("config: numeric fields require finite integers", () => {
  const merged = mergeConfig({
    loop_block_after: 1.5,
    diff_warn_lines: Number.NaN,
    diff_hard_lines: Number.POSITIVE_INFINITY,
    diff_warn_files: 2.5,
    ctx_warn_pct: 70.5,
  });
  assert.equal(merged.loop_block_after, DEFAULT_CONFIG.loop_block_after);
  assert.equal(merged.diff_warn_lines, DEFAULT_CONFIG.diff_warn_lines);
  assert.equal(merged.diff_hard_lines, DEFAULT_CONFIG.diff_hard_lines);
  assert.equal(merged.diff_warn_files, DEFAULT_CONFIG.diff_warn_files);
  assert.equal(merged.ctx_warn_pct, DEFAULT_CONFIG.ctx_warn_pct);
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

test("config: extension startup can seed config.json without overwriting existing config", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-config-"));
  try {
    const seeded = loadConfig(dir, true);
    const file = join(dir, ".agent-guard", "config.json");
    assert.equal(seeded.existed, false);
    assert.ok(existsSync(file));
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), DEFAULT_CONFIG);

    writeFileSync(file, JSON.stringify({ loop_block_after: 9 }), "utf8");
    const existing = loadConfig(dir, true);
    assert.equal(existing.existed, true);
    assert.equal(existing.config.loop_block_after, 9);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: race-safe seeding remains reentrant under the shared lease", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-config-"));
  try {
    const loaded = withStoreLock(storeDir(dir), () => loadConfig(dir, true));
    assert.equal(loaded.existed, false);
    assert.deepEqual(JSON.parse(readFileSync(loaded.path, "utf8")), DEFAULT_CONFIG);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
