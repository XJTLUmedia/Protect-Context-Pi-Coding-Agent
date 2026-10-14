"""Journal writes and the bounded read/render surface (SPEC §1 #6/#7)."""

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
    with pytest.raises(ValueError, match="must not be blank"):
        journal.add("note", " \n\t\x00\u200b ")


def test_text_capped_at_500_chars():
    """Free text is capped at write time: journal text is re-injected (goal #12)."""
    e = journal.add("note", "y" * 900)
    assert len(e["text"]) == 500
    rows = store.read_jsonl(store.journal_path())
    assert rows[-1]["text"] == "y" * 500


def test_control_chars_and_tags_are_normalised_and_bounded():
    tags = ["first\nline", "first line", "\x00", "x" * 100] + [f"tag-{i}" for i in range(20)]
    e = journal.add("decision", "keep\nwords\x00apart\u202e safely", tags)

    assert e["text"] == "keep words apart safely"
    assert e["tags"][0] == "first line"
    assert len(e["tags"]) == journal.TAG_COUNT_CAP
    assert all(tag and len(tag) <= journal.TAG_TEXT_CAP for tag in e["tags"])
    assert e["tags"][1] == "x" * journal.TAG_TEXT_CAP


def test_malformed_non_iterable_tags_are_ignored():
    entry = journal.add("note", "safe", 7)  # type: ignore[arg-type]
    assert entry["tags"] == []


def test_required_tag_is_deduped_after_cleaning_and_cannot_be_crowded_out():
    tags = ["agent\n", "owner"] + [f"tag-{i}" for i in range(20)]
    clean = journal.tags_with_required(tags, "agent")

    assert len(clean) == journal.TAG_COUNT_CAP
    assert clean.count("agent") == 1
    assert clean[-1] == "agent"


def test_recent_is_capped_and_can_filter_by_type():
    for i in range(journal.READ_LIMIT_MAX + 4):
        journal.add("decision" if i % 2 == 0 else "note", f"entry {i}")

    assert len(journal.recent(10_000)) == journal.READ_LIMIT_MAX
    decisions = journal.recent(10_000, "decision")
    assert decisions
    assert all(entry["type"] == "decision" for entry in decisions)
    assert journal.recent(0) == []
    with pytest.raises(ValueError):
        journal.recent(5, "unknown")


def test_render_recent_is_one_line_per_entry_and_defensively_bounded():
    raw = {
        "ts": "now\nforged",
        "type": "note\u202e",
        "text": "line one\nline two" + "z" * 900,
        "tags": ["tag\nvalue"] + ["x" * 100] * 20,
    }
    text = journal.render_recent([raw] * (journal.READ_LIMIT_MAX + 3), 99)
    lines = text.splitlines()

    assert lines[0] == f"PC journal · last {journal.READ_LIMIT_MAX} of 99"
    assert len(lines) == journal.READ_LIMIT_MAX + 2
    assert "forged" in lines[1] and "line one line two" in lines[1]
    assert all(len(line) <= 32 + 3 + 16 + 3 + journal.TEXT_CAP + 2
               + journal.TAG_COUNT_CAP * (journal.TAG_TEXT_CAP + 1)
               for line in lines[1:-1])
    assert lines[-1].startswith("Nudge:")
