import { dot, infinityNorm, linesToDenseAb, matVec, transposedMatVec } from "@lpviz/math/blas";
import type { LinesND, Vec2Ns, VecN } from "@lpviz/math/types";
import { formatMilliseconds } from "./time";

const MAX_ITERATIONS_LIMIT = 100_000;

interface PDHGIneqOptions {
  maxit: number;
  eta: number;
  tau: number;
  tol: number;
  verbose: boolean;
  colorByBasis: boolean;
  halpern: boolean;
  startPoint?: number[];
}

const BASIS_THRESHOLD = 1e-10;
const HALPERN_SUFFICIENT_REDUCTION = 0.2;
const HALPERN_NECESSARY_REDUCTION = 0.5;
const HALPERN_ARTIFICIAL_RESTART_THRESHOLD = 0.36;

function computeIneqBasisPhase(yk: Float64Array) {
  let phase = 0;
  for (let i = 0; i < yk.length; i++) {
    phase = (phase * 33 + (yk[i]! > BASIS_THRESHOLD ? 1 : 0)) >>> 0;
  }
  return phase;
}

function pdhgIneqEpsilon(A: ReturnType<typeof linesToDenseAb>["A"], b: Float64Array, c: Float64Array, xk: Float64Array, yk: Float64Array, axScratch: Float64Array, atYScratch: Float64Array, bNorm: number, cNorm: number) {
  matVec(A, xk, axScratch);
  let primalResidual = 0;
  for (let i = 0; i < axScratch.length; i++) {
    const residual = Math.max(0, axScratch[i]! - b[i]!);
    if (residual > primalResidual) primalResidual = residual;
  }

  transposedMatVec(A, yk, atYScratch);
  let dualResidual = 0;
  for (let i = 0; i < atYScratch.length; i++) {
    const residual = Math.abs(c[i]! + atYScratch[i]!);
    if (residual > dualResidual) dualResidual = residual;
  }

  const cTx = dot(c, xk);
  const bTy = dot(b, yk);
  const dualityGap = Math.abs(bTy + cTx) / (1 + Math.abs(cTx) + Math.abs(bTy));
  return Math.max(primalResidual / (1 + bNorm), dualResidual / (1 + cNorm), dualityGap);
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

export function pdhgIneq(
  lines: LinesND,
  objective: VecN,
  options: PDHGIneqOptions,
) {
  const {
    maxit = 1000,
    eta = 0.25,
    tau = 0.25,
    verbose = false,
    tol = 1e-4,
    colorByBasis = false,
    halpern = false,
    startPoint,
  } = options;
  if (maxit > MAX_ITERATIONS_LIMIT) {
    throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
  }

  const { A, b } = linesToDenseAb(lines);
  const c = Float64Array.from(objective, (value) => -value);

  const { rows: m, cols: n } = A;
  const bNorm = infinityNorm(b);
  const cNorm = infinityNorm(c);

  let xk = new Float64Array(n);
  let yk = new Float64Array(m).fill(1);
  let nextX = new Float64Array(n);
  let nextY = new Float64Array(m);
  let halpernX = new Float64Array(n);
  let halpernY = new Float64Array(m);
  let anchorX = new Float64Array(n);
  let anchorY = new Float64Array(m).fill(1);
  const axScratch = new Float64Array(m);
  const atYScratch = new Float64Array(n);
  const extrapolatedYScratch = new Float64Array(m);
  if (startPoint && startPoint.length === n) {
    // Warm start: relocate only the primal point (and the Halpern anchor
    // that must sit on it) and keep the cold start's y = 1, so a start at
    // the default position reproduces the cold trajectory exactly. PDHG
    // converges globally from any (x0, y0 >= 0) once eta*tau*||A||^2 < 1,
    // so the cold dual is as safe here as it is at the origin.
    xk.set(startPoint);
    anchorX.set(xk);
  }
  let k = 1;
  let innerIteration = 1;
  let initialFixedPointError = Number.POSITIVE_INFINITY;
  let lastTrialFixedPointError = Number.POSITIVE_INFINITY;

  let epsilonK = pdhgIneqEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm);
  const header = n >= 3 ? " Iter       x       y       z      Obj   Infeas      eps" : " Iter        x        y        Obj     Infeas        eps";

  const iterates: Vec2Ns = [];
  const eps: number[] = [];
  const phases: number[] = [];
  const restartIndices: number[] = [];
  const startTime = performance.now();
  const rows: Array<{
    kind: "pdhg";
    iteration: number;
    restart?: boolean;
    x: number;
    y: number;
    z?: number;
    objective: number;
    infeasibility: number;
    epsilon: number;
  }> = [];

  if (verbose) console.log(header);

  while (k <= maxit) {
    iterates.push(xk.slice());
    if (colorByBasis) {
      phases.push(computeIneqBasisPhase(yk));
    }

    matVec(A, xk, axScratch);
    let infeasibility = 0;
    for (let i = 0; i < m; i++) {
      const residual = Math.max(0, axScratch[i]! - b[i]!);
      if (residual > infeasibility) infeasibility = residual;
    }
    const row: (typeof rows)[number] = {
      kind: "pdhg" as const,
      iteration: k,
      restart: false,
      x: xk[0] ?? 0,
      y: xk[1] ?? 0,
      objective: -dot(c, xk),
      infeasibility,
      epsilon: epsilonK,
    };
    if (n >= 3) row.z = xk[2] ?? 0;
    if (verbose) console.log(row);
    rows.push(row);
    eps.push(epsilonK);

    if (epsilonK <= tol || k === maxit) {
      break;
    }

    // y_{k+1} = [y_k + τ(Ax_k - b)]_+
    for (let i = 0; i < m; i++) {
      const candidate = yk[i]! + tau * (axScratch[i]! - b[i]!);
      nextY[i] = candidate > 0 ? candidate : 0;
      extrapolatedYScratch[i] = 2 * nextY[i]! - yk[i]!;
    }

    // ỹ_k = y_{k+1} + (y_{k+1} - y_k)
    // x_{k+1} = x_k - η(c + A^T ỹ_k)
    transposedMatVec(A, extrapolatedYScratch, atYScratch);
    for (let i = 0; i < n; i++) {
      nextX[i] = xk[i]! - eta * (c[i]! + atYScratch[i]!);
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

    epsilonK = pdhgIneqEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm);
    if (!Number.isFinite(epsilonK)) {
      break;
    }
  }

  const solveTime = performance.now() - startTime;
  const formattedSolveTime = formatMilliseconds(solveTime);
  const footer = epsilonK <= tol ? `Converged to optimal solution in ${formattedSolveTime} / ${iterates.length} iterations` : `Did not converge after ${iterates.length} iterations in ${formattedSolveTime}`;
  if (verbose) console.log(footer);

  return {
    header,
    iterations: iterates,
    rows,
    footer,
    eps,
    phases: colorByBasis ? phases : undefined,
    restartIndices: halpern ? restartIndices : undefined,
  };
}
