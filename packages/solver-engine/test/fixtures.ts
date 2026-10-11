// Fixtures shared by the solver tests. The random generators consume the RNG
// in a fixed order (count, center, angles, radius), so a test's inputs depend
// only on its seed and options.

import { expect } from "bun:test";
import { trySolveDenseSystem } from "@lpviz/math/lapack";
import { boxRows } from "@lpviz/math/lp";
import type { Rng } from "@lpviz/math/random";
import type { Constraint, Vec } from "@lpviz/math/types";
import { constraintsFromChain } from "@lpviz/polytope/constraints";
import type { NumericRow, NumericRows, SolverResult } from "../src/result";

// square around (-5,-5): x <= -4, x >= -6, y <= -4, y >= -6
export const SQUARE: Constraint[] = boxRows([-6, -6], [-4, -4]);
export const SQUARE_VERTICES: Vec[] = [
  [-6, -6],
  [-4, -6],
  [-4, -4],
  [-6, -4],
];

// x in [-1, 2]: a strip, unbounded along y
export const STRIP: Constraint[] = [
  [1, 0, 2],
  [-1, 0, 1],
];
// a piece of the strip, as the vertices a drawing of it would bound the localization by
export const STRIP_HULL: Vec[] = [
  [-1, -5],
  [2, -5],
  [2, 5],
  [-1, 5],
];
// x <= 1 and x >= 2: an empty region
export const EMPTY: Constraint[] = boxRows([2, -1], [1, 1]);
export const EMPTY_HULL: Vec[] = [
  [1, 1],
  [2, 1],
  [2, -1],
  [1, -1],
];

// cube centered at the origin: |x| <= 4, |y| <= 4, |z| <= 4
export const CUBE: Constraint[] = boxRows([-4, -4, -4], [4, 4, 4]);
// asymmetric box: x in [-2, 1], y in [-3, 2], z in [-4, 3]
export const BOX: Constraint[] = boxRows([-2, -3, -4], [1, 2, 3]);
// the box with its (1, 2, 3) corner sliced off, so a random objective can land
// on a non-axis-aligned facet
export const SLICED_BOX: Constraint[] = [...BOX, [1, 1, 1, 4]];

export const PDHG_DEFAULTS = { halpern: false, maxit: 2000, eta: 0.25, tau: 0.25, tol: 1e-4, colorByBasis: false };
export const ipmOptions = (alphaMax = 0.9, maxit = 200) => ({ tol: 1e-6, maxit, alphaMax, correctorThreshold: 0.9 });
// what the ellipsoid method and the cutting planes share
export const LOCALIZATION_DEFAULTS = { maxit: 500, tol: 1e-6, rayShoot: true, initialScale: 1.5 };

/** A random objective with coordinates in [-2, 2), drawn in index order. */
export const randomObjective = (rand: Rng, n = 2) => Float64Array.from({ length: n }, () => rand() * 4 - 2);

/** The point is within `digits` decimals of `expected`, coordinate by coordinate. */
export const expectNear = (point: ArrayLike<number>, expected: readonly number[], digits: number) => {
  expect(point.length).toBe(expected.length);
  expected.forEach((value, j) => expect(point[j]!).toBeCloseTo(value, digits));
};

// by how much the point breaks a·x ≤ b (negative inside)
const excess = (row: Constraint, point: ArrayLike<number>) => {
  let lhs = 0;
  for (let j = 0; j < row.length - 1; j++) lhs += row[j]! * point[j]!;
  return lhs - row[row.length - 1]!;
};

/** Every constraint a·x ≤ b holds at the point, to `tol`. */
export const expectFeasible = (constraints: readonly Constraint[], point: ArrayLike<number>, tol: number) => {
  for (const row of constraints) expect(excess(row, point)).toBeLessThanOrEqual(tol);
};

/** Every vertex of `{a·x ≤ b}` by brute force: each feasible point where `n` of the rows meet, in the rows' order. */
export function verticesOf(rows: readonly Constraint[], n: number): Vec[] {
  const out: Vec[] = [];
  const pick = (start: number, chosen: Constraint[]) => {
    if (chosen.length < n) {
      for (let i = start; i < rows.length; i++) pick(i + 1, [...chosen, rows[i]!]);
      return;
    }
    const point = new Float64Array(n);
    // the rows may not meet in a point
    if (
      !trySolveDenseSystem(
        Float64Array.from(chosen.flatMap((row) => row.slice(0, n))),
        n,
        Float64Array.from(chosen, (row) => row[n]!),
        point,
      )
    )
      return;
    const p = Array.from(point) as Vec;
    if (rows.every((row) => excess(row, p) <= 1e-6) && !out.some((v) => Math.hypot(...v.map((value, j) => value - p[j]!)) < 1e-7)) out.push(p);
  };
  pick(0, []);
  return out;
}

// The edges of a convex hull as inward-pointing unit-normal constraints.
export const polygonConstraints = (hull: Vec[]): Constraint[] => constraintsFromChain(hull, true);

// A random convex polygon (3-7 vertices on a circle, so no three edges are
// concurrent) as inward-pointing constraints, or null when two vertices
// are within `gap` radians of each other (an ill-conditioned edge). The center
// is drawn from [-spread/2, spread/2]^2 and the radius from [1, 1 + radius].
export function randomPolygon(rand: () => number, { gap = 0.2, radius = 8, spread = 16 } = {}) {
  const count = 3 + Math.floor(rand() * 5);
  const cx = rand() * spread - spread / 2;
  const cy = rand() * spread - spread / 2;
  const angles = Array.from({ length: count }, () => rand() * 2 * Math.PI).sort((a, b) => a - b);
  if (angles.some((a, i) => i > 0 && a - angles[i - 1]! < gap)) return null;
  const R = 1 + rand() * radius;
  const hull: Vec[] = angles.map((a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  return { hull, constraints: polygonConstraints(hull) };
}

// A convex polygon with `count` vertices on the circle of radius 10 about the
// origin — the size PR #69's random generator produces, and the size at which
// per-pivot / per-iteration dense factorizations used to cost seconds.
export function largePolygon(rand: () => number, count: number) {
  const angles = Array.from({ length: count }, () => rand() * 2 * Math.PI).sort((a, b) => a - b);
  const hull: Vec[] = angles.map((a) => [10 * Math.cos(a), 10 * Math.sin(a)]);
  return { hull, constraints: polygonConstraints(hull) };
}

export const objectiveValue = (c: ArrayLike<number>, p: ArrayLike<number>) => {
  let value = 0;
  for (let j = 0; j < c.length; j++) value += c[j]! * p[j]!;
  return value;
};
// the optimum of a bounded LP is attained at a vertex
export const bruteForceOptimum = (c: ArrayLike<number>, vertices: readonly Vec[]) => Math.max(...vertices.map((v) => objectiveValue(c, v)));

/** Iterate `i` of a result, as a view into its block. */
export const iterateAt = ({ iterates: { points, stride } }: Pick<SolverResult, "iterates">, i: number) => points.subarray(i * stride, (i + 1) * stride);
export const lastIterate = (r: Pick<SolverResult, "iterates">) => iterateAt(r, r.iterates.count - 1);

// How many of a simplex run's iterates belong to Phase 1 (its `phases` are absent when none do).
export const phase1Count = (r: SolverResult) => (r.phases ?? []).filter((phase) => phase === 0).length;
// A single-section result's log: its numeric rows, materialized from the columns as the client
// would, and its footer text.
export const rowsOf = (r: SolverResult): NumericRow[] => {
  const { objective, infeasibility, restart, convergence } = r.log[0]!.rows as NumericRows;
  return Array.from(objective, (value, i) => ({
    iteration: i + 1,
    restart: restart[i] === 1,
    point: iterateAt(r, i),
    objective: value,
    infeasibility: infeasibility[i]!,
    convergence: convergence[i]!,
  }));
};
export const lastRowOf = (r: SolverResult): NumericRow => rowsOf(r)[r.iterates.count - 1]!;
export const footerOf = (r: SolverResult) => r.log[0]!.footer ?? "";
// Every line of every section, as the panel prints them.
export const logText = (r: SolverResult) => r.log.flatMap(({ header, rows, notes = [], footer = "" }) => [header, ...(rows as string[]), ...notes, footer]).join("");
// The two-variable ellipse drawn for iterate `i`: its center and shape matrix (see ellipsoidStride).
export function ellipseAt(r: SolverResult, i: number) {
  const e = r.ellipsoids!.data;
  const base = i * 5;
  return { cx: e[base]!, cy: e[base + 1]!, p11: e[base + 2]!, p12: e[base + 3]!, p22: e[base + 4]! };
}
