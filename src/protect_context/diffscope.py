"""Git diff analysis: numstat parsing + verdicts vs configured thresholds
(SPEC §1 #3, #8). Verdicts: ok < warn (400 lines / 10 files) < hard (800 lines).
"""

from __future__ import annotations

import subprocess

from . import store


class DiffError(RuntimeError):
    """git could not run or refused (e.g. not a repository)."""


def _git(args: list[str]) -> str:
    try:
        r = subprocess.run(["git", *args], capture_output=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired) as e:  # pragma: no cover — rare
        raise DiffError(f"git failed: {e}") from e
    if r.returncode != 0:
        msg = r.stderr.decode("utf-8", errors="replace").strip()
        raise DiffError(msg or f"git {' '.join(args)} failed (exit {r.returncode})")
    return r.stdout.decode("utf-8", errors="replace")


def git_head(short: bool = True) -> str | None:
    """Current HEAD sha (short), or None outside a repository / on empty repo."""
    args = ["rev-parse"] + (["--short"] if short else []) + ["HEAD"]
    try:
        return _git(args).strip() or None
    except DiffError:
        return None


def parse_numstat(text: str) -> list[dict]:
    """Parse `git diff --numstat` output. Lines: 'add\\tdel\\tpath' where '-'
    marks binary (counted as 0 lines, still 1 file). Rename paths keep their
    '{old => new}' form verbatim."""
    rows: list[dict] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        a, d, path = parts
        binary = a == "-" or d == "-"
        rows.append({
            "add": 0 if a == "-" else _int(a),
            "del": 0 if d == "-" else _int(d),
            "path": path,
            "binary": binary,
        })
    return rows


def _int(s: str) -> int:
    try:
        return int(s)
    except ValueError:
        return 0


def stats(rows: list[dict]) -> dict:
    return {"files": len(rows), "lines": sum(r["add"] + r["del"] for r in rows)}


def verdict(st: dict, cfg: dict) -> str:
    """ok | warn | hard. hard wins over warn; files-only overflow is warn."""
    if st["lines"] >= cfg["diff_hard_lines"]:
        return "hard"
    if st["lines"] >= cfg["diff_warn_lines"] or st["files"] >= cfg["diff_warn_files"]:
        return "warn"
    return "ok"


def diff_audit(baseline: str | None = None, cfg: dict | None = None) -> dict:
    """Diff working tree vs baseline (default HEAD); returns stats + verdict,
    or {"error": ...} if git fails (never raises to callers)."""
    cfg = cfg if cfg is not None else store.load_config()
    ref = baseline or "HEAD"
    try:
        rows = parse_numstat(_git(["diff", "--numstat", ref]))
    except DiffError as e:
        return {"error": e.args[0]}
    st = stats(rows)
    st.update({
        "added": sum(r["add"] for r in rows),
        "deleted": sum(r["del"] for r in rows),
        "baseline": ref,
        "verdict": verdict(st, cfg),
        "warn_lines": cfg["diff_warn_lines"],
        "warn_files": cfg["diff_warn_files"],
        "hard_lines": cfg["diff_hard_lines"],
    })
    return st


def render(st: dict) -> str:
    if "error" in st:
        return f"PC diff · error: {st['error']}\nNudge: run inside a git repository, or pass an explicit baseline ref."
    advice = {
        "ok": "Nudge: diff is within budget — keep unrelated changes out.",
        "warn": f"Nudge: ≥ {st['warn_lines']} changed lines or ≥ {st['warn_files']} files — split the change into logical steps.",
        "hard": f"Nudge: ≥ {st['hard_lines']} changed lines — stop and split; large diffs are unreviewable.",
    }[st["verdict"]]
    return (
        f"PC diff · vs {st['baseline']} · +{st['added']}/-{st['deleted']} · "
        f"{st['files']} files · verdict {st['verdict']}\n{advice}"
    )
