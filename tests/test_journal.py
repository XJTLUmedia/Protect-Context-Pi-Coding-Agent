"""Journal: entry shape, type validation, free-text cap (SPEC §1 #6/#7, §2)."""

import pytest

from protect_context import journal, store


def test_add_shape_and_type_validation():
    e = journal.add("correction", "use rg", ["search"])
    assert e["type"] == "correction"
    assert e["text"] == "use rg"
    assert e["tags"] == ["search"]
    assert set(e) == {"ts", "type", "text", "tags"}
    with pytest.raises(ValueError):
        journal.add("nope", "x")


def test_text_capped_at_500_chars():
    """Free text is capped at write time: journal text is re-injected (goal #12)."""
    e = journal.add("note", "y" * 900)
    assert len(e["text"]) == 500
    rows = store.read_jsonl(store.journal_path())
    assert rows[-1]["text"] == "y" * 500
