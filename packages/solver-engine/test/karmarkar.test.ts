import { describe, expect, test } from "bun:test";
import { mulberry32 } from "@lpviz/math/random";
import { karmarkar } from "../src/karmarkar";
import { BOX, bruteForceOptimum, CUBE, expectNear, footerOf, lastIterate, objectiveValue, randomObjective, randomPolygon, SQUARE, STRIP } from "./fixtures";

const OPTS = { tol: 1e-7, maxit: 2000, alphaMax: 0.9 };

describe("karmarkar", () => {
  test("converges to the square's corner", () => {
    const r = karmarkar(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [-4, -4], 4);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = karmarkar(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [...corner], 4);
  });

  test("matches brute force on random polygons", () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 60; k++) {
      const poly = randomPolygon(rand);
      if (!poly) continue;
      const c = randomObjective(rand);
      const r = karmarkar(poly.constraints, c, OPTS);
      expect(footerOf(r).startsWith("Converged")).toBe(true);
      expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, poly.hull), 4);
    }
  });

  test("stays strictly inside the region and draws a Dikin ellipse per iterate", () => {
    const r = karmarkar(SQUARE, Float64Array.of(1, 0.3), OPTS);
    expect(r.ellipsoids!.count).toBe(r.iterates.count);
    for (let i = 0; i < r.iterates.count; i++) {
      const [x, y] = r.iterates.points.subarray(i * 2, i * 2 + 2);
      expect(x! > -6 && x! < -4 && y! > -6 && y! < -4).toBe(true);
    }
  });

  test("reports an unbounded strip", () => {
    const r = karmarkar(STRIP, Float64Array.of(1, 1), OPTS);
    expect(footerOf(r)).toContain("unbounded");
  });
});
