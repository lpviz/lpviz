// The points a cutting-plane method queries next: the Chebyshev center (one LP), the analytic
// center (the log barrier's minimizer) and Vaidya's volumetric center (the leverage-weighted
// minimizer of ½ log det H), each with the inscribed ellipsoid drawn for it. Written for n
// variables; the two-variable closed forms live in the math package's symmetric helpers.

import { dot, matVec, symmetricQuadraticForm } from "@lpviz/math/blas";
import { invertSymmetric, logDetSymmetric } from "@lpviz/math/lapack";
import { chebyshevCenter, type LpRow } from "@lpviz/math/lp";

const MAX_NEWTON_STEPS = 80;
const NEWTON_DECREMENT_TOLERANCE = 1e-12;
const DAMPED_NEWTON_THRESHOLD = 0.25;
const MIN_SLACK = 1e-14;
const BACKTRACK_FACTOR = 0.5;
const MAX_BACKTRACKS = 60;
// Below this the localizing set has no room left to query and the incumbent is
// the answer; it is the polyhedral counterpart of the ellipsoid collapsing.
const MIN_CHEBYSHEV_RADIUS = 1e-12;
// inert box for the LP solver: the localizing set carries its own bounds
export const LP_BOUND = 1e6;

export const QUERY_POINTS = ["chebyshev", "analytic", "volumetric"] as const;
export type QueryPoint = (typeof QUERY_POINTS)[number];

type QueryResult = {
  point: Float64Array;
  // The ellipsoid drawn for this iterate as its n x n shape matrix, *inscribed* at the query point
  // (the ellipsoid method's is a covering ellipsoid): a local measure of room, not the region still
  // under consideration, so the next query point is routinely outside it.
  P: Float64Array;
  leverage: Float64Array | null;
};

export function computeQueryPoint(kind: QueryPoint, rows: LpRow[], n: number): QueryResult | null {
  const ball = chebyshevCenter(rows, n, LP_BOUND);
  if (!ball || !(ball.radius > MIN_CHEBYSHEV_RADIUS)) return null;
  if (!ball.center.every(Number.isFinite)) {
    return null;
  }

  if (kind === "chebyshev") {
    const P = new Float64Array(n * n);
    for (let j = 0; j < n; j++) P[j * n + j] = ball.radius * ball.radius;
    return { point: ball.center, P, leverage: null };
  }

  // the inscribed ball's center is strictly interior, which is exactly what
  // both barriers need to start from — no cut-restoration step required
  const center = barrierCenter(rows, ball.center, kind === "volumetric", n);
  if (!center) return null;

  const hessian = barrierHessian(rows, center, kind === "volumetric", n);
  if (!hessian) return null;
  const P = invertSymmetric(hessian.metric, n);
  if (!P) return null;

  return { point: center, P, leverage: hessian.leverage };
}

function slacksOf(rows: LpRow[], x: Float64Array, n: number): Float64Array | null {
  const slacks = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let slack = row[n]!;
    for (let j = 0; j < n; j++) slack -= row[j]! * x[j]!;
    if (!(slack > MIN_SLACK)) return null;
    slacks[i] = slack;
  }
  return slacks;
}

// -sum log(slack), the analytic center's objective
function logBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  let value = 0;
  for (let i = 0; i < slacks.length; i++) value -= Math.log(slacks[i]!);
  return value;
}

// sum_i w_i a_i a_i' as a dense symmetric n x n matrix, over the upper triangle then mirrored. Its own
// product order, kept apart from the math package's weightedGram: the query point is hashed output.
function rowsGram(rows: LpRow[], weight: (i: number) => number, n: number): Float64Array {
  const H = new Float64Array(n * n);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const w = weight(i);
    for (let j = 0; j < n; j++) {
      for (let k = j; k < n; k++) H[j * n + k] = H[j * n + k]! + row[j]! * row[k]! * w;
    }
  }
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < j; k++) H[j * n + k] = H[k * n + j]!;
  }
  return H;
}

// H(x) = sum a_i a_i' / s_i^2
const barrierGram = (rows: LpRow[], slacks: Float64Array, n: number) => rowsGram(rows, (i) => 1 / (slacks[i]! * slacks[i]!), n);

// ½ log det H(x), Vaidya's volumetric barrier
function volumetricBarrier(rows: LpRow[], x: Float64Array, n: number): number {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return Infinity;
  const logDet = logDetSymmetric(barrierGram(rows, slacks, n), n);
  return logDet === null ? Infinity : 0.5 * logDet;
}

// The barrier's metric at x: H(x) itself for the analytic center; for Vaidya each face's leverage
// score sigma_i = a_i' H^-1 a_i / s_i^2 and the leverage-weighted matrix Q that stands in for the
// volumetric barrier's Hessian.
function barrierHessian(rows: LpRow[], x: Float64Array, weighted: boolean, n: number) {
  const slacks = slacksOf(rows, x, n);
  if (!slacks) return null;

  const H = barrierGram(rows, slacks, n);
  const inverse = invertSymmetric(H, n);
  if (!inverse) return null;

  const leverage = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    leverage[i] = symmetricQuadraticForm(inverse, rows[i]!, n) / (slacks[i]! * slacks[i]!);
  }
  if (!weighted) return { metric: H, leverage, slacks };
  return { metric: rowsGram(rows, (i) => leverage[i]! / (slacks[i]! * slacks[i]!), n), leverage, slacks };
}

// Damped Newton on a self-concordant barrier: full steps once the Newton
// decrement is small, backtracking before that (and always far enough to stay
// strictly inside, which the barrier's +Infinity outside enforces on its own).
function minimizeBarrier(
  start: Float64Array,
  n: number,
  gradientAndStep: (x: Float64Array) => { gradient: Float64Array; direction: Float64Array } | null,
  value: (x: Float64Array) => number,
): Float64Array | null {
  const x = start.slice();
  const candidate = new Float64Array(n);
  let current = value(x);
  if (!Number.isFinite(current)) return null;

  for (let step = 0; step < MAX_NEWTON_STEPS; step++) {
    const newton = gradientAndStep(x);
    if (!newton) return null;
    const decrementSquared = -dot(newton.gradient, newton.direction);
    if (!(decrementSquared > NEWTON_DECREMENT_TOLERANCE)) break;
    const decrement = Math.sqrt(decrementSquared);

    let t = decrement > DAMPED_NEWTON_THRESHOLD ? 1 / (1 + decrement) : 1;
    let accepted = false;
    for (let attempt = 0; attempt < MAX_BACKTRACKS; attempt++) {
      for (let j = 0; j < n; j++) candidate[j] = x[j]! + t * newton.direction[j]!;
      const next = value(candidate);
      if (Number.isFinite(next) && next < current) {
        x.set(candidate);
        current = next;
        accepted = true;
        break;
      }
      t *= BACKTRACK_FACTOR;
    }
    if (!accepted) break;
  }
  return x;
}

// The analytic center minimizes the log barrier, whose gradient is
// sum a_i / s_i; the volumetric center minimizes ½ log det H, whose gradient
// weights each face by its leverage score: sum sigma_i a_i / s_i.
function barrierCenter(rows: LpRow[], start: Float64Array, volumetric: boolean, n: number) {
  return minimizeBarrier(
    start,
    n,
    (x) => {
      const hessian = barrierHessian(rows, x, volumetric, n);
      if (!hessian) return null;
      const inverse = invertSymmetric(hessian.metric, n);
      if (!inverse) return null;
      const gradient = new Float64Array(n);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const weight = volumetric ? hessian.leverage[i]! / hessian.slacks[i]! : 1 / hessian.slacks[i]!;
        for (let j = 0; j < n; j++) gradient[j] = gradient[j]! + row[j]! * weight;
      }
      // the Newton direction -H^-1 g
      const direction = new Float64Array(n);
      matVec({ rows: n, cols: n, data: inverse }, gradient, direction);
      for (let j = 0; j < n; j++) direction[j] = -direction[j]!;
      return { gradient, direction };
    },
    (x) => (volumetric ? volumetricBarrier(rows, x, n) : logBarrier(rows, x, n)),
  );
}
