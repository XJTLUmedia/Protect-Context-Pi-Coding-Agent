"""Numstat parser + verdicts vs thresholds (SPEC §7)."""

import subprocess

from protect_context import diffscope
from protect_context.defaults import DEFAULT_CONFIG

NUMSTAT = (
    "10\t2\tsrc/a.py\n"
    "0\t0\timg.png\n"
    "-\t-\tlogo.bin\n"
    "3\t1\tdocs/{old => new}/guide.md\n"
)


def test_parse_numstat():
    rows = diffscope.parse_numstat(NUMSTAT)
    assert [(r["add"], r["del"]) for r in rows] == [(10, 2), (0, 0), (0, 0), (3, 1)]
    assert rows[2]["binary"] is True
    assert rows[2]["path"] == "logo.bin"
    assert rows[3]["path"] == "docs/{old => new}/guide.md"
    assert rows[1]["binary"] is False


def test_parse_numstat_empty():
    assert diffscope.parse_numstat("") == []


def test_stats():
    assert diffscope.stats(diffscope.parse_numstat(NUMSTAT)) == {"files": 4, "lines": 16}


def test_verdict_thresholds():
    cfg = dict(DEFAULT_CONFIG)
    assert diffscope.verdict({"files": 2, "lines": 399}, cfg) == "ok"
    assert diffscope.verdict({"files": 2, "lines": 400}, cfg) == "warn"
    assert diffscope.verdict({"files": 10, "lines": 5}, cfg) == "warn"
    assert diffscope.verdict({"files": 9, "lines": 5}, cfg) == "ok"
    assert diffscope.verdict({"files": 2, "lines": 800}, cfg) == "hard"
    assert diffscope.verdict({"files": 50, "lines": 900}, cfg) == "hard"


def _git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


def test_diff_audit_in_real_repo():
    _git("init", "-q")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "--allow-empty",
         "-qm", "init")
    with open("f.txt", "w", encoding="utf-8") as f:
        f.write("x\n" * 5)
    _git("add", "f.txt")  # untracked files are invisible to `git diff HEAD`
    st = diffscope.diff_audit()
    assert st["files"] == 1 and st["lines"] == 5 and st["verdict"] == "ok"
    assert st["baseline"] == "HEAD" and st["added"] == 5


def test_diff_audit_with_baseline_ref():
    _git("init", "-q")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "--allow-empty",
         "-qm", "c1")
    with open("f.txt", "w", encoding="utf-8") as f:
        f.write("x\n")
    _git("add", "f.txt")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "-qm", "c2")
    st = diffscope.diff_audit(baseline="HEAD~1")
    assert st["files"] == 1 and st["lines"] == 1


def test_diff_audit_outside_repo_is_error_not_raise():
    st = diffscope.diff_audit()
    assert "error" in st


def test_render_nudge_lines():
    assert "Nudge:" in diffscope.render({"error": "nope"})
    ok = diffscope.render({"baseline": "HEAD", "added": 1, "deleted": 0, "files": 1,
                           "lines": 1, "verdict": "ok", "warn_lines": 400,
                           "warn_files": 10, "hard_lines": 800})
    assert "verdict ok" in ok and ok.rstrip().splitlines()[-1].startswith("Nudge:")


def test_git_head_none_outside_repo():
    assert diffscope.git_head() is None
