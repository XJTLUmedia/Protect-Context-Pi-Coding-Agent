"""Persistent journal: .agent-guard/journal.jsonl (SPEC §1 #6, #7).

Entry shape (FROZEN): {"ts", "type": decision|correction|risk|note,
"text", "tags": []}. Entries survive restarts and are re-injected by the
extension when they change.
"""

from __future__ import annotations

import unicodedata

from . import store

NUDGE_BY_TYPE = {
    "decision": "Nudge: re-read journal decisions before resuming work.",
    "correction": "Nudge: check logged corrections before doing similar work.",
    "risk": "Nudge: logged risks should drive preflight and risk confirms.",
    "note": "Nudge: the journal persists across restarts — build on it.",
}

TEXT_CAP = 500  # free-text cap: journal text is re-injected into briefs (goal #12)
TAG_COUNT_CAP = 8
TAG_TEXT_CAP = 40
READ_LIMIT_DEFAULT = 5
READ_LIMIT_MAX = 20

_CONTROL_CATEGORIES = {"Cc", "Cf", "Cs"}


def _normalise_text(value: object, cap: int) -> str:
    """Return bounded, single-line text safe for storage and rendering.

    Journal content is model-supplied and later rendered into terminal/MCP
    output. Replace Unicode control, format, and surrogate code points with
    spaces before collapsing whitespace, so controls cannot forge lines or
    invisibly join otherwise separate words.
    """
    raw = str(value or "")
    without_controls = "".join(
        " " if unicodedata.category(char) in _CONTROL_CATEGORIES else char
        for char in raw
    )
    return " ".join(without_controls.split())[:cap].strip()


def _normalise_tags(tags: object) -> list[str]:
    """Clean, deduplicate, and bound tags, dropping post-cleaning blanks."""
    if tags is None:
        return []
    if isinstance(tags, str):
        candidates = [tags]
    elif isinstance(tags, (list, tuple, set)):
        candidates = tags
    else:
        # MCP/CLI schemas supply arrays, but the core API is public: malformed
        # legacy/direct-call values should be ignored rather than crashing a
        # journal render or write.
        return []
    clean: list[str] = []
    seen: set[str] = set()
    for tag in candidates:
        value = _normalise_text(tag, TAG_TEXT_CAP)
        if value and value not in seen:
            clean.append(value)
            seen.add(value)
        if len(clean) >= TAG_COUNT_CAP:
            break
    return clean


def tags_with_required(tags: object, required: str) -> list[str]:
    """Return bounded tags with exactly one normalized required tag.

    The required tag is placed last and cannot be crowded out by an
    over-limit caller list. This lets delivery boundaries preserve authorship
    provenance without changing the frozen journal entry shape.
    """
    required_clean = _normalise_text(required, TAG_TEXT_CAP)
    if not required_clean:
        raise ValueError("required journal tag must not be blank")
    clean = [tag for tag in _normalise_tags(tags) if tag != required_clean]
    return clean[:TAG_COUNT_CAP - 1] + [required_clean]


def _validate_type(jtype: str | None) -> None:
    if jtype is not None and jtype not in store.JOURNAL_TYPES:
        raise ValueError(
            f"unknown journal type {jtype!r}; use one of {', '.join(store.JOURNAL_TYPES)}"
        )


def _bounded_limit(limit: int) -> int:
    return max(0, min(int(limit), READ_LIMIT_MAX))


def add(jtype: str, text: str, tags: list[str] | None = None) -> dict:
    """Append a cleaned journal entry; reject unknown types and blank text."""
    _validate_type(jtype)
    clean_text = _normalise_text(text, TEXT_CAP)
    if not clean_text:
        raise ValueError("journal text must not be blank")
    entry = {
        "ts": store.now_ts(),
        "type": jtype,
        "text": clean_text,
        "tags": _normalise_tags(tags),
    }
    return store.append_jsonl(store.journal_path(), entry)


def recent(limit: int = READ_LIMIT_DEFAULT, jtype: str | None = None) -> list[dict]:
    """Return a bounded recent slice, oldest first, optionally by type."""
    _validate_type(jtype)
    entries = store.read_jsonl(store.journal_path())
    if jtype is not None:
        entries = [entry for entry in entries if entry.get("type") == jtype]
    bounded = _bounded_limit(limit)
    if bounded == 0:
        return []
    return entries[-bounded:]


def count(jtype: str | None = None) -> int:
    """Count all entries, or only entries of one validated journal type."""
    _validate_type(jtype)
    entries = store.read_jsonl(store.journal_path())
    if jtype is not None:
        entries = [entry for entry in entries if entry.get("type") == jtype]
    return len(entries)


def render_ack(entry: dict, total: int) -> str:
    """Compact acknowledgement for a freshly logged entry (ends with Nudge)."""
    jtype = _normalise_text(entry.get("type"), 16)
    tags = _normalise_tags(entry.get("tags"))
    tag_s = (" · tags: " + ", ".join(tags)) if tags else ""
    nudge = NUDGE_BY_TYPE.get(jtype, "Nudge: review the journal before resuming work.")
    return f"logged {jtype or 'entry'} #{total}{tag_s}\n{nudge}"


def render_recent(entries: list[dict], total: int, jtype: str | None = None) -> str:
    """Render a bounded journal view; every entry occupies exactly one line."""
    _validate_type(jtype)
    bounded_entries = entries[-READ_LIMIT_MAX:]
    scope = f" {jtype}" if jtype else ""
    lines = [f"PC journal{scope} · last {len(bounded_entries)} of {max(0, int(total))}"]
    for entry in bounded_entries:
        ts = _normalise_text(entry.get("ts"), 32) or "unknown-time"
        entry_type = _normalise_text(entry.get("type"), 16) or "unknown"
        text = _normalise_text(entry.get("text"), TEXT_CAP) or "(blank legacy entry)"
        tags = _normalise_tags(entry.get("tags"))
        tag_s = f" [{','.join(tags)}]" if tags else ""
        lines.append(f"{ts} · {entry_type} · {text}{tag_s}")
    lines.append("Nudge: re-read durable decisions and corrections before resuming work.")
    return "\n".join(lines)
