// Seidel's randomized incremental algorithm (Seidel 1991, "Small-dimensional linear programming
// and convex hulls made easy") on `max c'x s.t. Ax <= b`. Insert the constraints in a random order,
// keeping the optimum of those inserted so far. A new constraint the optimum satisfies changes
// nothing; one it breaks must be tight at the new optimum (the old optimum and the new one sit on
// opposite sides of it, and the feasible set is convex), so the new optimum solves the LP restricted
// to that constraint's hyperplane: the same problem one dimension down, solved the same way. In one
// dimension it is an interval. Expected time O(d! m): linear in the constraints for d fixed, which
// is why computational geometry uses it in the plane and in space.
//
// The incremental optimum needs a bounded start, so the run begins inside a box: every coordinate
// within ±M, with M half again the largest coordinate of any vertex of the region, so an optimal
// vertex is always strictly inside. A region with no vertex (empty, or holding a whole line) falls
// back to twice the largest coordinate any crossing of the rows has. The first iterate is the box's
// best corner.
// A final optimum still on the box is a vertex no constraint makes, so the LP is unbounded; an empty
// one-dimensional interval anywhere down the recursion means the inserted constraints, and so the
// LP, are infeasible.

import { denseFromConstraints, dot } from "@lpviz/math/blas";
import { trySolveDenseSystem } from "@lpviz/math/lapack";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { fmtIterate, fmtIteration, ITERATION_COLUMN_WIDTH, iterateHeaders, solveFooter } from "./fmt";
import { assertAtMost, MAX_ITERATIONS } from "./limits";
import { FloatBlock, iteratesOf, type SolverResult } from "./result";

export interface SeidelOptions {
  tol: number;
  /** the seed of the insertion order; the same seed replays the same run */
  seed: number;
}

/** A half-space a'x <= b in the coordinates of the current subproblem. */
type Halfspace = { a: Float64Array; b: number };

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

const violates = ({ a, b }: Halfspace, x: Float64Array, tol: number) => dot(a, x) - b > tol * (1 + Math.abs(b));

/**
 * The half-spaces restricted to the hyperplane h'x = h.b, in the d - 1 coordinates left once the
 * one with h's largest coefficient is eliminated, and the map back up.
 */
function restrict(h: Halfspace, halfspaces: readonly Halfspace[], c: Float64Array) {
  const d = h.a.length;
  let pivot = 0;
  for (let j = 1; j < d; j++) if (Math.abs(h.a[j]!) > Math.abs(h.a[pivot]!)) pivot = j;
  const p = h.a[pivot]!;
  // x_pivot = (h.b - sum_{k != pivot} h.a_k x_k) / p
  const drop = (v: Float64Array, scale: number) => {
    const out = new Float64Array(d - 1);
    for (let j = 0, k = 0; j < d; j++) if (j !== pivot) out[k++] = v[j]! - (scale * h.a[j]!) / p;
    return out;
  };
  const lower = halfspaces.map(({ a, b }) => ({ a: drop(a, a[pivot]!), b: b - (a[pivot]! * h.b) / p }));
  const objective = drop(c, c[pivot]!);
  const lift = (y: Float64Array) => {
    const x = new Float64Array(d);
    let rest = h.b;
    for (let j = 0, k = 0; j < d; j++) {
      if (j === pivot) continue;
      x[j] = y[k++]!;
      rest -= h.a[j]! * x[j]!;
    }
    x[pivot] = rest / p;
    return x;
  };
  return { lower, objective, lift };
}

/** The interval LP max c x s.t. a_i x <= b_i, or null when empty. */
function solveInterval(halfspaces: readonly Halfspace[], c: number, tol: number): Float64Array | null {
  let lo = -Infinity;
  let hi = Infinity;
  for (const { a, b } of halfspaces) {
    const coefficient = a[0]!;
    if (Math.abs(coefficient) <= 1e-12) {
      if (b < -tol * (1 + Math.abs(b))) return null;
    } else if (coefficient > 0) hi = Math.min(hi, b / coefficient);
    else lo = Math.max(lo, b / coefficient);
  }
  if (lo > hi + tol * (1 + Math.abs(hi))) return null;
  return Float64Array.of(c > 0 ? hi : c < 0 ? lo : Number.isFinite(hi) ? hi : lo);
}

/**
 * The optimum of `max c'x` over `box` (2d half-spaces that bound it) and `halfspaces`, inserted in
 * the given order; `onInsert` sees each top-level insertion. Null when infeasible.
 */
function incremental(
  box: readonly Halfspace[],
  halfspaces: readonly Halfspace[],
  c: Float64Array,
  start: Float64Array,
  tol: number,
  next: () => number,
  onInsert?: (index: number, x: Float64Array, moved: boolean) => void,
): Float64Array | null {
  let x = start;
  const inserted: Halfspace[] = [...box];
  for (let i = 0; i < halfspaces.length; i++) {
    const h = halfspaces[i]!;
    const moved = violates(h, x, tol);
    if (moved) {
      const found = onHyperplane(h, inserted, c, tol, next);
      if (!found) {
        onInsert?.(i, x, true);
        return null;
      }
      x = found;
    }
    inserted.push(h);
    onInsert?.(i, x, moved);
  }
  return x;
}

/** The optimum over `inserted` on the hyperplane of `h`: the recursive step, one dimension down. */
function onHyperplane(h: Halfspace, inserted: readonly Halfspace[], c: Float64Array, tol: number, next: () => number): Float64Array | null {
  const { lower, objective, lift } = restrict(h, inserted, c);
  if (objective.length === 1) {
    const y = solveInterval(lower, objective[0]!, tol);
    return y && lift(y);
  }
  // the restricted box rows (the first 2(d-1) of the parent's box, minus the pivot's pair) stay a
  // valid bounding start; the rest are reinserted in a fresh random order
  const d = objective.length;
  const bound = lower.filter(({ a }) => a.filter((v) => Math.abs(v) > 0).length === 1);
  const others = shuffled(
    lower.filter((halfspace) => !bound.includes(halfspace)),
    next,
  );
  const start = boxCorner(bound, objective, d, tol);
  if (!start) return null;
  const y = incremental(bound, others, objective, start, tol, next);
  return y && lift(y);
}

/** The best corner of the axis-aligned box the single-coordinate rows describe, or null when they leave it empty or open. */
function boxCorner(rows: readonly Halfspace[], c: Float64Array, d: number, tol: number): Float64Array | null {
  const x = new Float64Array(d);
  for (let j = 0; j < d; j++) {
    const column = rows.filter(({ a }) => Math.abs(a[j]!) > 0).map(({ a, b }) => ({ a: Float64Array.of(a[j]!), b }));
    const y = solveInterval(column, c[j]!, tol);
    if (!y || !Number.isFinite(y[0]!)) return null;
    x[j] = y[0]!;
  }
  return x;
}

/**
 * Half the width of the starting box: half again the largest coordinate of a vertex of the region,
 * or, when it has none, twice the largest of any crossing of the rows or of a row's closest point to the origin.
 */
function boxRadius(rows: readonly Halfspace[], d: number, tol: number): number {
  let crossings = 1;
  let vertices = 0;
  for (const { a, b } of rows) {
    const norm = Math.hypot(...a);
    if (norm > 0) crossings = Math.max(crossings, Math.abs(b) / norm);
  }
  const visit = (chosen: number[], from: number) => {
    if (chosen.length === d) {
      const matrix = new Float64Array(d * d);
      chosen.forEach((row, p) => matrix.set(rows[row]!.a, p * d));
      const point = new Float64Array(d);
      const right = Float64Array.from(chosen, (row) => rows[row]!.b);
      if (!trySolveDenseSystem(matrix, d, right, point) || !point.every(Number.isFinite)) return;
      const largest = Math.max(...point.map(Math.abs));
      crossings = Math.max(crossings, largest);
      if (!rows.some((row) => violates(row, point, tol))) vertices = Math.max(vertices, largest, 1);
      return;
    }
    for (let i = from; i < rows.length; i++) visit([...chosen, i], i + 1);
  };
  visit([], 0);
  return vertices > 0 ? 1.5 * vertices : 2 * crossings;
}

/** Seidel's algorithm on `max objective'x s.t. Ax <= b`, inserting the rows in the order `seed` shuffles them to. */
export function seidel(constraints: readonly Constraint[], objective: Float64Array, { tol, seed }: SeidelOptions): SolverResult {
  const { A, b } = denseFromConstraints(constraints);
  const d = A.cols;
  assertAtMost("constraints", A.rows, MAX_ITERATIONS);
  const startTime = performance.now();
  const rows: Halfspace[] = Array.from({ length: A.rows }, (_, i) => ({ a: Float64Array.from(A.data.subarray(i * d, (i + 1) * d)), b: b[i]! }));
  const radius = boxRadius(rows, d, tol);
  const box: Halfspace[] = [];
  for (let j = 0; j < d; j++) {
    for (const sign of [1, -1]) {
      const a = new Float64Array(d);
      a[j] = sign;
      box.push({ a, b: radius });
    }
  }
  const c = Float64Array.from(objective);
  const next = mulberry32(seed);
  const order = shuffled(
    rows.map((_, i) => i),
    next,
  );
  const start = boxCorner(box, c, d, tol)!;

  const iterates = new FloatBlock(d);
  const header = `${"Iter".padStart(ITERATION_COLUMN_WIDTH)} ${iterateHeaders(d)}  Row  Moved\n`;
  const log: string[] = [];
  const record = (x: Float64Array, row: string, moved: string) => {
    iterates.push(x);
    log.push(`${fmtIteration(log.length + 1)} ${fmtIterate(x, dot(c, x))} ${row.padStart(4)}${moved ? `  ${moved}` : ""}`);
  };
  record(start, "box", "");
  const x = incremental(
    box,
    order.map((i) => rows[i]!),
    c,
    start,
    tol,
    next,
    (k, point, moved) => record(point, String(order[k]! + 1), moved ? "yes" : "no"),
  );

  const onBox = x && box.some(({ a, b: limit }) => Math.abs(dot(a, x) - limit) <= tol * (1 + limit));
  const status = !x ? "infeasible" : onBox ? "unbounded" : "optimal";
  const moves = log.filter((line) => line.endsWith("yes")).length;
  const summary =
    status === "optimal"
      ? `Optimal after inserting ${rows.length} rows (${moves} moved the optimum)`
      : status === "infeasible"
        ? `Row ${order[log.length - 2]! + 1} leaves no point on its line: the LP is infeasible`
        : "The optimum is still on the starting box: no row bounds the objective, so the LP is unbounded";
  const footer = [summary, solveFooter(status === "optimal", iterates.count, performance.now() - startTime, "Stopped")].join("\n");
  return { iterates: iteratesOf(iterates), log: [{ header, rows: log, footer }], status };
}
