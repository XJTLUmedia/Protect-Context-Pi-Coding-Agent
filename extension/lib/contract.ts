/**
 * Contract store CRUD (SPEC §1 #1, §2, §5). No pi imports.
 */

import { existsSync } from "node:fs";
import { DEFAULT_CONTRACT, type Constraint, type Contract } from "./defaults.ts";
import { contractPath, readJson, storeDir, withStoreLock, writeJson } from "./store.ts";
import { normalizeOneLine } from "./text.ts";

/** Free-text cap (chars): constraint text flows into re-injected briefs (goal #12). */
export const TEXT_CAP = 500;
export const CONTRACT_RENDER_MAX = 24;

export class ContractIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractIntegrityError";
  }
}

/**
 * Load the contract, seeding `.agent-guard/contract.json` from DEFAULT_CONTRACT
 * only when the file does not exist. A corrupt/unreadable file falls back to
 * in-memory defaults WITHOUT writing, so a transient read error or corruption
 * can never silently destroy the user's constraints (mirrors contract.load()
 * on the Python side).
 */
function cloneDefaultContract(): Contract {
  return JSON.parse(JSON.stringify(DEFAULT_CONTRACT)) as Contract;
}

function isConstraint(value: unknown): value is Constraint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.text === "string" &&
    typeof row.added === "string" &&
    typeof row.source === "string"
  );
}

/** Caller must hold the shared store lease. */
function loadContractUnlocked(cwd: string, forMutation = false): Contract {
  const file = contractPath(cwd);
  if (!existsSync(file)) {
    const seeded = cloneDefaultContract();
    saveContractUnlocked(cwd, seeded);
    return seeded;
  }
  const existing = readJson<unknown>(file);
  if (existing && typeof existing === "object" && Array.isArray((existing as { constraints?: unknown }).constraints)) {
    const rows = (existing as { constraints: unknown[] }).constraints;
    const constraints = rows.filter(isConstraint);
    if (forMutation && constraints.length !== rows.length) {
      throw new ContractIntegrityError(
        "contract contains malformed rows; repair .agent-guard/contract.json before mutating it",
      );
    }
    // A non-empty list with no valid records is effectively corrupt. Serve
    // frozen seeds in memory, but never overwrite the owner's damaged file.
    if (rows.length > 0 && constraints.length === 0) return cloneDefaultContract();
    return { version: 1, constraints };
  }
  if (forMutation) {
    throw new ContractIntegrityError(
      "contract file is malformed; repair .agent-guard/contract.json before mutating it",
    );
  }
  return cloneDefaultContract();
}

/** Caller must hold the shared store lease. */
function saveContractUnlocked(cwd: string, contract: Contract): void {
  writeJson(contractPath(cwd), contract);
}

export function loadContract(cwd: string): Contract {
  return withStoreLock(storeDir(cwd), () => loadContractUnlocked(cwd));
}

export function saveContract(cwd: string, contract: Contract): void {
  withStoreLock(storeDir(cwd), () => saveContractUnlocked(cwd, contract));
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

export interface AddConstraintResult {
  constraint: Constraint;
  added: boolean;
  total: number;
}

export function addConstraintWithStatus(cwd: string, text: string, source = "agent"): AddConstraintResult {
  const cleanText = normalizeOneLine(text, TEXT_CAP);
  if (cleanText === "") throw new Error("constraint text must not be blank");
  return withStoreLock(storeDir(cwd), () => {
    const contract = loadContractUnlocked(cwd, true);
    const existing = contract.constraints.find((constraint) => normalizeOneLine(constraint.text, TEXT_CAP) === cleanText);
    if (existing) return { constraint: existing, added: false, total: contract.constraints.length };
    const constraint: Constraint = {
      id: nextConstraintId(contract.constraints),
      text: cleanText,
      added: new Date().toISOString().slice(0, 10),
      source: normalizeOneLine(source, 40) || "agent",
    };
    contract.constraints.push(constraint);
    saveContractUnlocked(cwd, contract);
    return { constraint, added: true, total: contract.constraints.length };
  });
}

export function addConstraint(cwd: string, text: string, source = "agent"): Constraint {
  return addConstraintWithStatus(cwd, text, source).constraint;
}

export function removeConstraint(cwd: string, id: string): boolean {
  return withStoreLock(storeDir(cwd), () => {
    const contract = loadContractUnlocked(cwd, true);
    const before = contract.constraints.length;
    contract.constraints = contract.constraints.filter((c) => c.id !== id);
    if (contract.constraints.length === before) return false;
    saveContractUnlocked(cwd, contract);
    return true;
  });
}

/** Bounded compact lines: frozen seeds plus the newest remaining entries. */
export function contractLines(contract: Contract): string[] {
  const constraints = contract.constraints;
  let visible = constraints;
  if (constraints.length > CONTRACT_RENDER_MAX) {
    const seedIndexes = constraints
      .map((constraint, index) => ({ constraint, index }))
      .filter(({ constraint }) => constraint.source === "seed")
      .map(({ index }) => index)
      .slice(0, CONTRACT_RENDER_MAX);
    const selected = new Set(seedIndexes);
    for (let index = constraints.length - 1; index >= 0 && selected.size < CONTRACT_RENDER_MAX; index -= 1) {
      selected.add(index);
    }
    visible = constraints.filter((_constraint, index) => selected.has(index));
  }
  const lines = visible.map((c) => {
    const id = normalizeOneLine(c.id, 80) || "(missing-id)";
    return `${id}: ${normalizeOneLine(c.text, TEXT_CAP)}`;
  });
  if (visible.length < constraints.length) {
    lines.unshift(`… ${constraints.length - visible.length} older non-seed constraints omitted`);
  }
  return lines;
}
