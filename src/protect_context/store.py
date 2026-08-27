"""Shared on-disk store: .agent-guard/ paths, ensure, JSONL append/read with a
best-effort flock, config load/merge, and session state (SPEC §2).

All paths resolve against the current working directory at call time, so the
CLI, MCP server and tests can each operate on their own root. The whole
directory is runtime state and gitignored; defaults live in code (defaults.py)
on both the Python and TypeScript sides, pinned identical by tests.
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Callable
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

try:
    import fcntl
except ImportError:  # pragma: no cover — non-POSIX platforms
    fcntl = None  # type: ignore[assignment]

from .defaults import DEFAULT_CONFIG

GUARD_DIR = ".agent-guard"

JOURNAL_TYPES = ("decision", "correction", "risk", "note")
EVENT_KINDS = ("tool_call", "tool_result")

DEFAULT_STATE: dict = {
    "current_session": {"id": None, "started": None, "git_head": None},
    "brief_digest": "",
    "notify_watermarks": {"ctx_pct": 0, "diff_lines": 0, "diff_files": 0},
    "counters": {},
}


def guard_dir() -> Path:
    return Path.cwd() / GUARD_DIR


def config_path() -> Path:
    return guard_dir() / "config.json"


def contract_path() -> Path:
    return guard_dir() / "contract.json"


def journal_path() -> Path:
    return guard_dir() / "journal.jsonl"


def events_path() -> Path:
    return guard_dir() / "events.jsonl"


def verify_path() -> Path:
    return guard_dir() / "verify_runs.jsonl"


def state_path() -> Path:
    return guard_dir() / "state.json"


def lock_path() -> Path:
    return guard_dir() / ".lock"


def ensure() -> Path:
    """Create .agent-guard/ and seed config.json if missing. Idempotent."""
    d = guard_dir()
    d.mkdir(parents=True, exist_ok=True)
    if not config_path().exists():
        write_json(config_path(), DEFAULT_CONFIG)
    return d


def session_id() -> str:
    """Session label: env PC_SESSION_ID, else 'default' (SPEC §2)."""
    return os.environ.get("PC_SESSION_ID") or "default"


def now_ts() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fingerprint(cmd: str) -> str:
    """Command fingerprint: trim + collapse whitespace runs to single spaces.
    Nothing else (SPEC §2)."""
    return " ".join(cmd.split())


def write_json(path: Path, data: object) -> None:
    """Atomic-enough JSON write (unique tmp + replace). A per-write tmp name
    keeps concurrent writers (threads/processes sharing the store) from
    clobbering each other's tmp file mid-replace."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        tmp.replace(path)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def read_json(path: Path):
    """Read JSON; return None on any error (missing or corrupt = best-effort)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


@contextmanager
def _exclusive_flock(lf) -> Iterator[None]:
    """Hold a best-effort exclusive flock on an already-open lock file."""
    locked = False
    if fcntl is not None:
        try:
            fcntl.flock(lf.fileno(), fcntl.LOCK_EX)
            locked = True
        except OSError:
            locked = False
    try:
        yield
    finally:
        if locked:
            try:
                fcntl.flock(lf.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass


def _append_unlocked(path: Path, entry: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _open_lock():
    guard_dir().mkdir(parents=True, exist_ok=True)  # lock file lives here
    return open(lock_path(), "a+", encoding="utf-8")


def append_jsonl(path: Path, entry: dict) -> dict:
    """Append one JSON line under a best-effort exclusive flock on
    .agent-guard/.lock (SPEC §2: both implementations lock the same file)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _open_lock() as lf, _exclusive_flock(lf):
        _append_unlocked(path, entry)
    return entry


def locked_append(path: Path, factory: Callable[[], dict]) -> dict:
    """Compute + append an entry inside ONE locked critical section.

    The factory (typically reading `path` to allocate a sequential id) runs
    under the same flock as the append, so concurrent writers can never read
    the same max id and emit duplicates. Returns the computed entry."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with _open_lock() as lf, _exclusive_flock(lf):
        entry = factory()
        _append_unlocked(path, entry)
    return entry


def read_jsonl(path: Path) -> list[dict]:
    """Read a JSONL file; blank/malformed lines are skipped (best-effort)."""
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _valid_config_value(key: str, val: object) -> bool:
    """Type/range validation for a known config key, mirroring the
    TypeScript mergeConfig() checks: wrong-typed or out-of-range values fall
    back to the default instead of crashing verdicts later."""
    default = DEFAULT_CONFIG[key]
    if isinstance(default, bool):
        return isinstance(val, bool)
    if isinstance(default, int):
        # bool is an int subclass; reject it explicitly.
        if isinstance(val, bool) or not isinstance(val, int):
            return False
        if key == "loop_block_after":
            return val >= 1
        if key == "ctx_warn_pct":
            return 0 <= val <= 100
        return val >= 0
    if isinstance(default, list):
        return isinstance(val, list) and all(isinstance(v, str) for v in val)
    if key == "brief_mode":
        return val in ("changed", "always")
    return isinstance(val, str)


def load_config() -> dict:
    """Load config.json merged over DEFAULT_CONFIG (known keys only; corrupt,
    missing, or wrong-typed values fall back to defaults)."""
    ensure()
    cfg = dict(DEFAULT_CONFIG)
    data = read_json(config_path())
    if isinstance(data, dict):
        for key in DEFAULT_CONFIG:
            if key in data and _valid_config_value(key, data[key]):
                cfg[key] = data[key]
    return cfg


def load_state() -> dict:
    """Load state.json merged over DEFAULT_STATE (deep-copied defaults)."""
    st = json.loads(json.dumps(DEFAULT_STATE))
    data = read_json(state_path())
    if isinstance(data, dict):
        for key, val in data.items():
            st[key] = val
    return st


def save_state(state: dict) -> None:
    ensure()
    write_json(state_path(), state)
