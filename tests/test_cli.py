"""CLI smoke for EVERY verb; exit codes 0 ok / 1 warning / 2 error (SPEC §3, §7)."""

import json
import subprocess
from pathlib import Path

from protect_context import journal, store, verify
from protect_context.cli import main


def _fail(cmd, session="test-session"):
    return {"kind": "tool_result", "tool": "bash", "ok": False, "cmd": cmd, "exit": 1,
            "session": session}


def _git(*args):
    subprocess.run(["git", *args], check=True, capture_output=True)


# ---- init -------------------------------------------------------------------

def test_init_creates_store_and_nudges(capsys):
    assert main(["init"]) == 0
    out = capsys.readouterr().out
    assert "Nudge:" in out
    assert (store.guard_dir() / "config.json").exists()
    assert (store.guard_dir() / "contract.json").exists()
    st = store.load_state()
    assert st["current_session"]["id"] == "test-session"


# ---- status -----------------------------------------------------------------

def test_status_smoke(capsys):
    main(["init"])
    assert main(["status"]) == 0
    out = capsys.readouterr().out
    assert "PC status" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- verify -----------------------------------------------------------------

def test_verify_ok_and_fail_exit_codes(capsys):
    main(["init"])
    assert main(["verify", "true"]) == 0
    assert main(["verify", "false"]) == 1
    out = capsys.readouterr().out
    assert "ev-0001" in out and "ev-0002" in out
    assert "Nudge:" in out
    assert verify.count() == 2


# ---- evidence ---------------------------------------------------------------

def test_evidence_smoke(capsys):
    verify.run_verify("true")
    verify.run_verify("true")
    assert main(["evidence", "--limit", "1"]) == 0
    out = capsys.readouterr().out
    assert "last 1 of 2" in out and "ev-0002" in out and "Nudge:" in out


# ---- contract ---------------------------------------------------------------

def test_contract_list_add_remove(capsys):
    assert main(["contract", "list"]) == 0
    out = capsys.readouterr().out
    assert "contract (12 constraints)" in out and "Nudge:" in out

    assert main(["contract", "add", "Keep PRs under 300 lines"]) == 0
    out = capsys.readouterr().out
    assert "13-keep-prs-under-300" in out

    data = json.loads(store.contract_path().read_text(encoding="utf-8"))
    new_id = data["constraints"][-1]["id"]
    assert new_id == "13-keep-prs-under-300"
    assert main(["contract", "remove", new_id]) == 0
    assert main(["contract", "remove", "zzz-unknown"]) == 2  # error
    out = capsys.readouterr().out
    assert "Nudge:" in out


# ---- note -------------------------------------------------------------------

def test_note_with_tags(capsys):
    assert main(["note", "correction", "Use rg, not grep", "--tags", "search,env"]) == 0
    out = capsys.readouterr().out
    assert "logged correction #1" in out and "search, env" in out
    assert "Nudge:" in out
    entry = journal.recent(1)[0]
    assert entry["tags"] == ["search", "env"] and entry["type"] == "correction"


# ---- loops ------------------------------------------------------------------

def test_loops_exit_1_at_block_threshold(write_events, capsys):
    write_events([_fail("pytest -q"), _fail("pytest -q")])
    assert main(["loops"]) == 1
    out = capsys.readouterr().out
    assert "pytest -q ×2" in out and "Nudge:" in out


def test_loops_exit_0_below_threshold(write_events, capsys):
    write_events([_fail("pytest -q")])
    assert main(["loops"]) == 0
    assert "Nudge:" in capsys.readouterr().out


# ---- diff -------------------------------------------------------------------

def test_diff_error_outside_repo(capsys):
    assert main(["diff"]) == 2
    out = capsys.readouterr().out
    assert "error" in out and "Nudge:" in out


def test_diff_ok_then_warn_in_repo(capsys):
    _git("init", "-q")
    _git("-c", "user.email=pc@test", "-c", "user.name=pc", "commit", "--allow-empty",
         "-qm", "init")
    Path("f.txt").write_text("x\n" * 5)
    _git("add", "f.txt")  # untracked files are invisible to `git diff HEAD`
    assert main(["diff"]) == 0
    Path("f.txt").write_text("x\n" * 450)
    assert main(["diff"]) == 1
    out = capsys.readouterr().out
    assert "verdict warn" in out and "Nudge:" in out


# ---- preflight --------------------------------------------------------------

def test_preflight_exit_codes_follow_missing_tools(capsys):
    store.ensure()
    from protect_context.defaults import DEFAULT_CONFIG

    store.write_json(store.config_path(),
                     dict(DEFAULT_CONFIG, preflight_tools=["python3"]))
    assert main(["preflight"]) == 0
    store.write_json(store.config_path(),
                     dict(DEFAULT_CONFIG, preflight_tools=["no-such-tool-xyz"]))
    assert main(["preflight"]) == 1
    assert "Nudge:" in capsys.readouterr().out


# ---- budget -----------------------------------------------------------------

def test_budget_smoke(capsys):
    main(["init"])
    assert main(["budget"]) == 0
    out = capsys.readouterr().out
    assert "0 chars" in out and "Nudge:" in out


# ---- error mapping ----------------------------------------------------------

def test_missing_binary_is_warning_not_error(capsys):
    rc = main(["verify", "definitely-missing-binary-xyz"])
    assert rc == 1  # recorded evidence of failure, not a tool error
    out = capsys.readouterr().out
    assert "exit 127" in out and "Nudge:" in out


# ---- orientation wiring (goal #4) --------------------------------------------

def test_init_includes_orientation_digest(capsys):
    """`init` folds the orientation brief (tree, languages, conventions) into
    its output — goal #4 must be reachable from the CLI delivery surface."""
    assert main(["init"]) == 0
    out = capsys.readouterr().out
    assert "PC orientation" in out
    assert "languages:" in out and "conventions:" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")


# ---- contract add: brief-cap warning -----------------------------------------

def test_contract_add_warns_past_brief_cap(capsys):
    """The 13th constraint exceeds the frozen 12-line brief cap: the ack must
    say it will NOT be re-injected, not imply it will."""
    assert main(["contract", "add", "Keep PRs under 300 lines"]) == 0
    out = capsys.readouterr().out
    assert "NOT re-injected" in out
    assert "Nudge:" in out
    assert out.rstrip().splitlines()[-1].startswith("Nudge:")
