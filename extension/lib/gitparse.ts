/**
 * git numstat / shortstat parsing and diff verdicts (SPEC §5, §1 #8).
 * Pure logic — no pi imports.
 */

export interface NumstatRow {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

export interface Numstat {
  files: NumstatRow[];
  fileCount: number;
  lines: number;
}

/** Parse `git diff --numstat HEAD` output. Binary rows report "-\t-". */
export function parseNumstat(out: string): Numstat {
  const files: NumstatRow[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;
    const path = parts.slice(2).join("\t");
    const additions = parts[0] === "-" ? 0 : Number(parts[0]);
    const deletions = parts[1] === "-" ? 0 : Number(parts[1]);
    files.push({
      path,
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
      binary: parts[0] === "-" || parts[1] === "-",
    });
  }
  return {
    files,
    fileCount: files.length,
    lines: files.reduce((sum, f) => sum + f.additions + f.deletions, 0),
  };
}

export interface Shortstat {
  files: number;
  lines: number;
}

/** Parse `git diff --shortstat HEAD` output, e.g.
 *  " 3 files changed, 120 insertions(+), 4 deletions(-)". */
export function parseShortstat(out: string): Shortstat {
  const filesM = out.match(/(\d+)\s+files? changed/);
  const insM = out.match(/(\d+)\s+insertions?\(\+\)/);
  const delM = out.match(/(\d+)\s+deletions?\(-\)/);
  const files = filesM ? Number(filesM[1]) : 0;
  const lines = (insM ? Number(insM[1]) : 0) + (delM ? Number(delM[1]) : 0);
  return { files, lines };
}

export type DiffLevel = "ok" | "warn" | "hard";

export interface DiffVerdict {
  level: DiffLevel;
  lines: number;
  files: number;
}

export interface DiffThresholds {
  diff_warn_lines: number;
  diff_hard_lines: number;
  diff_warn_files: number;
}

/** Verdict of a diff against configured thresholds (SPEC §1 #8). */
export function diffVerdict(lines: number, files: number, t: DiffThresholds): DiffVerdict {
  if (lines >= t.diff_hard_lines) return { level: "hard", lines, files };
  if (lines >= t.diff_warn_lines || files >= t.diff_warn_files) return { level: "warn", lines, files };
  return { level: "ok", lines, files };
}
