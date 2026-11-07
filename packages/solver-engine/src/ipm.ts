import { denseFromConstraints, type DenseMatrix, dot, infinityNorm, matVec, negate, negateMatrix, transposeMatrix, weightedGram } from "@lpviz/math/blas";
import { trySolveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { warmStart } from "./limits";
import { NumericTrace, type SolverResult } from "./result";

const SIGMA_MIN = 1e-8;
const SIGMA_MAX = 1 - 1e-8;
const SIGMA_POWER = 3;
// the homogeneous method's normal-equations regularization, relative to A'DA's largest diagonal
const REGULARIZATION = 1e-12;

export interface IPMOptions {
  /** the primal residual, dual residual and relative gap all have to drop below this */
  tol: number;
  maxit: number;
  alphaMax: number;
  correctorThreshold: number;
  /** Run the predictor–corrector on the homogeneous self-dual embedding (see ipmHomogeneous). */
  homogeneous?: boolean | undefined;
  /** Optional primal warm start; need not be feasible (infeasible-start method). */
  startPoint?: readonly number[] | undefined;
}

/**
 * A Mehrotra-style predictor–corrector interior point method on `max c'x s.t. Ax <= b`, written
 * as the minimization of −c over `(−A)x − s = −b, s ≥ 0`. Each iteration solves the normal
 * equations twice (the affine step, then the corrector) and steps a fraction `alphaMax` of the way
 * to the boundary; `mu = s'y / m` is the complementarity measure the 3D path is lifted by.
 */
export function ipm(constraints: readonly Constraint[], objective: Float64Array, opts: IPMOptions): SolverResult {
  if (opts.homogeneous) return ipmHomogeneous(constraints, objective, opts);
  const { tol, maxit, alphaMax, correctorThreshold, startPoint } = opts;

  // Ax <= b becomes (-A)x - s = -b with slack s >= 0, and max becomes min.
  const { A: aOriginal, b: bOriginal } = denseFromConstraints(constraints);
  const A = negateMatrix(aOriginal);
  const At = transposeMatrix(A);
  const b = negate(bOriginal);
  const c = negate(objective);
  const m = A.rows;
  const n = A.cols;

  const trace = new NumericTrace(n, "µ", maxit);

  const x = new Float64Array(n);
  const s = new Float64Array(m).fill(1);
  const y = new Float64Array(m).fill(1);
  const x0 = warmStart(startPoint, n);
  if (x0) {
    // Relocate only the primal point and keep s = y = 1, so a start at the default position
    // reproduces the cold trajectory. x0 need not be feasible (infeasible-start method), but
    // (s, y) must stay strictly positive: the fraction-to-boundary rule only preserves the
    // positivity it starts with, and s_i*y_i = 1 keeps the initial mu on scale for sigma.
    x.set(x0);
  }

  const ax = new Float64Array(m);
  const aty = new Float64Array(n);
  const rP = new Float64Array(m);
  const rD = new Float64Array(n);
  const rC = new Float64Array(m);
  const zeroP = new Float64Array(m);
  const zeroD = new Float64Array(n);
  const normal = new NormalEquations(A, At, s, y);
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
  // null once the normal equations are solved, else why they could not be
  const solve = (label: string, rP: Float64Array, rD: Float64Array, rC: Float64Array, dx: Float64Array, ds: Float64Array, dy: Float64Array): string | null =>
    normal.solve(rP, rD, rC, dx, ds, dy) ? null : `IPM ${label} solve failed: Singular linear system`;

  while (trace.count < maxit) {
    matVec(A, x, ax);
    matVec(At, y, aty);

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

    trace.record(x, -pObj, pRes, mu);

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

  return trace.finish(failureMessage ? { converged: false, lead: "Stopped", before: failureMessage } : { converged });
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
    private readonly At: DenseMatrix,
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
    weightedGram(A, (i) => y[i]! / s[i]!, M);
  }

  /** The step into dx, ds and dy; false when the normal matrix is singular. */
  solve(rP: Float64Array, rD: Float64Array, rC: Float64Array, dx: Float64Array, ds: Float64Array, dy: Float64Array): boolean {
    const { A, At, s, y, M, rhs, weighted, luScratch } = this;
    const { rows: m, cols: n } = A;
    for (let i = 0; i < m; i++) {
      weighted[i] = (rC[i]! + y[i]! * rP[i]!) / s[i]!;
    }
    matVec(At, weighted, rhs);
    for (let j = 0; j < n; j++) rhs[j]! -= rD[j]!;
    if (!trySolveDenseSystem(M, n, rhs, dx, luScratch)) return false;
    matVec(A, dx, ds);
    for (let i = 0; i < m; i++) {
      ds[i]! -= rP[i]!;
      dy[i] = (rC[i]! - y[i]! * ds[i]!) / s[i]!;
    }
    return true;
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

/**
 * The same predictor–corrector on the homogeneous self-dual embedding (Xu, Hung and Ye 1996) of
 * `min c'x s.t. Ax - s = b, s >= 0` and its dual `max b'y s.t. A'y = c, y >= 0`:
 *
 *   F1 = Ax - s - b tau = 0,   F2 = A'y - c tau = 0,   F3 = c'x - b'y + kappa = 0,
 *   s o y = mu e,   tau kappa = mu,   (s, y, tau, kappa) > 0.
 *
 * A solution with tau > 0 is the optimum (x, y) / tau; one with tau = 0 < kappa is a Farkas
 * certificate, so the method runs on infeasible and unbounded LPs too. All steps share one length
 * (tau couples the primal and the dual), and mu = (s'y + tau kappa) / (m + 1) is reported as
 * mu / tau^2, the complementarity of the recovered point, in the plain method's units.
 */
function ipmHomogeneous(constraints: readonly Constraint[], objective: Float64Array, opts: IPMOptions): SolverResult {
  const { tol, maxit, alphaMax, correctorThreshold, startPoint } = opts;
  const { A: aOriginal, b: bOriginal } = denseFromConstraints(constraints);
  const A = negateMatrix(aOriginal);
  const At = transposeMatrix(A);
  const b = negate(bOriginal);
  const c = negate(objective);
  const m = A.rows;
  const n = A.cols;

  const x = new Float64Array(n);
  const s = new Float64Array(m).fill(1);
  const y = new Float64Array(m).fill(1);
  let tau = 1;
  let kappa = 1;
  const x0 = warmStart(startPoint, n);
  if (x0) x.set(x0);

  const trace = new NumericTrace(n, "µ", maxit);
  const point = new Float64Array(n);
  const ax = new Float64Array(m);
  const aty = new Float64Array(n);
  const F1 = new Float64Array(m);
  const F2 = new Float64Array(n);
  const F4 = new Float64Array(m);
  const M = new Float64Array(n * n);
  const lu = new Float64Array(n * n);
  const weighted = new Float64Array(m);
  const rhs = new Float64Array(n);
  const pSol = new Float64Array(n);
  const qSol = new Float64Array(n);
  const dBVec = new Float64Array(m);
  const atDb = new Float64Array(n);
  const step = { dx: new Float64Array(n), ds: new Float64Array(m), dy: new Float64Array(m), dTau: 0, dKappa: 0 };
  const aff = { dx: new Float64Array(n), ds: new Float64Array(m), dy: new Float64Array(m), dTau: 0, dKappa: 0 };
  const scratchDx = new Float64Array(m);

  // One Newton step for the linear residuals F1..F3 and the complementarity right-hand sides
  // F4 (per pair) and F5 (tau kappa); D = y / s is the normal-equations weight:
  //   (A'DA) dx = r1 + (A'Db - c) dTau,   r1 = F2 - A'(D F1 + F4 / s)
  //   dTau from the gap row, then dy = D(-F1 - A dx + b dTau) - F4 / s, ds and dKappa from complementarity.
  // Solves J d = -F for the residuals as given; returns false when A'DA is singular.
  const newton = (F3: number, F5: number, out: typeof step): boolean => {
    for (let i = 0; i < m; i++) {
      const D = y[i]! / s[i]!;
      weighted[i] = D * F1[i]! + F4[i]! / s[i]!;
      dBVec[i] = D * b[i]!;
    }
    matVec(At, weighted, rhs);
    for (let j = 0; j < n; j++) rhs[j] = F2[j]! - rhs[j]!;
    if (!trySolveDenseSystem(M, n, rhs, pSol, lu)) return false;
    matVec(At, dBVec, atDb);
    for (let j = 0; j < n; j++) rhs[j] = atDb[j]! - c[j]!;
    if (!trySolveDenseSystem(M, n, rhs, qSol, lu)) return false;
    // the gap row: (c + A'Db)'dx - (b'Db + kappa/tau) dTau = -F3 - b'(D F1 + F4 / s) + F5 / tau
    let eP = 0;
    let eQ = 0;
    for (let j = 0; j < n; j++) {
      const e = c[j]! + atDb[j]!;
      eP += e * pSol[j]!;
      eQ += e * qSol[j]!;
    }
    const denominator = eQ - dot(b, dBVec) - kappa / tau;
    const dTau = (-F3 - dot(b, weighted) + F5 / tau - eP) / denominator;
    if (!Number.isFinite(dTau)) return false;
    for (let j = 0; j < n; j++) out.dx[j] = pSol[j]! + qSol[j]! * dTau;
    matVec(A, out.dx, scratchDx);
    for (let i = 0; i < m; i++) {
      out.dy[i] = (y[i]! / s[i]!) * (-F1[i]! - scratchDx[i]! + b[i]! * dTau) - F4[i]! / s[i]!;
      out.ds[i] = (-F4[i]! - s[i]! * out.dy[i]!) / y[i]!;
    }
    out.dTau = dTau;
    out.dKappa = (-F5 - kappa * dTau) / tau;
    return true;
  };
  // the largest step in [0, 1] keeping s, y, tau and kappa nonnegative
  const boundary = (d: typeof step) => {
    let alpha = Math.min(fractionToBoundary(s, d.ds), fractionToBoundary(y, d.dy));
    if (d.dTau < 0) alpha = Math.min(alpha, -tau / d.dTau);
    if (d.dKappa < 0) alpha = Math.min(alpha, -kappa / d.dKappa);
    return alpha;
  };

  let status: "optimal" | "infeasible" | "unbounded" | undefined;
  let failure: string | null = null;
  while (trace.count < maxit) {
    matVec(A, x, ax);
    matVec(At, y, aty);
    for (let i = 0; i < m; i++) F1[i] = ax[i]! - s[i]! - b[i]! * tau;
    for (let j = 0; j < n; j++) F2[j] = aty[j]! - c[j]! * tau;
    const cx = dot(c, x);
    const by = dot(b, y);
    const F3 = cx - by + kappa;
    const mu = (dot(s, y) + tau * kappa) / (m + 1);

    for (let j = 0; j < n; j++) point[j] = x[j]! / tau;
    const pRes = infinityNorm(F1) / tau;
    const dRes = infinityNorm(F2) / tau;
    const gap = Math.abs(cx - by) / tau / (1 + Math.abs(cx / tau));
    trace.record(point, -cx / tau, pRes, mu / (tau * tau));

    if (pRes <= tol && dRes <= tol && gap <= tol) {
      status = "optimal";
      break;
    }
    // tau has collapsed against kappa: test the Farkas rays, scale-free
    if (tau < tol * kappa) {
      const yScale = infinityNorm(y);
      if (by > tol * yScale && infinityNorm(aty) <= tol * by) {
        status = "infeasible";
        break;
      }
      let recession = 0;
      for (let i = 0; i < m; i++) recession = Math.max(recession, Math.abs(ax[i]! - s[i]!));
      if (-cx > tol * infinityNorm(x) && recession <= tol * -cx) {
        status = "unbounded";
        break;
      }
    }

    weightedGram(A, (i) => y[i]! / s[i]!, M);
    // a variable no row bounds (a strip's free direction) leaves A'DA singular; a regularization far
    // below the tolerance lets that direction move, and the gap row then finds the unbounded ray
    let diagonal = 0;
    for (let j = 0; j < n; j++) diagonal = Math.max(diagonal, M[j * n + j]!);
    for (let j = 0; j < n; j++) M[j * n + j]! += REGULARIZATION * (1 + diagonal);
    // predictor: the affine step, mu -> 0
    for (let i = 0; i < m; i++) F4[i] = s[i]! * y[i]!;
    if (!newton(F3, tau * kappa, aff)) {
      failure = "IPM linear solve failed: Singular linear system";
      break;
    }
    const alphaAff = boundary(aff);
    let next = aff;
    if (!(alphaAff >= correctorThreshold)) {
      let muAff = (tau + alphaAff * aff.dTau) * (kappa + alphaAff * aff.dKappa);
      for (let i = 0; i < m; i++) muAff += (s[i]! + alphaAff * aff.ds[i]!) * (y[i]! + alphaAff * aff.dy[i]!);
      muAff /= m + 1;
      const sigma = mu > 0 ? Math.max(SIGMA_MIN, Math.min(SIGMA_MAX, (muAff / mu) ** SIGMA_POWER)) : SIGMA_MIN;
      // corrector: centering toward sigma mu with Mehrotra's second-order term, in one solve
      for (let i = 0; i < m; i++) F4[i] = s[i]! * y[i]! + aff.ds[i]! * aff.dy[i]! - sigma * mu;
      if (!newton(F3, tau * kappa + aff.dTau * aff.dKappa - sigma * mu, step)) {
        failure = "IPM corrector solve failed: Singular linear system";
        break;
      }
      next = step;
    }
    const alpha = alphaMax * boundary(next);
    for (let j = 0; j < n; j++) x[j]! += alpha * next.dx[j]!;
    for (let i = 0; i < m; i++) {
      s[i]! += alpha * next.ds[i]!;
      y[i]! += alpha * next.dy[i]!;
    }
    tau += alpha * next.dTau;
    kappa += alpha * next.dKappa;
  }

  const lead = status === "infeasible" ? "Certified primal infeasible" : status === "unbounded" ? "Certified unbounded" : failure ? "Stopped" : undefined;
  return trace.finish({ converged: status === "optimal", lead, ...(failure ? { before: failure } : {}) }, { status });
}
