"""fastmcp in-memory Client smoke over ALL 9 MCP tools (SPEC §4, §7)."""

import asyncio
import json
import re

import pytest

from protect_context import store

fastmcp = pytest.importorskip("fastmcp")

EXPECTED_TOOLS = {
    "guard_status",
    "guard_verify",
    "guard_evidence",
    "guard_contract",
    "guard_note",
    "guard_loop_check",
    "guard_diff_audit",
    "guard_preflight",
    "guard_budget",
}


def _text(res) -> str:
    return res.content[0].text


def test_all_nine_tools_smoke():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            tools = await client.list_tools()
            assert {t.name for t in tools} == EXPECTED_TOOLS

            results = {}
            results["status"] = _text(await client.call_tool("guard_status", {}))
            results["verify_ok"] = _text(
                await client.call_tool("guard_verify", {"command": "true"}))
            results["verify_fail"] = _text(
                await client.call_tool("guard_verify", {"command": "false"}))
            results["evidence"] = _text(
                await client.call_tool("guard_evidence", {"limit": 2}))
            results["contract_list"] = _text(
                await client.call_tool("guard_contract", {"action": "list"}))
            results["contract_add"] = _text(await client.call_tool(
                "guard_contract", {"action": "add", "text": "Write tests first"}))
            results["note"] = _text(await client.call_tool(
                "guard_note", {"type": "correction", "text": "use rg not grep",
                               "tags": ["search"]}))
            results["loop_check"] = _text(await client.call_tool("guard_loop_check", {}))
            results["diff_audit"] = _text(
                await client.call_tool("guard_diff_audit", {"baseline": None}))
            results["preflight"] = _text(await client.call_tool("guard_preflight", {}))
            results["budget"] = _text(await client.call_tool("guard_budget", {}))
            return results

    res = asyncio.run(run())

    for name, text in res.items():
        assert "Nudge:" in text, f"{name} output lacks a Nudge line"

    # verify recorded evidence across both runs (ok + failing, never raised)
    assert "ev-0001" in res["verify_ok"] and "exit 0" in res["verify_ok"]
    assert "ev-0002" in res["verify_fail"] and "exit 1" in res["verify_fail"]
    assert store.verify_path().exists()

    # contract add returned the new id; remove it to prove remove works too
    m = re.search(r"added (\d{2}-[\w-]+)", res["contract_add"])
    assert m, res["contract_add"]

    async def cleanup():
        from fastmcp import Client

        from protect_context.mcp_server import mcp as server

        async with Client(server) as client:
            return _text(await client.call_tool(
                "guard_contract", {"action": "remove", "id": m.group(1)}))

    removed = asyncio.run(cleanup())
    assert f"removed {m.group(1)}" in removed

    # note actually persisted to the shared journal
    entries = store.read_jsonl(store.journal_path())
    assert entries and entries[-1]["type"] == "correction"
    assert json.loads(json.dumps(entries[-1]["tags"])) == ["search"]


def test_failed_guard_verify_feeds_loop_streak_at_mcp_boundary():
    """Anti-bypass pinned end-to-end at the MCP boundary (judge fix): two
    failing guard_verify calls must surface as a streak in guard_loop_check —
    the guard's own evidence tool must not be an escape hatch from goal #9.
    The loops.py merging is unit-tested directly; this pins it through the
    real tool boundary."""
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            fail1 = _text(await client.call_tool("guard_verify", {"command": "false"}))
            fail2 = _text(await client.call_tool("guard_verify", {"command": "false"}))
            loop = _text(await client.call_tool("guard_loop_check", {}))
            return fail1, fail2, loop

    fail1, fail2, loop = asyncio.run(run())
    assert "ev-0001" in fail1 and "exit 1" in fail1
    assert "ev-0002" in fail2 and "exit 1" in fail2
    # the identical failing fingerprint shows as a streak of 2, at the block
    # threshold (loop_block_after=3 → block on the next identical attempt)
    assert "false ×2" in loop
    assert "next identical run will be blocked" in loop
    assert "Nudge:" in loop


def test_guard_verify_never_raises_on_bad_command():
    from fastmcp import Client

    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return _text(await client.call_tool(
                "guard_verify", {"command": "definitely-missing-binary-xyz"}))

    text = asyncio.run(run())
    assert "exit 127" in text and "Nudge:" in text


def test_guard_contract_refuses_model_driven_seed_removal():
    """A model must not be able to delete its own injected guardrails: seed
    constraints are removable only by the owner (CLI / /guard-contract)."""
    from fastmcp import Client

    from protect_context import contract
    from protect_context.mcp_server import mcp

    async def run():
        async with Client(mcp) as client:
            return (
                _text(await client.call_tool("guard_contract", {"action": "remove", "id": "02-evidence-before-success"})),
                _text(await client.call_tool(
                    "guard_contract", {"action": "add", "text": "temporary constraint"})),
            )

    seed_res, add_res = asyncio.run(run())
    assert "seed constraint" in seed_res and "refused" in seed_res
    assert "Nudge:" in seed_res
    # the seed constraint is still there
    assert any(c["id"] == "02-evidence-before-success" for c in contract.load())

    # a model-added constraint can still be removed by the model
    m = re.search(r"added (\d{2}-[\w-]+)", add_res)
    assert m, add_res

    async def cleanup():
        async with Client(mcp) as client:
            return _text(await client.call_tool("guard_contract", {"action": "remove", "id": m.group(1)}))

    assert f"removed {m.group(1)}" in asyncio.run(cleanup())
