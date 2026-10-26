// H-PDLP (arXiv:2610.17695): restarted reflected Halpern PDHG on a box-cone homogeneous self-dual
// embedding of `max c'x s.t. Ax <= b`. The LP is read in the bound form `min c'x s.t. l <= Ax <= u`
// with x free (here l = -inf, u = b), and z = (tau, x, alpha, y) solves z in K, Qz in K* with
// K = K[l_v, u_v] x K[l, u]*. A solution with tau > 0 is (x, y) / tau, one with tau = 0 a certificate
// of infeasibility or unboundedness, so the iteration has something to converge to for every LP.
// The drawn trace is the recovered point x / tau of each PDHG point T(z).

import { denseFromConstraints, denseOperator, dot, type LinearOperator, negate } from "@lpviz/math/blas";
import type { Constraint } from "@lpviz/math/types";
import { warmStart } from "./limits";
import { KktError, shouldRestartHalpern } from "./pdhg";
import { NumericTrace, type SolverResult } from "./result";

const BASIS_THRESHOLD = 1e-10;
const BASIS_HASH_MULTIPLIER = 33;
// the primal weight moves this far (in log) toward its target at each restart: PDLP's smoothing. The
// paper's PI gains (0.97 proportional, 0.05 integral) assume restarts checked every 200 iterations;
// lpviz checks every iteration, cycles are a few iterations long, their movement mostly reflects the
// steps omega itself just set, and the near-full update makes omega swing by 20x from restart to restart
const WEIGHT_SMOOTHING = 0.5;
// rho above this is the certificate regime, where the primal weight is held
const CERTIFICATE_REGIME = 0.9;
const CERTIFICATE_TOL = 1e-9;
const NEWTON_TOL = 1e-12;
const NEWTON_MAXIT = 100;

export interface HPDLPOptions {
  maxit: number;
  /** the primal (x) and dual (alpha, y) step sizes; PDHG's eta and tau, and stable while eta sigma ||A||^2 < 1 */
  eta: number;
  sigma: number;
  /** mu sigma, the tau step against the alpha step; stable below 1 (the paper uses 0.998) */
  nu: number;
  /** adapt the primal weight at restarts (PI control on the primal and dual movement), or keep eta and sigma */
  adaptiveWeight: boolean;
  tol: number;
  colorByBasis: boolean;
  /** Optional primal warm start, taken as the anchor's x with tau = 1. */
  startPoint?: readonly number[] | undefined;
}

/** sup_{l <= s <= u} v's, the support function p(v; l, u) of a box. */
function support(v: Float64Array, l: Float64Array, u: Float64Array, sign = 1) {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    const vi = sign * v[i]!;
    if (vi > 0) sum += u[i]! * vi;
    else if (vi < 0) sum += l[i]! * vi;
  }
  return sum;
}

/** w clipped into [l tau, u tau]; at tau = 0, into the recession cone of [l, u]. */
const clip = (w: number, l: number, u: number, tau: number) => Math.min(Math.max(w, l === -Infinity ? -Infinity : l * tau), u === Infinity ? Infinity : u * tau);

/**
 * The safeguarded Newton method (the paper's Algorithm 1) for tau >= 0 with g(tau) >= 0 and
 * tau g(tau) = 0, where g is continuous, piecewise affine and increasing with slopes >= dMin.
 * `evaluate` returns g(tau) and leaves its Newton denominator in `slope.d`.
 */
function scalarRoot(evaluate: (tau: number) => number, slope: { d: number }, dMin: number, warm: number) {
  const g0 = evaluate(0);
  if (g0 >= 0) return 0;
  let lo = 0;
  let hi = -g0 / dMin;
  let step = Infinity;
  let tau = warm > 0 ? Math.min(Math.max(warm, lo), hi) : (lo + hi) / 2;
  for (let it = 0; it < NEWTON_MAXIT; it++) {
    const g = evaluate(tau);
    if (Math.abs(g) <= ((dMin * NEWTON_TOL) / (1 + NEWTON_TOL)) * tau) return tau;
    if (g < 0) lo = tau;
    else hi = tau;
    if (hi - lo <= 2 * NEWTON_TOL * lo) return (lo + hi) / 2;
    let next = tau - g / slope.d;
    if (next < lo || next > hi || Math.abs(next - tau) > step / 2) next = (lo + hi) / 2;
    step = Math.abs(next - tau);
    tau = next;
  }
  return tau;
}

/**
 * The Euclidean projection of (t, w) onto the box cone K[l, u], into `out` (the vector part); returns
 * its tau. Eliminating the vector part leaves a 1-strongly convex scalar problem whose derivative
 * phi' is the root `scalarRoot` finds.
 */
function projectBoxCone(t: number, w: Float64Array, l: Float64Array, u: Float64Array, out: Float64Array, warm: number) {
  const slope = { d: 1 };
  const phiPrime = (tau: number) => {
    let g = tau - t;
    let d = 1;
    for (let i = 0; i < w.length; i++) {
      if (l[i]! > -Infinity && w[i]! < l[i]! * tau) {
        g += l[i]! * (l[i]! * tau - w[i]!);
        d += l[i]! * l[i]!;
      } else if (u[i]! < Infinity && w[i]! > u[i]! * tau) {
        g += u[i]! * (u[i]! * tau - w[i]!);
        d += u[i]! * u[i]!;
      }
    }
    slope.d = d;
    return g;
  };
  const tau = scalarRoot(phiPrime, slope, 1, warm);
  for (let i = 0; i < w.length; i++) out[i] = clip(w[i]!, l[i]!, u[i]!, tau);
  return tau;
}

/** One point (tau, x, alpha, y) of the embedding. */
class HsdPoint {
  tau = 1;
  alpha = 1;
  readonly x: Float64Array;
  readonly y: Float64Array;
  constructor(n: number, m: number) {
    this.x = new Float64Array(n);
    this.y = new Float64Array(m);
  }
  set(from: HsdPoint, scale = 1) {
    this.tau = scale * from.tau;
    this.alpha = scale * from.alpha;
    for (let i = 0; i < this.x.length; i++) this.x[i] = scale * from.x[i]!;
    for (let i = 0; i < this.y.length; i++) this.y[i] = scale * from.y[i]!;
  }
}

/**
 * H-PDLP on `min c'x s.t. l <= Ax <= u, x free`. Every PDHG point is measured: its recovered point's
 * relative KKT error stops the run as optimal, and its (y) and (x) are tested as certificates of
 * primal and dual infeasibility.
 */
function hpdlpCore(A: LinearOperator, l: Float64Array, u: Float64Array, c: Float64Array, x0: Float64Array | undefined, opts: Omit<HPDLPOptions, "startPoint">): SolverResult {
  const { maxit, tol, colorByBasis, nu, adaptiveWeight } = opts;
  const { rows: m, cols: n } = A;
  // the KKT error reads the LP as `Ax <= b` with duals y >= 0, the negated duals of the embedding
  const kkt = new KktError(A, u, c, true);
  const cNormSq = dot(c, c);

  // step sizes: eta sigma = lambda^2 and mu sigma = nu, the primal weight omega trading the primal
  // block's steps against the dual block's; the given eta and sigma set lambda and the first omega
  const lambda = Math.sqrt(opts.eta * opts.sigma);
  let omega = Math.sqrt(opts.sigma / opts.eta);
  let mu = 0;
  let eta = 0;
  let sigma = 0;
  const setSteps = () => {
    mu = nu / (omega * lambda);
    eta = lambda / omega;
    sigma = omega * lambda;
  };
  setSteps();

  // the practical anchor (1, 0, 1, 0) of the paper, with a warm start's x in place of 0
  const z = new HsdPoint(n, m);
  if (x0) z.x.set(x0);
  const anchor = new HsdPoint(n, m);
  anchor.set(z);
  const t = new HsdPoint(n, m);

  const ax = new Float64Array(m);
  const dualShift = new Float64Array(m);
  const projected = new Float64Array(m);
  const yReflected = new Float64Array(m);
  const atY = new Float64Array(n);
  const xShift = new Float64Array(n);
  const dx = new Float64Array(n);
  const adx = new Float64Array(m);
  const point = new Float64Array(n);
  const yHat = new Float64Array(m);
  let dualWarm = 0;

  // T(z) into t: the dual block (alpha, y) is a projection onto K_c*, by Moreau through K_c; the
  // primal block (tau, x) is implicit in tau, a scalar root that is closed-form for free x
  const step = () => {
    A.apply(z.x, ax);
    const alphaShift = z.alpha - sigma * z.tau;
    for (let i = 0; i < m; i++) dualShift[i] = -(z.y[i]! - sigma * ax[i]!);
    dualWarm = projectBoxCone(-alphaShift, dualShift, l, u, projected, dualWarm);
    t.alpha = alphaShift + dualWarm;
    for (let i = 0; i < m; i++) {
      t.y[i] = -dualShift[i]! + projected[i]!;
      yReflected[i] = 2 * t.y[i]! - z.y[i]!;
    }
    const tauShift = z.tau + mu * (2 * t.alpha - z.alpha);
    A.applyTranspose(yReflected, atY);
    for (let i = 0; i < n; i++) xShift[i] = z.x[i]! + eta * atY[i]!;
    // psi(tau) = (tau - tauShift) / mu - c'(xShift - eta c tau) is affine: its root in one step
    t.tau = Math.max(0, (tauShift / mu + dot(c, xShift)) / (1 / mu + eta * cNormSq));
    for (let i = 0; i < n; i++) t.x[i] = xShift[i]! - eta * c[i]! * t.tau;
  };

  // ||z - T(z)||_P in the metric of the current step sizes
  const fixedPointResidual = () => {
    for (let i = 0; i < n; i++) dx[i] = z.x[i]! - t.x[i]!;
    A.apply(dx, adx);
    const dTau = z.tau - t.tau;
    const dAlpha = z.alpha - t.alpha;
    let sum = (dTau * dTau) / mu + (dAlpha * dAlpha) / sigma - 2 * dTau * dAlpha + dot(dx, dx) / eta;
    for (let i = 0; i < m; i++) {
      const dy = z.y[i]! - t.y[i]!;
      sum += (dy * dy) / sigma - 2 * dy * adx[i]!;
    }
    return Math.sqrt(Math.max(sum, 0));
  };

  // the restart's adaptive primal weight: omega moves toward dual movement / primal movement, held in
  // the certificate regime where the movements say nothing about balance
  const updatePrimalWeight = () => {
    let primalSq = ((lambda * lambda) / nu) * (t.tau - anchor.tau) ** 2;
    for (let i = 0; i < n; i++) primalSq += (t.x[i]! - anchor.x[i]!) ** 2;
    let dualSq = (t.alpha - anchor.alpha) ** 2;
    for (let i = 0; i < m; i++) dualSq += (t.y[i]! - anchor.y[i]!) ** 2;
    const kappa = Math.max(0, -dot(c, t.x) - support(t.y, l, u, -1));
    const rho = t.tau + kappa > 0 ? kappa / (t.tau + kappa) : 0;
    if (rho <= CERTIFICATE_REGIME && primalSq > 0 && dualSq > 0) {
      omega *= (Math.sqrt(dualSq / primalSq) / omega) ** WEIGHT_SMOOTHING;
      setSteps();
    }
  };

  // the restart's homogeneous rescaling: extreme magnitudes back to one, tau to one when it is
  // neither near one nor negligible
  const restartScale = () => {
    let h = Math.abs(t.alpha);
    h = Math.max(h, Math.hypot(...t.x), Math.hypot(...t.y));
    const g = Math.max(h, t.tau);
    if (g < 1e-12 || g > 1e12) return 1 / g;
    if (t.tau > 1e-8 * h && (t.tau < 0.1 || t.tau > 10)) return 1 / t.tau;
    return 1;
  };

  // the certificates: y with A'y = 0 and -p(-y) > 0 (primal infeasible), x with Ax in rec(S) and
  // c'x < 0 (unbounded); both are tested as ratios, scale-free like the embedding
  const certificate = (): "infeasible" | "unbounded" | undefined => {
    A.applyTranspose(t.y, atY);
    const yObjective = -support(t.y, l, u, -1);
    let atyNorm = 0;
    for (let i = 0; i < n; i++) atyNorm = Math.max(atyNorm, Math.abs(atY[i]!));
    if (yObjective > 0 && atyNorm <= CERTIFICATE_TOL * yObjective) return "infeasible";
    const descent = -dot(c, t.x);
    A.apply(t.x, ax);
    let recession = 0;
    for (let i = 0; i < m; i++) recession = Math.max(recession, Math.abs(ax[i]! - clip(ax[i]!, l[i]!, u[i]!, 0)));
    if (descent > 0 && recession <= CERTIFICATE_TOL * descent) return "unbounded";
    return undefined;
  };

  const trace = new NumericTrace(n, "eps", maxit);
  const basisHashes: number[] = [];
  const restartIndices: number[] = [];
  let innerIteration = 1;
  let initialFixedPointError = Number.POSITIVE_INFINITY;
  let lastTrialFixedPointError = Number.POSITIVE_INFINITY;
  let epsilon = Number.POSITIVE_INFINITY;
  let status: "optimal" | "infeasible" | "unbounded" | undefined;

  while (trace.count < maxit) {
    step();

    // the recovered point of T(z); on the certificate branch (tau = 0) the last one stays drawn
    if (t.tau > 0) {
      for (let i = 0; i < n; i++) point[i] = t.x[i]! / t.tau;
      for (let i = 0; i < m; i++) yHat[i] = -t.y[i]! / t.tau;
      epsilon = kkt.of(point, yHat);
    }
    if (colorByBasis) {
      let hash = 0;
      for (let i = 0; i < m; i++) hash = (hash * BASIS_HASH_MULTIPLIER + (t.y[i]! < -BASIS_THRESHOLD * Math.max(t.tau, 1) ? 1 : 0)) >>> 0;
      basisHashes.push(hash);
    }
    trace.record(point, -kkt.cTx, kkt.primal, epsilon);

    if (epsilon <= tol) {
      status = "optimal";
      break;
    }
    status = certificate();
    if (status || trace.count === maxit || !Number.isFinite(t.tau)) break;

    const fixedPointError = fixedPointResidual();
    if (!Number.isFinite(initialFixedPointError)) initialFixedPointError = fixedPointError;

    if (shouldRestartHalpern(innerIteration, trace.count, fixedPointError, initialFixedPointError, lastTrialFixedPointError)) {
      // restart at the PDHG point, rescaled, with the primal weight updated from this cycle's movement
      if (adaptiveWeight) updatePrimalWeight();
      z.set(t, restartScale());
      anchor.set(z);
      initialFixedPointError = Number.POSITIVE_INFINITY;
      lastTrialFixedPointError = Number.POSITIVE_INFINITY;
      innerIteration = 1;
      restartIndices.push(trace.count - 1);
      trace.markRestart();
      continue;
    }
    // reflected Halpern: z <- w (2 T(z) - z) + (1 - w) z0
    const weight = innerIteration / (innerIteration + 1);
    const reflect = (next: number, current: number, anchored: number) => weight * (2 * next - current) + (1 - weight) * anchored;
    z.tau = reflect(t.tau, z.tau, anchor.tau);
    z.alpha = reflect(t.alpha, z.alpha, anchor.alpha);
    for (let i = 0; i < n; i++) z.x[i] = reflect(t.x[i]!, z.x[i]!, anchor.x[i]!);
    for (let i = 0; i < m; i++) z.y[i] = reflect(t.y[i]!, z.y[i]!, anchor.y[i]!);
    lastTrialFixedPointError = fixedPointError;
    innerIteration++;
  }

  const lead = status === "infeasible" ? "Certified primal infeasible" : status === "unbounded" ? "Certified unbounded" : undefined;
  return trace.finish({ converged: status === "optimal", lead }, { phases: colorByBasis ? basisHashes : undefined, restartIndices, status });
}

/** H-PDLP on `max objective'x s.t. Ax <= b`. */
export function hpdlp(constraints: readonly Constraint[], objective: Float64Array, opts: HPDLPOptions): SolverResult {
  const { startPoint, ...core } = opts;
  const { A, b } = denseFromConstraints(constraints);
  const warm = warmStart(startPoint, A.cols);
  const lower = new Float64Array(A.rows).fill(-Infinity);
  // max c'x is min (−c)'x
  return hpdlpCore(denseOperator(A), lower, b, negate(objective), warm ? Float64Array.from(warm) : undefined, core);
}
