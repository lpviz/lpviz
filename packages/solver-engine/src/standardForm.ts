import { type DenseMatrix, hstackMatrices, identityMatrix, type LinearOperator, negateMatrix } from "@lpviz/math/blas";

/**
 * The split standard form of `Ax ≤ b` with cost `c`: x = x⁺ − x⁻ with x⁺, x⁻ ≥ 0 and one slack per
 * row, so the constraint matrix is [A, −A, I] and the cost [c; −c; 0].
 */
export function splitStandardForm(A: DenseMatrix, cost: Float64Array): { A: DenseMatrix; c: Float64Array } {
  return { A: hstackMatrices(A, negateMatrix(A), identityMatrix(A.rows)), c: splitCost(cost, A.rows) };
}

/** The split form's cost [c; −c; 0]. */
export function splitCost(cost: Float64Array, rows: number): Float64Array {
  const n = cost.length;
  const c = new Float64Array(2 * n + rows);
  c.set(cost);
  for (let j = 0; j < n; j++) c[n + j] = -cost[j]!;
  return c;
}

/**
 * The split form's matrix [A, −A, I] applied without forming it: a product costs the two A blocks
 * and one slack per row instead of a dense row of 2n + m. The sums run in the order the dense
 * product would run them, so the results are the same floats, down to the zero entries' effect:
 * a dense zero times a slack adds +0 (so a partial sum of −0 ends +0) or NaN when the slack is
 * not finite, and the same for a dual times the identity's zeros.
 */
export function splitOperator(A: DenseMatrix): LinearOperator {
  const { rows: m, cols: n, data } = A;
  const slackOffset = 2 * n;
  // the dense zeros' NaN: a product over the whole column block poisons every sum but the one
  // that the non-finite entry feeds through a 1
  const nonFinite = (vector: Float64Array, from: number, count: number) => {
    let bad = 0;
    for (let i = 0; i < count; i++) if (!Number.isFinite(vector[from + i]!)) bad++;
    return bad;
  };
  return {
    rows: m,
    cols: slackOffset + m,
    apply: (chi, out) => {
      const badSlacks = nonFinite(chi, slackOffset, m);
      for (let i = 0; i < m; i++) {
        const offset = i * n;
        let sum = 0;
        for (let j = 0; j < n; j++) sum += data[offset + j]! * chi[j]!;
        for (let j = 0; j < n; j++) sum += -data[offset + j]! * chi[n + j]!;
        const slack = chi[slackOffset + i]!;
        if (badSlacks > (Number.isFinite(slack) ? 0 : 1)) {
          out[i] = NaN;
          continue;
        }
        if (Object.is(sum, -0)) sum = 0;
        out[i] = sum + slack;
      }
    },
    applyTranspose: (y, out) => {
      for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < m; i++) sum += data[i * n + j]! * y[i]!;
        out[j] = sum;
        let negated = 0;
        for (let i = 0; i < m; i++) negated += -data[i * n + j]! * y[i]!;
        out[n + j] = negated;
      }
      const badDuals = nonFinite(y, 0, m);
      for (let i = 0; i < m; i++) {
        const dual = y[i]!;
        // a −0 dual reaches the sum as +0 + (−0), which is +0
        out[slackOffset + i] = badDuals > (Number.isFinite(dual) ? 0 : 1) ? NaN : dual === 0 ? 0 : dual;
      }
    },
  };
}

/** The original variables x = x⁺ − x⁻ of a split-form point, into `point`. */
export function unsplit(chi: Float64Array, n: number, point = new Float64Array(n)): Float64Array {
  for (let j = 0; j < n; j++) {
    point[j] = (chi[j] ?? 0) - (chi[n + j] ?? 0);
  }
  return point;
}
