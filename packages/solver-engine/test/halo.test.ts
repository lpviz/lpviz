import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { halo } from "../src/halo";
import { simplex } from "../src/simplex";
import { BOX, bruteForceOptimum, CUBE, expectNear, footerOf, lastIterate, objectiveValue, randomObjective, randomPolygon, SLICED_BOX, SQUARE } from "./fixtures";

const OPTS = { maxit: 200, tol: 1e-7, rhoN: 0.01, homogeneous: true };

describe("halo", () => {
  test("converges to the square's corner", () => {
    const r = halo(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [-4, -4], 5);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = halo(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [...corner], 5);
  });

  test("finds the optimum on a slanted facet", () => {
    const objective = Float64Array.of(1, 1.2, 0.9);
    const r = halo(SLICED_BOX, objective, OPTS);
    expect(r.status).toBe("optimal");
    expect(objectiveValue(objective, lastIterate(r))).toBeCloseTo(1 * -2 + 1.2 * 3 + 0.9 * 3, 5);
  });

  test("matches brute force on random polygons", () => {
    const rand = mulberry32(7);
    for (let k = 0; k < 40; k++) {
      const poly = randomPolygon(rand);
      if (!poly) continue;
      const { hull, constraints } = poly;
      const c = randomObjective(rand);
      const r = halo(constraints, c, OPTS);
      expect(r.status).toBe("optimal");
      expect(objectiveValue(c, lastIterate(r))).toBeCloseTo(bruteForceOptimum(c, hull), 4);
    }
  });

  test("certifies an infeasible LP", () => {
    const infeasible: Constraint[] = [
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, -1, 1],
    ];
    const r = halo(infeasible, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("infeasible");
    expect(footerOf(r).startsWith("Certified primal infeasible")).toBe(true);
  });

  test("certifies an unbounded LP", () => {
    const unbounded: Constraint[] = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, -1, 1],
    ];
    const r = halo(unbounded, Float64Array.of(0, 1), OPTS);
    expect(r.status).toBe("unbounded");
  });

  test("starts from an infeasible warm start and draws it first", () => {
    const r = halo(SQUARE, Float64Array.of(1, 0.3), { ...OPTS, startPoint: [3, 7] });
    expect(r.status).toBe("optimal");
    expectNear(r.iterates.points.subarray(0, 2), [3, 7], 9);
    expectNear(lastIterate(r), [-4, -4], 5);
  });

  test("a warm start at the optimum finishes quickly", () => {
    const cold = halo(SQUARE, Float64Array.of(1, 0.3), OPTS);
    const warm = halo(SQUARE, Float64Array.of(1, 0.3), { ...OPTS, startPoint: [-4, -4] });
    expect(warm.status).toBe("optimal");
    expect(warm.iterates.count).toBeLessThanOrEqual(cold.iterates.count);
  });

  test.each([["a large NCP weight", { rhoN: 1 }]] as const)("converges with %s", (_, knobs) => {
    const r = halo(SQUARE, Float64Array.of(1, 0.3), { ...OPTS, ...knobs, startPoint: [3, 7] });
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 5);
  });

  test("measures mu in the recovered point's units, decreasing to the floor", () => {
    const r = halo(SQUARE, Float64Array.of(1, 0.3), { ...OPTS, startPoint: [3, 7] });
    const mu = r.convergence!;
    // tau = 1 at the start, so the first is the raw measure; tau grows past 20 on the way
    expect(mu[0]).toBeGreaterThan(1);
    expect(mu[mu.length - 1]!).toBeLessThan(1e-12);
    for (let i = 1; i < mu.length; i++) expect(mu[i]!).toBeLessThan(mu[i - 1]!);
  });
});

describe("halo on badly scaled LPs", () => {
  // right-hand sides up to ~1e3 and rows that are not unit length: before the solver rescaled, the
  // paper's relative complementarity test let such a run stop 1% short of the optimum
  test("matches simplex", () => {
    const rand = mulberry32(484);
    for (let k = 0; k < 30; k++) {
      const n = 2 + (k % 2);
      const rows: Constraint[] = Array.from({ length: n + 3 }, () => {
        const a = Array.from({ length: n }, () => (rand() * 2 - 1) * 50);
        return [...a, 50 * (1 + rand() * 1000)] as number[] as Constraint;
      });
      const bounds = Array.from({ length: n }, (_, j) => [1, -1].map((sign) => [...Array.from({ length: n }, (_, i) => (i === j ? sign : 0)), 2000] as number[] as Constraint)).flat();
      const constraints = [...rows, ...bounds];
      const c = randomObjective(rand, n);
      const r = halo(constraints, c, OPTS);
      const reference = simplex(constraints, c, { tol: 1e-9, dual: false, enteringRule: "first", leavingRule: "first" });
      expect(r.status).toBe("optimal");
      const optimum = objectiveValue(c, lastIterate(reference));
      expect(Math.abs(objectiveValue(c, lastIterate(r)) - optimum) / (1 + Math.abs(optimum))).toBeLessThan(1e-5);
    }
  });
});

describe("halo without the homogeneous embedding (ODYN on the LP)", () => {
  const ODYN = { ...OPTS, homogeneous: false };

  test("converges to the square's corner from an infeasible start", () => {
    const r = halo(SQUARE, Float64Array.of(1, 0.3), { ...ODYN, startPoint: [3, 7] });
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 5);
  });

  test("certifies an infeasible LP from its Newton directions", () => {
    const r = halo(
      [
        [1, 0, -1],
        [-1, 0, -1],
        [0, 1, 1],
        [0, -1, 1],
      ],
      Float64Array.of(1, 1),
      ODYN,
    );
    expect(r.status).toBe("infeasible");
  });

  test("certifies an unbounded LP from its Newton directions", () => {
    const r = halo(
      [
        [1, 0, 1],
        [-1, 0, 1],
        [0, -1, 1],
      ],
      Float64Array.of(0, 1),
      ODYN,
    );
    expect(r.status).toBe("unbounded");
  });
});
