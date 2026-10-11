import { type DenseMatrix, extractColumn, hstackMatrices, identityMatrix } from "@lpviz/math/blas";
import { fmtIterate, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders } from "../fmt";
import { MAX_ITERATIONS } from "../limits";
import type { LogSection, SolverResult } from "../result";
import { Basis, basicSolution, phaseScratch, type StandardLp } from "./basis";
import { createCyclingGuard, type PivotRules, selectEnteringIndex, selectLeavingIndex } from "./pivotRules";

export type SimplexStatus = NonNullable<SolverResult["status"]>;
type SimplexMode = NonNullable<SolverResult["mode"]>;

export const UNBOUNDED_NOTE = "LP is unbounded. No leaving variable found.";

const basisString = (isBasic: readonly boolean[]) => isBasic.map((basic) => (basic ? 1 : 0)).join("");

export interface PhaseConfig {
  tol: number;
  pivotRules: PivotRules;
  phase: 1 | 2;
  /** the problem's variable count, which sizes the log's coordinate columns */
  dimension: number;
  /** The point an iteration plots and logs, from the basic solution and the basis. */
  pointOf: (x: Float64Array, basis: Basis) => Float64Array;
  /** the line logged when no leaving variable exists */
  unboundedNote: string;
}

/** What a phase hands on: its iterates and log, and the basis and objective it ended on. */
interface PhaseRun {
  iterates: Float64Array[];
  log: LogSection;
  isBasic: boolean[];
  objective: number;
  status: SimplexStatus;
}

export function simplexPhase(lp: StandardLp, initialBasis: readonly boolean[], cfg: PhaseConfig): PhaseRun {
  const { tol, pivotRules, phase, dimension, pointOf, unboundedNote } = cfg;
  const { A } = lp;
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(dimension)} ${"basis".padEnd(A.cols)}\n`;
  const rows: string[] = [];
  const notes: string[] = [];
  const iterates: Float64Array[] = [];
  const guard = createCyclingGuard(pivotRules, tol);
  const basis = new Basis(A, initialBasis);
  const scratch = phaseScratch(basis.m, A.cols);
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
    rows.push(`${fmtIteration(iteration, guard.active ? "d" : "")} ${fmtIterate(point, objective)} ${basisString(basis.isBasic)}\n`);

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
  return { iterates, log: { header, rows, notes, footer }, isBasic, objective, status };
}

export type PhaseLog = Pick<PhaseRun, "iterates" | "log">;

// A phase that never ran: its log is the one line saying why.
export const skippedPhase = (reason: string): PhaseLog => ({ iterates: [], log: { header: reason, rows: [] } });

export function simplexResult(phase1: PhaseLog, phase2: PhaseLog, status: SimplexStatus, mode: SimplexMode): SolverResult {
  const outcome = status === "unbounded" ? "Unbounded LP" : status === "infeasible" ? "Infeasible LP" : null;
  // a run that did not end optimal keeps Phase 2's closing line as a note and names the outcome in the footer
  const { header, rows, notes = [], footer } = phase2.log;
  const closing: LogSection = outcome ? { header, rows, notes: footer === undefined ? notes : [...notes, footer], footer: outcome } : phase2.log;
  return {
    iterates: [...phase1.iterates, ...phase2.iterates],
    // the phase of each iterate, only once there are two phases to tell apart
    ...(phase1.iterates.length > 0 ? { phases: [...phase1.iterates.map(() => 0), ...phase2.iterates.map(() => 1)] } : {}),
    log: [phase1.log, closing],
    status,
    mode,
  };
}

// Drives any artificial variable still basic after Phase 1 out of the basis by swapping in the
// lowest-index original column with a nonzero pivot. A basis repair step, deliberately
// independent of the selected pivot rules.
export function pivotOutArtificialVariables(phase1: StandardLp, isBasic: readonly boolean[], originalColumnCount: number, tol: number): boolean[] {
  const { A } = phase1;
  const column = new Float64Array(A.rows);
  const direction = new Float64Array(A.rows);
  const basis = new Basis(A, isBasic);

  while (true) {
    const rowIndex = basis.columns.findIndex((index) => index >= originalColumnCount);
    if (rowIndex === -1) break;
    let replacement = -1;

    for (let j = 0; j < originalColumnCount; j++) {
      if (basis.isBasic[j]) continue;
      extractColumn(A, j, column);
      basis.apply(column, direction);
      if (Math.abs(direction[rowIndex]!) > tol) {
        replacement = j;
        break;
      }
    }

    if (replacement === -1) {
      throw new Error("Could not pivot artificial variables out of the Phase 1 basis.");
    }
    basis.pivot(rowIndex, direction, replacement);
  }

  const phase2Basis = basis.isBasic.slice(0, originalColumnCount);
  if (phase2Basis.filter(Boolean).length !== A.rows) {
    throw new Error("Phase 1 did not produce a valid Phase 2 basis.");
  }
  return phase2Basis;
}

// The Phase-1 problem for {columns(gamma) x = gamma ∘ b, x >= 0}: rows are
// flipped so the right-hand side is nonnegative, one artificial column per row
// is appended, the objective is -sum(artificials) and they form the first basis.
export function phase1Problem(b: Float64Array, columnsOf: (gamma: Float64Array) => DenseMatrix) {
  const gamma = Float64Array.from(b, (value) => (value < 0 ? -1 : 1));
  const flippedB = Float64Array.from(b, (value, index) => value * gamma[index]!);
  const columns = columnsOf(gamma);
  const { rows, cols } = columns;
  const lp: StandardLp = { A: hstackMatrices(columns, identityMatrix(rows)), b: flippedB, c: new Float64Array(cols + rows).fill(-1, cols) };
  const isBasic: boolean[] = new Array<boolean>(cols + rows).fill(false);
  for (let i = 0; i < rows; i++) isBasic[cols + i] = true;
  return { columns, lp, isBasic };
}
