import { describe, expect, test } from "bun:test";
import { cuttingPlane, type QueryPoint } from "../src/cuttingPlane";
import { ellipsoid, ellipsoidStride } from "../src/ellipsoid";

// Three-variable regions as half-spaces [a1, a2, a3, b] (a'x <= b).
const BOX = [
  [1, 0, 0, 3],
  [-1, 0, 0, 1],
  [0, 1, 0, 2],
  [0, -1, 0, 2],
  [0, 0, 1, 4],
  [0, 0, -1, 0],
];
// the box with one corner sliced off, so a random objective can land on a
// non-axis-aligned facet
const SLICED = [...BOX, [1, 1, 1, 6]];

// Brute-force vertex enumeration: every feasible intersection of three planes.
function verticesOf(planes: number[][]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < planes.length; i++)
    for (let j = i + 1; j < planes.length; j++)
      for (let k = j + 1; k < planes.length; k++) {
        const [a, b, c] = [planes[i]!, planes[j]!, planes[k]!];
        const det =
          a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) -
          a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) +
          a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
        if (Math.abs(det) < 1e-9) continue;
        const rhs = [a[3]!, b[3]!, c[3]!];
        const col = (m: number) => {
          const r = [a, b, c].map((p) => p.slice(0, 3) as number[]);
          for (let t = 0; t < 3; t++) r[t]![m] = rhs[t]!;
          return (
            r[0]![0]! * (r[1]![1]! * r[2]![2]! - r[1]![2]! * r[2]![1]!) -
            r[0]![1]! * (r[1]![0]! * r[2]![2]! - r[1]![2]! * r[2]![0]!) +
            r[0]![2]! * (r[1]![0]! * r[2]![1]! - r[1]![1]! * r[2]![0]!)
          );
        };
        const p = [col(0) / det, col(1) / det, col(2) / det];
        const feasible = planes.every(
          (q) => q[0]! * p[0]! + q[1]! * p[1]! + q[2]! * p[2]! <= q[3]! + 1e-7,
        );
        if (feasible && !out.some((v) => Math.hypot(v[0]! - p[0]!, v[1]! - p[1]!, v[2]! - p[2]!) < 1e-7)) {
          out.push(p);
        }
      }
  return out;
}

const QUERY_POINTS: QueryPoint[] = ["chebyshev", "analytic", "volumetric"];
const shared = { maxit: 2000, tol: 1e-6, rayShoot: true, initialScale: 1.5, verbose: false };
const lcg = (seed: number) => () =>
  (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const value = (c: Float64Array, p: ArrayLike<number>) =>
  c[0]! * p[0]! + c[1]! * p[1]! + c[2]! * p[2]!;
const feasible = (planes: number[][], p: ArrayLike<number>) =>
  planes.every((q) => q[0]! * p[0]! + q[1]! * p[1]! + q[2]! * p[2]! <= q[3]! + 1e-6);

describe("ellipsoid family in three variables", () => {
  for (const [name, planes] of [["box", BOX], ["sliced box", SLICED]] as const) {
    const vertices = verticesOf(planes);
    test(`ellipsoid method finds the optimum of the ${name}`, () => {
      const rand = lcg(11);
      for (let t = 0; t < 12; t++) {
        const c = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2);
        const expected = Math.max(...vertices.map((v) => value(c, v)));
        const r = ellipsoid(vertices, planes, c, { ...shared, deepCuts: true });
        expect(r.footer.startsWith("Converged")).toBe(true);
        const last = r.iterations[r.iterations.length - 1]!;
        expect(last.length).toBe(3);
        expect(feasible(planes, last)).toBe(true);
        expect(value(c, last)).toBeCloseTo(expected, 3);
        // packed layout: centre (3) + upper triangle of P (6)
        expect(r.ellipsoidStride).toBe(ellipsoidStride(3));
        expect(r.ellipsoids.length).toBe(r.iterations.length * 9);
        expect(r.rows[0]!.z).toBeDefined();
        expect(r.header).toContain(" z ");
      }
    });

    test(`every query point finds the optimum of the ${name}`, () => {
      const rand = lcg(23);
      for (let t = 0; t < 6; t++) {
        const c = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2);
        const expected = Math.max(...vertices.map((v) => value(c, v)));
        for (const queryPoint of QUERY_POINTS) {
          const r = cuttingPlane(vertices, planes, c, { ...shared, queryPoint });
          const last = r.iterations[r.iterations.length - 1]!;
          expect(last.length).toBe(3);
          expect(feasible(planes, last)).toBe(true);
          expect(value(c, last)).toBeCloseTo(expected, 3);
          // the localizing set is emitted as half-spaces (stride 4) in 3D and
          // only ever gains cuts, starting from the six faces of the box
          expect(r.polygonStride).toBe(4);
          const counts = Array.from({ length: r.polygonOffsets.length - 1 }, (_, i) => r.polygonOffsets[i + 1]! - r.polygonOffsets[i]!);
          expect(counts[0]).toBe(6);
          expect(Math.max(...counts)).toBeGreaterThan(6);
        }
      }
    });
  }

  test("the 2-variable packed layout is unchanged", () => {
    expect(ellipsoidStride(2)).toBe(5);
    const square = [[1, 0, -4], [-1, 0, 6], [0, 1, -4], [0, -1, 6]];
    const corners = [[-6, -6], [-4, -6], [-4, -4], [-6, -4]];
    const r = ellipsoid(corners, square, Float64Array.of(1, 1), { ...shared, deepCuts: true });
    expect(r.ellipsoidStride).toBe(5);
    expect(r.rows[0]!.z).toBeUndefined();
    const q = cuttingPlane(corners, square, Float64Array.of(1, 1), { ...shared, queryPoint: "analytic" });
    expect(q.polygonStride).toBe(2);
  });
});
