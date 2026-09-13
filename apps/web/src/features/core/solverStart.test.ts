import { describe, expect, test } from "bun:test";
import {
  displayedSolverStartPoint,
  nearestPolytopeVertex,
  type State,
} from "./store";

// The start marker's applicability and snapping rules in the 3-variable
// editor, where the region is polytope3 rather than the planar polytope.
const cube = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [0, 2].map((z) => ({ x, y, z }))));
function state3(o: Partial<State>): State {
  return {
    problemMode: "3d",
    editor3Phase: "ready",
    vertices: [],
    completionMode: "closed",
    objectiveVector: null,
    polytope: null,
    polytope3: { kind: "bounded", planes: [], vertices: cube, faces: [], inequalities: [] },
    objectiveVector3: { x: 1, y: 0, z: 0 },
    solverMode: "ipm",
    solverSettings: { simplexDualMode: false },
    solverStartPoint: null,
    ...o,
  } as unknown as State;
}

describe("solver start marker in the 3-variable editor", () => {
  test("defaults to the origin in space for IPM and PDHG", () => {
    expect(displayedSolverStartPoint(state3({}))).toEqual({ x: 0, y: 0, z: 0 });
    expect(displayedSolverStartPoint(state3({ solverMode: "pdhg" }))).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("keeps a dragged point's height", () => {
    const shown = displayedSolverStartPoint(state3({ solverStartPoint: { x: 0.2, y: -0.4, z: 1.5 } }));
    expect(shown).toEqual({ x: 0.2, y: -0.4, z: 1.5 });
  });

  test("snaps to the nearest solid corner for primal simplex", () => {
    const near = { x: 0.8, y: -0.9, z: 1.7 };
    expect(nearestPolytopeVertex(state3({}), near)).toEqual({ x: 1, y: -1, z: 2 });
    const shown = displayedSolverStartPoint(state3({ solverMode: "simplex", solverStartPoint: near }));
    expect(shown).toEqual({ x: 1, y: -1, z: 2 });
  });

  test("hides for dual simplex, unsolved phases and non-bounded solids", () => {
    expect(displayedSolverStartPoint(state3({ solverMode: "simplex", solverSettings: { simplexDualMode: true } as State["solverSettings"] }))).toBeNull();
    expect(displayedSolverStartPoint(state3({ editor3Phase: "extrude" }))).toBeNull();
    expect(displayedSolverStartPoint(state3({ polytope3: null }))).toBeNull();
  });
});
