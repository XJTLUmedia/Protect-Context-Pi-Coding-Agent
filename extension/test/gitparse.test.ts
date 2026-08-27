import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNumstat, parseShortstat, diffVerdict } from "../lib/gitparse.ts";

const NUMSTAT_FIXTURE = [
  "12\t3\tsrc/a.py",
  "0\t5\tlib/b.ts",
  "-\t-\tlogo.png",
  "1\t0\tdir with space/c d.md",
  "",
].join("\n");

test("numstat: parses additions/deletions/paths incl. binary rows", () => {
  const parsed = parseNumstat(NUMSTAT_FIXTURE);
  assert.equal(parsed.fileCount, 4);
  assert.equal(parsed.lines, 21);
  assert.equal(parsed.files[0]?.path, "src/a.py");
  assert.equal(parsed.files[0]?.additions, 12);
  assert.equal(parsed.files[0]?.deletions, 3);
  assert.equal(parsed.files[2]?.binary, true);
  assert.equal(parsed.files[2]?.additions, 0);
  assert.equal(parsed.files[3]?.path, "dir with space/c d.md");
});

test("numstat: empty output", () => {
  const parsed = parseNumstat("");
  assert.equal(parsed.fileCount, 0);
  assert.equal(parsed.lines, 0);
});

const SHORTSTAT_FIXTURE = " 3 files changed, 120 insertions(+), 4 deletions(-)";

test("shortstat: parses files and summed lines", () => {
  assert.deepEqual(parseShortstat(SHORTSTAT_FIXTURE), { files: 3, lines: 124 });
});

test("shortstat: partial fixtures default missing parts to 0", () => {
  assert.deepEqual(parseShortstat(" 2 files changed, 7 insertions(+)"), { files: 2, lines: 7 });
  assert.deepEqual(parseShortstat(" 1 file changed, 2 deletions(-)"), { files: 1, lines: 2 });
  assert.deepEqual(parseShortstat(""), { files: 0, lines: 0 });
});

test("verdict: ok / warn / hard levels against thresholds", () => {
  const t = { diff_warn_lines: 400, diff_hard_lines: 800, diff_warn_files: 10 };
  assert.equal(diffVerdict(10, 2, t).level, "ok");
  assert.equal(diffVerdict(400, 2, t).level, "warn");
  assert.equal(diffVerdict(401, 2, t).level, "warn");
  assert.equal(diffVerdict(100, 10, t).level, "warn", "file-count warn");
  assert.equal(diffVerdict(800, 2, t).level, "hard");
  assert.equal(diffVerdict(900, 2, t).level, "hard");
});
