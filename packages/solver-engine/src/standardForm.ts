import { type DenseMatrix, hstackMatrices, identityMatrix, negateMatrix } from "@lpviz/math/blas";

/**
 * The split standard form of `Ax ≤ b` with cost `c`: x = x⁺ − x⁻ with x⁺, x⁻ ≥ 0 and one slack per
 * row, so the constraint matrix is [A, −A, I] and the cost [c; −c; 0].
 */
export function splitStandardForm(A: DenseMatrix, cost: Float64Array): { A: DenseMatrix; c: Float64Array } {
  const n = A.cols;
  const c = new Float64Array(2 * n + A.rows);
  c.set(cost);
  for (let j = 0; j < n; j++) c[n + j] = -cost[j]!;
  return { A: hstackMatrices(A, negateMatrix(A), identityMatrix(A.rows)), c };
}

/** The original variables x = x⁺ − x⁻ of a split-form point. */
export function unsplit(chi: Float64Array, n: number): Float64Array {
  const point = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    point[j] = (chi[j] ?? 0) - (chi[n + j] ?? 0);
  }
  return point;
}
