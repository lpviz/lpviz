import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { hpdlp } from "../src/hpdlp";
import { pdhg } from "../src/pdhg";
import { BOX, CUBE, expectNear, footerOf, lastIterate, PDHG_DEFAULTS, SLICED_BOX, SQUARE } from "./fixtures";

const OPTS = { maxit: 2000, eta: 0.25, sigma: 0.25, nu: 0.998, adaptiveWeight: true, tol: 1e-6, colorByBasis: false };

describe("hpdlp", () => {
  test("converges to the square's corner", () => {
    const r = hpdlp(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [-4, -4], 4);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = hpdlp(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [...corner], 4);
  });

  test("agrees with pdhg on a slanted facet", () => {
    const objective = Float64Array.of(1, 1.2, 0.9);
    const r = hpdlp(SLICED_BOX, objective, OPTS);
    const reference = pdhg(SLICED_BOX, objective, { ...PDHG_DEFAULTS, ineq: true, halpern: true, maxit: 20000, tol: 1e-8 });
    expect(r.status).toBe("optimal");
    const obj = (p: Float64Array) => p.reduce((s, v, i) => s + v * objective[i]!, 0);
    expect(obj(lastIterate(r))).toBeCloseTo(obj(lastIterate(reference)), 4);
  });

  test("certifies an infeasible LP", () => {
    // x <= -1 and -x <= -1
    const infeasible: Constraint[] = [
      [1, 0, -1],
      [-1, 0, -1],
      [0, 1, 1],
      [0, -1, 1],
    ];
    const r = hpdlp(infeasible, Float64Array.of(1, 1), { ...OPTS, maxit: 20000 });
    expect(r.status).toBe("infeasible");
    expect(footerOf(r).startsWith("Certified primal infeasible")).toBe(true);
  });

  test("certifies an unbounded LP", () => {
    // x <= 1, y free below and unbounded above under max y
    const unbounded: Constraint[] = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, -1, 1],
    ];
    const r = hpdlp(unbounded, Float64Array.of(0, 1), { ...OPTS, maxit: 20000 });
    expect(r.status).toBe("unbounded");
  });

  test("starts from a warm start and records a restart", () => {
    const r = hpdlp(SQUARE, Float64Array.of(1, 0.3), { ...OPTS, startPoint: [1, -2] });
    expect(r.status).toBe("optimal");
    expect(r.restartIndices!.length).toBeGreaterThan(0);
  });
});
