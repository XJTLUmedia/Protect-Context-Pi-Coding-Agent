"""Evidence ledger: guard_verify runs a command and RECORDS the outcome
(SPEC §1 #2, §4). Failures are never raised — they are recorded; that is the
point.

shell=True is BY DESIGN (SPEC §4): the command is stored and executed verbatim
as the agent issued it (pipes, env prefixes, shell builtins) with the caller's
own privileges. This tool adds evidence, not sandboxing — it must behave
exactly like the agent running the command itself.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import time

from . import journal, store

DIGEST_MAX = 2000  # last ≤2000 chars of combined stdout+stderr (SPEC §2)
TIMEOUT_EXIT = 124  # GNU timeout convention for recorded timeouts
TIMEOUT_MIN_S = 1
TIMEOUT_MAX_S = 900  # upper clamp: no single guard_verify call can wedge a session

# Deny-confirm risk patterns (SPEC §5 list, anchored to exact targets).
# guard_verify consults them to LOG (never block — advisory-first): running a
# risky command through the evidence ledger gets journaled as a risk entry.
# Anchoring matches the extension's fingerprint.ts: benign commands (man
# pages, greps, rmmod, absolute-path rm -rf) must not match.
RISK_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("rm -rf /", re.compile(r"rm -rf /(?:\s|$)")),
    ("rm -rf ~", re.compile(r"rm -rf ~(?:/(?:\s|$)|\s|$)")),
    ("git push --force", re.compile(r"git push\b[^|;&]*--force(?!-with-lease)")),
    ("git reset --hard", re.compile(r"git reset --hard")),
    ("mkfs", re.compile(r"\bmkfs[^|;&]*/dev/")),
    ("dd of=/dev/", re.compile(r"\bdd\b[^|;&]*\bof=/dev/")),
    ("chmod -R 777 /", re.compile(r"chmod -R 777 /(?:\s|$)")),
    ("curl | sh", re.compile(r"curl\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b")),
    ("sudo rm", re.compile(r"\bsudo\s+rm(?:\s|$)")),
]


def match_risk(command: str) -> str | None:
    """Return the matched risk-pattern name, or None (mirrors the extension)."""
    cmd = store.fingerprint(command)
    for name, pattern in RISK_PATTERNS:
        if pattern.search(cmd):
            return name
    return None


def _next_id(runs: list[dict]) -> str:
    mx = 0
    for r in runs:
        rid = str(r.get("id", ""))
        if rid.startswith("ev-"):
            try:
                mx = max(mx, int(rid[3:]))
            except ValueError:
                pass
    return f"ev-{mx + 1:04d}"


def _clamp_timeout(timeout_s: int) -> int:
    try:
        t = int(timeout_s)
    except (TypeError, ValueError):
        return 180
    return max(TIMEOUT_MIN_S, min(TIMEOUT_MAX_S, t))


def run_verify(command: str, timeout_s: int = 180) -> dict:
    """Run `command` via the shell and append it to verify_runs.jsonl. NEVER
    raises on nonzero exit — records it. A timeout is recorded as exit 124
    with ok=False.

    timeout_s is clamped to [TIMEOUT_MIN_S, TIMEOUT_MAX_S] so a model-supplied
    value cannot wedge the session. The child starts in its own process group
    (start_new_session) and the WHOLE group is SIGKILLed on timeout, so
    grandchildren holding the stdout/stderr pipes cannot hang the drain — the
    evidence entry is always written.
    """
    timeout_s = _clamp_timeout(timeout_s)
    t0 = time.monotonic()
    timed_out = False
    p = subprocess.Popen(
        command,
        shell=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out_b, err_b = p.communicate(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            p.kill()  # best-effort fallback if the group vanished
        out_b, err_b = p.communicate()  # drains pipes; returns after the kill
    out = (out_b or b"").decode("utf-8", errors="replace")
    err = (err_b or b"").decode("utf-8", errors="replace")
    exit_code = TIMEOUT_EXIT if timed_out else p.returncode
    ok = exit_code == 0 and not timed_out
    combined = out + err
    if timed_out:
        combined += f"\n[guard_verify: timeout after {timeout_s}s]"

    risk = match_risk(command)
    if risk:
        # Advisory-first: risky verify commands are logged for the owner, never blocked.
        try:
            journal.add("risk", f"guard_verify ran a command matching risk pattern '{risk}': {command}")
        except Exception:  # journal is best-effort; never block the evidence write
            pass

    def _make_entry() -> dict:
        # Id allocation happens inside the flock (store.locked_append) so two
        # concurrent guard_verify calls can never read the same max id.
        return {
            "id": _next_id(store.read_jsonl(store.verify_path())),
            "ts": store.now_ts(),
            "session": store.session_id(),
            "cmd": command,
            "exit": exit_code,
            "ok": ok,
            "digest": combined[-DIGEST_MAX:],
            "ms": int((time.monotonic() - t0) * 1000),
        }

    return store.locked_append(store.verify_path(), _make_entry)


def _scoped(runs: list[dict], session: str | None) -> list[dict]:
    if session is None:
        return runs
    return [r for r in runs if r.get("session") == session]


def recent(limit: int = 5, session: str | None = None) -> list[dict]:
    """Recent runs, oldest first. session=None → the whole ledger; a session
    label scopes to that session's runs (parity with the extension, which
    counts evidence per session)."""
    runs = _scoped(store.read_jsonl(store.verify_path()), session)
    if limit <= 0:
        return []
    return runs[-limit:]


def count(session: str | None = None) -> int:
    """Number of recorded runs; session=None → whole ledger."""
    return len(_scoped(store.read_jsonl(store.verify_path()), session))


def _tail_line(digest: str, width: int = 120) -> str:
    """Last non-blank digest line, truncated. Failure diagnostics (pytest
    summaries, compiler errors) live at the END of output — and the digest
    rule is "last ≤2000 chars" — so the failure preview must show the tail,
    not the head, or it is spent on banners."""
    lines = [ln.strip() for ln in digest.splitlines() if ln.strip()]
    return lines[-1][:width] if lines else "(no output)"


def render_entry(entry: dict) -> str:
    """Compact single-run view (ends with Nudge)."""
    status = "ok" if entry["ok"] else "FAIL"
    if entry["ok"]:
        first_line = next((ln for ln in entry["digest"].splitlines() if ln.strip()), "(no output)")
        preview = first_line[:120]
    else:
        preview = _tail_line(entry["digest"])
    nudge = (
        "Nudge: cite this evidence id when claiming success."
        if entry["ok"]
        else "Nudge: read the digest, fix the cause, then re-verify — do not claim success."
    )
    return f"PC verify {entry['id']} · exit {entry['exit']} · {status} · {entry['ms']}ms\ndigest: {preview}\n{nudge}"


def render_recent(runs: list[dict], total: int) -> str:
    """Compact ledger view (ends with Nudge)."""
    lines = [f"PC evidence · last {len(runs)} of {total}"]
    for r in runs:
        cmd = (r.get("cmd") or "")[:60]
        lines.append(f"{r.get('id')} exit {r.get('exit')} · {r.get('ms')}ms · {cmd}")
    lines.append("Nudge: cite evidence ids, not memory, when claiming success.")
    return "\n".join(lines)
