// Fixtures shared by the solver tests. The random generators consume the RNG
// in a fixed order (count, center, angles, radius), so a test's inputs depend
// only on its seed and options.

import { expect } from "bun:test";
import type { Rng } from "@lpviz/math/random";
import type { Constraint, Vec } from "@lpviz/math/types";
import { constraintsFromChain } from "@lpviz/polytope/constraints";
import type { NumericRow, SolverResult } from "../src/result";

// square around (-5,-5): x <= -4, x >= -6, y <= -4, y >= -6
export const SQUARE: Constraint[] = [
  [1, 0, -4],
  [-1, 0, 6],
  [0, 1, -4],
  [0, -1, 6],
];
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
export const EMPTY: Constraint[] = [
  [1, 0, 1],
  [-1, 0, -2],
  [0, 1, 1],
  [0, -1, 1],
];
export const EMPTY_HULL: Vec[] = [
  [1, 1],
  [2, 1],
  [2, -1],
  [1, -1],
];

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

/** Every constraint a·x ≤ b holds at the point, to `tol`. */
export const expectFeasible = (constraints: readonly Constraint[], point: ArrayLike<number>, tol: number) => {
  for (const row of constraints) {
    let lhs = 0;
    for (let j = 0; j < row.length - 1; j++) lhs += row[j]! * point[j]!;
    expect(lhs).toBeLessThanOrEqual(row[row.length - 1]! + tol);
  }
};

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

export const lastIterate = (r: { iterates: Float64Array[] }) => r.iterates[r.iterates.length - 1]!;

// How many of a simplex run's iterates belong to Phase 1 (its `phases` are absent when none do).
export const phase1Count = (r: SolverResult) => (r.phases ?? []).filter((phase) => phase === 0).length;
// A single-section result's log: its numeric rows and its footer text.
export const rowsOf = (r: SolverResult) => r.log[0]!.rows as NumericRow[];
export const footerOf = (r: SolverResult) => r.log[0]!.footer ?? "";
// Every line of every section, as the panel prints them.
export const logText = (r: SolverResult) => r.log.flatMap(({ header, rows, notes = [], footer = "" }) => [header, ...(rows as string[]), ...notes, footer]).join("");
// The two-variable ellipse drawn for iterate `i`: its center and shape matrix (see ellipsoidStride).
export function ellipseAt(r: SolverResult, i: number) {
  const e = r.ellipsoids!;
  const base = i * 5;
  return { cx: e[base]!, cy: e[base + 1]!, p11: e[base + 2]!, p12: e[base + 3]!, p22: e[base + 4]! };
}
