import { describe, expect, test } from "bun:test";
import { deriveViewportDirty, type State } from "./store";

// Pins the field -> repainted-layers mapping that patch() derives automatically.
// This must agree with the hand-tuned getXViewportDirtyFlags helpers (see
// dirtyFlags.test.ts) that it replaces; the two oracles are updated together.
const st = (o: Partial<State>): State => ({ is3DMode: false, isTransitioning3D: false, ...o }) as State;
// what a change to one field repaints, in a 2D view unless said otherwise
const dirtyOf = (key: keyof State, state: Partial<State> = {}) => deriveViewportDirty(st(state), [key]);

describe("deriveViewportDirty (field -> layers)", () => {
  test("polytope-group fields repaint polytope + constraints + objective", () => {
    for (const key of ["vertices", "polytope", "completionMode"] as const) {
      expect(dirtyOf(key)).toEqual({
        polytope: true,
        constraints: true,
        objective: true,
      });
    }
  });

  test("iterate fields repaint only the iterate pass", () => {
    for (const key of ["iteratePath", "iterateEllipsoids", "iteratePhases", "iterateRestartIndices", "highlightIteratePathIndex", "replayActive"] as const) {
      expect(dirtyOf(key)).toEqual({ iterate: true });
    }
  });

  test("trace fields repaint only the trace pass", () => {
    expect(dirtyOf("traceBuffer")).toEqual({
      trace: true,
    });
    expect(dirtyOf("traceEnabled")).toEqual({
      trace: true,
    });
  });

  test("constraint highlight repaints only constraints", () => {
    expect(dirtyOf("highlightIndex")).toEqual({
      constraints: true,
    });
  });

  test("objective change repaints objective, plus polytope in/into 3D", () => {
    expect(dirtyOf("objectiveVector")).toEqual({
      objective: true,
    });
    expect(dirtyOf("objectiveVector", { is3DMode: true })).toEqual({ polytope: true, objective: true });
    expect(dirtyOf("currentObjective", { isTransitioning3D: true })).toEqual({ polytope: true, objective: true });
  });

  test("zScale, and entering or leaving 3D, repaint every world-anchored layer", () => {
    for (const key of ["zScale", "is3DMode", "isTransitioning3D"] as const) {
      expect(dirtyOf(key)).toEqual({
        polytope: true,
        objective: true,
        trace: true,
        iterate: true,
      });
    }
  });

  test("union of multiple changed fields", () => {
    expect(deriveViewportDirty(st({}), ["iteratePath", "traceBuffer"])).toEqual({ iterate: true, trace: true });
  });

  test("pure UI / solver-config fields repaint nothing", () => {
    expect(dirtyOf("result")).toBeNull();
    expect(dirtyOf("maxTraceCount")).toBeNull();
    // kept for the 3-variable port's central path; nothing draws it yet
    expect(dirtyOf("interiorPoint")).toBeNull();
  });

  test("the start marker repaints the iterate overlay", () => {
    // switching solvers shows/hides/snaps the start marker
    expect(dirtyOf("solverMode")).toEqual({
      iterate: true,
    });
    expect(dirtyOf("solverStartPoint")).toEqual({
      iterate: true,
    });
  });
});
