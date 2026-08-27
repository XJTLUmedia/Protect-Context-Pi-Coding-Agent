"""Persistent journal: .agent-guard/journal.jsonl (SPEC §1 #6, #7).

Entry shape (FROZEN): {"ts", "type": decision|correction|risk|note,
"text", "tags": []}. Entries survive restarts and are re-injected by the
extension when they change.
"""

from __future__ import annotations

from . import store

NUDGE_BY_TYPE = {
    "decision": "Nudge: re-read journal decisions before resuming work.",
    "correction": "Nudge: check logged corrections before doing similar work.",
    "risk": "Nudge: logged risks should drive preflight and risk confirms.",
    "note": "Nudge: the journal persists across restarts — build on it.",
}

TEXT_CAP = 500  # free-text cap: journal text is re-injected into briefs (goal #12)


def add(jtype: str, text: str, tags: list[str] | None = None) -> dict:
    """Append a journal entry. Raises ValueError on an unknown type."""
    if jtype not in store.JOURNAL_TYPES:
        raise ValueError(f"unknown journal type {jtype!r}; use one of {', '.join(store.JOURNAL_TYPES)}")
    entry = {
        "ts": store.now_ts(),
        "type": jtype,
        "text": (text or "").strip()[:TEXT_CAP],
        "tags": [str(t) for t in (tags or [])],
    }
    return store.append_jsonl(store.journal_path(), entry)


def recent(limit: int = 5) -> list[dict]:
    entries = store.read_jsonl(store.journal_path())
    if limit <= 0:
        return []
    return entries[-limit:]


def count() -> int:
    return len(store.read_jsonl(store.journal_path()))


def render_ack(entry: dict, total: int) -> str:
    """Compact acknowledgement for a freshly logged entry (ends with Nudge)."""
    tag_s = (" · tags: " + ", ".join(entry["tags"])) if entry["tags"] else ""
    return f"logged {entry['type']} #{total}{tag_s}\n" + NUDGE_BY_TYPE[entry["type"]]
