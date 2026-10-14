# protect-context v1.0 completion audit

**Audit opened:** 2026-09-01  
**Finalized:** 2026-10-15  
**Specification:** [`SPEC.md`](../SPEC.md), frozen 2026-08-28 and left unchanged

## Outcome

All three deliverables are built and usable from one shared project-local
store: the pi extension, FastMCP server, and Python CLI. Every frozen goal has
a reachable mitigation and test coverage. The result deliberately remains a
guardrail suite, not a correctness proof or security boundary: goals 1, 3–8,
10–12 necessarily include advisory or heuristic behavior, while the pi layer
hard-blocks only the configured repeated-command loop and asks for confirmation
on the frozen risky-command patterns.

The original dogfood report is preserved as a historical snapshot. Its F1–F5
gaps are closed here: journal reads and trusted-decision re-injection,
orientation through CLI/MCP, bounded untracked/unborn diff accounting,
structured bash failure capture, and friendly unborn/non-repository handling.

## Frozen-goal traceability

| # | Implemented behavior | Primary code | Verification |
|---|---|---|---|
| 1 | Persistent contract CRUD; provenance-aware, digest-triggered brief; overflow disclosure | `contract.py`, `extension/lib/contract.ts`, `extension/lib/brief.ts` | Python/TS contract and brief tests; CLI/MCP smoke |
| 2 | Shell outcome ledger with unique evidence IDs, bounded digest, timeout handling, and status view | `verify.py`, `extension/lib/verify.ts`, `extension/index.ts` | verify, store-concurrency, status, and MCP tests |
| 3 | Safe baseline resolution plus tracked, staged, bounded non-ignored untracked, nested-cwd, and unborn-repo accounting | `diffscope.py`, `extension/lib/gitparse.ts`, `extension/index.ts` | adversarial Python/TS diff tests and lifecycle smoke |
| 4 | Bounded tree/language/conventions orientation at session start and through CLI/MCP | `orientation.py`, `extension/lib/orientation.ts` | orientation, CLI, MCP, and lifecycle tests |
| 5 | Deterministic checklist and explicit verification evidence path | `extension/lib/contract_check.ts`, `verify.py` | extension registration/lifecycle and verify tests |
| 6 | Persistent journal read/write; recent trusted decisions re-injected after changes and compaction | `journal.py`, `extension/lib/journal.ts`, `extension/lib/brief.ts` | journal, brief, CLI, MCP, and lifecycle tests |
| 7 | Tagged corrections with trust boundary; agent-authored entries remain reviewable but are not trusted context | same journal/brief modules | provenance, sanitization, journal, and brief tests |
| 8 | Configurable line/file warning and hard levels in audit, status, widget, and notifications | `diffscope.py`, `report.py`, `extension/lib/status.ts`, `extension/lib/widget.ts` | verdict, report, status, widget, and lifecycle tests |
| 9 | Cross-ledger chronological failure streaks; successful identical command resets; third identical failure blocked by default | `loops.py`, `extension/lib/loops.ts`, `extension/index.ts` | Python/TS loop tests, cross-format fixtures, lifecycle smoke |
| 10 | Bounded tool/version and Git-worktree preflight with clear warning state | `preflight.py` | preflight, CLI, and MCP tests |
| 11 | One pi confirmation per matching risky bash call when UI exists; no-UI logging; preflight reduces surprises | `extension/lib/fingerprint.ts`, `extension/index.ts` | risk-pattern and lifecycle tests |
| 12 | Bounded briefs, text fields, evidence views/digests, orientation/diff reads, and context watermarks | budget/text/render modules in both runtimes | budget, sanitization, cap, digest, status, and lifecycle tests |

## Gaps found and closed

- Baselines are resolved as revisions before use and passed after `--`, avoiding
  option/path ambiguity. Git failures are reported as unavailable rather than
  silently converted to a clean diff.
- Untracked work is selected by Git's stable porcelain output and read under
  file/count/byte/line caps. The active runtime store is excluded exactly,
  including when the extension starts below the repository root. Scan limits
  are surfaced as lower-bound measurements.
- Repositories without commits are compared against Git's format-specific
  empty tree, without double-counting staged-plus-edited files.
- Journal and orientation gained compact CLI/MCP read surfaces. This expands
  the portable surface from the nine frozen names to eleven compatible tools;
  the original nine names and arguments remain intact.
- Contract and journal text is bounded and control-normalized at storage and
  rendering boundaries. Contract overflow cannot silently crowd every frozen
  seed out of the 12-line brief.
- Orientation resolves a nested launch directory to its Git worktree root,
  normalizes adversarial filenames, caps the combined tree, and does not
  follow directory symlinks outside the selected repository.
- Agent-authored MCP content is marked as such. It remains inspectable but does
  not become a trusted decision/correction simply by writing to persistent
  context.
- Python and TypeScript share an atomic-directory lease for cross-runtime
  append, ID allocation, first-use seeding, and contract read-modify-write.
  Python retains the frozen local `fcntl.flock` inside that lease. Atomic JSON
  replacement uses unique temporary names.
- Loop state merges bash events and verification runs in parsed timestamp order
  and refreshes when another CLI/MCP writer changes a ledger mid-session.
- An incomplete untracked scan is always at least a warning, returns CLI status
  1, and uses lower-bound language instead of claiming the diff is in budget.
- Preflight checks at most 20 configured tools; omitted entries make the result
  explicitly incomplete and produce a warning rather than a false healthy
  result.
- Verification output is spooled to bounded-memory temporary files; timeout
  kills the POSIX process group and records exit 124. Input timeout and recent
  evidence count are clamped.
- Extension lifecycle paths are exercised with a mocked pi API: startup,
  change-only brief injection, compaction invalidation, risk/no-UI behavior,
  loop blocking, status, and idempotent shutdown. Every UI call is gated.
- Zero-valued notification thresholds retain first-notification semantics, and
  malformed nested extension state is normalized before lifecycle use.
- Build metadata now includes the README, an explicit build extra, pinned Node
  development dependencies, and Node 22.19+ validation scripts. These are
  development dependencies only; the extension keeps zero npm runtime
  dependencies.
- The direct CLI module entry `python -m protect_context.cli …` now runs the
  CLI instead of silently exiting 0. A subprocess test pins the behavior
  (goal 2: no unevidenced success).

## Store and compatibility notes

The frozen JSON/JSONL record shapes, 12 seed IDs/texts, config defaults,
fingerprint rule, 2,000-character digest rule, and original MCP names are
unchanged. Readers tolerate malformed or legacy records conservatively, and
new timestamps use UTC milliseconds while loop reconstruction accepts legacy
ISO offsets and `Z` timestamps.

The lock strengthens the frozen best-effort local-lock requirement. A dead
same-host owner is reclaimable only after the stale interval and identity
checks. A foreign-host stale owner fails closed because this dependency-free
store cannot prove remote PID liveness.

## Verification

The final release gate was run on 2026-10-15 after the last production-code
change (the CLI module-entry guard and its test):

- two consecutive passes of **144 Python tests** and **99 Node 22 tests**;
- pinned TypeScript 7.0.2 typechecking passed on both passes;
- the Python suite called all **11 shipped FastMCP tools** through an in-memory
  client (including the nine frozen v1.0 names);
- each Node pass included simultaneous Python/Node stress that preserved all
  40 contract additions and allocated 60 unique sequential evidence IDs;
- `python -m build` produced `protect_context-1.0.0.tar.gz` and
  `protect_context-1.0.0-py3-none-any.whl`;
- the wheel installed without dependencies into a fresh virtual environment,
  where package import and `protect-context --help` both succeeded;
- `pip check` passed and `npm audit --omit=dev` reported zero vulnerabilities;
  and
- source compilation and `git diff --check` passed, while `SPEC.md` remained
  unchanged.

## Honest residual limits

- `guard_verify` executes a shell with the caller's authority. Regex risk
  confirmation and MCP annotations are hints, not parsing, isolation, or host
  enforcement.
- Evidence is an append-only observation of a command result; it is not bound
  cryptographically to a commit/worktree and has no automatic freshness rule.
- The default diff view is relative to `HEAD`, so an explicit baseline is
  needed for scope that spans commits. Binary files contribute a file count
  but no meaningful changed-line count.
- Bounded untracked scanning can return a lower-bound line count. The output
  discloses that condition rather than claiming an exact measurement.
- The contract brief is capped at 12 lines; prioritized overflow remains
  available in the full contract view but is not simultaneously injected.
- `state.json` is project-global. Atomic writes prevent torn JSON, but two
  sessions may overwrite notification/session state; ledger views can be
  separated with session IDs.
- The frozen whitespace fingerprint also collapses whitespace inside quoted
  strings, so two semantically different shell commands can collide.
- Stored commands/digests have no secret detector. Very noisy verification can
  consume temporary disk; direct-process termination on Windows cannot prove
  that every descendant stopped.
- Orientation and contract checking are bounded heuristics, not semantic code
  understanding or proof.
- The CLI-versus-agent provenance distinction is conventional rather than
  authenticated, and append-only ledgers have no automatic retention policy.

## Design evidence

- Git path/status handling follows the stable porcelain and other-file
  interfaces in [git-status](https://git-scm.com/docs/git-status) and
  [git-ls-files](https://git-scm.com/docs/git-ls-files).
- Extension lifecycle and UI/tool integration follow the
  [pi extension documentation](https://pi.dev/docs/latest/extensions).
- The shared lease adapts the mature atomic-`mkdir` approach documented by
  [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile), while
  retaining a dependency-free cross-language implementation.
- The trust and evidence posture is informed by professional empirical work on
  coding-agent failure transparency and evidence-conditioned execution:
  [What Breaks When LLMs Code?](https://arxiv.org/abs/2605.30777) and
  [Preventing Premature Commitment in Coding Agents](https://arxiv.org/abs/2607.28815).
- MCP annotations are documented as risk vocabulary rather than enforcement in
  [the MCP project article](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).
