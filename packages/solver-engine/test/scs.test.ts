import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { scs } from "../src/scs";
import { simplex } from "../src/simplex";
import { BOX, CUBE, EMPTY, expectNear, footerOf, lastIterate, objectiveValue, SQUARE, STRIP } from "./fixtures";

const OPTS = { maxit: 20000, tol: 1e-6 };

describe("scs", () => {
  test("converges to the square's corner", () => {
    const r = scs(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [-4, -4], 3);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = scs(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(r.status).toBe("optimal");
    expectNear(lastIterate(r), [...corner], 3);
  });

  test("certifies an empty region", () => {
    const r = scs(EMPTY, Float64Array.of(1, 1), OPTS);
    expect(r.status).toBe("infeasible");
    expect(footerOf(r).startsWith("Certified primal infeasible")).toBe(true);
  });

  test("certifies an unbounded strip", () => {
    const r = scs(STRIP, Float64Array.of(0, 1), OPTS);
    expect(r.status).toBe("unbounded");
  });

  test("matches simplex on random LPs", () => {
    const rand = mulberry32(11);
    let optimal = 0;
    for (let k = 0; k < 200; k++) {
      const n = k % 2 ? 3 : 2;
      const m = n + 2 + Math.floor(rand() * 8);
      const constraints = Array.from({ length: m }, () => [...Array.from({ length: n }, () => rand() * 2 - 1), rand() + 0.2]) as unknown as Constraint[];
      const c = Float64Array.from({ length: n }, () => rand() * 2 - 1);
      const r = scs(constraints, c, OPTS);
      let reference;
      try {
        reference = simplex(constraints, c, { tol: 1e-9, dual: false });
      } catch {
        expect(r.status).toBe("infeasible");
        continue;
      }
      expect(r.status).toBe(reference.status!);
      if (r.status === "optimal") {
        optimal++;
        const want = objectiveValue(c, lastIterate(reference));
        expect(Math.abs(objectiveValue(c, lastIterate(r)) - want)).toBeLessThan(1e-4 * (1 + Math.abs(want)));
      }
    }
    expect(optimal).toBeGreaterThan(100);
  });
});
