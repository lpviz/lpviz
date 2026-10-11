// Which variable enters the basis and which leaves: the rule vocabulary the UI exposes, the two
// selections, and the guard that falls back to Bland's rule when a phase looks like cycling.

/**
 * Pivot-selection rules for the entering variable (the UI labels them
 * Dantzig / Bland (low) / Bland (high)):
 *  - "coeff": the non-basic column with the largest positive reduced cost
 *    (Dantzig's rule); ties break to the lowest column index.
 *  - "first": the lowest-index non-basic column with a positive reduced cost
 *    (Bland's rule). Paired with leaving rule "first" it provably never
 *    cycles, which is why it is the default.
 *  - "last": the highest-index such column.
 */
export const ENTERING_RULES = ["coeff", "first", "last"] as const;
export type EnteringRule = (typeof ENTERING_RULES)[number];

/**
 * Tie-break for the ratio test (leaving variable): among rows within `tol` of
 * the minimum ratio, "first" keeps the lowest original column index and
 * "last" the highest.
 */
export const LEAVING_RULES = ["first", "last"] as const;
export type LeavingRule = (typeof LEAVING_RULES)[number];

export type PivotRules = { entering: EnteringRule; leaving: LeavingRule };

// Bland's rule on both sides: the default, and the only combination with a
// termination guarantee.
const BLAND_RULES: PivotRules = { entering: "first", leaving: "first" };

export const isEnteringRule = (value: unknown): value is EnteringRule => (ENTERING_RULES as readonly unknown[]).includes(value);
export const isLeavingRule = (value: unknown): value is LeavingRule => (LEAVING_RULES as readonly unknown[]).includes(value);

export type PivotRuleOptions = {
  /** Entering-variable pivot rule (see ENTERING_RULES). Defaults to "first" (Bland). */
  enteringRule?: EnteringRule | undefined;
  /** Ratio-test tie-break (see LEAVING_RULES). Defaults to "first" (lowest index). */
  leavingRule?: LeavingRule | undefined;
};

// Unknown values (e.g. from a hand-edited share link) degrade to the default.
export function resolvePivotRules(opts: PivotRuleOptions): PivotRules {
  return {
    entering: isEnteringRule(opts.enteringRule) ? opts.enteringRule : BLAND_RULES.entering,
    leaving: isLeavingRule(opts.leavingRule) ? opts.leavingRule : BLAND_RULES.leaving,
  };
}

// Only Bland's rule (lowest index entering and leaving) is guaranteed not to cycle, so after this
// many consecutive degenerate pivots (minimum ratio ~ 0) a simplex phase falls back to it for the
// rest of the phase; those iterations carry a "d" after their number in the log. A legitimately
// degenerate vertex in the app's problems needs only a handful, and a false trigger is harmless.
export const MAX_CONSECUTIVE_DEGENERATE_PIVOTS = 25;

export function selectEnteringIndex(isBasic: readonly boolean[], reducedCosts: Float64Array, tol: number, rule: EnteringRule): number {
  if (rule === "first") {
    for (let j = 0; j < reducedCosts.length; j++) {
      if (!isBasic[j] && reducedCosts[j]! > tol) return j;
    }
    return -1;
  }
  if (rule === "last") {
    for (let j = reducedCosts.length - 1; j >= 0; j--) {
      if (!isBasic[j] && reducedCosts[j]! > tol) return j;
    }
    return -1;
  }
  let best = -1;
  let bestCost = -Infinity;
  for (let j = 0; j < reducedCosts.length; j++) {
    if (isBasic[j] || reducedCosts[j]! <= tol) continue;
    // strict `>` keeps the lowest index on ties
    if (reducedCosts[j]! > bestCost) {
      bestCost = reducedCosts[j]!;
      best = j;
    }
  }
  return best;
}

export function selectLeavingIndex(xB: Float64Array, direction: Float64Array, columns: readonly number[], tol: number, rule: LeavingRule): number {
  // Pass 1: the minimum ratio over the rows the entering variable drives down.
  let minRatio = Infinity;
  for (let i = 0; i < xB.length; i++) {
    if (direction[i]! <= tol) continue;
    minRatio = Math.min(minRatio, xB[i]! / direction[i]!);
  }
  if (minRatio === Infinity) return -1;

  // Pass 2: among rows within tol of that minimum, break the tie by original
  // column index. A second pass keeps the tie set anchored to the true minimum
  // rather than to whichever near-tie happened to be scanned first.
  let leave = -1;
  let chosenIndex = -1;
  for (let i = 0; i < xB.length; i++) {
    if (direction[i]! <= tol) continue;
    if (xB[i]! / direction[i]! - minRatio >= tol) continue;
    const originalIndex = columns[i]!;
    const prefer = leave === -1 || (rule === "first" ? originalIndex < chosenIndex : originalIndex > chosenIndex);
    if (prefer) {
      leave = i;
      chosenIndex = originalIndex;
    }
  }
  return leave;
}

export function createCyclingGuard(initial: PivotRules, tol: number) {
  const rules: PivotRules = { ...initial };
  let degeneratePivots = 0;
  let active = false;
  return {
    rules,
    /** True once the guard has switched this phase to Bland's rule. */
    get active() {
      return active;
    },
    /** Record the step length (minimum ratio) of the pivot just taken. */
    recordPivot(step: number) {
      degeneratePivots = step <= tol ? degeneratePivots + 1 : 0;
      if (active || degeneratePivots <= MAX_CONSECUTIVE_DEGENERATE_PIVOTS) return;
      if (rules.entering === BLAND_RULES.entering && rules.leaving === BLAND_RULES.leaving) return;
      rules.entering = BLAND_RULES.entering;
      rules.leaving = BLAND_RULES.leaving;
      active = true;
    },
  };
}
