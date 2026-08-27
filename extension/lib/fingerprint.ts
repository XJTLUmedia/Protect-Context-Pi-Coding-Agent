/**
 * Command fingerprinting and risk-pattern matching (SPEC §2, §5).
 * Pure logic — no pi imports, testable via `node --test --experimental-strip-types`.
 */

/**
 * Fingerprint normalization (FROZEN): trim, collapse all whitespace runs to
 * single spaces. Nothing else (case is preserved).
 */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

export interface RiskPattern {
  name: string;
  test: (cmd: string) => boolean;
}

/**
 * Deny-confirm list (SPEC §5, FROZEN names). Matching is anchored to the
 * CATASTROPHIC literal targets — over-matching benign commands (every
 * absolute-path `rm -rf`, man pages, greps) generates confirm fatigue that
 * defeats the grouped confirm's purpose (goal #11). `git push --force` must
 * not match `--force-with-lease`.
 */
export const RISK_PATTERNS: RiskPattern[] = [
  // Bare "/" or "~/" targets only — not every absolute path.
  { name: "rm -rf /", test: (c) => /rm -rf \/(?:\s|$)/.test(c) },
  { name: "rm -rf ~", test: (c) => /rm -rf ~(?:\/(?:\s|$)|\s|$)/.test(c) },
  {
    name: "git push --force",
    test: (c) => /git push\b[^|;&]*--force(?!-with-lease)/.test(c),
  },
  { name: "git reset --hard", test: (c) => c.includes("git reset --hard") },
  // mkfs needs a device target: reading man pages / grepping docs is safe.
  { name: "mkfs", test: (c) => /\bmkfs[^|;&]*\/dev\//.test(c) },
  {
    name: "dd of=/dev/",
    test: (c) => /\bdd\b[^|;&]*\bof=\/dev\//.test(c),
  },
  { name: "chmod -R 777 /", test: (c) => /chmod -R 777 \/(?:\s|$)/.test(c) },
  {
    name: "curl | sh",
    test: (c) => /curl\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/.test(c),
  },
  // `sudo rm` but not `sudo rmmod` (or other rm-prefixed tools).
  { name: "sudo rm", test: (c) => /\bsudo\s+rm(?:\s|$)/.test(c) },
];

/** Returns the matched risk pattern name, or null if the command is safe. */
export function matchRisk(normalizedCmd: string): string | null {
  for (const p of RISK_PATTERNS) {
    if (p.test(normalizedCmd)) return p.name;
  }
  return null;
}
