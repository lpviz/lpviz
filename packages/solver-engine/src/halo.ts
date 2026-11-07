// HALO-LP (arXiv:2611.01038): a homogeneous all-shifted non-interior-point method. Newton steps on
// the homogeneous self-dual embedding of `min c'x s.t. Gx + s = h, s >= 0`, with the complementarity
// pairs (s, z) and (tau, kappa) written through the smoothed minimum NCP function
// phi(a, b; mu) = a + b - sqrt((a - b)^2 + 4 mu), shifted by proximal terms toward a reference point
// w_E. No iterate has to stay positive: s, z, tau, kappa may all leave the orthant, so any warm start
// is a valid start. The drawn trace is the recovered point x / tau of each iterate.
//
// The paper leaves the line search and the parameter updates to ODYN; here they are a non-monotone
// Armijo backtrack on the natural NCP merit, and, whenever an accepted step shrinks the stacked
// residual enough, the proximal reference moves to the iterate and mu to its complementarity measure.

import { denseFromConstraints, type DenseMatrix, dot, matVec, negate, transposeMatrix } from "@lpviz/math/blas";
import { cholesky } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { warmStart } from "./limits";
import { NumericTrace, type SolverResult } from "./result";

// the proximal weight on x, z and tau (rho_d, rho_i, rho_tau); rhoN, the NCP shift, is an option
const RHO = 1e-6;
// the update neighborhood (theta, beta) and the Armijo line search
const THETA = 0.9;
const BETA = 10;
const ARMIJO = 1e-4;
const BACKTRACK = 0.5;
const MIN_STEP = 1e-10;
const NONMONOTONE_MEMORY = 5;
const MU_FLOOR = 1e-16;

export interface HALOOptions {
  /** absolute and relative termination tolerance (the paper's eps_a = eps_r) */
  tol: number;
  maxit: number;
  /** rho_n, the proximal weight of the shifted NCP equations */
  rhoN: number;
  /** Optional primal warm start; s takes b - Ax0, negative where x0 violates a constraint. */
  startPoint?: readonly number[] | undefined;
}

/** One point w = (x, z, s, tau, kappa) of the embedding. */
class Point {
  tau = 1;
  kappa = 1;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly s: Float64Array;
  constructor(n: number, p: number) {
    this.x = new Float64Array(n);
    this.z = new Float64Array(p).fill(1);
    this.s = new Float64Array(p).fill(1);
  }
  set(from: Point, step = 0, d?: Point) {
    const a = d ? step : 0;
    this.tau = from.tau + a * (d?.tau ?? 0);
    this.kappa = from.kappa + a * (d?.kappa ?? 0);
    for (let i = 0; i < this.x.length; i++) this.x[i] = from.x[i]! + a * (d?.x[i] ?? 0);
    for (let i = 0; i < this.z.length; i++) {
      this.z[i] = from.z[i]! + a * (d?.z[i] ?? 0);
      this.s[i] = from.s[i]! + a * (d?.s[i] ?? 0);
    }
  }
}

const ncp = (a: number, b: number, mu: number) => a + b - Math.sqrt((a - b) ** 2 + 4 * mu);
/** min(a, b)^2: the exact complementarity violation of one pair */
const minSq = (a: number, b: number) => Math.min(a, b) ** 2;

/**
 * The residuals of the proximal all-shifted HSD equations at one point, for fixed mu and w_E:
 *   rD = G'z + c tau + rho (x - xE)            rI = Gx + s - h tau - rho (z - zE)
 *   rG = -c'x - h'z - kappa + rho (tau - tauE)
 *   rN = phi(s, z) + rhoN (s - sE) + rhoN (z - zE)   rH = phi(tau, kappa) + rhoN (tau - tauE) + rhoN (kappa - kappaE)
 */
class Residuals {
  readonly rD: Float64Array;
  readonly rI: Float64Array;
  readonly rN: Float64Array;
  rG = 0;
  rH = 0;
  readonly gx: Float64Array;
  readonly gtz: Float64Array;
  constructor(n: number, p: number) {
    this.rD = new Float64Array(n);
    this.rI = new Float64Array(p);
    this.rN = new Float64Array(p);
    this.gx = new Float64Array(p);
    this.gtz = new Float64Array(n);
  }
  /** the natural merit 1/2 (||rN||^2 + rH^2) */
  merit() {
    return 0.5 * (dot(this.rN, this.rN) + this.rH * this.rH);
  }
  /** the stacked residual's infinity norm */
  norm() {
    let r = Math.max(Math.abs(this.rG), Math.abs(this.rH));
    for (const v of [this.rD, this.rI, this.rN]) for (let i = 0; i < v.length; i++) r = Math.max(r, Math.abs(v[i]!));
    return r;
  }
}

/** HALO-LP on `min c'x s.t. Gx <= h`, x free. */
function haloCore(G: DenseMatrix, h: Float64Array, c: Float64Array, x0: readonly number[] | null, opts: HALOOptions): SolverResult {
  const { tol, maxit, rhoN: RHO_N } = opts;
  const { rows: p, cols: n } = G;
  const Gt = transposeMatrix(G);

  const w = new Point(n, p);
  if (x0) {
    // the slack of the warm start, negative where it violates a row: no interior push
    w.x.set(x0);
    matVec(G, w.x, w.s);
    for (let i = 0; i < p; i++) w.s[i] = h[i]! - w.s[i]!;
  }
  const ref = new Point(n, p);
  ref.set(w);
  const trial = new Point(n, p);
  const d = new Point(n, p);

  const complementarityMeasure = (v: Point) => {
    let sum = minSq(v.tau, v.kappa);
    for (let i = 0; i < p; i++) sum += minSq(v.s[i]!, v.z[i]!);
    return sum / (p + 1);
  };
  let mu = Math.max(complementarityMeasure(w), MU_FLOOR);

  const evaluate = (v: Point, r: Residuals) => {
    matVec(G, v.x, r.gx);
    matVec(Gt, v.z, r.gtz);
    for (let j = 0; j < n; j++) r.rD[j] = r.gtz[j]! + c[j]! * v.tau + RHO * (v.x[j]! - ref.x[j]!);
    for (let i = 0; i < p; i++) {
      r.rI[i] = r.gx[i]! + v.s[i]! - h[i]! * v.tau - RHO * (v.z[i]! - ref.z[i]!);
      r.rN[i] = ncp(v.s[i]!, v.z[i]!, mu) + RHO_N * (v.s[i]! - ref.s[i]!) + RHO_N * (v.z[i]! - ref.z[i]!);
    }
    r.rG = -dot(c, v.x) - dot(h, v.z) - v.kappa + RHO * (v.tau - ref.tau);
    r.rH = ncp(v.tau, v.kappa, mu) + RHO_N * (v.tau - ref.tau) + RHO_N * (v.kappa - ref.kappa);
  };
  const res = new Residuals(n, p);
  const trialRes = new Residuals(n, p);

  // the condensed Newton step: Delta s and Delta kappa eliminated, then Delta y (none here) and
  // Delta z, leaving H = rho I + G' D^-1 G (positive definite) and the scalar Delta tau
  const dInv = new Float64Array(p);
  const sJac = new Float64Array(p);
  const zJac = new Float64Array(p);
  const rBarI = new Float64Array(p);
  const H = new Float64Array(n * n);
  const vecA = new Float64Array(n);
  const vecD = new Float64Array(n);
  const rBarX = new Float64Array(n);
  const pSol = new Float64Array(n);
  const qSol = new Float64Array(n);
  const gdx = new Float64Array(p);
  const cholSolve = (L: Float64Array, rhs: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) {
      let sum = rhs[i]!;
      for (let k = 0; k < i; k++) sum -= L[i * n + k]! * out[k]!;
      out[i] = sum / L[i * n + i]!;
    }
    for (let i = n - 1; i >= 0; i--) {
      let sum = out[i]!;
      for (let k = i + 1; k < n; k++) sum -= L[k * n + i]! * out[k]!;
      out[i] = sum / L[i * n + i]!;
    }
  };
  const direction = (): boolean => {
    // the regularized NCP Jacobians: d phi/da = 1 - (a - b)/r, d phi/db = 1 + (a - b)/r, both in (0, 2)
    for (let i = 0; i < p; i++) {
      const diff = w.s[i]! - w.z[i]!;
      const root = Math.sqrt(diff * diff + 4 * mu);
      sJac[i] = 1 - diff / root + RHO_N;
      zJac[i] = 1 + diff / root + RHO_N;
      dInv[i] = 1 / (zJac[i]! / sJac[i]! + RHO);
      rBarI[i] = res.rI[i]! - res.rN[i]! / sJac[i]!;
    }
    const diffTK = w.tau - w.kappa;
    const rootTK = Math.sqrt(diffTK * diffTK + 4 * mu);
    const chiTau = 1 - diffTK / rootTK + RHO_N;
    const chiKappa = 1 + diffTK / rootTK + RHO_N;
    const gammaTau = RHO + chiTau / chiKappa;
    const rBarG = res.rG + res.rH / chiKappa;

    H.fill(0);
    for (let i = 0; i < p; i++) {
      const weight = dInv[i]!;
      const row = i * n;
      for (let j = 0; j < n; j++) {
        const gij = G.data[row + j]! * weight;
        for (let k = 0; k < n; k++) H[j * n + k]! += gij * G.data[row + k]!;
      }
    }
    for (let j = 0; j < n; j++) H[j * n + j]! += RHO;
    let gamma = gammaTau;
    let rBarTau = rBarG;
    for (let j = 0; j < n; j++) {
      vecA[j] = c[j]!;
      vecD[j] = -c[j]!;
      rBarX[j] = res.rD[j]!;
    }
    for (let i = 0; i < p; i++) {
      const hd = h[i]! * dInv[i]!;
      const rd = rBarI[i]! * dInv[i]!;
      gamma += h[i]! * hd;
      rBarTau -= h[i]! * rd;
      for (let j = 0; j < n; j++) {
        const gij = G.data[i * n + j]!;
        vecA[j]! -= gij * hd;
        vecD[j]! -= gij * hd;
        rBarX[j]! += gij * rd;
      }
    }
    const L = cholesky(H, n);
    if (!L) return false;
    for (let j = 0; j < n; j++) vecA[j] = -vecA[j]!;
    cholSolve(L, vecA, pSol);
    for (let j = 0; j < n; j++) rBarX[j] = -rBarX[j]!;
    cholSolve(L, rBarX, qSol);
    const denominator = gamma + dot(vecD, pSol);
    if (!Number.isFinite(denominator) || denominator === 0) return false;
    d.tau = (-rBarTau - dot(vecD, qSol)) / denominator;
    for (let j = 0; j < n; j++) d.x[j] = qSol[j]! + d.tau * pSol[j]!;
    matVec(G, d.x, gdx);
    for (let i = 0; i < p; i++) {
      d.z[i] = dInv[i]! * (gdx[i]! - h[i]! * d.tau + rBarI[i]!);
      d.s[i] = -(res.rN[i]! + zJac[i]! * d.z[i]!) / sJac[i]!;
    }
    d.kappa = -(res.rH + chiTau * d.tau) / chiKappa;
    return Number.isFinite(d.tau) && d.x.every(Number.isFinite);
  };

  // the paper's stopping tests, in homogeneous coordinates (no division by tau)
  const scale = (v: Float64Array) => {
    let r = 0;
    for (let i = 0; i < v.length; i++) r = Math.max(r, Math.abs(v[i]!));
    return r;
  };
  const cNorm = scale(c);
  const hNorm = scale(h);
  const rawD = new Float64Array(n);
  const rawI = new Float64Array(p);
  const optimal = (): boolean => {
    const { tau, kappa, x, z, s } = w;
    if (!(tau > 0)) return false;
    const { gx, gtz } = res;
    for (let j = 0; j < n; j++) rawD[j] = gtz[j]! + c[j]! * tau;
    for (let i = 0; i < p; i++) rawI[i] = gx[i]! + s[i]! - h[i]! * tau;
    let rc = 0;
    let rn = 0;
    for (let i = 0; i < p; i++) {
      rc = Math.max(rc, Math.abs(Math.min(s[i]!, z[i]!)));
      rn = Math.max(rn, Math.abs(ncp(s[i]!, z[i]!, mu)));
    }
    const cx = dot(c, x);
    const hz = dot(h, z);
    const rg = -cx - hz - kappa;
    const sNorm = scale(s);
    const zNorm = scale(z);
    const bound = (...terms: number[]) => tol * tau + tol * Math.max(...terms);
    return (
      scale(rawD) <= bound(tau * cNorm, scale(gtz)) &&
      scale(rawI) <= bound(scale(gx), sNorm, tau * hNorm) &&
      rc <= bound(sNorm, zNorm, rn) &&
      Math.abs(rg) <= bound(tau, Math.abs(cx), Math.abs(hz)) &&
      Math.abs(kappa) <= 2 * tol * tau
    );
  };
  // the Farkas tests, once kappa dominates tau: z with G'z = 0, z >= 0, h'z < 0 (primal
  // infeasible), or x with Gx <= 0 and c'x < 0 (dual infeasible, so unbounded)
  const certificate = (): "infeasible" | "unbounded" | undefined => {
    const { tau, kappa, x, z, s } = w;
    if (!(kappa > tol) || Math.abs(tau) > 2 * tol * kappa) return undefined;
    const omegaP = scale(z);
    let zNeg = 0;
    for (let i = 0; i < p; i++) zNeg = Math.max(zNeg, -z[i]!);
    if (omegaP > 0 && scale(res.gtz) <= tol * omegaP && zNeg <= tol * omegaP && dot(h, z) < -tol * omegaP) return "infeasible";
    const omegaD = scale(x);
    let recession = 0;
    let sNeg = 0;
    for (let i = 0; i < p; i++) {
      recession = Math.max(recession, Math.abs(res.gx[i]! + s[i]!));
      sNeg = Math.max(sNeg, -s[i]!);
    }
    if (omegaD > 0 && recession <= tol * omegaD && sNeg <= tol * omegaD && dot(c, x) < -tol * omegaD) return "unbounded";
    return undefined;
  };

  const trace = new NumericTrace(n, "µ", maxit);
  const point = Float64Array.from(w.x);
  // mu / tau^2: the complementarity of the recovered pair (s, z) / tau, in the LP's units as IPM's
  // s'y/m is; raw mu is homogeneous and grows with tau
  let scaledMu = mu;
  const record = () => {
    // the recovered point; while tau <= 0 the last one (and its mu) stays drawn
    if (w.tau > 0) {
      for (let j = 0; j < n; j++) point[j] = w.x[j]! / w.tau;
      scaledMu = mu / (w.tau * w.tau);
    }
    let infeasibility = 0;
    if (w.tau > 0) for (let i = 0; i < p; i++) infeasibility = Math.max(infeasibility, (res.gx[i]! - h[i]! * w.tau) / w.tau);
    trace.record(point, -dot(c, point), Math.max(infeasibility, 0), scaledMu);
  };

  const merits: number[] = [];
  let status: "optimal" | "infeasible" | "unbounded" | undefined;
  let failure: string | undefined;
  evaluate(w, res);
  let referenceError = res.norm();

  while (true) {
    record();
    if (optimal()) {
      status = "optimal";
      break;
    }
    status = certificate();
    if (status || trace.count >= maxit) break;
    if (!direction()) {
      failure = "HALO-LP Newton solve failed: Singular linear system";
      break;
    }

    // non-monotone Armijo on the natural merit: an exact Newton step has slope -2 merit
    const merit = res.merit();
    merits.push(merit);
    if (merits.length > NONMONOTONE_MEMORY) merits.shift();
    const meritRef = Math.max(...merits);
    let alpha = 1;
    for (;;) {
      trial.set(w, alpha, d);
      evaluate(trial, trialRes);
      if (trialRes.merit() <= meritRef - 2 * ARMIJO * alpha * merit || alpha <= MIN_STEP) break;
      alpha *= BACKTRACK;
    }
    w.set(trial);
    const trialError = trialRes.norm();

    if (trialError <= THETA * referenceError + BETA * mu) {
      // the step made enough progress on the current subproblem: move the proximal reference to
      // the iterate and mu to its complementarity measure, never up
      ref.set(w);
      mu = Math.max(Math.min(mu, complementarityMeasure(w)), MU_FLOOR);
      merits.length = 0;
      evaluate(w, res);
      referenceError = res.norm();
    } else {
      evaluate(w, res);
    }
  }

  const lead = status === "infeasible" ? "Certified primal infeasible" : status === "unbounded" ? "Certified unbounded" : failure ? "Stopped" : undefined;
  return trace.finish({ converged: status === "optimal", lead, ...(failure ? { before: failure } : {}) }, { status });
}

/** HALO-LP on `max objective'x s.t. Ax <= b`. */
export function halo(constraints: readonly Constraint[], objective: Float64Array, opts: HALOOptions): SolverResult {
  const { A, b } = denseFromConstraints(constraints);
  return haloCore(A, b, negate(objective), warmStart(opts.startPoint, A.cols), opts);
}
