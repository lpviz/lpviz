import { type DenseMatrix, denseFromConstraints, dot, infinityNorm, matVec } from "@lpviz/math/blas";
import { solveDenseSystem } from "@lpviz/math/lapack";
import { centroid } from "@lpviz/math/polygon";
import type { Constraint, Vec } from "@lpviz/math/types";
import { findStrictFeasiblePoint } from "@lpviz/polytope/halfSpaces";
import { coordinateHeaders, fmtCoordinates, fmtExp, fmtExpUnsigned, formatMilliseconds, logColumnWidths, padLeft, padRight } from "./fmt";
import { MAX_PATH_POINTS } from "./limits";
import type { SolverResult } from "./result";

const MIN_STEP_SIZE = 1e-10;
const LINE_SEARCH_SHRINK_FACTOR = 0.5;
const LINE_SEARCH_SUFFICIENT_DECREASE = 0.01;
const MAX_LINE_SEARCH_ITERATIONS = 100;
const NEWTON_GRADIENT_TOLERANCE = 1e-4;
const NEWTON_DECREMENT_RELATIVE_TOLERANCE = 1e-12;
const MAX_NEWTON_ITERATIONS = 2000;
// the barrier parameter runs down a log-spaced ladder from 10^3 to 10^-5
const BARRIER_PARAM_START = 3.0;
const BARRIER_PARAM_END = -5.0;
const ITERATION_COLUMN_WIDTH = 4;

export interface CentralPathOptions {
  /** how many points of the path to trace, one per barrier parameter */
  niter: number;
  /**
   * A strictly feasible point to start the Newton steps from. Two-variable problems can find one
   * from their vertices or constraints; any other dimension must supply it.
   */
  interiorPoint?: readonly number[] | undefined;
}

/**
 * The central path of `max objective'x s.t. Ax <= b`: for each barrier parameter mu on a log-spaced
 * ladder, the maximizer of `c'x + mu * sum log(b - Ax)` by damped Newton steps started from the
 * previous point. The barrier's share of the objective is the height the 3D view lifts each point by.
 */
export function centralPath(vertices: Vec[], constraints: readonly Constraint[], objective: Float64Array, opts: CentralPathOptions): SolverResult {
  const { niter, interiorPoint } = opts;

  if (niter > MAX_PATH_POINTS) {
    throw new Error("niter > 2^10 not allowed");
  }

  const startTime = performance.now();
  const { A, b } = denseFromConstraints(constraints);
  const c = Float64Array.from(objective);
  const n = A.cols;
  const barrier = new BarrierProblem(A, b, c);

  const start = startingPoint(barrier, interiorPoint, vertices, constraints);
  if (!start) {
    throw new Error("Central Path requires a strictly feasible starting point.");
  }

  const widths = logColumnWidths(n);
  const header = `  ${padRight("Iter", ITERATION_COLUMN_WIDTH)} ${coordinateHeaders(n)} ${padLeft("Obj", widths.measure)} ${padLeft("µ", widths.measure)}  \n`;
  const points: Float64Array[] = [];
  const barrierTerms: number[] = [];
  const rows: string[] = [];

  let current = start;
  for (const mu of barrierParameters(niter)) {
    const point = barrier.centralPoint(mu, current);
    if (!point) continue;

    const linearObjective = dot(c, point);
    points.push(point.slice());
    // the barrier's share of the objective: what the 3D view lifts this iterate by
    barrierTerms.push(barrier.value(mu, point) - linearObjective);
    rows.push(
      `  ${padRight(String(points.length), ITERATION_COLUMN_WIDTH)} ${fmtCoordinates(point, widths.coordinate)} ${fmtExp(linearObjective, widths.measure, 1)} ${fmtExpUnsigned(mu, widths.measure, 1)}  \n`,
    );
    current = point;
  }

  const footer = `Traced central path in ${formatMilliseconds(performance.now() - startTime)}`;
  return { iterations: points, convergence: barrierTerms, log: [{ header, rows, footer }] };
}

// A supplied point is checked, not trusted; without one, a two-variable problem starts from the
// centroid of its vertices (or, for an open region, from a point its constraints admit).
function startingPoint(barrier: BarrierProblem, interiorPoint: readonly number[] | undefined, vertices: Vec[], constraints: readonly Constraint[]): Float64Array | null {
  if (interiorPoint) {
    return barrier.isStrictlyFeasible(interiorPoint) ? Float64Array.from(interiorPoint) : null;
  }
  if (barrier.n !== 2) return null;
  const point = vertices.length >= 3 ? centroid(vertices) : findStrictFeasiblePoint(constraints);
  return point ? Float64Array.from(point) : null;
}

function barrierParameters(niter: number): number[] {
  if (niter <= 0) return [];
  if (niter === 1) return [10 ** BARRIER_PARAM_START];

  const stepSize = (BARRIER_PARAM_END - BARRIER_PARAM_START) / (niter - 1);
  return Array.from({ length: niter }, (_, index) => 10 ** (BARRIER_PARAM_START + index * stepSize));
}

// The barrier objective `c'x + mu * sum log(b - Ax)` over `Ax < b`, with the Newton machinery that
// maximizes it; the scratch buffers are reused across every call.
class BarrierProblem {
  readonly n: number;
  private readonly ax: Float64Array;
  private readonly slack: Float64Array;
  private readonly gradient: Float64Array;
  private readonly hessian: Float64Array;
  private readonly step: Float64Array;
  private readonly candidate: Float64Array;
  private readonly luScratch: Float64Array;

  constructor(
    private readonly A: DenseMatrix,
    private readonly b: Float64Array,
    private readonly c: Float64Array,
  ) {
    this.n = A.cols;
    this.ax = new Float64Array(b.length);
    this.slack = new Float64Array(b.length);
    this.gradient = new Float64Array(this.n);
    this.hessian = new Float64Array(this.n * this.n);
    this.step = new Float64Array(this.n);
    this.candidate = new Float64Array(this.n);
    this.luScratch = new Float64Array(this.n * this.n);
  }

  isStrictlyFeasible(x: ArrayLike<number>): boolean {
    const { A, b } = this;
    if (x.length !== A.cols) return false;
    for (let i = 0; i < A.rows; i++) {
      let ax = 0;
      for (let j = 0; j < A.cols; j++) ax += A.data[i * A.cols + j]! * x[j]!;
      if (!(ax < b[i]!)) return false;
    }
    return true;
  }

  /** The barrier objective at `point`, or -Infinity outside the region. */
  value(mu: number, point: Float64Array): number {
    const { A, b, c, ax, slack } = this;
    matVec(A, point, ax);
    let logBarrier = 0;
    for (let i = 0; i < b.length; i++) {
      const s = b[i]! - ax[i]!;
      slack[i] = s;
      if (s <= 0) return -Infinity;
      logBarrier += Math.log(s);
    }
    return dot(c, point) + mu * logBarrier;
  }

  /** The maximizer for `mu`, by Newton steps from `x0`; null when the steps fail to converge. */
  centralPoint(mu: number, x0: Float64Array): Float64Array | null {
    const { gradient, step } = this;
    const point = Float64Array.from(x0);

    for (let iteration = 1; iteration <= MAX_NEWTON_ITERATIONS; iteration++) {
      if (!this.newtonStep(mu, point)) return null;

      const decrement = dot(gradient, step);
      const current = this.value(mu, point);
      if (infinityNorm(gradient) < NEWTON_GRADIENT_TOLERANCE || decrement <= NEWTON_DECREMENT_RELATIVE_TOLERANCE * (1 + Math.abs(current))) {
        return Float64Array.from(point);
      }

      const stepSize = this.lineSearch(mu, point, current, decrement);
      if (stepSize === 0) return null;
      for (let j = 0; j < point.length; j++) {
        point[j]! += step[j]! * stepSize;
      }
    }

    return null;
  }

  // The gradient and the Newton step at `point` into their buffers; false when the point is
  // outside the region or the Hessian is singular.
  private newtonStep(mu: number, point: Float64Array): boolean {
    const { A, b, c, ax, slack, gradient, hessian, step, luScratch } = this;
    matVec(A, point, ax);
    gradient.set(c);
    hessian.fill(0);

    for (let i = 0; i < b.length; i++) {
      const s = b[i]! - ax[i]!;
      slack[i] = s;
      if (s <= 0) return false;
      const invSlack = 1 / s;
      const hessianScale = mu * invSlack * invSlack;
      const gradientScale = mu * invSlack;
      const rowOffset = i * A.cols;
      for (let j = 0; j < A.cols; j++) {
        const aij = A.data[rowOffset + j]!;
        gradient[j]! -= gradientScale * aij;
        for (let k = 0; k < A.cols; k++) {
          hessian[j * A.cols + k]! += hessianScale * aij * A.data[rowOffset + k]!;
        }
      }
    }

    try {
      solveDenseSystem(hessian, A.cols, gradient, step, luScratch);
      return true;
    } catch {
      return false;
    }
  }

  // Backtracking along the Newton step until the Armijo condition holds; zero when no step does.
  private lineSearch(mu: number, point: Float64Array, current: number, gradientDotStep: number): number {
    const { step, candidate } = this;
    let stepSize = 1;

    for (let i = 0; i < MAX_LINE_SEARCH_ITERATIONS; i++) {
      for (let j = 0; j < point.length; j++) {
        candidate[j] = point[j]! + step[j]! * stepSize;
      }

      const next = this.value(mu, candidate);
      if (next !== -Infinity && next >= current + LINE_SEARCH_SUFFICIENT_DECREASE * stepSize * gradientDotStep) {
        return stepSize;
      }

      stepSize *= LINE_SEARCH_SHRINK_FACTOR;
      if (stepSize < MIN_STEP_SIZE) {
        return 0;
      }
    }

    return 0;
  }
}
