import { createDenseMatrix, type DenseMatrix, dot, infinityNorm, linesToDenseAb, matVec, transposedMatVec } from "@lpviz/math/blas";
import type { Lines, VecN, VecNs } from "@lpviz/math/types";
import { numericLogHeader } from "./fmt";
import type { NumericRow, SolverResult } from "./result";
import { assertMaxit, solveFooter } from "./time";

const BASIS_THRESHOLD = 1e-10;
const HALPERN_SUFFICIENT_REDUCTION = 0.2;
const HALPERN_NECESSARY_REDUCTION = 0.5;
const HALPERN_ARTIFICIAL_RESTART_THRESHOLD = 0.36;

interface PDHGOptions {
  ineq: boolean;
  halpern: boolean;
  maxit: number;
  eta: number;
  tau: number;
  tol: number;
  colorByBasis: boolean;
  /** Optional primal warm start; safe from any x0 (duals derived per mode). */
  startPoint?: number[];
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

function pdhgEpsilon(
  A: DenseMatrix,
  b: Float64Array,
  c: Float64Array,
  xk: Float64Array,
  yk: Float64Array,
  axScratch: Float64Array,
  atYScratch: Float64Array,
  bNorm: number,
  cNorm: number,
  ineq: boolean,
) {
  matVec(A, xk, axScratch);
  const primal = primalResidual(axScratch, b, ineq);

  transposedMatVec(A, yk, atYScratch);
  let dualResidual = 0;
  for (let i = 0; i < atYScratch.length; i++) {
    const residual = ineq ? Math.abs(c[i]! + atYScratch[i]!) : Math.max(0, -atYScratch[i]! - c[i]!);
    if (residual > dualResidual) dualResidual = residual;
  }

  const cTx = dot(c, xk);
  const bTy = dot(b, yk);
  const dualityGap = Math.abs(cTx + bTy) / (1 + Math.abs(cTx) + Math.abs(bTy));
  return Math.max(primal / (1 + bNorm), dualResidual / (1 + cNorm), dualityGap);
}

function computeFixedPointError(currentX: Float64Array, nextX: Float64Array, currentY: Float64Array, nextY: Float64Array) {
  let error = 0;
  for (let i = 0; i < currentX.length; i++) {
    const delta = Math.abs(nextX[i]! - currentX[i]!);
    if (delta > error) error = delta;
  }
  for (let i = 0; i < currentY.length; i++) {
    const delta = Math.abs(nextY[i]! - currentY[i]!);
    if (delta > error) error = delta;
  }
  return error;
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
function pdhgCore(A: DenseMatrix, b: Float64Array, c: Float64Array, x0: Float64Array | undefined, options: PDHGOptions): SolverResult {
  const { ineq, maxit, eta, tau, tol, colorByBasis, halpern } = options;

  const { rows: m, cols: n } = A;
  // eq mode: x is split as x = x^+ - x^- with xk = [x^+; x^-; s]
  const slackOffset = n - m;
  const nOrig = slackOffset / 2;
  // the problem's own variables: all of xk in ineq mode, x^+ - x^- in eq mode
  const dimension = ineq ? n : nOrig;
  const pointOf = (xk: Float64Array): Float64Array => {
    if (ineq) return xk.slice();
    const point = new Float64Array(nOrig);
    for (let j = 0; j < nOrig; j++) point[j] = (xk[j] ?? 0) - (xk[nOrig + j] ?? 0);
    return point;
  };
  const bNorm = infinityNorm(b);
  const cNorm = infinityNorm(c);

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
  const axScratch = new Float64Array(m);
  const atYScratch = new Float64Array(n);
  const extrapolated = new Float64Array(ineq ? m : n);
  if (x0) {
    // Warm start: relocate only the primal point (and the Halpern anchor that
    // must sit on it) and keep the cold start's dual, so a start at the default
    // position reproduces the cold trajectory exactly.
    xk.set(x0);
    anchorX.set(x0);
  }
  let k = 1;
  let innerIteration = 1;
  let initialFixedPointError = Number.POSITIVE_INFINITY;
  let lastTrialFixedPointError = Number.POSITIVE_INFINITY;

  let epsilonK = pdhgEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm, ineq);
  const header = numericLogHeader(dimension, "eps");

  const rows: NumericRow[] = [];
  const iterates: VecNs = [];
  const eps: number[] = [];
  const phases: number[] = [];
  const restartIndices: number[] = [];
  const startTime = performance.now();

  while (k <= maxit) {
    iterates.push(xk.slice());
    if (colorByBasis) {
      // ineq: which duals are active; eq: which slacks are at their bound
      let phase = 0;
      for (let i = 0; i < m; i++) {
        phase = (phase * 33 + ((ineq ? yk[i]! > BASIS_THRESHOLD : Math.abs(xk[slackOffset + i]!) <= BASIS_THRESHOLD) ? 1 : 0)) >>> 0;
      }
      phases.push(phase);
    }

    matVec(A, xk, axScratch);
    rows.push({
      iteration: k,
      restart: false,
      point: pointOf(xk),
      objective: -dot(c, xk),
      infeasibility: primalResidual(axScratch, b, ineq),
      convergence: epsilonK,
    });
    eps.push(epsilonK);

    if (epsilonK <= tol || k === maxit) {
      break;
    }

    if (ineq) {
      // y_{k+1} = [y_k + τ(Ax_k - b)]_+
      // ỹ_k = y_{k+1} + (y_{k+1} - y_k)
      for (let i = 0; i < m; i++) {
        const candidate = yk[i]! + tau * (axScratch[i]! - b[i]!);
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
      matVec(A, extrapolated, axScratch);
      for (let i = 0; i < m; i++) {
        nextY[i] = yk[i]! + tau * (axScratch[i]! - b[i]!);
      }
    }

    if (halpern) {
      const fixedPointError = computeFixedPointError(xk, nextX, yk, nextY);
      if (!Number.isFinite(initialFixedPointError)) {
        initialFixedPointError = fixedPointError;
      }

      if (shouldRestartHalpern(innerIteration, k, fixedPointError, initialFixedPointError, lastTrialFixedPointError)) {
        xk.set(nextX);
        yk.set(nextY);
        anchorX.set(nextX);
        anchorY.set(nextY);
        initialFixedPointError = fixedPointError;
        innerIteration = 1;
        restartIndices.push(iterates.length - 1);
        if (rows.length > 0) {
          rows[rows.length - 1]!.restart = true;
        }
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
    k++;

    epsilonK = pdhgEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm, ineq);
    if (!Number.isFinite(epsilonK)) {
      break;
    }
  }

  const footer = solveFooter(epsilonK <= tol, iterates.length, performance.now() - startTime);

  return {
    iterations: iterates,
    convergence: eps,
    log: [{ header, rows, footer }],
    phases: colorByBasis ? phases : undefined,
    restartIndices: halpern ? restartIndices : undefined,
  };
}

export function pdhg(lines: Lines, objective: VecN, options: PDHGOptions): SolverResult {
  const { ineq, maxit, startPoint } = options;
  assertMaxit(maxit);

  const { A, b } = linesToDenseAb(lines);
  const nOrig = A.cols;
  const m = A.rows;
  const x0 = startPoint && startPoint.length === nOrig ? Float64Array.from(startPoint) : undefined;

  if (ineq) {
    return pdhgCore(
      A,
      b,
      Float64Array.from(objective, (value) => -value),
      x0,
      options,
    );
  }

  // x = x^+ - x^- where x^+, x^- ≥ 0
  // A(x^+ - x^-) = b becomes A[x^+; x^-; s] = b with slack s
  const AHat = createDenseMatrix(m, 2 * nOrig + m);
  for (let i = 0; i < m; i++) {
    const originalRowOffset = i * nOrig;
    const targetRowOffset = i * AHat.cols;
    for (let j = 0; j < nOrig; j++) {
      const value = A.data[originalRowOffset + j]!;
      AHat.data[targetRowOffset + j] = value;
      AHat.data[targetRowOffset + nOrig + j] = -value;
    }
    AHat.data[targetRowOffset + 2 * nOrig + i] = 1;
  }

  // ĉ = [-c; c; 0_m]
  const cHat = new Float64Array(2 * nOrig + m);
  for (let i = 0; i < nOrig; i++) {
    cHat[i] = -objective[i]!;
    cHat[nOrig + i] = objective[i]!;
  }
  // Warm start mapped into the split variables chi = [x^+; x^-; s] >= 0:
  // x^+ - x^- = x0 exactly, so the displayed first iterate is the chosen
  // point. The slack block stays at the cold start's zeros — like the cold
  // start, the equality residual is left for the iteration to close — and
  // chi0 >= 0 (the splitting's hard constraint) holds by construction.
  let chi0: Float64Array | undefined;
  if (x0) {
    chi0 = new Float64Array(2 * nOrig + m);
    for (let j = 0; j < nOrig; j++) {
      const value = x0[j]!;
      if (value >= 0) chi0[j] = value;
      else chi0[nOrig + j] = -value;
    }
  }
  const result = pdhgCore(AHat, b, cHat, chi0, options);

  // x = x^+ - x^-
  const iterations = result.iterations.map((chi) => {
    const point = new Float64Array(nOrig);
    for (let i = 0; i < nOrig; i++) {
      point[i] = chi[i]! - chi[nOrig + i]!;
    }
    return point;
  });
  return { ...result, iterations };
}
