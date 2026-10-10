import { describe, expect, test } from "bun:test";
import type { Constraint, Vec } from "@lpviz/math/types";
import { centralPath } from "../src/centralPath";
import { ellipsoid, type EllipsoidOptions } from "../src/ellipsoid";
import { ipm } from "../src/ipm";
import { pdhg } from "../src/pdhg";
import { ENTERING_RULES, LEAVING_RULES, MAX_CONSECUTIVE_DEGENERATE_PIVOTS, simplex } from "../src/simplex";
import {
  PDHG_DEFAULTS,
  SQUARE,
  SQUARE_VERTICES,
  bruteForceOptimum,
  ellipseAt,
  footerOf,
  ipmOptions,
  largePolygon,
  lastIterate,
  lcg,
  logText,
  objectiveValue,
  phase1Count,
  randomPolygon,
  rowsOf,
} from "./fixtures";

// The square plus x + y <= -8, which passes exactly through the optimum
// (-4, -4) of the objective (2, 1): three constraints meet there, so the ratio test
// ties and the index rules take visibly different routes.
const DEGENERATE_SQUARE: Constraint[] = [...SQUARE, [1, 1, -8]];

// Seven nearly concurrent constraints on which primal simplex with entering rule
// "last" cycles in Phase 1 (found by fuzzing; see the cycling-guard test).
const STALL_LINES: Constraint[] = [
  [-0.9697749358075918, -0.24400117597950474, -3.3722141566558337],
  [-0.9964356544434488, -0.08435630713737943, -3.2387883117373377],
  [-0.9996118936712689, -0.027857889922603827, -3.1719450077092093],
  [-0.6891315307597216, -0.7246362765641553, -3.1456714857769295],
  [-0.29831925841830076, 0.9544661440076098, 1.1470257024838302],
  [-0.6805175119924961, -0.7327318171551874, -3.1296687759153756],
  [-0.977278470566636, -0.2119594087719077, -3.3521836075692066],
];
const STALL_OBJECTIVE = Float64Array.of(-0.04722023010253906, 0.20946311950683594);

// Every explicit entering/leaving pair, plus {} for the engine defaults.
const RULE_COMBOS = ENTERING_RULES.flatMap((enteringRule) => LEAVING_RULES.map((leavingRule) => ({ enteringRule, leavingRule })));
const RULE_OPTIONS = [{}, ...RULE_COMBOS];

// a log row whose iteration number carries the cycling-guard marker, e.g. "  27d"
const GUARDED_ROW = /^\s*\d+d /m;

describe("pdhg", () => {
  test("eq-mode rows report the recovered (x, y), not the split variable", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), { ...PDHG_DEFAULTS, ineq: false });
    const lastRow = rowsOf(r)[rowsOf(r).length - 1]!;
    const last = lastIterate(r);
    expect(lastRow.point[0]).toBeCloseTo(last[0]!, 8);
    expect(lastRow.point[1]).toBeCloseTo(last[1]!, 8);
    expect(lastRow.point[0]).toBeCloseTo(-4, 2);
    expect(lastRow.point[1]).toBeCloseTo(-4, 2);
  });

  test("ineq mode records the converged iterate", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), { ...PDHG_DEFAULTS, ineq: true });
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    const lastRow = rowsOf(r)[rowsOf(r).length - 1]!;
    expect(lastRow.convergence).toBeLessThanOrEqual(1e-4);
    expect(r.iterates.length).toBe(rowsOf(r).length);
    expect(r.iterates.length).toBe(r.convergence!.length);
  });

  test("eq mode stops at the last finite iterate on divergence", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...PDHG_DEFAULTS,
      ineq: false,
      eta: 0.75,
      tau: 0.75,
    });
    expect(footerOf(r).startsWith("Did not converge")).toBe(true);
    const last = lastIterate(r);
    expect(Number.isFinite(last[0]!)).toBe(true);
    expect(Number.isFinite(last[1]!)).toBe(true);
    // the path must not silently collapse to the origin
    expect(Math.hypot(last[0]!, last[1]!)).toBeGreaterThan(1);
  });
});

describe("simplex", () => {
  const opts = (dual: boolean) => ({ tol: 1e-9, dual });

  test("every pivot-rule combination reaches the square optimum in primal and dual mode", () => {
    for (const dual of [false, true]) {
      for (const rules of RULE_OPTIONS) {
        const r = simplex(SQUARE, Float64Array.of(1, 1), { ...opts(dual), ...rules });
        expect(r.status).toBe("optimal");
        const last = lastIterate(r);
        expect(last[0]!).toBeCloseTo(-4, 6);
        expect(last[1]!).toBeCloseTo(-4, 6);
      }
    }
  });

  test("dual mode handles redundant zero rows (vertical strip)", () => {
    // x in [-1, 2], maximize x: the y-column of the dual system is all zeros
    const strip: Constraint[] = [
      [1, 0, 2],
      [-1, 0, 1],
    ];
    const r = simplex(strip, Float64Array.of(1, 0), opts(true));
    expect(r.status).toBe("optimal");
  });

  test("dual mode reports an infeasible primal as infeasible, not unbounded", () => {
    // x <= 1 and x >= 2: empty region
    const empty: Constraint[] = [
      [1, 0, 1],
      [-1, 0, -2],
      [0, 1, 1],
      [0, -1, -2],
    ];
    const r = simplex(empty, Float64Array.of(1, 1), opts(true));
    expect(r.status).toBe("infeasible");
  });

  test("primal mode throws on an infeasible region", () => {
    const empty: Constraint[] = [
      [1, 0, 1],
      [-1, 0, -2],
    ];
    expect(() => simplex(empty, Float64Array.of(1, 0), opts(false))).toThrow(/infeasible/i);
  });

  test("unbounded LP is reported as unbounded in primal mode", () => {
    const strip: Constraint[] = [
      [1, 0, 2],
      [-1, 0, 1],
    ];
    const r = simplex(strip, Float64Array.of(0, 1), opts(false));
    expect(r.status).toBe("unbounded");
  });

  test("random polygons: every pivot rule matches the brute-force optimum", () => {
    const rand = lcg(7);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 25; t++) {
      const polygon = randomPolygon(rand);
      if (!polygon) continue;
      const obj = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      if (Math.abs(obj[0]!) + Math.abs(obj[1]!) < 0.1) continue;
      const expected = bruteForceOptimum(obj, polygon.hull);
      runs++;
      for (const dual of [false, true]) {
        for (const rules of RULE_OPTIONS) {
          const r = simplex(polygon.constraints, obj, { ...opts(dual), ...rules });
          const last = lastIterate(r);
          expect(r.status).toBe("optimal");
          expect(objectiveValue(obj, last)).toBeCloseTo(expected, 5);
          // nondegenerate vertices never need the Bland fallback
          expect(logText(r)).not.toMatch(GUARDED_ROW);
        }
      }
    }
    expect(runs).toBeGreaterThan(10);
  });

  // Regression: a 255-constraint Phase 1 takes a pivot per artificial variable,
  // which used to cost two dense O(m³) solves each — seconds per run. The
  // maintained basis inverse is refactored every REFACTOR_INTERVAL pivots, so
  // this run also crosses that boundary many times and must still land on the optimum.
  test("a 255-gon solves in well under a second and matches brute force", () => {
    const rand = lcg(11);
    const { hull, constraints } = largePolygon(rand, 255);
    const obj = Float64Array.of(7, -1.4);
    const expected = bruteForceOptimum(obj, hull);
    const start = performance.now();
    const r = simplex(constraints, obj, opts(false));
    const elapsed = performance.now() - start;
    expect(r.status).toBe("optimal");
    expect(phase1Count(r)).toBeGreaterThan(200);
    const last = lastIterate(r);
    expect(objectiveValue(obj, last)).toBeCloseTo(expected, 5);
    // ~80ms here; the pre-fix code took ~3s, so this trips on a regression
    // without being sensitive to a slow CI machine
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("simplex pivot rules", () => {
  const opts = { tol: 1e-9, dual: false };

  test("index rules take different routes through a degenerate vertex but agree on the optimum", () => {
    const trajectories = new Map<string, string>();
    for (const rules of RULE_COMBOS) {
      const r = simplex(DEGENERATE_SQUARE, Float64Array.of(2, 1), { ...opts, ...rules });
      expect(r.status).toBe("optimal");
      const last = lastIterate(r);
      expect(last[0]!).toBeCloseTo(-4, 6);
      expect(last[1]!).toBeCloseTo(-4, 6);
      trajectories.set(`${rules.enteringRule}/${rules.leavingRule}`, logText(r));
    }
    // the leaving tie-break alone changes the route (exercising the tie branch) ...
    expect(trajectories.get("first/first")).not.toBe(trajectories.get("first/last"));
    // ... and so does the entering rule
    expect(trajectories.get("first/first")).not.toBe(trajectories.get("last/first"));
    expect(new Set(trajectories.values()).size).toBeGreaterThanOrEqual(3);
  });

  test("unknown rule values fall back to Bland's rule (first/first)", () => {
    // Crafted share URLs can push arbitrary strings into the settings, so the
    // solver must degrade to its default instead of misbehaving. The degenerate
    // fixture makes the rules distinguishable (see the previous test).
    const bogus = simplex(DEGENERATE_SQUARE, Float64Array.of(2, 1), {
      ...opts,
      enteringRule: "bogus" as unknown as "first",
      leavingRule: "bogus" as unknown as "first",
    });
    const bland = simplex(DEGENERATE_SQUARE, Float64Array.of(2, 1), {
      ...opts,
      enteringRule: "first",
      leavingRule: "first",
    });
    expect(bogus.status).toBe("optimal");
    expect(logText(bogus)).toBe(logText(bland));
  });

  test("the cycling guard rescues a rule combination that would otherwise never terminate", () => {
    // With entering rule "last", Phase 1 on STALL_LINES cycles through
    // degenerate pivots until MAX_ITERATIONS without the guard. The region is
    // open in the objective direction, so the right answer is "unbounded",
    // which Bland's rule reaches in a handful of pivots. Rows pivoted under
    // the fallback carry a "d" after the iteration number.
    const stall = { tol: 1e-5, dual: false };
    const bland = simplex(STALL_LINES, STALL_OBJECTIVE, stall);
    const cycling = simplex(STALL_LINES, STALL_OBJECTIVE, {
      ...stall,
      enteringRule: "last",
      leavingRule: "first",
    });
    expect(logText(bland)).not.toMatch(GUARDED_ROW);
    const phase1 = cycling.log[0]!.rows as string[];
    const firstGuarded = phase1.findIndex((row) => GUARDED_ROW.test(row));
    expect(firstGuarded).toBeGreaterThan(MAX_CONSECUTIVE_DEGENERATE_PIVOTS);
    // once active, every remaining iteration row of the phase is marked
    for (const row of phase1.slice(firstGuarded)) {
      if (/^\s*\d+d? /.test(row)) expect(row).toMatch(GUARDED_ROW);
    }
    expect(bland.status).toBe("unbounded");
    expect(cycling.status).toBe("unbounded");
    expect(cycling.iterates.length).toBeLessThan(100);
  });
});

describe("ipm", () => {
  test("converges to the square optimum", () => {
    const r = ipm(SQUARE, Float64Array.of(1, 1), ipmOptions(0.9));
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    const last = lastIterate(r);
    expect(last[0]!).toBeCloseTo(-4, 3);
    expect(last[1]!).toBeCloseTo(-4, 3);
  });

  test("alphaMax = 1 never produces NaN rows", () => {
    const rand = lcg(3);
    for (let t = 0; t < 100; t++) {
      const obj = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      const r = ipm(SQUARE, obj, ipmOptions(1));
      for (const row of rowsOf(r)) {
        expect(Number.isFinite(row.point[0]!)).toBe(true);
        expect(Number.isFinite(row.point[1]!)).toBe(true);
        expect(Number.isFinite(row.convergence)).toBe(true);
        expect(Number.isFinite(row.objective)).toBe(true);
      }
    }
  });

  // Regression: the Newton step used to be solved from the dense (n + 2m)²
  // KKT matrix, a 512×512 LU twice per iteration on a 255-gon (~8s per run).
  // The normal-equations reduction must reach the same optimum in milliseconds.
  test("a 255-gon converges in well under a second to the brute-force optimum", () => {
    const rand = lcg(11);
    const { hull, constraints } = largePolygon(rand, 255);
    const obj = Float64Array.of(7, -1.4);
    const expected = bruteForceOptimum(obj, hull);
    const start = performance.now();
    const r = ipm(constraints, obj, ipmOptions(0.1, 1000));
    const elapsed = performance.now() - start;
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    const last = lastIterate(r);
    expect(objectiveValue(obj, last)).toBeCloseTo(expected, 3);
    // ~10ms here against ~8s before the fix
    expect(elapsed).toBeLessThan(1500);
  });
});

describe("ellipsoid", () => {
  const opts = (o: Partial<EllipsoidOptions> = {}) => ({
    maxit: 500,
    tol: 1e-6,
    deepCuts: true,
    rayShoot: true,
    initialScale: 1.5,
    ...o,
  });

  test("converges to the square optimum under every cut combination", () => {
    for (const deepCuts of [true, false]) {
      for (const rayShoot of [true, false]) {
        const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), opts({ deepCuts, rayShoot }));
        expect(footerOf(r).startsWith("Converged")).toBe(true);
        const last = lastIterate(r);
        expect(last[0]!).toBeCloseTo(-4, 3);
        expect(last[1]!).toBeCloseTo(-4, 3);
      }
    }
  });

  test("the ray shoot reaches the same optimum in fewer iterations", () => {
    for (const objective of [Float64Array.of(1, 1), Float64Array.of(-1, 2), Float64Array.of(0.3, -1)]) {
      const off = ellipsoid(SQUARE_VERTICES, SQUARE, objective, opts({ rayShoot: false }));
      const on = ellipsoid(SQUARE_VERTICES, SQUARE, objective, opts({ rayShoot: true }));
      expect(on.iterates.length).toBeLessThan(off.iterates.length);
      const a = off.iterates[off.iterates.length - 1]!;
      const b = on.iterates[on.iterates.length - 1]!;
      expect(objectiveValue(objective, b)).toBeCloseTo(objectiveValue(objective, a), 4);
    }
  });

  test("the final iterate is feasible however termination is reached", () => {
    // the gap stop can close while the ellipsoid is still wide, so it must
    // still hold the center inside the region before calling it converged
    const rand = lcg(5);
    for (let t = 0; t < 40; t++) {
      const objective = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      const r = ellipsoid(SQUARE_VERTICES, SQUARE, objective, opts());
      const last = lastIterate(r);
      for (const [a1, a2, rhs] of SQUARE) {
        expect(a1 * last[0]! + a2 * last[1]!).toBeLessThanOrEqual(rhs + 1e-9);
      }
    }
  });

  test("the converged iterate is feasible, not just close", () => {
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 2), opts());
    const last = lastIterate(r);
    for (const [a1, a2, rhs] of SQUARE) {
      expect(a1 * last[0]! + a2 * last[1]!).toBeLessThanOrEqual(rhs + 1e-9);
    }
  });

  // The run ends by appending the incumbent as a final iterate — it is what the
  // method returns, and it is not in general the last point queried. That entry
  // reuses the previous iterate's ellipse, so the per-iterate invariants below
  // hold over everything before it.
  const queriedCount = (r: ReturnType<typeof ellipsoid>) => r.iterates.length - 1;

  test("iterations, rows, rho and ellipsoids stay in lockstep", () => {
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), opts({ maxit: 40 }));
    expect(rowsOf(r).length).toBe(r.iterates.length);
    expect(r.convergence!.length).toBe(r.iterates.length);
    expect(r.ellipsoids!.length).toBe(r.iterates.length * 5);
    for (let i = 0; i < queriedCount(r); i++) {
      expect(r.ellipsoids![i * 5]!).toBe(r.iterates[i]![0]!);
      expect(r.ellipsoids![i * 5 + 1]!).toBe(r.iterates[i]![1]!);
      expect(rowsOf(r)[i]!.convergence).toBe(r.convergence![i]!);
    }
  });

  test("the run ends on the incumbent, which is the optimum", () => {
    const objective = Float64Array.of(1, 2);
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, objective, opts());
    const last = lastIterate(r);
    const lastRow = rowsOf(r)[rowsOf(r).length - 1]!;
    const expected = bruteForceOptimum(objective, SQUARE_VERTICES);
    const got = objectiveValue(objective, last);
    // the incumbent is feasible, so it can never beat the optimum, and the gap
    // stop certifies it to within the relative tolerance it was asked for
    expect(got).toBeLessThanOrEqual(expected + 1e-9);
    expect(expected - got).toBeLessThanOrEqual(1e-6 * (1 + Math.abs(expected)));
    expect(lastRow.infeasibility).toBe(0);
    expect(lastRow.point[0]).toBe(last[0]!);
    expect(lastRow.point[1]).toBe(last[1]!);
  });

  test("every ellipsoid is positive definite and shrinks", () => {
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(-1, 2), opts({ maxit: 60 }));
    let previousDet = Infinity;
    for (let i = 0; i < queriedCount(r); i++) {
      const { p11, p12, p22 } = ellipseAt(r, i);
      const det = p11 * p22 - p12 * p12;
      expect(p11).toBeGreaterThan(0);
      expect(p22).toBeGreaterThan(0);
      expect(det).toBeGreaterThan(0);
      expect(det).toBeLessThan(previousDet);
      previousDet = det;
    }
  });

  test("the first ellipsoid contains every vertex of the region", () => {
    const r = ellipsoid(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), opts({ maxit: 1 }));
    const { cx, cy, p11, p12, p22 } = ellipseAt(r, 0);
    const det = p11 * p22 - p12 * p12;
    for (const [vx, vy] of SQUARE_VERTICES) {
      const dx = vx - cx;
      const dy = vy - cy;
      // (v - c)' P^-1 (v - c) <= 1
      const quadratic = (p22 * dx * dx - 2 * p12 * dx * dy + p11 * dy * dy) / det;
      expect(quadratic).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  test("random polygons match the brute-force optimum", () => {
    const rand = lcg(11);
    let runs = 0;
    for (let t = 0; t < 60 && runs < 15; t++) {
      const polygon = randomPolygon(rand);
      if (!polygon) continue;
      const { hull, constraints } = polygon;
      const obj = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      if (Math.abs(obj[0]!) + Math.abs(obj[1]!) < 0.1) continue;
      const expected = bruteForceOptimum(obj, hull);
      runs++;
      const r = ellipsoid(hull, constraints, obj, opts());
      const last = lastIterate(r);
      expect(footerOf(r).startsWith("Converged")).toBe(true);
      expect(objectiveValue(obj, last)).toBeCloseTo(expected, 4);
    }
    expect(runs).toBeGreaterThan(8);
  });

  test("reports an unbounded objective instead of claiming optimality", () => {
    // x in [-1, 2], maximize y: the optimum is only bounded by the initial
    // ellipsoid, never by a constraint
    const strip: Constraint[] = [
      [1, 0, 2],
      [-1, 0, 1],
    ];
    const hull: Vec[] = [
      [-1, -5],
      [2, -5],
      [2, 5],
      [-1, 5],
    ];
    const r = ellipsoid(hull, strip, Float64Array.of(0, 1), opts());
    expect(footerOf(r).startsWith("Stopped on the initial ellipsoid boundary")).toBe(true);
    expect(footerOf(r)).toContain("unbounded");
  });

  test("stops instead of spinning when the region is empty", () => {
    const empty: Constraint[] = [
      [1, 0, 1],
      [-1, 0, -2],
      [0, 1, 1],
      [0, -1, 1],
    ];
    const hull: Vec[] = [
      [1, 1],
      [2, 1],
      [2, -1],
      [1, -1],
    ];
    const r = ellipsoid(hull, empty, Float64Array.of(1, 1), opts());
    expect(r.iterates.length).toBeLessThan(500);
    expect(footerOf(r).startsWith("Converged")).toBe(false);
  });
});

describe("centralPath", () => {
  test("emits one log row per traced point under a header, closed by the timing footer", () => {
    const r = centralPath(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), {
      niter: 10,
    });
    expect(r.iterates.length).toBe(10);
    expect(r.log).toHaveLength(1);
    expect(r.log[0]!.header).toContain("Iter");
    expect(r.log[0]!.rows).toHaveLength(10);
    expect(r.log[0]!.footer).toMatch(/^Traced central path in \d+ms$/);
    const last = lastIterate(r);
    expect(last[0]!).toBeCloseTo(-4, 2);
    expect(last[1]!).toBeCloseTo(-4, 2);
  });

  test("stays finite on a sliver region", () => {
    const sliverLines: Constraint[] = [
      [1, 0, -4],
      [-1, 0, 4.001],
      [0, 1, -4],
      [0, -1, 6],
    ];
    const sliverVertices: Vec[] = [
      [-4.001, -6],
      [-4, -6],
      [-4, -4],
      [-4.001, -4],
    ];
    const r = centralPath(sliverVertices, sliverLines, Float64Array.of(1, 1), {
      niter: 20,
    });
    expect(r.iterates.length).toBeGreaterThan(0);
    expect(r.convergence!.length).toBe(r.iterates.length);
    for (const [i, p] of r.iterates.entries()) {
      expect(Number.isFinite(p[0]!)).toBe(true);
      expect(Number.isFinite(p[1]!)).toBe(true);
      expect(Number.isFinite(r.convergence![i]!)).toBe(true);
    }
  });

  test("a 255-gon traces every point quickly", () => {
    for (const seed of [3, 9]) {
      const { hull, constraints } = largePolygon(lcg(seed), 255);
      const obj = Float64Array.of(7, -1.4);
      const expected = bruteForceOptimum(obj, hull);
      const start = performance.now();
      const r = centralPath(hull, constraints, obj, { niter: 75 });
      const elapsed = performance.now() - start;
      expect(r.iterates.length).toBe(75);
      const last = lastIterate(r);
      // µ ends at 1e-5, so the path ends within ~m·µ of the LP optimum
      expect(objectiveValue(obj, last)).toBeCloseTo(expected, 1);
      expect(elapsed).toBeLessThan(1000);
    }
  });
});

describe("draggable start point", () => {
  const ipmOpts = (startPoint?: number[]) => ({ ...ipmOptions(0.9, 500), startPoint });

  test("ipm starts at the given point and still converges", () => {
    for (const start of [
      [-5.5, -4.5], // interior
      [3, 7], // far outside (infeasible start)
    ]) {
      const r = ipm(SQUARE, Float64Array.of(1, 1), ipmOpts(start));
      expect(r.iterates[0]![0]!).toBeCloseTo(start[0]!, 12);
      expect(r.iterates[0]![1]!).toBeCloseTo(start[1]!, 12);
      expect(footerOf(r).startsWith("Converged")).toBe(true);
      const last = lastIterate(r);
      expect(last[0]!).toBeCloseTo(-4, 3);
      expect(last[1]!).toBeCloseTo(-4, 3);
    }
  });

  test("a start at the default origin reproduces the cold trajectory", () => {
    // The marker relocates only the primal start; every other initialization
    // matches the cold start, so startPoint [0,0] must be bitwise identical
    // to passing no start point at all.
    const coldIpm = ipm(SQUARE, Float64Array.of(1, 1), ipmOpts(undefined));
    const warmIpm = ipm(SQUARE, Float64Array.of(1, 1), ipmOpts([0, 0]));
    expect(warmIpm.iterates).toEqual(coldIpm.iterates);
    // mu and the primal residual are functions of the dual trajectory (s, y)
    expect(warmIpm.convergence).toEqual(coldIpm.convergence);
    expect(rowsOf(warmIpm)).toEqual(rowsOf(coldIpm));

    for (const ineq of [true, false]) {
      const cold = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...PDHG_DEFAULTS,
        ineq,
      });
      const warm = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...PDHG_DEFAULTS,
        ineq,
        startPoint: [0, 0],
      });
      expect(warm.iterates).toEqual(cold.iterates);
    }
  });

  test("pdhg ineq mode starts at the given point and converges", () => {
    for (const start of [
      [-5, -5],
      [2, 2], // outside (the dual keeps the cold start's y = 1)
    ]) {
      const r = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...PDHG_DEFAULTS,
        ineq: true,
        startPoint: start,
      });
      expect(r.iterates[0]![0]!).toBeCloseTo(start[0]!, 12);
      expect(r.iterates[0]![1]!).toBeCloseTo(start[1]!, 12);
      expect(footerOf(r).startsWith("Converged")).toBe(true);
      const last = lastIterate(r);
      expect(last[0]!).toBeCloseTo(-4, 2);
      expect(last[1]!).toBeCloseTo(-4, 2);
    }
  });

  test("pdhg eq mode maps a negative start through the split exactly", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...PDHG_DEFAULTS,
      ineq: false,
      startPoint: [-5.5, -4.5],
    });
    expect(r.iterates[0]![0]!).toBeCloseTo(-5.5, 12);
    expect(r.iterates[0]![1]!).toBeCloseTo(-4.5, 12);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    const last = lastIterate(r);
    expect(last[0]!).toBeCloseTo(-4, 2);
    expect(last[1]!).toBeCloseTo(-4, 2);
  });

  test("pdhg halpern accepts a warm start", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...PDHG_DEFAULTS,
      ineq: true,
      halpern: true,
      startPoint: [-5, -5],
    });
    expect(r.iterates[0]![0]!).toBeCloseTo(-5, 12);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
  });

  test("simplex warm starts from a vertex and skips Phase 1", () => {
    const r = simplex(SQUARE, Float64Array.of(1, 1), {
      tol: 1e-9,
      dual: false,
      startVertex: [-6, -6],
    });
    expect(r.status).toBe("optimal");
    expect(phase1Count(r)).toBe(0);
    expect(r.log[0]!.header).toContain("warm start");
    const first = r.iterates[0]!;
    expect(first[0]!).toBeCloseTo(-6, 6);
    expect(first[1]!).toBeCloseTo(-6, 6);
    const last = lastIterate(r);
    expect(last[0]!).toBeCloseTo(-4, 6);
    expect(last[1]!).toBeCloseTo(-4, 6);
  });

  test("simplex falls back to Phase 1 when the start is not a vertex", () => {
    for (const start of [
      [-5, -5], // interior
      [0, 0], // infeasible
      [-4, -5], // on a facet but not a corner
    ]) {
      const r = simplex(SQUARE, Float64Array.of(1, 1), {
        tol: 1e-9,
        dual: false,
        startVertex: start,
      });
      expect(r.status).toBe("optimal");
      expect(phase1Count(r)).toBeGreaterThan(0);
      const last = lastIterate(r);
      expect(last[0]!).toBeCloseTo(-4, 6);
      expect(last[1]!).toBeCloseTo(-4, 6);
    }
  });
});
