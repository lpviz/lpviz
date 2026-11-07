import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@lpviz/math/random";
import { affineScaling } from "../src/affineScaling";
import { BOX, bruteForceOptimum, CUBE, expectNear, footerOf, lastIterate, objectiveValue, randomObjective, randomPolygon, SQUARE, STRIP } from "./fixtures";

const options = (projective: boolean, alphaMax = 0.9) => ({ tol: 1e-7, maxit: 2000, alphaMax, projective });

describe.each([
  ["affine scaling", false],
  ["Karmarkar", true],
] as const)("%s", (_, projective) => {
  test("converges to the square's corner", () => {
    const r = affineScaling(SQUARE, Float64Array.of(1, 1), options(projective));
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [-4, -4], 4);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = affineScaling(constraints, Float64Array.of(1, 1, 1), options(projective));
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [...corner], 4);
  });

  test("matches brute force on random polygons", () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 60; k++) {
      const poly = randomPolygon(rand);
      if (!poly) continue;
      const c = randomObjective(rand);
      const r = affineScaling(poly.constraints, c, options(projective));
      expect(footerOf(r).startsWith("Converged")).toBe(true);
      expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, poly.hull), 4);
    }
  });

  test("stays strictly inside the region and draws a Dikin ellipse per iterate", () => {
    const r = affineScaling(SQUARE, Float64Array.of(1, 0.3), options(projective));
    expect(r.ellipsoids!.count).toBe(r.iterates.count);
    for (let i = 0; i < r.iterates.count; i++) {
      const [x, y] = r.iterates.points.subarray(i * 2, i * 2 + 2);
      expect(x! > -6 && x! < -4 && y! > -6 && y! < -4).toBe(true);
    }
  });

  test("reports an unbounded strip", () => {
    const r = affineScaling(STRIP, Float64Array.of(1, 1), options(projective));
    expect(footerOf(r)).toContain("unbounded");
  });
});
