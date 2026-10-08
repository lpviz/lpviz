import { describe, expect, test } from "bun:test";
import { centralPath } from "../src/centralPath";
import { ipm } from "../src/ipm";
import { pdhg } from "../src/pdhg";
import { simplex } from "../src/simplex";
import { PDHG_DEFAULTS, footerOf, ipmOptions, lastIterate, rowsOf } from "./fixtures";
import { BOX, CUBE, expectNear } from "./fixtures3d";

describe.each([
  ["cube, maximize x + y + z", CUBE, [1, 1, 1], [4, 4, 4]],
  ["asymmetric box, maximize x + 2y + 3z", BOX, [1, 2, 3], [1, 2, 3]],
] as const)("3 variables: %s", (_name, constraints, objective, optimum) => {
  const obj = Float64Array.from(objective);

  test("ipm converges to the corner with 3-coordinate iterates and rows", () => {
    const r = ipm(constraints, obj, ipmOptions());
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), optimum, 3);
    const rows = rowsOf(r);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.point.length).toBe(3);
    expect(lastRow.point[2]).toBeCloseTo(optimum[2], 3);
    expect(r.log[0]!.header).toContain(" z ");
  });

  test.each([true, false])("pdhg (ineq %p) converges to the corner", (ineq) => {
    const r = pdhg(constraints, obj, { ...PDHG_DEFAULTS, maxit: 5000, ineq });
    const last = lastIterate(r);
    expect(last.length).toBe(3);
    optimum.forEach((value, j) => expect(Math.abs(last[j]! - value)).toBeLessThanOrEqual(1e-2));
    const rows = rowsOf(r);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.point[2]).toBeCloseTo(last[2]!, 8);
  });

  test.each([false, true])("simplex (dual %p) finds the corner with 3-vector iterates", (dual) => {
    const r = simplex(constraints, obj, { tol: 1e-9, dual });
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), optimum, 6);
  });

  test("centralPath traces to the corner from a given interior point", () => {
    const r = centralPath([], constraints, obj, { niter: 20, interiorPoint: [0, 0, 0] });
    expect(r.iterations.length).toBe(20);
    expect(r.convergence!.length).toBe(20);
    expectNear(lastIterate(r), optimum, 2);
  });
});

test("centralPath rejects an infeasible interior point, and needs one past two variables", () => {
  const obj = Float64Array.of(1, 1, 1);
  expect(() => centralPath([], CUBE, obj, { niter: 10, interiorPoint: [5, 0, 0] })).toThrow(/strictly feasible/i);
  expect(() => centralPath([], CUBE, obj, { niter: 10 })).toThrow(/strictly feasible/i);
});
