import { describe, expect, test } from "bun:test";
import { centralPath } from "../src/centralPath";
import { ipm } from "../src/ipm";
import { pdhg } from "../src/pdhg";
import { simplex } from "../src/simplex";

// cube centered at the origin: |x| <= 4, |y| <= 4, |z| <= 4
const CUBE = [
  [1, 0, 0, 4],
  [-1, 0, 0, 4],
  [0, 1, 0, 4],
  [0, -1, 0, 4],
  [0, 0, 1, 4],
  [0, 0, -1, 4],
];

// asymmetric box: x in [-2, 1], y in [-3, 2], z in [-4, 3]
const BOX = [
  [1, 0, 0, 1],
  [-1, 0, 0, 2],
  [0, 1, 0, 2],
  [0, -1, 0, 3],
  [0, 0, 1, 3],
  [0, 0, -1, 4],
];

const pdhgDefaults = {
  halpern: false,
  maxit: 5000,
  eta: 0.25,
  tau: 0.25,
  tol: 1e-4,
  verbose: false,
  colorByBasis: false,
};

const simplexOpts = (dual: boolean) => ({ tol: 1e-9, verbose: false, dual });

const ipmOpts = {
  eps_p: 1e-6,
  eps_d: 1e-6,
  eps_opt: 1e-6,
  maxit: 200,
  alphaMax: 0.9,
  correctorThreshold: 0.9,
  verbose: false,
};

describe("3d cube, maximize x + y + z (optimum (4,4,4), obj 12)", () => {
  const obj = Float64Array.of(1, 1, 1);

  test("ipm converges to the cube corner", () => {
    const r = ipm(CUBE, obj, ipmOpts);
    const sol = r.iterates.solution;
    expect(sol.footer!.startsWith("Converged")).toBe(true);
    const last = sol.x[sol.x.length - 1]!;
    expect(last.length).toBe(3);
    expect(last[0]!).toBeCloseTo(4, 3);
    expect(last[1]!).toBeCloseTo(4, 3);
    expect(last[2]!).toBeCloseTo(4, 3);
    const lastRow = sol.rows[sol.rows.length - 1]!;
    expect(lastRow.z).toBeCloseTo(4, 3);
    expect(lastRow.objective).toBeCloseTo(12, 3);
  });

  test("pdhg ineq mode converges to the cube corner", () => {
    const r = pdhg(CUBE, obj, { ...pdhgDefaults, ineq: true });
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last.length).toBe(3);
    expect(Math.abs(last[0]! - 4)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[1]! - 4)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[2]! - 4)).toBeLessThanOrEqual(1e-2);
    const lastRow = r.rows[r.rows.length - 1]!;
    expect(lastRow.z!).toBeCloseTo(last[2]!, 8);
  });

  test("pdhg eq mode converges to the cube corner", () => {
    const r = pdhg(CUBE, obj, { ...pdhgDefaults, ineq: false });
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last.length).toBe(3);
    expect(Math.abs(last[0]! - 4)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[1]! - 4)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[2]! - 4)).toBeLessThanOrEqual(1e-2);
    const lastRow = r.rows[r.rows.length - 1]!;
    expect(lastRow.z!).toBeCloseTo(last[2]!, 8);
  });

  test("simplex primal and dual find the cube corner with 3-vector iterates", () => {
    for (const dual of [false, true]) {
      const r = simplex(CUBE, obj, simplexOpts(dual));
      expect(r.status).toBe("optimal");
      const last = r.iterations[r.iterations.length - 1]!;
      expect(last.length).toBe(3);
      expect(last[0]!).toBeCloseTo(4, 6);
      expect(last[1]!).toBeCloseTo(4, 6);
      expect(last[2]!).toBeCloseTo(4, 6);
    }
  });

  test("centralPath with an interior point traces to the cube corner", () => {
    const r = centralPath([], CUBE, obj, {
      niter: 20,
      verbose: false,
      interiorPoint: [0, 0, 0],
    });
    expect(r.iterations.length).toBe(20);
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last.length).toBe(4);
    expect(last[0]!).toBeCloseTo(4, 2);
    expect(last[1]!).toBeCloseTo(4, 2);
    expect(last[2]!).toBeCloseTo(4, 2);
  });

  test("centralPath rejects an infeasible interior point", () => {
    expect(() =>
      centralPath([], CUBE, obj, {
        niter: 10,
        verbose: false,
        interiorPoint: [5, 0, 0],
      }),
    ).toThrow(/strictly feasible/i);
  });
});

describe("3d asymmetric box, maximize x + 2y + 3z (optimum (1,2,3), obj 14)", () => {
  const obj = Float64Array.of(1, 2, 3);

  test("ipm converges to (1,2,3)", () => {
    const r = ipm(BOX, obj, ipmOpts);
    const sol = r.iterates.solution;
    expect(sol.footer!.startsWith("Converged")).toBe(true);
    const last = sol.x[sol.x.length - 1]!;
    expect(last[0]!).toBeCloseTo(1, 3);
    expect(last[1]!).toBeCloseTo(2, 3);
    expect(last[2]!).toBeCloseTo(3, 3);
  });

  test("pdhg ineq mode converges to (1,2,3)", () => {
    const r = pdhg(BOX, obj, { ...pdhgDefaults, ineq: true });
    const last = r.iterations[r.iterations.length - 1]!;
    expect(Math.abs(last[0]! - 1)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[1]! - 2)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[2]! - 3)).toBeLessThanOrEqual(1e-2);
  });

  test("pdhg eq mode converges to (1,2,3)", () => {
    const r = pdhg(BOX, obj, { ...pdhgDefaults, ineq: false });
    const last = r.iterations[r.iterations.length - 1]!;
    expect(Math.abs(last[0]! - 1)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[1]! - 2)).toBeLessThanOrEqual(1e-2);
    expect(Math.abs(last[2]! - 3)).toBeLessThanOrEqual(1e-2);
  });

  test("simplex primal and dual find (1,2,3)", () => {
    for (const dual of [false, true]) {
      const r = simplex(BOX, obj, simplexOpts(dual));
      expect(r.status).toBe("optimal");
      const last = r.iterations[r.iterations.length - 1]!;
      expect(last.length).toBe(3);
      expect(last[0]!).toBeCloseTo(1, 6);
      expect(last[1]!).toBeCloseTo(2, 6);
      expect(last[2]!).toBeCloseTo(3, 6);
      const got = obj[0]! * last[0]! + obj[1]! * last[1]! + obj[2]! * last[2]!;
      expect(got).toBeCloseTo(14, 6);
    }
  });

  test("centralPath with an interior point traces to (1,2,3)", () => {
    const r = centralPath([], BOX, obj, {
      niter: 20,
      verbose: false,
      interiorPoint: [0, 0, 0],
    });
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last.length).toBe(4);
    expect(last[0]!).toBeCloseTo(1, 2);
    expect(last[1]!).toBeCloseTo(2, 2);
    expect(last[2]!).toBeCloseTo(3, 2);
  });
});
