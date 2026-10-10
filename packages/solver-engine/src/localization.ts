// What the ellipsoid method and the cutting-plane methods share: the dense problem, the
// separation oracle, the incumbent, the initial localization around the drawn region, the
// lockstep record of every iterate's drawn shape, the stopping test and the footer.

import { type DenseMatrix, denseFromConstraints, dot } from "@lpviz/math/blas";
import type { Constraint, Vec } from "@lpviz/math/types";
import { numericLogHeader, solveFooter } from "./fmt";
import { assertMaxit } from "./limits";
import { NumericTrace, type SolverResult } from "./result";

const FEASIBILITY_TOLERANCE = 1e-9;
// below this the objective is parallel to the face and never blocks the ray
const RAY_BLOCKING_TOLERANCE = 1e-12;
// closer than this to the last iterate, the incumbent is that iterate
const INCUMBENT_MERGE_TOLERANCE = 1e-9;
// initial half-extent when there are no vertices to bound the region (the app always has some)
const FALLBACK_HALF_EXTENT = 100;
// A flat bounding box (vertical/horizontal sliver) would otherwise seed an
// ellipsoid with a near-zero axis, which the shape matrix cannot recover from.
const MIN_RELATIVE_HALF_EXTENT = 1e-3;
const MIN_HALF_EXTENT = 1e-9;
// The initial localization must strictly contain the drawn region: every extreme point of the
// region is a drawn vertex, hence strictly inside, so a converged point *on* the boundary was
// stopped by the localization rather than by a constraint, i.e. the objective is unbounded.
const MIN_INITIAL_SCALE = 1.05;

// Per iteration: the center c (n values) followed by the upper triangle of the symmetric shape
// matrix P of E = { x : (x - c)' P^-1 (x - c) <= 1 }, row by row — [cx, cy, p11, p12, p22] for two
// variables (stride 5) and [cx, cy, cz, p11, p12, p13, p22, p23, p33] for three (stride 9).
export function ellipsoidStride(n: number): number {
  return n + (n * (n + 1)) / 2;
}

// The cutting planes' localizing set per iteration: a closed polygon's [x, y] vertices for two
// variables, the half-spaces [a1..an, b] of the polyhedron otherwise. The stride tells them apart.
export function localizingSetStride(n: number): number {
  return n === 2 ? 2 : n + 1;
}

const localizationLogHeader = (n: number) => numericLogHeader(n, "ρ");

// The separation oracle every method in this family shares: the constraint
// `x` violates by the most, or a nonpositive violation when `x` is feasible.
function mostViolatedConstraint(A: DenseMatrix, b: Float64Array, x: Float64Array) {
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
function objectiveRayStep(A: DenseMatrix, b: Float64Array, x: Float64Array, c: Float64Array) {
  const n = A.cols;
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

/**
 * The best feasible point found so far. With the ray shoot, a feasible query point first slides
 * along the objective until a constraint blocks it, and that boundary point is the one adopted.
 */
class Incumbent {
  readonly point: Float64Array;
  objective = -Infinity;
  private readonly objectiveNormSquared: number;

  constructor(
    private readonly A: DenseMatrix,
    private readonly b: Float64Array,
    private readonly c: Float64Array,
    private readonly rayShoot: boolean,
  ) {
    this.point = new Float64Array(c.length);
    this.objectiveNormSquared = dot(c, c);
  }

  get found(): boolean {
    return this.objective > -Infinity;
  }

  /** Offer a feasible `x` whose objective value is `objectiveValue`. */
  offer(x: Float64Array, objectiveValue: number): void {
    if (objectiveValue > this.objective) {
      this.objective = objectiveValue;
      this.point.set(x);
    }
    if (!this.rayShoot) return;
    const { A, b, c } = this;
    const step = objectiveRayStep(A, b, x, c);
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
    return this.found && upperBound - this.objective <= tol * (1 + Math.abs(this.objective));
  }
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

// "infeasible" is the ellipsoid method's empty localizing set, "exhausted" the cutting planes'.
type Termination = "converged" | "maxit" | "infeasible" | "exhausted" | "degenerate" | "unbounded";
// how the stops that are not "converged" or "maxit" read, as `[lead, explanation?]` lines
type TerminationLines = Partial<Record<Termination, [lead: string, explanation?: string]>>;

// "converged" and "maxit" read the same for every method in the family; the
// other stops name the method's localizing set.
function localizationFooter(termination: Termination, iterationCount: number, solveTime: number, stops: TerminationLines) {
  const [lead, explanation] = stops[termination] ?? ["Did not converge"];
  return `${solveFooter(termination === "converged", iterationCount, solveTime, lead)}\n${explanation ? `${explanation}\n` : ""}`;
}

/**
 * The family's run record: every iterate with the ellipsoid drawn around it (its n x n shape
 * matrix, packed per ellipsoidStride) and, for the cutting planes, the localizing set it was
 * queried from. `rho` is the convergence measure: how much better than the iterate anything still
 * under consideration could be.
 */
class LocalizationTrace extends NumericTrace {
  readonly stride: number;
  private readonly ellipsoids: Float64Array;
  private readonly localizingSets: number[][] | null;

  constructor(
    maxit: number,
    private readonly n: number,
    withLocalizingSets: boolean,
  ) {
    super();
    this.stride = ellipsoidStride(n);
    // one ellipsoid slot spare for the incumbent appended at the end
    this.ellipsoids = new Float64Array((maxit + 1) * this.stride);
    this.localizingSets = withLocalizingSets ? [] : null;
  }

  /** Record the point `x` with the shape matrix `P` drawn around it, queried from `localizingSet`. */
  recordIterate(x: Float64Array, P: Float64Array, objective: number, infeasibility: number, rho: number, localizingSet?: number[]): void {
    this.writeEllipsoid(this.count * this.stride, x, P);
    if (localizingSet) this.localizingSets?.push(localizingSet);
    this.record(x.slice(), objective, infeasibility, rho);
  }

  /**
   * Close the run by recording the incumbent as its final iterate: the best feasible point is not
   * in general the last one queried (an exhausted localizing set, a ray-shot incumbent), and the
   * viewport's star and the log's last row must mark the answer. The appended entry reuses the
   * previous iterate's ellipsoid and localizing set, so the drawn localization stays put while
   * the path steps to it.
   */
  closeOnIncumbent(incumbent: Incumbent, upperBound: number): void {
    if (!incumbent.found) return;
    const { point: best, objective: bestObjective } = incumbent;
    const previous = this.iterates[this.count - 1];
    if (previous && best.every((value, j) => Math.abs(previous[j]! - value) < INCUMBENT_MERGE_TOLERANCE)) {
      return;
    }
    if (previous) {
      const base = this.count * this.stride;
      this.ellipsoids.copyWithin(base, base - this.stride, base);
      this.localizingSets?.push([...this.localizingSets[this.count - 1]!]);
    }
    this.record(best.slice(), bestObjective, 0, Math.max(0, upperBound - bestObjective));
  }

  override result(header: string, footer: string): SolverResult {
    const extras: Partial<SolverResult> = {
      // sliced, not a subarray: the packed response transfers this buffer, and a
      // view would drag the whole maxit-sized allocation across with it
      ellipsoids: this.ellipsoids.slice(0, this.count * this.stride),
    };
    if (this.localizingSets) Object.assign(extras, packLocalizingSets(this.localizingSets, localizingSetStride(this.n)));
    return super.result(header, footer, extras);
  }

  private writeEllipsoid(base: number, center: Float64Array, P: Float64Array): void {
    const { n, ellipsoids } = this;
    for (let j = 0; j < n; j++) ellipsoids[base + j] = center[j]!;
    let at = base + n;
    for (let j = 0; j < n; j++) {
      for (let k = j; k < n; k++) ellipsoids[at++] = P[j * n + k]!;
    }
  }
}

// Flatten the per-iteration localizing sets (each a flat list of `stride`-wide entries) into the
// result's transferable points/offsets pair.
function packLocalizingSets(sets: readonly (readonly number[])[], stride: number): Pick<SolverResult, "localizingSetPoints" | "localizingSetOffsets"> {
  const total = sets.reduce((sum, set) => sum + set.length, 0);
  const localizingSetPoints = new Float64Array(total);
  const localizingSetOffsets = new Uint32Array(sets.length + 1);
  let at = 0;
  sets.forEach((set, index) => {
    localizingSetOffsets[index] = at / stride;
    localizingSetPoints.set(set, at);
    at += set.length;
  });
  localizingSetOffsets[sets.length] = at / stride;
  return { localizingSetPoints, localizingSetOffsets };
}

/** What the ellipsoid method and the cutting planes share in their options. */
export interface LocalizationOptions {
  maxit: number;
  tol: number;
  /** slide a feasible query point along the objective to the blocking constraint before adopting it */
  rayShoot: boolean;
  /** how much larger than the drawn region's bounding box the initial localization is */
  initialScale: number;
}

/**
 * One run of a method in the family: the dense problem, the oracle, the incumbent, the trace and
 * the stopping test, so an engine holds only its own localizing set and its update of it.
 */
export class LocalizationRun {
  readonly A: DenseMatrix;
  readonly b: Float64Array;
  readonly c: Float64Array;
  readonly n: number;
  readonly trace: LocalizationTrace;
  readonly incumbent: Incumbent;
  /** the best objective value anything still under consideration could have */
  upperBound = Infinity;
  termination: Termination = "maxit";
  private readonly tol: number;
  private readonly startTime = performance.now();

  constructor(constraints: readonly Constraint[], objective: Float64Array, opts: LocalizationOptions, withLocalizingSets: boolean, tooFewVariables: string) {
    assertMaxit(opts.maxit);
    const { A, b } = denseFromConstraints(constraints);
    if (A.cols < 2) throw new Error(tooFewVariables);
    this.A = A;
    this.b = b;
    this.n = A.cols;
    this.c = Float64Array.from({ length: this.n }, (_, j) => objective[j] ?? 0);
    this.tol = opts.tol;
    this.trace = new LocalizationTrace(opts.maxit, this.n, withLocalizingSets);
    this.incumbent = new Incumbent(A, b, this.c, opts.rayShoot);
  }

  /** The oracle's answer at a query point, which is offered to the incumbent when feasible. */
  query(point: Float64Array): { objectiveValue: number; worstRow: number; violation: number; feasible: boolean } {
    const objectiveValue = dot(this.c, point);
    const { row: worstRow, violation } = mostViolatedConstraint(this.A, this.b, point);
    const feasible = violation <= FEASIBILITY_TOLERANCE;
    if (feasible) this.incumbent.offer(point, objectiveValue);
    return { objectiveValue, worstRow, violation, feasible };
  }

  /**
   * Whether the incumbent is certified optimal by the upper bound, which ends the run. Feasibility
   * of the query point is still required so that the last iterate the viewport marks as the answer
   * is a point of the region.
   */
  converged(feasible: boolean): boolean {
    if (!feasible || !this.incumbent.certifies(this.upperBound, this.tol)) return false;
    this.termination = "converged";
    return true;
  }

  /** The result: how the run ended, with the incumbent recorded as its final iterate. */
  finish(stops: TerminationLines): SolverResult {
    const footer = localizationFooter(this.termination, this.trace.count, performance.now() - this.startTime, stops);
    this.trace.closeOnIncumbent(this.incumbent, this.upperBound);
    return this.trace.result(localizationLogHeader(this.n), footer);
  }
}
