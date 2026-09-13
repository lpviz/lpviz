import { describe, expect, test } from "bun:test";
import { centralPath } from "../src/centralPath";
import { ipm } from "../src/ipm";
import { pdhg } from "../src/pdhg";
import { ENTERING_RULES, LEAVING_RULES, simplex } from "../src/simplex";

// square around (-5,-5): x <= -4, x >= -6, y <= -4, y >= -6
const SQUARE = [
  [1, 0, -4],
  [-1, 0, 6],
  [0, 1, -4],
  [0, -1, 6],
] as [number, number, number][];
const SQUARE_VERTICES = [
  [-6, -6],
  [-4, -6],
  [-4, -4],
  [-6, -4],
] as [number, number][];

// The square plus x + y <= -8, which passes exactly through the optimum
// (-4, -4) of the objective (2, 1): three lines meet there, so the ratio test
// ties and the index rules take visibly different routes.
const DEGENERATE_SQUARE = [...SQUARE, [1, 1, -8]] as [number, number, number][];

// Seven nearly concurrent lines on which primal simplex with entering rule
// "last" cycles in Phase 1 (found by fuzzing; see the cycling-guard test).
const STALL_LINES = [
  [-0.9697749358075918, -0.24400117597950474, -3.3722141566558337],
  [-0.9964356544434488, -0.08435630713737943, -3.2387883117373377],
  [-0.9996118936712689, -0.027857889922603827, -3.1719450077092093],
  [-0.6891315307597216, -0.7246362765641553, -3.1456714857769295],
  [-0.29831925841830076, 0.9544661440076098, 1.1470257024838302],
  [-0.6805175119924961, -0.7327318171551874, -3.1296687759153756],
  [-0.977278470566636, -0.2119594087719077, -3.3521836075692066],
] as [number, number, number][];
const STALL_OBJECTIVE = Float64Array.of(-0.04722023010253906, 0.20946311950683594);

// Every explicit entering/leaving pair, plus {} for the engine defaults.
const RULE_COMBOS = ENTERING_RULES.flatMap((enteringRule) =>
  LEAVING_RULES.map((leavingRule) => ({ enteringRule, leavingRule })),
);
const RULE_OPTIONS = [{}, ...RULE_COMBOS];

const lcg = (seed: number) => () =>
  (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

// A random convex polygon (3-7 vertices on a circle, so no three edges are
// concurrent) as inward-pointing constraint lines, or null when two vertices
// are too close for a well-conditioned edge.
function randomPolygon(rand: () => number) {
  const cnt = 3 + Math.floor(rand() * 5);
  const cx = rand() * 16 - 8;
  const cy = rand() * 16 - 8;
  const angles = Array.from({ length: cnt }, () => rand() * 2 * Math.PI).sort(
    (a, b) => a - b,
  );
  if (angles.some((a, i) => i > 0 && a - angles[i - 1]! < 0.2)) return null;
  const R = 1 + rand() * 8;
  const hull = angles.map(
    (a) => [cx + R * Math.cos(a), cy + R * Math.sin(a)] as [number, number],
  );
  const centX = hull.reduce((s, v) => s + v[0], 0) / hull.length;
  const centY = hull.reduce((s, v) => s + v[1], 0) / hull.length;
  const lines = hull.map((start, i) => {
    const end = hull[(i + 1) % hull.length]!;
    let A = end[1] - start[1];
    let B = -(end[0] - start[0]);
    const n = Math.hypot(A, B);
    A /= n;
    B /= n;
    let C = A * start[0] + B * start[1];
    if (A * centX + B * centY > C) {
      A = -A;
      B = -B;
      C = -C;
    }
    return [A, B, C] as [number, number, number];
  });
  return { hull, lines };
}

const flatLogs = (r: { logs: string[][] }) => r.logs.flat().join("");
// a log row whose iteration number carries the cycling-guard marker, e.g. "  27d"
const GUARDED_ROW = /^\s*\d+d /m;
const MAX_CONSECUTIVE_DEGENERATE_PIVOTS = 25;
const lastIterate = (r: { iterations: Float64Array[] }) =>
  r.iterations[r.iterations.length - 1]!;

const pdhgDefaults = {
  halpern: false,
  maxit: 2000,
  eta: 0.25,
  tau: 0.25,
  tol: 1e-4,
  verbose: false,
  colorByBasis: false,
};

describe("pdhg", () => {
  test("eq-mode rows report the recovered (x, y), not the split variable", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), { ...pdhgDefaults, ineq: false });
    const lastRow = r.rows[r.rows.length - 1]!;
    const lastIterate = r.iterations[r.iterations.length - 1]!;
    expect(lastRow.x).toBeCloseTo(lastIterate[0]!, 8);
    expect(lastRow.y).toBeCloseTo(lastIterate[1]!, 8);
    expect(lastRow.x).toBeCloseTo(-4, 2);
    expect(lastRow.y).toBeCloseTo(-4, 2);
  });

  test("ineq mode records the converged iterate", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), { ...pdhgDefaults, ineq: true });
    expect(r.footer.startsWith("Converged")).toBe(true);
    const lastRow = r.rows[r.rows.length - 1]!;
    expect(lastRow.epsilon).toBeLessThanOrEqual(1e-4);
    expect(r.iterations.length).toBe(r.rows.length);
    expect(r.iterations.length).toBe(r.eps.length);
  });

  test("eq mode stops at the last finite iterate on divergence", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...pdhgDefaults,
      ineq: false,
      eta: 0.75,
      tau: 0.75,
    });
    expect(r.footer.startsWith("Did not converge")).toBe(true);
    const last = r.iterations[r.iterations.length - 1]!;
    expect(Number.isFinite(last[0]!)).toBe(true);
    expect(Number.isFinite(last[1]!)).toBe(true);
    // the path must not silently collapse to the origin
    expect(Math.hypot(last[0]!, last[1]!)).toBeGreaterThan(1);
  });
});

describe("simplex", () => {
  const opts = (dual: boolean) => ({ tol: 1e-9, verbose: false, dual });

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
    const strip = [
      [1, 0, 2],
      [-1, 0, 1],
    ] as [number, number, number][];
    const r = simplex(strip, Float64Array.of(1, 0), opts(true));
    expect(r.status).toBe("optimal");
  });

  test("dual mode reports an infeasible primal as infeasible, not unbounded", () => {
    // x <= 1 and x >= 2: empty region
    const empty = [
      [1, 0, 1],
      [-1, 0, -2],
      [0, 1, 1],
      [0, -1, -2],
    ] as [number, number, number][];
    const r = simplex(empty, Float64Array.of(1, 1), opts(true));
    expect(r.status).toBe("infeasible");
  });

  test("primal mode throws on an infeasible region", () => {
    const empty = [
      [1, 0, 1],
      [-1, 0, -2],
    ] as [number, number, number][];
    expect(() => simplex(empty, Float64Array.of(1, 0), opts(false))).toThrow(/infeasible/i);
  });

  test("unbounded LP is reported as unbounded in primal mode", () => {
    const strip = [
      [1, 0, 2],
      [-1, 0, 1],
    ] as [number, number, number][];
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
      const expected = Math.max(
        ...polygon.hull.map((v) => obj[0]! * v[0] + obj[1]! * v[1]),
      );
      runs++;
      for (const dual of [false, true]) {
        for (const rules of RULE_OPTIONS) {
          const r = simplex(polygon.lines, obj, { ...opts(dual), ...rules });
          const last = lastIterate(r);
          expect(r.status).toBe("optimal");
          expect(obj[0]! * last[0]! + obj[1]! * last[1]!).toBeCloseTo(expected, 5);
          // nondegenerate vertices never need the Bland fallback
          expect(flatLogs(r)).not.toMatch(GUARDED_ROW);
        }
      }
    }
    expect(runs).toBeGreaterThan(10);
  });
});

describe("simplex pivot rules", () => {
  const opts = { tol: 1e-9, verbose: false, dual: false };

  test("index rules take different routes through a degenerate vertex but agree on the optimum", () => {
    const trajectories = new Map<string, string>();
    for (const rules of RULE_COMBOS) {
      const r = simplex(DEGENERATE_SQUARE, Float64Array.of(2, 1), { ...opts, ...rules });
      expect(r.status).toBe("optimal");
      const last = lastIterate(r);
      expect(last[0]!).toBeCloseTo(-4, 6);
      expect(last[1]!).toBeCloseTo(-4, 6);
      trajectories.set(`${rules.enteringRule}/${rules.leavingRule}`, flatLogs(r));
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
    expect(flatLogs(bogus)).toBe(flatLogs(bland));
  });

  test("the cycling guard rescues a rule combination that would otherwise never terminate", () => {
    // With entering rule "last", Phase 1 on STALL_LINES cycles through
    // degenerate pivots until MAX_ITERATIONS without the guard. The region is
    // open in the objective direction, so the right answer is "unbounded",
    // which Bland's rule reaches in a handful of pivots. Rows pivoted under
    // the fallback carry a "d" after the iteration number.
    const stall = { tol: 1e-5, verbose: false, dual: false };
    const bland = simplex(STALL_LINES, STALL_OBJECTIVE, stall);
    const cycling = simplex(STALL_LINES, STALL_OBJECTIVE, {
      ...stall,
      enteringRule: "last",
      leavingRule: "first",
    });
    expect(flatLogs(bland)).not.toMatch(GUARDED_ROW);
    const phase1 = cycling.logs[0]!;
    const firstGuarded = phase1.findIndex((row) => GUARDED_ROW.test(row));
    expect(firstGuarded).toBeGreaterThan(MAX_CONSECUTIVE_DEGENERATE_PIVOTS);
    // once active, every remaining iteration row of the phase is marked
    for (const row of phase1.slice(firstGuarded)) {
      if (/^\s*\d+d? /.test(row)) expect(row).toMatch(GUARDED_ROW);
    }
    expect(bland.status).toBe("unbounded");
    expect(cycling.status).toBe("unbounded");
    expect(cycling.phase1Iterations!.length + cycling.iterations.length).toBeLessThan(100);
  });
});

describe("ipm", () => {
  const opts = (alphaMax: number) => ({
    eps_p: 1e-6,
    eps_d: 1e-6,
    eps_opt: 1e-6,
    maxit: 200,
    alphaMax,
    correctorThreshold: 0.9,
    verbose: false,
  });

  test("converges to the square optimum", () => {
    const r = ipm(SQUARE, Float64Array.of(1, 1), opts(0.9));
    const sol = r.iterates.solution;
    expect(sol.footer!.startsWith("Converged")).toBe(true);
    const last = sol.x[sol.x.length - 1]!;
    expect(last[0]!).toBeCloseTo(-4, 3);
    expect(last[1]!).toBeCloseTo(-4, 3);
  });

  test("alphaMax = 1 never produces NaN rows", () => {
    const rand = lcg(3);
    for (let t = 0; t < 100; t++) {
      const obj = Float64Array.of(rand() * 4 - 2, rand() * 4 - 2);
      const r = ipm(SQUARE, obj, opts(1));
      for (const row of r.iterates.solution.rows) {
        expect(Number.isFinite(row.x)).toBe(true);
        expect(Number.isFinite(row.y)).toBe(true);
        expect(Number.isFinite(row.mu)).toBe(true);
        expect(Number.isFinite(row.objective)).toBe(true);
      }
    }
  });
});

describe("centralPath", () => {
  test("emits one log row per traced point plus a header, no footer", () => {
    const r = centralPath(SQUARE_VERTICES, SQUARE, Float64Array.of(1, 1), {
      niter: 10,
      verbose: false,
    });
    expect(r.iterations.length).toBe(10);
    expect(r.logs.length).toBe(11);
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last[0]!).toBeCloseTo(-4, 2);
    expect(last[1]!).toBeCloseTo(-4, 2);
  });

  test("stays finite on a sliver region", () => {
    const sliverLines = [
      [1, 0, -4],
      [-1, 0, 4.001],
      [0, 1, -4],
      [0, -1, 6],
    ] as [number, number, number][];
    const sliverVertices = [
      [-4.001, -6],
      [-4, -6],
      [-4, -4],
      [-4.001, -4],
    ] as [number, number][];
    const r = centralPath(sliverVertices, sliverLines, Float64Array.of(1, 1), {
      niter: 20,
      verbose: false,
    });
    expect(r.iterations.length).toBeGreaterThan(0);
    for (const p of r.iterations) {
      expect(Number.isFinite(p[0]!)).toBe(true);
      expect(Number.isFinite(p[1]!)).toBe(true);
      expect(Number.isFinite(p[2]!)).toBe(true);
    }
  });
});

describe("draggable start point", () => {
  const ipmOpts = (startPoint?: number[]) => ({
    eps_p: 1e-6,
    eps_d: 1e-6,
    eps_opt: 1e-6,
    maxit: 500,
    alphaMax: 0.9,
    correctorThreshold: 0.9,
    verbose: false,
    startPoint,
  });

  test("ipm starts at the given point and still converges", () => {
    for (const start of [
      [-5.5, -4.5], // interior
      [3, 7], // far outside (infeasible start)
    ]) {
      const r = ipm(SQUARE, Float64Array.of(1, 1), ipmOpts(start));
      const sol = r.iterates.solution;
      expect(sol.x[0]![0]!).toBeCloseTo(start[0]!, 12);
      expect(sol.x[0]![1]!).toBeCloseTo(start[1]!, 12);
      expect(sol.footer!.startsWith("Converged")).toBe(true);
      const last = sol.x[sol.x.length - 1]!;
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
    expect(warmIpm.iterates.solution.x).toEqual(coldIpm.iterates.solution.x);
    expect(warmIpm.iterates.solution.s).toEqual(coldIpm.iterates.solution.s);
    expect(warmIpm.iterates.solution.y).toEqual(coldIpm.iterates.solution.y);

    for (const ineq of [true, false]) {
      const cold = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...pdhgDefaults,
        ineq,
      });
      const warm = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...pdhgDefaults,
        ineq,
        startPoint: [0, 0],
      });
      expect(warm.iterations).toEqual(cold.iterations);
    }
  });

  test("pdhg ineq mode starts at the given point and converges", () => {
    for (const start of [
      [-5, -5],
      [2, 2], // outside (the dual keeps the cold start's y = 1)
    ]) {
      const r = pdhg(SQUARE, Float64Array.of(1, 1), {
        ...pdhgDefaults,
        ineq: true,
        startPoint: start,
      });
      expect(r.iterations[0]![0]!).toBeCloseTo(start[0]!, 12);
      expect(r.iterations[0]![1]!).toBeCloseTo(start[1]!, 12);
      expect(r.footer.startsWith("Converged")).toBe(true);
      const last = r.iterations[r.iterations.length - 1]!;
      expect(last[0]!).toBeCloseTo(-4, 2);
      expect(last[1]!).toBeCloseTo(-4, 2);
    }
  });

  test("pdhg eq mode maps a negative start through the split exactly", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...pdhgDefaults,
      ineq: false,
      startPoint: [-5.5, -4.5],
    });
    expect(r.iterations[0]![0]!).toBeCloseTo(-5.5, 12);
    expect(r.iterations[0]![1]!).toBeCloseTo(-4.5, 12);
    expect(r.footer.startsWith("Converged")).toBe(true);
    const last = r.iterations[r.iterations.length - 1]!;
    expect(last[0]!).toBeCloseTo(-4, 2);
    expect(last[1]!).toBeCloseTo(-4, 2);
  });

  test("pdhg halpern accepts a warm start", () => {
    const r = pdhg(SQUARE, Float64Array.of(1, 1), {
      ...pdhgDefaults,
      ineq: true,
      halpern: true,
      startPoint: [-5, -5],
    });
    expect(r.iterations[0]![0]!).toBeCloseTo(-5, 12);
    expect(r.footer.startsWith("Converged")).toBe(true);
  });

  test("simplex warm starts from a vertex and skips Phase 1", () => {
    const r = simplex(SQUARE, Float64Array.of(1, 1), {
      tol: 1e-9,
      verbose: false,
      dual: false,
      startVertex: [-6, -6],
    });
    expect(r.status).toBe("optimal");
    expect(r.phase1Iterations!.length).toBe(0);
    expect(r.logs[0]![0]!).toContain("warm start");
    const first = r.iterations[0]!;
    expect(first[0]!).toBeCloseTo(-6, 6);
    expect(first[1]!).toBeCloseTo(-6, 6);
    const last = r.iterations[r.iterations.length - 1]!;
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
        verbose: false,
        dual: false,
        startVertex: start,
      });
      expect(r.status).toBe("optimal");
      expect(r.phase1Iterations!.length).toBeGreaterThan(0);
      const last = r.iterations[r.iterations.length - 1]!;
      expect(last[0]!).toBeCloseTo(-4, 6);
      expect(last[1]!).toBeCloseTo(-4, 6);
    }
  });
});
