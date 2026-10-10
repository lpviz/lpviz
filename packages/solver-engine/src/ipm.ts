import { type DenseMatrix, denseFromConstraints, dot, infinityNorm, matVec, negateMatrix, transposedMatVec } from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { numericLogHeader, solveFooter } from "./fmt";
import { assertMaxit } from "./limits";
import { NumericTrace, type SolverResult } from "./result";

const SIGMA_MIN = 1e-8;
const SIGMA_MAX = 1 - 1e-8;
const SIGMA_POWER = 3;

export interface IPMOptions {
  /** the primal residual, dual residual and relative gap all have to drop below this */
  tol: number;
  maxit: number;
  alphaMax: number;
  correctorThreshold: number;
  /** Optional primal warm start; need not be feasible (infeasible-start method). */
  startPoint?: readonly number[] | undefined;
}

/**
 * A Mehrotra-style predictor–corrector interior point method on `max c'x s.t. Ax <= b`, written
 * as the minimization of −c over `(−A)x + s = −b, s ≥ 0`. Each iteration solves the normal
 * equations twice (the affine step, then the corrector) and steps a fraction `alphaMax` of the way
 * to the boundary; `mu = s'y / m` is the complementarity measure the 3D path is lifted by.
 */
export function ipm(constraints: readonly Constraint[], objective: Float64Array, opts: IPMOptions): SolverResult {
  const { tol, maxit, alphaMax, correctorThreshold, startPoint } = opts;

  assertMaxit(maxit);

  // Ax <= b becomes (-A)x + s = -b with slack s >= 0, and max becomes min.
  const { A: aOriginal, b: bOriginal } = denseFromConstraints(constraints);
  const A = negateMatrix(aOriginal);
  const b = Float64Array.from(bOriginal, (value) => -value);
  const c = Float64Array.from(objective, (value) => -value);
  const m = A.rows;
  const n = A.cols;

  const trace = new NumericTrace();

  const x = new Float64Array(n);
  const s = new Float64Array(m).fill(1);
  const y = new Float64Array(m).fill(1);
  if (startPoint && startPoint.length === n) {
    // Relocate only the primal point and keep s = y = 1, so a start at the default position
    // reproduces the cold trajectory. x0 need not be feasible (infeasible-start method), but
    // (s, y) must stay strictly positive: the fraction-to-boundary rule only preserves the
    // positivity it starts with, and s_i*y_i = 1 keeps the initial mu on scale for sigma.
    x.set(startPoint);
  }

  const ax = new Float64Array(m);
  const aty = new Float64Array(n);
  const rP = new Float64Array(m);
  const rD = new Float64Array(n);
  const rC = new Float64Array(m);
  const zeroP = new Float64Array(m);
  const zeroD = new Float64Array(n);
  const normal = new NormalEquations(A, s, y);
  const dxAff = new Float64Array(n);
  const dsAff = new Float64Array(m);
  const dyAff = new Float64Array(m);
  const dxCor = new Float64Array(n);
  const dsCor = new Float64Array(m);
  const dyCor = new Float64Array(m);
  const dx = new Float64Array(n);
  const ds = new Float64Array(m);
  const dy = new Float64Array(m);

  let converged = false;
  let failureMessage: string | null = null;
  const startTime = performance.now();
  // null once the normal equations are solved, else why they could not be
  const solve = (label: string, rP: Float64Array, rD: Float64Array, rC: Float64Array, dx: Float64Array, ds: Float64Array, dy: Float64Array): string | null => {
    try {
      normal.solve(rP, rD, rC, dx, ds, dy);
      return null;
    } catch (error) {
      return `IPM ${label} solve failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  };

  while (trace.count < maxit) {
    matVec(A, x, ax);
    transposedMatVec(A, y, aty);

    for (let i = 0; i < m; i++) {
      rP[i] = b[i]! - ax[i]! + s[i]!;
    }
    for (let j = 0; j < n; j++) {
      rD[j] = c[j]! - aty[j]!;
    }

    const mu = dot(s, y) / m;
    const pObj = dot(c, x);
    const gap = Math.abs(pObj - dot(b, y)) / (1 + Math.abs(pObj));
    const pRes = infinityNorm(rP);

    trace.record(x.slice(), -pObj, pRes, mu);

    if (pRes <= tol && infinityNorm(rD) <= tol && gap <= tol) {
      converged = true;
      break;
    }

    normal.form();
    for (let i = 0; i < m; i++) rC[i] = -s[i]! * y[i]!;
    failureMessage = solve("linear", rP, rD, rC, dxAff, dsAff, dyAff);
    if (failureMessage) break;

    const alphaP = fractionToBoundary(s, dsAff);
    const alphaD = fractionToBoundary(y, dyAff);
    let muAff = 0;
    for (let i = 0; i < m; i++) {
      muAff += (s[i]! + alphaP * dsAff[i]!) * (y[i]! + alphaD * dyAff[i]!);
    }
    muAff /= m;

    if (!(alphaP >= correctorThreshold && alphaD >= correctorThreshold)) {
      // mu can reach exactly 0 when alphaMax = 1; (0/0)**p would be NaN
      const sigma = mu > 0 ? Math.max(SIGMA_MIN, Math.min(SIGMA_MAX, (muAff / mu) ** SIGMA_POWER)) : SIGMA_MIN;
      for (let i = 0; i < m; i++) {
        rC[i] = -(dsAff[i]! * dyAff[i]! - sigma * mu);
      }
      failureMessage = solve("corrector", zeroP, zeroD, rC, dxCor, dsCor, dyCor);
      if (failureMessage) break;

      for (let j = 0; j < n; j++) dx[j] = dxAff[j]! + dxCor[j]!;
      for (let i = 0; i < m; i++) {
        ds[i] = dsAff[i]! + dsCor[i]!;
        dy[i] = dyAff[i]! + dyCor[i]!;
      }
    } else {
      dx.set(dxAff);
      ds.set(dsAff);
      dy.set(dyAff);
    }

    const stepP = alphaMax * fractionToBoundary(s, ds);
    const stepD = alphaMax * fractionToBoundary(y, dy);
    for (let j = 0; j < n; j++) x[j]! += dx[j]! * stepP;
    for (let i = 0; i < m; i++) {
      s[i]! += ds[i]! * stepP;
      y[i]! += dy[i]! * stepD;
    }
  }

  const solveTime = performance.now() - startTime;
  const footer = failureMessage ? `${failureMessage}\n${solveFooter(false, trace.count, solveTime, "Stopped")}\n` : `${solveFooter(converged, trace.count, solveTime)}\n`;
  return trace.result(numericLogHeader(n, "µ"), footer);
}

//   [ A  -I   0 ] [dx]   [rP]        (primal residual)
//   [ 0   0  Aᵀ ] [ds] = [rD]        (dual residual)
//   [ 0   Y   S ] [dy]   [rC]        (complementarity)
//
//   (Aᵀ D A) dx = Aᵀ((rC + y∘rP)/s) − rD,   D = diag(y/s),
class NormalEquations {
  private readonly M: Float64Array;
  private readonly luScratch: Float64Array;
  private readonly rhs: Float64Array;
  private readonly weighted: Float64Array;

  constructor(
    private readonly A: DenseMatrix,
    private readonly s: Float64Array,
    private readonly y: Float64Array,
  ) {
    const n = A.cols;
    this.M = new Float64Array(n * n);
    this.luScratch = new Float64Array(n * n);
    this.rhs = new Float64Array(n);
    this.weighted = new Float64Array(A.rows);
  }

  /** Rebuild Aᵀ D A for the current s and y. */
  form(): void {
    const { A, s, y, M } = this;
    const { rows: m, cols: n } = A;
    M.fill(0);
    for (let i = 0; i < m; i++) {
      const d = y[i]! / s[i]!;
      const offset = i * n;
      for (let j = 0; j < n; j++) {
        const dj = d * A.data[offset + j]!;
        for (let k = 0; k < n; k++) {
          M[j * n + k]! += dj * A.data[offset + k]!;
        }
      }
    }
  }

  solve(rP: Float64Array, rD: Float64Array, rC: Float64Array, dx: Float64Array, ds: Float64Array, dy: Float64Array): void {
    const { A, s, y, M, rhs, weighted, luScratch } = this;
    const { rows: m, cols: n } = A;
    for (let i = 0; i < m; i++) {
      weighted[i] = (rC[i]! + y[i]! * rP[i]!) / s[i]!;
    }
    transposedMatVec(A, weighted, rhs);
    for (let j = 0; j < n; j++) rhs[j]! -= rD[j]!;
    solveDenseSystem(M, n, rhs, dx, luScratch);
    matVec(A, dx, ds);
    for (let i = 0; i < m; i++) {
      ds[i]! -= rP[i]!;
      dy[i] = (rC[i]! - y[i]! * ds[i]!) / s[i]!;
    }
  }
}

// The largest step in [0, 1] that keeps every `values[i] + alpha * delta[i]` nonnegative.
function fractionToBoundary(values: Float64Array, delta: Float64Array) {
  let alpha = 1;
  for (let i = 0; i < values.length; i++) {
    const direction = delta[i]!;
    if (direction < 0) {
      alpha = Math.min(alpha, -values[i]! / direction);
    }
  }
  return alpha;
}
