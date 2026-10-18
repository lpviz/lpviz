import { boxRows } from "@lpviz/math/lp";
import { lcg } from "@lpviz/math/random";
import type { Constraint } from "@lpviz/math/types";
import { describe, expect, test } from "bun:test";
import { crissCross, type CrissCrossOptions, defaultStartVertex } from "../src/crissCross";
import type { SolverResult } from "../src/result";
import { firstIndependentRows } from "../src/vertexBasis";
import { denseFromConstraints } from "@lpviz/math/blas";
import {
  BOX,
  bruteForceOptimum,
  expectFeasible,
  expectNear,
  iterateAt,
  largePolygon,
  lastIterate,
  objectiveValue,
  randomObjective,
  randomPolygon,
  SLICED_BOX,
  SQUARE,
  STRIP,
  verticesOf,
} from "./fixtures";

const TOL = 1e-9;

const solve = (constraints: Constraint[], objective: Float64Array, options: Partial<CrissCrossOptions> = {}) => crissCross(constraints, objective, { tol: TOL, maxit: 10_000, ...options });

// by how much the point breaks the worst row (negative inside)
const worstExcess = (constraints: readonly Constraint[], point: ArrayLike<number>) => Math.max(...constraints.map((row) => row[0] * point[0]! + row[1] * point[1]! - row[2]));

const rowsOf = (r: SolverResult) => r.log[0]!.rows as string[];
const footerOf = (r: SolverResult) => r.log[0]!.footer ?? "";

describe("criss-cross", () => {
  test("reaches the square's optimum, ending on a feasible vertex", () => {
    const r = solve(SQUARE, Float64Array.of(2, 1));
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 9);
    expect(worstExcess(SQUARE, lastIterate(r))).toBeLessThanOrEqual(1e-9);
    expect(footerOf(r)).toMatch(/^Optimal/);
  });

  test("random polygons match the brute-force optimum", () => {
    const rand = lcg(7);
    let runs = 0;
    for (let t = 0; t < 120 && runs < 50; t++) {
      const polygon = randomPolygon(rand);
      if (!polygon) continue;
      const obj = randomObjective(rand);
      if (Math.abs(obj[0]!) + Math.abs(obj[1]!) < 0.1) continue;
      runs++;
      const r = solve(polygon.constraints, obj);
      expect(r.status).toBe("optimal");
      expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, polygon.hull), 6);
      expectFeasible(polygon.constraints, lastIterate(r), 1e-7);
    }
    expect(runs).toBeGreaterThan(30);
  });

  test("one iterate, one phase and one log row per basis", () => {
    const { constraints } = largePolygon(lcg(3), 40);
    const r = solve(constraints, Float64Array.of(1, 3));
    expect(r.phases).toBeUndefined();
    expect(rowsOf(r).length).toBe(r.iterates.count);
    // every iterate is the vertex where its two listed rows meet
    rowsOf(r).forEach((row, i) => {
      const tight = row
        .trim()
        .split(/\s+/)
        .at(-1)!
        .split(",")
        .map((k) => constraints[Number(k) - 1]!);
      const point = iterateAt(r, i);
      for (const [a1, a2, b] of tight) expect(a1 * point[0]! + a2 * point[1]!).toBeCloseTo(b, 9);
    });
  });

  test("the walk leaves the region: some iterate on a large polygon is infeasible", () => {
    const rand = lcg(5);
    const anyInfeasible = Array.from({ length: 10 }, () => {
      const { constraints } = largePolygon(rand, 30);
      const r = solve(constraints, randomObjective(rand));
      return Array.from({ length: r.iterates.count }, (_, i) => worstExcess(constraints, iterateAt(r, i))).some((excess) => excess > 1e-6);
    }).some(Boolean);
    expect(anyInfeasible).toBe(true);
  });

  test("an objective along the strip is unbounded", () => {
    // the strip plus a floor, so the rows have a vertex
    const r = solve([...STRIP, [0, -1, 5]], Float64Array.of(0, 1));
    expect(r.status).toBe("unbounded");
    expect(footerOf(r)).toMatch(/Unbounded LP$/);
  });

  test("an empty region is reported infeasible", () => {
    // x <= 1, x >= 2 and y between them
    const r = solve([...boxRows([2, -1], [1, 1])], Float64Array.of(1, 1));
    expect(r.status).toBe("infeasible");
  });

  test("rows with no vertex are an error, not a wrong answer", () => {
    expect(() => solve(STRIP, Float64Array.of(1, 0))).toThrow(/linearly independent/);
  });

  test.each([
    ["box", BOX, [1, 2, 3]],
    ["sliced box", SLICED_BOX, [1, 1, 1]],
  ] as const)("3 variables: the %s matches brute force", (_box, constraints, objective) => {
    const obj = Float64Array.from(objective);
    const r = solve(constraints, obj);
    expect(r.status).toBe("optimal");
    expect(lastIterate(r).length).toBe(3);
    expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, verticesOf(constraints, 3)), 8);
  });

  test("the highest-first order takes another route to the same optimum", () => {
    const rand = lcg(21);
    let differed = 0;
    for (let t = 0; t < 20; t++) {
      const { constraints, hull } = largePolygon(rand, 30);
      const obj = randomObjective(rand);
      const low = solve(constraints, obj);
      const high = solve(constraints, obj, { order: "last" });
      expect(high.status).toBe("optimal");
      expect(objectiveValue(obj, lastIterate(high))).toBeCloseTo(bruteForceOptimum(obj, hull), 6);
      if (rowsOf(low).join() !== rowsOf(high).join()) differed++;
    }
    expect(differed).toBeGreaterThan(10);
  });

  test.each(["first", "last"] as const)("without a start, the path begins at the default start vertex (%s first)", (order) => {
    const { constraints } = largePolygon(lcg(8), 20);
    const r = solve(constraints, Float64Array.of(1, 2), { order });
    expectNear(iterateAt(r, 0), Array.from(defaultStartVertex(constraints, order)!), 9);
  });

  test("a start vertex is the first basis; a point that is not a vertex falls back to the first rows", () => {
    const fromVertex = solve(SQUARE, Float64Array.of(2, 1), { startVertex: [-6, -4] });
    expectNear(iterateAt(fromVertex, 0), [-6, -4], 12);
    expect(fromVertex.status).toBe("optimal");
    const fromInterior = solve(SQUARE, Float64Array.of(2, 1), { startVertex: [-5, -5] });
    expectNear(iterateAt(fromInterior, 0), Array.from(iterateAt(solve(SQUARE, Float64Array.of(2, 1)), 0)), 12);
  });

  test("the iteration cap stops the walk without claiming optimality", () => {
    const { constraints } = largePolygon(lcg(4), 60);
    const r = solve(constraints, Float64Array.of(-1, -0.3), { maxit: 2 });
    expect(r.iterates.count).toBe(2);
    expect(r.status).toBeUndefined();
    expect(footerOf(r)).toMatch(/Did not converge/);
  });
});

test("the start is the lowest-index independent rows", () => {
  expect(
    firstIndependentRows(
      denseFromConstraints([
        [1, 0, 1],
        [2, 0, 3],
        [0, 1, 1],
      ]).A,
    ),
  ).toEqual([0, 2]);
  expect(firstIndependentRows(denseFromConstraints(STRIP).A)).toBeNull();
});
