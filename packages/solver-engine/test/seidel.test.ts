import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { seidel } from "../src/seidel";
import { simplex } from "../src/simplex";
import { BOX, bruteForceOptimum, CUBE, expectNear, lastIterate, objectiveValue, randomObjective, randomPolygon, SQUARE } from "./fixtures";

const OPTS = { tol: 1e-9, seed: 1 };

describe("seidel", () => {
  test("finds the square's corner", () => {
    const r = seidel(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 9);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("finds the %s corner in 3D", (_, constraints, corner) => {
    const r = seidel(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [...corner], 9);
  });

  test("one iterate per row, after the box corner", () => {
    const r = seidel(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.iterates.count).toBe(SQUARE.length + 1);
  });

  test("matches brute force on random polygons, for any seed", () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 60; k++) {
      const poly = randomPolygon(rand);
      if (!poly) continue;
      const c = randomObjective(rand);
      const r = seidel(poly.constraints, c, { tol: 1e-9, seed: k });
      expect(r.status).toBe("optimal");
      expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, poly.hull), 6);
    }
  });

  test("matches simplex on random 3D LPs", () => {
    const rand = mulberry32(11);
    let checked = 0;
    for (let k = 0; k < 200; k++) {
      const m = 4 + Math.floor(rand() * 10);
      const constraints: Constraint[] = Array.from({ length: m }, () => [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 0.5]);
      const c = Float64Array.of(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      const r = seidel(constraints, c, { tol: 1e-9, seed: k });
      let reference;
      try {
        reference = simplex(constraints, c, { tol: 1e-9, dual: false });
      } catch {
        expect(r.status).toBe("infeasible");
        continue;
      }
      expect(r.status).toBe(reference.status!);
      if (r.status === "optimal") {
        expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(objectiveValue(c, lastIterate(reference)), 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  test("reports an infeasible LP", () => {
    const infeasible: Constraint[] = [
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, -1, 1],
    ];
    expect(seidel(infeasible, Float64Array.of(1, 1), OPTS).status).toBe("infeasible");
  });

  test("reports an unbounded LP", () => {
    const strip: Constraint[] = [
      [0, 1, 1],
      [0, -1, 1],
    ];
    expect(seidel(strip, Float64Array.of(1, 0), OPTS).status).toBe("unbounded");
  });
});
