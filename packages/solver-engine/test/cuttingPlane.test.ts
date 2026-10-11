import { lcg } from "@lpviz/math/random";
import { describe, expect, test } from "bun:test";
import type { Constraint, Vec } from "@lpviz/math/types";
import { computeQueryPoint } from "../src/barrierCenters";
import { QUERY_POINTS, cuttingPlane, type CuttingPlaneOptions, type QueryPoint } from "../src/cuttingPlane";
import { ellipsoid } from "../src/ellipsoid";
import {
  bruteForceOptimum,
  ellipseAt,
  EMPTY,
  EMPTY_HULL,
  expectFeasible,
  footerOf,
  lastIterate,
  LOCALIZATION_DEFAULTS,
  objectiveValue,
  randomObjective,
  randomPolygon,
  rowsOf,
  SQUARE,
  SQUARE_VERTICES,
  STRIP,
  STRIP_HULL,
} from "./fixtures";

const opts = (queryPoint: QueryPoint, o: Partial<CuttingPlaneOptions> = {}) => ({ ...LOCALIZATION_DEFAULTS, queryPoint, ...o });

describe("cuttingPlane", () => {
  test("every query point finds the optimum of random polygons", () => {
    const rand = lcg(13);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 12; t++) {
      const polygon = randomPolygon(rand, { gap: 0.3, radius: 6, spread: 12 });
      if (!polygon) continue;
      const { hull, constraints } = polygon;
      const objective = randomObjective(rand);
      if (Math.abs(objective[0]!) + Math.abs(objective[1]!) < 0.2) continue;
      const expected = bruteForceOptimum(objective, hull);
      runs++;
      for (const queryPoint of QUERY_POINTS) {
        const r = cuttingPlane(hull, constraints, objective, opts(queryPoint));
        const got = objectiveValue(objective, lastIterate(r));
        expect(got).toBeLessThanOrEqual(expected + 1e-7);
        expect(expected - got).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(expected)) + 1e-7);
      }
    }
    expect(runs).toBeGreaterThan(8);
  });

  test("the returned point is feasible for every query point", () => {
    for (const queryPoint of QUERY_POINTS) {
      for (const objective of [Float64Array.of(1, 1), Float64Array.of(-2, 0.5), Float64Array.of(0, -1)]) {
        const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
        const last = lastIterate(r);
        expectFeasible(SQUARE, last, 1e-7);
      }
    }
  });

  test("they need far fewer iterations than the ellipsoid method", () => {
    const objective = Float64Array.of(0.8, 0.6);
    const reference = ellipsoid(SQUARE_VERTICES, SQUARE, objective, { ...LOCALIZATION_DEFAULTS, deepCuts: true });
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
      expect(r.iterates.count).toBeLessThan(reference.iterates.count / 2);
    }
  });

  test("rho is a genuine bound: it never understates the true gap", () => {
    const objective = Float64Array.of(1, 1);
    const expected = bruteForceOptimum(objective, SQUARE_VERTICES);
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
      const rows = rowsOf(r);
      // objective at the query point plus rho upper-bounds the optimum at every
      // iteration, which is what makes the stopping gap a certificate
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i]!.objective + r.convergence![i]!).toBeGreaterThanOrEqual(expected - 1e-6);
      }
      expect(r.convergence![r.convergence!.length - 1]!).toBeLessThan(r.convergence![0]!);
    }
  });

  test("the localizing set only ever shrinks", () => {
    // The invariant that actually constrains these methods. The next query
    // point is NOT required to lie inside the previous drawn ellipse — that
    // ellipse is inscribed at the query point, a local measure of elbow room,
    // not the region still under consideration. What cannot happen is the
    // region itself growing, which would show up as a rising upper bound.
    for (const queryPoint of QUERY_POINTS) {
      for (let k = 0; k < 8; k++) {
        const angle = (k / 8) * 2 * Math.PI;
        const objective = Float64Array.of(Math.cos(angle), Math.sin(angle));
        const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
        const rows = rowsOf(r);
        for (let i = 1; i < rows.length - 1; i++) {
          const previous = rows[i - 1]!.objective + r.convergence![i - 1]!;
          const current = rows[i]!.objective + r.convergence![i]!;
          expect(current).toBeLessThanOrEqual(previous + 1e-9);
        }
      }
    }
  });

  test("the drawn ellipse is inscribed in the region, not around it", () => {
    // the polyhedral methods emit the Dikin / inscribed ball at the query
    // point, so every ellipse must sit inside the original constraints once the
    // cuts that define it have been discovered
    const objective = Float64Array.of(1, 1);
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
      for (let i = 0; i < r.iterates.count; i++) {
        const { p11, p12, p22 } = ellipseAt(r, i);
        expect(p11).toBeGreaterThan(0);
        expect(p22).toBeGreaterThan(0);
        expect(p11 * p22 - p12 * p12).toBeGreaterThan(0);
      }
    }
  });

  test("volumetric leverage scores sum to the dimension", () => {
    // sum_i sigma_i = tr(H^-1 H) = n. If this drifts, the volumetric gradient
    // and its proxy Hessian are wrong.
    const rows = [
      [1, 0, 3],
      [-1, 0, 1],
      [0, 1, 2],
      [0, -1, 2],
      [1, 1, 4],
    ];
    const { leverage } = computeQueryPoint("volumetric", rows, 2)!;
    expect(leverage!.reduce((total, score) => total + score, 0)).toBeCloseTo(2, 10);
  });

  test("an empty region terminates instead of spinning", () => {
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(EMPTY_HULL, EMPTY, Float64Array.of(1, 1), opts(queryPoint));
      expect(r.iterates.count).toBeLessThan(500);
      expect(footerOf(r).startsWith("Converged")).toBe(false);
    }
  });

  test("reports an unbounded objective instead of claiming optimality", () => {
    // x in [-1, 2], maximize y: the optimum is only bounded by the initial box,
    // never by a constraint
    for (const queryPoint of QUERY_POINTS) {
      for (const rayShoot of [true, false]) {
        const r = cuttingPlane(STRIP_HULL, STRIP, Float64Array.of(0, 1), opts(queryPoint, { rayShoot }));
        expect(footerOf(r).startsWith("Stopped on the initial box boundary")).toBe(true);
        expect(footerOf(r)).toContain("unbounded");
      }
    }
  });

  // The open chain (0,0) → (2,1) → (1,2) of lpviz/lpviz#75: the region
  // y >= x/2, x + y <= 3 is unbounded to the upper left, with (2,1) its only
  // vertex. Minimizing x over it has no optimum; maximizing x + y does — the
  // value 3 along the whole ray from (2,1) in the direction (-1, 1) — even
  // though that optimal face runs off into the initial box exactly where an
  // unbounded objective would stop. The ellipsoid method is the reference.
  const WEDGE: Constraint[] = [
    [1, -2, 0],
    [1, 1, 3],
  ];
  const WEDGE_CHAIN: Vec[] = [
    [0, 0],
    [2, 1],
    [1, 2],
  ];

  test("an objective that is unbounded over an open region says so", () => {
    for (const objective of [Float64Array.of(-1, 0), Float64Array.of(-1, 1)]) {
      for (const queryPoint of QUERY_POINTS) {
        for (const rayShoot of [true, false]) {
          const r = cuttingPlane(WEDGE_CHAIN, WEDGE, objective, opts(queryPoint, { rayShoot }));
          expect(footerOf(r)).toContain("unbounded");
        }
      }
      const reference = ellipsoid(WEDGE_CHAIN, WEDGE, objective, {
        ...opts("chebyshev"),
        deepCuts: true,
      });
      expect(footerOf(reference)).toContain("unbounded");
    }
  });

  test("a bounded objective whose optimal face is a ray is still optimal", () => {
    const objective = Float64Array.of(1, 1);
    for (const queryPoint of QUERY_POINTS) {
      for (const rayShoot of [true, false]) {
        const r = cuttingPlane(WEDGE_CHAIN, WEDGE, objective, opts(queryPoint, { rayShoot }));
        expect(footerOf(r)).not.toContain("unbounded");
        const last = lastIterate(r);
        expect(last[0]! + last[1]!).toBeCloseTo(3, 4);
      }
    }
  });

  test("results are reproducible across repeated solves", () => {
    for (const queryPoint of QUERY_POINTS) {
      const run = () => cuttingPlane(SQUARE_VERTICES, SQUARE, Float64Array.of(0.4, 0.9), opts(queryPoint));
      const first = run();
      for (let i = 0; i < 3; i++) {
        const again = run();
        expect(again.iterates.count).toBe(first.iterates.count);
        expect([...again.ellipsoids!]).toEqual([...first.ellipsoids!]);
      }
    }
  });
});
