"""Shared fixtures: every test runs in a temp cwd so .agent-guard is created
in a temp dir (SPEC §7), with a deterministic session id."""

import pytest

from protect_context import store


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PC_SESSION_ID", "test-session")
    yield


@pytest.fixture
def write_events():
    """Write events.jsonl entries (already in TS-extension normalized shape)."""

    def _write(events, session="test-session"):
        rows = []
        for e in events:
            row = {
                "ts": "2026-08-28T10:00:00Z",
                "session": e.get("session", session),
                "kind": e["kind"],
                "tool": e.get("tool", "bash"),
                "ok": e.get("ok"),
                "ms": e.get("ms"),
                "out_chars": e.get("out_chars"),
                "cmd": e.get("cmd"),
                "exit": e.get("exit"),
            }
            rows.append(row)
        p = store.events_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text("".join(_j(r) + "\n" for r in rows), encoding="utf-8")
        return rows

    return _write


def _j(obj):
    import json

    return json.dumps(obj)
