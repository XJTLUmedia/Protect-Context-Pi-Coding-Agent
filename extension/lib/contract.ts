/**
 * Contract store CRUD (SPEC §1 #1, §2, §5). No pi imports.
 */

import { existsSync } from "node:fs";
import { DEFAULT_CONTRACT, type Constraint, type Contract } from "./defaults.ts";
import { contractPath, readJson, writeJson } from "./store.ts";

/** Free-text cap (chars): constraint text flows into re-injected briefs (goal #12). */
export const TEXT_CAP = 500;

/**
 * Load the contract, seeding `.agent-guard/contract.json` from DEFAULT_CONTRACT
 * only when the file does not exist. A corrupt/unreadable file falls back to
 * in-memory defaults WITHOUT writing, so a transient read error or corruption
 * can never silently destroy the user's constraints (mirrors contract.load()
 * on the Python side).
 */
export function loadContract(cwd: string): Contract {
  const file = contractPath(cwd);
  if (!existsSync(file)) {
    const seeded: Contract = JSON.parse(JSON.stringify(DEFAULT_CONTRACT)) as Contract;
    saveContract(cwd, seeded);
    return seeded;
  }
  const existing = readJson<Contract>(file);
  if (existing && Array.isArray(existing.constraints)) {
    return { version: 1, constraints: existing.constraints };
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONTRACT)) as Contract;
}

export function saveContract(cwd: string, contract: Contract): void {
  writeJson(contractPath(cwd), contract);
}

/** Next sequential id, e.g. "13" after the 12 seeded constraints. */
export function nextConstraintId(constraints: Constraint[]): string {
  let max = 0;
  for (const c of constraints) {
    const m = c.id.match(/^(\d+)(?:-|$)/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return String(max + 1).padStart(2, "0");
}

export function addConstraint(cwd: string, text: string, source = "agent"): Constraint {
  const contract = loadContract(cwd);
  const constraint: Constraint = {
    id: nextConstraintId(contract.constraints),
    text: text.trim().slice(0, TEXT_CAP),
    added: new Date().toISOString().slice(0, 10),
    source,
  };
  contract.constraints.push(constraint);
  saveContract(cwd, contract);
  return constraint;
}

export function removeConstraint(cwd: string, id: string): boolean {
  const contract = loadContract(cwd);
  const before = contract.constraints.length;
  contract.constraints = contract.constraints.filter((c) => c.id !== id);
  if (contract.constraints.length === before) return false;
  saveContract(cwd, contract);
  return true;
}

/** One compact line per constraint: `<id>: <text>`. */
export function contractLines(contract: Contract): string[] {
  return contract.constraints.map((c) => `${c.id}: ${c.text}`);
}
