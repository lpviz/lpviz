import { dot, infinityNorm, linesToDenseAb, matVec } from "@lpviz/math/blas";
import { centroid, findStrictFeasiblePoint } from "@lpviz/math/geometry";
import { solveDenseSystem } from "@lpviz/math/lapack";
import type { Lines, LinesND, VecN, VecNs, Vertices } from "@lpviz/math/types";
import { fmtE, fmtF, fmtIntL, fmtStr, fmtStrL } from "./fmt";

const MIN_STEP_SIZE = 1e-10;
const LINE_SEARCH_SHRINK_FACTOR = 0.5;
const LINE_SEARCH_SUFFICIENT_DECREASE = 0.01;
const MAX_LINE_SEARCH_ITERATIONS = 100;
const DEFAULT_CONVERGENCE_TOLERANCE = 1e-4;
const DEFAULT_MAX_NEWTON_ITERATIONS = 2000;
const BARRIER_PARAM_START = 3.0;
const BARRIER_PARAM_END = -5.0;

interface CentralPathOptions {
  niter: number;
  verbose: boolean;
  interiorPoint?: number[];
}

interface CentralPathXkOptions {
  maxit: number;
  epsilon: number;
  verbose: boolean;
}

function computeObjective(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, c: Float64Array, mu: number, point: Float64Array, axScratch: Float64Array, slackScratch: Float64Array) {
  matVec(A, point, axScratch);
  let logBarrier = 0;
  for (let i = 0; i < b.length; i++) {
    const slack = b[i]! - axScratch[i]!;
    slackScratch[i] = slack;
    if (slack <= 0) return -Infinity;
    logBarrier += Math.log(slack);
  }
  return dot(c, point) + mu * logBarrier;
}

function computeNewtonStep(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, c: Float64Array, mu: number, point: Float64Array, gradient: Float64Array, hessian: Float64Array, axScratch: Float64Array, slackScratch: Float64Array, stepScratch: Float64Array, luScratch: Float64Array) {
  matVec(A, point, axScratch);
  gradient.set(c);
  hessian.fill(0);

  for (let i = 0; i < b.length; i++) {
    const slack = b[i]! - axScratch[i]!;
    slackScratch[i] = slack;
    if (slack <= 0) {
      return null;
    }
    const invSlack = 1 / slack;
    const hessianScale = mu * invSlack * invSlack;
    const gradientScale = mu * invSlack;
    const rowOffset = i * A.cols;
    for (let j = 0; j < A.cols; j++) {
      const aij = A.data[rowOffset + j]!;
      gradient[j] -= gradientScale * aij;
      for (let k = 0; k < A.cols; k++) {
        hessian[j * A.cols + k] += hessianScale * aij * A.data[rowOffset + k]!;
      }
    }
  }

  try {
    solveDenseSystem(hessian, A.cols, gradient, stepScratch, luScratch);
    return stepScratch;
  } catch (error) {
    console.error("Error in Newton step computation:", error);
    return null;
  }
}

function performLineSearch(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, c: Float64Array, mu: number, currentPoint: Float64Array, newtonStep: Float64Array, gradient: Float64Array, candidatePoint: Float64Array, axScratch: Float64Array, slackScratch: Float64Array) {
  let stepSize = 1;
  const currentObjective = computeObjective(A, b, c, mu, currentPoint, axScratch, slackScratch);
  const gradientDotStep = dot(gradient, newtonStep);

  for (let i = 0; i < MAX_LINE_SEARCH_ITERATIONS; i++) {
    for (let j = 0; j < currentPoint.length; j++) {
      candidatePoint[j] = currentPoint[j]! + newtonStep[j]! * stepSize;
    }

    const candidateObjective = computeObjective(A, b, c, mu, candidatePoint, axScratch, slackScratch);
    if (candidateObjective !== -Infinity && candidateObjective >= currentObjective + LINE_SEARCH_SUFFICIENT_DECREASE * stepSize * gradientDotStep) {
      return stepSize;
    }

    stepSize *= LINE_SEARCH_SHRINK_FACTOR;
    if (stepSize < MIN_STEP_SIZE) {
      return 0;
    }
  }

  return 0;
}

function centralPathXk(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, c: Float64Array, mu: number, x0: Float64Array, opts: CentralPathXkOptions) {
  const { maxit, epsilon, verbose } = opts;

  const currentPoint = Float64Array.from(x0);
  const gradient = new Float64Array(c.length);
  const hessian = new Float64Array(c.length * c.length);
  const step = new Float64Array(c.length);
  const candidatePoint = new Float64Array(c.length);
  const axScratch = new Float64Array(b.length);
  const slackScratch = new Float64Array(b.length);
  const luScratch = new Float64Array(c.length * c.length);

  for (let iteration = 1; iteration <= maxit; iteration++) {
    const newtonStep = computeNewtonStep(A, b, c, mu, currentPoint, gradient, hessian, axScratch, slackScratch, step, luScratch);
    if (newtonStep === null) {
      return null;
    }

    const gradientInfinityNorm = infinityNorm(gradient);
    if (gradientInfinityNorm < epsilon) {
      if (verbose) console.log(`Converged in ${iteration} iterations with mu = ${mu}`);
      return Float64Array.from(currentPoint);
    }

    const stepSize = performLineSearch(A, b, c, mu, currentPoint, newtonStep, gradient, candidatePoint, axScratch, slackScratch);
    if (stepSize === 0) {
      if (verbose) console.warn(`Line search failed to find a feasible step for mu = ${mu}`);
      return null;
    }
    for (let j = 0; j < currentPoint.length; j++) {
      currentPoint[j] += newtonStep[j]! * stepSize;
    }

    if (verbose) {
      const objectiveValue = computeObjective(A, b, c, mu, currentPoint, axScratch, slackScratch);
      console.log(`Iter ${iteration}: f(x) = ${objectiveValue.toFixed(6)}, ||grad||_inf = ${gradientInfinityNorm.toExponential(2)}, alpha = ${stepSize.toFixed(2)}`);
    }
  }

  if (verbose) console.warn(`Did not converge after ${maxit} iterations for mu = ${mu}`);
  return null;
}

function isStrictlyFeasible(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, candidate: number[], axScratch: Float64Array) {
  if (candidate.length !== A.cols) return false;
  matVec(A, Float64Array.from(candidate), axScratch);
  for (let i = 0; i < b.length; i++) {
    if (!(b[i]! - axScratch[i]! > 0)) return false;
  }
  return true;
}

export function centralPath(vertices: Vertices, lines: LinesND, objective: VecN, opts: CentralPathOptions) {
  const { niter, verbose, interiorPoint } = opts;

  if (niter > 2 ** 10) {
    throw new Error("niter > 2^10 not allowed");
  }

  const startTime = Date.now();
  const { A, b } = linesToDenseAb(lines);
  const n = A.cols;
  const c = Float64Array.from(objective);
  const barrierParameters = centralPathMu(niter);

  const points: VecNs = [];
  const logs: string[] = [];
  const header = n >= 3 ? `  ${fmtStrL("Iter", 4)} ${fmtStr("x", 8)} ${fmtStr("y", 8)} ${fmtStr("z", 8)} ${fmtStr("Obj", 10)} ${fmtStr("µ", 10)}  \n` : `  ${fmtStrL("Iter", 4)} ${fmtStr("x", 8)} ${fmtStr("y", 8)} ${fmtStr("Obj", 10)} ${fmtStr("µ", 10)}  \n`;
  if (verbose) console.log(header);
  logs.push(header);

  const axScratch = new Float64Array(b.length);
  const slackScratch = new Float64Array(b.length);

  const startPoint = interiorPoint ? (isStrictlyFeasible(A, b, interiorPoint, axScratch) ? interiorPoint : null) : vertices.length >= 3 ? centroid(vertices) : findStrictFeasiblePoint(lines as Lines);
  if (!startPoint) {
    throw new Error("Central Path requires a strictly feasible starting point.");
  }

  let currentPoint = Float64Array.from(startPoint);

  for (const mu of barrierParameters) {
    const optimalPoint = centralPathXk(A, b, c, mu, currentPoint, {
      verbose,
      epsilon: DEFAULT_CONVERGENCE_TOLERANCE,
      maxit: DEFAULT_MAX_NEWTON_ITERATIONS,
    });

    if (!optimalPoint) {
      if (verbose) console.log(`Failed to find optimal point for μ = ${mu}. Skipping.`);
      continue;
    }

    const totalObjective = computeObjective(A, b, c, mu, optimalPoint, axScratch, slackScratch);
    const linearObjective = dot(c, optimalPoint);
    const point = new Float64Array(n + 1);
    for (let j = 0; j < n; j++) {
      point[j] = optimalPoint[j] ?? 0;
    }
    point[n] = totalObjective;
    points.push(point);

    const progressLog = n >= 3 ? `  ${fmtIntL(points.length, 4)} ${fmtF(optimalPoint[0] ?? 0, 8, 2)} ${fmtF(optimalPoint[1] ?? 0, 8, 2)} ${fmtF(optimalPoint[2] ?? 0, 8, 2)} ${fmtE(linearObjective, 10, 1)} ${fmtE(mu, 10, 1, false)}  \n` : `  ${fmtIntL(points.length, 4)} ${fmtF(optimalPoint[0] ?? 0, 8, 2)} ${fmtF(optimalPoint[1] ?? 0, 8, 2)} ${fmtE(linearObjective, 10, 1)} ${fmtE(mu, 10, 1, false)}  \n`;
    if (verbose) console.log(progressLog);
    logs.push(progressLog);

    currentPoint = optimalPoint;
  }

  return {
    iterations: points,
    logs,
    tsolve: (Date.now() - startTime) / 1000,
  };
}

function centralPathMu(niter: number): number[] {
  if (niter <= 0) return [];
  if (niter === 1) return [1000];

  const stepSize = (BARRIER_PARAM_END - BARRIER_PARAM_START) / (niter - 1);
  return Array.from({ length: niter }, (_, index) => 10 ** (BARRIER_PARAM_START + index * stepSize));
}
