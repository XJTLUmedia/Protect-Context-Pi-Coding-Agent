"""Orientation digest: tree ≤2 levels, language counts, conventions files (SPEC §7)."""

from protect_context import orientation


def test_digest_counts_and_conventions(tmp_path):
    (tmp_path / "src" / "pkg").mkdir(parents=True)
    (tmp_path / "src" / "pkg" / "a.py").write_text("x = 1\n")
    (tmp_path / "src" / "b.py").write_text("x = 2\n")
    (tmp_path / "lib.ts").write_text("export {};\n")
    (tmp_path / "tool.sh").write_text("#!/bin/sh\n")
    (tmp_path / "CLAUDE.md").write_text("# conventions\n")
    (tmp_path / "README.md").write_text("# r\n")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules" / "x.js").write_text("")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "hidden.py").write_text("")

    d = orientation.digest(tmp_path)
    assert "Python=2" in d
    assert "TypeScript=1" in d
    assert "Shell=1" in d
    assert "CLAUDE.md" in d and "README.md" in d
    assert "node_modules" not in d  # skipped entirely
    assert ".git" not in d
    assert "pkg" in d  # level-2 children shown
    assert d.rstrip().splitlines()[-1].startswith("Nudge:")


def test_digest_empty_dir(tmp_path):
    d = orientation.digest(tmp_path)
    assert "none detected" in d
    assert "none found" in d
    assert d.rstrip().splitlines()[-1].startswith("Nudge:")


def test_tree_limited_to_two_levels(tmp_path):
    (tmp_path / "a" / "b" / "c").mkdir(parents=True)
    (tmp_path / "a" / "b" / "c" / "deep.py").write_text("")
    (tmp_path / "a" / "child.txt").write_text("")
    d = orientation.digest(tmp_path)
    assert "a/ (b/, child.txt)" in d
    assert "deep.py" not in d  # level 3 never listed
