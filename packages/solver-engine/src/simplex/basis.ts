import { createDenseMatrix, type DenseMatrix, dot, matVec, transposeMatrix } from "@lpviz/math/blas";
import { invertDenseMatrix, solveDenseSystem } from "@lpviz/math/lapack";

/** An LP in standard form, `max c'x s.t. Ax = b, x >= 0`, as a simplex phase walks it. */
export interface StandardLp {
  A: DenseMatrix;
  b: Float64Array;
  c: Float64Array;
}

const REFACTOR_INTERVAL = 20;
const UNSTABLE_PIVOT = 1e-6;
/**
 * The current basis: which columns are basic, the basic column of each row, and B⁻¹, maintained by
 * eta updates between full refactorizations (every REFACTOR_INTERVAL pivots, or at once after a
 * pivot too small to trust).
 */
export class Basis {
  readonly m: number;
  /** the basic column of each row */
  readonly columns: number[] = [];
  readonly isBasic: boolean[];
  private readonly inverse: Float64Array;
  private readonly inverseMatrix: DenseMatrix;
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
    this.inverseMatrix = createDenseMatrix(this.m, this.m, this.inverse);
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
    matVec(this.inverseMatrix, v, out);
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

export function phaseScratch(lp: StandardLp) {
  const m = lp.A.rows;
  const cols = lp.A.cols;
  return {
    // the transpose, for the reduced costs' Aᵀy by row dot products
    At: transposeMatrix(lp.A),
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
export function basicSolution(lp: StandardLp, basis: Basis, scratch: PhaseScratch, exact: boolean) {
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
  matVec(scratch.At, scratch.duals, scratch.aty);
  for (let j = 0; j < A.cols; j++) reducedCosts[j] = c[j]! - scratch.aty[j]!;
  return { x, reducedCosts, objective: dot(c, x) };
}
