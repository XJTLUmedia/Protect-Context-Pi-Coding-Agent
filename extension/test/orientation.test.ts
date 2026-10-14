import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOrientation, renderOrientation } from "../lib/orientation.ts";

test("orientation: tree, language counts and conventions detection", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-orient-"));
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "src", "a.py"), "x = 1\n");
    writeFileSync(join(dir, "src", "b.py"), "y = 2\n");
    writeFileSync(join(dir, "main.py"), "print(1)\n");
    writeFileSync(join(dir, "lib.ts"), "export {}\n");
    writeFileSync(join(dir, "docs", "guide.md"), "# guide\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# conventions\n");
    writeFileSync(join(dir, "README.md"), "# readme\n");
    writeFileSync(join(dir, "data.bin"), "raw");

    const scan = scanOrientation(dir);
    assert.ok(scan.tree.some((t) => t.startsWith("src/")), "dirs listed with trailing slash");
    assert.ok(scan.tree.includes("data.bin"), "top-level files listed");
    assert.ok(!scan.tree.some((t) => t.startsWith("node_modules")), "node_modules skipped");
    const langs = new Map(scan.languages.map((l) => [l.lang, l.count]));
    assert.equal(langs.get("Python"), 3);
    assert.equal(langs.get("TypeScript"), 1);
    assert.ok(!langs.has("Markdown"), "unmapped extensions ignored");
    assert.deepEqual(scan.conventions, ["CLAUDE.md", "README.md"]);

    const text = renderOrientation(scan);
    assert.ok(text.startsWith("PC orientation · "));
    assert.ok(text.includes("languages: Python=3, TypeScript=1"));
    assert.ok(text.includes("conventions: CLAUDE.md, README.md"));
    assert.ok(text.trimEnd().split("\n").pop()?.startsWith("Nudge:"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orientation: hidden/venv dirs skipped, unknown root tolerated", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-orient2-"));
  try {
    mkdirSync(join(dir, ".venv"));
    mkdirSync(join(dir, "__pycache__"));
    writeFileSync(join(dir, ".venv", "pyvenv.cfg"), "x\n");
    const scan = scanOrientation(dir);
    assert.ok(!scan.tree.some((t) => t.includes(".venv")));
    assert.ok(!scan.tree.some((t) => t.includes("__pycache__")));
    assert.equal(scan.languages.length, 0);
    assert.equal(renderOrientation(scan).includes("languages: none detected"), true);
    // missing root must not throw
    const missing = scanOrientation(join(dir, "does-not-exist"));
    assert.deepEqual(missing.tree, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orientation: sanitizes names, caps the tree, and never follows directory symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-orient-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "pc-orient-outside-"));
  try {
    writeFileSync(join(outside, "secret.py"), "x = 1\n");
    symlinkSync(outside, join(dir, "linked"), "dir");
    writeFileSync(join(dir, "bad\nname.ts"), "export {}\n");
    for (let index = 0; index < 20; index += 1) {
      writeFileSync(join(dir, `file-${String(index).padStart(2, "0")}.txt`), "x\n");
    }

    const scan = scanOrientation(dir);
    const rendered = renderOrientation(scan);

    assert.ok(scan.tree.length <= 12);
    assert.match(rendered, /bad name\.ts/);
    assert.doesNotMatch(rendered, /bad\nname\.ts/);
    assert.equal(new Map(scan.languages.map((item) => [item.lang, item.count])).has("Python"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("orientation: nested start resolves to the Git root and sees root instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-orient-nested-"));
  try {
    execFileSync("git", ["init", "-q", dir]);
    const nested = join(dir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# root instructions\n");
    writeFileSync(join(dir, "root.ts"), "export {};\n");

    const scan = scanOrientation(nested);

    assert.equal(scan.root, dir);
    assert.ok(scan.conventions.includes("AGENTS.md"));
    assert.equal(new Map(scan.languages.map((item) => [item.lang, item.count])).get("TypeScript"), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
