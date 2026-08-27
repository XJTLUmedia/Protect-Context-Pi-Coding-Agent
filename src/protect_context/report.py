"""guard_status dashboard (SPEC §4): session, Δdiff, loop streaks, evidence
count, contract size, last verify — compact, ends with an actionable Nudge.
"""

from __future__ import annotations

from . import contract, diffscope, loops, orientation, store, verify


def status() -> tuple[str, int]:
    """Returns (dashboard_text, warning_level) where level is 0 or 1."""
    store.ensure()
    cfg = store.load_config()
    sid = store.session_id()

    head = diffscope.git_head()
    lines = [f"PC status · session {sid} · git {head or 'no repo'}"]

    hard = warn = False
    d = diffscope.diff_audit(cfg=cfg)
    if "error" in d:
        lines.append("Δdiff n/a (not a git repo)")
    else:
        lines.append(
            f"Δdiff +{d['added']}/-{d['deleted']} · {d['files']} files · verdict {d['verdict']}"
        )
        hard = d["verdict"] == "hard"
        warn = d["verdict"] == "warn"

    streak_list = loops.streaks(session=sid)
    blocked = bool(loops.would_block(streak_list, cfg))
    if streak_list:
        lines.append("loops: " + ", ".join(f"{s['cmd'][:40]} ×{s['count']}" for s in streak_list[:3]))
    else:
        lines.append("loops: none")

    runs = verify.recent(1, session=sid)
    if runs:
        r = runs[0]
        lines.append(f"evidence {verify.count(session=sid)} · last {r['id']} exit {r['exit']}")
    else:
        lines.append(f"evidence {verify.count(session=sid)} · last none")

    lines.append(f"contract {len(contract.load())} constraints")
    # Goal #4: conventions files are the first thing to read in an unfamiliar
    # repo — surface them on every dashboard (cheap: root stat calls only).
    conv = orientation.conventions()
    lines.append("conventions: " + (", ".join(conv) if conv else "none found"))

    if hard:
        nudge = f"Nudge: diff ≥ {cfg['diff_hard_lines']} lines — stop and split the change."
    elif blocked:
        nudge = "Nudge: identical failing command at the block threshold — change approach, do not re-run."
    elif warn:
        nudge = f"Nudge: diff ≥ {cfg['diff_warn_lines']} lines — split it before it grows."
    else:
        nudge = "Nudge: verify changes with guard_verify and cite the evidence id before claiming success."
    lines.append(nudge)
    return "\n".join(lines), (1 if (hard or blocked) else 0)
