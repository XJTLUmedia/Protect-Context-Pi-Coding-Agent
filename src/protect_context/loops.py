"""Loop detection: failing-command streaks from events.jsonl + the evidence
ledger (SPEC §1 #9).

A streak for a command fingerprint counts its failed bash tool_result events
since the last *successful* run of that same fingerprint. Failing or unknown
events of other commands do not reset a streak. The extension blocks a re-run
once prior failures for the fingerprint reach loop_block_after - 1; this
module reports the same arithmetic.

guard_verify outcomes are merged into the streaks too (ok=False → +1,
ok=True → reset): the suite's own evidence tool must not be an escape hatch
from goal #9. verify_runs.jsonl already stores `cmd`, so no §2 change.
"""

from __future__ import annotations

from . import store


def _verify_outcomes(session: str) -> list[dict]:
    """guard_verify ledger outcomes for a session as loop-relevant pseudo-events
    (same shape as bash tool_results, so the streak arithmetic below is shared)."""
    out: list[dict] = []
    for r in store.read_jsonl(store.verify_path()):
        if r.get("session") != session or not isinstance(r.get("ok"), bool):
            continue
        cmd = r.get("cmd")
        if not cmd:
            continue
        out.append(
            {
                "ts": str(r.get("ts") or ""),
                "session": session,
                "kind": "tool_result",
                "tool": "guard_verify",
                "ok": r["ok"],
                "cmd": cmd,
                "exit": r.get("exit"),
            }
        )
    return out


def streaks(events: list[dict] | None = None, session: str | None = None) -> list[dict]:
    """Return [{"cmd": fingerprint, "count": n}, ...] sorted by count desc.

    With no explicit events, bash tool_results are merged with guard_verify
    outcomes (chronological by ts; ties keep file order) so failing verify
    runs accumulate streaks exactly like failing bash runs.
    """
    session = session or store.session_id()
    if events is None:
        events = sorted(
            store.read_jsonl(store.events_path()) + _verify_outcomes(session),
            key=lambda e: str(e.get("ts") or ""),
        )
    current: dict[str, int] = {}
    for e in events:
        if e.get("session") != session or e.get("kind") != "tool_result":
            continue
        cmd = e.get("cmd")
        if not cmd:
            continue
        cmd = store.fingerprint(cmd)  # defensive: storage should be normalized
        ok = e.get("ok")
        if ok is False:
            current[cmd] = current.get(cmd, 0) + 1
        elif ok is True:
            current.pop(cmd, None)
        # ok None (unknown) → ignored, streak untouched
    out = [{"cmd": cmd, "count": n} for cmd, n in current.items() if n > 0]
    out.sort(key=lambda s: (-s["count"], s["cmd"]))
    return out


def block_threshold(cfg: dict) -> int:
    """Prior failures at which the NEXT identical re-run gets blocked."""
    return max(1, int(cfg.get("loop_block_after", 3)) - 1)


def would_block(streak_list: list[dict], cfg: dict) -> list[dict]:
    t = block_threshold(cfg)
    return [s for s in streak_list if s["count"] >= t]


def render(streak_list: list[dict], cfg: dict) -> str:
    lines = [f"PC loops · session {store.session_id()}"]
    if not streak_list:
        lines.append("no repeated failing commands")
        lines.append("Nudge: before re-running a failed command, read the error and change something.")
        return "\n".join(lines)
    for s in streak_list[:5]:
        lines.append(f"{s['cmd'][:60]} ×{s['count']}")
    if would_block(streak_list, cfg):
        lines.append(f"next identical run will be blocked (loop_block_after={cfg.get('loop_block_after', 3)})")
        lines.append(
            "Nudge: change approach or gather new information — do not re-run unchanged; "
            "raise loop_block_after in .agent-guard/config.json to override."
        )
    else:
        lines.append("Nudge: another identical failure will trigger a block — change approach now.")
    return "\n".join(lines)
