import { createDenseMatrix, type DenseMatrix, dot, linesToDenseAb, transposedMatVec } from "@lpviz/math/blas";
import { invertDenseMatrix, solveDenseSystem } from "@lpviz/math/lapack";
import type { Lines, Vec2N, Vec2Ns, VecN } from "@lpviz/math/types";
import { fmtE, fmtF, fmtStr } from "./fmt";

const MAX_ITERATIONS = 100_000;

type SimplexStatus = "optimal" | "unbounded" | "infeasible";

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

type PivotRules = { entering: EnteringRule; leaving: LeavingRule };

// Bland's rule on both sides: the default, and the only combination with a
// termination guarantee.
const BLAND_RULES: PivotRules = { entering: "first", leaving: "first" };

export const isEnteringRule = (value: unknown): value is EnteringRule => (ENTERING_RULES as readonly unknown[]).includes(value);
export const isLeavingRule = (value: unknown): value is LeavingRule => (LEAVING_RULES as readonly unknown[]).includes(value);

// Unknown values (e.g. from a hand-edited share link) degrade to the default.
function resolvePivotRules(opts: Pick<SimplexOptions, "enteringRule" | "leavingRule">): PivotRules {
  return {
    entering: isEnteringRule(opts.enteringRule) ? opts.enteringRule : BLAND_RULES.entering,
    leaving: isLeavingRule(opts.leavingRule) ? opts.leavingRule : BLAND_RULES.leaving,
  };
}

interface SimplexOptions {
  tol: number;
  dual: boolean;
  /**
   * Optional warm start: a vertex of {Ax <= b} to begin Phase 2 from,
   * skipping Phase 1. Primal mode only — a primal point determines a
   * dual-feasible basis only when it is already optimal (by complementary
   * slackness), so dual simplex mode ignores it.
   */
  startVertex?: number[];
  /** Entering-variable pivot rule (see ENTERING_RULES). Defaults to "first" (Bland). */
  enteringRule?: EnteringRule;
  /** Ratio-test tie-break (see LEAVING_RULES). Defaults to "first" (lowest index). */
  leavingRule?: LeavingRule;
}

function diagonalMatrix(values: Float64Array): DenseMatrix {
  const size = values.length;
  const matrix = createDenseMatrix(size, size);
  for (let i = 0; i < size; i++) matrix.data[i * size + i] = values[i]!;
  return matrix;
}

const identityMatrix = (size: number) => diagonalMatrix(new Float64Array(size).fill(1));

function transposeMatrix(matrix: DenseMatrix): DenseMatrix {
  const out = createDenseMatrix(matrix.cols, matrix.rows);
  for (let row = 0; row < matrix.rows; row++) {
    const rowOffset = row * matrix.cols;
    for (let col = 0; col < matrix.cols; col++) {
      out.data[col * matrix.rows + row] = matrix.data[rowOffset + col]!;
    }
  }
  return out;
}

function negateMatrix(matrix: DenseMatrix): DenseMatrix {
  const data = Float64Array.from(matrix.data, (value) => -value);
  return createDenseMatrix(matrix.rows, matrix.cols, data);
}

function scaleRows(matrix: DenseMatrix, rowScales: Float64Array): DenseMatrix {
  const out = createDenseMatrix(matrix.rows, matrix.cols);
  for (let row = 0; row < matrix.rows; row++) {
    const scale = rowScales[row]!;
    const rowOffset = row * matrix.cols;
    for (let col = 0; col < matrix.cols; col++) {
      out.data[rowOffset + col] = matrix.data[rowOffset + col]! * scale;
    }
  }
  return out;
}

function hstackMatrices(...matrices: DenseMatrix[]): DenseMatrix {
  if (matrices.length === 0) return createDenseMatrix(0, 0);
  const rows = matrices[0]!.rows;
  const cols = matrices.reduce((sum, matrix) => sum + matrix.cols, 0);
  const out = createDenseMatrix(rows, cols);
  let colOffset = 0;
  for (const matrix of matrices) {
    for (let row = 0; row < rows; row++) {
      const srcOffset = row * matrix.cols;
      const dstOffset = row * cols + colOffset;
      for (let col = 0; col < matrix.cols; col++) {
        out.data[dstOffset + col] = matrix.data[srcOffset + col]!;
      }
    }
    colOffset += matrix.cols;
  }
  return out;
}

function extractColumn(matrix: DenseMatrix, column: number, out = new Float64Array(matrix.rows)) {
  for (let row = 0; row < matrix.rows; row++) {
    out[row] = matrix.data[row * matrix.cols + column]!;
  }
  return out;
}

function basisString(basis: boolean[]) {
  return basis.map((isBasic) => (isBasic ? 1 : 0)).join("");
}

const REFACTOR_INTERVAL = 20;
const UNSTABLE_PIVOT = 1e-6;

class BasisInverse {
  readonly m: number;
  readonly basisIndices: number[];
  private readonly inverse: Float64Array;
  private readonly work: Float64Array;
  private readonly matrix: Float64Array;
  private transposed: Float64Array | null = null;
  private pivotsSinceRefactor = 0;

  constructor(
    private readonly A: DenseMatrix,
    basisIndices: readonly number[],
  ) {
    this.m = A.rows;
    this.basisIndices = basisIndices.slice();
    this.inverse = new Float64Array(this.m * this.m);
    this.work = new Float64Array(this.m * this.m);
    this.matrix = new Float64Array(this.m * this.m);
    this.refactor();
  }

  /** True once any eta update has been applied since the last rebuild. */
  get stale(): boolean {
    return this.pivotsSinceRefactor > 0;
  }

  static fromFlags(A: DenseMatrix, basis: readonly boolean[]): BasisInverse {
    const indices: number[] = [];
    for (let i = 0; i < basis.length; i++) if (basis[i]) indices.push(i);
    return new BasisInverse(A, indices);
  }

  refactor(): void {
    const { m, A } = this;
    for (let col = 0; col < m; col++) {
      const source = this.basisIndices[col]!;
      for (let row = 0; row < m; row++) {
        this.matrix[row * m + col] = A.data[row * A.cols + source]!;
      }
    }
    invertDenseMatrix(this.matrix, m, this.inverse, this.work);
    this.transposed = null;
    this.pivotsSinceRefactor = 0;
  }

  /** out = B⁻¹ v */
  solveExact(v: Float64Array, out: Float64Array): Float64Array {
    return solveDenseSystem(this.matrix, this.m, v, out, this.work);
  }

  /** out = B⁻ᵀ v, direct solve; see solveExact. */
  solveTransposeExact(v: Float64Array, out: Float64Array): Float64Array {
    const { m } = this;
    if (!this.transposed) {
      this.transposed = new Float64Array(m * m);
      for (let row = 0; row < m; row++) {
        for (let col = 0; col < m; col++) {
          this.transposed[col * m + row] = this.matrix[row * m + col]!;
        }
      }
    }
    return solveDenseSystem(this.transposed, m, v, out, this.work);
  }

  /** out = B⁻¹ v */
  apply(v: Float64Array, out: Float64Array): Float64Array {
    const { m, inverse } = this;
    for (let i = 0; i < m; i++) {
      let sum = 0;
      const offset = i * m;
      for (let k = 0; k < m; k++) sum += inverse[offset + k]! * v[k]!;
      out[i] = sum;
    }
    return out;
  }

  /** out = B⁻ᵀ v */
  applyTranspose(v: Float64Array, out: Float64Array): Float64Array {
    const { m, inverse } = this;
    out.fill(0);
    for (let i = 0; i < m; i++) {
      const scale = v[i]!;
      if (scale === 0) continue;
      const offset = i * m;
      for (let k = 0; k < m; k++) out[k] += inverse[offset + k]! * scale;
    }
    return out;
  }

  pivot(leavingRow: number, direction: Float64Array, enteringIndex: number): void {
    const { m, inverse } = this;
    const pivotValue = direction[leavingRow]!;
    const rowR = leavingRow * m;
    const scale = 1 / pivotValue;
    for (let k = 0; k < m; k++) inverse[rowR + k] *= scale;
    for (let i = 0; i < m; i++) {
      if (i === leavingRow) continue;
      const factor = direction[i]!;
      if (factor === 0) continue;
      const rowI = i * m;
      for (let k = 0; k < m; k++) inverse[rowI + k] -= factor * inverse[rowR + k]!;
    }
    this.basisIndices[leavingRow] = enteringIndex;
    if (++this.pivotsSinceRefactor >= REFACTOR_INTERVAL || Math.abs(pivotValue) < UNSTABLE_PIVOT) {
      this.refactor();
    }
  }
}

function basisState(
  cVec: Float64Array,
  A: DenseMatrix,
  bVec: Float64Array,
  factor: BasisInverse,
  scratch: {
    xB: Float64Array;
    cB: Float64Array;
    duals: Float64Array;
    aty: Float64Array;
  },
  exact = false,
) {
  const { m, basisIndices } = factor;
  const nCols = A.cols;
  if (exact) factor.solveExact(bVec, scratch.xB);
  else factor.apply(bVec, scratch.xB);
  const xTableau = new Float64Array(nCols);
  for (let i = 0; i < m; i++) {
    xTableau[basisIndices[i]!] = scratch.xB[i]!;
    scratch.cB[i] = cVec[basisIndices[i]!]!;
  }
  if (exact) factor.solveTransposeExact(scratch.cB, scratch.duals);
  else factor.applyTranspose(scratch.cB, scratch.duals);
  transposedMatVec(A, scratch.duals, scratch.aty);
  const reducedCosts = new Float64Array(nCols);
  for (let j = 0; j < nCols; j++) reducedCosts[j] = cVec[j]! - scratch.aty[j]!;
  return { xTableau, reducedCosts, objective: dot(cVec, xTableau) };
}

function basisScratch(m: number, nCols: number) {
  return {
    xB: new Float64Array(m),
    cB: new Float64Array(m),
    duals: new Float64Array(m),
    aty: new Float64Array(nCols),
    enterColumn: new Float64Array(m),
    direction: new Float64Array(m),
  };
}

function selectEnteringIndex(basis: boolean[], reducedCosts: Float64Array, tol: number, rule: EnteringRule): number {
  if (rule === "first") {
    for (let j = 0; j < reducedCosts.length; j++) {
      if (!basis[j] && reducedCosts[j]! > tol) return j;
    }
    return -1;
  }
  if (rule === "last") {
    for (let j = reducedCosts.length - 1; j >= 0; j--) {
      if (!basis[j] && reducedCosts[j]! > tol) return j;
    }
    return -1;
  }
  let best = -1;
  let bestCost = -Infinity;
  for (let j = 0; j < reducedCosts.length; j++) {
    if (basis[j] || reducedCosts[j]! <= tol) continue;
    // strict `>` keeps the lowest index on ties
    if (reducedCosts[j]! > bestCost) {
      bestCost = reducedCosts[j]!;
      best = j;
    }
  }
  return best;
}

function selectLeavingIndex(xB: Float64Array, direction: Float64Array, basisIndices: number[], tol: number, rule: LeavingRule): number {
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
    const originalIndex = basisIndices[i]!;
    const prefer = leave === -1 || (rule === "first" ? originalIndex < chosenIndex : originalIndex > chosenIndex);
    if (prefer) {
      leave = i;
      chosenIndex = originalIndex;
    }
  }
  return leave;
}

// A pivot is degenerate when the entering variable cannot increase at all
// (minimum ratio ~ 0): the basis changes but the vertex does not. Cycling is a
// run of degenerate pivots that revisits a basis, and only Bland's rule
// (lowest index entering and leaving) is guaranteed to avoid it. Rather than
// letting the other rules spin until MAX_ITERATIONS, both simplex loops count
// consecutive degenerate pivots and fall back to Bland's rule for the rest of
// the phase once the count exceeds this limit. Iterations pivoted under the
// fallback carry a "d" after their number in the log, the way PDHG marks
// Halpern restarts with "r". A legitimately degenerate vertex in the app's
// 2-D/3-D problems needs only a handful of degenerate pivots, and a false
// trigger merely changes the pivot rule.
const MAX_CONSECUTIVE_DEGENERATE_PIVOTS = 25;

// Iteration column of a log row: "12" normally, "12d" while the cycling guard
// has forced Bland's rule (see MAX_CONSECUTIVE_DEGENERATE_PIVOTS).
const iterationLabel = (iteration: number, guarded: boolean) => fmtStr(guarded ? `${iteration}d` : `${iteration}`, 5);

function createCyclingGuard(initial: PivotRules, tol: number) {
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

// The primal vertex a dual basis identifies: the intersection of the two
// lowest-index constraint lines whose dual variables are basic.
function primalPointFromDualBasis(lines: Lines, basisIndices: readonly number[], tol: number): Float64Array {
  const sorted = [...basisIndices].sort((a, b) => a - b);
  const support = sorted.filter((index) => index < lines.length).slice(0, 2);
  if (support.length < 2) return new Float64Array(2);

  const [i, j] = support;
  const first = lines[i]!;
  const second = lines[j]!;
  const determinant = first[0]! * second[1]! - first[1]! * second[0]!;
  if (Math.abs(determinant) <= tol) return new Float64Array(2);

  const x = (first[2]! * second[1]! - first[1]! * second[2]!) / determinant;
  const y = (first[0]! * second[2]! - first[2]! * second[0]!) / determinant;
  return Float64Array.of(x, y);
}

type SimplexCoreConfig = {
  tol: number;
  pivotRules: PivotRules;
  completionLabel: string;
  /** The point an iteration plots and logs, from the tableau and the basis columns. */
  pointOf: (xTableau: Float64Array, basisIndices: readonly number[]) => Float64Array;
};

function simplexCore(cVec: Float64Array, A: DenseMatrix, bVec: Float64Array, basisInit: boolean[], cfg: SimplexCoreConfig) {
  const { tol, pivotRules, completionLabel, pointOf } = cfg;
  const mRows = A.rows;
  const nCols = A.cols;
  const basis = basisInit.slice();
  const iterations: Vec2Ns = [];
  const logs: string[] = [];
  const header = `${"Iter".padStart(5)} ${"x".padStart(8)} ${"y".padStart(8)} ${"Obj".padStart(10)} ${"basis".padEnd(nCols, " ")}\n`;

  logs.push(header);
  const guard = createCyclingGuard(pivotRules, tol);

  let iteration = 0;
  let status: SimplexStatus = "optimal";
  let objective = 0;
  const factor = BasisInverse.fromFlags(A, basis);
  const scratch = basisScratch(mRows, nCols);
  const { xB, enterColumn, direction } = scratch;

  while (true) {
    if (++iteration > MAX_ITERATIONS) throw new Error(`Simplex stalled after ${MAX_ITERATIONS} iterations`);

    let state = basisState(cVec, A, bVec, factor, scratch);
    let enterIndex = selectEnteringIndex(basis, state.reducedCosts, tol, guard.rules.entering);

    if (enterIndex === -1 && factor.stale) {
      factor.refactor();
      state = basisState(cVec, A, bVec, factor, scratch, true);
      enterIndex = selectEnteringIndex(basis, state.reducedCosts, tol, guard.rules.entering);
    }
    objective = state.objective;
    const point = pointOf(state.xTableau, factor.basisIndices);
    iterations.push(point);
    logs.push(`${iterationLabel(iteration, guard.active)} ${fmtF(point[0] ?? 0, 8, 2)} ${fmtF(point[1] ?? 0, 8, 2)} ${fmtE(objective, 10, 1)} ${basisString(basis)}\n`);

    if (enterIndex === -1) break;

    extractColumn(A, enterIndex, enterColumn);
    factor.apply(enterColumn, direction);

    const leaveBasisIndex = selectLeavingIndex(xB, direction, factor.basisIndices, tol, guard.rules.leaving);

    if (leaveBasisIndex === -1) {
      logs.push("LP is unbounded. No leaving variable found.");
      status = "unbounded";
      break;
    }

    guard.recordPivot(xB[leaveBasisIndex]! / direction[leaveBasisIndex]!);
    basis[enterIndex] = true;
    basis[factor.basisIndices[leaveBasisIndex]!] = false;
    factor.pivot(leaveBasisIndex, direction, enterIndex);
  }

  const finalBasis = basis.slice();
  logs.push(`${completionLabel} finished in ${iteration} iterations – basis ${basisString(finalBasis)}\n`);

  return { iterations, logs, finalBasis, objective, status };
}

// Drives any artificial variable still basic at the end of Phase 1 out of the
// basis by swapping in the lowest-index original column with a nonzero pivot.
// This is deliberately independent of the selected pivot rules: it is a basis
// repair step, not an objective-improving pivot, so the rules only govern the
// two simplex loops. (Primal mode reaches this loop only for zero-area regions,
// which the app rejects; dual mode reaches it when the objective is exactly
// parallel to a constraint normal.)
function pivotOutArtificialVariables(phase1Matrix: DenseMatrix, bVec: Float64Array, basisInit: boolean[], originalColumnCount: number, tol: number) {
  const basis = basisInit.slice();
  const column = new Float64Array(phase1Matrix.rows);
  const direction = new Float64Array(phase1Matrix.rows);
  const factor = BasisInverse.fromFlags(phase1Matrix, basis);

  while (true) {
    const rowIndex = factor.basisIndices.findIndex((index) => index >= originalColumnCount);
    if (rowIndex === -1) break;
    const artificialIndex = factor.basisIndices[rowIndex]!;
    let replacement = -1;

    for (let j = 0; j < originalColumnCount; j++) {
      if (basis[j]) continue;
      extractColumn(phase1Matrix, j, column);
      factor.apply(column, direction);
      if (Math.abs(direction[rowIndex]!) > tol) {
        replacement = j;
        break;
      }
    }

    if (replacement === -1) {
      throw new Error("Could not pivot artificial variables out of the Phase 1 basis.");
    }

    basis[artificialIndex] = false;
    basis[replacement] = true;
    factor.pivot(rowIndex, direction, replacement);
  }

  const phase2Basis = basis.slice(0, originalColumnCount);
  if (phase2Basis.filter(Boolean).length !== bVec.length) {
    throw new Error("Phase 1 did not produce a valid Phase 2 basis.");
  }
  return phase2Basis;
}

// The Phase-1 problem for {columns(gamma) x = gamma ∘ b, x >= 0}: rows are
// flipped so the right-hand side is nonnegative, one artificial column per row
// is appended, the objective is -sum(artificials) and they form the first basis.
function phase1Problem(b: Float64Array, columnsOf: (gamma: Float64Array) => DenseMatrix) {
  const gamma = Float64Array.from(b, (value) => (value < 0 ? -1 : 1));
  const bPhase1 = Float64Array.from(b, (value, index) => value * gamma[index]!);
  const columns = columnsOf(gamma);
  const { rows, cols } = columns;
  const aPhase1 = hstackMatrices(columns, identityMatrix(rows));
  const cPhase1 = new Float64Array(cols + rows).fill(-1, cols);
  const phase1Basis = Array(cols + rows).fill(false);
  for (let i = 0; i < rows; i++) phase1Basis[cols + i] = true;
  return { columns, bPhase1, aPhase1, cPhase1, phase1Basis };
}

function solveDualMode(lines: Lines, primalA: DenseMatrix, primalB: Float64Array, objective: Float64Array, cfg: { tol: number; pivotRules: PivotRules }) {
  const { tol, pivotRules } = cfg;
  const dualAFull = transposeMatrix(primalA);
  const bDualFull = Float64Array.from(objective);

  // Rows of the dual system that are identically zero with a zero
  // right-hand side are redundant (0 = 0); Phase 1 can never pivot their
  // artificial variables out of the basis, so drop them up front.
  const keptRows: number[] = [];
  for (let row = 0; row < dualAFull.rows; row++) {
    let allZero = true;
    for (let col = 0; col < dualAFull.cols; col++) {
      if (Math.abs(dualAFull.data[row * dualAFull.cols + col]!) > tol) {
        allZero = false;
        break;
      }
    }
    if (!allZero || Math.abs(bDualFull[row]!) > tol) keptRows.push(row);
  }
  let dualA = dualAFull;
  let bDual = bDualFull;
  if (keptRows.length !== dualAFull.rows) {
    dualA = createDenseMatrix(keptRows.length, dualAFull.cols);
    for (let dstRow = 0; dstRow < keptRows.length; dstRow++) {
      const srcOffset = keptRows[dstRow]! * dualAFull.cols;
      for (let col = 0; col < dualAFull.cols; col++) {
        dualA.data[dstRow * dualAFull.cols + col] = dualAFull.data[srcOffset + col]!;
      }
    }
    bDual = Float64Array.from(keptRows, (row) => bDualFull[row]!);
  }

  const cDual = Float64Array.from(primalB, (value) => -value);
  const { columns: aPhase2, bPhase1, aPhase1, cPhase1, phase1Basis } = phase1Problem(bDual, (gamma) => scaleRows(dualA, gamma));
  const core: SimplexCoreConfig = { tol, pivotRules, completionLabel: "Phase 2", pointOf: (_, basisIndices) => primalPointFromDualBasis(lines, basisIndices, tol) };

  const phase1 = simplexCore(cPhase1, aPhase1, bPhase1, phase1Basis, { ...core, completionLabel: "Phase 1" });

  if (Math.abs(phase1.objective) > tol) {
    // Phase 1 could not drive the artificial objective to zero, so the dual LP
    // is infeasible. The feasible region we are visualizing is non-empty
    // (emptiness is rejected before the solver runs), so by LP duality the
    // primal LP is unbounded. Report it like the primal solver does and still
    // plot the Phase 1 trajectory.
    return {
      iterations: [] as Float64Array[],
      phase1Iterations: phase1.iterations,
      logs: [phase1.logs, ["The dual LP is infeasible, so the primal LP is unbounded.\n"]],
      status: "unbounded" as const,
    };
  }

  const phase2Basis = pivotOutArtificialVariables(aPhase1, bPhase1, phase1.finalBasis, aPhase2.cols, tol);
  const phase2 = simplexCore(cDual, aPhase2, bPhase1, phase2Basis, core);

  // An unbounded dual means the primal LP being visualized is infeasible.
  const status: SimplexStatus = phase2.status === "unbounded" ? "infeasible" : phase2.status;
  const phase2Logs =
    phase2.status === "unbounded" ? phase2.logs.map((log) => (log === "LP is unbounded. No leaving variable found." ? "Dual LP is unbounded: the LP is infeasible." : log)) : phase2.logs;

  return {
    iterations: phase2.iterations,
    phase1Iterations: phase1.iterations,
    logs: [phase1.logs, phase2Logs],
    status,
  };
}

function primalPointFromSplitTableau(tableauX: Vec2N, n: number) {
  const point = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    point[i] = (tableauX[i] ?? 0) - (tableauX[n + i] ?? 0);
  }
  return point;
}

// Turn a user-supplied vertex of {Ax <= b} directly into a feasible Phase-2
// basis for the split standard form [A, -A, I]. The dual side needs no
// initialization: primal simplex derives its dual estimate y = B^-T c_B from
// the basis, and dual feasibility is exactly what Phase 2 works toward.
// Returns null unless the point verifiably is a nondegenerate basic feasible
// solution — exactly n tight rows, every other slack positive, nonsingular
// basis matrix whose basic solution is feasible and reproduces the vertex —
// so a bad start degrades to the ordinary two-phase run, never a wrong path.
function warmStartBasisFromVertex(A: DenseMatrix, b: Float64Array, cPhase2: Float64Array, aPhase2: DenseMatrix, vertex: number[], tol: number): boolean[] | null {
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
  // basic variables = one split coordinate per dimension + one slack per
  // inactive row; that totals m exactly when |active| = n (a nondegenerate
  // vertex). Interior points and degenerate corners fall back to Phase 1.
  if (active.length !== n) return null;

  const basis: boolean[] = new Array(2 * n + m).fill(false);
  for (let j = 0; j < n; j++) basis[vertex[j]! >= 0 ? j : n + j] = true;
  const activeSet = new Set(active);
  for (let i = 0; i < m; i++) if (!activeSet.has(i)) basis[2 * n + i] = true;

  try {
    const scratch = basisScratch(m, aPhase2.cols);
    const state = basisState(cPhase2, aPhase2, b, BasisInverse.fromFlags(aPhase2, basis), scratch);
    for (let i = 0; i < m; i++) {
      if (scratch.xB[i]! < -tol) return null; // basis is not primal feasible
    }
    for (let j = 0; j < n; j++) {
      const value = (state.xTableau[j] ?? 0) - (state.xTableau[n + j] ?? 0);
      if (Math.abs(value - vertex[j]!) > 1e-6 * (1 + Math.abs(vertex[j]!))) {
        return null; // basic solution does not reproduce the vertex
      }
    }
  } catch {
    return null; // singular basis matrix
  }
  return basis;
}

export function simplex(lines: Lines, objective: VecN, opts: SimplexOptions) {
  const { tol, dual, startVertex } = opts;
  const pivotRules = resolvePivotRules(opts);
  const { A: aOriginal, b } = linesToDenseAb(lines);
  const m = aOriginal.rows;
  const n = aOriginal.cols;
  const cObjective = Float64Array.from(objective);

  if (dual) {
    return {
      ...solveDualMode(lines, aOriginal, b, cObjective, {
        tol,
        pivotRules,
      }),
      mode: "dual" as const,
    };
  }

  // Phase 1 works on [A⁺, -A⁺, diag(γ)] with the rows flipped nonnegative;
  // Phase 2 on the split standard form [A, -A, I] of the original rows.
  const { bPhase1, aPhase1, cPhase1, phase1Basis } = phase1Problem(b, (gamma) => {
    const aPositive = scaleRows(aOriginal, gamma);
    return hstackMatrices(aPositive, negateMatrix(aPositive), diagonalMatrix(gamma));
  });
  const cPhase2 = new Float64Array(2 * n + m);
  cPhase2.set(cObjective);
  for (let j = 0; j < n; j++) cPhase2[n + j] = -cObjective[j]!;
  const aPhase2 = hstackMatrices(aOriginal, negateMatrix(aOriginal), identityMatrix(m));
  const core: SimplexCoreConfig = { tol, pivotRules, completionLabel: "Phase 2", pointOf: (xTableau) => primalPointFromSplitTableau(xTableau, n) };

  const warmBasis = startVertex && startVertex.length === n ? warmStartBasisFromVertex(aOriginal, b, cPhase2, aPhase2, startVertex, tol) : null;
  let phase1Iterations: Float64Array[] = [];
  let phase1Logs = ["Skipped — warm start from the dragged start vertex.\n"];
  let phase2Basis = warmBasis;
  if (!phase2Basis) {
    const phase1 = simplexCore(cPhase1, aPhase1, bPhase1, phase1Basis, { ...core, completionLabel: "Phase 1" });
    // The Phase-1 objective equals -(sum of artificial values), so a negative
    // optimum means no feasible point exists.
    if (phase1.objective < -tol) throw new Error("Problem infeasible (Phase-1 optimum is negative: no feasible point exists)");
    phase1Iterations = phase1.iterations;
    phase1Logs = phase1.logs;
    phase2Basis = pivotOutArtificialVariables(aPhase1, bPhase1, phase1.finalBasis, 2 * n + m, tol);
  }

  const { iterations, logs, status } = simplexCore(cPhase2, aPhase2, b, phase2Basis, core);
  return {
    iterations,
    phase1Iterations,
    logs: [phase1Logs, logs],
    mode: "primal" as const,
    status,
  };
}
