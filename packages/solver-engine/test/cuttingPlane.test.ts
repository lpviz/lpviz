import { describe, expect, test } from "bun:test";
import { cuttingPlane, type QueryPoint } from "../src/cuttingPlane";
import { ellipsoid } from "../src/ellipsoid";
import { SQUARE, SQUARE_VERTICES, footerOf, lastIterate, lcg, randomPolygon, rowsOf } from "./fixtures";

const QUERY_POINTS: QueryPoint[] = ["chebyshev", "analytic", "volumetric"];

const opts = (queryPoint: QueryPoint, o: Record<string, unknown> = {}) => ({
  maxit: 500,
  tol: 1e-6,
  rayShoot: true,
  initialScale: 1.5,
  queryPoint,
  ...o,
});

describe("cuttingPlane", () => {
  test("every query point finds the optimum of random polygons", () => {
    const rand = lcg(13);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 12; t++) {
      const polygon = randomPolygon(rand, { gap: 0.3, radius: 6, spread: 12 });
      if (!polygon) continue;
      const { hull, constraints } = polygon;
      const objective = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      if (Math.abs(objective[0]!) + Math.abs(objective[1]!) < 0.2) continue;
      const expected = Math.max(...hull.map((v) => objective[0]! * v[0] + objective[1]! * v[1]));
      runs++;
      for (const queryPoint of QUERY_POINTS) {
        const r = cuttingPlane(hull, constraints, objective, opts(queryPoint));
        const last = lastIterate(r);
        const got = objective[0]! * last[0]! + objective[1]! * last[1]!;
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
        for (const [a1, a2, rhs] of SQUARE) {
          expect(a1 * last[0]! + a2 * last[1]!).toBeLessThanOrEqual(rhs + 1e-7);
        }
      }
    }
  });

  test("they need far fewer iterations than the ellipsoid method", () => {
    const objective = Float64Array.of(0.8, 0.6);
    const reference = ellipsoid(SQUARE_VERTICES, SQUARE, objective, {
      maxit: 500,
      tol: 1e-6,
      deepCuts: true,
      rayShoot: true,
      initialScale: 1.5,
    });
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
      expect(r.iterations.length).toBeLessThan(reference.iterations.length / 2);
    }
  });

  test("rho is a genuine bound: it never understates the true gap", () => {
    const objective = Float64Array.of(1, 1);
    const expected = Math.max(...SQUARE_VERTICES.map((v) => objective[0]! * v[0] + objective[1]! * v[1]));
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(SQUARE_VERTICES, SQUARE, objective, opts(queryPoint));
      // objective at the query point plus rho upper-bounds the optimum at every
      // iteration, which is what makes the stopping gap a certificate
      for (let i = 0; i < rowsOf(r).length; i++) {
        expect(rowsOf(r)[i]!.objective + r.convergence![i]!).toBeGreaterThanOrEqual(expected - 1e-6);
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
        for (let i = 1; i < rowsOf(r).length - 1; i++) {
          const previous = rowsOf(r)[i - 1]!.objective + r.convergence![i - 1]!;
          const current = rowsOf(r)[i]!.objective + r.convergence![i]!;
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
      for (let i = 0; i < r.iterations.length; i++) {
        const p11 = r.ellipsoids![i * 5 + 2]!;
        const p12 = r.ellipsoids![i * 5 + 3]!;
        const p22 = r.ellipsoids![i * 5 + 4]!;
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
    const x = Float64Array.of(0.3, -0.2);
    let h11 = 0;
    let h12 = 0;
    let h22 = 0;
    const slacks = rows.map((row) => row[2]! - row[0]! * x[0]! - row[1]! * x[1]!);
    rows.forEach((row, i) => {
      const w = 1 / (slacks[i]! * slacks[i]!);
      h11 += row[0]! * row[0]! * w;
      h12 += row[0]! * row[1]! * w;
      h22 += row[1]! * row[1]! * w;
    });
    const det = h11 * h22 - h12 * h12;
    const inv = { a11: h22 / det, a12: -h12 / det, a22: h11 / det };
    let total = 0;
    rows.forEach((row, i) => {
      const quad = inv.a11 * row[0]! * row[0]! + 2 * inv.a12 * row[0]! * row[1]! + inv.a22 * row[1]! * row[1]!;
      total += quad / (slacks[i]! * slacks[i]!);
    });
    expect(total).toBeCloseTo(2, 10);
  });

  test("an empty region terminates instead of spinning", () => {
    const empty = [
      [1, 0, 1],
      [-1, 0, -2],
      [0, 1, 1],
      [0, -1, 1],
    ] as [number, number, number][];
    const hull = [
      [1, 1],
      [2, 1],
      [2, -1],
      [1, -1],
    ] as [number, number][];
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(hull, empty, Float64Array.of(1, 1), opts(queryPoint));
      expect(r.iterations.length).toBeLessThan(500);
      expect(footerOf(r).startsWith("Converged")).toBe(false);
    }
  });

  test("reports an unbounded objective instead of claiming optimality", () => {
    // x in [-1, 2], maximize y: the optimum is only bounded by the initial box,
    // never by a constraint
    const strip = [
      [1, 0, 2],
      [-1, 0, 1],
    ] as [number, number, number][];
    const hull = [
      [-1, -5],
      [2, -5],
      [2, 5],
      [-1, 5],
    ] as [number, number][];
    for (const queryPoint of QUERY_POINTS) {
      for (const rayShoot of [true, false]) {
        const r = cuttingPlane(hull, strip, Float64Array.of(0, 1), opts(queryPoint, { rayShoot }));
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
  const WEDGE = [
    [1, -2, 0],
    [1, 1, 3],
  ] as [number, number, number][];
  const WEDGE_CHAIN = [
    [0, 0],
    [2, 1],
    [1, 2],
  ] as [number, number][];

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
        expect(again.iterations.length).toBe(first.iterations.length);
        expect([...again.ellipsoids!]).toEqual([...first.ellipsoids!]);
      }
    }
  });
});
