import { describe, expect, test } from "bun:test";
import type { State } from "../core/store";
import { SOLVER_CONTROLS } from "./solverControls";
import type { Vec } from "@lpviz/math/types";

describe("ellipsoid request", () => {
  const CHAIN: Vec[] = [
    [0, 0],
    [2, 1],
    [1, 2],
  ];
  const stateWith = (polytope: Partial<State["polytope"]>) =>
    ({
      vertices: CHAIN,
      objectiveVector: [-1, 0],
      polytope: {
        kind: "unbounded",
        constraints: [
          [1, -2, 0],
          [1, 1, 3],
        ],
        vertices: [],
        boundaryRays: [],
        ...polytope,
      },
      solverSettings: {
        maxitEllipsoid: 100,
        ellipsoidDeepCuts: true,
        ellipsoidRayShoot: true,
        ellipsoidQueryPoint: "chebyshev",
        ellipsoidInitialScale: 1.5,
      },
    }) as unknown as State;
  const verticesOf = (state: State) => {
    const request = SOLVER_CONTROLS.ellipsoid.buildRequest(state);
    if (!request || request.solver !== "ellipsoid") throw new Error();
    return request.vertices;
  };

  test("an unbounded region is bounded by the drawn chain", () => {
    expect(verticesOf(stateWith({}))).toEqual([
      [0, 0],
      [2, 1],
      [1, 2],
    ]);
  });

  test("a bounded region is bounded by its own vertices", () => {
    const vertices: Vec[] = [
      [0, 0],
      [3, 0],
      [0, 3],
    ];
    expect(verticesOf(stateWith({ kind: "bounded", vertices }))).toBe(vertices);
  });
});
