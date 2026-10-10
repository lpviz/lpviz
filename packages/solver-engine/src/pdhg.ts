import { type DenseMatrix, denseFromConstraints, dot, infinityNorm, matVec, maxAbsDifference, transposedMatVec } from "@lpviz/math/blas";
import type { Constraint } from "@lpviz/math/types";
import { numericLogHeader, solveFooter } from "./fmt";
import { assertMaxit } from "./limits";
import { NumericTrace, type SolverResult } from "./result";
import { splitStandardForm, unsplit } from "./standardForm";

const BASIS_THRESHOLD = 1e-10;
const BASIS_HASH_MULTIPLIER = 33;
const HALPERN_SUFFICIENT_REDUCTION = 0.2;
const HALPERN_NECESSARY_REDUCTION = 0.5;
const HALPERN_ARTIFICIAL_RESTART_THRESHOLD = 0.36;

export interface PDHGOptions {
  /** run on `Ax ≤ b` directly, or on its split standard form `Ax = b, x ≥ 0` */
  ineq: boolean;
  halpern: boolean;
  maxit: number;
  eta: number;
  tau: number;
  tol: number;
  colorByBasis: boolean;
  /** Optional primal warm start; the duals keep the cold start's values. */
  startPoint?: readonly number[] | undefined;
}

// Worst row of Ax - b: its violation in inequality mode, its mismatch in equality mode.
function primalResidual(ax: Float64Array, b: Float64Array, ineq: boolean) {
  let worst = 0;
  for (let i = 0; i < ax.length; i++) {
    const residual = ineq ? Math.max(0, ax[i]! - b[i]!) : Math.abs(ax[i]! - b[i]!);
    if (residual > worst) worst = residual;
  }
  return worst;
}

// The relative KKT error of a primal-dual pair: the worst of the primal residual, the dual
// residual and the duality gap, each scaled by the data it is measured against. The primal side's
// parts (A x, the residual, c'x) are kept from the last measurement for the log row and the step.
class KktError {
  readonly ax: Float64Array;
  primal = 0;
  cTx = 0;
  private readonly aty: Float64Array;
  private readonly bNorm: number;
  private readonly cNorm: number;

  constructor(
    private readonly A: DenseMatrix,
    private readonly b: Float64Array,
    private readonly c: Float64Array,
    private readonly ineq: boolean,
  ) {
    this.ax = new Float64Array(A.rows);
    this.aty = new Float64Array(A.cols);
    this.bNorm = infinityNorm(b);
    this.cNorm = infinityNorm(c);
  }

  of(xk: Float64Array, yk: Float64Array): number {
    const { A, b, c, ineq, ax, aty } = this;
    matVec(A, xk, ax);
    const primal = primalResidual(ax, b, ineq);
    this.primal = primal;

    transposedMatVec(A, yk, aty);
    let dualResidual = 0;
    for (let i = 0; i < aty.length; i++) {
      const residual = ineq ? Math.abs(c[i]! + aty[i]!) : Math.max(0, -aty[i]! - c[i]!);
      if (residual > dualResidual) dualResidual = residual;
    }

    const cTx = dot(c, xk);
    this.cTx = cTx;
    const bTy = dot(b, yk);
    const dualityGap = Math.abs(cTx + bTy) / (1 + Math.abs(cTx) + Math.abs(bTy));
    return Math.max(primal / (1 + this.bNorm), dualResidual / (1 + this.cNorm), dualityGap);
  }
}

function shouldRestartHalpern(innerIteration: number, totalIteration: number, fixedPointError: number, initialFixedPointError: number, lastTrialFixedPointError: number) {
  if (!Number.isFinite(initialFixedPointError) || innerIteration < 2) {
    return false;
  }
  if (fixedPointError <= HALPERN_SUFFICIENT_REDUCTION * initialFixedPointError) {
    return true;
  }
  if (fixedPointError <= HALPERN_NECESSARY_REDUCTION * initialFixedPointError && fixedPointError > lastTrialFixedPointError) {
    return true;
  }
  return innerIteration >= Math.ceil(HALPERN_ARTIFICIAL_RESTART_THRESHOLD * totalIteration);
}

/**
 * PDHG on `min c'x s.t. Ax <= b, x free` (ineq) or on the split standard form
 * `min c'x s.t. Ax = b, x >= 0` (eq; see `pdhg` for the split). The two modes
 * differ only in the residuals, the basis hash, the initial dual and which
 * variable takes the projected, extrapolated step.
 */
function pdhgCore(A: DenseMatrix, b: Float64Array, c: Float64Array, x0: Float64Array | undefined, dimension: number, opts: Omit<PDHGOptions, "startPoint">): SolverResult {
  const { ineq, maxit, eta, tau, tol, colorByBasis, halpern } = opts;

  const { rows: m, cols: n } = A;
  // eq mode: x is split as x = x^+ - x^- with xk = [x^+; x^-; s]
  const slackOffset = n - m;
  // the problem's own variables: all of xk in ineq mode, x^+ - x^- in eq mode
  const pointOf = (xk: Float64Array): Float64Array => (ineq ? xk.slice() : unsplit(xk, dimension));
  const kkt = new KktError(A, b, c, ineq);

  let xk = new Float64Array(n);
  // Equality duals are sign-free, so 0 is the neutral "no price information"
  // start; inequality duals start at 1. Either is safe by nonexpansiveness of
  // the PDHG operator, and the Halpern anchor sits on the same point.
  let yk = new Float64Array(m).fill(ineq ? 1 : 0);
  let nextX = new Float64Array(n);
  let nextY = new Float64Array(m);
  let halpernX = new Float64Array(n);
  let halpernY = new Float64Array(m);
  const anchorX = new Float64Array(n);
  const anchorY = new Float64Array(m).fill(ineq ? 1 : 0);
  const axExtrapolated = new Float64Array(m);
  const atYScratch = new Float64Array(n);
  const extrapolated = new Float64Array(ineq ? m : n);
  if (x0) {
    // Warm start: relocate only the primal point (and the Halpern anchor that
    // must sit on it) and keep the cold start's dual, so a start at the default
    // position reproduces the cold trajectory exactly.
    xk.set(x0);
    anchorX.set(x0);
  }
  let innerIteration = 1;
  let initialFixedPointError = Number.POSITIVE_INFINITY;
  let lastTrialFixedPointError = Number.POSITIVE_INFINITY;

  let epsilonK = kkt.of(xk, yk);

  const trace = new NumericTrace();
  const basisHashes: number[] = [];
  const restartIndices: number[] = [];
  const startTime = performance.now();

  while (trace.count < maxit) {
    if (colorByBasis) {
      // ineq: which duals are active; eq: which slacks are at their bound
      let hash = 0;
      for (let i = 0; i < m; i++) {
        hash = (hash * BASIS_HASH_MULTIPLIER + ((ineq ? yk[i]! > BASIS_THRESHOLD : Math.abs(xk[slackOffset + i]!) <= BASIS_THRESHOLD) ? 1 : 0)) >>> 0;
      }
      basisHashes.push(hash);
    }

    // the parts kkt.of measured for this (xk, yk) are the row's, and the ineq step's
    trace.record(pointOf(xk), -kkt.cTx, kkt.primal, epsilonK);

    if (epsilonK <= tol || trace.count === maxit) {
      break;
    }

    if (ineq) {
      // y_{k+1} = [y_k + τ(Ax_k - b)]_+
      // ỹ_k = y_{k+1} + (y_{k+1} - y_k)
      for (let i = 0; i < m; i++) {
        const candidate = yk[i]! + tau * (kkt.ax[i]! - b[i]!);
        nextY[i] = candidate > 0 ? candidate : 0;
        extrapolated[i] = 2 * nextY[i]! - yk[i]!;
      }
      // x_{k+1} = x_k - η(c + A^T ỹ_k)
      transposedMatVec(A, extrapolated, atYScratch);
      for (let i = 0; i < n; i++) {
        nextX[i] = xk[i]! - eta * (c[i]! + atYScratch[i]!);
      }
    } else {
      // x_{k+1} = [x_k - η(c + A^T y_k)]_+
      // x̃_k = x_{k+1} + (x_{k+1} - x_k)
      transposedMatVec(A, yk, atYScratch);
      for (let i = 0; i < n; i++) {
        const candidate = xk[i]! - eta * (c[i]! + atYScratch[i]!);
        nextX[i] = candidate > 0 ? candidate : 0;
        extrapolated[i] = 2 * nextX[i]! - xk[i]!;
      }
      // y_{k+1} = y_k + τ(Ax̃_k - b)
      matVec(A, extrapolated, axExtrapolated);
      for (let i = 0; i < m; i++) {
        nextY[i] = yk[i]! + tau * (axExtrapolated[i]! - b[i]!);
      }
    }

    if (halpern) {
      const fixedPointError = Math.max(maxAbsDifference(xk, nextX), maxAbsDifference(yk, nextY));
      if (!Number.isFinite(initialFixedPointError)) {
        initialFixedPointError = fixedPointError;
      }

      if (shouldRestartHalpern(innerIteration, trace.count, fixedPointError, initialFixedPointError, lastTrialFixedPointError)) {
        xk.set(nextX);
        yk.set(nextY);
        anchorX.set(nextX);
        anchorY.set(nextY);
        initialFixedPointError = fixedPointError;
        innerIteration = 1;
        restartIndices.push(trace.count - 1);
        trace.markRestart();
      } else {
        const weight = innerIteration / (innerIteration + 1);
        const anchorWeight = 1 - weight;
        for (let i = 0; i < n; i++) {
          halpernX[i] = weight * nextX[i]! + anchorWeight * anchorX[i]!;
        }
        for (let i = 0; i < m; i++) {
          halpernY[i] = weight * nextY[i]! + anchorWeight * anchorY[i]!;
        }
        [xk, halpernX] = [halpernX, xk];
        [yk, halpernY] = [halpernY, yk];
        innerIteration++;
      }
      lastTrialFixedPointError = fixedPointError;
    } else {
      [xk, nextX] = [nextX, xk];
      [yk, nextY] = [nextY, yk];
    }

    epsilonK = kkt.of(xk, yk);
    if (!Number.isFinite(epsilonK)) {
      break;
    }
  }

  const footer = solveFooter(epsilonK <= tol, trace.count, performance.now() - startTime);
  return trace.result(numericLogHeader(dimension, "eps"), footer, {
    phases: colorByBasis ? basisHashes : undefined,
    restartIndices: halpern ? restartIndices : undefined,
  });
}

/** PDHG on `max objective'x s.t. Ax ≤ b`, directly (ineq) or on the split standard form (eq). */
export function pdhg(constraints: readonly Constraint[], objective: Float64Array, opts: PDHGOptions): SolverResult {
  const { startPoint, ...core } = opts;
  assertMaxit(core.maxit);

  const { A, b } = denseFromConstraints(constraints);
  const nOrig = A.cols;
  const x0 = startPoint && startPoint.length === nOrig ? Float64Array.from(startPoint) : undefined;
  // max c'x is min (−c)'x
  const cost = Float64Array.from(objective, (value) => -value);

  if (core.ineq) {
    return pdhgCore(A, b, cost, x0, nOrig, core);
  }

  const split = splitStandardForm(A, cost);
  // Warm start mapped into the split variables chi = [x^+; x^-; s] >= 0:
  // x^+ - x^- = x0 exactly, so the displayed first iterate is the chosen
  // point. The slack block stays at the cold start's zeros — like the cold
  // start, the equality residual is left for the iteration to close — and
  // chi0 >= 0 (the splitting's hard constraint) holds by construction.
  let chi0: Float64Array | undefined;
  if (x0) {
    chi0 = new Float64Array(split.c.length);
    for (let j = 0; j < nOrig; j++) {
      const value = x0[j]!;
      if (value >= 0) chi0[j] = value;
      else chi0[nOrig + j] = -value;
    }
  }
  return pdhgCore(split.A, b, split.c, chi0, nOrig, core);
}
