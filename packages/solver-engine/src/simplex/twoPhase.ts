// The two-phase sequence both modes run: Phase 1 from the artificial basis, then Phase 2 from the
// feasible basis it ends on, and the result the two phases' logs make.

import { type DenseMatrix, extractColumn, hstackMatrices, identityMatrix } from "@lpviz/math/blas";
import { type FloatBlock, iteratesOf, type LogSection, type SolverResult } from "../result";
import { Basis, type StandardLp } from "./basis";
import { type PhaseConfig, type PhaseRun, simplexPhase, type SimplexStatus } from "./phase";

type SimplexMode = NonNullable<SolverResult["mode"]>;

export const UNBOUNDED_NOTE = "LP is unbounded. No leaving variable found.";

export type PhaseLog = Pick<PhaseRun, "count" | "log">;

// A phase that never ran: its log is the one line saying why.
export const skippedPhase = (reason: string): PhaseLog => ({ count: 0, log: { header: reason, rows: [] } });

/** The Phase-1 LP with its artificial basis, and the columns it was built around. */
export type Phase1Problem = { columns: DenseMatrix; lp: StandardLp; isBasic: boolean[] };

// The Phase-1 problem for {columns(gamma) x = gamma ∘ b, x >= 0}: rows are
// flipped so the right-hand side is nonnegative, one artificial column per row
// is appended, the objective is -sum(artificials) and they form the first basis.
export function phase1Problem(b: Float64Array, columnsOf: (gamma: Float64Array) => DenseMatrix): Phase1Problem {
  const gamma = Float64Array.from(b, (value) => (value < 0 ? -1 : 1));
  const flippedB = Float64Array.from(b, (value, index) => value * gamma[index]!);
  const columns = columnsOf(gamma);
  const { rows, cols } = columns;
  const lp: StandardLp = { A: hstackMatrices(columns, identityMatrix(rows)), b: flippedB, c: new Float64Array(cols + rows).fill(-1, cols) };
  const isBasic: boolean[] = new Array<boolean>(cols + rows).fill(false);
  for (let i = 0; i < rows; i++) isBasic[cols + i] = true;
  return { columns, lp, isBasic };
}

/**
 * Phase 1 from the artificial basis, then Phase 2 from the feasible basis it ends on; a
 * `warmBasis` (a vertex the caller verified) makes Phase 1 unnecessary. Phase 2 is null when
 * Phase 1 found no feasible point, and its run is then the log.
 */
export function runTwoPhase(
  phase1: Phase1Problem,
  phase2Lp: StandardLp,
  config: Omit<PhaseConfig, "phase">,
  { warmBasis = null, phase2UnboundedNote = config.unboundedNote }: { warmBasis?: boolean[] | null; phase2UnboundedNote?: string } = {},
): { phase1: PhaseLog; phase2: PhaseRun } | { phase1: PhaseRun; phase2: null } {
  let phase1Log: PhaseLog = skippedPhase("Skipped — warm start from the dragged start vertex.\n");
  let phase2Basis = warmBasis;
  if (!phase2Basis) {
    const run = simplexPhase(phase1.lp, phase1.isBasic, { ...config, phase: 1 });
    // The Phase-1 objective equals -(sum of artificial values), so a negative
    // optimum means no feasible point exists.
    if (run.objective < -config.tol) return { phase1: run, phase2: null };
    phase1Log = run;
    phase2Basis = pivotOutArtificialVariables(phase1.lp, run.isBasic, phase2Lp.A.cols, config.tol);
  }
  return { phase1: phase1Log, phase2: simplexPhase(phase2Lp, phase2Basis, { ...config, phase: 2, unboundedNote: phase2UnboundedNote }) };
}

export function simplexResult(iterates: FloatBlock, phase1: PhaseLog, phase2: PhaseLog, status: SimplexStatus, mode: SimplexMode): SolverResult {
  const outcome = status === "unbounded" ? "Unbounded LP" : status === "infeasible" ? "Infeasible LP" : null;
  // a run that did not end optimal keeps Phase 2's closing line as a note and names the outcome in the footer
  const { header, rows, notes = [], footer } = phase2.log;
  const closing: LogSection = outcome ? { header, rows, notes: footer === undefined ? notes : [...notes, footer], footer: outcome } : phase2.log;
  return {
    iterates: iteratesOf(iterates),
    // the phase of each iterate, only once there are two phases to tell apart
    ...(phase1.count > 0 ? { phases: [...new Array<number>(phase1.count).fill(0), ...new Array<number>(phase2.count).fill(1)] } : {}),
    log: [phase1.log, closing],
    status,
    mode,
  };
}

// Drives any artificial variable still basic after Phase 1 out of the basis by swapping in the
// lowest-index original column with a nonzero pivot. A basis repair step, deliberately
// independent of the selected pivot rules.
function pivotOutArtificialVariables(phase1: StandardLp, isBasic: readonly boolean[], originalColumnCount: number, tol: number): boolean[] {
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
