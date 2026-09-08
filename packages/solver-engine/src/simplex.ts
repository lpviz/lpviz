import {
  type DenseMatrix,
  dot,
  linesToDenseAb,
  transposedMatVec,
} from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Lines, Vec2N, Vec2Ns, VecN } from "@lpviz/math/types";
import { fmtE, fmtF, fmtInt } from "./fmt";

const MAX_ITERATIONS = 100_000;

type SimplexStatus = "optimal" | "unbounded" | "infeasible";

/**
 * Pivot-selection heuristics for the entering variable:
 *  - "coeff": the non-basic column with the highest (positive) reduced cost
 *    — the Dantzig / "largest coefficient" rule; ties break to the lowest
 *    column index.
 *  - "first": the lowest-index non-basic column with a positive reduced cost
 *    — Bland's-rule-style entering.
 *  - "last": the highest-index such column.
 */
export type EnteringRule = "coeff" | "first" | "last";

/**
 * Tie-break for the ratio test (leaving variable): among rows achieving the
 * minimum ratio, "first" keeps the lowest original column index and "last"
 * the highest.
 */
export type LeavingRule = "first" | "last";

const DEFAULT_ENTERING_RULE: EnteringRule = "first";
const DEFAULT_LEAVING_RULE: LeavingRule = "first";

function resolveEnteringRule(rule: unknown): EnteringRule {
  return rule === "coeff" || rule === "first" || rule === "last"
    ? rule
    : DEFAULT_ENTERING_RULE;
}

function resolveLeavingRule(rule: unknown): LeavingRule {
  return rule === "first" || rule === "last" ? rule : DEFAULT_LEAVING_RULE;
}

interface SimplexOptions {
  tol: number;
  verbose: boolean;
  dual: boolean;
  /**
   * Optional warm start: a vertex of {Ax <= b} to begin Phase 2 from,
   * skipping Phase 1. Primal mode only — a primal point determines a
   * dual-feasible basis only when it is already optimal (by complementary
   * slackness), so dual simplex mode ignores it.
   */
  startVertex?: number[];
  /** Entering-variable pivot rule. Defaults to "first" (lowest index). */
  enteringRule?: EnteringRule;
  /** Leaving-variable ratio-test tie-break. Defaults to "first". */
  leavingRule?: LeavingRule;
}

function createDenseMatrix(rows: number, cols: number, fill = 0): DenseMatrix {
  const data = new Float64Array(rows * cols);
  if (fill !== 0) data.fill(fill);
  return { rows, cols, data };
}

function identityMatrix(size: number): DenseMatrix {
  const matrix = createDenseMatrix(size, size);
  for (let i = 0; i < size; i++) {
    matrix.data[i * size + i] = 1;
  }
  return matrix;
}

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

function scaleMatrix(matrix: DenseMatrix, scale: number): DenseMatrix {
  const out = createDenseMatrix(matrix.rows, matrix.cols);
  for (let i = 0; i < matrix.data.length; i++) {
    out.data[i] = matrix.data[i]! * scale;
  }
  return out;
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
    if (matrix.rows !== rows) {
      throw new Error(
        "hstackMatrices: all matrices must have the same number of rows",
      );
    }
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

function concatenateVectors(...vectors: Float64Array[]): Float64Array {
  const totalLength = vectors.reduce((sum, vector) => sum + vector.length, 0);
  const out = new Float64Array(totalLength);
  let offset = 0;
  for (const vector of vectors) {
    for (let i = 0; i < vector.length; i++) {
      out[offset + i] = vector[i]!;
    }
    offset += vector.length;
  }
  return out;
}

function extractColumn(
  matrix: DenseMatrix,
  column: number,
  out = new Float64Array(matrix.rows),
) {
  for (let row = 0; row < matrix.rows; row++) {
    out[row] = matrix.data[row * matrix.cols + column]!;
  }
  return out;
}

function countBasicVariables(basis: boolean[]) {
  let count = 0;
  for (const isBasic of basis) {
    if (isBasic) count++;
  }
  return count;
}

function basisString(basis: boolean[]) {
  return basis.map((isBasic) => (isBasic ? 1 : 0)).join("");
}

function buildBasisState(
  cVec: Float64Array,
  A: DenseMatrix,
  bVec: Float64Array,
  basis: boolean[],
) {
  const mRows = A.rows;
  const nCols = A.cols;
  const basisIndices: number[] = [];

  for (let i = 0; i < nCols; i++) {
    if (basis[i]) basisIndices.push(i);
  }
  if (basisIndices.length !== mRows) {
    throw new Error(
      `Basis size ${basisIndices.length} does not match number of constraints ${mRows}. Basis: ${basisString(basis)}`,
    );
  }

  const B = createDenseMatrix(mRows, mRows);
  for (let basisCol = 0; basisCol < mRows; basisCol++) {
    const sourceCol = basisIndices[basisCol]!;
    for (let row = 0; row < mRows; row++) {
      B.data[row * mRows + basisCol] = A.data[row * nCols + sourceCol]!;
    }
  }

  const xB = new Float64Array(mRows);
  solveDenseSystem(B.data, mRows, bVec, xB);

  const xTableau = new Float64Array(nCols);
  for (let basisIndex = 0; basisIndex < mRows; basisIndex++) {
    xTableau[basisIndices[basisIndex]!] = xB[basisIndex]!;
  }

  const cB = new Float64Array(mRows);
  for (let i = 0; i < mRows; i++) {
    cB[i] = cVec[basisIndices[i]!]!;
  }

  const BT = transposeMatrix(B);
  const y = new Float64Array(mRows);
  solveDenseSystem(BT.data, mRows, cB, y);

  const aty = new Float64Array(nCols);
  transposedMatVec(A, y, aty);
  const reducedCosts = new Float64Array(nCols);
  for (let j = 0; j < nCols; j++) {
    reducedCosts[j] = cVec[j]! - aty[j]!;
  }

  return {
    B,
    xB,
    xTableau,
    basisIndices,
    reducedCosts,
    objective: dot(cVec, xTableau),
  };
}

function selectEnteringIndex(
  basis: boolean[],
  reducedCosts: Float64Array,
  tol: number,
  rule: EnteringRule,
): number {
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

function selectLeavingIndex(
  xB: Float64Array,
  direction: Float64Array,
  basisIndices: number[],
  tol: number,
  rule: LeavingRule,
): number {
  let leave = -1;
  let minRatio = Infinity;
  let chosenOriginalIndex = -1;
  for (let i = 0; i < xB.length; i++) {
    if (direction[i]! <= tol) continue;
    const ratio = xB[i]! / direction[i]!;
    const originalIndex = basisIndices[i]!;
    if (ratio < minRatio - tol) {
      minRatio = ratio;
      chosenOriginalIndex = originalIndex;
      leave = i;
    } else if (Math.abs(ratio - minRatio) < tol) {
      const prefer = rule === "first"
        ? originalIndex < chosenOriginalIndex
        : originalIndex > chosenOriginalIndex;
      if (prefer) {
        chosenOriginalIndex = originalIndex;
        leave = i;
      }
    }
  }
  return leave;
}

function formatIterationLog(
  iteration: number,
  xTableau: Float64Array,
  objective: number,
  basis: boolean[],
  nOrig: number,
) {
  const x0 = nOrig >= 1 ? (xTableau[0] ?? 0) - (xTableau[nOrig] ?? 0) : 0;
  const y0 = nOrig >= 2 ? (xTableau[1] ?? 0) - (xTableau[nOrig + 1] ?? 0) : 0;
  return `${fmtInt(iteration, 5)} ${fmtF(x0, 8, 2)} ${fmtF(y0, 8, 2)} ${fmtE(objective, 10, 1)} ${basisString(basis)}\n`;
}

function recoverPrimalPointFromDualBasis(
  lines: Lines,
  basisIndices: number[],
  tol: number,
): [number, number] {
  const support = basisIndices
    .filter((index) => index < lines.length)
    .slice(0, 2);
  if (support.length < 2) return [0, 0];

  const [i, j] = support;
  const first = lines[i]!;
  const second = lines[j]!;
  const determinant = first[0]! * second[1]! - first[1]! * second[0]!;
  if (Math.abs(determinant) <= tol) return [0, 0];

  const x = (first[2]! * second[1]! - first[1]! * second[2]!) / determinant;
  const y = (first[0]! * second[2]! - first[2]! * second[0]!) / determinant;
  return [x, y];
}

function simplexCoreStandard(
  cVec: Float64Array,
  A: DenseMatrix,
  bVec: Float64Array,
  basisInit: boolean[],
  cfg: {
    tol: number;
    verbose: boolean;
    pointFromBasis: (basisIndices: number[]) => [number, number];
    completionLabel: string;
    enteringRule: EnteringRule;
    leavingRule: LeavingRule;
  },
) {
  const { tol, verbose, pointFromBasis, completionLabel } = cfg;
  const mRows = A.rows;
  const nCols = A.cols;
  let basis = basisInit.slice();
  const iterations: Vec2Ns = [];
  const basisHistory: number[][] = [];
  const logs: string[] = [];
  const header = `${"Iter".padStart(5)} ${"x".padStart(8)} ${"y".padStart(8)} ${"Obj".padStart(10)} ${"basis".padEnd(nCols, " ")}\n`;

  if (verbose) console.log(header);
  logs.push(header);

  let iteration = 0;
  let status: SimplexStatus = "optimal";
  let objective = 0;
  const enterColumn = new Float64Array(mRows);
  const direction = new Float64Array(mRows);

  while (true) {
    if (++iteration > MAX_ITERATIONS)
      throw new Error(`Simplex stalled after ${MAX_ITERATIONS} iterations`);

    const state = buildBasisState(cVec, A, bVec, basis);
    iterations.push(state.xTableau.slice());
    basisHistory.push(state.basisIndices.slice());
    objective = state.objective;

    const [x, y] = pointFromBasis(state.basisIndices);
    const line = `${fmtInt(iteration, 5)} ${fmtF(x, 8, 2)} ${fmtF(y, 8, 2)} ${fmtE(objective, 10, 1)} ${basisString(basis)}\n`;
    if (verbose) console.log(line);
    logs.push(line);

    const enterIndex = selectEnteringIndex(
      basis,
      state.reducedCosts,
      tol,
      cfg.enteringRule,
    );
    if (enterIndex === -1) break;

    extractColumn(A, enterIndex, enterColumn);
    solveDenseSystem(state.B.data, state.B.rows, enterColumn, direction);

    const leaveBasisIndex = selectLeavingIndex(
      state.xB,
      direction,
      state.basisIndices,
      tol,
      cfg.leavingRule,
    );

    if (leaveBasisIndex === -1) {
      const message = "LP is unbounded. No leaving variable found.";
      if (verbose) console.log(message);
      logs.push(message);
      status = "unbounded";
      break;
    }

    basis[enterIndex] = true;
    basis[state.basisIndices[leaveBasisIndex]!] = false;
  }

  const finalBasis = basis.slice();
  const tail = `${completionLabel} finished in ${iteration} iterations – basis ${basisString(finalBasis)}\n`;
  if (verbose) console.log(tail);
  logs.push(tail);

  return {
    iterations,
    basisHistory,
    logs,
    finalBasis,
    objective,
    status,
  };
}

function simplexCore(
  cVec: Float64Array,
  A: DenseMatrix,
  bVec: Float64Array,
  basisInit: boolean[],
  cfg: {
    tol: number;
    verbose: boolean;
    phase1: boolean;
    nOrig: number;
    m: number;
    enteringRule: EnteringRule;
    leavingRule: LeavingRule;
  },
) {
  const { tol, verbose, phase1, nOrig, m } = cfg;
  const mRows = A.rows;
  const nCols = A.cols;

  if (mRows !== m || bVec.length !== m) {
    throw new Error(
      `Dimension mismatch: A.rows=${mRows} vs m=${m}, bVec.length=${bVec.length} vs m=${m}`,
    );
  }

  let basis = basisInit.slice();
  const iterations: Vec2Ns = [];
  const logs: string[] = [];
  const header = `${"Iter".padStart(5)} ${"x".padStart(8)} ${"y".padStart(8)} ${"Obj".padStart(10)} ${"basis".padEnd(nCols, " ")}\n`;
  if (verbose) console.log(header);
  logs.push(header);

  let iteration = 0;
  let xTableau = new Float64Array(nCols);
  let objective = 0;
  let status: SimplexStatus = "optimal";
  let basisIndices: number[] = [];
  const enterColumn = new Float64Array(mRows);
  const direction = new Float64Array(mRows);

  while (true) {
    if (++iteration > MAX_ITERATIONS)
      throw new Error(`Simplex stalled after ${MAX_ITERATIONS} iterations`);

    const state = buildBasisState(cVec, A, bVec, basis);
    basisIndices = state.basisIndices;
    xTableau = state.xTableau;
    objective = state.objective;
    iterations.push(xTableau.slice());

    const line = formatIterationLog(
      iteration,
      xTableau,
      objective,
      basis,
      nOrig,
    );
    if (verbose) console.log(line);
    logs.push(line);

    const enterIndex = selectEnteringIndex(
      basis,
      state.reducedCosts,
      tol,
      cfg.enteringRule,
    );
    if (enterIndex === -1) break;

    extractColumn(A, enterIndex, enterColumn);
    solveDenseSystem(state.B.data, state.B.rows, enterColumn, direction);

    const leaveIndexInBasis = selectLeavingIndex(
      state.xB,
      direction,
      basisIndices,
      tol,
      cfg.leavingRule,
    );

    if (leaveIndexInBasis === -1) {
      const message = "LP is unbounded. No leaving variable found.";
      if (verbose) console.log(message);
      logs.push(message);
      status = "unbounded";
      break;
    }

    basis[enterIndex] = true;
    basis[basisIndices[leaveIndexInBasis]!] = false;
  }

  const finalBasis = basis.slice();
  if (phase1 && objective < -tol) {
    // The Phase-1 objective equals -(sum of artificial values), so a
    // negative optimum means no feasible point exists.
    const message =
      "Problem infeasible (Phase-1 optimum is negative: no feasible point exists)";
    if (verbose) console.log(message);
    logs.push(message);
    throw new Error(message);
  }

  const tail = `Phase ${phase1 ? 1 : 2} finished in ${iteration} iterations – basis ${basisString(finalBasis)}\n`;
  if (verbose) console.log(tail);
  logs.push(tail);

  return {
    iterations,
    finalBasis,
    logs,
    status,
  };
}

function pivotOutArtificialVariables(
  phase1Matrix: DenseMatrix,
  bVec: Float64Array,
  basisInit: boolean[],
  originalColumnCount: number,
  tol: number,
) {
  const basis = basisInit.slice();
  const zeroCosts = new Float64Array(phase1Matrix.cols);
  const column = new Float64Array(phase1Matrix.rows);
  const direction = new Float64Array(phase1Matrix.rows);

  while (true) {
    const basisIndices = basis.flatMap((isBasic, index) =>
      isBasic ? [index] : [],
    );
    const artificialIndex = basisIndices.find(
      (index) => index >= originalColumnCount,
    );
    if (artificialIndex === undefined) break;

    const rowIndex = basisIndices.indexOf(artificialIndex);
    const state = buildBasisState(zeroCosts, phase1Matrix, bVec, basis);
    let replacement = -1;

    for (let j = 0; j < originalColumnCount; j++) {
      if (basis[j]) continue;
      extractColumn(phase1Matrix, j, column);
      solveDenseSystem(state.B.data, state.B.rows, column, direction);
      if (Math.abs(direction[rowIndex]!) > tol) {
        replacement = j;
        break;
      }
    }

    if (replacement === -1) {
      throw new Error(
        "Could not pivot artificial variables out of the Phase 1 basis.",
      );
    }

    basis[artificialIndex] = false;
    basis[replacement] = true;
  }

  const phase2Basis = basis.slice(0, originalColumnCount);
  if (countBasicVariables(phase2Basis) !== bVec.length) {
    throw new Error("Phase 1 did not produce a valid Phase 2 basis.");
  }
  return phase2Basis;
}

function solveDualMode(
  lines: Lines,
  primalA: DenseMatrix,
  primalB: Float64Array,
  objective: Float64Array,
  opts: Pick<SimplexOptions, "tol" | "verbose" | "enteringRule" | "leavingRule">,
) {
  const { tol, verbose } = opts;
  const enteringRule = resolveEnteringRule(opts.enteringRule);
  const leavingRule = resolveLeavingRule(opts.leavingRule);
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
        dualA.data[dstRow * dualAFull.cols + col] =
          dualAFull.data[srcOffset + col]!;
      }
    }
    bDual = Float64Array.from(keptRows, (row) => bDualFull[row]!);
  }

  const cDual = Float64Array.from(primalB, (value) => -value);
  const gamma = Float64Array.from(bDual, (value) => (value < 0 ? -1 : 1));
  const bPhase1 = Float64Array.from(
    bDual,
    (value, index) => value * gamma[index]!,
  );
  const aPhase2 = scaleRows(dualA, gamma);
  const artificial = identityMatrix(aPhase2.rows);
  const aPhase1 = hstackMatrices(aPhase2, artificial);
  const cPhase1 = concatenateVectors(
    new Float64Array(aPhase2.cols),
    Float64Array.from({ length: aPhase2.rows }, () => -1),
  );
  const phase1Basis = Array(aPhase2.cols + aPhase2.rows).fill(false);
  for (let i = 0; i < aPhase2.rows; i++) phase1Basis[aPhase2.cols + i] = true;

  const dualPointFromBasis = (basisIndices: number[]) =>
    recoverPrimalPointFromDualBasis(lines, basisIndices, tol);

  if (verbose) console.log("Phase 1");
  const phase1 = simplexCoreStandard(cPhase1, aPhase1, bPhase1, phase1Basis, {
    tol,
    verbose,
    pointFromBasis: dualPointFromBasis,
    completionLabel: "Phase 1",
    enteringRule,
    leavingRule,
  });

  if (Math.abs(phase1.objective) > tol) {
    // Phase 1 could not drive the artificial objective to zero, so the dual LP
    // is infeasible. The feasible region we are visualizing is non-empty
    // (emptiness is rejected before the solver runs), so by LP duality the
    // primal LP is unbounded. Report it like the primal solver does and still
    // plot the Phase 1 trajectory.
    const phase2Logs = ["The dual LP is infeasible, so the primal LP is unbounded.\n"];
    if (verbose) console.log("Dual LP infeasible: primal LP is unbounded.");
    return {
      iterations: [] as Float64Array[],
      phase1Iterations: phase1.basisHistory.map((basisIndices) =>
        Float64Array.from(dualPointFromBasis(basisIndices)),
      ),
      logs: [phase1.logs, phase2Logs],
      status: "unbounded" as const,
    };
  }

  const phase2Basis = pivotOutArtificialVariables(
    aPhase1,
    bPhase1,
    phase1.finalBasis,
    aPhase2.cols,
    tol,
  );

  if (verbose) console.log("Phase 2");
  const phase2 = simplexCoreStandard(cDual, aPhase2, bPhase1, phase2Basis, {
    tol,
    verbose,
    pointFromBasis: dualPointFromBasis,
    completionLabel: "Phase 2",
    enteringRule,
    leavingRule,
  });

  // An unbounded dual means the primal LP being visualized is infeasible.
  const status: SimplexStatus =
    phase2.status === "unbounded" ? "infeasible" : phase2.status;
  const phase2Logs =
    phase2.status === "unbounded"
      ? phase2.logs.map((log) =>
          log === "LP is unbounded. No leaving variable found."
            ? "Dual LP is unbounded: the LP is infeasible."
            : log,
        )
      : phase2.logs;

  return {
    iterations: phase2.basisHistory.map((basisIndices) =>
      Float64Array.from(dualPointFromBasis(basisIndices)),
    ),
    phase1Iterations: phase1.basisHistory.map((basisIndices) =>
      Float64Array.from(dualPointFromBasis(basisIndices)),
    ),
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
function warmStartBasisFromVertex(
  A: DenseMatrix,
  b: Float64Array,
  cPhase2: Float64Array,
  aPhase2: DenseMatrix,
  vertex: number[],
  tol: number,
): boolean[] | null {
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
    const state = buildBasisState(cPhase2, aPhase2, b, basis);
    for (let i = 0; i < state.xB.length; i++) {
      if (state.xB[i]! < -tol) return null; // basis is not primal feasible
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
  const { tol, verbose, dual, startVertex } = opts;
  const enteringRule = resolveEnteringRule(opts.enteringRule);
  const leavingRule = resolveLeavingRule(opts.leavingRule);
  const { A: aOriginal, b } = linesToDenseAb(lines);
  const m = aOriginal.rows;
  const n = aOriginal.cols;
  const cObjective = Float64Array.from(objective);

  if (dual) {
    return {
      ...solveDualMode(lines, aOriginal, b, cObjective, {
        tol,
        verbose,
        enteringRule,
        leavingRule,
      }),
      mode: "dual" as const,
    };
  }

  const gamma = Float64Array.from(b, (value) => (value < 0 ? -1 : 1));
  const bPhase1 = Float64Array.from(b, (value, index) => value * gamma[index]!);
  const aPositive = scaleRows(aOriginal, gamma);
  const aNegative = scaleMatrix(aPositive, -1);
  const gammaIdentity = createDenseMatrix(m, m);
  for (let i = 0; i < m; i++) {
    gammaIdentity.data[i * m + i] = gamma[i]!;
  }
  const identity = identityMatrix(m);
  const aPhase1 = hstackMatrices(aPositive, aNegative, gammaIdentity, identity);
  const cPhase1 = concatenateVectors(
    new Float64Array(2 * n + m),
    Float64Array.from({ length: m }, () => -1),
  );
  const phase1Basis = Array(2 * n + 2 * m).fill(false);
  for (let i = 0; i < m; i++) phase1Basis[2 * n + m + i] = true;

  const cPhase2 = concatenateVectors(
    cObjective,
    Float64Array.from(cObjective, (value) => -value),
    new Float64Array(m),
  );
  const aPhase2 = hstackMatrices(
    aOriginal,
    scaleMatrix(aOriginal, -1),
    identity,
  );

  const warmBasis =
    startVertex && startVertex.length === n
      ? warmStartBasisFromVertex(
          aOriginal,
          b,
          cPhase2,
          aPhase2,
          startVertex,
          tol,
        )
      : null;
  if (warmBasis) {
    if (verbose) console.log("Warm start (Phase 1 skipped)");
    const { iterations, logs, status } = simplexCore(
      cPhase2,
      aPhase2,
      b,
      warmBasis,
      {
        tol,
        verbose,
        phase1: false,
        nOrig: n,
        m,
        enteringRule,
        leavingRule,
      },
    );
    return {
      iterations: iterations.map((tableauX: Vec2N) =>
        primalPointFromSplitTableau(tableauX, n),
      ),
      phase1Iterations: [],
      logs: [["Skipped — warm start from the dragged start vertex.\n"], logs],
      mode: "primal" as const,
      status,
    };
  }

  if (verbose) console.log("Phase One");
  const {
    finalBasis: rawBasis1,
    iterations: phase1TableauIterations,
    logs: log1,
  } = simplexCore(cPhase1, aPhase1, bPhase1, phase1Basis, {
    tol,
    verbose,
    phase1: true,
    nOrig: n,
    m,
    enteringRule,
    leavingRule,
  });

  const phase2Basis = pivotOutArtificialVariables(
    aPhase1,
    bPhase1,
    rawBasis1,
    2 * n + m,
    tol,
  );

  if (verbose) console.log("Primal Simplex");
  const { iterations, logs, status } = simplexCore(
    cPhase2,
    aPhase2,
    b,
    phase2Basis,
    {
      tol,
      verbose,
      phase1: false,
      nOrig: n,
      m,
      enteringRule,
      leavingRule,
    },
  );

  const xIterations = iterations.map((tableauX: Vec2N) =>
    primalPointFromSplitTableau(tableauX, n),
  );
  const phase1Iterations = phase1TableauIterations.map((tableauX: Vec2N) =>
    primalPointFromSplitTableau(tableauX, n),
  );

  return {
    iterations: xIterations,
    phase1Iterations,
    logs: [log1, logs],
    mode: "primal" as const,
    status,
  };
}
