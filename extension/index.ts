/**
 * protect-context — pi extension (automatic guardrail layer, SPEC §5).
 *
 * Entry point / wiring only: all logic lives in ./lib/*.ts (pi-import-free,
 * tested via `node --test --experimental-strip-types`). Zero npm runtime
 * dependencies; `typebox`, `@earendil-works/pi-coding-agent` and
 * `@earendil-works/pi-ai` are provided by the pi runtime (loaded via jiti).
 *
 * Hard rules honored here:
 * - no background processes/sockets/timers from the factory (deferred to
 *   session_start; nothing long-lived is started at all);
 * - session_shutdown is idempotent;
 * - every ctx.ui.* dialog is guarded by ctx.hasUI;
 * - event handlers never throw (catch → ctx.ui.notify).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { DEFAULT_CONFIG, type GuardConfig } from "./lib/defaults.ts";
import { loadConfig } from "./lib/config.ts";
import { matchRisk, normalizeCommand } from "./lib/fingerprint.ts";
import {
  appendJsonl,
  appendJsonlLocked,
  defaultState,
  ensureStore,
  eventsPath,
  fileStamp,
  loadState,
  saveState,
  readJsonl,
  storeDir,
  verifyRunsPath,
  withStoreLock,
} from "./lib/store.ts";
import { addConstraint, contractLines, loadContract, removeConstraint } from "./lib/contract.ts";
import { appendJournal, isJournalType, readJournal, recentCorrections } from "./lib/journal.ts";
import { toolCallEvent, toolResultEvent, bashExitFromResult, type EventRecord } from "./lib/events.ts";
import { failedAttempts, loopBlockReason, openLoopsFromMap, shouldBlockLoop, type LoopInfo } from "./lib/loops.ts";
import { buildBrief, sha1Hex, BRIEF_MAX_CONTRACT_LINES, CMD_DISPLAY_MAX, truncLine } from "./lib/brief.ts";
import { parseShortstat } from "./lib/gitparse.ts";
import { renderWidget } from "./lib/widget.ts";
import { checkContractSummary, renderChecklist } from "./lib/contract_check.ts";
import { renderOrientation, scanOrientation } from "./lib/orientation.ts";
import {
  clampTimeoutS,
  digestOf,
  formatMs,
  nextEvidenceId,
  readVerifyRuns,
  runsForSession,
  type VerifyRun,
} from "./lib/verify.ts";
import { buildStatus, type StatusData } from "./lib/status.ts";

const WIDGET_ID = "protect-context";
const BRIEF_CUSTOM_TYPE = "guard-brief";
/** Upper clamp for guard_verify timeouts (keep in sync with verify.TIMEOUT_MAX_S). */
const MAX_VERIFY_TIMEOUT_S = 900;

export default function (pi: ExtensionAPI) {
  // Session-scoped state (rebuilt on every session_start; new extension
  // instances are created per session by pi).
  let session = { id: "", started: "", gitHead: null as string | null };
  let cfg: GuardConfig = { ...DEFAULT_CONFIG, preflight_tools: [...DEFAULT_CONFIG.preflight_tools] };
  let state = defaultState("", null);
  const startTimes = new Map<string, { start: number; tool: string; cmd: string | null }>();
  let lastDiff = { lines: 0, files: 0 };
  let lastCtxPct: number | null = null;

  // In-memory guardrail state (goal #12: O(1) hot paths — the event handlers
  // and widget never re-parse the JSONL files; disk reads happen once per
  // session and on the cold brief/status paths). Rebuilt on session_start,
  // updated incrementally in the handlers below.
  const loopState = new Map<string, LoopInfo>();
  let evidenceCount = 0;
  // Evidence memo (goal #12 hot-path invariant): before_agent_start runs every
  // turn, and readJsonl already caches the ledger parse by mtime+size — this
  // memo additionally skips the per-session filter and last-run scan, so the
  // per-turn cost stays O(1) as the ledger grows. Any writer's append
  // (extension, MCP server, CLI) changes mtime+size → memo recomputes, so
  // externally recorded runs are still picked up.
  let evidenceMemo: { stamp: string | null; sessionId: string; last: VerifyRun | null; count: number } | null = null;
  // Blocked tool calls: pi still emits tool_execution_end for them (with the
  // block reason as the "result") — those end events must NOT be recorded as
  // failed tool results, or loop streaks inflate on every blocked attempt.
  const blockedToolCallIds = new Set<string>();
  // Orientation digest (goal #4): one scan per session, injected from
  // before_agent_start when its digest changes.
  let orientationText: string | null = null;

  // --- helpers ---------------------------------------------------------

  /** Run an event/command body without ever throwing (SPEC §5). */
  async function attempt<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      try {
        ctx.ui.notify(`guard: ${err instanceof Error ? err.message : String(err)}`, "error");
      } catch {
        // No UI available; drop the error.
      }
      return undefined;
    }
  }

  function safeSessionId(ctx: ExtensionContext): string {
    try {
      const id = ctx.sessionManager.getSessionId();
      if (id) return id;
    } catch {
      // fall through to random id
    }
    return `pc-${Math.random().toString(36).slice(2, 10)}`;
  }

  async function runGit(ctx: ExtensionContext, args: string[]): Promise<string | null> {
    try {
      const res = await pi.exec("git", args, { timeout: 5000 });
      if (res.code !== 0) return null;
      return res.stdout;
    } catch {
      return null;
    }
  }

  /** Run a shell command string via sh (mirrors Python shell=True). The
   *  timeout is clamped to [1, MAX_VERIFY_TIMEOUT_S] (keep in sync with
   *  verify.TIMEOUT_MAX_S on the Python side) so a model-supplied value can
   *  never wedge the session for hours. */
  async function shExec(
    ctx: ExtensionContext,
    command: string,
    timeoutS: number,
  ): Promise<{ exit: number; stdout: string; stderr: string; ms: number }> {
    const t0 = Date.now();
    const res = await pi.exec("sh", ["-c", command], {
      timeout: Math.min(MAX_VERIFY_TIMEOUT_S, Math.max(1, timeoutS)) * 1000,
    });
    const ms = Date.now() - t0;
    const exit = res.killed && res.code === 0 ? 124 : res.code;
    return { exit, stdout: res.stdout ?? "", stderr: res.stderr ?? "", ms };
  }

  function readEvents(cwd: string): EventRecord[] {
    return readJsonl<EventRecord>(eventsPath(cwd));
  }

  /** Rebuild in-memory loop streaks from disk (once per session). */
  function rebuildLoopState(cwd: string): void {
    loopState.clear();
    for (const info of failedAttempts(readEvents(cwd), session.id).values()) {
      loopState.set(info.cmd, info);
    }
  }

  /** Incremental loop-state update for a finished bash call (O(1)). */
  function recordLoopOutcome(cmd: string, ok: boolean, exit: number | null): void {
    if (ok) {
      loopState.delete(cmd); // success resets the streak (mirrors loops.py)
      return;
    }
    const cur = loopState.get(cmd) ?? { cmd, failures: 0, lastExit: null };
    cur.failures += 1;
    if (exit !== null) cur.lastExit = exit;
    loopState.set(cmd, cur);
  }

  /** Evidence for the current session, memoized by the ledger's mtime+size
   *  stamp (judge fix #2): the hot brief/status path never re-filters the
   *  whole ledger per turn. */
  function sessionEvidence(cwd: string): { last: VerifyRun | null; count: number } {
    const stamp = fileStamp(verifyRunsPath(cwd));
    if (evidenceMemo && evidenceMemo.sessionId === session.id && evidenceMemo.stamp === stamp) {
      return { last: evidenceMemo.last, count: evidenceMemo.count };
    }
    const runs = runsForSession(readVerifyRuns(cwd), session.id);
    evidenceMemo = {
      stamp,
      sessionId: session.id,
      last: runs.length > 0 ? runs[runs.length - 1] : null,
      count: runs.length,
    };
    return { last: evidenceMemo.last, count: evidenceMemo.count };
  }

  /** Number of fingerprints currently at/over the block threshold. */
  function openLoopCount(): number {
    let n = 0;
    for (const info of loopState.values()) {
      if (shouldBlockLoop(info.failures, cfg.loop_block_after)) n += 1;
    }
    return n;
  }

  function textLengthOf(result: unknown): { outChars: number; text: string } {
    const content = (result as { content?: unknown } | undefined)?.content;
    let outChars = 0;
    const parts: string[] = [];
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item && typeof item === "object" && (item as { type?: unknown }).type === "text") {
          const t = (item as { text?: unknown }).text;
          if (typeof t === "string") {
            outChars += t.length;
            parts.push(t);
          }
        }
      }
    }
    return { outChars, text: parts.join("\n") };
  }

  function renderWidgetNow(ctx: ExtensionContext): void {
    try {
      // O(1): renders purely from in-memory counters (no JSONL re-read).
      const line = renderWidget({
        diffLines: lastDiff.lines,
        diffFiles: lastDiff.files,
        loops: openLoopCount(),
        evidence: evidenceCount,
        ctxPct: lastCtxPct,
      });
      if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, [line]);
    } catch {
      // Widget is best-effort; never break the session over it.
    }
  }

  async function gatherStatus(ctx: ExtensionContext): Promise<StatusData> {
    const out = await runGit(ctx, ["diff", "--shortstat", "HEAD"]);
    const d = out === null ? { files: 0, lines: 0 } : parseShortstat(out);
    const ev = sessionEvidence(ctx.cwd);
    return {
      session: session.id,
      gitHead: session.gitHead,
      diffLines: d.lines,
      diffFiles: d.files,
      loops: openLoopsFromMap(loopState, cfg.loop_block_after),
      evidenceCount: ev.count,
      contractCount: loadContract(ctx.cwd).constraints.length,
      lastVerify: ev.last,
      ctxPct: lastCtxPct,
      diffWarnLines: cfg.diff_warn_lines,
      diffHardLines: cfg.diff_hard_lines,
    };
  }

  /** Run + record a verification command; never raises on nonzero exit.
   *  Enforces the SAME policy as bash tool_call — risk confirm + loop check —
   *  so guard_verify cannot be used to bypass either guardrail. */
  async function runVerifyAndRecord(
    ctx: ExtensionContext,
    command: string,
    timeoutSraw: number,
  ): Promise<string> {
    const fp = normalizeCommand(command);
    const timeoutS = clampTimeoutS(timeoutSraw);

    // (a) risk patterns → single grouped confirm; no-UI: log only, never block
    // (same semantics as bash tool_call; mirrors verify.match_risk journaling)
    const risk = matchRisk(fp);
    if (risk) {
      if (ctx.hasUI && cfg.risk_confirm) {
        const ok = await ctx.ui.confirm("Risky command", `'${fp}' matches '${risk}'. Run anyway?`);
        if (!ok) {
          return `guard: risky command declined (${risk}) — not run, not recorded.\nNudge: split off the destructive step and run the safe part here.`;
        }
      } else {
        try {
          appendJournal(ctx.cwd, {
            type: "risk",
            text: `guard_verify ran a command matching risk pattern '${risk}': ${fp}`,
          });
        } catch {
          // journal is best-effort; never block the evidence write
        }
      }
    }

    // (b) loop check on fingerprint — identical arithmetic to the bash path
    const failures = loopState.get(fp)?.failures ?? 0;
    if (shouldBlockLoop(failures, cfg.loop_block_after)) {
      return `${loopBlockReason(fp, failures)}\nNudge: not run, not recorded — change approach or gather new information first.`;
    }

    const res = await shExec(ctx, command, timeoutS);
    const run = withStoreLock(storeDir(ctx.cwd), () => {
      const r: VerifyRun = {
        // Id allocated INSIDE the store lock: two concurrent writers
        // (extension + MCP server + CLI) can never mint the same ev-NNNN.
        id: nextEvidenceId(readVerifyRuns(ctx.cwd)),
        ts: new Date().toISOString(),
        session: session.id || "default",
        cmd: command.trim(),
        exit: res.exit,
        ok: res.exit === 0,
        digest: digestOf(res.stdout, res.stderr),
        ms: res.ms,
      };
      appendJsonlLocked(verifyRunsPath(ctx.cwd), r);
      return r;
    });
    evidenceCount += 1;
    // guard_verify is not an escape hatch from goal #9: its outcomes feed the
    // same in-memory streaks as bash runs (fail +1, success resets).
    recordLoopOutcome(fp, run.ok, run.exit);
    renderWidgetNow(ctx);
    const lines: string[] = [`${run.id} exit=${run.exit} ${formatMs(run.ms)} '${truncLine(run.cmd, CMD_DISPLAY_MAX)}'`];
    if (!run.ok) {
      // Failure diagnostics (pytest summaries, compiler errors) live at the
      // END of output — and the digest rule is "last ≤2000 chars" — so show
      // the TAIL, not the head, or the only visible preview is spent on banners.
      const tail = run.digest.slice(-160).replace(/\s+/g, " ").trim();
      if (tail) lines.push(`out: ${run.digest.length > 160 ? "…" : ""}${tail}`);
      lines.push(`Nudge: recorded the failure — fix or change approach; do not re-run unchanged.`);
    } else {
      lines.push(`Nudge: cite ${run.id} when claiming success.`);
    }
    return lines.join("\n");
  }

  // --- events ----------------------------------------------------------

  pi.on("session_start", async (_event, ctx) =>
    attempt(ctx, async () => {
      ensureStore(ctx.cwd);
      cfg = loadConfig(ctx.cwd).config;
      session.id = safeSessionId(ctx);
      session.started = new Date().toISOString();
      session.gitHead = await runGit(ctx, ["rev-parse", "HEAD"]);
      loadContract(ctx.cwd); // seeds contract.json from DEFAULT_CONTRACT if missing

      const prev = loadState(ctx.cwd);
      if (prev && prev.current_session?.id === session.id && prev.notify_watermarks) {
        state = { ...prev, counters: prev.counters ?? {} };
      } else {
        state = defaultState(session.id, session.gitHead);
        saveState(ctx.cwd, state);
      }
      // Warm the in-memory counters once per session (O(1) hot paths after this).
      rebuildLoopState(ctx.cwd);
      evidenceCount = sessionEvidence(ctx.cwd).count;
      try {
        orientationText = renderOrientation(scanOrientation(ctx.cwd));
      } catch {
        orientationText = null; // orientation is best-effort
      }
      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  pi.on("before_agent_start", async (_event, ctx) =>
    attempt(ctx, async () => {
      const contract = loadContract(ctx.cwd);
      const corrections = recentCorrections(readJournal(ctx.cwd), 3);
      // In-memory streaks are the merged view (bash events + guard_verify
      // outcomes) — the disk events alone would miss verify streaks.
      const loops = openLoopsFromMap(loopState, cfg.loop_block_after).slice(0, 2);
      const last = sessionEvidence(ctx.cwd).last;
      const brief = buildBrief({
        contract: contract.constraints,
        corrections,
        loops,
        lastEvidence: last ? { id: last.id, exit: last.exit, cmd: last.cmd, ms: last.ms } : null,
      });
      const digest = sha1Hex(brief);
      const briefDue = brief.trim() !== "" && (cfg.brief_mode !== "changed" || state.brief_digest !== digest);

      // Orientation (goal #4): injected once per distinct digest, like the
      // brief. Lazily re-scanned if session_start did not populate it.
      if (orientationText === null) {
        try {
          orientationText = renderOrientation(scanOrientation(ctx.cwd));
        } catch {
          orientationText = null;
        }
      }
      const orientDigest = orientationText === null ? null : sha1Hex(orientationText);
      const orientDue = orientDigest !== null && state.counters.orient_sha1 !== orientDigest;

      if (!briefDue && !orientDue) return undefined;

      const parts: string[] = [];
      if (orientDue && orientationText !== null) parts.push(orientationText);
      if (briefDue) parts.push(brief);
      if (parts.length === 0) return undefined;

      if (orientDue && orientDigest !== null) state.counters.orient_sha1 = orientDigest;
      if (briefDue) state.brief_digest = digest;
      saveState(ctx.cwd, state);
      return { message: { customType: BRIEF_CUSTOM_TYPE, content: parts.join("\n\n"), display: false } };
    }),
  );

  pi.on("tool_call", async (event, ctx) =>
    attempt(ctx, async () => {
      if (event.toolName !== "bash") return undefined;
      if (!isToolCallEventType("bash", event)) return undefined;
      const raw = typeof event.input.command === "string" ? event.input.command : "";
      if (raw.trim() === "") return undefined;
      const fp = normalizeCommand(raw);

      // (a) risk patterns → single grouped confirm; no-UI: log only, never block
      const risk = matchRisk(fp);
      if (risk) {
        if (ctx.hasUI && cfg.risk_confirm) {
          const ok = await ctx.ui.confirm("Risky command", `'${fp}' matches '${risk}'. Run anyway?`);
          if (!ok) {
            // pi still emits tool_execution_end for blocked calls (with the
            // block reason as the result) — mark it so the end handler does
            // not record the decline as a failed command.
            blockedToolCallIds.add(event.toolCallId);
            return { block: true, reason: `guard: risky command declined (${risk})` };
          }
        } else {
          // No-UI parity (judge fix #1): a risky bash run without a confirm
          // dialog must still reach the journal — runVerifyAndRecord and
          // Python verify.match_risk already do this, and a silent risky run
          // would be invisible to /guard-report and the brief.
          try {
            appendJournal(ctx.cwd, {
              type: "risk",
              text: `bash tool_call matched risk pattern '${risk}': ${fp}`,
            });
          } catch {
            // journal is best-effort; never block the tool call over it
          }
        }
      }

      // (b) loop check on fingerprint (in-memory streaks — O(1))
      const failures = loopState.get(fp)?.failures ?? 0;
      if (shouldBlockLoop(failures, cfg.loop_block_after)) {
        blockedToolCallIds.add(event.toolCallId);
        return { block: true, reason: loopBlockReason(fp, failures) };
      }

      // (c) record the attempt
      appendJsonl(eventsPath(ctx.cwd), toolCallEvent(session.id, "bash"));
      return undefined;
    }),
  );

  pi.on("tool_execution_start", async (event, _ctx) => {
    try {
      let cmd: string | null = null;
      if (event.toolName === "bash") {
        const command = (event.args as { command?: unknown } | undefined)?.command;
        if (typeof command === "string") cmd = normalizeCommand(command);
      }
      startTimes.set(event.toolCallId, { start: Date.now(), tool: event.toolName, cmd });
    } catch {
      // timing is best-effort
    }
    return undefined;
  });

  pi.on("tool_execution_end", async (event, ctx) =>
    attempt(ctx, async () => {
      const meta = startTimes.get(event.toolCallId);
      startTimes.delete(event.toolCallId);

      if (blockedToolCallIds.has(event.toolCallId)) {
        // Blocked in tool_call: the "result" here is the block reason, not a
        // real tool outcome. Recording it as a failed command would inflate
        // loop streaks (risk-declines and loop-blocks are not command runs).
        blockedToolCallIds.delete(event.toolCallId);
        return undefined;
      }

      const ms = meta ? Date.now() - meta.start : null;
      const { outChars, text } = textLengthOf(event.result);

      let cmd: string | null = null;
      let exit: number | null = null;
      let ok: boolean | null = !event.isError;
      if (event.toolName === "bash") {
        cmd = meta?.cmd ?? null;
        if (event.isError) {
          exit = bashExitFromResult(text);
          // Aborted/cancelled runs (isError with no parseable exit, e.g. the
          // user hitting Esc) are NOT failed runs: ok=null keeps them out of
          // loop streaks — both loop implementations ignore ok=null — while
          // the timing/size telemetry is kept.
          if (exit === null) ok = null;
        }
      }

      appendJsonl(
        eventsPath(ctx.cwd),
        toolResultEvent(session.id, event.toolName, { ok, ms, outChars, cmd, exit }),
      );

      // Incremental streak update (bash only; O(1) — no file re-read).
      // ok=null (aborted/unknown) leaves streaks untouched, like loops.py.
      if (cmd !== null && ok !== null) recordLoopOutcome(cmd, ok, exit);

      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  pi.on("turn_end", async (_event, ctx) =>
    attempt(ctx, async () => {
      // Context usage watermarks (goal #12)
      try {
        const usage = ctx.getContextUsage();
        if (usage && usage.percent !== null) {
          lastCtxPct = usage.percent;
          const step = Math.floor(usage.percent / 10) * 10;
          if (step >= cfg.ctx_warn_pct && step > state.notify_watermarks.ctx_pct) {
            state.notify_watermarks.ctx_pct = step;
            saveState(ctx.cwd, state);
            if (ctx.hasUI) {
              ctx.ui.notify(
                `guard: context at ${Math.round(usage.percent)}% — consider /compact to free budget.`,
                "warning",
              );
            }
          }
        }
      } catch {
        // usage is best-effort
      }

      // Diff budget (goal #8)
      const out = await runGit(ctx, ["diff", "--shortstat", "HEAD"]);
      if (out !== null) {
        const { files, lines } = parseShortstat(out);
        lastDiff = { files, lines };
        const wm = state.notify_watermarks;
        if (lines >= cfg.diff_hard_lines && wm.diff_lines < cfg.diff_hard_lines) {
          wm.diff_lines = cfg.diff_hard_lines;
          saveState(ctx.cwd, state);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `guard: diff reached ${lines} lines (hard limit ${cfg.diff_hard_lines}) — split before continuing.`,
              "error",
            );
          }
        } else if (lines >= cfg.diff_warn_lines && wm.diff_lines < cfg.diff_warn_lines) {
          wm.diff_lines = cfg.diff_warn_lines;
          saveState(ctx.cwd, state);
          if (ctx.hasUI) {
            ctx.ui.notify(
              `guard: diff reached ${lines} lines (warn ${cfg.diff_warn_lines}) — consider splitting.`,
              "warning",
            );
          }
        }
        if (files >= cfg.diff_warn_files && wm.diff_files < cfg.diff_warn_files) {
          wm.diff_files = cfg.diff_warn_files;
          saveState(ctx.cwd, state);
          if (ctx.hasUI) {
            ctx.ui.notify(`guard: diff touched ${files} files (warn ${cfg.diff_warn_files}) — check scope.`, "warning");
          }
        }
      }

      renderWidgetNow(ctx);
      return undefined;
    }),
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    // Idempotent persistence; no UI during shutdown.
    try {
      if (ctx?.cwd) saveState(ctx.cwd, state);
    } catch {
      // best-effort
    }
    return undefined;
  });

  // --- commands ----------------------------------------------------------

  pi.registerCommand("guard-status", {
    description: "protect-context: compact session status",
    handler: async (_args, ctx) =>
      attempt(ctx, async () => {
        const text = buildStatus(await gatherStatus(ctx));
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        return undefined;
      }),
  });

  pi.registerCommand("guard-contract", {
    description: "protect-context: contract list | add <text> | remove <id>",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const trimmed = (args ?? "").trim();
        const parts = trimmed.split(/\s+/);
        const verb = parts[0] ?? "";
        const rest = parts.slice(1).join(" ").trim();
        if (verb === "" || verb === "list") {
          const lines = contractLines(loadContract(ctx.cwd));
          if (ctx.hasUI) {
            ctx.ui.notify(
              `contract (${lines.length}):\n${lines.join("\n")}\nNudge: add missing constraints with /guard-contract add <text>.`,
              "info",
            );
          }
          return undefined;
        }
        if (verb === "add") {
          if (rest === "") {
            if (ctx.hasUI) ctx.ui.notify("usage: /guard-contract add <text>", "warning");
            return undefined;
          }
          const c = addConstraint(ctx.cwd, rest);
          const total = loadContract(ctx.cwd).constraints.length;
          if (ctx.hasUI) {
            // SPEC §5 caps the re-injected brief at 12 contract lines: a
            // constraint past the cap would be silently DROPPED while the
            // owner believes it is enforced — warn instead.
            const over = total > BRIEF_MAX_CONTRACT_LINES;
            const ack = over
              ? `added ${c.id}\nwarning: ${total} constraints exceed the ${BRIEF_MAX_CONTRACT_LINES}-line brief cap — ` +
                `constraints beyond ${BRIEF_MAX_CONTRACT_LINES} are NOT re-injected by the brief.` +
                `\nNudge: keep the contract tight — fewer, sharper constraints survive re-injection.`
              : `added ${c.id}\nNudge: the brief re-injects on your next prompt.`;
            ctx.ui.notify(ack, over ? "warning" : "info");
          }
          return undefined;
        }
        if (verb === "remove") {
          const removed = rest !== "" && removeConstraint(ctx.cwd, rest);
          if (ctx.hasUI) {
            ctx.ui.notify(
              removed
                ? `removed ${rest}\nNudge: the contract re-injects on your next prompt.`
                : `no constraint '${rest}'\nNudge: run /guard-contract list first.`,
              removed ? "info" : "warning",
            );
          }
          return undefined;
        }
        if (ctx.hasUI) ctx.ui.notify("usage: /guard-contract list | add <text> | remove <id>", "warning");
        return undefined;
      }),
  });

  pi.registerCommand("guard-verify", {
    description: "protect-context: run a command and record evidence",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const command = (args ?? "").trim();
        if (command === "") {
          if (ctx.hasUI) ctx.ui.notify("usage: /guard-verify <command>", "warning");
          return undefined;
        }
        const out = await runVerifyAndRecord(ctx, command, 180);
        if (ctx.hasUI) ctx.ui.notify(out, "info");
        return undefined;
      }),
  });

  pi.registerCommand("guard-note", {
    description: "protect-context: journal a decision|correction|risk|note",
    handler: async (args, ctx) =>
      attempt(ctx, async () => {
        const m = (args ?? "").trim().match(/^(\S+)\s+([\s\S]+)$/);
        const type = m && isJournalType(m[1]) ? m[1] : null;
        if (!type || !m) {
          if (ctx.hasUI) ctx.ui.notify("usage: /guard-note <decision|correction|risk|note> <text>", "warning");
          return undefined;
        }
        appendJournal(ctx.cwd, { type, text: m[2].trim() });
        if (ctx.hasUI) ctx.ui.notify(`journal: ${type} recorded\nNudge: check corrections before similar work.`, "info");
        return undefined;
      }),
  });

  pi.registerCommand("guard-report", {
    description: "protect-context: full session summary",
    handler: async (_args, ctx) =>
      attempt(ctx, async () => {
        const st = await gatherStatus(ctx);
        const lines: string[] = [buildStatus(st), "---"];
        lines.push(
          `config: loop_block_after=${cfg.loop_block_after} diff_warn=${cfg.diff_warn_lines}L/${cfg.diff_warn_files}f ` +
            `diff_hard=${cfg.diff_hard_lines}L ctx_warn=${cfg.ctx_warn_pct}% brief=${cfg.brief_mode} risk_confirm=${cfg.risk_confirm}`,
        );
        if (st.loops.length > 0) {
          lines.push(`loops: ${st.loops.map((l) => `'${truncLine(l.cmd, CMD_DISPLAY_MAX)}'x${l.failures}`).join(", ")}`);
        }
        lines.push("Nudge: use /guard-verify for evidence and /guard-note to persist decisions.");
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
        return undefined;
      }),
  });

  // --- model-callable tools ---------------------------------------------

  pi.registerTool({
    name: "guard_verify",
    label: "Guard Verify",
    description:
      "Run a verification command and record evidence (id, exit, digest) in .agent-guard/verify_runs.jsonl. " +
      "Never raises on nonzero exit — it records the failure. Cite the evidence id when claiming success. " +
      "timeout_s is clamped to [1, 900] so a runaway value cannot wedge the session.",
    promptSnippet: "Run a verification command and record evidence",
    promptGuidelines: [
      "Use guard_verify to run verification commands; cite the returned evidence id when claiming success.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run for verification" }),
      timeout_s: Type.Optional(Type.Integer({ description: "Timeout in seconds (default 180, clamped to 1–900)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const out = await runVerifyAndRecord(ctx, params.command, params.timeout_s ?? 180);
      return { content: [{ type: "text", text: out }], details: {} };
    },
  });

  pi.registerTool({
    name: "guard_note",
    label: "Guard Note",
    description:
      "Append a decision/correction/risk/note to the persistent journal (.agent-guard/journal.jsonl). " +
      "Corrections are re-injected into the brief on change.",
    promptSnippet: "Record a durable decision or correction in the journal",
    promptGuidelines: [
      "Use guard_note to record durable decisions; when corrected, log a tagged correction with type=correction.",
    ],
    parameters: Type.Object({
      type: StringEnum(["decision", "correction", "risk", "note"] as const),
      text: Type.String({ description: "What happened / what was decided" }),
      tags: Type.Optional(Type.Array(Type.String({ description: "Optional tags" }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const entry = appendJournal(ctx.cwd, { type: params.type, text: params.text, tags: params.tags ?? [] });
      return {
        content: [
          {
            type: "text",
            text: `journal: ${entry.type} recorded${entry.tags.length > 0 ? ` [${entry.tags.join(",")}]` : ""}\nNudge: check corrections before similar work.`,
          },
        ],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "guard_contract_check",
    label: "Guard Contract Check",
    description:
      "Deterministic checklist: marks each contract constraint addressed/unclear based on keyword coverage of a change summary. No LLM involved.",
    promptSnippet: "Check a change summary against the contract constraints",
    promptGuidelines: [
      "Use guard_contract_check with a change summary before claiming a task satisfies the contract.",
    ],
    parameters: Type.Object({
      summary: Type.String({ description: "Summary of the change made" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const contract = loadContract(ctx.cwd);
      const text = renderChecklist(checkContractSummary(params.summary, contract));
      return { content: [{ type: "text", text }], details: {} };
    },
  });

  pi.registerTool({
    name: "guard_status",
    label: "Guard Status",
    description:
      "Compact guardrail dashboard: session, diff, loop streaks, evidence count, contract size, last verify.",
    promptSnippet: "Show the protect-context status dashboard",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const text = buildStatus(await gatherStatus(ctx));
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
