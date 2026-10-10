import { describe, expect, test } from "bun:test";
import { QUERY_POINTS, cuttingPlane } from "../src/cuttingPlane";
import { ellipsoid } from "../src/ellipsoid";
import { ellipsoidStride, localizingSetStride } from "../src/localization";
import { SQUARE, SQUARE_VERTICES, bruteForceOptimum, footerOf, lastIterate, lcg, objectiveValue, rowsOf } from "./fixtures";
import { BOX, SLICED_BOX, satisfiesAll, verticesOf } from "./fixtures3d";

const shared = { maxit: 2000, tol: 1e-6, rayShoot: true, initialScale: 1.5 };

describe("ellipsoid family in three variables", () => {
  for (const [name, planes] of [
    ["box", BOX],
    ["sliced box", SLICED_BOX],
  ] as const) {
    const vertices = verticesOf(planes);
    test(`ellipsoid method finds the optimum of the ${name}`, () => {
      const rand = lcg(11);
      for (let t = 0; t < 12; t++) {
        const c = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2);
        const r = ellipsoid(vertices, planes, c, { ...shared, deepCuts: true });
        expect(footerOf(r).startsWith("Converged")).toBe(true);
        const last = lastIterate(r);
        expect(last.length).toBe(3);
        expect(satisfiesAll(planes, last)).toBe(true);
        expect(objectiveValue(c, last)).toBeCloseTo(bruteForceOptimum(c, vertices), 3);
        // packed layout: centre (3) + upper triangle of P (6)
        expect(r.ellipsoids!.length).toBe(r.iterates.length * ellipsoidStride(3));
        expect(rowsOf(r)[0]!.point.length).toBe(3);
        expect(r.log[0]!.header).toContain(" z ");
      }
    });

    test(`every query point finds the optimum of the ${name}`, () => {
      const rand = lcg(23);
      for (let t = 0; t < 6; t++) {
        const c = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2, rand() * 4 - 2);
        for (const queryPoint of QUERY_POINTS) {
          const r = cuttingPlane(vertices, planes, c, { ...shared, queryPoint });
          const last = lastIterate(r);
          expect(last.length).toBe(3);
          expect(satisfiesAll(planes, last)).toBe(true);
          expect(objectiveValue(c, last)).toBeCloseTo(bruteForceOptimum(c, vertices), 3);
          // the localizing set is emitted as half-spaces (stride 4) and only ever gains
          // cuts, starting from the six faces of the box
          expect(localizingSetStride(3)).toBe(4);
          const offsets = r.localizingSetOffsets!;
          const counts = Array.from({ length: offsets.length - 1 }, (_, i) => offsets[i + 1]! - offsets[i]!);
          expect(counts[0]).toBe(6);
          expect(Math.max(...counts)).toBeGreaterThan(6);
          expect(r.localizingSetPoints!.length).toBe(offsets[offsets.length - 1]! * 4);
        }
      }
    });
  }

  test("the 2-variable packed layout is unchanged", () => {
    expect(ellipsoidStride(2)).toBe(5);
    expect(localizingSetStride(2)).toBe(2);
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), { ...shared, deepCuts: true });
    expect(r.ellipsoids!.length).toBe(r.iterates.length * 5);
    expect(rowsOf(r)[0]!.point.length).toBe(2);
    const q = cuttingPlane(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), { ...shared, queryPoint: "analytic" });
    expect(q.localizingSetPoints!.length).toBe(q.localizingSetOffsets![q.localizingSetOffsets!.length - 1]! * 2);
  });
});
