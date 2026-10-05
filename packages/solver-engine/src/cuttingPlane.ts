import { linesToDenseAb } from "@lpviz/math/blas";
import { chebyshevCenter, solveSmallLp, type LpRow } from "@lpviz/math/lp";
import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import {
  ELLIPSOID_HEADER,
  ELLIPSOID_STRIDE,
  FEASIBILITY_TOLERANCE,
  Incumbent,
  appendIncumbent,
  buildFooter,
  clipPolygon,
  mostViolatedConstraint,
  newTrace,
  packPolygons,
  recordIterate,
  regionBoundingBox,
  type EllipsoidResultData,
  type Termination,
} from "./ellipsoid";
import { assertMaxit } from "./time";

const MAX_NEWTON_STEPS = 80;
const NEWTON_DECREMENT_TOLERANCE = 1e-12;
const DAMPED_NEWTON_THRESHOLD = 0.25;
const MIN_SLACK = 1e-14;
const BACKTRACK_FACTOR = 0.5;
const MAX_BACKTRACKS = 60;
// Below this the localizing set has no room left to query and the incumbent is
// the answer; it is the polyhedral counterpart of the ellipsoid collapsing.
const MIN_CHEBYSHEV_RADIUS = 1e-12;
// Vaidya drops a cut once its leverage score falls below this, which bounds the constraint
// count; dropping only ever enlarges the localizing set, so it can never lose the optimum.
const VAIDYA_DROP_LEVERAGE = 1e-3;
// inert box for the LP solver: the localizing set carries its own bounds
const LP_BOUND = 1e6;
// A recession direction has to improve the objective by more than this per
// unit length to count: below it the direction runs along an optimal face, not
// away from it, and the optimum it leads to is a finite value.
const RECESSION_TOLERANCE = 1e-9;

export type QueryPoint = "analytic" | "chebyshev" | "volumetric";

export interface CuttingPlaneOptions {
  maxit: number;
  tol: number;
  rayShoot: boolean;
  initialScale: number;
  queryPoint: QueryPoint;
}

type QueryResult = {
  point: Float64Array;
  // The ellipse drawn for this iterate, *inscribed* at the query point (the ellipsoid method's
  // is a covering ellipsoid): a local measure of room, not the region still under
  // consideration, so the next query point is routinely outside it.
  p11: number;
  p12: number;
  p22: number;
  leverage: Float64Array | null;
};

/**
 * Cutting-plane methods that localize with a polyhedron instead of an ellipsoid, differing in the
 * point they query next: `chebyshev` the center of the largest inscribed ball (one LP), `analytic`
 * the log-barrier minimizer (ACCPM), `volumetric` Vaidya's minimizer of ½ log det H(x) with
 * leverage-weighted faces plus cut dropping. The oracle, incumbent and ray shoot are shared with
 * the ellipsoid method, so iteration counts are directly comparable. The polyhedron's support
 * function has no closed form, so the upper bound `max c'x over L` behind `rho` and the stopping
 * gap is an actual LP, solved exactly each iteration.
 */
export function cuttingPlane(vertices: Vertices, lines: Lines, objective: VecN, opts: CuttingPlaneOptions): EllipsoidResultData {
  const { maxit, tol, rayShoot, initialScale, queryPoint } = opts;

  assertMaxit(maxit);

  const { A, b } = linesToDenseAb(lines);
  const n = A.cols;
  if (n !== 2) {
    throw new Error("The cutting-plane query points are implemented for two variables.");
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const { center: boxCenter, halfExtents } = regionBoundingBox(vertices, n, initialScale);

  // the initial localizing set: the same inflated bounding box the ellipsoid
  // method circumscribes, kept as a box here
  const minX = boxCenter[0]! - halfExtents[0]!;
  const maxX = boxCenter[0]! + halfExtents[0]!;
  const minY = boxCenter[1]! - halfExtents[1]!;
  const maxY = boxCenter[1]! + halfExtents[1]!;
  const localizing: number[][] = [
    [1, 0, maxX],
    [-1, 0, -minX],
    [0, 1, maxY],
    [0, -1, -minY],
  ];
  const boxRowCount = localizing.length;
  const boxPolygon = [minX, minY, maxX, minY, maxX, maxY, minX, maxY];
  const polygons: number[][] = [];
  const trace = newTrace(maxit, polygons);
  const { iterations, rows, rho, ellipsoids } = trace;

  const incumbent = new Incumbent(A, b, c, rayShoot, c[0]! * c[0]! + c[1]! * c[1]!);
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  while (iterations.length < maxit) {
    const query = computeQueryPoint(queryPoint, localizing);
    if (!query) {
      termination = "exhausted";
      break;
    }
    const point = query.point;

    if (queryPoint === "volumetric" && query.leverage) {
      dropRedundantCuts(localizing, boxRowCount, query.leverage);
    }

    const objectiveValue = c[0]! * point[0]! + c[1]! * point[1]!;
    const { row: worstRow, violation } = mostViolatedConstraint(A, b, point);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible) incumbent.offer(point, objectiveValue);

    // rho keeps the meaning it has for the ellipsoid method: how much better
    // than the query point anything still under consideration could be
    const bound = solveSmallLp([c[0]!, c[1]!], localizing, LP_BOUND);
    if (bound.status === "infeasible") {
      termination = "exhausted";
      break;
    }
    upperBound = bound.value;
    const objectiveRadius = Math.max(0, bound.value - objectiveValue);

    // the localizing set as it stood when this point was queried: the box, cut
    // by everything learned so far
    let polygon = boxPolygon;
    for (let i = boxRowCount; i < localizing.length; i++) {
      const cut = localizing[i]!;
      polygon = clipPolygon(polygon, cut[0]!, cut[1]!, cut[2]!);
      if (polygon.length === 0) break;
    }
    polygons.push(polygon === boxPolygon ? [...boxPolygon] : polygon);

    recordIterate(trace, point, query.p11, query.p12, query.p22, objectiveValue, Math.max(0, violation), objectiveRadius);

    if (feasible && incumbent.certifies(upperBound, tol)) {
      termination = "converged";
      break;
    }

    if (!feasible) {
      // the violated constraint itself, which is as deep a cut as the oracle
      // can return
      localizing.push([A.data[worstRow * n]!, A.data[worstRow * n + 1]!, b[worstRow]!]);
    } else {
      // discard everything no better than the incumbent
      localizing.push([-c[0]!, -c[1]!, -incumbent.objective]);
    }
  }

  // Both of these are claims of optimality, and both are wrong when the
  // objective is unbounded: nothing but the initial box stopped the method.
  if ((termination === "converged" || termination === "exhausted") && incumbent.objective > -Infinity && objectiveIsUnbounded(A, c)) {
    termination = "unbounded";
  }

  const footer = buildFooter(termination, iterations.length, performance.now() - startTime, {
    exhausted: incumbent.objective === -Infinity ? ["No feasible point inside the initial box"] : ["Localizing set exhausted", "Nothing better than the incumbent remains, so it is optimal"],
    unbounded: ["Stopped on the initial box boundary", "The objective is unbounded over this region: the method only searches inside the initial box"],
  });
  appendIncumbent(trace, incumbent, upperBound);

  return {
    iterations,
    ellipsoids: ellipsoids.slice(0, iterations.length * ELLIPSOID_STRIDE),
    ...packPolygons(polygons),
    rho,
    header: ELLIPSOID_HEADER,
    rows,
    footer,
  };
}

/**
 * Whether `max c'x` over `Ax <= b` is unbounded: some recession direction `d` (`Ad <= 0`) has
 * `c'd > 0`, one small LP over the recession cone clipped to the unit box. The ellipsoid method's
 * boundary test does not transfer: the query points here are strictly interior, and a *bounded*
 * objective whose optimal face is a ray also runs into the box, so position cannot tell the two apart.
 */
function objectiveIsUnbounded(A: { rows: number; cols: number; data: Float64Array }, c: Float64Array): boolean {
  const cone: LpRow[] = [];
  for (let i = 0; i < A.rows; i++) {
    cone.push([A.data[i * A.cols]!, A.data[i * A.cols + 1]!, 0]);
  }
  const best = solveSmallLp([c[0]!, c[1]!], cone, 1);
  return best.status === "optimal" && best.value > RECESSION_TOLERANCE * Math.hypot(c[0]!, c[1]!);
}

function computeQueryPoint(kind: QueryPoint, rows: LpRow[]): QueryResult | null {
  const ball = chebyshevCenter(rows, 2, LP_BOUND);
  if (!ball || !(ball.radius > MIN_CHEBYSHEV_RADIUS)) return null;
  if (!Number.isFinite(ball.center[0]!) || !Number.isFinite(ball.center[1]!)) {
    return null;
  }

  if (kind === "chebyshev") {
    const radiusSquared = ball.radius * ball.radius;
    return {
      point: ball.center,
      p11: radiusSquared,
      p12: 0,
      p22: radiusSquared,
      leverage: null,
    };
  }

  // the inscribed ball's center is strictly interior, which is exactly what
  // both barriers need to start from — no cut-restoration step required
  const center = barrierCenter(rows, ball.center, kind === "volumetric");
  if (!center) return null;

  const hessian = barrierHessian(rows, center, kind === "volumetric");
  if (!hessian) return null;
  const inverse = invertSymmetric2(hessian.h11, hessian.h12, hessian.h22);
  if (!inverse) return null;

  return {
    point: center,
    p11: inverse.a11,
    p12: inverse.a12,
    p22: inverse.a22,
    leverage: hessian.leverage,
  };
}

function slacksOf(rows: LpRow[], x: Float64Array): Float64Array | null {
  const slacks = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const slack = row[2]! - row[0]! * x[0]! - row[1]! * x[1]!;
    if (!(slack > MIN_SLACK)) return null;
    slacks[i] = slack;
  }
  return slacks;
}

// -sum log(slack), the analytic center's objective
function logBarrier(rows: LpRow[], x: Float64Array): number {
  const slacks = slacksOf(rows, x);
  if (!slacks) return Infinity;
  let value = 0;
  for (let i = 0; i < slacks.length; i++) value -= Math.log(slacks[i]!);
  return value;
}

// sum_i w_i a_i a_i' as its three distinct entries
function weightedGram(rows: LpRow[], weight: (i: number) => number) {
  let h11 = 0;
  let h12 = 0;
  let h22 = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const w = weight(i);
    h11 += row[0]! * row[0]! * w;
    h12 += row[0]! * row[1]! * w;
    h22 += row[1]! * row[1]! * w;
  }
  return { h11, h12, h22 };
}

// H(x) = sum a_i a_i' / s_i^2
const barrierGram = (rows: LpRow[], slacks: Float64Array) => weightedGram(rows, (i) => 1 / (slacks[i]! * slacks[i]!));

// ½ log det H(x), Vaidya's volumetric barrier
function volumetricBarrier(rows: LpRow[], x: Float64Array): number {
  const slacks = slacksOf(rows, x);
  if (!slacks) return Infinity;
  const { h11, h12, h22 } = barrierGram(rows, slacks);
  const determinant = h11 * h22 - h12 * h12;
  return determinant > 0 ? 0.5 * Math.log(determinant) : Infinity;
}

// H(x), plus (for Vaidya) each face's leverage score
// sigma_i = a_i' H^-1 a_i / s_i^2 and the leverage-weighted matrix Q that
// stands in for the volumetric barrier's Hessian.
function barrierHessian(rows: LpRow[], x: Float64Array, weighted: boolean) {
  const slacks = slacksOf(rows, x);
  if (!slacks) return null;

  const { h11, h12, h22 } = barrierGram(rows, slacks);
  const inverse = invertSymmetric2(h11, h12, h22);
  if (!inverse) return null;

  const leverage = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const quadratic = inverse.a11 * row[0]! * row[0]! + 2 * inverse.a12 * row[0]! * row[1]! + inverse.a22 * row[1]! * row[1]!;
    leverage[i] = quadratic / (slacks[i]! * slacks[i]!);
  }
  if (!weighted) return { h11, h12, h22, leverage, slacks };
  return { ...weightedGram(rows, (i) => leverage[i]! / (slacks[i]! * slacks[i]!)), leverage, slacks };
}

function invertSymmetric2(a11: number, a12: number, a22: number) {
  const determinant = a11 * a22 - a12 * a12;
  if (!(determinant > 0) || !Number.isFinite(determinant)) return null;
  return {
    a11: a22 / determinant,
    a12: -a12 / determinant,
    a22: a11 / determinant,
  };
}

// Damped Newton on a self-concordant barrier: full steps once the Newton
// decrement is small, backtracking before that (and always far enough to stay
// strictly inside, which the barrier's +Infinity outside enforces on its own).
function minimizeBarrier(
  start: Float64Array,
  gradientAndStep: (x: Float64Array) => { g0: number; g1: number; d0: number; d1: number } | null,
  value: (x: Float64Array) => number,
): Float64Array | null {
  const x = start.slice();
  const candidate = new Float64Array(2);
  let current = value(x);
  if (!Number.isFinite(current)) return null;

  for (let step = 0; step < MAX_NEWTON_STEPS; step++) {
    const direction = gradientAndStep(x);
    if (!direction) return null;
    const decrementSquared = -(direction.g0 * direction.d0 + direction.g1 * direction.d1);
    if (!(decrementSquared > NEWTON_DECREMENT_TOLERANCE)) break;
    const decrement = Math.sqrt(decrementSquared);

    let t = decrement > DAMPED_NEWTON_THRESHOLD ? 1 / (1 + decrement) : 1;
    let accepted = false;
    for (let attempt = 0; attempt < MAX_BACKTRACKS; attempt++) {
      candidate[0] = x[0]! + t * direction.d0;
      candidate[1] = x[1]! + t * direction.d1;
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
function barrierCenter(rows: LpRow[], start: Float64Array, volumetric: boolean) {
  return minimizeBarrier(
    start,
    (x) => {
      const hessian = barrierHessian(rows, x, volumetric);
      if (!hessian) return null;
      const inverse = invertSymmetric2(hessian.h11, hessian.h12, hessian.h22);
      if (!inverse) return null;
      let g0 = 0;
      let g1 = 0;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const weight = volumetric ? hessian.leverage[i]! / hessian.slacks[i]! : 1 / hessian.slacks[i]!;
        g0 += row[0]! * weight;
        g1 += row[1]! * weight;
      }
      return {
        g0,
        g1,
        d0: -(inverse.a11 * g0 + inverse.a12 * g1),
        d1: -(inverse.a12 * g0 + inverse.a22 * g1),
      };
    },
    (x) => (volumetric ? volumetricBarrier(rows, x) : logBarrier(rows, x)),
  );
}

// Never drops the initial box, which is what keeps the localizing set bounded.
function dropRedundantCuts(rows: number[][], boxRowCount: number, leverage: Float64Array): void {
  if (rows.length !== leverage.length) return;
  for (let i = rows.length - 1; i >= boxRowCount; i--) {
    if (leverage[i]! < VAIDYA_DROP_LEVERAGE) rows.splice(i, 1);
  }
}
