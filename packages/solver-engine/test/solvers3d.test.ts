import { describe, expect, test } from "bun:test";
import type { Lines } from "@lpviz/math/types";
import { centralPath } from "../src/centralPath";
import { ipm } from "../src/ipm";
import { pdhg } from "../src/pdhg";
import { simplex } from "../src/simplex";
import { footerOf, lastIterate, rowsOf } from "./fixtures";

// Three-variable regions as half-spaces [a1, a2, a3, b] (a'x <= b).
// cube centered at the origin: |x| <= 4, |y| <= 4, |z| <= 4
const CUBE: Lines = [
  [1, 0, 0, 4],
  [-1, 0, 0, 4],
  [0, 1, 0, 4],
  [0, -1, 0, 4],
  [0, 0, 1, 4],
  [0, 0, -1, 4],
];

// asymmetric box: x in [-2, 1], y in [-3, 2], z in [-4, 3]
const BOX: Lines = [
  [1, 0, 0, 1],
  [-1, 0, 0, 2],
  [0, 1, 0, 2],
  [0, -1, 0, 3],
  [0, 0, 1, 3],
  [0, 0, -1, 4],
];

const pdhgDefaults = { halpern: false, maxit: 5000, eta: 0.25, tau: 0.25, tol: 1e-4, colorByBasis: false };
const ipmOpts = { eps_p: 1e-6, eps_d: 1e-6, eps_opt: 1e-6, maxit: 200, alphaMax: 0.9, correctorThreshold: 0.9 };

const expectNear = (point: ArrayLike<number>, expected: number[], digits: number) => {
  expect(point.length).toBe(expected.length);
  expected.forEach((value, j) => expect(point[j]!).toBeCloseTo(value, digits));
};

describe.each([
  ["cube, maximize x + y + z", CUBE, [1, 1, 1], [4, 4, 4]],
  ["asymmetric box, maximize x + 2y + 3z", BOX, [1, 2, 3], [1, 2, 3]],
] as const)("3 variables: %s", (_name, lines, objective, optimum) => {
  const obj = Float64Array.from(objective);

  test("ipm converges to the corner with 3-coordinate iterates and rows", () => {
    const r = ipm(lines, obj, ipmOpts);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [...optimum], 3);
    const rows = rowsOf(r);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.point.length).toBe(3);
    expect(lastRow.point[2]).toBeCloseTo(optimum[2], 3);
    expect(r.log[0]!.header).toContain(" z ");
  });

  test.each([true, false])("pdhg (ineq %p) converges to the corner", (ineq) => {
    const r = pdhg(lines, obj, { ...pdhgDefaults, ineq });
    const last = lastIterate(r);
    expect(last.length).toBe(3);
    optimum.forEach((value, j) => expect(Math.abs(last[j]! - value)).toBeLessThanOrEqual(1e-2));
    const rows = rowsOf(r);
    const lastRow = rows[rows.length - 1]!;
    expect(lastRow.point[2]).toBeCloseTo(last[2]!, 8);
  });

  test.each([false, true])("simplex (dual %p) finds the corner with 3-vector iterates", (dual) => {
    const r = simplex(lines, obj, { tol: 1e-9, dual });
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [...optimum], 6);
  });

  test("centralPath traces to the corner from a given interior point", () => {
    const r = centralPath([], lines, obj, { niter: 20, interiorPoint: [0, 0, 0] });
    expect(r.iterations.length).toBe(20);
    expect(r.convergence!.length).toBe(20);
    expectNear(lastIterate(r), [...optimum], 2);
  });
});

test("centralPath rejects an infeasible interior point, and needs one past two variables", () => {
  const obj = Float64Array.of(1, 1, 1);
  expect(() => centralPath([], CUBE, obj, { niter: 10, interiorPoint: [5, 0, 0] })).toThrow(/strictly feasible/i);
  expect(() => centralPath([], CUBE, obj, { niter: 10 })).toThrow(/strictly feasible/i);
});
