/**
 * config.json load/merge (SPEC §2). Pure merge + fs load — no pi imports.
 */

import { DEFAULT_CONFIG, type GuardConfig } from "./defaults.ts";
import { configPath, readJson } from "./store.ts";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return null;
  return v as string[];
}

/**
 * Merge a partial config over the frozen defaults. Unknown keys are ignored;
 * wrong-typed values fall back to the default (deterministic, test-pinned).
 */
export function mergeConfig(partial: Record<string, unknown> | null | undefined): GuardConfig {
  const cfg: GuardConfig = { ...DEFAULT_CONFIG, preflight_tools: [...DEFAULT_CONFIG.preflight_tools] };
  if (!partial || typeof partial !== "object") return cfg;

  const p = partial as Record<string, unknown>;
  if (isFiniteNumber(p.loop_block_after) && p.loop_block_after >= 1) cfg.loop_block_after = p.loop_block_after;
  if (isFiniteNumber(p.diff_warn_lines) && p.diff_warn_lines >= 0) cfg.diff_warn_lines = p.diff_warn_lines;
  if (isFiniteNumber(p.diff_hard_lines) && p.diff_hard_lines >= 0) cfg.diff_hard_lines = p.diff_hard_lines;
  if (isFiniteNumber(p.diff_warn_files) && p.diff_warn_files >= 0) cfg.diff_warn_files = p.diff_warn_files;
  if (isFiniteNumber(p.ctx_warn_pct) && p.ctx_warn_pct >= 0 && p.ctx_warn_pct <= 100) cfg.ctx_warn_pct = p.ctx_warn_pct;
  if (p.brief_mode === "changed" || p.brief_mode === "always") cfg.brief_mode = p.brief_mode;
  if (typeof p.risk_confirm === "boolean") cfg.risk_confirm = p.risk_confirm;
  const tools = strArray(p.preflight_tools);
  if (tools) cfg.preflight_tools = [...tools];
  return cfg;
}

export interface LoadedConfig {
  config: GuardConfig;
  path: string;
  existed: boolean;
}

/** Load `.agent-guard/config.json` merged over defaults. Missing file → defaults. */
export function loadConfig(cwd: string): LoadedConfig {
  const path = configPath(cwd);
  const raw = readJson<Record<string, unknown>>(path);
  return { config: mergeConfig(raw ?? undefined), path, existed: raw !== null };
}
