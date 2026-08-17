import { describe, expect, test } from "bun:test";
import { deriveViewportDirty, type State } from "./store";

// Pins the field -> repainted-layers mapping that patch() derives automatically.
// This must agree with the hand-tuned getXViewportDirtyFlags helpers (see
// dirtyFlags.test.ts) that it replaces; the two oracles are updated together.
function st(o: Partial<State>): State {
  return { is3DMode: false, isTransitioning3D: false, ...o } as State;
}

describe("deriveViewportDirty (field -> layers)", () => {
  test("polytope-group fields repaint polytope + constraints + objective", () => {
    for (const key of [
      "vertices",
      "polytope",
      "completionMode",
      "interiorPoint",
    ] as const) {
      expect(deriveViewportDirty(st({}), [key])).toEqual({
        polytope: true,
        constraints: true,
        objective: true,
      });
    }
  });

  test("iterate fields repaint only the iterate pass", () => {
    for (const key of [
      "iteratePath",
      "iterateEllipsoids",
      "iteratePhases",
      "iterateRestartIndices",
      "iterateObjectiveVector",
      "highlightIteratePathIndex",
    ] as const) {
      expect(deriveViewportDirty(st({}), [key])).toEqual({ iterate: true });
    }
  });

  test("trace fields repaint only the trace pass", () => {
    expect(deriveViewportDirty(st({}), ["traceBuffer"])).toEqual({
      trace: true,
    });
    expect(deriveViewportDirty(st({}), ["traceEnabled"])).toEqual({
      trace: true,
    });
  });

  test("constraint highlight repaints only constraints", () => {
    expect(deriveViewportDirty(st({}), ["highlightIndex"])).toEqual({
      constraints: true,
    });
  });

  test("objective change repaints objective, plus polytope in/into 3D", () => {
    expect(deriveViewportDirty(st({}), ["objectiveVector"])).toEqual({
      objective: true,
    });
    expect(
      deriveViewportDirty(st({ is3DMode: true }), ["objectiveVector"]),
    ).toEqual({ polytope: true, objective: true });
    expect(
      deriveViewportDirty(st({ isTransitioning3D: true }), ["currentObjective"]),
    ).toEqual({ polytope: true, objective: true });
  });

  test("zScale repaints every world-anchored layer", () => {
    expect(deriveViewportDirty(st({}), ["zScale"])).toEqual({
      polytope: true,
      objective: true,
      trace: true,
      iterate: true,
    });
  });

  test("union of multiple changed fields", () => {
    expect(
      deriveViewportDirty(st({}), ["iteratePath", "traceBuffer"]),
    ).toEqual({ iterate: true, trace: true });
  });

  test("pure UI / solver-config fields repaint nothing", () => {
    expect(deriveViewportDirty(st({}), ["resultDisplayMode"])).toBeNull();
    expect(deriveViewportDirty(st({}), ["maxTraceCount"])).toBeNull();
  });

  test("the start marker repaints the iterate overlay", () => {
    // switching solvers shows/hides/snaps the start marker
    expect(deriveViewportDirty(st({}), ["solverMode"])).toEqual({
      iterate: true,
    });
    expect(deriveViewportDirty(st({}), ["solverStartPoint"])).toEqual({
      iterate: true,
    });
  });
});
