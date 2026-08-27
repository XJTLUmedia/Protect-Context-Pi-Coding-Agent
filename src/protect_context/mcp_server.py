"""protect-context MCP server — the explicit/portable guardrail layer
(SPEC §4). Same on-disk store as the pi extension and the CLI
(.agent-guard/ in the server's working directory).

Run: python -m protect_context.mcp_server   (stdio transport)

Hosts configure it via a standard .mcp.json, e.g.:

    {"mcpServers": {"protect-context": {
        "command": "/abs/path/.venv/bin/python",
        "args": ["-m", "protect_context.mcp_server"]}}}

All 9 tools return compact text; the last line is always an actionable Nudge.
"""

from __future__ import annotations

from fastmcp import FastMCP

from . import (
    budget,
    contract,
    diffscope,
    journal,
    loops,
    preflight,
    report,
    store,
    verify,
)

mcp = FastMCP("protect-context")


@mcp.tool
def guard_status() -> str:
    """Dashboard: session, diff delta, loop streaks, evidence count, contract size, last verify."""
    text, _level = report.status()
    return text


@mcp.tool
def guard_verify(command: str, timeout_s: int = 180) -> str:
    """Run a command and RECORD the outcome as evidence (id, exit, digest) in
    verify_runs.jsonl. shell=True is by design: the command runs verbatim with
    the caller's own privileges — this is an evidence ledger, not a sandbox.
    Never raises on nonzero exit; failures are recorded (that is the point).
    timeout_s is clamped to [1, 900] so a runaway value cannot wedge the host.
    """
    return verify.render_entry(verify.run_verify(command, timeout_s))


@mcp.tool
def guard_evidence(limit: int = 5) -> str:
    """Recent verification runs from the evidence ledger."""
    return verify.render_recent(verify.recent(limit), verify.count())


@mcp.tool
def guard_contract(action: str, text: str | None = None, id: str | None = None) -> str:
    """Contract store: action="list" | "add" (with text) | "remove" (with id).
    Seed constraints (source="seed") cannot be removed by the model — the owner
    removes them via the CLI or /guard-contract, so a model cannot delete its
    own injected guardrails (e.g. 02-evidence-before-success)."""
    if action == "list":
        return contract.render(contract.load()) + \
            "\nNudge: honor these constraints; they are re-injected whenever they change."
    if action == "add":
        if not text:
            return "contract: 'add' requires text\nNudge: pass the constraint text to add."
        c, cons = contract.add(text)
        if c is None:
            return (f"contract: identical constraint already present ({len(cons)} total)\n"
                    "Nudge: reuse the existing constraint instead of duplicating it.")
        warn = contract.brief_cap_warning(len(cons))
        return (f"added {c['id']}\n" + contract.render(cons) +
                (f"\n{warn}" if warn else "") +
                "\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
    if action == "remove":
        if not id:
            return "contract: 'remove' requires id\nNudge: run action=\"list\" to see current ids."
        target = next((c for c in contract.load() if c.get("id") == id), None)
        if target is None:
            return (f"contract: no constraint with id {id!r}\n"
                    "Nudge: run action=\"list\" to see current ids.")
        if target.get("source") == "seed":
            return (f"contract: {id} is a seed constraint — model-driven removal is refused\n"
                    "Nudge: only the owner may remove it (CLI `contract remove ID` or /guard-contract remove).")
        contract.remove(id)
        return (f"removed {id}\n" + contract.render(contract.load()) +
                "\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.")
    return "contract: unknown action — use list|add|remove\nNudge: retry with a valid action."


@mcp.tool
def guard_note(type: str, text: str, tags: list[str] = []) -> str:
    """Journal an entry: type=decision|correction|risk|note; optional tags."""
    try:
        entry = journal.add(type, text, tags)
    except ValueError as e:
        return f"note: {e}\nNudge: use one of decision|correction|risk|note."
    return journal.render_ack(entry, journal.count())


@mcp.tool
def guard_loop_check() -> str:
    """Failing-command streaks for this session + change-strategy advice."""
    cfg = store.load_config()
    return loops.render(loops.streaks(), cfg)


@mcp.tool
def guard_diff_audit(baseline: str | None = None) -> str:
    """Diff audit vs HEAD (or a baseline ref): numstat stats + verdict vs thresholds."""
    return diffscope.render(diffscope.diff_audit(baseline))


@mcp.tool
def guard_preflight() -> str:
    """Tool presence/versions for configured tools + git-repo check."""
    return preflight.render(preflight.run_preflight())


@mcp.tool
def guard_budget() -> str:
    """Session tool-output chars, estimated tokens (chars/4), top-5 tools."""
    return budget.render(budget.compute())


def main() -> None:
    mcp.run()  # stdio transport (default)


if __name__ == "__main__":
    main()
