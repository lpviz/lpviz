// Fixtures shared by the solver tests. The random generators consume the RNG
// in a fixed order (count, center, angles, radius), so a test's inputs depend
// only on its seed and options.

import type { Constraint, Vec } from "@lpviz/math/types";
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

export const PDHG_DEFAULTS = { halpern: false, maxit: 2000, eta: 0.25, tau: 0.25, tol: 1e-4, colorByBasis: false };
export const ipmOptions = (alphaMax = 0.9, maxit = 200) => ({ tol: 1e-6, maxit, alphaMax, correctorThreshold: 0.9 });

export const lcg = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

// The edges of a convex hull as inward-pointing unit-normal constraints.
export function polygonConstraints(hull: Vec[]): Constraint[] {
  const cx = hull.reduce((s, v) => s + v[0], 0) / hull.length;
  const cy = hull.reduce((s, v) => s + v[1], 0) / hull.length;
  return hull.map((start, i) => {
    const end = hull[(i + 1) % hull.length]!;
    let A = end[1] - start[1];
    let B = -(end[0] - start[0]);
    const norm = Math.hypot(A, B);
    A /= norm;
    B /= norm;
    let C = A * start[0] + B * start[1];
    if (A * cx + B * cy > C) {
      A = -A;
      B = -B;
      C = -C;
    }
    return [A, B, C];
  });
}

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

export const lastIterate = (r: { iterations: Float64Array[] }) => r.iterations[r.iterations.length - 1]!;

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
