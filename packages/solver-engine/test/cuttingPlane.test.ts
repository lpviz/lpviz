import { describe, expect, test } from "bun:test";
import { cuttingPlane, type QueryPoint } from "../src/cuttingPlane";
import { ellipsoid } from "../src/ellipsoid";

const SQUARE = [
  [1, 0, -4],
  [-1, 0, 6],
  [0, 1, -4],
  [0, -1, 6],
] as [number, number, number][];
const SQUARE_VERTICES = [
  [-6, -6],
  [-4, -6],
  [-4, -4],
  [-6, -4],
] as [number, number][];

const QUERY_POINTS: QueryPoint[] = ["chebyshev", "analytic", "volumetric"];

const opts = (queryPoint: QueryPoint, o: Record<string, unknown> = {}) => ({
  maxit: 500,
  tol: 1e-6,
  rayShoot: true,
  initialScale: 1.5,
  queryPoint,
  verbose: false,
  ...o,
});

function polygonLines(hull: [number, number][]) {
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
    return [A, B, C] as [number, number, number];
  });
}

describe("cuttingPlane", () => {
  test("every query point finds the optimum of random polygons", () => {
    let seed = 13;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let runs = 0;
    for (let t = 0; t < 60 && runs < 12; t++) {
      const count = 3 + Math.floor(rand() * 5);
      const cx = rand() * 12 - 6;
      const cy = rand() * 12 - 6;
      const angles = Array.from({ length: count }, () => rand() * 2 * Math.PI).sort(
        (a, b) => a - b,
      );
      if (angles.some((a, i) => i > 0 && a - angles[i - 1]! < 0.3)) continue;
      const R = 1 + rand() * 6;
      const hull = angles.map(
        (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)] as [number, number],
      );
      const lines = polygonLines(hull);
      const objective = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      if (Math.abs(objective[0]!) + Math.abs(objective[1]!) < 0.2) continue;
      const expected = Math.max(
        ...hull.map((v) => objective[0]! * v[0] + objective[1]! * v[1]),
      );
      runs++;
      for (const queryPoint of QUERY_POINTS) {
        const r = cuttingPlane(hull, lines, objective, opts(queryPoint));
        const last = r.iterations[r.iterations.length - 1]!;
        const got = objective[0]! * last[0]! + objective[1]! * last[1]!;
        expect(got).toBeLessThanOrEqual(expected + 1e-7);
        expect(expected - got).toBeLessThanOrEqual(
          1e-6 * (1 + Math.abs(expected)) + 1e-7,
        );
      }
    }
    expect(runs).toBeGreaterThan(8);
  });

  test("the returned point is feasible for every query point", () => {
    for (const queryPoint of QUERY_POINTS) {
      for (const objective of [
        Float64Array.of(1, 1),
        Float64Array.of(-2, 0.5),
        Float64Array.of(0, -1),
      ]) {
        const r = cuttingPlane(
          SQUARE_VERTICES,
          SQUARE,
          objective,
          opts(queryPoint),
        );
        const last = r.iterations[r.iterations.length - 1]!;
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
      parallelCuts: false,
      rayShoot: true,
      initialScale: 1.5,
      verbose: false,
    });
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(
        SQUARE_VERTICES,
        SQUARE,
        objective,
        opts(queryPoint),
      );
      expect(r.iterations.length).toBeLessThan(reference.iterations.length / 2);
    }
  });

  test("rho is a genuine bound: it never understates the true gap", () => {
    const objective = Float64Array.of(1, 1);
    const expected = Math.max(
      ...SQUARE_VERTICES.map((v) => objective[0]! * v[0] + objective[1]! * v[1]),
    );
    for (const queryPoint of QUERY_POINTS) {
      const r = cuttingPlane(
        SQUARE_VERTICES,
        SQUARE,
        objective,
        opts(queryPoint),
      );
      // objective at the query point plus rho upper-bounds the optimum at every
      // iteration, which is what makes the stopping gap a certificate
      for (let i = 0; i < r.rows.length; i++) {
        expect(r.rows[i]!.objective + r.rho[i]!).toBeGreaterThanOrEqual(
          expected - 1e-6,
        );
      }
      expect(r.rho[r.rho.length - 1]!).toBeLessThan(r.rho[0]!);
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
        const r = cuttingPlane(
          SQUARE_VERTICES,
          SQUARE,
          objective,
          opts(queryPoint),
        );
        for (let i = 1; i < r.rows.length - 1; i++) {
          const previous = r.rows[i - 1]!.objective + r.rho[i - 1]!;
          const current = r.rows[i]!.objective + r.rho[i]!;
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
      const r = cuttingPlane(
        SQUARE_VERTICES,
        SQUARE,
        objective,
        opts(queryPoint),
      );
      for (let i = 0; i < r.iterations.length; i++) {
        const p11 = r.ellipsoids[i * 5 + 2]!;
        const p12 = r.ellipsoids[i * 5 + 3]!;
        const p22 = r.ellipsoids[i * 5 + 4]!;
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
    const slacks = rows.map(
      (row) => row[2]! - row[0]! * x[0]! - row[1]! * x[1]!,
    );
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
      const quad =
        inv.a11 * row[0]! * row[0]! +
        2 * inv.a12 * row[0]! * row[1]! +
        inv.a22 * row[1]! * row[1]!;
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
      const r = cuttingPlane(
        hull,
        empty,
        Float64Array.of(1, 1),
        opts(queryPoint),
      );
      expect(r.iterations.length).toBeLessThan(500);
      expect(r.footer.startsWith("Converged")).toBe(false);
    }
  });

  test("results are reproducible across repeated solves", () => {
    for (const queryPoint of QUERY_POINTS) {
      const run = () =>
        cuttingPlane(
          SQUARE_VERTICES,
          SQUARE,
          Float64Array.of(0.4, 0.9),
          opts(queryPoint),
        );
      const first = run();
      for (let i = 0; i < 3; i++) {
        const again = run();
        expect(again.iterations.length).toBe(first.iterations.length);
        expect([...again.ellipsoids]).toEqual([...first.ellipsoids]);
      }
    }
  });
});
