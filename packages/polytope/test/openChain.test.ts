import { describe, expect, test } from "bun:test";
import type { Vec } from "@lpviz/math/types";
import { hasOpenBoundaryClosure } from "../src/openChain";

describe("hasOpenBoundaryClosure", () => {
  test("detects the start ray crossing the terminal segment", () => {
    // pure ray-vs-segment geometry; no constraints disables the constraint fallback
    const chain: Vec[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [-3, 1],
      [-3, -1],
    ];
    expect(hasOpenBoundaryClosure(chain, [])).toBe(true);
    expect(hasOpenBoundaryClosure([...chain].reverse(), [])).toBe(true);
  });

  test("an open L stays open", () => {
    const chain: Vec[] = [
      [0, 0],
      [2, 0],
      [2, 2],
    ];
    expect(hasOpenBoundaryClosure(chain, [])).toBe(false);
  });
});
