"""Context budget accounting (SPEC §1 #12): tool-output chars per session,
estimated tokens (chars/4), per-tool breakdown with top-5.
"""

from __future__ import annotations

from . import store

TOKEN_DIVISOR = 4


def compute(events: list[dict] | None = None, session: str | None = None, top: int = 5) -> dict:
    if events is None:
        events = store.read_jsonl(store.events_path())
    session = session or store.session_id()
    per_tool: dict[str, int] = {}
    n = 0
    for e in events:
        if e.get("session") != session or e.get("kind") != "tool_result":
            continue
        n += 1
        raw_chars = e.get("out_chars")
        chars = (
            raw_chars
            if isinstance(raw_chars, int)
            and not isinstance(raw_chars, bool)
            and raw_chars >= 0
            else 0
        )
        raw_tool = e.get("tool")
        tool = raw_tool if isinstance(raw_tool, str) and raw_tool else "unknown"
        per_tool[tool] = per_tool.get(tool, 0) + chars
    chars = sum(per_tool.values())
    try:
        bounded_top = max(0, min(int(top), 5))
    except (TypeError, ValueError):
        bounded_top = 5
    top_tools = sorted(per_tool.items(), key=lambda kv: (-kv[1], kv[0]))[:bounded_top]
    return {
        "session": session,
        "chars": chars,
        "tokens_est": chars // TOKEN_DIVISOR,
        "events": n,
        "top": top_tools,
    }


def render(b: dict) -> str:
    top = " · ".join(
        f"{store.display_text(t, 40) or 'unknown'}={c}" for t, c in b["top"][:5]
    ) or "none"
    return (
        f"PC budget · session {store.display_text(b['session'], 80)}\n"
        f"tool output: {b['chars']} chars (~{b['tokens_est']} tokens est) over {b['events']} tool results\n"
        f"top: {top}\n"
        "Nudge: keep tool outputs bounded (head/tail/digest); use targeted reads, not whole-file dumps."
    )
