"""guard_preflight: tool presence/versions + git repo check (SPEC §1 #10).
Reduces mid-task discovery of environment problems. No network, no LLM.
"""

from __future__ import annotations

import shutil
import subprocess


def _version(tool: str) -> str | None:
    """First line of `<tool> --version`, best-effort; None on any failure."""
    try:
        r = subprocess.run([tool, "--version"], capture_output=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (r.stdout + r.stderr).decode("utf-8", errors="replace").strip()
    if not text:
        return None
    first = text.splitlines()[0].strip()
    # normalize "git version 2.43.0" → "2.43.0"
    first = first.replace("version ", "", 1)
    return first[:60] or None


def in_git_repo() -> bool:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"], capture_output=True, timeout=10
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return r.returncode == 0 and r.stdout.decode().strip() == "true"


def run_preflight(cfg: dict | None = None) -> dict:
    cfg = cfg if cfg is not None else _load_config()
    tools = []
    for t in cfg.get("preflight_tools", []):
        present = shutil.which(t) is not None
        tools.append({"tool": t, "present": present, "version": _version(t) if present else None})
    missing = [t["tool"] for t in tools if not t["present"]]
    return {"tools": tools, "git_repo": in_git_repo(), "missing": missing}


def _load_config() -> dict:
    from . import store  # local import keeps module importable without cwd side effects

    return store.load_config()


def render(res: dict) -> str:
    lines = [f"PC preflight · git repo: {'yes' if res['git_repo'] else 'NO'}"]
    present = [t for t in res["tools"] if t["present"]]
    if present:
        lines.append(" · ".join(f"{t['tool']} {t['version']}".strip() for t in present))
    if res["missing"]:
        lines.append("missing: " + ", ".join(res["missing"]))
        lines.append("Nudge: install the missing tools before debugging code — this is an environment problem.")
    else:
        lines.append("missing: none")
        lines.append("Nudge: environment looks sane — investigate code, not the sandbox.")
    return "\n".join(lines)
