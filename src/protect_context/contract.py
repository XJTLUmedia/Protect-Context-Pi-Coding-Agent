"""Contract store CRUD: .agent-guard/contract.json (SPEC §1 #1, §6).

Seeded from DEFAULT_CONTRACT on first use; user-added constraints get
sequential ids (13-, 14-, ...) with a slug derived from the text.
"""

from __future__ import annotations

import re

from . import store
from .defaults import DEFAULT_CONTRACT

MAX_SLUG = 40
MAX_TEXT = 500  # free-text cap (parity with the extension): briefs re-inject it
# SPEC §5: the extension's re-injected brief carries at most 12 contract
# lines. Owner-added constraints beyond the cap exist in the store but are
# NOT re-injected — surfaces that ack an `add` must say so (frozen §5 cap).
BRIEF_MAX_CONTRACT_LINES = 12


def brief_cap_warning(total: int) -> str:
    """Warning line for constraints that cannot enter the extension's brief
    (empty string when the contract fits the cap)."""
    if total <= BRIEF_MAX_CONTRACT_LINES:
        return ""
    return (
        f"warning: {total} constraints exceed the {BRIEF_MAX_CONTRACT_LINES}-line brief cap — "
        f"constraints beyond {BRIEF_MAX_CONTRACT_LINES} are NOT re-injected by the pi brief."
    )


def load() -> list[dict]:
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
    return data["constraints"]


def save(constraints: list[dict]) -> None:
    store.ensure()
    store.write_json(store.contract_path(), {"version": 1, "constraints": constraints})


def _num(cid: str) -> int:
    m = re.match(r"(\d+)", str(cid))
    return int(m.group(1)) if m else 0


def _slug(text: str) -> str:
    words = re.findall(r"[a-z0-9]+", text.lower())[:4]
    return ("-".join(words)[:MAX_SLUG]).strip("-") or "constraint"


def add(text: str, source: str = "user") -> tuple[dict | None, list[dict]]:
    """Add a constraint. Returns (constraint_or_None_if_duplicate, all)."""
    text = text.strip()[:MAX_TEXT]
    cons = load()
    for c in cons:
        if str(c.get("text", "")).strip() == text:
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
    save(cons)
    return constraint, cons


def remove(cid: str) -> bool:
    """Remove a constraint by exact id. Returns False if not found."""
    cons = load()
    kept = [c for c in cons if c.get("id") != cid]
    if len(kept) == len(cons):
        return False
    save(kept)
    return True


def render(cons: list[dict]) -> str:
    """Compact contract view (no Nudge; callers append one)."""
    lines = [f"{c.get('id')} {c.get('text')}" for c in cons]
    return f"contract ({len(cons)} constraints)\n" + "\n".join(lines)
