import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
