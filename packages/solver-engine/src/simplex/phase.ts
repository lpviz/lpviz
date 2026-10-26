import { extractColumn } from "@lpviz/math/blas";
import { fmtIterate, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders } from "../fmt";
import { MAX_ITERATIONS } from "../limits";
import type { FloatBlock, LogSection, SolverResult } from "../result";
import { Basis, basicSolution, phaseScratch, type StandardLp } from "./basis";
import { createCyclingGuard, type PivotRules, selectEnteringIndex, selectLeavingIndex } from "./pivotRules";

export type SimplexStatus = NonNullable<SolverResult["status"]>;

const basisString = (isBasic: readonly boolean[]) => isBasic.map((basic) => (basic ? 1 : 0)).join("");

export interface PhaseConfig {
  tol: number;
  pivotRules: PivotRules;
  phase: 1 | 2;
  /** the problem's variable count, which sizes the log's coordinate columns */
  dimension: number;
  /** the run's iterates, which both phases append to */
  iterates: FloatBlock;
  /** The point an iteration plots and logs, from the basic solution and the basis. */
  pointOf: (x: Float64Array, basis: Basis) => Float64Array;
  /** the line logged when no leaving variable exists */
  unboundedNote: string;
  /** dual mode: Phase 2 maximizes -b'y, logged as the dual objective b'y, the primal value it bounds */
  negatePhase2Objective?: boolean | undefined;
}

/** What a phase hands on: how many iterates it appended and its log, and the basis and objective it ended on. */
export interface PhaseRun {
  count: number;
  log: LogSection;
  isBasic: boolean[];
  objective: number;
  status: SimplexStatus;
}

export function simplexPhase(lp: StandardLp, initialBasis: readonly boolean[], cfg: PhaseConfig): PhaseRun {
  const { tol, pivotRules, phase, dimension, iterates, pointOf, unboundedNote } = cfg;
  const { A } = lp;
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(dimension)} ${"basis".padEnd(A.cols)}\n`;
  const rows: string[] = [];
  const notes: string[] = [];
  let count = 0;
  const guard = createCyclingGuard(pivotRules, tol);
  const basis = new Basis(A, initialBasis);
  const scratch = phaseScratch(lp);
  const { xB, enterColumn, direction } = scratch;

  let iteration = 0;
  let status: SimplexStatus = "optimal";
  let objective = 0;

  while (true) {
    if (++iteration > MAX_ITERATIONS) throw new Error(`Simplex stalled after ${MAX_ITERATIONS} iterations`);

    let solution = basicSolution(lp, basis, scratch, false);
    let entering = selectEnteringIndex(basis.isBasic, solution.reducedCosts, tol, guard.rules.entering);

    if (entering === -1 && basis.stale) {
      // Optimality was claimed from the eta-updated inverse, whose accumulated error can hide a
      // positive reduced cost: confirm it from a fresh factorization and exact solves.
      basis.refactor();
      solution = basicSolution(lp, basis, scratch, true);
      entering = selectEnteringIndex(basis.isBasic, solution.reducedCosts, tol, guard.rules.entering);
    }
    objective = solution.objective;
    const point = pointOf(solution.x, basis);
    iterates.push(point);
    count++;
    rows.push(`${fmtIteration(iteration, guard.active ? "d" : "")} ${fmtIterate(point, phase === 2 && cfg.negatePhase2Objective ? -objective : objective)} ${basisString(basis.isBasic)}\n`);

    if (entering === -1) break;

    extractColumn(A, entering, enterColumn);
    basis.apply(enterColumn, direction);

    const leavingRow = selectLeavingIndex(xB, direction, basis.columns, tol, guard.rules.leaving);
    if (leavingRow === -1) {
      notes.push(unboundedNote);
      status = "unbounded";
      break;
    }

    guard.recordPivot(xB[leavingRow]! / direction[leavingRow]!);
    basis.pivot(leavingRow, direction, entering);
  }

  const isBasic = basis.isBasic.slice();
  const footer = `Phase ${phase} finished in ${iteration} iterations – basis ${basisString(isBasic)}\n`;
  return { count, log: { header, rows, notes, footer }, isBasic, objective, status };
}
