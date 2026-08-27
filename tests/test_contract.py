"""Contract CRUD + defaults identical to the TS side: same 12 ids and exact
texts (SPEC §6, §7)."""

import json

from protect_context import contract, store
from protect_context.defaults import DEFAULT_CONTRACT

EXPECTED = [
    ("01-obey-instructions",
     "Obey the owner's explicit instructions and stated constraints exactly; "
     "when instructions conflict, ask instead of guessing."),
    ("02-evidence-before-success",
     "Never claim success without citing a fresh verification run (evidence id "
     "or pasted output) for the exact claim."),
    ("03-stay-in-scope",
     "Change only files the stated task requires; no unrelated refactors, "
     "reformatting, or \"improvements\"."),
    ("04-orient-first",
     "Before the first edit in an unfamiliar area, read the relevant files and "
     "conventions; never code from guesses."),
    ("05-simplest-correct",
     "Prefer the simplest implementation satisfying stated behavior; add or "
     "update a test for every behavior change."),
    ("06-journal-decisions",
     "Record durable decisions and constraints in the journal when made; "
     "re-read them before resuming work."),
    ("07-log-corrections",
     "When the owner corrects behavior, log a tagged correction; check "
     "corrections before similar work."),
    ("08-keep-diffs-reviewable",
     "Keep diffs small: split work into logical steps; treat 400+ changed "
     "lines per task as a stop-and-split signal."),
    ("09-no-identical-retries",
     "After 2 failures of the same command, change approach or gather new "
     "information; never re-run identical failing commands."),
    ("10-preflight-env",
     "When tools behave unexpectedly, run preflight (tool presence/versions) "
     "before blaming code."),
    ("11-batch-operations",
     "Batch related shell operations; prefer commands that avoid per-command "
     "permission prompts."),
    ("12-budget-context",
     "Keep tool outputs bounded (head/tail/digest); use targeted reads; avoid "
     "re-reading large files."),
]


def test_seed_written_on_first_load():
    assert not store.contract_path().exists()
    cons = contract.load()
    assert len(cons) == 12
    assert store.contract_path().exists()
    data = json.loads(store.contract_path().read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["constraints"] == cons


def test_defaults_exact_ids_and_texts():
    got = [(c["id"], c["text"]) for c in contract.load()]
    assert got == EXPECTED
    assert [(c["id"], c["text"]) for c in DEFAULT_CONTRACT] == EXPECTED


def test_seed_entry_shape_is_deterministic():
    for c in DEFAULT_CONTRACT:
        assert set(c) == {"id", "text", "added", "source"}
        assert c["source"] == "seed"
        assert c["added"] == "2026-08-28"  # SPEC frozen date — stable across sides


def test_add_assigns_sequential_slug_id_and_persists():
    c, cons = contract.add("Always run pytest before committing")
    assert c["id"].startswith("13-")
    assert cons[-1]["id"] == c["id"]
    assert c["source"] == "user"
    assert any(x["id"] == c["id"] for x in contract.load())  # persisted


def test_add_duplicate_text_rejected():
    contract.add("Do the thing")
    c2, cons = contract.add("  Do the thing  ")
    assert c2 is None
    assert len(cons) == 13


def test_remove_by_id():
    c, _ = contract.add("Another constraint here")
    assert contract.remove(c["id"]) is True
    assert all(x["id"] != c["id"] for x in contract.load())
    assert contract.remove("zzz-not-there") is False


def test_render_view():
    text = contract.render(contract.load())
    assert text.startswith("contract (12 constraints)")
    assert "01-obey-instructions" in text
    assert "12-budget-context" in text


def test_add_caps_text_length():
    """Constraint text is capped (parity with the extension): briefs re-inject it."""
    c, _ = contract.add("x" * 900)
    assert len(c["text"]) == 500


def test_corrupt_file_falls_back_without_overwriting():
    """A corrupt contract.json serves in-memory defaults and is NOT clobbered."""
    store.ensure()
    p = store.contract_path()
    p.write_text("{truncated", encoding="utf-8")
    cons = contract.load()
    assert len(cons) == 12
    assert p.read_text(encoding="utf-8") == "{truncated"


def test_brief_cap_warning_fires_only_past_12():
    """SPEC §5 freezes the brief at 12 contract lines; the warning tells the
    truth about constraints beyond it."""
    assert contract.brief_cap_warning(12) == ""
    warn = contract.brief_cap_warning(13)
    assert "NOT re-injected" in warn and "12" in warn
