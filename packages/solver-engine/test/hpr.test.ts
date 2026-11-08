import { describe, expect, test } from "bun:test";
import type { Constraint } from "@lpviz/math/types";
import { mulberry32 } from "@lpviz/math/random";
import { hpr } from "../src/hpr";
import { simplex } from "../src/simplex";
import { BOX, CUBE, expectNear, footerOf, lastIterate, objectiveValue, SQUARE } from "./fixtures";

const OPTS = { maxit: 20000, tol: 1e-6 };

describe("hpr", () => {
  test("converges to the square's corner", () => {
    const r = hpr(SQUARE, Float64Array.of(1, 1), OPTS);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [-4, -4], 3);
  });

  test.each([
    ["cube", CUBE, [4, 4, 4]],
    ["box", BOX, [1, 2, 3]],
  ] as const)("converges to the %s corner in 3D", (_, constraints, corner) => {
    const r = hpr(constraints, Float64Array.of(1, 1, 1), OPTS);
    expect(footerOf(r).startsWith("Converged")).toBe(true);
    expectNear(lastIterate(r), [...corner], 3);
  });

  test("matches simplex on random LPs", () => {
    const rand = mulberry32(11);
    let optimal = 0;
    for (let k = 0; k < 200; k++) {
      const n = k % 2 ? 3 : 2;
      const m = n + 2 + Math.floor(rand() * 8);
      const constraints = Array.from({ length: m }, () => [...Array.from({ length: n }, () => rand() * 2 - 1), rand() + 0.2]) as unknown as Constraint[];
      const c = Float64Array.from({ length: n }, () => rand() * 2 - 1);
      const r = hpr(constraints, c, OPTS);
      let reference;
      try {
        reference = simplex(constraints, c, { tol: 1e-9, dual: false });
      } catch {
        continue;
      }
      if (reference.status === "optimal") {
        expect(footerOf(r).startsWith("Converged")).toBe(true);
        optimal++;
        const want = objectiveValue(c, lastIterate(reference));
        expect(Math.abs(objectiveValue(c, lastIterate(r)) - want)).toBeLessThan(1e-4 * (1 + Math.abs(want)));
      }
    }
    expect(optimal).toBeGreaterThan(100);
  });
});

describe("hpr restarts", () => {
  test("marks restarts in the log", () => {
    const r = hpr(SQUARE, Float64Array.of(1, 0.3), OPTS);
    const section = r.log[0]!.rows as { restart: Uint8Array };
    expect(section.restart.some((v) => v === 1)).toBe(true);
  });
});
