import { describe, expect, test } from "bun:test";
import type { SolverSettings, State } from "../core/store";
import type { ShareSettings } from "../share/sharedState";
import { createSolverControls } from "./solverControls";
import type { Vec } from "@lpviz/math/types";

// Share links are the app's only untrusted input. Each control's
// applySharedSettings must forward valid values and drop everything else so a
// hand-edited link can neither blank a <select> nor throw inside the settings
// panel's store subscriber.
function controls() {
  const applied: Record<string, unknown> = {};
  const list = createSolverControls({
    updateSolverSetting: (key, value) => {
      applied[key] = value;
    },
  });
  const byMode = (mode: string) => list.find((c) => c.mode === mode)!;
  return { applied, simplex: byMode("simplex"), ipm: byMode("ipm") };
}

const untrusted = (value: unknown) => value as ShareSettings;

describe("shared solver settings", () => {
  test("valid values reach the store", () => {
    const { applied, simplex, ipm } = controls();
    const wanted: Partial<SolverSettings> = {
      simplexDualMode: true,
      simplexEnteringRule: "coeff",
      simplexLeavingRule: "last",
      alphaMax: 0.5,
      maxitIPM: 250,
    };
    simplex.applySharedSettings(wanted);
    ipm.applySharedSettings(wanted);
    expect(applied).toEqual(wanted);
  });

  test("unknown rule names, wrong types and non-finite numbers are dropped", () => {
    const { applied, simplex, ipm } = controls();
    simplex.applySharedSettings(
      untrusted({
        simplexDualMode: "yes",
        simplexEnteringRule: "bogus",
        simplexLeavingRule: {},
      }),
    );
    ipm.applySharedSettings(untrusted({ alphaMax: NaN, maxitIPM: "100", correctorThreshold: 0.5 }));
    expect(applied).toEqual({ correctorThreshold: 0.5 });
  });

  test("keys a control does not own are ignored", () => {
    const { applied, simplex } = controls();
    simplex.applySharedSettings({ alphaMax: 0.5, pdhgEta: 0.1 });
    expect(applied).toEqual({});
  });
});

describe("ellipsoid request", () => {
  const ellipsoid = () => createSolverControls({ updateSolverSetting: () => {} }).find((c) => c.mode === "ellipsoid")!;
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
        lines: [
          [1, -2, 0],
          [1, 1, 3],
        ],
        vertices: [],
        inequalities: ["", ""],
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
    const request = ellipsoid().buildRequest(state);
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
    const vertices = [
      [0, 0],
      [3, 0],
      [0, 3],
    ] as [number, number][];
    expect(verticesOf(stateWith({ kind: "bounded", vertices }))).toBe(vertices);
  });
});
