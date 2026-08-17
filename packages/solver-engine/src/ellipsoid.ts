import { linesToDenseAb } from "@lpviz/math/blas";
import type { Lines, VecN, Vertices } from "@lpviz/math/types";
import { formatMilliseconds } from "./time";

const MAX_ITERATIONS_LIMIT = 100_000;
// Half-extent used for the initial ellipsoid when the caller has no vertices to
// bound the region with (the app always has some; this is the safety net).
const FALLBACK_HALF_EXTENT = 100;
// A flat bounding box (vertical/horizontal sliver) would otherwise seed an
// ellipsoid with a near-zero axis, which the shape matrix cannot recover from.
const MIN_RELATIVE_HALF_EXTENT = 1e-3;
const MIN_HALF_EXTENT = 1e-9;
const FEASIBILITY_TOLERANCE = 1e-9;
// below this the objective is parallel to the face and never blocks the ray
const RAY_BLOCKING_TOLERANCE = 1e-12;
// closer than this to the last iterate, the incumbent is that iterate
const INCUMBENT_MERGE_TOLERANCE = 1e-9;
// [cx, cy, p11, p12, p22] per iteration: the center and the symmetric shape
// matrix P of E = { x : (x - c)' P^-1 (x - c) <= 1 }. lpviz LPs have n = 2, so
// this is the ellipse itself; for n > 2 it is the (x, y) block of P.
export const ELLIPSOID_STRIDE = 5;

export interface EllipsoidRow {
  kind: "ellipsoid";
  iteration: number;
  x: number;
  y: number;
  objective: number;
  infeasibility: number;
  rho: number;
}

interface EllipsoidOptions {
  maxit: number;
  tol: number;
  deepCuts: boolean;
  rayShoot: boolean;
  initialScale: number;
  verbose: boolean;
}

export interface EllipsoidResultData {
  iterations: Float64Array[];
  ellipsoids: Float64Array;
  // The localizing set per iteration, as a closed polygon: [x, y] pairs for
  // iterate `i` live at `polygonPoints[polygonOffsets[i] * 2 ...
  // polygonOffsets[i + 1] * 2)`. Empty for the ellipsoid method, whose
  // localizing set *is* the drawn ellipsoid; the cutting-plane methods emit the
  // polyhedron of accumulated cuts, which the ellipse alone cannot show.
  polygonPoints: Float64Array;
  polygonOffsets: Uint32Array;
  rho: number[];
  header: string;
  rows: EllipsoidRow[];
  footer: string;
}

// A factory, never a shared constant: these buffers are transferred to the main
// thread, which detaches them. Handing out the same instance twice means the
// second solve reads a detached ArrayBuffer and the whole result fails.
export const emptyPolygons = () => ({
  polygonPoints: new Float64Array(0),
  polygonOffsets: new Uint32Array(1),
});

// Flatten per-iteration polygons into the transferable pair above.
export function packPolygons(polygons: readonly (readonly number[])[]) {
  const total = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
  const polygonPoints = new Float64Array(total);
  const polygonOffsets = new Uint32Array(polygons.length + 1);
  let at = 0;
  polygons.forEach((polygon, index) => {
    polygonOffsets[index] = at / 2;
    polygonPoints.set(polygon, at);
    at += polygon.length;
  });
  polygonOffsets[polygons.length] = at / 2;
  return { polygonPoints, polygonOffsets };
}

/**
 * Sutherland-Hodgman clip of a convex polygon against `a'x <= b`. The
 * localizing set is an intersection of half-planes, so clipping the initial box
 * by each cut in turn is the whole construction.
 */
export function clipPolygon(
  polygon: readonly number[],
  a0: number,
  a1: number,
  b: number,
): number[] {
  const out: number[] = [];
  const count = polygon.length / 2;
  if (count === 0) return out;
  for (let i = 0; i < count; i++) {
    const x0 = polygon[i * 2]!;
    const y0 = polygon[i * 2 + 1]!;
    const next = (i + 1) % count;
    const x1 = polygon[next * 2]!;
    const y1 = polygon[next * 2 + 1]!;
    const d0 = a0 * x0 + a1 * y0 - b;
    const d1 = a0 * x1 + a1 * y1 - b;
    if (d0 <= 0) out.push(x0, y0);
    if ((d0 < 0 && d1 > 0) || (d0 > 0 && d1 < 0)) {
      const t = d0 / (d0 - d1);
      out.push(x0 + t * (x1 - x0), y0 + t * (y1 - y0));
    }
  }
  return out;
}

type Termination =
  | "converged"
  | "maxit"
  | "infeasible"
  | "degenerate"
  | "unbounded";

// The initial ellipsoid must strictly contain the drawn region: that is what
// makes the method's guarantee hold, and it is what makes the test below
// unambiguous. Every extreme point of the region — bounded or not — is a drawn
// vertex, hence strictly inside; so a converged point *on* the boundary was
// stopped by the ellipsoid rather than by the constraints, which means the
// objective is unbounded over the region.
const MIN_INITIAL_SCALE = 1.05;
const INITIAL_BOUNDARY_TOLERANCE = 1e-3;

/**
 * The ellipsoid method on `max objective'x s.t. Ax <= b`.
 *
 * Each iteration keeps an ellipsoid E_k that is guaranteed to contain every
 * feasible point at least as good as the best one found so far, and shrinks it
 * with one cutting plane through (or past) its center:
 *
 *   - center infeasible -> cut with the most violated constraint row;
 *   - center feasible   -> cut with the objective, which discards every point
 *                          no better than the incumbent (the "sliding
 *                          objective" variant).
 *
 * With deep cuts the plane is pushed to the constraint / incumbent level
 * instead of passing through the center, which is strictly more aggressive and
 * never loses a feasible point.
 *
 * With the ray shoot, a feasible center first slides along the objective until
 * a constraint blocks it, and that boundary point becomes the incumbent. The
 * cut stays valid — the shot point is feasible, so nothing at least as good as
 * it can be optimal-and-discarded — but it now bites deep instead of passing
 * through the center. It is worth 1.7-2.4x on the regions in the gallery, since
 * cut depth compounds where the initial ellipsoid's size only enters
 * logarithmically.
 *
 * `rho = sqrt(objective' P objective)` is the ellipsoid's half-width along the
 * objective, i.e. how much objective value could still be hiding inside it, so
 * it doubles as the reported convergence measure and as the vertical lift of
 * the 3D iterate path. Termination uses the sharper certificate rho makes
 * available: `objective'c + rho` upper-bounds the optimum (the ellipsoid
 * contains it) while the incumbent lower-bounds it, so the two bracket the true
 * optimality gap. That gap is never larger than rho and closes sooner.
 */
export function ellipsoid(
  vertices: Vertices,
  lines: Lines,
  objective: VecN,
  opts: EllipsoidOptions,
): EllipsoidResultData {
  const {
    maxit,
    tol,
    deepCuts,
    rayShoot,
    initialScale,
    verbose,
  } = opts;

  if (maxit > MAX_ITERATIONS_LIMIT) {
    throw new Error(`maxit > ${MAX_ITERATIONS_LIMIT} not allowed`);
  }

  const { A, b } = linesToDenseAb(lines);
  const n = A.cols;
  if (n < 2) {
    throw new Error("The ellipsoid method requires at least two variables.");
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const objectiveNormSquared = dotSlice(c, c);
  const { center, P } = initialEllipsoid(vertices, n, initialScale);
  const initialCenter = center.slice();
  const initialSemiAxes = Float64Array.from({ length: n }, (_, j) =>
    Math.sqrt(P[j * n + j]!),
  );

  const iterations: Float64Array[] = [];
  const rows: EllipsoidRow[] = [];
  const rho: number[] = [];
  // one slot spare for the incumbent appended at the end
  const ellipsoids = new Float64Array((maxit + 1) * ELLIPSOID_STRIDE);

  const g = new Float64Array(n);
  const Pg = new Float64Array(n);
  const nextP = new Float64Array(n * n);

  const best = new Float64Array(n);
  let bestObjective = -Infinity;
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  const header = " Iter        x        y        Obj     Infeas          ρ";
  if (verbose) console.log(header);

  const record = (
    objectiveValue: number,
    infeasibility: number,
    objectiveRadius: number,
  ) => {
    const base = iterations.length * ELLIPSOID_STRIDE;
    ellipsoids[base] = center[0]!;
    ellipsoids[base + 1] = center[1]!;
    ellipsoids[base + 2] = P[0]!;
    ellipsoids[base + 3] = P[1]!;
    ellipsoids[base + 4] = P[n + 1]!;

    const row: EllipsoidRow = {
      kind: "ellipsoid",
      iteration: iterations.length + 1,
      x: center[0]!,
      y: center[1]!,
      objective: objectiveValue,
      infeasibility,
      rho: objectiveRadius,
    };
    if (verbose) console.log(row);
    rows.push(row);
    rho.push(objectiveRadius);
    iterations.push(Float64Array.of(center[0]!, center[1]!));
  };

  while (iterations.length < maxit) {
    const objectiveValue = dotSlice(c, center);
    const { row: worstRow, violation } = mostViolatedConstraint(A, b, center);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible && objectiveValue > bestObjective) {
      bestObjective = objectiveValue;
      best.set(center);
    }
    if (feasible && rayShoot) {
      const step = objectiveRayStep(A, b, center, c, n);
      const shotObjective = objectiveValue + step * objectiveNormSquared;
      if (shotObjective > bestObjective) {
        bestObjective = shotObjective;
        for (let j = 0; j < n; j++) best[j] = center[j]! + step * c[j]!;
      }
    }

    const objectiveRadius = Math.sqrt(Math.max(0, quadraticForm(P, c, n)));
    upperBound = objectiveValue + objectiveRadius;
    record(objectiveValue, Math.max(0, violation), objectiveRadius);

    // `objectiveValue + objectiveRadius` bounds the optimum from above (the
    // ellipsoid still contains it) and the incumbent bounds it from below, so
    // their difference is the true optimality gap — never worse than rho alone.
    // Feasibility of the center is still required so that the last iterate the
    // viewport marks as the answer is a point of the region.
    const gap = objectiveValue + objectiveRadius - bestObjective;
    if (
      feasible &&
      bestObjective > -Infinity &&
      gap <= tol * (1 + Math.abs(bestObjective))
    ) {
      termination = "converged";
      break;
    }

    // cut normal g and its offset beta: keep { x : g'x <= g'center - beta }
    let beta: number;
    if (!feasible) {
      for (let j = 0; j < n; j++) g[j] = A.data[worstRow * n + j]!;
      beta = violation;
    } else {
      for (let j = 0; j < n; j++) g[j] = -c[j]!;
      // the incumbent can be better than this center's objective, in which case
      // the objective cut is itself a deep cut
      beta = bestObjective - objectiveValue;
    }

    const gPg = symmetricMatVec(P, g, Pg, n);
    if (!(gPg > 0) || !Number.isFinite(gPg)) {
      termination = "degenerate";
      break;
    }

    const alpha = deepCuts ? beta / Math.sqrt(gPg) : 0;
    if (alpha >= 1) {
      // the half-space misses the ellipsoid: nothing feasible (and no better
      // than the incumbent) is left inside it
      termination = "infeasible";
      break;
    }

    const tau = (1 + n * alpha) / (n + 1);
    const delta = ((n * n) / (n * n - 1)) * (1 - alpha * alpha);
    const sigma = (2 * (1 + n * alpha)) / ((n + 1) * (1 + alpha));
    const invGPg = 1 / gPg;
    const step = tau / Math.sqrt(gPg);

    for (let j = 0; j < n; j++) center[j] -= step * Pg[j]!;
    for (let j = 0; j < n; j++) {
      for (let k = j; k < n; k++) {
        const value = delta * (P[j * n + k]! - sigma * Pg[j]! * Pg[k]! * invGPg);
        nextP[j * n + k] = value;
        nextP[k * n + j] = value;
      }
    }
    P.set(nextP);

    if (!Number.isFinite(center[0]!) || !Number.isFinite(P[0]!)) {
      termination = "degenerate";
      break;
    }
  }

  // tested on the converged center, not on the incumbent: a ray shoot can adopt
  // a feasible point far outside the initial ellipsoid on an unbounded region
  // whose objective is nonetheless bounded, and that is not this condition
  if (
    termination === "converged" &&
    onInitialBoundary(center, initialCenter, initialSemiAxes, n)
  ) {
    termination = "unbounded";
  }

  const footer = buildFooter(
    termination,
    iterations.length,
    performance.now() - startTime,
    bestObjective,
  );
  if (verbose) console.log(footer);

  appendIncumbent(
    { iterations, rows, rho, ellipsoids },
    best,
    bestObjective,
    upperBound,
  );

  return {
    iterations,
    // sliced, not a subarray: the packed response transfers this buffer, and a
    // view would drag the whole maxit-sized allocation across with it
    ellipsoids: ellipsoids.slice(0, iterations.length * ELLIPSOID_STRIDE),
    // the ellipsoid *is* this method's localizing set, so there is no separate
    // polyhedron to draw
    ...emptyPolygons(),
    rho,
    header,
    rows,
    footer,
  };
}

// The initial ellipsoid is axis-aligned, so its defining quadratic form is just
// a sum of squares over the semi-axes.
function onInitialBoundary(
  x: Float64Array,
  center: Float64Array,
  semiAxes: Float64Array,
  n: number,
) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    const ratio = (x[j]! - center[j]!) / semiAxes[j]!;
    quadratic += ratio * ratio;
  }
  return quadratic >= 1 - INITIAL_BOUNDARY_TOLERANCE;
}

/**
 * The drawn region's bounding box, inflated by `scale`. Shared by every method
 * in this family so they all start from the same localization of the region:
 * the ellipsoid method circumscribes an ellipsoid around this box, the
 * cutting-plane methods take the box itself as their initial localizing set.
 */
export function regionBoundingBox(
  vertices: Vertices,
  n: number,
  scale: number,
) {
  const center = new Float64Array(n);
  const halfExtents = new Float64Array(n).fill(FALLBACK_HALF_EXTENT);
  const inflation = Math.max(MIN_INITIAL_SCALE, scale);

  if (vertices.length > 0) {
    const planar = Math.min(n, 2);
    for (let axis = 0; axis < planar; axis++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const vertex of vertices) {
        const value = vertex[axis] ?? 0;
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      center[axis] = (lo + hi) / 2;
      halfExtents[axis] = (hi - lo) / 2;
    }
    let largest = 0;
    for (let axis = 0; axis < planar; axis++) {
      largest = Math.max(largest, halfExtents[axis]!);
    }
    const floor = Math.max(largest * MIN_RELATIVE_HALF_EXTENT, MIN_HALF_EXTENT);
    for (let axis = 0; axis < planar; axis++) {
      halfExtents[axis] = Math.max(halfExtents[axis]!, floor);
    }
    for (let axis = planar; axis < n; axis++) {
      halfExtents[axis] = Math.max(largest, floor);
    }
  }

  for (let j = 0; j < n; j++) halfExtents[j] = halfExtents[j]! * inflation;
  return { center, halfExtents };
}

// The smallest axis-aligned ellipsoid around that box: semi-axis
// sqrt(n) * halfExtent puts every box corner exactly on the boundary.
function initialEllipsoid(vertices: Vertices, n: number, scale: number) {
  const { center, halfExtents } = regionBoundingBox(vertices, n, scale);
  const P = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const semiAxis = Math.sqrt(n) * halfExtents[j]!;
    P[j * n + j] = semiAxis * semiAxis;
  }
  return { center, P };
}

/**
 * Close a run by recording the incumbent as its final iterate.
 *
 * Every method here returns the best feasible point it found, which is not in
 * general the last point it queried: a cutting-plane method can exhaust its
 * localizing set while the last query point sits in the middle of it (and may
 * even be infeasible), and a ray shoot puts the incumbent on the boundary
 * rather than at any center. Without this the viewport's star and the log's
 * last row would mark a point that is not the answer.
 *
 * The appended entry reuses the previous iterate's ellipse, so the drawn
 * localization stays put while the path steps to the point being returned.
 */
export function appendIncumbent(
  result: {
    iterations: Float64Array[];
    rows: EllipsoidRow[];
    rho: number[];
    ellipsoids: Float64Array;
    polygons?: number[][];
  },
  best: Float64Array,
  bestObjective: number,
  upperBound: number,
): void {
  if (bestObjective === -Infinity) return;
  const count = result.iterations.length;
  const previous = count > 0 ? result.iterations[count - 1]! : null;
  if (
    previous &&
    Math.abs(previous[0]! - best[0]!) < INCUMBENT_MERGE_TOLERANCE &&
    Math.abs(previous[1]! - best[1]!) < INCUMBENT_MERGE_TOLERANCE
  ) {
    return;
  }

  const base = count * ELLIPSOID_STRIDE;
  if (base + ELLIPSOID_STRIDE > result.ellipsoids.length) return;
  if (count > 0) {
    result.ellipsoids.copyWithin(base, base - ELLIPSOID_STRIDE, base);
    // the localization stays where it was while the path steps to the answer
    if (result.polygons && result.polygons.length === count) {
      result.polygons.push([...result.polygons[count - 1]!]);
    }
  }
  result.iterations.push(Float64Array.of(best[0]!, best[1]!));
  const gap = Math.max(0, upperBound - bestObjective);
  result.rho.push(gap);
  result.rows.push({
    kind: "ellipsoid",
    iteration: count + 1,
    x: best[0]!,
    y: best[1]!,
    objective: bestObjective,
    infeasibility: 0,
    rho: gap,
  });
}

// The separation oracle every method in this family shares: the constraint
// `x` violates by the most, or a nonpositive violation when `x` is feasible.
export function mostViolatedConstraint(
  A: { rows: number; cols: number; data: Float64Array },
  b: Float64Array,
  x: Float64Array,
) {
  let row = 0;
  let violation = -Infinity;
  for (let i = 0; i < A.rows; i++) {
    const offset = i * A.cols;
    let value = -b[i]!;
    for (let j = 0; j < A.cols; j++) value += A.data[offset + j]! * x[j]!;
    if (value > violation) {
      violation = value;
      row = i;
    }
  }
  return { row, violation: A.rows === 0 ? 0 : violation };
}

// How far a feasible point can slide along the objective before a constraint
// blocks it: max t with A(x + t*c) <= b. Zero when the point is already on a
// blocking face, and zero (rather than infinity) when nothing blocks at all —
// an unbounded direction has no boundary point to adopt as an incumbent.
export function objectiveRayStep(
  A: { rows: number; cols: number; data: Float64Array },
  b: Float64Array,
  x: Float64Array,
  c: Float64Array,
  n: number,
) {
  let step = Infinity;
  for (let i = 0; i < A.rows; i++) {
    const offset = i * n;
    let along = 0;
    let at = 0;
    for (let j = 0; j < n; j++) {
      along += A.data[offset + j]! * c[j]!;
      at += A.data[offset + j]! * x[j]!;
    }
    if (along > RAY_BLOCKING_TOLERANCE) {
      step = Math.min(step, (b[i]! - at) / along);
    }
  }
  return Number.isFinite(step) && step > 0 ? step : 0;
}

function dotSlice(a: Float64Array, x: Float64Array) {
  let sum = 0;
  for (let j = 0; j < a.length; j++) sum += a[j]! * x[j]!;
  return sum;
}

// out = P v, returning v'Pv
function symmetricMatVec(
  P: Float64Array,
  v: Float64Array,
  out: Float64Array,
  n: number,
) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += P[j * n + k]! * v[k]!;
    out[j] = sum;
    quadratic += sum * v[j]!;
  }
  return quadratic;
}

function quadraticForm(P: Float64Array, v: Float64Array, n: number) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    for (let k = 0; k < n; k++) quadratic += P[j * n + k]! * v[j]! * v[k]!;
  }
  return quadratic;
}

function buildFooter(
  termination: Termination,
  iterationCount: number,
  solveTime: number,
  bestObjective: number,
) {
  const elapsed = formatMilliseconds(solveTime);
  switch (termination) {
    case "converged":
      return `Converged to optimal solution in ${elapsed} / ${iterationCount} iterations\n`;
    case "infeasible":
      return bestObjective === -Infinity
        ? `No feasible point inside the initial ellipsoid after ${iterationCount} iterations in ${elapsed}\n`
        : `Cut away the last of the ellipsoid after ${iterationCount} iterations in ${elapsed}\n`;
    case "degenerate":
      return `Ellipsoid degenerated numerically after ${iterationCount} iterations in ${elapsed}\n`;
    case "unbounded":
      return `Stopped on the initial ellipsoid boundary after ${iterationCount} iterations in ${elapsed}\nThe objective is unbounded over this region: the method only searches inside the initial ellipsoid\n`;
    default:
      return `Did not converge after ${iterationCount} iterations in ${elapsed}\n`;
  }
}
