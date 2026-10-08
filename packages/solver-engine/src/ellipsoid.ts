import { type DenseMatrix, dot, denseFromConstraints } from "@lpviz/math/blas";
import type { Constraint, Vec } from "@lpviz/math/types";
import { numericLogHeader } from "./fmt";
import type { NumericRow, SolverResult } from "./result";
import { assertMaxit, solveFooter } from "./time";

// initial half-extent when there are no vertices to bound the region (the app always has some)
const FALLBACK_HALF_EXTENT = 100;
// A flat bounding box (vertical/horizontal sliver) would otherwise seed an
// ellipsoid with a near-zero axis, which the shape matrix cannot recover from.
const MIN_RELATIVE_HALF_EXTENT = 1e-3;
const MIN_HALF_EXTENT = 1e-9;
export const FEASIBILITY_TOLERANCE = 1e-9;
// below this the objective is parallel to the face and never blocks the ray
const RAY_BLOCKING_TOLERANCE = 1e-12;
// closer than this to the last iterate, the incumbent is that iterate
const INCUMBENT_MERGE_TOLERANCE = 1e-9;
// Per iteration: the center c (n values) followed by the upper triangle of the symmetric shape
// matrix P of E = { x : (x - c)' P^-1 (x - c) <= 1 }, row by row — [cx, cy, p11, p12, p22] for two
// variables (stride 5) and [cx, cy, cz, p11, p12, p13, p22, p23, p33] for three (stride 9).
export function ellipsoidStride(n: number): number {
  return n + (n * (n + 1)) / 2;
}

// The cutting planes' localizing set per iteration: a closed polygon's [x, y] vertices for two
// variables, the half-spaces [a1..an, b] of the polyhedron otherwise.
export function localizingSetStride(n: number): number {
  return n === 2 ? 2 : n + 1;
}

// Write one packed ellipsoid at `base` (see ellipsoidStride for the layout).
function writeEllipsoid(out: Float64Array, base: number, center: Float64Array, P: Float64Array, n: number): void {
  for (let j = 0; j < n; j++) out[base + j] = center[j]!;
  let at = base + n;
  for (let j = 0; j < n; j++) {
    for (let k = j; k < n; k++) out[at++] = P[j * n + k]!;
  }
}

interface EllipsoidOptions {
  maxit: number;
  tol: number;
  deepCuts: boolean;
  rayShoot: boolean;
  initialScale: number;
}

export const ellipsoidLogHeader = (n: number) => numericLogHeader(n, "ρ");

// Everything a run records per iterate, in lockstep; polygons only for the cutting planes.
type IterateTrace = {
  n: number;
  stride: number;
  iterations: Float64Array[];
  rows: NumericRow[];
  rho: number[];
  ellipsoids: Float64Array;
  polygons?: number[][] | undefined;
};

export function newTrace(maxit: number, n: number, polygons?: number[][]): IterateTrace {
  const stride = ellipsoidStride(n);
  // one ellipse slot spare for the incumbent appended at the end
  return { n, stride, iterations: [], rows: [], rho: [], ellipsoids: new Float64Array((maxit + 1) * stride), polygons };
}

/** Record the point `x` with the n x n shape matrix `P` drawn around it. */
export function recordIterate(trace: IterateTrace, x: Float64Array, P: Float64Array, objective: number, infeasibility: number, objectiveRadius: number): void {
  const { iterations, ellipsoids, n, stride } = trace;
  writeEllipsoid(ellipsoids, iterations.length * stride, x, P, n);
  const point = x.slice();
  trace.rows.push({ iteration: iterations.length + 1, point, objective, infeasibility, convergence: objectiveRadius });
  trace.rho.push(objectiveRadius);
  iterations.push(point);
}

/**
 * The best feasible point found so far. With the ray shoot, a feasible query point first slides
 * along the objective until a constraint blocks it, and that boundary point is the one adopted.
 */
export class Incumbent {
  readonly point: Float64Array;
  objective = -Infinity;

  constructor(
    private readonly A: DenseMatrix,
    private readonly b: Float64Array,
    private readonly c: Float64Array,
    private readonly rayShoot: boolean,
    private readonly objectiveNormSquared: number,
  ) {
    this.point = new Float64Array(c.length);
  }

  /** Offer a feasible `x` whose objective value is `objectiveValue`. */
  offer(x: Float64Array, objectiveValue: number): void {
    if (objectiveValue > this.objective) {
      this.objective = objectiveValue;
      this.point.set(x);
    }
    if (!this.rayShoot) return;
    const { A, b, c } = this;
    const step = objectiveRayStep(A, b, x, c, c.length);
    const shotObjective = objectiveValue + step * this.objectiveNormSquared;
    if (shotObjective > this.objective) {
      this.objective = shotObjective;
      for (let j = 0; j < c.length; j++) this.point[j] = x[j]! + step * c[j]!;
    }
  }

  /**
   * `upperBound` (the best value the localizing set can still hold) and the
   * incumbent bracket the optimum, so their difference is the true optimality
   * gap; the incumbent is certified once it closes to `tol`.
   */
  certifies(upperBound: number, tol: number): boolean {
    return this.objective > -Infinity && upperBound - this.objective <= tol * (1 + Math.abs(this.objective));
  }
}

// Flatten per-iteration localizing sets (each a flat list of `stride`-wide entries) into the
// result's transferable polygonPoints/polygonOffsets pair.
export function packPolygons(polygons: readonly (readonly number[])[], stride: number) {
  const total = polygons.reduce((sum, polygon) => sum + polygon.length, 0);
  const polygonPoints = new Float64Array(total);
  const polygonOffsets = new Uint32Array(polygons.length + 1);
  let at = 0;
  polygons.forEach((polygon, index) => {
    polygonOffsets[index] = at / stride;
    polygonPoints.set(polygon, at);
    at += polygon.length;
  });
  polygonOffsets[polygons.length] = at / stride;
  return { polygonPoints, polygonOffsets };
}

/** Sutherland-Hodgman clip of a convex polygon against `a'x <= b`. */
export function clipPolygon(polygon: readonly number[], a0: number, a1: number, b: number): number[] {
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

// "infeasible" is the ellipsoid method's empty localizing set, "exhausted" the cutting planes'.
export type Termination = "converged" | "maxit" | "infeasible" | "exhausted" | "degenerate" | "unbounded";

// The initial ellipsoid must strictly contain the drawn region: every extreme point of the
// region is a drawn vertex, hence strictly inside, so a converged point *on* the boundary was
// stopped by the ellipsoid rather than by a constraint, i.e. the objective is unbounded.
const MIN_INITIAL_SCALE = 1.05;
const INITIAL_BOUNDARY_TOLERANCE = 1e-3;

/**
 * The ellipsoid method on `max objective'x s.t. Ax <= b`, sliding-objective variant: an infeasible
 * center is cut with the most violated row, a feasible one with the objective. Deep cuts push the
 * plane to the constraint / incumbent level; the ray shoot slides a feasible center along the
 * objective to the blocking constraint before adopting it as the incumbent.
 *
 * `rho = sqrt(objective' P objective)` is the ellipsoid's half-width along the objective, so
 * `objective'c + rho` upper-bounds the optimum while the incumbent lower-bounds it; that gap is
 * the stopping measure and the vertical lift of the 3D iterate path.
 */
export function ellipsoid(vertices: Vec[], constraints: Constraint[], objective: Float64Array, opts: EllipsoidOptions): SolverResult {
  const { maxit, tol, deepCuts, rayShoot, initialScale } = opts;

  assertMaxit(maxit);

  const { A, b } = denseFromConstraints(constraints);
  const n = A.cols;
  if (n < 2) {
    throw new Error("The ellipsoid method requires at least two variables.");
  }

  const c = Float64Array.from({ length: n }, (_, j) => objective[j] ?? 0);
  const { center, P } = initialEllipsoid(vertices, n, initialScale);
  const initialCenter = center.slice();
  const initialSemiAxes = Float64Array.from({ length: n }, (_, j) => Math.sqrt(P[j * n + j]!));

  const trace = newTrace(maxit, n);
  const { iterations, rows, rho, ellipsoids, stride } = trace;
  const g = new Float64Array(n);
  const Pg = new Float64Array(n);
  const nextP = new Float64Array(n * n);

  const incumbent = new Incumbent(A, b, c, rayShoot, dot(c, c));
  let upperBound = Infinity;
  let termination: Termination = "maxit";
  const startTime = performance.now();

  while (iterations.length < maxit) {
    const objectiveValue = dot(c, center);
    const { row: worstRow, violation } = mostViolatedConstraint(A, b, center);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible) incumbent.offer(center, objectiveValue);

    const objectiveRadius = Math.sqrt(Math.max(0, quadraticForm(P, c, n)));
    upperBound = objectiveValue + objectiveRadius;
    recordIterate(trace, center, P, objectiveValue, Math.max(0, violation), objectiveRadius);

    // Feasibility of the center is still required so that the last iterate the
    // viewport marks as the answer is a point of the region.
    if (feasible && incumbent.certifies(upperBound, tol)) {
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
      beta = incumbent.objective - objectiveValue;
    }

    const gPg = symmetricMatVec(P, g, Pg, n);
    if (!(gPg > 0) || !Number.isFinite(gPg)) {
      termination = "degenerate";
      break;
    }

    const alpha = deepCuts ? beta / Math.sqrt(gPg) : 0;
    if (alpha >= 1) {
      // the half-space misses the ellipsoid: nothing feasible and better than the incumbent is left
      termination = "infeasible";
      break;
    }

    const tau = (1 + n * alpha) / (n + 1);
    const delta = ((n * n) / (n * n - 1)) * (1 - alpha * alpha);
    const sigma = (2 * (1 + n * alpha)) / ((n + 1) * (1 + alpha));
    const invGPg = 1 / gPg;
    const step = tau / Math.sqrt(gPg);

    for (let j = 0; j < n; j++) center[j]! -= step * Pg[j]!;
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
  if (termination === "converged" && onInitialBoundary(center, initialCenter, initialSemiAxes, n)) {
    termination = "unbounded";
  }

  const footer = buildFooter(termination, iterations.length, performance.now() - startTime, {
    infeasible: [incumbent.objective === -Infinity ? "No feasible point inside the initial ellipsoid" : "Cut away the last of the ellipsoid"],
    degenerate: ["Ellipsoid degenerated numerically"],
    unbounded: ["Stopped on the initial ellipsoid boundary", "The objective is unbounded over this region: the method only searches inside the initial ellipsoid"],
  });
  appendIncumbent(trace, incumbent, upperBound);

  return {
    iterations,
    convergence: rho,
    // sliced, not a subarray: the packed response transfers this buffer, and a
    // view would drag the whole maxit-sized allocation across with it
    ellipsoids: ellipsoids.slice(0, iterations.length * stride),
    // the ellipsoid *is* this method's localizing set, so there is no separate
    // polyhedron to draw; fresh (never shared) buffers, since the main thread
    // detaches what it receives
    ...packPolygons([], localizingSetStride(n)),
    log: [{ header: ellipsoidLogHeader(n), rows, footer }],
  };
}

// the initial ellipsoid is axis-aligned, so its quadratic form is a sum of squares over the semi-axes
function onInitialBoundary(x: Float64Array, center: Float64Array, semiAxes: Float64Array, n: number) {
  let quadratic = 0;
  for (let j = 0; j < n; j++) {
    const ratio = (x[j]! - center[j]!) / semiAxes[j]!;
    quadratic += ratio * ratio;
  }
  return quadratic >= 1 - INITIAL_BOUNDARY_TOLERANCE;
}

/**
 * The drawn region's bounding box, inflated by `scale`: the ellipsoid method circumscribes it, the
 * cutting-plane methods take the box itself as their initial localizing set.
 */
export function regionBoundingBox(vertices: Vec[], n: number, scale: number) {
  const center = new Float64Array(n);
  const halfExtents = new Float64Array(n).fill(FALLBACK_HALF_EXTENT);
  const inflation = Math.max(MIN_INITIAL_SCALE, scale);

  if (vertices.length > 0) {
    // axes the vertices actually span; any further axis (a 3-variable LP fed
    // planar vertices) gets the largest spanned extent instead
    const planar = Math.min(n, vertices[0]!.length);
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
function initialEllipsoid(vertices: Vec[], n: number, scale: number) {
  const { center, halfExtents } = regionBoundingBox(vertices, n, scale);
  const P = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    const semiAxis = Math.sqrt(n) * halfExtents[j]!;
    P[j * n + j] = semiAxis * semiAxis;
  }
  return { center, P };
}

/**
 * Close a run by recording the incumbent as its final iterate: the best feasible point is not in
 * general the last one queried (an exhausted localizing set, a ray-shot incumbent), and the
 * viewport's star and the log's last row must mark the answer. The appended entry reuses the
 * previous iterate's ellipse, so the drawn localization stays put while the path steps to it.
 */
export function appendIncumbent(result: IterateTrace, incumbent: Incumbent, upperBound: number): void {
  const { point: best, objective: bestObjective } = incumbent;
  if (bestObjective === -Infinity) return;
  const { stride } = result;
  const count = result.iterations.length;
  const previous = count > 0 ? result.iterations[count - 1]! : null;
  if (previous && best.every((value, j) => Math.abs(previous[j]! - value) < INCUMBENT_MERGE_TOLERANCE)) {
    return;
  }

  const base = count * stride;
  if (base + stride > result.ellipsoids.length) return;
  if (count > 0) {
    result.ellipsoids.copyWithin(base, base - stride, base);
    if (result.polygons && result.polygons.length === count) {
      result.polygons.push([...result.polygons[count - 1]!]);
    }
  }
  const point = best.slice();
  result.iterations.push(point);
  const gap = Math.max(0, upperBound - bestObjective);
  result.rho.push(gap);
  result.rows.push({ iteration: count + 1, point, objective: bestObjective, infeasibility: 0, convergence: gap });
}

// The separation oracle every method in this family shares: the constraint
// `x` violates by the most, or a nonpositive violation when `x` is feasible.
export function mostViolatedConstraint(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, x: Float64Array) {
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

// max t with A(x + t*c) <= b: how far a feasible point can slide along the objective. Zero when
// nothing blocks at all (not infinity): an unbounded direction has no boundary point to adopt.
function objectiveRayStep(A: { rows: number; cols: number; data: Float64Array }, b: Float64Array, x: Float64Array, c: Float64Array, n: number) {
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

// out = P v, returning v'Pv
function symmetricMatVec(P: Float64Array, v: Float64Array, out: Float64Array, n: number) {
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

// "converged" and "maxit" read the same for every method in the family; the
// other stops name the method's localizing set, as `[lead, explanation?]` constraints.
export function buildFooter(termination: Termination, iterationCount: number, solveTime: number, stops: Partial<Record<Termination, [lead: string, explanation?: string]>>) {
  const [lead, explanation] = stops[termination] ?? ["Did not converge"];
  return `${solveFooter(termination === "converged", iterationCount, solveTime, lead)}\n${explanation ? `${explanation}\n` : ""}`;
}
