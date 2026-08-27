"""CLI: `python -m protect_context <verb>` — same verbs as the MCP tools; the
test harness and the no-MCP fallback (SPEC §3).

Exit codes: 0 ok · 1 warning triggered · 2 error.
Every output ends with a one-line actionable "Nudge:".
"""

from __future__ import annotations

import argparse

from . import (
    budget,
    contract,
    diffscope,
    journal,
    loops,
    orientation,
    preflight,
    report,
    store,
    verify,
)

NUDGE_ERROR = "Nudge: fix the error above and re-run; thresholds live in .agent-guard/config.json."


def _tags(raw: str) -> list[str]:
    return [t.strip() for t in (raw or "").split(",") if t.strip()]


def cmd_init(args: argparse.Namespace) -> int:
    store.ensure()
    cons = contract.load()  # seeds contract.json on first use
    st = store.load_state()
    st["current_session"] = {
        "id": store.session_id(),
        "started": store.now_ts(),
        "git_head": diffscope.git_head(),
    }
    store.save_state(st)
    print(f"PC store ready · {store.guard_dir()}")
    print(
        f"config {len(store.load_config())} keys · contract {len(cons)} constraints · "
        f"session {store.session_id()}"
    )
    # Goal #4: the orientation digest (repo tree, languages, conventions
    # files) ships with init so the CLI surface can orient a fresh session.
    # The digest's own trailing Nudge is dropped — init's Nudge closes the
    # output (every CLI output ends with exactly one Nudge line).
    print("\n".join(orientation.digest().splitlines()[:-1]))
    print("Nudge: thresholds live in .agent-guard/config.json — tune them any time.")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    text, level = report.status()
    print(text)
    return level


def cmd_verify(args: argparse.Namespace) -> int:
    entry = verify.run_verify(args.command, args.timeout_s)
    print(verify.render_entry(entry))
    return 0 if entry["ok"] else 1


def cmd_evidence(args: argparse.Namespace) -> int:
    runs = verify.recent(args.limit)
    print(verify.render_recent(runs, verify.count()))
    return 0


def cmd_contract(args: argparse.Namespace) -> int:
    if args.action == "list":
        print(contract.render(contract.load()))
        print("Nudge: honor these constraints; they are re-injected whenever they change.")
        return 0
    if args.action == "add":
        c, cons = contract.add(args.text)
        if c is None:
            print(f"contract: identical constraint already present ({len(cons)} total)")
            print("Nudge: reuse the existing constraint instead of duplicating it.")
            return 0
        print(f"added {c['id']}")
        print(contract.render(cons))
        warn = contract.brief_cap_warning(len(cons))
        if warn:
            print(warn)
        print("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
        return 0
    if args.action == "remove":
        if contract.remove(args.id):
            print(f"removed {args.id}")
            print(contract.render(contract.load()))
            print("Nudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
            return 0
        print(f"no constraint with id {args.id!r}")
        print("Nudge: run 'contract list' to see current ids.")
        return 2
    print(NUDGE_ERROR)
    return 2


def cmd_note(args: argparse.Namespace) -> int:
    try:
        entry = journal.add(args.type, args.text, _tags(args.tags))
    except ValueError as e:
        print(f"PC error: {e}")
        print(NUDGE_ERROR)
        return 2
    print(journal.render_ack(entry, journal.count()))
    return 0


def cmd_loops(args: argparse.Namespace) -> int:
    cfg = store.load_config()
    streak_list = loops.streaks()
    print(loops.render(streak_list, cfg))
    return 1 if loops.would_block(streak_list, cfg) else 0


def cmd_diff(args: argparse.Namespace) -> int:
    st = diffscope.diff_audit(args.baseline)
    print(diffscope.render(st))
    if "error" in st:
        return 2
    return 0 if st["verdict"] == "ok" else 1


def cmd_preflight(args: argparse.Namespace) -> int:
    res = preflight.run_preflight()
    print(preflight.render(res))
    return 1 if res["missing"] else 0


def cmd_budget(args: argparse.Namespace) -> int:
    print(budget.render(budget.compute()))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="protect_context",
        description="protect-context guardrail CLI (advisory-first; no network, no LLM)",
    )
    sub = p.add_subparsers(dest="verb", required=True)

    sp = sub.add_parser("init", help="create .agent-guard/ with default config + seed contract")
    sp.set_defaults(func=cmd_init)

    sp = sub.add_parser("status", help="compact status dashboard")
    sp.set_defaults(func=cmd_status)

    sp = sub.add_parser("verify", help="run CMD and record evidence (shell verbatim)")
    sp.add_argument("command")
    sp.add_argument("--timeout", dest="timeout_s", type=int, default=180)
    sp.set_defaults(func=cmd_verify)

    sp = sub.add_parser("evidence", help="recent verify runs")
    sp.add_argument("--limit", type=int, default=5)
    sp.set_defaults(func=cmd_evidence)

    sp = sub.add_parser("contract", help="contract store: list | add TEXT | remove ID")
    csub = sp.add_subparsers(dest="action", required=True)
    csub.add_parser("list")
    a = csub.add_parser("add")
    a.add_argument("text")
    r = csub.add_parser("remove")
    r.add_argument("id")
    sp.set_defaults(func=cmd_contract)

    sp = sub.add_parser("note", help="journal entry: decision|correction|risk|note TEXT")
    sp.add_argument("type", choices=list(store.JOURNAL_TYPES))
    sp.add_argument("text")
    sp.add_argument("--tags", default="", help="comma-separated tags")
    sp.set_defaults(func=cmd_note)

    sp = sub.add_parser("loops", help="failing-command streaks")
    sp.set_defaults(func=cmd_loops)

    sp = sub.add_parser("diff", help="diff audit vs HEAD (or --baseline ref)")
    sp.add_argument("--baseline", default=None)
    sp.set_defaults(func=cmd_diff)

    sp = sub.add_parser("preflight", help="tool presence/versions + git repo check")
    sp.set_defaults(func=cmd_preflight)

    sp = sub.add_parser("budget", help="session tool-output budget")
    sp.set_defaults(func=cmd_budget)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:  # pragma: no cover
        print(NUDGE_ERROR)
        return 2
    except Exception as e:  # CLI boundary: report compactly, never crash ugly
        print(f"PC error: {e}")
        print(NUDGE_ERROR)
        return 2
