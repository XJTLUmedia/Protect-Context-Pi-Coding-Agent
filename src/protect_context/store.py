"""Shared on-disk store: .agent-guard/ paths, ensure, serialized JSONL
append/read, config load/merge, and session state (SPEC §2).

All paths resolve against the current working directory at call time, so the
CLI, MCP server and tests can each operate on their own root. The whole
directory is runtime state and gitignored; defaults live in code (defaults.py)
on both the Python and TypeScript sides, pinned identical by tests.
"""

from __future__ import annotations

import errno
import hashlib
import json
import math
import os
import shutil
import socket
import stat
import threading
import time
import unicodedata
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

try:
    import fcntl
except ImportError:  # pragma: no cover — non-POSIX platforms
    fcntl = None  # type: ignore[assignment]

from .defaults import DEFAULT_CONFIG

GUARD_DIR = ".agent-guard"

# Both runtimes acquire this atomic-directory lease before touching a shared
# ledger.  A stale lease is deliberately much older than an ordinary critical
# section; the minimum is public so callers cannot accidentally configure an
# eager live-lock breaker.
STORE_LOCK_MIN_STALE_S = 10.0
STORE_LOCK_STALE_S = 30.0
STORE_LOCK_TIMEOUT_S = 5.0
STORE_LOCK_RETRY_S = 0.025
_LEASE_OWNER = "owner.json"
_LEASE_REAP_PREFIX = ".lock.d.reap."
_LEASE_RENAME_TIMEOUT_S = 1.0
_LEASE_RENAME_RETRY_S = 0.005
_STORE_LOCK_LOCAL = threading.local()

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


def lease_path() -> Path:
    """Path to the cross-runtime atomic-directory store lease."""
    return guard_dir() / ".lock.d"


def ensure() -> Path:
    """Create .agent-guard/ and seed config.json if missing. Idempotent."""
    d = guard_dir()
    d.mkdir(parents=True, exist_ok=True)
    if not config_path().exists():
        # Recheck under the cross-runtime lease: an extension/Python peer may
        # have created an owner-edited config after the optimistic check.
        with store_lock():
            if not config_path().exists():
                write_json(config_path(), DEFAULT_CONFIG)
    return d


def session_id() -> str:
    """Session label: env PC_SESSION_ID, else 'default' (SPEC §2)."""
    return os.environ.get("PC_SESSION_ID") or "default"


def now_ts() -> str:
    """UTC ISO-8601 with milliseconds, identical in shape to JS toISOString."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def display_text(value: object, cap: int = 120) -> str:
    """Bounded one-line rendering for legacy/store/environment values."""
    raw = str(value or "")
    clean = "".join(
        " " if unicodedata.category(char) in {"Cc", "Cf", "Cs"} else char
        for char in raw
    )
    return " ".join(clean.split())[: max(0, int(cap))].strip()


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
        tmp.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
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


def _lease_owner(path: Path) -> dict | None:
    try:
        value = json.loads((path / _LEASE_OWNER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("token"), str)
        or not value["token"]
    ):
        return None
    return value


def _windows_pid_is_live(pid: int) -> bool:
    """Check a Windows PID without ``os.kill(pid, 0)``.

    CPython implements most Windows ``os.kill`` signals with
    ``TerminateProcess``; using signal 0 as a POSIX-style probe can therefore
    terminate the process we are trying to protect. A zero-time wait on a
    synchronization handle is read-only and gives the same liveness answer.
    """
    try:
        import ctypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        open_process = kernel32.OpenProcess
        open_process.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
        open_process.restype = ctypes.c_void_p
        wait_for_single_object = kernel32.WaitForSingleObject
        wait_for_single_object.argtypes = (ctypes.c_void_p, ctypes.c_uint32)
        wait_for_single_object.restype = ctypes.c_uint32
        close_handle = kernel32.CloseHandle
        close_handle.argtypes = (ctypes.c_void_p,)
        close_handle.restype = ctypes.c_int

        synchronize = 0x00100000
        wait_object_0 = 0x00000000
        wait_timeout = 0x00000102
        error_invalid_parameter = 87
        handle = open_process(synchronize, False, pid)
        if not handle:
            # Access denied is conservatively "possibly live"; Windows uses
            # ERROR_INVALID_PARAMETER for a PID that does not exist.
            return ctypes.get_last_error() != error_invalid_parameter
        try:
            result = wait_for_single_object(handle, 0)
            if result == wait_object_0:
                return False
            if result == wait_timeout:
                return True
            return True
        finally:
            close_handle(handle)
    except (AttributeError, OSError, TypeError, ValueError):
        # An unavailable/failed platform probe must not authorize lock theft.
        return True


def _pid_is_live(pid: object) -> bool:
    """Conservatively report whether a same-host lease owner may be live."""
    if (
        isinstance(pid, bool)
        or not isinstance(pid, int)
        or pid <= 0
        or pid > 2_147_483_647
    ):
        return False
    if os.name == "nt":  # pragma: no cover - exercised on Windows
        return _windows_pid_is_live(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        # Unknown platform/permission failures must not authorize lock theft.
        return True
    return True


def _same_host(value: object) -> bool:
    return (
        isinstance(value, str) and value.casefold() == socket.gethostname().casefold()
    )


def _lease_snapshot(path: Path) -> tuple[tuple[int, int], float, dict | None] | None:
    """Read a stable, non-symlink lease snapshot.

    Reading identity before and after owner.json prevents a replacement that
    races the read from being mistaken for the directory we inspected.
    """
    try:
        before = path.lstat()
        if not stat.S_ISDIR(before.st_mode):
            return None
        owner = _lease_owner(path)
        after = path.lstat()
    except OSError:
        return None
    before_id = (before.st_dev, before.st_ino)
    after_id = (after.st_dev, after.st_ino)
    if before_id != after_id or not stat.S_ISDIR(after.st_mode):
        return None
    return after_id, after.st_mtime, owner


def _snapshot_is_stale(
    snapshot: tuple[tuple[int, int], float, dict | None], stale_s: float
) -> bool:
    _, mtime, owner = snapshot
    age_s = time.time() - mtime
    if age_s < stale_s:
        return False
    if owner is None:
        # Covers a process killed between mkdir and owner creation. The
        # minimum stale age makes this tiny initialization window fail closed
        # for an ordinary, merely slow writer.
        return True
    if not _same_host(owner.get("hostname")):
        # There is no safe dependency-free way to prove a foreign-host owner
        # dead. Age alone is not evidence: a legitimate critical section may
        # exceed the lease threshold. Keep the lock rather than steal it.
        return False
    return not _pid_is_live(owner.get("pid"))


def _lease_is_stale(path: Path, stale_s: float) -> bool:
    snapshot = _lease_snapshot(path)
    return snapshot is not None and _snapshot_is_stale(snapshot, stale_s)


def _owner_token(owner: dict | None) -> str | None:
    token = owner.get("token") if owner else None
    return token if isinstance(token, str) and token else None


def _same_snapshot(
    left: tuple[tuple[int, int], float, dict | None],
    right: tuple[tuple[int, int], float, dict | None],
) -> bool:
    return left[0] == right[0] and _owner_token(left[2]) == _owner_token(right[2])


def _reap_claim_path(path: Path, owner: dict | None) -> Path:
    token = _owner_token(owner)
    key = (
        "unowned" if token is None else hashlib.sha256(token.encode()).hexdigest()[:20]
    )
    return path.with_name(f"{_LEASE_REAP_PREFIX}{key}")


def _old_enough_to_reap(path: Path, stale_s: float) -> bool:
    """Cheap hot-path age check that avoids opening owner.json on contention."""
    try:
        value = path.lstat()
    except OSError:
        return False
    return stat.S_ISDIR(value.st_mode) and time.time() - value.st_mtime >= stale_s


def _rename_lease(source: Path, destination: Path) -> None:
    """Rename a lease, retrying transient Windows sharing violations."""
    deadline = time.monotonic() + _LEASE_RENAME_TIMEOUT_S
    while True:
        try:
            source.rename(destination)
            return
        except OSError as exc:
            transient_windows_error = os.name == "nt" and (
                getattr(exc, "winerror", None) in (5, 32, 33)
                or exc.errno in (errno.EACCES, errno.EBUSY, errno.EPERM)
            )
            remaining = deadline - time.monotonic()
            if not transient_windows_error or remaining <= 0:
                raise
            time.sleep(min(_LEASE_RENAME_RETRY_S, remaining))


def _break_stale_lease(path: Path, stale_s: float) -> bool:
    """Atomically quarantine and remove the exact stale directory inspected.

    A token-scoped sibling claim serializes concurrent stale breakers. The
    lease is then re-read under that claim before rename, so a newly acquired
    replacement is never deleted based on an observation of its predecessor.
    """
    if not _old_enough_to_reap(path, stale_s):
        return False
    observed = _lease_snapshot(path)
    if observed is None or not _snapshot_is_stale(observed, stale_s):
        return False
    claim = _reap_claim_path(path, observed[2])
    try:
        claim.mkdir()
    except FileExistsError:
        return False
    except OSError:
        return False

    try:
        current = _lease_snapshot(path)
        if (
            current is None
            or not _same_snapshot(observed, current)
            or not _snapshot_is_stale(current, stale_s)
        ):
            return False

        tomb = path.with_name(f"{path.name}.stale.{os.getpid()}.{uuid.uuid4().hex}")
        try:
            _rename_lease(path, tomb)
        except OSError:
            return False
        moved = _lease_snapshot(tomb)
        if moved is None or not _same_snapshot(current, moved):
            # Defensive fallback for filesystems with surprising rename
            # semantics. Do not delete an object whose identity changed.
            if not path.exists():
                try:
                    _rename_lease(tomb, path)
                except OSError:
                    pass
            return False
        try:
            shutil.rmtree(tomb)
        except OSError:
            # The authoritative name is already free. A unique quarantine
            # directory is safer than restoring a partly removed stale lock.
            pass
        return True
    finally:
        try:
            claim.rmdir()
        except OSError:
            pass


def _lock_number(value: object, default: float, minimum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    if not math.isfinite(number):
        return default
    return max(minimum, number)


def _acquire_lease(
    path: Path, timeout_s: float, stale_s: float, retry_s: float
) -> tuple[Path, str]:
    path.parent.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    timeout_s = _lock_number(timeout_s, STORE_LOCK_TIMEOUT_S, 0.0)
    stale_s = _lock_number(stale_s, STORE_LOCK_STALE_S, STORE_LOCK_MIN_STALE_S)
    retry_s = _lock_number(retry_s, STORE_LOCK_RETRY_S, 0.001)
    deadline = time.monotonic() + timeout_s

    while True:
        try:
            path.mkdir()
        except FileExistsError:
            if _break_stale_lease(path, stale_s):
                continue
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"timed out acquiring store lock {path}")
            time.sleep(min(retry_s, remaining))
            continue

        owner = {
            "token": token,
            "pid": os.getpid(),
            "hostname": socket.gethostname(),
            "created_ms": int(time.time() * 1000),
        }
        try:
            with open(path / _LEASE_OWNER, "x", encoding="utf-8") as owner_file:
                owner_file.write(json.dumps(owner, separators=(",", ":")) + "\n")
        except BaseException:
            try:
                shutil.rmtree(path)
            except OSError:
                pass
            raise
        return path, token


def _release_lease(path: Path, token: str) -> None:
    observed = _lease_snapshot(path)
    if observed is None or _owner_token(observed[2]) != token:
        raise RuntimeError(f"store lock ownership changed before release: {path}")
    tomb = path.with_name(f"{path.name}.release.{os.getpid()}.{uuid.uuid4().hex}")
    try:
        _rename_lease(path, tomb)
    except OSError as exc:
        raise RuntimeError(f"could not release store lock {path}") from exc
    moved = _lease_snapshot(tomb)
    if moved is None or not _same_snapshot(observed, moved):
        if not path.exists():
            try:
                _rename_lease(tomb, path)
            except OSError:
                pass
        raise RuntimeError(f"store lock ownership changed before release: {path}")
    try:
        shutil.rmtree(tomb)
    except OSError as exc:
        # The lock name was atomically freed; report the quarantine cleanup
        # error without risking removal of a subsequent owner's directory.
        raise RuntimeError(f"could not clean released store lock {tomb}") from exc


def _held_leases() -> dict[str, int]:
    current_pid = os.getpid()
    if getattr(_STORE_LOCK_LOCAL, "pid", None) != current_pid:
        # A fork inherits thread-local Python objects but not ownership of the
        # parent process's lease. Drop the copied reentrancy state so the child
        # contends normally instead of entering the critical section unlocked.
        _STORE_LOCK_LOCAL.pid = current_pid
        _STORE_LOCK_LOCAL.held = {}
    held = getattr(_STORE_LOCK_LOCAL, "held", None)
    if held is None:
        held = {}
        _STORE_LOCK_LOCAL.held = held
    return held


@contextmanager
def store_lock(
    *,
    timeout_s: float = STORE_LOCK_TIMEOUT_S,
    stale_s: float = STORE_LOCK_STALE_S,
    retry_s: float = STORE_LOCK_RETRY_S,
) -> Iterator[None]:
    """Hold the shared cross-runtime store lock.

    This public context manager is suitable for read-modify-write operations.
    The legacy ``.lock`` flock is retained inside the directory lease for
    compatibility, but the directory lease is the cross-runtime authority.
    Acquisition either succeeds or raises ``TimeoutError``; it never runs the
    protected code unlocked.
    """
    directory = guard_dir()
    directory.mkdir(parents=True, exist_ok=True)
    path = (directory / ".lock.d").resolve()
    key = os.path.normcase(str(path))
    held = _held_leases()
    if key in held:
        held[key] += 1
        try:
            yield
        finally:
            held[key] -= 1
        return

    path, token = _acquire_lease(path, timeout_s, stale_s, retry_s)
    held[key] = 1
    try:
        with _open_lock(path.parent) as lf, _exclusive_flock(lf):
            yield
    finally:
        held.pop(key, None)
        _release_lease(path, token)


def _append_unlocked(path: Path, entry: dict) -> None:
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _open_lock(directory: Path | None = None):
    directory = guard_dir() if directory is None else directory
    directory.mkdir(parents=True, exist_ok=True)  # lock file lives here
    return open(directory / ".lock", "a+", encoding="utf-8")


def append_jsonl(path: Path, entry: dict) -> dict:
    """Append one JSON line under the shared cross-runtime store lock."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with store_lock():
        _append_unlocked(path, entry)
    return entry


def locked_append(path: Path, factory: Callable[[], dict]) -> dict:
    """Compute + append an entry inside ONE locked critical section.

    The factory (typically reading `path` to allocate a sequential id) runs
    under the same cross-runtime lease as the append, so concurrent writers
    can never read the same max id and emit duplicates. Returns the computed
    entry."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with store_lock():
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
