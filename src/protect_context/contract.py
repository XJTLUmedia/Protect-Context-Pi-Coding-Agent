"""Contract store CRUD: .agent-guard/contract.json (SPEC §1 #1, §6).

Seeded from DEFAULT_CONTRACT on first use; user-added constraints get
sequential ids (13-, 14-, ...) with a slug derived from the text.
"""

from __future__ import annotations

import re
import unicodedata

from . import store
from .defaults import DEFAULT_CONTRACT

MAX_SLUG = 40
MAX_TEXT = 500  # free-text cap (parity with the extension): briefs re-inject it
# SPEC §5: the extension's re-injected brief carries at most 12 contract
# lines. The extension selects owner constraints before seeds and never lets
# agent-authored entries displace seeds; surfaces that exceed the cap must
# disclose that only the highest-priority subset is re-injected.
BRIEF_MAX_CONTRACT_LINES = 12
RENDER_ID_MAX = 80
RENDER_MAX_CONSTRAINTS = 24

_CONTROL_CATEGORIES = {"Cc", "Cf", "Cs"}


def _normalise_text(value: object, cap: int) -> str:
    """Return bounded single-line text safe for storage and rendering."""
    raw = str(value or "")
    without_controls = "".join(
        " " if unicodedata.category(char) in _CONTROL_CATEGORIES else char
        for char in raw
    )
    return " ".join(without_controls.split())[:cap].strip()


def brief_cap_warning(total: int) -> str:
    """Warning line for constraints that cannot enter the extension's brief
    (empty string when the contract fits the cap)."""
    if total <= BRIEF_MAX_CONTRACT_LINES:
        return ""
    return (
        f"warning: {total} constraints exceed the {BRIEF_MAX_CONTRACT_LINES}-line brief cap — "
        f"only the {BRIEF_MAX_CONTRACT_LINES} highest-priority owner/seed constraints are "
        "re-injected by the pi brief; review the complete contract explicitly."
    )


def _load_unlocked() -> list[dict]:
    """Load constraints, seeding contract.json from DEFAULT_CONTRACT if the
    file is missing. A corrupt file falls back to in-memory defaults."""
    p = store.contract_path()
    if not p.exists():
        data = [dict(c) for c in DEFAULT_CONTRACT]
        store.ensure()
        store.write_json(p, {"version": 1, "constraints": data})
        return data
    data = store.read_json(p)
    if not isinstance(data, dict) or not isinstance(data.get("constraints"), list):
        return [dict(c) for c in DEFAULT_CONTRACT]
    raw = data["constraints"]
    required = ("id", "text", "added", "source")
    valid = [
        dict(c)
        for c in raw
        if isinstance(c, dict)
        and all(isinstance(c.get(key), str) for key in required)
    ]
    # An explicitly empty list is a valid owner choice. A non-empty list made
    # entirely of malformed rows is corruption, so fail back to the frozen
    # seeds instead of silently disabling every guardrail.
    if raw and not valid:
        return [dict(c) for c in DEFAULT_CONTRACT]
    return valid


def load() -> list[dict]:
    """Load the current contract.

    The shared lock also serializes first-load seeding. Mutating callers use
    ``_load_unlocked`` while already holding the lease, keeping each complete
    read-modify-write cycle inside one critical section.
    """
    with store.store_lock():
        return _load_unlocked()


def _save_unlocked(constraints: list[dict]) -> None:
    store.ensure()
    store.write_json(store.contract_path(), {"version": 1, "constraints": constraints})


def save(constraints: list[dict]) -> None:
    """Replace the contract while holding the shared cross-runtime lock."""
    with store.store_lock():
        _save_unlocked(constraints)


def _num(cid: str) -> int:
    m = re.match(r"(\d+)", str(cid))
    return int(m.group(1)) if m else 0


def _slug(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:4]
    return ("-".join(words)[:MAX_SLUG]).strip("-") or "constraint"


def add(text: str, source: str = "user") -> tuple[dict | None, list[dict]]:
    """Add a constraint. Returns (constraint_or_None_if_duplicate, all)."""
    text = _normalise_text(text, MAX_TEXT)
    if not text:
        raise ValueError("constraint text must not be blank")
    with store.store_lock():
        cons = _load_unlocked()
        for c in cons:
            if _normalise_text(c.get("text"), MAX_TEXT) == text:
                return None, cons
        num = 1 + max([_num(c.get("id", "")) for c in cons] or [0])
        base = f"{num:02d}-{_slug(text)}"
        cid = base
        taken = {c.get("id") for c in cons}
        n = 2
        while cid in taken:
            cid = f"{base}-{n}"
            n += 1
        constraint = {
            "id": cid,
            "text": text,
            "added": store.now_ts()[:10],
            "source": source,
        }
        cons.append(constraint)
        _save_unlocked(cons)
        return constraint, cons


def remove(cid: str) -> bool:
    """Remove a constraint by exact id. Returns False if not found."""
    with store.store_lock():
        cons = _load_unlocked()
        kept = [c for c in cons if c.get("id") != cid]
        if len(kept) == len(cons):
            return False
        _save_unlocked(kept)
        return True


def _render_subset(cons: list[dict], limit: int) -> list[dict]:
    """Keep frozen seeds plus the newest remaining constraints under a cap."""
    if len(cons) <= limit:
        return cons
    seed_indexes = [i for i, c in enumerate(cons) if c.get("source") == "seed"]
    chosen = set(seed_indexes[:limit])
    for i in range(len(cons) - 1, -1, -1):
        if len(chosen) >= limit:
            break
        chosen.add(i)
    return [cons[i] for i in sorted(chosen)]


def render(cons: list[dict], limit: int = RENDER_MAX_CONSTRAINTS) -> str:
    """Compact, bounded contract view (no Nudge; callers append one).

    The frozen seeds stay visible when ordinary owner/agent entries overflow;
    remaining capacity shows the newest entries. The header and omission line
    make the bounded view explicit instead of presenting it as complete.
    """
    try:
        bounded_limit = max(1, min(int(limit), RENDER_MAX_CONSTRAINTS))
    except (TypeError, ValueError):
        bounded_limit = RENDER_MAX_CONSTRAINTS
    visible = _render_subset(cons, bounded_limit)
    lines = []
    for c in visible:
        cid = _normalise_text(c.get("id"), RENDER_ID_MAX) or "unknown-id"
        text = _normalise_text(c.get("text"), MAX_TEXT) or "(blank legacy constraint)"
        lines.append(f"{cid} {text}")
    if len(visible) == len(cons):
        header = f"contract ({len(cons)} constraints)"
    else:
        omitted = len(cons) - len(visible)
        header = f"contract ({len(cons)} constraints; showing {len(visible)})"
        lines.insert(0, f"… {omitted} older non-seed constraints omitted from this compact view")
    return header + "\n" + "\n".join(lines)
