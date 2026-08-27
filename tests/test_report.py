"""Status dashboard contents (SPEC §4 guard_status row)."""

from protect_context import contract, report, store, verify


def test_status_dashboard_contents():
    contract.load()  # seed 12
    verify.run_verify("true")
    text, level = report.status()
    assert "PC status" in text
    assert "session test-session" in text
    assert "loops: none" in text
    assert "evidence 1 · last ev-0001 exit 0" in text
    assert "contract 12 constraints" in text
    assert level == 0
    assert text.rstrip().splitlines()[-1].startswith("Nudge:")


def test_status_outside_git_repo():
    text, level = report.status()
    assert "Δdiff n/a (not a git repo)" in text
    assert level == 0


def test_status_evidence_is_scoped_to_session():
    """Other sessions' verify runs don't leak into this session's dashboard."""
    store.ensure()
    row = {"id": "ev-0001", "ts": "t", "session": "someone-else", "cmd": "true",
           "exit": 0, "ok": True, "digest": "", "ms": 1}
    store.append_jsonl(store.verify_path(), row)
    text, _level = report.status()
    assert "evidence 0 · last none" in text
    verify.run_verify("true")
    text, _level = report.status()
    assert "evidence 1 · last ev-0002 exit 0" in text


def test_status_includes_conventions_line():
    """Goal #4: conventions files surface on the dashboard (cheap root stats)."""
    contract.load()
    text, _level = report.status()
    assert "conventions:" in text
