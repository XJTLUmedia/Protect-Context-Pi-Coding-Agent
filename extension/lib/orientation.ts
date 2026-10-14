/**
 * Orientation digest (SPEC §1 #4): repo tree ≤2 levels, language counts by
 * file extension, conventions-file detection (CLAUDE.md/AGENTS.md/README...).
 * Pure local filesystem scanning — no network, no LLM, no pi imports.
 *
 * Mirrors src/protect_context/orientation.py: the session-start surface
 * injects this digest (digest-gated like the brief) so goal #4 ("misread the
 * repo before acting") has a reachable delivery path in the extension.
 */

import { lstatSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { normalizeOneLine } from "./text.ts";

const SKIP_DIRS = new Set([
  "venv",
  "env",
  "node_modules",
  "__pycache__",
  "dist",
  "build",
  "coverage",
]);

export const CONVENTIONS_FILES = ["CLAUDE.md", "AGENTS.md", "CONVENTIONS.md", "README.md", "README"] as const;

const EXT_LANG: Record<string, string> = {
  ".py": "Python",
  ".pyw": "Python",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".js": "JavaScript",
  ".jsx": "JavaScript",
  ".mjs": "JavaScript",
  ".cjs": "JavaScript",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".c": "C",
  ".h": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".sh": "Shell",
  ".bash": "Shell",
  ".zsh": "Shell",
};

export const MAX_TREE_ENTRIES = 12;
export const MAX_CHILDREN = 8;
const MAX_WALK_DEPTH = 3;
const MAX_FILES_SCANNED = 4000;

function isSkippedDir(name: string): boolean {
  return name.startsWith(".") || SKIP_DIRS.has(name) || name.endsWith(".egg-info");
}

function displayName(name: string): string {
  return normalizeOneLine(name, 120) || "(control-only name)";
}

export interface OrientationScan {
  root: string;
  /** Top-level dirs (with a child sample) then top-level files. */
  tree: string[];
  languages: Array<{ lang: string; count: number }>;
  conventions: string[];
}

/** Resolve nested launch directories to their containing worktree root.
 * Failures are intentionally quiet: outside Git (or without Git installed),
 * orientation remains a bounded scan of the caller-supplied directory. */
export function orientationRoot(start: string): string {
  try {
    const value = execFileSync("git", ["-C", start, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
      maxBuffer: 64 * 1024,
    }).trim();
    return value || start;
  } catch {
    return start;
  }
}

function childrenSample(dir: string): string {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return "";
  }
  const names: string[] = [];
  const visible = entries.filter((e) => !isSkippedDir(e)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const name of visible) {
    let isDir = false;
    try {
      // lstat prevents a repository symlink from turning this bounded local
      // orientation scan into a traversal of an arbitrary external tree.
      isDir = lstatSync(join(dir, name)).isDirectory();
    } catch {
      // unreadable entry: still list it
    }
    const shown = displayName(name);
    names.push(isDir ? `${shown}/` : shown);
    if (names.length >= MAX_CHILDREN) break;
  }
  const remaining = visible.length - names.length;
  let s = names.join(", ");
  if (remaining > 0) s += `, +${remaining} more`;
  return s;
}

function languageCounts(root: string): Array<{ lang: string; count: number }> {
  const counts = new Map<string, number>();
  let seen = 0;

  const walk = (dir: string, depth: number): void => {
    if (seen >= MAX_FILES_SCANNED || depth > MAX_WALK_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
      if (seen >= MAX_FILES_SCANNED) return;
      const full = join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!isSkippedDir(name)) walk(full, depth + 1);
        continue;
      }
      seen += 1;
      const dot = name.lastIndexOf(".");
      if (dot <= 0) continue; // no extension / dotfiles
      const lang = EXT_LANG[name.slice(dot).toLowerCase()];
      if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
    }
  };

  walk(root, 0);
  return [...counts.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count || a.lang.localeCompare(b.lang));
}

export function scanOrientation(start: string): OrientationScan {
  const root = orientationRoot(start);
  const dirs: string[] = [];
  const files: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    entries = [];
  }
  for (const name of entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    if (isSkippedDir(name)) continue;
    let isDir = false;
    try {
      isDir = lstatSync(join(root, name)).isDirectory();
    } catch {
      // unreadable entry: list as file
    }
    if (isDir) {
      const kids = childrenSample(join(root, name));
      dirs.push(`${displayName(name)}/` + (kids ? ` (${kids})` : ""));
    } else {
      files.push(displayName(name));
    }
  }
  const conventions = CONVENTIONS_FILES.filter((c) => {
    try {
      return lstatSync(join(root, c)).isFile();
    } catch {
      return false;
    }
  });
  return { root, tree: dirs.concat(files).slice(0, MAX_TREE_ENTRIES), languages: languageCounts(root), conventions };
}

/** Compact orientation digest (ends with Nudge) — mirrors orientation.digest(). */
export function renderOrientation(scan: OrientationScan): string {
  const name = displayName(scan.root.split(/[\\/]/).filter(Boolean).pop() || scan.root);
  const lines = [`PC orientation · ${name}`];
  lines.push(...scan.tree);
  const langs =
    scan.languages
      .slice(0, 6)
      .map((l) => `${l.lang}=${l.count}`)
      .join(", ") || "none detected";
  lines.push(`languages: ${langs}`);
  lines.push("conventions: " + (scan.conventions.join(", ") || "none found"));
  lines.push("Nudge: read the conventions files and relevant code before the first edit — never code from guesses.");
  return lines.join("\n");
}
