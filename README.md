# protect-context · Agent Guardrail Suite

`protect-context` adds practical guardrails around AI coding agents through
three interfaces backed by the same project-local `.agent-guard/` store:

- a pi extension for automatic context injection, telemetry, loop blocking,
  diff warnings, and risky-command confirmation;
- a FastMCP server for portable model/host access; and
- a Python CLI for people, scripts, CI, and hosts without MCP.

The suite is advisory-first. It records evidence and makes unsafe or repetitive
behavior visible; it is not a sandbox and does not prove that a change is
correct. [`SPEC.md`](./SPEC.md) is the frozen v1.0 contract. The current
line-by-line implementation audit is in
[`docs/SPEC-AUDIT-2026-09-01.md`](./docs/SPEC-AUDIT-2026-09-01.md).

## Quickstart

Python 3.10+ is required. Node 22.19+ is required only to validate the
TypeScript extension from this checkout; pi supplies the extension's runtime
types and modules.

```sh
# Python package, CLI, MCP server, and Python tests
python3 -m venv .venv
.venv/bin/python -m pip install -e ".[dev]"

# Reproducible extension development checks (dev dependencies only)
npm ci --ignore-scripts
npm run check
```

The extension itself has zero npm runtime dependencies and is loaded by pi via
jiti. Install it by copying or symlinking `extension/` into a trusted extension
directory:

```sh
mkdir -p ~/.pi/agent/extensions
cp -r extension ~/.pi/agent/extensions/protect-context

# Project-local alternative
mkdir -p .pi/extensions
cp -r extension .pi/extensions/protect-context
```

If the machine's default Node is older than 22.19, the same checks can be run
with an ephemeral Node 22 binary after `npm ci`:

```sh
npx -y node@22 node_modules/typescript/bin/tsc --noEmit -p extension/tsconfig.json
npx -y node@22 --experimental-strip-types --test extension/test/*.test.ts
```

### MCP configuration

For pi with `pi-mcp-adapter`, add `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "protect-context": {
      "command": "/absolute/path/to/protect-context/.venv/bin/python",
      "args": ["-m", "protect_context.mcp_server"]
    }
  }
}
```

The same stdio shape works in a generic MCP host. Set `PC_SESSION_ID` when
several host sessions need distinct evidence and loop views:

```json
{
  "mcpServers": {
    "protect-context": {
      "command": "/absolute/path/to/protect-context/.venv/bin/python",
      "args": ["-m", "protect_context.mcp_server"],
      "env": { "PC_SESSION_ID": "my-session" }
    }
  }
}
```

The MCP surface contains the nine frozen v1.0 tools plus two compatible read
surfaces added to close the original reachability gaps:
`guard_journal` and `guard_orientation`. Tools carry conservative MCP
annotations; in particular, `guard_verify` is marked destructive and
open-world because it can run any shell command. Annotations are host hints,
not enforcement, so configure the host to require human approval for that
tool.

### CLI

Every command returns `0` for OK, `1` for a triggered warning or failed
verification, and `2` for an input/environment error.

```sh
.venv/bin/protect-context init
.venv/bin/protect-context status
.venv/bin/protect-context verify "pytest -q" [--timeout 180]
.venv/bin/protect-context evidence [--limit 5]
.venv/bin/protect-context contract list
.venv/bin/protect-context contract add "Keep the public API stable"
.venv/bin/protect-context contract remove ID
.venv/bin/protect-context note correction "use rg, not grep" --tags search
.venv/bin/protect-context journal [--limit 5] [--type decision]
.venv/bin/protect-context orientation
.venv/bin/protect-context loops
.venv/bin/protect-context diff [--baseline REF]
.venv/bin/protect-context preflight
.venv/bin/protect-context budget
```

Pi commands are `/guard-status`, `/guard-contract`, `/guard-verify`,
`/guard-note`, and `/guard-report`. Its model-callable tools are
`guard_verify`, `guard_note`, `guard_contract_check`, and `guard_status`.

## The 12 goals and their actual enforcement level

| # | Failure mode | Shipped mitigation | Enforcement |
|---|---|---|---|
| 1 | Violating instructions | Persistent contract; provenance-aware, change-triggered brief injection; seed-removal refusal at the MCP boundary | Context/advisory |
| 2 | Claiming success without verification | Verification ledger, evidence IDs, status/evidence views, failure digests | Recorded evidence; not semantic proof |
| 3 | Editing too much / scope creep | Git diff audit over tracked, staged, and bounded non-ignored untracked work; safe explicit baselines | Warn/advisory |
| 4 | Misunderstanding the repo | Worktree-root-aware bounded orientation digest in pi, CLI, and MCP; conventions-file discovery | Automatic context + explicit read |
| 5 | Plausible but subtly wrong code | Deterministic contract checklist, verification gate, test-required seed | Heuristic/advisory |
| 6 | Losing earlier context | Persistent journal; recent trusted decisions re-injected after change and compaction; CLI/MCP read views | Automatic context + explicit read |
| 7 | Repeating corrected behavior | Bounded tagged corrections; trusted corrections re-injected; model-authored entries retained for owner review | Automatic context + trust boundary |
| 8 | Large diffs | Configurable line/file warning and hard-level notifications, status verdict, widget | Warn/advisory |
| 9 | Repetitive debugging loops | Shared bash/evidence streak reconstruction; third identical failing command blocked by default in pi, CLI, and MCP | Hard block at configured threshold |
| 10 | Environment/tool failures | Tool/version and Git-worktree preflight with warning exit outside a repository | Diagnostic |
| 11 | Permission interruptions | One grouped pi confirmation for the frozen risky-command patterns; environment preflight | Interactive confirmation where UI exists |
| 12 | Token/API cost and latency | Bounded brief sections, journal/contract text, evidence digests, untracked reads, output previews, and context watermarks | Automatic budgeting/advisory |

“Shipped” means the mitigation is reachable and tested. It does not turn an
advisory signal into a security or correctness guarantee.

## Trust and provenance

Direct CLI and pi slash-command contract writes are treated as owner input.
Within the frozen 12-line brief cap, newest owner constraints are selected
first, then frozen seed constraints, then other entries; an agent-authored
constraint cannot crowd out a seed.

MCP/model journal writes are forcibly tagged `agent`. They remain inspectable
through journal views but are not re-injected as trusted decisions or
corrections. CLI and pi slash-command journal entries are trusted. Untagged
legacy entries are treated as trusted for backward compatibility, because the
frozen journal schema has no dedicated author field.

This is a provenance convention, not authentication. A model that already has
shell access can invoke the CLI and appear on that trusted path; use host-level
tool permissions when the distinction must be a security boundary.

All newly stored contract, journal, and tag text is normalized to one bounded
line, and legacy values are normalized again when rendered. This prevents
terminal-line forging and unbounded persistent prompt growth; it does not make
untrusted prose safe to follow.

## Configuration

The extension seeds `.agent-guard/config.json` on first session start; `init`
does the same for CLI/MCP-first use. Unknown, wrongly typed, fractional, or
out-of-range values fall back to the frozen default.

| Key | Default | Meaning |
|---|---:|---|
| `loop_block_after` | `3` | Block the Nth identical failing command attempt |
| `diff_warn_lines` | `400` | Changed-line warning threshold |
| `diff_hard_lines` | `800` | Changed-line hard-level threshold |
| `diff_warn_files` | `10` | Changed-file warning threshold |
| `ctx_warn_pct` | `70` | First context-usage warning watermark |
| `brief_mode` | `"changed"` | Inject only when the brief digest changes; `"always"` injects every turn |
| `risk_confirm` | `true` | Ask once before a matching risky pi bash command when UI is available |
| `preflight_tools` | `git`, `python3`, `pip`, `node`, `npm`, `rg`, `pytest` | Executables checked by preflight |

Numeric thresholds may be set to zero; the extension records an explicit first
notification so a zero watermark does not silently disable alerts. Preflight
checks at most 20 configured tool entries. If more are configured, it lists the
omitted count and returns a warning instead of claiming the environment is
fully checked. Version probes have a two-second per-tool timeout, share a
15-second overall deadline, and decode at most 4 KiB of output; a missing
version is reported as an incomplete preflight.

## Shared store and concurrency

Runtime files remain in the frozen `.agent-guard/` layout and are gitignored:

`config.json` · `contract.json` · `journal.jsonl` · `events.jsonl` ·
`verify_runs.jsonl` · `state.json`

Python and TypeScript use the same atomic-directory lease at
`.agent-guard/.lock.d`, with an owner token, PID/hostname checks, bounded
waiting, and conservative stale recovery. Python also takes its legacy local
`fcntl.flock` inside that lease. Evidence-ID allocation, JSONL appends, and
contract read-modify-write operations hold the shared lease, preventing
duplicate IDs and lost contract updates across runtimes. JSON file replacement
uses unique temporary files.

The lease follows the atomic `mkdir` design used by mature lock libraries while
remaining dependency-free and interoperable with Python. A crashed same-host
owner is reclaimable after the stale interval; a stale foreign-host owner fails
closed because process liveness cannot be proved safely without an external
coordinator. Recovery retains a small identity-bound `.lock.d.stale.*`
directory as a durable race guard; it does not block new writers and lives
inside the already-ignored runtime store. Contract mutations also fail closed
when owner rows are malformed, preserving the original file for repair.

## Validation

Run all local checks with:

```sh
.venv/bin/pytest -q
npm run typecheck
npm test
.venv/bin/python -m compileall -q src
.venv/bin/python -m build --outdir /tmp/protect-context-dist
```

The definition-of-done checks are run twice consecutively before release. The
dated audit records the observed counts, integration probes, and package smoke
test instead of leaving stale numbers in this README.

## Limitations and security boundary

- `guard_verify` deliberately invokes a shell with the caller's privileges.
  It can modify files, access the network, or disclose data. The pi layer asks
  for confirmation only when one of the frozen regex patterns matches; the MCP
  layer relies on host approval. Neither is a shell parser or a sandbox.
- MCP annotations are untrusted hints. A client may ignore them. Do not expose
  `guard_verify` to an untrusted model without a real host sandbox/approval
  policy.
- An evidence record proves only that one command returned one exit code. It is
  not cryptographically bound to a commit/worktree, has no freshness policy,
  and does not prove the claimed behavior.
- The pi extension freezes its diff baseline at session start, so committing
  mid-session does not reset its scope. CLI/MCP audits default to current
  `HEAD`; pass them an explicit baseline for cross-commit scope. Binary files
  count as files but zero lines.
- Untracked-file content reads are capped at 1,000 files, 1 MB per file, and
  8 MB total, and stop once the hard line threshold is known. Output explicitly
  reports a bounded scan, promotes it to at least a warning/CLI exit 1, and
  treats the truncated count as a lower bound.
- The frozen brief carries at most 12 constraints. Overflow is visible, and
  owner constraints are prioritized, but hidden constraints are not enforced
  by context injection.
- `state.json` is project-global. Atomic replacement prevents torn JSON, but
  simultaneous sessions can still overwrite notification/session state; use
  `PC_SESSION_ID` to separate ledger views, not state files.
- Frozen fingerprint normalization collapses whitespace everywhere, including
  inside quoted shell strings. Semantically different commands can therefore
  share a loop fingerprint.
- Commands and the last 2,000 output characters are stored verbatim. There is
  no automatic secret detector or redactor; never put credentials in commands
  or verification output.
- Python verification bounds RAM by spooling output to temporary files, but a
  very noisy command can consume temporary disk until it exits. On Windows,
  killing the direct process cannot guarantee that every descendant exits.
- The deterministic contract checker is keyword coverage, not program
  analysis. Treat every `addressed` result as a review prompt, not proof.
- JSONL ledgers have no automatic retention or rotation. Output views stay
  bounded, but long-lived stores grow on disk and full session reconstruction
  becomes progressively more expensive; archive runtime state deliberately.

## Design sources

The implementation was checked against primary or professional sources:

- Git's stable porcelain/other-file interfaces for non-ignored untracked
  enumeration: [git-status](https://git-scm.com/docs/git-status) and
  [git-ls-files](https://git-scm.com/docs/git-ls-files).
- Pi's documented lifecycle, tool, context, and UI APIs:
  [Pi extension documentation](https://pi.dev/docs/latest/extensions).
- The mature `proper-lockfile` design, which uses atomic `mkdir` rather than
  `O_EXCL`: [moxystudio/node-proper-lockfile](https://github.com/moxystudio/node-proper-lockfile).
  The package itself was not added because the frozen extension requirement is
  zero runtime dependencies and the lock must interoperate with Python.
- Operational-safety evidence motivating explicit constraints, failure
  transparency, and safe-halt behavior: [What Breaks When LLMs Code?](https://arxiv.org/abs/2605.30777)
  (ASE 2026), plus evidence-conditioned execution results in
  [Preventing Premature Commitment in Coding Agents](https://arxiv.org/abs/2607.28815).
- MCP's own warning that annotations are risk vocabulary rather than
  enforcement: [Tool Annotations as Risk Vocabulary](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

## Non-goals

No network or LLM calls are made by the guardrail logic itself. It is not a
sandbox, policy engine, auto-fixer, secret manager, or replacement for pi/MCP
host permissions. It complements those controls with durable context,
evidence, telemetry, and narrowly scoped blocking.
