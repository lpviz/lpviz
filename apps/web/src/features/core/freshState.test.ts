import { describe, expect, test } from "bun:test";
import { DEFAULT_SOLVER_SETTINGS, freshState, getState, setState } from "./store";

// A reset applies freshState() over whatever the store holds. These pin what
// that must restore, and what it must leave to the viewport.
describe("freshState", () => {
  test("covers every field except the view and runtime ones", () => {
    const fresh = Object.keys(freshState()).sort();
    const all = Object.keys(getState()).sort();
    const leftOut = all.filter((key) => !fresh.includes(key));
    expect(leftOut.sort()).toEqual(
      [
        "dimension",
        "is3DMode",
        "isNavigatingViewport",
        "isTransitioning3D",
        "maxTraceCount",
        "transition3DEndAngles",
        "transition3DStartAngles",
        "transitionDirection",
        "transitionProgress",
        "transitionStartTime",
        "viewAngle",
      ].sort(),
    );
  });

  test("restores a worked-on store to its starting values", () => {
    setState({
      vertices: [
        [0, 0],
        [2, 1],
        [1, 2],
      ],
      completionMode: "closed",
      objectiveVector: [1, 0],
      solverMode: "ipm",
      solverSettings: { ...DEFAULT_SOLVER_SETTINGS, maxitIPM: 7 },
      historyStack: [{ vertices: [], objectiveVector: null, completionMode: "draft" }],
      snapToGrid: true,
      traceEnabled: true,
      is3DMode: true,
      maxTraceCount: 63,
    });

    setState(freshState());
    const state = getState();
    expect(state.vertices).toEqual([]);
    expect(state.completionMode).toBe("draft");
    expect(state.objectiveVector).toBeNull();
    expect(state.solverMode).toBe("central");
    expect(state.solverSettings).toEqual(DEFAULT_SOLVER_SETTINGS);
    expect(state.historyStack).toEqual([]);
    expect(state.snapToGrid).toBe(false);
    expect(state.traceEnabled).toBe(false);
    // left to the viewport
    expect(state.is3DMode).toBe(true);
    expect(state.maxTraceCount).toBe(63);
  });

  test("hands out fresh objects every call", () => {
    const a = freshState();
    const b = freshState();
    expect(a.vertices).not.toBe(b.vertices);
    expect(a.solverSettings).not.toBe(b.solverSettings);
    expect(a.solverSettings).toEqual(b.solverSettings);
  });
});
