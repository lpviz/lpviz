import { describe, expect, test } from "bun:test";
import { haloLift } from "./resultPacking";

describe("haloLift", () => {
  test("puts the smallest mu on the floor and mu = 1 at PDHG's lifted start", () => {
    const lift = haloLift(Float64Array.of(1, 1e-3, 1e-6, 1e-12));
    expect(Array.from(lift)).toEqual([500, 375, 250, 0]);
  });

  test("keeps a decade between mu = 1 and the floor when mu never gets small", () => {
    const lift = haloLift(Float64Array.of(10, 1, 0.5));
    expect(lift[1]).toBeCloseTo(500);
    expect(lift[0]).toBeCloseTo(1000);
  });
});
