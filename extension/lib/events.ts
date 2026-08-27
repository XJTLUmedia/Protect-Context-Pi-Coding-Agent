/**
 * Event records for `.agent-guard/events.jsonl` (SPEC §2, §5).
 * Pure logic + record shapes — no pi imports.
 */

export type EventKind = "tool_call" | "tool_result";

export interface EventRecord {
  ts: string;
  session: string;
  kind: EventKind;
  tool: string;
  ok: boolean | null;
  ms: number | null;
  out_chars: number | null;
  /** Only set for bash tool_result events; fingerprint-normalized. */
  cmd: string | null;
  exit: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function toolCallEvent(session: string, tool: string): EventRecord {
  return {
    ts: nowIso(),
    session,
    kind: "tool_call",
    tool,
    ok: null,
    ms: null,
    out_chars: null,
    cmd: null,
    exit: null,
  };
}

export function toolResultEvent(
  session: string,
  tool: string,
  opts: { ok: boolean | null; ms: number | null; outChars: number | null; cmd?: string | null; exit?: number | null },
): EventRecord {
  return {
    ts: nowIso(),
    session,
    kind: "tool_result",
    tool,
    ok: opts.ok,
    ms: opts.ms,
    out_chars: opts.outChars,
    cmd: opts.cmd ?? null,
    exit: opts.exit ?? null,
  };
}

/**
 * The pi bash tool does not expose the exit code in its details; on nonzero
 * exit it throws with "Command exited with code N" appended to the output.
 * Parse it back out; returns null when unavailable (e.g. cancelled).
 */
export function bashExitFromResult(text: string): number | null {
  const matches = text.matchAll(/Command exited with code (\d+)/g);
  let last: number | null = null;
  for (const m of matches) {
    last = Number(m[1]);
  }
  return last;
}
