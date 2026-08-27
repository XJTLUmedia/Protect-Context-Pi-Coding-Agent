/**
 * Persistent single-line status widget (SPEC §5).
 * Pure logic — no pi imports.
 *
 * Format (FROZEN example): `PC Δ+123L/4f 1loop ev2 ctx41%`
 */

export interface WidgetData {
  diffLines: number;
  diffFiles: number;
  /** Number of commands currently in a failing loop. */
  loops: number;
  /** Evidence (verify runs) recorded this session. */
  evidence: number;
  ctxPct: number | null;
}

export function renderWidget(d: WidgetData): string {
  const pct = d.ctxPct === null ? 0 : Math.round(d.ctxPct);
  return `PC Δ+${d.diffLines}L/${d.diffFiles}f ${d.loops}loop ev${d.evidence} ctx${pct}%`;
}
