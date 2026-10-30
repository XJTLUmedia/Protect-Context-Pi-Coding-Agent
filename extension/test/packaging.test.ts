import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function pretestScript(): string {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const script = pkg.scripts?.pretest;
  if (!script) assert.fail("package.json declares a pretest guard for the test script");
  return script;
}

function runPretest(cwd: string) {
  return spawnSync("sh", ["-c", pretestScript()], { cwd, encoding: "utf8" });
}

test("packaging: pretest passes in a checkout", () => {
  const res = runPretest(repoRoot);
  assert.equal(res.status, 0, res.stderr);
});

test("packaging: pretest fails loudly where the tests were not published", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-pkg-"));
  try {
    const res = runPretest(dir);
    assert.notEqual(res.status, 0, "an installed package must not report a green run with zero tests");
    assert.match(res.stderr, /repository checkout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
