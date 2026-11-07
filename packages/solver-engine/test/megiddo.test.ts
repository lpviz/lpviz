import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { megiddo } from "../src/megiddo";
import { simplex } from "../src/simplex";
import { bruteForceOptimum, expectNear, largePolygon, lastIterate, objectiveValue, randomObjective, randomPolygon, SQUARE, STRIP } from "./fixtures";

const OPTS = { tol: 1e-9 };

describe("megiddo", () => {
  test("finds the square's corner", () => {
    const r = megiddo(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 8);
  });

  test("finds an optimal edge's point when the objective is perpendicular to it", () => {
    const r = megiddo(SQUARE, Float64Array.of(0, 1), OPTS);
    expect(r.status).toBe("optimal");
    expect(lastIterate(r)[1]).toBeCloseTo(-4, 8);
  });

  test("matches brute force on random polygons", () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 200; k++) {
      const poly = randomPolygon(rand);
      if (!poly) continue;
      const c = randomObjective(rand);
      const r = megiddo(poly.constraints, c, OPTS);
      expect(r.status).toBe("optimal");
      expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, poly.hull), 6);
    }
  });

  test("prunes a large polygon in a few rounds", () => {
    const rand = mulberry32(5);
    const { hull, constraints } = largePolygon(rand, 200);
    const c = randomObjective(rand);
    const r = megiddo(constraints, c, OPTS);
    expect(r.status).toBe("optimal");
    expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, hull), 6);
    expect(r.iterates.count).toBeLessThan(30);
  });

  test("matches simplex on random LPs, including empty and unbounded ones", () => {
    const rand = mulberry32(11);
    const seen = new Set<string>();
    for (let k = 0; k < 400; k++) {
      const m = 3 + Math.floor(rand() * 12);
      const constraints: Constraint[] = Array.from({ length: m }, () => [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 0.5]);
      const c = Float64Array.of(rand() * 2 - 1, rand() * 2 - 1);
      const r = megiddo(constraints, c, OPTS);
      let reference;
      try {
        reference = simplex(constraints, c, { tol: 1e-9, dual: false });
      } catch {
        expect(r.status).toBe("infeasible");
        seen.add("infeasible");
        continue;
      }
      expect(r.status).toBe(reference.status!);
      seen.add(r.status!);
      if (r.status === "optimal") expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(objectiveValue(c, lastIterate(reference)), 6);
    }
    expect([...seen].sort()).toEqual(["infeasible", "optimal", "unbounded"]);
  });

  test("reports an unbounded strip", () => {
    expect(megiddo(STRIP, Float64Array.of(1, 1), OPTS).status).toBe("unbounded");
  });

  test("refuses three variables", () => {
    expect(() => megiddo([[1, 0, 0, 1]], Float64Array.of(1, 1, 1), OPTS)).toThrow();
  });
});
