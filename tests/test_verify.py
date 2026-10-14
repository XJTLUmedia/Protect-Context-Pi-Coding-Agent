"""Verify runner: records true/false outcomes, digest rules, timeout (SPEC §7)."""

import json
import os
import shutil
import time

import pytest

from protect_context import store, verify


def test_true_is_recorded_ok():
    e = verify.run_verify("true")
    assert e["ok"] is True
    assert e["exit"] == 0
    assert e["id"] == "ev-0001"
    assert e["cmd"] == "true"
    assert isinstance(e["ms"], int)
    assert e["session"] == "test-session"


def test_false_recorded_never_raises():
    e = verify.run_verify("false")
    assert e["ok"] is False
    assert e["exit"] == 1


def test_blank_command_is_rejected_without_evidence():
    with pytest.raises(ValueError, match="must not be blank"):
        verify.run_verify("  \t\n")
    assert verify.count() == 0


def test_ledger_sequence_and_ids():
    verify.run_verify("true")
    e2 = verify.run_verify("echo hello")
    assert e2["id"] == "ev-0002"
    runs = verify.recent()
    assert [r["id"] for r in runs] == ["ev-0001", "ev-0002"]
    assert verify.count() == 2
    assert verify.recent(limit=1)[0]["id"] == "ev-0002"


def test_digest_is_stdout_then_stderr():
    e = verify.run_verify("printf OUT; printf ERR 1>&2")
    assert e["digest"] == "OUTERR"


def test_digest_truncated_to_last_2000_chars():
    e = verify.run_verify("head -c 3000 /dev/zero | tr '\\0' 'x'")
    assert len(e["digest"]) == 2000
    assert e["digest"] == "x" * 2000


def test_large_output_uses_bounded_tail_and_preserves_stdout_then_stderr():
    e = verify.run_verify(
        "head -c 200000 /dev/zero | tr '\\0' 'x'; printf 'stderr-tail' 1>&2"
    )

    assert len(e["digest"]) == verify.DIGEST_MAX
    assert e["digest"].endswith("stderr-tail")
    assert e["digest"] == "x" * (verify.DIGEST_MAX - len("stderr-tail")) + "stderr-tail"


def test_timeout_recorded_as_124():
    e = verify.run_verify("sleep 5", timeout_s=1)
    assert e["ok"] is False
    assert e["exit"] == 124
    assert "timeout" in e["digest"].lower()
    assert e["ms"] >= 900


def test_persisted_ledger_schema():
    e = verify.run_verify("true")
    rows = store.read_jsonl(store.verify_path())
    assert len(rows) == 1
    r = rows[0]
    assert set(r) == {"id", "ts", "session", "cmd", "exit", "ok", "digest", "ms"}
    assert r["id"] == e["id"]


def test_render_entry_nudge():
    good = verify.render_entry(verify.run_verify("true"))
    assert good.rstrip().splitlines()[-1].startswith("Nudge:")
    assert "ev-0001" in good
    bad = verify.render_entry(verify.run_verify("false"))
    assert "FAIL" in bad and "Nudge:" in bad


def test_recent_and_count_scope_to_session():
    """Evidence count/last-verify are session-scoped (parity with the widget)."""
    e1 = verify.run_verify("true")
    other = dict(store.read_jsonl(store.verify_path())[0], session="someone-else")
    store.append_jsonl(store.verify_path(), other)
    assert verify.count() == 2  # whole ledger
    assert verify.count(session="someone-else") == 1
    assert verify.recent(1, session="test-session")[0]["id"] == e1["id"]
    assert verify.recent(1, session="someone-else")[0]["session"] == "someone-else"


def test_recent_limit_is_clamped_and_malformed_value_is_safe():
    for _ in range(25):
        verify.run_verify("true")

    assert len(verify.recent(10**9)) == verify.RECENT_LIMIT_MAX
    assert verify.recent(-1) == []
    assert len(verify.recent("not-a-number")) == verify.RECENT_LIMIT_DEFAULT  # type: ignore[arg-type]


def test_malformed_evidence_objects_are_ignored_by_views_and_count():
    store.ensure()
    store.verify_path().write_text(
        json.dumps({"session": "test-session", "ok": False}) + "\n",
        encoding="utf-8",
    )

    assert verify.recent() == []
    assert verify.count() == 0
    assert verify.run_verify("true")["id"] == "ev-0001"


def test_timeout_clamped_to_sane_range():
    """A model-supplied timeout can never wedge the session (1–900s clamp)."""
    assert verify._clamp_timeout(10**9) == verify.TIMEOUT_MAX_S
    assert verify._clamp_timeout(0) == verify.TIMEOUT_MIN_S
    assert verify._clamp_timeout(-5) == verify.TIMEOUT_MIN_S
    assert verify._clamp_timeout("bogus") == 180  # type: ignore[arg-type]
    assert verify._clamp_timeout(180) == 180


def test_match_risk_anchors_catastrophic_literals():
    """Benign lookalikes must not match (confirm-fatigue parity with the ext)."""
    assert verify.match_risk("rm -rf /") == "rm -rf /"
    assert verify.match_risk("rm -rf /tmp/build-cache") is None
    assert verify.match_risk("rm -rf ~/.cache/pip") is None
    assert verify.match_risk("sudo rmmod uvcvideo") is None
    assert verify.match_risk("man mkfs.ext4") is None
    assert verify.match_risk("grep -rn mkfs docs/") is None
    assert verify.match_risk("mkfs.ext4 /dev/sda1") == "mkfs"
    assert verify.match_risk("sudo rm -rf build") == "sudo rm"


# ---- timeout clamp + process-group kill (adversarial hardening) --------------

def test_timeout_clamped_to_sane_upper_bound(monkeypatch):
    """A model-supplied timeout_s=86400 must not wedge the session; the upper
    clamp applies (pinned here with a 1s ceiling for test speed)."""
    monkeypatch.setattr(verify, "TIMEOUT_MAX_S", 1)
    e = verify.run_verify("sleep 5", timeout_s=100000)
    assert e["ok"] is False and e["exit"] == 124
    assert e["ms"] < 4000
    assert "timeout" in e["digest"].lower()


def test_timeout_uses_child_kill_on_non_posix(monkeypatch):
    class Process:
        killed = False

        def kill(self):
            self.killed = True

    process = Process()
    monkeypatch.setattr(verify.os, "name", "nt")

    verify._terminate_timed_out_process(process)

    assert process.killed is True


def _marker_alive(marker: str) -> bool:
    """True when a process whose argv[0] == marker exists (Linux /proc scan;
    zombies have an empty cmdline, so they never count as alive)."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                argv0 = f.read().split(b"\0")[0].decode("utf-8", "replace")
        except OSError:
            continue
        if argv0 == marker:
            return True
    return False


def test_timeout_kills_whole_process_group():
    """Backgrounded grandchildren must not survive as runaway orphans: the
    anti-loop guardrail tool must not create the runaway processes it guards
    against. The child gets its own process group and the WHOLE group is
    SIGKILLed on timeout."""
    if not os.path.isdir("/proc") or shutil.which("bash") is None:
        pytest.skip("needs Linux /proc and bash")
    marker = f"pc-orphan-{os.getpid()}"
    e = verify.run_verify(f"bash -c 'exec -a {marker} sleep 30' & wait", timeout_s=1)
    assert e["exit"] == 124 and e["ok"] is False
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline and _marker_alive(marker):
        time.sleep(0.05)
    assert not _marker_alive(marker), "timeout left an orphaned grandchild running"


# ---- failure previews show the TAIL (token-ux) --------------------------------

def test_render_entry_failure_shows_tail_not_head():
    """Failure diagnostics (pytest summaries, compiler errors) live at the END
    of output; the digest rule is 'last ≤2000 chars', so the preview must be
    the tail, not the head banner."""
    cmd = "printf 'banner line\\n'; printf 'actual error at the end\\n' 1>&2; exit 3"
    e = verify.run_verify(cmd)
    assert e["ok"] is False
    digest_line = verify.render_entry(e).splitlines()[1]
    assert "error at the end" in digest_line
    assert "banner line" not in digest_line
