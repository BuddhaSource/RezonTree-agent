// budget/index.ts — a spend cap an agent (or swarm) spends down to, then stops.
//
// Real funds on Base mainnet flow through every action (sponsor amounts, commit
// stakes, vote stakes, fees). A Budget is the agent's own spending governor:
// it tracks cumulative committed USDC against a hard cap and answers two
// questions — "can I afford this next action?" and "is there anything
// meaningful left to spend?" When the answer to the second is no, the agent
// stops rather than grinding the wallet to dust.
//
// PURE + DETERMINISTIC: no clock, no randomness, no I/O. The caller decides
// WHEN to check/record; this module only does the arithmetic. Units are whole
// USDC (human decimals, e.g. 10 = $10), not token base units — the swarm reads
// its per-action cost from the same RT-config string (ORGANIC_SPONSOR_AMOUNT)
// and feeds it here directly.

export interface Budget {
  /** Total USDC the agent may spend over its lifetime (e.g. 10 = $10). */
  capUsd: number;
  /** Cumulative USDC already committed across all actions. */
  spentUsd: number;
  /** Headroom left: max(0, cap - spent). Never negative. */
  remainingUsd(): number;
  /** True when `usd` still fits under the cap (remaining >= usd). */
  canAfford(usd: number): boolean;
  /** Commit `usd` of spend. Call AFTER an action confirms on-chain. */
  record(usd: number): void;
  /**
   * True when there is nothing meaningful left to spend — i.e. the remaining
   * headroom is below `floorUsd`, the cheapest action the agent could take.
   * With no floor (or 0) this is the "exactly exhausted" check (remaining < 0
   * never happens, so it's effectively remaining === 0).
   */
  exhausted(floorUsd?: number): boolean;
}

/** Round to whole cents so float accumulation can't drift the cap by ε. */
function cents(usd: number): number {
  return Math.round(usd * 100) / 100;
}

class SpendBudget implements Budget {
  capUsd: number;
  spentUsd: number;

  constructor(capUsd: number) {
    this.capUsd = capUsd;
    this.spentUsd = 0;
  }

  remainingUsd(): number {
    return Math.max(0, cents(this.capUsd - this.spentUsd));
  }

  canAfford(usd: number): boolean {
    return this.remainingUsd() >= cents(usd);
  }

  record(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) {
      throw new Error(`Budget.record: usd must be a non-negative number, got ${usd}`);
    }
    this.spentUsd = cents(this.spentUsd + usd);
  }

  exhausted(floorUsd?: number): boolean {
    return this.remainingUsd() < cents(floorUsd ?? 0);
  }
}

/** Create a budget with a positive USDC cap. Throws on cap <= 0 (a zero/
 *  negative cap is a config error — an agent that can never spend shouldn't
 *  silently run). */
export function createBudget(capUsd: number): Budget {
  if (!Number.isFinite(capUsd) || capUsd <= 0) {
    throw new Error(`createBudget: capUsd must be a positive number, got ${capUsd}`);
  }
  return new SpendBudget(capUsd);
}

/** Read a budget from RT_BUDGET_USD. Returns null when unset/blank (no cap —
 *  behavior is unchanged). A set-but-invalid value (non-numeric or <= 0)
 *  throws via createBudget, so a typo'd cap fails fast rather than running
 *  uncapped. */
export function budgetFromEnv(): Budget | null {
  const raw = process.env.RT_BUDGET_USD;
  if (raw === undefined || raw.trim() === "") return null;
  return createBudget(Number(raw));
}
