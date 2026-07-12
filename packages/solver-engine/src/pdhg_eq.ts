import { createDenseMatrix, dot, infinityNorm, linesToDenseAb, matVec, transposedMatVec } from "@lpviz/math/blas";
import type { LinesND, Vec2Ns, VecN } from "@lpviz/math/types";
import { formatMilliseconds } from "./time";

const MAX_ITERATIONS_LIMIT = 100_000;

interface PDHGEqOptions {
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

function computeSlackBasisPhase(xk: Float64Array, m: number, slackOffset: number) {
  let phase = 0;
  for (let i = 0; i < m; i++) {
    phase = (phase * 33 + (Math.abs(xk[slackOffset + i]!) <= BASIS_THRESHOLD ? 1 : 0)) >>> 0;
  }
  return phase;
}

function pdhgEpsilon(A: ReturnType<typeof createDenseMatrix>, b: Float64Array, c: Float64Array, xk: Float64Array, yk: Float64Array, axScratch: Float64Array, atYScratch: Float64Array, bNorm: number, cNorm: number) {
  matVec(A, xk, axScratch);
  let primalResidual = 0;
  for (let i = 0; i < axScratch.length; i++) {
    const residual = Math.abs(axScratch[i]! - b[i]!);
    if (residual > primalResidual) primalResidual = residual;
  }

  transposedMatVec(A, yk, atYScratch);
  let dualResidual = 0;
  for (let i = 0; i < atYScratch.length; i++) {
    const residual = Math.max(0, -atYScratch[i]! - c[i]!);
    if (residual > dualResidual) dualResidual = residual;
  }

  const cTx = dot(c, xk);
  const bTy = dot(b, yk);
  const dualityGap = Math.abs(cTx + bTy) / (1 + Math.abs(cTx) + Math.abs(bTy));
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

function pdhgStandardForm(
  A: ReturnType<typeof createDenseMatrix>,
  b: Float64Array,
  c: Float64Array,
  options: PDHGEqOptions,
  chi0?: Float64Array,
) {
  const { maxit, eta, tau, tol, verbose, colorByBasis, halpern } = options;

  const { rows: m, cols: n } = A;
  const slackOffset = n - m;
  // x is split as x = x^+ - x^- with xk = [x^+; x^-; s]
  const nOrig = slackOffset / 2;
  const bNorm = infinityNorm(b);
  const cNorm = infinityNorm(c);

  let xk = new Float64Array(n);
  let yk = new Float64Array(m);
  let nextX = new Float64Array(n);
  let nextY = new Float64Array(m);
  let halpernX = new Float64Array(n);
  let halpernY = new Float64Array(m);
  let anchorX = new Float64Array(n);
  let anchorY = new Float64Array(m);
  const axScratch = new Float64Array(m);
  const atYScratch = new Float64Array(n);
  const extrapolatedXScratch = new Float64Array(n);
  if (chi0 && chi0.length === n) {
    // Warm start in the split variables (see pdhgEq for how chi0 is built).
    // The equality duals stay at 0: they are sign-free, complementary
    // slackness pins nothing for equality rows, and any y0 is safe by
    // nonexpansiveness of the PDHG operator — zero is the neutral
    // "no price information" choice.
    xk.set(chi0);
    anchorX.set(chi0);
  }
  let k = 1;
  let innerIteration = 1;
  let initialFixedPointError = Number.POSITIVE_INFINITY;
  let lastTrialFixedPointError = Number.POSITIVE_INFINITY;

  let epsilonK = pdhgEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm);
  const header = nOrig >= 3 ? " Iter        x        y        z        Obj     Infeas        eps" : " Iter        x        y        Obj     Infeas        eps";

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
  const iterates: Vec2Ns = [];
  const eps: number[] = [];
  const phases: number[] = [];
  const restartIndices: number[] = [];
  const startTime = performance.now();

  if (verbose) console.log(header);

  while (k <= maxit) {
    iterates.push(xk.slice());
    if (colorByBasis) {
      phases.push(computeSlackBasisPhase(xk, m, slackOffset));
    }

    const pObj = -dot(c, xk);
    matVec(A, xk, axScratch);
    let pFeas = 0;
    for (let i = 0; i < m; i++) {
      const residual = Math.abs(axScratch[i]! - b[i]!);
      if (residual > pFeas) pFeas = residual;
    }
    const row: (typeof rows)[number] = {
      kind: "pdhg" as const,
      iteration: k,
      restart: false,
      x: (xk[0] ?? 0) - (xk[nOrig] ?? 0),
      y: nOrig >= 2 ? (xk[1] ?? 0) - (xk[nOrig + 1] ?? 0) : 0,
      objective: pObj,
      infeasibility: pFeas,
      epsilon: epsilonK,
    };
    if (nOrig >= 3) row.z = (xk[2] ?? 0) - (xk[nOrig + 2] ?? 0);
    if (verbose) console.log(row);
    rows.push(row);
    eps.push(epsilonK);

    if (epsilonK <= tol || k === maxit) {
      break;
    }

    // x_{k+1} = [x_k - η(c + A^T y_k)]_+
    transposedMatVec(A, yk, atYScratch);
    for (let i = 0; i < n; i++) {
      const candidate = xk[i]! - eta * (c[i]! + atYScratch[i]!);
      nextX[i] = candidate > 0 ? candidate : 0;
      extrapolatedXScratch[i] = 2 * nextX[i]! - xk[i]!;
    }
    // x̃_k = x_{k+1} + (x_{k+1} - x_k)
    // y_{k+1} = y_k + τ(Ax̃_k - b)
    matVec(A, extrapolatedXScratch, axScratch);
    for (let i = 0; i < m; i++) {
      nextY[i] = yk[i]! + tau * (axScratch[i]! - b[i]!);
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

    epsilonK = pdhgEpsilon(A, b, c, xk, yk, axScratch, atYScratch, bNorm, cNorm);
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

export function pdhgEq(lines: LinesND, objective: VecN, options: PDHGEqOptions) {
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

  const { A: AOriginal, b } = linesToDenseAb(lines);
  const nOrig = AOriginal.cols;
  const m = AOriginal.rows;

  // x = x^+ - x^- where x^+, x^- ≥ 0
  // A(x^+ - x^-) = b becomes A[x^+; x^-; s] = b with slack s
  const AHat = createDenseMatrix(m, 2 * nOrig + m);
  for (let i = 0; i < m; i++) {
    const originalRowOffset = i * nOrig;
    const targetRowOffset = i * AHat.cols;
    for (let j = 0; j < nOrig; j++) {
      const value = AOriginal.data[originalRowOffset + j]!;
      AHat.data[targetRowOffset + j] = value;
      AHat.data[targetRowOffset + nOrig + j] = -value;
    }
    AHat.data[targetRowOffset + 2 * nOrig + i] = 1;
  }

  // ĉ = [-c; c; 0_m]
  const cHat = new Float64Array(2 * nOrig + m);
  for (let i = 0; i < nOrig; i++) {
    cHat[i] = -objective[i]!;
    cHat[nOrig + i] = objective[i]!;
  }
  // Warm start mapped into the split variables chi = [x^+; x^-; s] >= 0:
  // x^+ - x^- = x0 exactly, so the displayed first iterate is the chosen
  // point. The slack block stays at the cold start's zeros — like the cold
  // start, the equality residual is left for the iteration to close — so a
  // start at the default position reproduces the cold trajectory exactly,
  // and chi0 >= 0 (the splitting's hard constraint) holds by construction.
  let chi0: Float64Array | undefined;
  if (startPoint && startPoint.length === nOrig) {
    chi0 = new Float64Array(2 * nOrig + m);
    for (let j = 0; j < nOrig; j++) {
      const value = startPoint[j]!;
      if (value >= 0) chi0[j] = value;
      else chi0[nOrig + j] = -value;
    }
  }
  const {
    iterations: chiIterates,
    header,
    rows,
    footer,
    eps,
    phases,
    restartIndices,
  } = pdhgStandardForm(
    AHat,
    b,
    cHat,
    {
      maxit,
      eta,
      tau,
      verbose,
      tol,
      colorByBasis,
      halpern,
    },
    chi0,
  );

  // x = x^+ - x^-
  const xIterates = chiIterates.map((chi) => {
    const point = new Float64Array(nOrig);
    for (let i = 0; i < nOrig; i++) {
      point[i] = chi[i]! - chi[nOrig + i]!;
    }
    return point;
  });

  return {
    header,
    iterations: xIterates,
    rows,
    footer,
    eps,
    phases,
    restartIndices,
  };
}
