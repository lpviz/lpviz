// Two-phase simplex on `max c'x s.t. Ax <= b`: this file is the entry, the warm start and the dual
// mode; the basis, the pivot rules and a phase's walk are in simplex/.

import { createDenseMatrix, type DenseMatrix, denseFromConstraints, diagonalMatrix, hstackMatrices, negateMatrix, scaleRows, transposeMatrix } from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import type { SolverResult } from "./result";
import { Basis, basicSolution, phaseScratch, type StandardLp } from "./simplex/basis";
import { type PhaseConfig, type PhaseLog, phase1Problem, pivotOutArtificialVariables, simplexPhase, simplexResult, type SimplexStatus, skippedPhase, UNBOUNDED_NOTE } from "./simplex/phase";
import { type PivotRuleOptions, resolvePivotRules } from "./simplex/pivotRules";
import { splitStandardForm, unsplit } from "./standardForm";

export { ENTERING_RULES, type EnteringRule, isEnteringRule, isLeavingRule, LEAVING_RULES, type LeavingRule, MAX_CONSECUTIVE_DEGENERATE_PIVOTS } from "./simplex/pivotRules";

export interface SimplexOptions extends PivotRuleOptions {
  tol: number;
  /** Walk the dual LP instead; each dual basis is plotted as the primal vertex it identifies. */
  dual: boolean;
  /**
   * Optional warm start: a vertex of {Ax <= b} to begin Phase 2 from,
   * skipping Phase 1. Primal mode only — a primal point determines a
   * dual-feasible basis only when it is already optimal (by complementary
   * slackness), so dual simplex mode ignores it.
   */
  startVertex?: readonly number[] | undefined;
}

// A warm-start vertex must be reproduced by its basis to this relative precision.
const WARM_START_VERTEX_TOLERANCE = 1e-6;

// The primal vertex a dual basis identifies: the intersection of the n lowest-index constraint
// planes whose dual variables are basic. Two variables keep their closed form; more go through a
// dense solve, and a singular support yields the origin either way.
function primalPointFromDualBasis(A: DenseMatrix, b: Float64Array, columns: readonly number[], tol: number): Float64Array {
  const n = A.cols;
  const support = [...columns]
    .sort((p, q) => p - q)
    .filter((index) => index < A.rows)
    .slice(0, n);
  if (support.length < n) return new Float64Array(n);

  if (n === 2) {
    const [i, k] = support as [number, number];
    const a11 = A.data[i * 2]!;
    const a12 = A.data[i * 2 + 1]!;
    const a21 = A.data[k * 2]!;
    const a22 = A.data[k * 2 + 1]!;
    const determinant = a11 * a22 - a12 * a21;
    if (Math.abs(determinant) <= tol) return new Float64Array(2);

    const x = (b[i]! * a22 - a12 * b[k]!) / determinant;
    const y = (a11 * b[k]! - b[i]! * a21) / determinant;
    return Float64Array.of(x, y);
  }

  const matrix = new Float64Array(n * n);
  const rhs = new Float64Array(n);
  for (let row = 0; row < n; row++) {
    const source = support[row]!;
    for (let j = 0; j < n; j++) matrix[row * n + j] = A.data[source * n + j]!;
    rhs[row] = b[source]!;
  }
  const point = new Float64Array(n);
  try {
    solveDenseSystem(matrix, n, rhs, point);
  } catch {
    return new Float64Array(n);
  }
  return point.every(Number.isFinite) ? point : new Float64Array(n);
}

function solveDualMode(A: DenseMatrix, b: Float64Array, objective: Float64Array, cfg: Pick<PhaseConfig, "tol" | "pivotRules">): SolverResult {
  const { tol, pivotRules } = cfg;
  const dual = dropRedundantRows(transposeMatrix(A), Float64Array.from(objective), tol);
  const cDual = Float64Array.from(b, (value) => -value);
  const { columns: aPhase2, lp: phase1Lp, isBasic: phase1Basis } = phase1Problem(dual.b, (gamma) => scaleRows(dual.A, gamma));
  const config: Omit<PhaseConfig, "phase"> = { tol, pivotRules, dimension: A.cols, pointOf: (_, basis) => primalPointFromDualBasis(A, b, basis.columns, tol), unboundedNote: UNBOUNDED_NOTE };

  const phase1 = simplexPhase(phase1Lp, phase1Basis, { ...config, phase: 1 });

  if (Math.abs(phase1.objective) > tol) {
    // The dual LP is infeasible; the region is non-empty (emptiness is rejected before the
    // solver runs), so by LP duality the primal is unbounded. Still plot the Phase 1 trajectory.
    return simplexResult(phase1, skippedPhase("The dual LP is infeasible, so the primal LP is unbounded.\n"), "unbounded", "dual");
  }

  const phase2Basis = pivotOutArtificialVariables(phase1Lp, phase1.isBasic, aPhase2.cols, tol);
  // An unbounded dual means the primal LP being visualized is infeasible.
  const phase2 = simplexPhase({ A: aPhase2, b: phase1Lp.b, c: cDual }, phase2Basis, { ...config, phase: 2, unboundedNote: "Dual LP is unbounded: the LP is infeasible." });
  const status: SimplexStatus = phase2.status === "unbounded" ? "infeasible" : phase2.status;
  return simplexResult(phase1, phase2, status, "dual");
}

// Rows of the dual system that are identically zero with a zero right-hand side are redundant
// (0 = 0); Phase 1 can never pivot their artificial variables out of the basis, so drop them up front.
function dropRedundantRows(A: DenseMatrix, b: Float64Array, tol: number): { A: DenseMatrix; b: Float64Array } {
  const kept: number[] = [];
  for (let row = 0; row < A.rows; row++) {
    let allZero = true;
    for (let col = 0; col < A.cols; col++) {
      if (Math.abs(A.data[row * A.cols + col]!) > tol) {
        allZero = false;
        break;
      }
    }
    if (!allZero || Math.abs(b[row]!) > tol) kept.push(row);
  }
  if (kept.length === A.rows) return { A, b };
  const reduced = createDenseMatrix(kept.length, A.cols);
  for (let dstRow = 0; dstRow < kept.length; dstRow++) {
    const srcOffset = kept[dstRow]! * A.cols;
    for (let col = 0; col < A.cols; col++) {
      reduced.data[dstRow * A.cols + col] = A.data[srcOffset + col]!;
    }
  }
  return { A: reduced, b: Float64Array.from(kept, (row) => b[row]!) };
}

// Turn a user-supplied vertex of {Ax <= b} into a feasible Phase-2 basis for [A, -A, I]. Returns
// null unless the point verifiably is a nondegenerate basic feasible solution (exactly n tight
// rows, nonsingular basis whose basic solution is feasible and reproduces the vertex), so a bad
// start degrades to the ordinary two-phase run, never a wrong path.
function warmStartBasis(A: DenseMatrix, b: Float64Array, phase2: StandardLp, vertex: readonly number[], tol: number): boolean[] | null {
  const m = A.rows;
  const n = A.cols;
  const active: number[] = [];
  for (let i = 0; i < m; i++) {
    let ax = 0;
    const rowOffset = i * n;
    for (let j = 0; j < n; j++) ax += A.data[rowOffset + j]! * vertex[j]!;
    const slack = b[i]! - ax;
    const scale = 1 + Math.abs(b[i]!);
    if (slack < -tol * scale) return null; // infeasible point
    if (slack <= tol * scale) active.push(i);
  }
  // one split coordinate per dimension + one slack per inactive row totals m exactly when
  // |active| = n; interior points and degenerate corners fall back to Phase 1
  if (active.length !== n) return null;

  const isBasic: boolean[] = new Array<boolean>(phase2.A.cols).fill(false);
  for (let j = 0; j < n; j++) isBasic[vertex[j]! >= 0 ? j : n + j] = true;
  const activeSet = new Set(active);
  for (let i = 0; i < m; i++) if (!activeSet.has(i)) isBasic[2 * n + i] = true;

  try {
    const scratch = phaseScratch(m, phase2.A.cols);
    const solution = basicSolution(phase2, new Basis(phase2.A, isBasic), scratch, false);
    for (let i = 0; i < m; i++) {
      if (scratch.xB[i]! < -tol) return null; // basis is not primal feasible
    }
    const point = unsplit(solution.x, n);
    for (let j = 0; j < n; j++) {
      if (Math.abs(point[j]! - vertex[j]!) > WARM_START_VERTEX_TOLERANCE * (1 + Math.abs(vertex[j]!))) {
        return null; // basic solution does not reproduce the vertex
      }
    }
  } catch {
    return null; // singular basis matrix
  }
  return isBasic;
}

/** Two-phase simplex on `max objective'x s.t. Ax <= b`, on the primal or (dual: true) the dual LP. */
export function simplex(constraints: readonly Constraint[], objective: Float64Array, opts: SimplexOptions): SolverResult {
  const { tol, dual, startVertex } = opts;
  const pivotRules = resolvePivotRules(opts);
  const { A, b } = denseFromConstraints(constraints);
  const n = A.cols;
  const c = Float64Array.from(objective);

  if (dual) {
    return solveDualMode(A, b, c, { tol, pivotRules });
  }

  // Phase 1 works on [A⁺, -A⁺, diag(γ)] with the rows flipped nonnegative;
  // Phase 2 on the split standard form [A, -A, I] of the original rows.
  const { lp: phase1Lp, isBasic: phase1Basis } = phase1Problem(b, (gamma) => {
    const aPositive = scaleRows(A, gamma);
    return hstackMatrices(aPositive, negateMatrix(aPositive), diagonalMatrix(gamma));
  });
  const split = splitStandardForm(A, c);
  const phase2Lp: StandardLp = { A: split.A, b, c: split.c };
  const config: Omit<PhaseConfig, "phase"> = { tol, pivotRules, dimension: n, pointOf: (x) => unsplit(x, n), unboundedNote: UNBOUNDED_NOTE };

  const warmBasis = startVertex && startVertex.length === n ? warmStartBasis(A, b, phase2Lp, startVertex, tol) : null;
  let phase1: PhaseLog = skippedPhase("Skipped — warm start from the dragged start vertex.\n");
  let phase2Basis = warmBasis;
  if (!phase2Basis) {
    const run = simplexPhase(phase1Lp, phase1Basis, { ...config, phase: 1 });
    // The Phase-1 objective equals -(sum of artificial values), so a negative
    // optimum means no feasible point exists.
    if (run.objective < -tol) throw new Error("Problem infeasible (Phase-1 optimum is negative: no feasible point exists)");
    phase1 = run;
    phase2Basis = pivotOutArtificialVariables(phase1Lp, run.isBasic, phase2Lp.A.cols, tol);
  }

  const phase2 = simplexPhase(phase2Lp, phase2Basis, { ...config, phase: 2 });
  return simplexResult(phase1, phase2, phase2.status, "primal");
}
