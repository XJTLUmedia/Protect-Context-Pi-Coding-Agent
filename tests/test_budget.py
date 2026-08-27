"""Budget math: chars, tokens est (chars/4), per-tool top-5 (SPEC §7)."""

from protect_context import budget


def _res(tool, chars, session="test-session"):
    return {"kind": "tool_result", "tool": tool, "ok": True, "out_chars": chars,
            "cmd": None, "exit": 0, "session": session}


def test_budget_math_and_top_ordering(write_events):
    write_events([
        _res("bash", 1000),
        _res("bash", 500),
        _res("read", 2000),
        {"kind": "tool_call", "tool": "bash", "session": "test-session"},  # not counted
        _res("edit", 100, session="other-session"),  # other session ignored
    ])
    b = budget.compute()
    assert b["session"] == "test-session"
    assert b["chars"] == 3500
    assert b["tokens_est"] == 875  # 3500 // 4
    assert b["events"] == 3
    assert b["top"] == [("read", 2000), ("bash", 1500)]


def test_budget_top5_cutoff(write_events):
    write_events([_res(f"tool{i}", (10 - i) * 100) for i in range(7)])
    b = budget.compute()
    assert len(b["top"]) == 5
    assert b["top"][0] == ("tool0", 1000)
    assert b["top"][-1] == ("tool4", 600)


def test_budget_empty_session():
    b = budget.compute(events=[], session="test-session")
    assert b["chars"] == 0 and b["tokens_est"] == 0 and b["top"] == []


def test_render_nudge():
    b = budget.compute(events=[], session="test-session")
    text = budget.render(b)
    assert "0 chars" in text and text.rstrip().splitlines()[-1].startswith("Nudge:")
