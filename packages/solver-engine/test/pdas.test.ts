import { lcg } from "@lpviz/math/random";
import type { Constraint } from "@lpviz/math/types";
import { describe, expect, test } from "bun:test";
import { FALLBACK_MARKER, IDENTIFIED_MARKER, pdas, type PDASOptions, PROX_STEP_MARKER } from "../src/pdas";
import type { SolverResult } from "../src/result";
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

const OPTIONS: PDASOptions = { tol: 1e-6, rho: 0.3, delta: 0.3, shrinkWeights: true, identify: true, maxit: 1000 };
const solve = (constraints: Constraint[], objective: Float64Array, options: Partial<PDASOptions> = {}) => pdas(constraints, objective, { ...OPTIONS, ...options });

const rowsOf = (r: SolverResult) => r.log[0]!.rows as string[];
const footerOf = (r: SolverResult) => r.log[0]!.footer ?? "";
const markerOf = (row: string) => /^\s*\d+(\S?) /.exec(row)![1];

describe("pdas", () => {
  test("reaches the square's optimum and says so", () => {
    const r = solve(SQUARE, Float64Array.of(2, 1));
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 6);
    expect(footerOf(r)).toMatch(/Converged to optimal solution/);
  });

  test.each([0.03, 0.3, 3])("random polygons match the brute-force optimum at ρ = %p", (rho) => {
    const rand = lcg(7);
    let runs = 0;
    for (let t = 0; t < 120 && runs < 50; t++) {
      const polygon = t % 2 ? randomPolygon(rand) : largePolygon(rand, 30);
      if (!polygon) continue;
      const obj = randomObjective(rand);
      if (Math.abs(obj[0]!) + Math.abs(obj[1]!) < 0.1) continue;
      runs++;
      const r = solve(polygon.constraints, obj, { rho });
      expect(r.status).toBe("optimal");
      expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, polygon.hull), 5);
      expectFeasible(polygon.constraints, lastIterate(r), 1e-5);
    }
    expect(runs).toBeGreaterThan(30);
  });

  test.each([
    ["box", BOX, [1, 2, 3]],
    ["sliced box", SLICED_BOX, [1, 1, 1]],
  ] as const)("3 variables: the %s matches brute force", (_box, constraints, objective) => {
    const obj = Float64Array.from(objective);
    const r = solve(constraints, obj);
    expect(r.status).toBe("optimal");
    expect(lastIterate(r).length).toBe(3);
    expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, verticesOf(constraints, 3)), 5);
  });

  test("the path begins at the start, then takes the unconstrained step z + c/ρ", () => {
    const r = solve(SQUARE, Float64Array.of(2, 1), { startPoint: [1, -1] });
    expectNear(iterateAt(r, 0), [1, -1], 12);
    expectNear(iterateAt(r, 1), [1 + 2 / 0.3, -1 + 1 / 0.3], 9);
    expect(r.status).toBe("optimal");
  });

  test("one iterate, one phase and one log row per Newton step, and the markers say how each ended", () => {
    const rand = lcg(3);
    const markers = new Set<string>();
    for (let t = 0; t < 30; t++) {
      const r = solve(largePolygon(rand, 40).constraints, randomObjective(rand));
      expect(r.phases).toBeUndefined();
      expect(rowsOf(r).length).toBe(r.iterates.count);
      for (const row of rowsOf(r)) markers.add(markerOf(row)!);
    }
    // plain Newton steps, solved subproblems and identified vertices all occur
    expect(markers).toContain("");
    expect(markers).toContain(PROX_STEP_MARKER);
    expect(markers).toContain(IDENTIFIED_MARKER);
    for (const marker of markers) expect(["", PROX_STEP_MARKER, IDENTIFIED_MARKER, FALLBACK_MARKER]).toContain(marker);
  });

  test("a cycling subproblem is finished by Lawson-Hanson, and the run still reaches the optimum", () => {
    const rand = lcg(1);
    let fallbacks = 0;
    for (let t = 0; t < 80; t++) {
      const polygon = t % 2 ? randomPolygon(rand) : largePolygon(rand, 30);
      if (!polygon) continue;
      const obj = randomObjective(rand);
      const r = solve(polygon.constraints, obj, { rho: 0.03 });
      if (!rowsOf(r).some((row) => markerOf(row) === FALLBACK_MARKER)) continue;
      fallbacks++;
      expect(footerOf(r)).toMatch(/Lawson-Hanson/);
      // a fallback ends on the subproblem's solution, recorded as the step the centers take
      const markers = rowsOf(r).map(markerOf);
      markers.forEach((marker, i) => {
        if (marker === FALLBACK_MARKER && i + 1 < markers.length) expect([FALLBACK_MARKER, PROX_STEP_MARKER]).toContain(markers[i + 1]!);
      });
      expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, polygon.hull), 5);
    }
    expect(fallbacks).toBeGreaterThan(0);
  });

  test("an objective along the strip is unbounded", () => {
    const r = solve([...STRIP, [0, -1, 5]], Float64Array.of(0.3, 1));
    expect(r.status).toBe("unbounded");
    expect(footerOf(r)).toMatch(/unbounded/);
  });

  test("shrinking weights do not hold off the unbounded certificate", () => {
    // the halved weights double each step: compared raw, steps never repeat until the weights bottom out
    const r = solve(STRIP, Float64Array.of(1, 1), { tol: 1e-7 });
    expect(r.status).toBe("unbounded");
    expect(Math.max(...Array.from(r.iterates.points, Math.abs))).toBeLessThan(1e4);
  });

  test("the iteration cap stops the run without claiming optimality", () => {
    const r = solve(largePolygon(lcg(4), 40).constraints, Float64Array.of(1, 0.2), { maxit: 2 });
    expect(r.iterates.count).toBe(2);
    expect(r.status).toBeUndefined();
    expect(footerOf(r)).toMatch(/Did not converge/);
  });

  test.each([
    ["without identification, ending on the KKT residual", { identify: false }, IDENTIFIED_MARKER],
    ["without shrinking the weights", { shrinkWeights: false }, null],
    ["with a dual weight apart from the primal one", { delta: 0.05 }, null],
  ] as const)("still reaches the optimum %s", (_name, options, absentMarker) => {
    const rand = lcg(17);
    for (let t = 0; t < 15; t++) {
      const { constraints, hull } = largePolygon(rand, 30);
      const obj = randomObjective(rand);
      const r = solve(constraints, obj, { ...options, maxit: 20_000 });
      expect(r.status).toBe("optimal");
      expect(objectiveValue(obj, lastIterate(r))).toBeCloseTo(bruteForceOptimum(obj, hull), 4);
      if (absentMarker) expect(rowsOf(r).some((row) => markerOf(row) === absentMarker)).toBe(false);
    }
  });
});

test("an empty region with shrinking weights stops instead of throwing", () => {
  // x <= 1 and x >= 2: the weights halve toward zero and the Newton system turns singular
  const empty: Constraint[] = [
    [1, 0, 1],
    [-1, 0, -2],
    [0, 1, 1],
    [0, -1, 1],
  ];
  const r = solve(empty, Float64Array.of(1, 1));
  expect(r.status).toBeUndefined();
  expect(r.log[0]!.footer).not.toMatch(/^Converged/m);
});
