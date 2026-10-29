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
  /** null on an ordinary tool_call; false when the call was refused. */
  ok: boolean | null;
  ms: number | null;
  out_chars: number | null;
  /** bash rows only, fingerprint-normalized (tool_call and tool_result). */
  cmd: string | null;
  exit: number | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function toolCallEvent(
  session: string,
  tool: string,
  opts: { cmd?: string | null; blocked?: boolean } = {},
): EventRecord {
  return {
    ts: nowIso(),
    session,
    kind: "tool_call",
    tool,
    // A refused call (loop block / declined risk confirm) has no result, so the
    // attempt is recorded as ok=false; an ordinary call has no outcome yet.
    ok: opts.blocked ? false : null,
    ms: null,
    out_chars: null,
    cmd: opts.cmd ?? null,
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
