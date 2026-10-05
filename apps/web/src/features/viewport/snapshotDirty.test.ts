import { describe, expect, test } from "bun:test";
import { createDefaultViewportRenderSnapshot } from "@lpviz/viewport/types";
import { getSnapshotViewportDirtyFlags } from "./snapshotDirty";

const base = createDefaultViewportRenderSnapshot({ width: 1000, height: 800 });
const next = (o: Partial<typeof base>) => ({ ...base, ...o });

describe("getSnapshotViewportDirtyFlags", () => {
  test("identical snapshots repaint nothing", () => {
    expect(getSnapshotViewportDirtyFlags(base, base)).toEqual({});
  });

  test("a mode switch repaints everything", () => {
    const flags = getSnapshotViewportDirtyFlags(next({ mode: "2d" }), next({ mode: "3d" }));
    expect(flags).toMatchObject({
      grid: true,
      polytope: true,
      constraints: true,
      objective: true,
      trace: true,
      iterate: true,
    });
  });

  test("a transition-z change repaints the transition layers", () => {
    const flags = getSnapshotViewportDirtyFlags(base, next({ transitionZMultiplier: base.transitionZMultiplier + 0.5 }));
    // transition flags include the world-anchored layers
    expect(Object.keys(flags).length).toBeGreaterThan(0);
  });

  test("zoom repaints grid + objective", () => {
    expect(getSnapshotViewportDirtyFlags(base, next({ scaleFactor: base.scaleFactor * 1.5 }))).toEqual({ grid: true, objective: true });
  });

  test("resize repaints grid + objective", () => {
    expect(getSnapshotViewportDirtyFlags(base, next({ width: base.width + 200 }))).toEqual({ grid: true, objective: true });
  });

  test("a 2D pan past one world unit repaints only the grid", () => {
    const a = next({ mode: "2d", target: { x: 0, y: 0, z: 0 } });
    const b = next({ mode: "2d", target: { x: 5, y: -3, z: 0 } });
    expect(getSnapshotViewportDirtyFlags(a, b)).toEqual({ grid: true });
  });

  test("a sub-world-unit 2D pan thrashes nothing (grid key rounds)", () => {
    const a = next({ mode: "2d", target: { x: 0, y: 0, z: 0 } });
    const b = next({ mode: "2d", target: { x: 0.2, y: -0.1, z: 0 } });
    expect(getSnapshotViewportDirtyFlags(a, b)).toEqual({});
  });
});
