# protect-context · Agent Guardrail Suite

Guardrails for AI coding agents: three deliverables over one shared on-disk store
(`.agent-guard/`) — a **pi extension** (automatic layer), an **MCP server** (explicit/portable
layer), and a **CLI** (scripts + fallback). Advisory-first; no network, no LLM calls inside the
tooling. See `SPEC.md` for the frozen contract.

## Quickstart

```sh
# 1. Python package (MCP server + CLI)
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"

# 2. pi extension — copy (or symlink) into a trusted location
mkdir -p ~/.pi/agent/extensions
cp -r extension ~/.pi/agent/extensions/protect-context
#    or project-local: mkdir -p .pi/extensions && cp -r extension .pi/extensions/protect-context
```

The extension loads via jiti (no build step) and has **zero npm dependencies** — pi supplies
`typebox` and its own API at load time.

**pi + MCP** — add `.mcp.json` at the project root (pi-mcp-adapter reads the standard format):

```json
{ "mcpServers": { "protect-context": {
    "command": "/abs/path/to/protect-context/.venv/bin/python",
    "args": ["-m", "protect_context.mcp_server"] } } }
```

**Generic MCP host** — same shape for any host speaking stdio MCP:

```json
{ "mcpServers": { "protect-context": {
    "command": "/abs/path/.venv/bin/python",
    "args": ["-m", "protect_context.mcp_server"],
    "env": { "PC_SESSION_ID": "my-session" } } } }
```

**CLI** (same verbs as the MCP tools; exit 0 ok / 1 warning / 2 error):

```sh
.venv/bin/protect-context init                    # create .agent-guard/ (defaults + seed contract)
.venv/bin/protect-context status                  # compact dashboard
.venv/bin/protect-context verify "pytest -q"      # run + record evidence (never raises on failure)
.venv/bin/protect-context evidence                # recent verify runs
.venv/bin/protect-context contract list|add TEXT|remove ID
.venv/bin/protect-context note correction "use rg not grep" --tags search
.venv/bin/protect-context loops | diff [--baseline REF] | preflight | budget
```

**Extension commands:** `/guard-status`, `/guard-contract add|remove|list [text]`,
`/guard-verify <cmd>`, `/guard-note <type> <text>`, `/guard-report`.
**Model-callable tools (ext):** `guard_verify`, `guard_note`, `guard_contract_check`, `guard_status`.

## The 12 goals → shipped mitigations (traceability; Status = judge verdict, best-of-panel)

| # | Failure mode | Mitigation | Component | Status |
|---|---|---|---|---|
| 1 | Violating instructions | Contract store (`contract.json`); re-injected on change; `guard_contract`; model cannot remove seed constraints | ext + core | SHIPPED_WORKING |
| 2 | Success without verification | `guard_verify` evidence ledger (`verify_runs.jsonl`); status shows evidence count + last run; seed 02 forbids unevidenced claims | ext + core | SHIPPED_WORKING |
| 3 | Scope creep | Diff tracking vs HEAD (files/lines via git); warn thresholds; widget shows Δ; seed 03 bans unrelated refactors | ext + core | SHIPPED_WORKING |
| 4 | Misreading the repo | Orientation digest (tree ≤2 levels, languages, conventions files) injected at session start / on change | ext + core | SHIPPED_WORKING |
| 5 | Subtly-wrong code | `guard_contract_check` deterministic checklist over a change summary; verify gate; seed 05 requires tests | ext + core | SHIPPED_WORKING |
| 6 | Lost context/constraints | Persistent journal (`journal.jsonl`); re-injected on change; survives restarts | ext + core | SHIPPED_WORKING |
| 7 | Repeated corrections | Tagged correction entries, re-injected like the contract; `guard_note type=correction`; last 3 in brief | ext + core | SHIPPED_WORKING |
| 8 | Large diffs | Diff gates: warn 400L/10f, hard 800L — notify + widget + status verdict, split advice | ext + core | SHIPPED_WORKING |
| 9 | Debugging loops | Command-fingerprint streaks; identical failing bash blocked on 3rd attempt; `guard_verify` outcomes feed the same streaks | ext + core | SHIPPED_WORKING |
| 10 | Environment failures | `guard_preflight` (tool presence/versions, git check); structured error capture in events | core | SHIPPED_WORKING |
| 11 | Permission interruptions | One grouped risk-confirm for dangerous bash (9 anchored patterns); preflight reduces mid-task discovery | ext | SHIPPED_WORKING |
| 12 | Token cost & latency | Context-% watermarks (once per 10%); char budget on tool telemetry; brief only-on-change; compact output everywhere | ext + core | SHIPPED_WORKING |

Tests: `pytest` (90, incl. fastmcp in-memory smoke over all 9 tools) and
`node --experimental-strip-types --test extension/test/*.test.ts` (61) — green together;
typecheck: `npx -y typescript@latest --noEmit -p extension/tsconfig.json` passes.

## Configuration (`.agent-guard/config.json`; both sides identical)

| Key | Default | Meaning |
|---|---|---|
| `loop_block_after` | `3` | Identical failing command is blocked on the Nth attempt |
| `diff_warn_lines` / `diff_hard_lines` | `400` / `800` | Diff budget thresholds (lines) |
| `diff_warn_files` | `10` | Diff budget threshold (files) |
| `ctx_warn_pct` | `70` | Context-usage watermark start (notifies once per 10% step) |
| `brief_mode` | `"changed"` | `"changed"` = inject brief only when its sha1 changes |
| `risk_confirm` | `true` | Grouped confirm for risky bash (requires UI) |
| `preflight_tools` | `["git","python3","pip","node","npm","rg","pytest"]` | Tools checked by `guard_preflight` |

## Shared store (`.agent-guard/`, gitignored)

`config.json` · `contract.json` · `journal.jsonl` · `events.jsonl` · `verify_runs.jsonl` ·
`state.json` — formats frozen in SPEC §2. Appends serialized by a best-effort lock
(`fcntl.flock` on the Python side, exclusive-create lockfile on the TS side); evidence ids are
allocated inside the store lock, so concurrent writers never mint the same `ev-NNNN`. Session
label: extension session id; Python uses `PC_SESSION_ID` else `"default"`.

## Limitations

- **Advisory-first.** Only two things block: a third identical failing command, and a declined
  risk confirm. Everything else is nudges, widget deltas, and status verdicts.
- **Not a sandbox.** `guard_verify` runs commands verbatim (`shell=True` / `sh -c`) with the
  caller's privileges — it adds evidence, not isolation.
- **Diff baseline is HEAD.** Both `turn_end` telemetry and `guard_diff_audit` diff against HEAD,
  so a mid-task commit resets Δ to 0 and cumulative creep past the hard limit across multiple
  commits goes unseen (SPEC §5 freezes "vs HEAD"); pass an explicit `--baseline` ref to audit
  across commits.
- **Brief cap.** The re-injected brief carries at most 12 contract lines — constraints beyond
  that are not re-injected (adding one past the cap warns).
- **Risky commands without UI** are journaled as `risk` entries, never blocked.
- Single-machine, single-directory store; no remote sync, no auth.

## Non-goals

No network or LLM calls. Not a sandbox. Not an auto-fixer. No secrets in the store. Does not
replace pi's own permission system — complements it.
