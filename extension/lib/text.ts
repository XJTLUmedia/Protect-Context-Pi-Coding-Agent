/**
 * Shared text utilities (goal #12): hard one-line caps so model-supplied text
 * can never bloat re-injected briefs, journals or evidence lines.
 * Pure logic — no pi imports.
 */

/** Truncate `s` to `max` chars with a trailing ellipsis when longer. */
export function trunc(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}
