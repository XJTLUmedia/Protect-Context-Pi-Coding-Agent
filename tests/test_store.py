"""Store roundtrip + flock; config load/merge; state; fingerprint (SPEC §7)."""

import json
import threading

from protect_context import store
from protect_context.defaults import DEFAULT_CONFIG

EXPECTED_CONFIG = {
    "loop_block_after": 3,
    "diff_warn_lines": 400,
    "diff_hard_lines": 800,
    "diff_warn_files": 10,
    "ctx_warn_pct": 70,
    "brief_mode": "changed",
    "risk_confirm": True,
    "preflight_tools": ["git", "python3", "pip", "node", "npm", "rg", "pytest"],
}


def test_default_config_matches_spec_exactly():
    assert DEFAULT_CONFIG == EXPECTED_CONFIG


def test_jsonl_roundtrip(tmp_path):
    p = tmp_path / "x.jsonl"
    store.append_jsonl(p, {"a": 1})
    store.append_jsonl(p, {"b": "two", "tags": []})
    assert store.read_jsonl(p) == [{"a": 1}, {"b": "two", "tags": []}]


def test_read_jsonl_skips_malformed(tmp_path):
    p = tmp_path / "x.jsonl"
    p.write_text('{"ok": 1}\nNOT JSON\n\n{"ok": 2}\n', encoding="utf-8")
    assert store.read_jsonl(p) == [{"ok": 1}, {"ok": 2}]


def test_read_jsonl_missing_file(tmp_path):
    assert store.read_jsonl(tmp_path / "nope.jsonl") == []


def test_flock_concurrent_appends_integrity(tmp_path):
    """Many threads appending concurrently → every line intact (flock works)."""
    p = tmp_path / "conc.jsonl"

    def worker(i):
        for j in range(25):
            store.append_jsonl(p, {"w": i, "j": j})

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    rows = store.read_jsonl(p)
    assert len(rows) == 200
    assert all(isinstance(r, dict) and "w" in r and "j" in r for r in rows)


def test_ensure_seeds_config_and_idempotent():
    d = store.ensure()
    assert (d / "config.json").exists()
    assert json.loads((d / "config.json").read_text(encoding="utf-8")) == EXPECTED_CONFIG
    store.ensure()  # second call must not clobber
    assert json.loads((d / "config.json").read_text(encoding="utf-8")) == EXPECTED_CONFIG


def test_config_load_merge_defaults_and_override():
    store.ensure()
    assert store.load_config() == EXPECTED_CONFIG
    store.write_json(store.config_path(), {"loop_block_after": 5, "bogus_key": 1})
    cfg = store.load_config()
    assert cfg["loop_block_after"] == 5  # file overrides default
    assert cfg["diff_warn_lines"] == 400  # defaults preserved
    assert "bogus_key" not in cfg  # unknown keys ignored


def test_state_roundtrip():
    st = store.load_state()
    assert st == store.DEFAULT_STATE
    st["brief_digest"] = "abc123"
    st["counters"]["x"] = 1
    st["notify_watermarks"]["ctx_pct"] = 80
    store.save_state(st)
    loaded = store.load_state()
    assert loaded["brief_digest"] == "abc123"
    assert loaded["counters"] == {"x": 1}
    assert loaded["notify_watermarks"]["ctx_pct"] == 80


def test_fingerprint_trim_and_collapse_only():
    assert store.fingerprint("  ls   -la\n") == "ls -la"
    assert store.fingerprint("pytest\t-q   -x") == "pytest -q -x"
    assert store.fingerprint("pytest -q") == "pytest -q"
    assert store.fingerprint("") == ""


def test_session_id_env_default(monkeypatch):
    monkeypatch.setenv("PC_SESSION_ID", "s-42")
    assert store.session_id() == "s-42"
    monkeypatch.delenv("PC_SESSION_ID", raising=False)
    assert store.session_id() == "default"


def test_locked_append_builds_inside_critical_section(tmp_path):
    """locked_append runs the factory under the same flock as the append, so
    id allocation cannot race between writers (SPEC §2, §7)."""
    p = tmp_path / "ids.jsonl"

    def build():
        return {"n": len(store.read_jsonl(p)) + 1}

    for _ in range(3):
        entry = store.locked_append(p, build)
        assert set(entry) == {"n"}
    assert store.read_jsonl(p) == [{"n": 1}, {"n": 2}, {"n": 3}]
