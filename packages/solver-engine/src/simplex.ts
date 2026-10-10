import {
  createDenseMatrix,
  type DenseMatrix,
  denseFromConstraints,
  diagonalMatrix,
  dot,
  extractColumn,
  hstackMatrices,
  identityMatrix,
  negateMatrix,
  scaleRows,
  transposeMatrix,
  transposedMatVec,
} from "@lpviz/math/blas";
import { invertDenseMatrix, solveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { coordinateHeaders, fmtCoordinates, fmtExp, fmtIteration, ITERATION_COLUMN_WIDTH, logColumnWidths } from "./fmt";
import { MAX_ITERATIONS } from "./limits";
import type { LogSection, SolverResult } from "./result";
import { splitStandardForm, unsplit } from "./standardForm";

type SimplexStatus = NonNullable<SolverResult["status"]>;
type SimplexMode = NonNullable<SolverResult["mode"]>;

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

export interface SimplexOptions {
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
  /** Entering-variable pivot rule (see ENTERING_RULES). Defaults to "first" (Bland). */
  enteringRule?: EnteringRule | undefined;
  /** Ratio-test tie-break (see LEAVING_RULES). Defaults to "first" (lowest index). */
  leavingRule?: LeavingRule | undefined;
}

/** An LP in standard form, `max c'x s.t. Ax = b, x >= 0`, as a simplex phase walks it. */
interface StandardLp {
  A: DenseMatrix;
  b: Float64Array;
  c: Float64Array;
}

const REFACTOR_INTERVAL = 20;
const UNSTABLE_PIVOT = 1e-6;
// Only Bland's rule (lowest index entering and leaving) is guaranteed not to cycle, so after this
// many consecutive degenerate pivots (minimum ratio ~ 0) a simplex phase falls back to it for the
// rest of the phase; those iterations carry a "d" after their number in the log. A legitimately
// degenerate vertex in the app's problems needs only a handful, and a false trigger is harmless.
export const MAX_CONSECUTIVE_DEGENERATE_PIVOTS = 25;
// A warm-start vertex must be reproduced by its basis to this relative precision.
const WARM_START_VERTEX_TOLERANCE = 1e-6;
const UNBOUNDED_NOTE = "LP is unbounded. No leaving variable found.";

/**
 * The current basis: which columns are basic, the basic column of each row, and B⁻¹, maintained by
 * eta updates between full refactorizations (every REFACTOR_INTERVAL pivots, or at once after a
 * pivot too small to trust).
 */
class Basis {
  readonly m: number;
  /** the basic column of each row */
  readonly columns: number[] = [];
  readonly isBasic: boolean[];
  private readonly inverse: Float64Array;
  private readonly work: Float64Array;
  private readonly matrix: Float64Array;
  private transposed: Float64Array | null = null;
  private pivotsSinceRefactor = 0;

  constructor(
    private readonly A: DenseMatrix,
    isBasic: readonly boolean[],
  ) {
    this.m = A.rows;
    this.isBasic = isBasic.slice();
    for (let j = 0; j < isBasic.length; j++) if (isBasic[j]) this.columns.push(j);
    this.inverse = new Float64Array(this.m * this.m);
    this.work = new Float64Array(this.m * this.m);
    this.matrix = new Float64Array(this.m * this.m);
    this.refactor();
  }

  /** True once any eta update has been applied since the last rebuild. */
  get stale(): boolean {
    return this.pivotsSinceRefactor > 0;
  }

  refactor(): void {
    const { m, A } = this;
    for (let col = 0; col < m; col++) {
      const source = this.columns[col]!;
      for (let row = 0; row < m; row++) {
        this.matrix[row * m + col] = A.data[row * A.cols + source]!;
      }
    }
    invertDenseMatrix(this.matrix, m, this.inverse, this.work);
    this.transposed = null;
    this.pivotsSinceRefactor = 0;
  }

  /** out = B⁻¹ v by a direct solve, independent of the maintained inverse. */
  solveExact(v: Float64Array, out: Float64Array): Float64Array {
    return solveDenseSystem(this.matrix, this.m, v, out, this.work);
  }

  /** out = B⁻ᵀ v by a direct solve; see solveExact. */
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
      for (let k = 0; k < m; k++) out[k]! += inverse[offset + k]! * scale;
    }
    return out;
  }

  /** Swap `entering` into the basis for the column `leavingRow` carries; `direction` is B⁻¹ times the entering column. */
  pivot(leavingRow: number, direction: Float64Array, entering: number): void {
    const { m, inverse } = this;
    const pivotValue = direction[leavingRow]!;
    const rowR = leavingRow * m;
    const scale = 1 / pivotValue;
    for (let k = 0; k < m; k++) inverse[rowR + k]! *= scale;
    for (let i = 0; i < m; i++) {
      if (i === leavingRow) continue;
      const factor = direction[i]!;
      if (factor === 0) continue;
      const rowI = i * m;
      for (let k = 0; k < m; k++) inverse[rowI + k]! -= factor * inverse[rowR + k]!;
    }
    this.isBasic[this.columns[leavingRow]!] = false;
    this.isBasic[entering] = true;
    this.columns[leavingRow] = entering;
    if (++this.pivotsSinceRefactor >= REFACTOR_INTERVAL || Math.abs(pivotValue) < UNSTABLE_PIVOT) {
      this.refactor();
    }
  }
}

type PhaseScratch = ReturnType<typeof phaseScratch>;

function phaseScratch(m: number, cols: number) {
  return {
    xB: new Float64Array(m),
    cB: new Float64Array(m),
    duals: new Float64Array(m),
    aty: new Float64Array(cols),
    x: new Float64Array(cols),
    reducedCosts: new Float64Array(cols),
    enterColumn: new Float64Array(m),
    direction: new Float64Array(m),
  };
}

// The basic solution of the current basis: x over every column, the reduced costs, the objective.
// Both vectors live in the scratch and hold until the next call.
function basicSolution(lp: StandardLp, basis: Basis, scratch: PhaseScratch, exact: boolean) {
  const { A, b, c } = lp;
  const { m, columns } = basis;
  const { x, reducedCosts } = scratch;
  if (exact) basis.solveExact(b, scratch.xB);
  else basis.apply(b, scratch.xB);
  x.fill(0);
  for (let i = 0; i < m; i++) {
    x[columns[i]!] = scratch.xB[i]!;
    scratch.cB[i] = c[columns[i]!]!;
  }
  if (exact) basis.solveTransposeExact(scratch.cB, scratch.duals);
  else basis.applyTranspose(scratch.cB, scratch.duals);
  transposedMatVec(A, scratch.duals, scratch.aty);
  for (let j = 0; j < A.cols; j++) reducedCosts[j] = c[j]! - scratch.aty[j]!;
  return { x, reducedCosts, objective: dot(c, x) };
}

function selectEnteringIndex(isBasic: readonly boolean[], reducedCosts: Float64Array, tol: number, rule: EnteringRule): number {
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

function selectLeavingIndex(xB: Float64Array, direction: Float64Array, columns: readonly number[], tol: number, rule: LeavingRule): number {
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

const basisString = (isBasic: readonly boolean[]) => isBasic.map((basic) => (basic ? 1 : 0)).join("");

interface PhaseConfig {
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

function simplexPhase(lp: StandardLp, initialBasis: readonly boolean[], cfg: PhaseConfig): PhaseRun {
  const { tol, pivotRules, phase, dimension, pointOf, unboundedNote } = cfg;
  const { A } = lp;
  const widths = logColumnWidths(dimension);
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${coordinateHeaders(dimension)} ${"Obj".padStart(widths.measure)} ${"basis".padEnd(A.cols)}\n`;
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
    rows.push(`${fmtIteration(iteration, guard.active ? "d" : "")} ${fmtCoordinates(point, widths.coordinate)} ${fmtExp(objective, widths.measure, 1)} ${basisString(basis.isBasic)}\n`);

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

type PhaseLog = Pick<PhaseRun, "iterates" | "log">;

// A phase that never ran: its log is the one line saying why.
const skippedPhase = (reason: string): PhaseLog => ({ iterates: [], log: { header: reason, rows: [] } });

function simplexResult(phase1: PhaseLog, phase2: PhaseLog, status: SimplexStatus, mode: SimplexMode): SolverResult {
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

// The Phase-1 problem for {columns(gamma) x = gamma ∘ b, x >= 0}: rows are
// flipped so the right-hand side is nonnegative, one artificial column per row
// is appended, the objective is -sum(artificials) and they form the first basis.
function phase1Problem(b: Float64Array, columnsOf: (gamma: Float64Array) => DenseMatrix) {
  const gamma = Float64Array.from(b, (value) => (value < 0 ? -1 : 1));
  const flippedB = Float64Array.from(b, (value, index) => value * gamma[index]!);
  const columns = columnsOf(gamma);
  const { rows, cols } = columns;
  const lp: StandardLp = { A: hstackMatrices(columns, identityMatrix(rows)), b: flippedB, c: new Float64Array(cols + rows).fill(-1, cols) };
  const isBasic: boolean[] = new Array<boolean>(cols + rows).fill(false);
  for (let i = 0; i < rows; i++) isBasic[cols + i] = true;
  return { columns, lp, isBasic };
}

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
