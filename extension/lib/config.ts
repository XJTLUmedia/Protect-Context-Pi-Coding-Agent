/**
 * config.json load/merge (SPEC §2). Pure merge + fs load — no pi imports.
 */

import { existsSync } from "node:fs";
import { DEFAULT_CONFIG, type GuardConfig } from "./defaults.ts";
import { configPath, readJson, storeDir, withStoreLock, writeJson } from "./store.ts";

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
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
  if (isInteger(p.loop_block_after) && p.loop_block_after >= 1) cfg.loop_block_after = p.loop_block_after;
  if (isInteger(p.diff_warn_lines) && p.diff_warn_lines >= 0) cfg.diff_warn_lines = p.diff_warn_lines;
  if (isInteger(p.diff_hard_lines) && p.diff_hard_lines >= 0) cfg.diff_hard_lines = p.diff_hard_lines;
  if (isInteger(p.diff_warn_files) && p.diff_warn_files >= 0) cfg.diff_warn_files = p.diff_warn_files;
  if (isInteger(p.ctx_warn_pct) && p.ctx_warn_pct >= 0 && p.ctx_warn_pct <= 100) cfg.ctx_warn_pct = p.ctx_warn_pct;
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

/** Load `.agent-guard/config.json` merged over defaults. Missing file →
 * defaults; extension startup can request an on-disk seed so an extension-only
 * install has the documented configuration surface without first running the
 * Python CLI. Existing corrupt files are never overwritten. */
function readLoadedConfig(cwd: string): LoadedConfig {
  const path = configPath(cwd);
  const existed = existsSync(path);
  const raw = readJson<Record<string, unknown>>(path);
  const config = mergeConfig(raw ?? undefined);
  return { config, path, existed };
}

export function loadConfig(cwd: string, seedMissing = false): LoadedConfig {
  if (!seedMissing) return readLoadedConfig(cwd);
  // Serialize and re-check the whole missing→seed transition. Without the
  // second read inside the lease, an owner-written config could be replaced
  // by defaults between an optimistic exists() and writeJson().
  return withStoreLock(storeDir(cwd), () => {
    const loaded = readLoadedConfig(cwd);
    if (!loaded.existed) writeJson(loaded.path, loaded.config);
    return loaded;
  });
}
